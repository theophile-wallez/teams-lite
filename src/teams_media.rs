// Media proxy for Teams hosted content (inline images + file attachments).
//
// Inline images and files shared in a Teams chat are served from authenticated
// hosted-content endpoints (AMS `*.asm.skype.com/v1/objects/...`, the region
// chatService, etc.). Their URLs require the skypetoken — the browser does not
// hold it, so it cannot load them directly. The backend fetches the bytes with
// the session credentials and streams them back to the UI over the existing
// WebSocket protocol (see `fetch_media` in src/bin/server.rs). The UI never
// touches the network directly, exactly like every other read path.
//
// Two safety rails:
//   - HOST ALLOWLIST: we only ever attach the skypetoken to (and fetch from)
//     Microsoft-owned hosts. Fetching an arbitrary attacker-supplied URL with
//     the token would be an SSRF / credential-leak vector, so any URL whose host
//     is not on the allowlist is rejected before a request is made.
//   - SIZE CAP: a single media object is bounded so a hostile/huge response
//     can't blow up memory or the WebSocket frame.

use anyhow::{Context, Result};

use crate::teams::Session;

/// Upper bound on a single media object we will proxy (bytes). Inline chat images
/// and shared files are comfortably under this; anything larger is refused rather
/// than buffered whole into a base64 WebSocket frame.
pub const MAX_MEDIA_BYTES: usize = 24 * 1024 * 1024;

/// Base domains we trust to carry Teams hosted content. A host is trusted when
/// it equals one of these or is a subdomain of it. The skypetoken is only ever
/// sent to a trusted host, and only trusted hosts are fetched. Kept deliberately
/// tight: every entry is a Microsoft-owned domain that serves chat images/files.
const ALLOWED_BASE_DOMAINS: &[&str] = &[
    "skype.com",
    "teams.microsoft.com",
    "teams.cloud.microsoft",
    "teams.office.com",
];

/// The bytes + content type of a fetched media object.
pub struct Media {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// Extract the lowercased host from an `https://` URL, without pulling in a URL
/// crate. Returns `None` for anything that is not a plain `https` URL (we never
/// proxy `http`, `data:`, `file:`, etc.). Strips any `userinfo@` and `:port`.
fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    // Authority ends at the first '/', '?' or '#'.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    // Drop any credentials ("user:pass@host").
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    // Drop the port. IPv6 literals ("[::1]") are not Teams hosts, so treating a
    // ':' as a port separator here only ever rejects them — which is correct.
    let host = host_port.split(':').next().unwrap_or(host_port);
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// True when `url` is an `https` URL whose host is a trusted Teams/Skype hosted
/// content domain. Only such URLs are ever fetched with the session token.
pub fn is_allowed_media_url(url: &str) -> bool {
    let Some(host) = https_host(url) else {
        return false;
    };
    ALLOWED_BASE_DOMAINS.iter().any(|base| {
        // Exact apex match, or a subdomain of the base ("<sub>.<base>"). The
        // leading-dot check prevents a look-alike like "skype.com.evil.example"
        // from matching "skype.com".
        host == *base || host.ends_with(&format!(".{base}"))
    })
}

/// Fetch one hosted-content media object with the session credentials.
///
/// The caller MUST have already validated the URL with [`is_allowed_media_url`];
/// this function re-checks as a defensive belt-and-braces and bails otherwise, so
/// the token can never reach an untrusted host through a future caller mistake.
///
/// Auth: hosted content is served under two different schemes depending on the
/// endpoint — AMS objects want `Authorization: skype_token <token>`, while the
/// chatService-hosted variants want `Authentication: skypetoken=<token>`. We send
/// both; the header names differ so there is no conflict, and each endpoint reads
/// only the one it recognizes.
pub async fn fetch_media(http: &reqwest::Client, session: &Session, url: &str) -> Result<Media> {
    anyhow::ensure!(
        is_allowed_media_url(url),
        "refusing to fetch media from an untrusted host"
    );

    let resp = http
        .get(url)
        .header(
            "Authorization",
            format!("skype_token {}", session.skypetoken),
        )
        .header(
            "Authentication",
            format!("skypetoken={}", session.skypetoken),
        )
        .send()
        .await
        .context("hosted-content media request")?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    if !status.is_success() {
        anyhow::bail!("hosted-content media -> {status}");
    }

    let bytes = resp.bytes().await.context("read media body")?;
    anyhow::ensure!(
        bytes.len() <= MAX_MEDIA_BYTES,
        "media object too large: {} bytes",
        bytes.len()
    );

    Ok(Media {
        content_type,
        bytes: bytes.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_teams_and_skype_hosted_content_hosts() {
        // AMS inline-image object URL.
        assert!(is_allowed_media_url(
            "https://eu-api.asm.skype.com/v1/objects/0-eu-d1/views/imgo"
        ));
        // Region chatService hosted content.
        assert!(is_allowed_media_url(
            "https://fr.ng.msg.teams.microsoft.com/v1/objects/abc/content"
        ));
        // Other Microsoft-owned Teams domains.
        assert!(is_allowed_media_url(
            "https://teams.cloud.microsoft/x/y.png"
        ));
        assert!(is_allowed_media_url("https://teams.office.com/a.jpg"));
        // A port and credentials on a trusted host are still allowed.
        assert!(is_allowed_media_url(
            "https://user:pass@eu-api.asm.skype.com:443/v1/objects/x/views/imgo"
        ));
    }

    #[test]
    fn rejects_untrusted_hosts_and_schemes() {
        // Arbitrary external host — the SSRF / token-leak case we must refuse.
        assert!(!is_allowed_media_url("https://evil.example.com/steal"));
        // A look-alike host that only contains a trusted domain as a substring.
        assert!(!is_allowed_media_url("https://skype.com.evil.example/x"));
        assert!(!is_allowed_media_url(
            "https://asm.skype.com.attacker.net/x"
        ));
        // Non-https schemes are never proxied.
        assert!(!is_allowed_media_url("http://eu-api.asm.skype.com/x"));
        assert!(!is_allowed_media_url("file:///etc/passwd"));
        assert!(!is_allowed_media_url("data:image/png;base64,AAAA"));
        // Internal metadata endpoint (SSRF classic) — not on the allowlist.
        assert!(!is_allowed_media_url(
            "https://169.254.169.254/latest/meta-data"
        ));
        // Garbage / empty.
        assert!(!is_allowed_media_url(""));
        assert!(!is_allowed_media_url("not a url"));
    }

    #[test]
    fn bare_trusted_domain_without_subdomain_is_allowed() {
        // The suffix match intentionally covers the apex too (".skype.com" also
        // matches "api.skype.com"); an exact apex like "teams.microsoft.com".
        assert!(is_allowed_media_url(
            "https://teams.microsoft.com/objects/x"
        ));
    }

    #[test]
    fn host_parsing_is_case_insensitive() {
        assert!(is_allowed_media_url(
            "https://EU-API.ASM.SKYPE.COM/v1/objects/x/views/imgo"
        ));
    }
}
