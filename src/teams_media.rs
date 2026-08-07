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
//
// A THIRD path covers modern OneDrive/SharePoint files: files shared in a current
// Teams chat/channel live on `*.sharepoint.com`, not the AMS object store, and the
// skypetoken cannot open them. Those are fetched through Microsoft Graph with a
// Graph bearer token (see `fetch_sharepoint_media`); the same size-cap rail
// applies, and the Graph token only ever goes to `graph.microsoft.com` — never to
// the user-supplied URL — so it can't be exfiltrated by a hostile attachment.

use anyhow::{Context, Result};
use base64::Engine as _;

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

/// What a server says when it is declining to name a type.
const OPAQUE_CONTENT_TYPE: &str = "application/octet-stream";

/// The type to report for fetched bytes: what the server said, or what the bytes are when
/// it said nothing useful.
///
/// AMS serves an emoji's original art from `content/imgpsh` as `application/octet-stream`
/// (measured by `examples/custom_emoji_gif_probe.rs`), and the UI builds its Blob with
/// whatever type arrives — so an animated GIF handed over as octet-stream is a coin-flip
/// for animating in a browser. The bytes themselves are unambiguous, and
/// [`sender_icon::image_kind`] is already the one sniffer in this crate — the emoji upload
/// validates with it — so it decides here too rather than a second copy of the same table.
///
/// A type the server really did state always wins, even where the bytes disagree: a sniff
/// that overruled a declared type would be this proxy deciding it knows the endpoint's
/// content better than the endpoint does. And bytes that are not a raster image at all —
/// a shared PDF, a zip — keep the opaque type, which is the honest answer for them.
fn reported_content_type(declared: &str, bytes: &[u8]) -> String {
    // Compare the media type alone; a `; charset=…` parameter says nothing about whether
    // the type itself was stated.
    let media_type = declared.split(';').next().unwrap_or("").trim();
    if !media_type.is_empty() && !media_type.eq_ignore_ascii_case(OPAQUE_CONTENT_TYPE) {
        return declared.trim().to_string();
    }
    crate::sender_icon::image_kind(bytes)
        .unwrap_or(OPAQUE_CONTENT_TYPE)
        .to_string()
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
    let declared = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
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
        content_type: reported_content_type(&declared, &bytes),
        bytes: bytes.to_vec(),
    })
}

/// Base domain for OneDrive / SharePoint, where modern Teams stores files shared
/// in a chat or channel — the sender's OneDrive (`<tenant>-my.sharepoint.com`) for
/// 1:1/group chats, or a team site (`<tenant>.sharepoint.com`) for channels. These
/// are NOT served with the skypetoken; they need a Microsoft Graph bearer token, so
/// they take a separate fetch path ([`fetch_sharepoint_media`]) from the AMS /
/// chatService hosts in `ALLOWED_BASE_DOMAINS` above.
const SHAREPOINT_BASE_DOMAIN: &str = "sharepoint.com";

/// The Microsoft Graph host we route OneDrive/SharePoint downloads through. The
/// Graph bearer token is only ever sent HERE (a fixed Microsoft host); the
/// user-supplied SharePoint URL is passed only as opaque data (base64 in the
/// request path), so a hostile attachment URL can never receive the token.
const GRAPH_HOST: &str = "graph.microsoft.com";

/// Graph scope for the delegated file download, acquired via the broker/PRT like
/// every other token (see `auth::get_token` / `auth::TokenCache`).
pub const GRAPH_SCOPE: &str = "https://graph.microsoft.com/.default";

/// True when `url` is an `https` URL on OneDrive/SharePoint (`*.sharepoint.com`).
/// Such files are fetched through Microsoft Graph (see [`fetch_sharepoint_media`]),
/// never through the skypetoken path — [`is_allowed_media_url`] returns false for
/// them, so the two paths never overlap.
pub fn is_sharepoint_url(url: &str) -> bool {
    let Some(host) = https_host(url) else {
        return false;
    };
    // Exact apex or a subdomain; the leading dot rejects "sharepoint.com.evil".
    host == SHAREPOINT_BASE_DOMAIN || host.ends_with(&format!(".{SHAREPOINT_BASE_DOMAIN}"))
}

/// Encode an absolute file URL as a Graph share id, per the Graph
/// `/shares/{shareId}` convention: URL-safe base64 of the UTF-8 URL, no `=`
/// padding, prefixed with `u!`. This lets us address a OneDrive/SharePoint file the
/// caller can access by its URL alone, without first resolving a drive + item id.
fn graph_share_id(url: &str) -> String {
    format!(
        "u!{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes())
    )
}

/// Fetch one OneDrive/SharePoint-hosted file (a modern Teams chat/channel file
/// attachment) through Microsoft Graph, with a Graph bearer token.
///
/// Files shared in current Teams are uploaded to OneDrive/SharePoint, not the
/// legacy AMS object store, so their `objectUrl` is a `*.sharepoint.com` URL the
/// skypetoken cannot open. We resolve them via Graph's shares endpoint —
/// `GET /v1.0/shares/{u!<base64url>}/driveItem/content` — which 302-redirects to a
/// short-lived, pre-authenticated download URL that `reqwest` follows (dropping the
/// bearer on the cross-host hop, so the token stays with Graph).
///
/// The caller MUST have validated the URL with [`is_sharepoint_url`]; this
/// re-checks defensively so a future caller mistake can't turn the proxy into an
/// open Graph-shares fetch for an arbitrary URL.
pub async fn fetch_sharepoint_media(
    http: &reqwest::Client,
    graph_token: &str,
    url: &str,
) -> Result<Media> {
    anyhow::ensure!(
        is_sharepoint_url(url),
        "refusing to fetch a non-SharePoint URL through Graph"
    );

    let endpoint = format!(
        "https://{GRAPH_HOST}/v1.0/shares/{}/driveItem/content",
        graph_share_id(url)
    );
    let resp = http
        .get(&endpoint)
        .bearer_auth(graph_token)
        .send()
        .await
        .context("graph shares content request")?;

    let status = resp.status();
    let declared = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    if !status.is_success() {
        anyhow::bail!("graph shares content -> {status}");
    }

    let bytes = resp.bytes().await.context("read media body")?;
    anyhow::ensure!(
        bytes.len() <= MAX_MEDIA_BYTES,
        "media object too large: {} bytes",
        bytes.len()
    );

    Ok(Media {
        content_type: reported_content_type(&declared, &bytes),
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

    #[test]
    fn detects_sharepoint_and_onedrive_hosts() {
        // OneDrive-for-Business: a file shared in a 1:1 / group chat.
        assert!(is_sharepoint_url(
            "https://contoso-my.sharepoint.com/personal/user/Documents/x.json"
        ));
        // A team site: a file shared in a channel.
        assert!(is_sharepoint_url(
            "https://contoso.sharepoint.com/sites/team/Shared%20Documents/x.pdf"
        ));
        // Apex, and case-insensitive.
        assert!(is_sharepoint_url("https://sharepoint.com/x"));
        assert!(is_sharepoint_url("https://CONTOSO.SHAREPOINT.COM/x"));

        // Not SharePoint, a look-alike, or a non-https scheme.
        assert!(!is_sharepoint_url("https://eu-api.asm.skype.com/v1/objects/x"));
        assert!(!is_sharepoint_url("https://sharepoint.com.evil.example/x"));
        assert!(!is_sharepoint_url("http://contoso.sharepoint.com/x"));
    }

    #[test]
    fn sharepoint_and_skypetoken_paths_never_overlap() {
        // A SharePoint file is NEVER eligible for the skypetoken path, and an AMS
        // object is never treated as SharePoint — the router picks exactly one.
        let sp = "https://contoso-my.sharepoint.com/personal/user/x.json";
        assert!(is_sharepoint_url(sp) && !is_allowed_media_url(sp));
        let ams = "https://eu-api.asm.skype.com/v1/objects/x/views/imgo";
        assert!(is_allowed_media_url(ams) && !is_sharepoint_url(ams));
    }

    #[test]
    fn an_opaque_content_type_is_resolved_from_the_bytes() {
        // The measured case: AMS serves an emoji's original art as octet-stream, and a
        // browser handed those bytes under that type may draw one frame and stop.
        let gif = b"GIF89a\x14\x00\x14\x00\x00";
        assert_eq!(
            reported_content_type("application/octet-stream", gif),
            "image/gif"
        );
        // A server that names no type at all, and one that names it with a parameter.
        assert_eq!(
            reported_content_type("", b"\x89PNG\r\n\x1a\n rest"),
            "image/png"
        );
        assert_eq!(
            reported_content_type("application/octet-stream; charset=binary", gif),
            "image/gif"
        );

        // A type the server really stated wins, even where the bytes disagree: this proxy
        // does not overrule an endpoint about its own content.
        assert_eq!(reported_content_type("image/jpeg", gif), "image/jpeg");
        assert_eq!(
            reported_content_type("text/html; charset=utf-8", gif),
            "text/html; charset=utf-8"
        );

        // And bytes that are no raster image keep the opaque type — a shared zip or PDF is
        // exactly what octet-stream is the honest answer for.
        assert_eq!(
            reported_content_type("application/octet-stream", b"PK\x03\x04 zip"),
            "application/octet-stream"
        );
        assert_eq!(reported_content_type("", b""), "application/octet-stream");
    }

    #[test]
    fn graph_share_id_is_urlsafe_base64_unpadded() {
        let url = "https://contoso-my.sharepoint.com/personal/a/Documents/x.json";
        let id = graph_share_id(url);
        // "u!" + URL-safe base64, no padding or non-URL-safe chars.
        assert!(id.starts_with("u!"));
        assert!(!id.contains('='));
        assert!(!id.contains('+'));
        assert!(!id.contains('/'));
        // Round-trips back to the original URL.
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(id.trim_start_matches("u!"))
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), url);
    }
}
