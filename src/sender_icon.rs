// The icon of the organisation a mail came from, fetched from that organisation's own
// domain — the ONE place this app requests something from a stranger's server.
//
// Why it exists: a mail from a colleague shows their real photo (see `teams_avatars`
// over `teams_profiles::fetch_profiles_by_address`), but a mail from Sentry, Linear,
// GitHub or AWS has no directory entry at all, and a monogram is a poor way to
// recognise a service. Its favicon is the mark the user already knows.
//
// Proven shape (recon: examples/sender_icon_probe.rs, over the domains that really
// write to this mailbox): 11 of 18 answer at `/favicon.ico`, several also at
// `/apple-touch-icon.png`, and the rest answer nothing an image can be made of (a WAF
// 403s a non-browser client, or the apex simply has no icon). Reading the home page's
// `<link rel="icon">` was measured too and is deliberately NOT used: without a real
// HTML parser it mistook a stylesheet for an icon, and a parser here would mean
// downloading and walking a stranger's document.
//
// A favicon request is a request to the sender's infrastructure, so five rails hold it
// away from being the tracking pixel `mail_html` just stripped out of the body:
//
//   1. **Only the registrable domain is ever requested.** A per-recipient host
//      (`mail.a1b2c3.example.com`) collapses to `example.com` before anything is
//      fetched, so the token that would identify this reader never reaches the wire.
//      The caller derives it; `is_fetchable_domain` refuses anything that is not a
//      plain, bounded, public-looking name.
//   2. **Once per domain, ever.** The answer — including "there is none" — is cached in
//      the store, so the number of requests is the number of organisations that write
//      to the user, not the number of mails they send.
//   3. **The reader's behaviour is not in it.** The icon is asked for when a mail LIST
//      renders, never when a body is opened, so the request cannot say a mail was read.
//   4. **Nothing about the mail travels.** No cookie store, no referrer, no query, no
//      mail id, no address — just GET https://{domain}/favicon.ico.
//   5. **It can be turned off** (`sender_icons` in the settings), and a read-only
//      backend never fetches at all: an automation must not touch a stranger's server
//      on the user's behalf.
//
// And two rails are about this machine rather than the user's privacy:
//
//   - **The host must resolve to a PUBLIC address.** A hostile sender's domain can
//     point at 127.0.0.1 or at 169.254.169.254, the cloud metadata endpoint, which
//     would make this fetch an SSRF into the machine's own network. Every resolved
//     address is checked before the request goes out.
//   - **The bytes must really be an image**, by magic number rather than by the
//     content type the server claims, and under a size cap. SVG is refused: it is a
//     document, not a bitmap, and nothing here needs one.

use anyhow::{Context, Result};
use std::net::IpAddr;

use crate::teams_media::Media;

/// The paths tried, in order. Both are conventions a site either honours or does not;
/// neither is derived from the mail.
const ICON_PATHS: [&str; 2] = ["/favicon.ico", "/apple-touch-icon.png"];

/// The largest icon accepted. A favicon is a few kilobytes; the biggest one measured
/// on this mailbox's senders was 36 KB, and the cap is well past it without letting a
/// hostile host stream megabytes into the store.
pub const MAX_ICON_BYTES: usize = 256 * 1024;

/// How long the fetch may take, per path. Short: an icon is decoration, and a sender
/// that keeps the connection open must not hold a mail list up.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// The second-level labels that belong to a public suffix rather than to a name, so
/// `example.co.uk` keeps its two suffix labels. Mirrors `SUFFIX_LABELS` in
/// `web/src/components/avatar.tsx`, which derives the tint from the same notion.
const SUFFIX_LABELS: [&str; 7] = ["co", "com", "net", "org", "gov", "edu", "ac"];

/// The registrable part of a host — its name plus the public suffix. This is the ONLY
/// thing that is ever requested: `mail.a1b2c3.example.com` becomes `example.com`, so a
/// per-recipient subdomain cannot carry a reader's identity out to the sender.
pub fn registrable_domain(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    // An address is not a name, so it has no registrable part to take: hand it back
    // whole for [`is_fetchable_domain`] to refuse, rather than reducing "127.0.0.1" to
    // "0.1" and refusing something the caller never asked about.
    if host.parse::<IpAddr>().is_ok() {
        return host;
    }
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    let mut index = labels.len() - 2;
    if SUFFIX_LABELS.contains(&labels[index]) && index > 0 {
        index -= 1;
    }
    labels[index..].join(".")
}

/// True when `domain` is a plain public domain name this app may request an icon from.
///
/// Everything else is refused before a request is built: an IP literal (which would
/// name a host inside this network directly), a port or userinfo (`evil.com:22`,
/// `a@b`), a path or query (`x/../../y`, `x?`), a percent escape, a single label
/// (`localhost`), a numeric or one-character TLD, and anything over the DNS length
/// limit. The check is on the STRING, before DNS; [`fetch_icon`] then checks where the
/// name actually points.
pub fn is_fetchable_domain(domain: &str) -> bool {
    if domain.len() < 4 || domain.len() > 253 || domain != domain.to_ascii_lowercase() {
        return false;
    }
    if domain.parse::<IpAddr>().is_ok() {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let label_ok = |label: &&str| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if !labels.iter().all(label_ok) {
        return false;
    }
    // A real public suffix is alphabetic and at least two characters ("com", "app",
    // "dev", "io"), which also rules out an all-numeric last label.
    let tld = labels[labels.len() - 1];
    tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_alphabetic())
}

/// Extract the host from a URL string, or `None` if the URL is malformed or has no
/// host. This is a simple parser that covers the URLs this app fetches; it does not
/// handle every RFC 3986 edge case.
pub fn extract_host(url: &str) -> Option<String> {
    let url = url.trim();
    let after_scheme = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let host_and_rest = after_scheme.split_once('/').map(|(h, _)| h).unwrap_or(after_scheme);
    let host = host_and_rest.split_once(':').map(|(h, _)| h).unwrap_or(host_and_rest);
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

/// The content type of `bytes`, read from its magic number — never from what the
/// server said it was sending. `None` for anything that is not one of the raster
/// formats a browser can draw in an `<img>`.
///
/// SVG is absent on purpose: it is a document with its own fetching and scripting
/// story, and an icon has no need to be one.
pub fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x00, 0x00, 0x01, 0x00, ..] => Some("image/x-icon"),
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// Read the dimensions of a raster image from its bytes, or `None` if the format is not
/// recognized or the header is malformed. This is a simple parser that covers the
/// formats this app accepts; it reads only the header bytes needed to extract dimensions.
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    match bytes {
        // PNG: width and height are at bytes 16-23 (big-endian)
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..]
            if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" =>
        {
            let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
            let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            Some((width, height))
        }
        // GIF: width and height are at bytes 6-9 (little-endian)
        [b'G', b'I', b'F', b'8', ..] if bytes.len() >= 10 => {
            let width = u32::from(u16::from_le_bytes([bytes[6], bytes[7]]));
            let height = u32::from(u16::from_le_bytes([bytes[8], bytes[9]]));
            Some((width, height))
        }
        // WebP: read the VP8/VP8L/VP8X chunk to get dimensions
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] if bytes.len() >= 30 => {
            match &bytes[12..16] {
                b"VP8 " if bytes.len() >= 30 => {
                    let width = u32::from(u16::from_le_bytes([bytes[26], bytes[27]])) & 0x3FFF;
                    let height = u32::from(u16::from_le_bytes([bytes[28], bytes[29]])) & 0x3FFF;
                    Some((width, height))
                }
                b"VP8L" if bytes.len() >= 25 => {
                    let bits = u32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
                    let width = (bits & 0x3FFF) + 1;
                    let height = ((bits >> 14) & 0x3FFF) + 1;
                    Some((width, height))
                }
                b"VP8X" if bytes.len() >= 30 => {
                    let width_minus_one =
                        u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]) & 0xFFFFFF;
                    let height_minus_one =
                        u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]) & 0xFFFFFF;
                    Some((width_minus_one + 1, height_minus_one + 1))
                }
                _ => None,
            }
        }
        // JPEG: scan for SOF (Start of Frame) markers
        [0xFF, 0xD8, 0xFF, ..] => {
            let mut pos = 2;
            while pos + 9 < bytes.len() {
                if bytes[pos] != 0xFF {
                    return None;
                }
                let marker = bytes[pos + 1];
                pos += 2;
                if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
                    continue;
                }
                if pos + 2 > bytes.len() {
                    return None;
                }
                let length = u16::from_be_bytes([bytes[pos], bytes[pos + 1]]) as usize;
                if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 {
                    if pos + 5 < bytes.len() {
                        let height = u32::from(u16::from_be_bytes([bytes[pos + 3], bytes[pos + 4]]));
                        let width = u32::from(u16::from_be_bytes([bytes[pos + 5], bytes[pos + 6]]));
                        return Some((width, height));
                    }
                    return None;
                }
                pos += length;
            }
            None
        }
        _ => None,
    }
}

/// Fetch a raster image from a URL, checking every rail: public-IP-only resolution,
/// byte cap on the claimed and actual lengths, raster sniff on the bytes rather than
/// the claimed type. Adds no cookie, referrer, or query of its own. Returns `Ok(None)`
/// for a non-success status, a claimed or actual size over the cap, or bytes that are
/// not a raster image.
///
/// This is the reusable core of `fetch_icon` and is shared by every caller that fetches
/// an image from a URL a user supplied — the sender icon and the custom emoji URL
/// source. Every rail here exists because of a specific attack or leak; read the module
/// comment before weakening one.
pub async fn fetch_raster(
    http: &reqwest::Client,
    url: &str,
    max_bytes: usize,
) -> Result<Option<Media>> {
    let domain = extract_host(url).ok_or_else(|| anyhow::anyhow!("URL has no host"))?;

    anyhow::ensure!(is_fetchable_domain(&domain), "refusing to fetch from {domain:?}");
    ensure_public_host(&domain).await?;

    let resp = http.get(url).timeout(FETCH_TIMEOUT).send().await.context("request")?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    if resp.content_length().is_some_and(|len| len as usize > max_bytes) {
        return Ok(None);
    }
    let bytes = resp.bytes().await.context("read body")?;
    if bytes.len() > max_bytes {
        return Ok(None);
    }
    let Some(content_type) = image_kind(&bytes) else {
        return Ok(None);
    };
    Ok(Some(Media {
        content_type: content_type.to_string(),
        bytes: bytes.to_vec(),
    }))
}

/// Fetch the icon of one domain, or `Ok(None)` when it serves none we can use — which
/// is a normal answer for 7 senders in 18 and is cached like a found one.
///
/// `domain` MUST already be a registrable domain; this re-validates defensively so a
/// future caller's mistake cannot turn the request into an SSRF vector.
pub async fn fetch_icon(http: &reqwest::Client, domain: &str) -> Result<Option<Media>> {
    anyhow::ensure!(is_fetchable_domain(domain), "refusing to fetch an icon for {domain:?}");

    for path in ICON_PATHS {
        let url = format!("https://{domain}{path}");
        match fetch_raster(http, &url, MAX_ICON_BYTES).await {
            Ok(Some(media)) => return Ok(Some(media)),
            // No icon at this path, or something the bytes say is not an image: try the
            // next one. A sender's server failing is not this app's error.
            Ok(None) | Err(_) => continue,
        }
    }
    Ok(None)
}

/// Refuse a name that points anywhere but at the public internet. The classic prize is
/// `169.254.169.254` (cloud metadata), and loopback would reach this machine's own
/// backends — including the send-capable one.
///
/// There is a small window between this check and the request in which DNS could
/// change its answer. Closing it entirely means resolving here and connecting by
/// address with a pinned SNI; the window is documented rather than closed because the
/// request that follows carries no credential and its answer is only ever decoded as
/// an image.
async fn ensure_public_host(domain: &str) -> Result<()> {
    let addresses = tokio::net::lookup_host((domain, 443u16))
        .await
        .with_context(|| format!("resolve {domain}"))?;
    let mut any = false;
    for address in addresses {
        any = true;
        anyhow::ensure!(
            is_public(address.ip()),
            "refusing to fetch an icon from a non-public address ({})",
            address.ip()
        );
    }
    anyhow::ensure!(any, "{domain} resolves to nothing");
    Ok(())
}

/// True when an address is on the public internet. Everything a stranger's DNS could
/// point at to make this fetch reach inside is refused.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || v4.is_unspecified()
                // 100.64.0.0/10 (carrier NAT, and a tailnet's own range) and
                // 192.0.0.0/24 / 198.18.0.0/15 (protocol assignments, benchmarking).
                || matches!(v4.octets(), [100, b, ..] if (64..128).contains(&b))
                || matches!(v4.octets(), [192, 0, 0, _])
                || matches!(v4.octets(), [198, b, ..] if (18..20).contains(&b)))
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                // fc00::/7 unique-local and fe80::/10 link-local.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduces_a_host_to_the_name_that_is_shared_by_every_recipient() {
        // The rail that defuses the tracking pixel: a per-recipient subdomain is gone
        // before anything is requested.
        assert_eq!(registrable_domain("mail.a1b2c3.example.com"), "example.com");
        assert_eq!(registrable_domain("updates.tracker.dev"), "tracker.dev");
        assert_eq!(registrable_domain("md.getsentry.com"), "getsentry.com");
        assert_eq!(registrable_domain("sns.amazonaws.com"), "amazonaws.com");
        assert_eq!(registrable_domain("linear.app"), "linear.app");
        // A two-part public suffix keeps both labels.
        assert_eq!(registrable_domain("shop.example.co.uk"), "example.co.uk");
        // Case and a trailing root dot are not two domains.
        assert_eq!(registrable_domain("Mail.Example.COM."), "example.com");
        // An address has no name to reduce, and comes back whole to be refused.
        assert_eq!(registrable_domain("127.0.0.1"), "127.0.0.1");
        assert_eq!(registrable_domain("169.254.169.254"), "169.254.169.254");
        assert!(!is_fetchable_domain(&registrable_domain("127.0.0.1")));
    }

    #[test]
    fn accepts_a_plain_public_domain() {
        assert!(is_fetchable_domain("getsentry.com"));
        assert!(is_fetchable_domain("linear.app"));
        assert!(is_fetchable_domain("example.co.uk"));
        assert!(is_fetchable_domain("my-company.io"));
    }

    #[test]
    fn refuses_anything_that_could_name_something_else() {
        // An address inside this network, named directly.
        assert!(!is_fetchable_domain("127.0.0.1"));
        assert!(!is_fetchable_domain("169.254.169.254"));
        assert!(!is_fetchable_domain("::1"));
        assert!(!is_fetchable_domain("10.0.0.7"));
        // A single label: this machine's own names live there.
        assert!(!is_fetchable_domain("localhost"));
        assert!(!is_fetchable_domain(""));
        // A port, userinfo, a path, a query, an escape, a space, a scheme.
        assert!(!is_fetchable_domain("example.com:22"));
        assert!(!is_fetchable_domain("user@example.com"));
        assert!(!is_fetchable_domain("example.com/../secret"));
        assert!(!is_fetchable_domain("example.com?x=1"));
        assert!(!is_fetchable_domain("example%2ecom"));
        assert!(!is_fetchable_domain("exam ple.com"));
        assert!(!is_fetchable_domain("https://example.com"));
        // Malformed labels and suffixes.
        assert!(!is_fetchable_domain("-example.com"));
        assert!(!is_fetchable_domain("example-.com"));
        assert!(!is_fetchable_domain("example.c"));
        assert!(!is_fetchable_domain("example.123"));
        assert!(!is_fetchable_domain("Example.com"), "a caller must lowercase first");
        assert!(!is_fetchable_domain(&format!("{}.com", "a".repeat(64))));
        assert!(!is_fetchable_domain(&format!("{}.com", "a.".repeat(200))));
    }

    #[test]
    fn believes_the_bytes_and_not_the_server() {
        assert_eq!(image_kind(&[0x00, 0x00, 0x01, 0x00, 9, 9]), Some("image/x-icon"));
        assert_eq!(
            image_kind(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]),
            Some("image/png")
        );
        assert_eq!(image_kind(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_kind(b"GIF89a..."), Some("image/gif"));
        assert_eq!(image_kind(b"RIFF____WEBPVP8 "), Some("image/webp"));
        // An HTML error page a server answered 200 with, which is what several of this
        // mailbox's senders really return for /apple-touch-icon.png.
        assert_eq!(image_kind(b"<!DOCTYPE html><html>"), None);
        // A document, not a bitmap: refused even though a browser would draw it.
        assert_eq!(image_kind(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(image_kind(b""), None);
    }

    #[test]
    fn only_public_addresses_are_reachable() {
        for inside in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254", // the cloud metadata endpoint
            "100.100.1.1",     // a tailnet address
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(!is_public(inside.parse().unwrap()), "{inside} must be refused");
        }
        for outside in ["1.1.1.1", "140.82.121.4", "2606:4700::1111"] {
            assert!(is_public(outside.parse().unwrap()), "{outside} must be allowed");
        }
    }

    #[test]
    fn a_hostile_domain_never_reaches_the_network() {
        // The validator is re-run inside `fetch_icon`, so a caller that forgot to check
        // cannot turn it into a request. No network is touched by this test.
        let http = reqwest::Client::new();
        let refused = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fetch_icon(&http, "127.0.0.1"));
        assert!(refused.is_err());
    }
}
