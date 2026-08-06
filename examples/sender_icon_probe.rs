// Manual live check for the sender icon: does a mail domain actually serve one, and
// through which of the three ways?
//
// This is NOT a unit test. It reaches the DOMAINS THAT WRITE TO THE USER — the one
// place in this app that talks to a stranger's server — and it reads only:
//   1. GET https://{domain}/favicon.ico
//   2. GET https://{domain}/apple-touch-icon.png
//   3. GET https://{domain}/  and read <link rel="…icon"> out of the head
// It sends no cookie, no referrer and no mail identifier, and it never names a
// subdomain: a per-recipient host is exactly what must never be requested.
//
//   cargo run --example sender_icon_probe -- getsentry.com linear.app …
//
// It prints, per domain, which way answered, the content type, the byte count and
// what the bytes really are (a server's own content-type is not evidence).
use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let domains: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(!domains.is_empty(), "usage: sender_icon_probe <domain> …");

    let http = reqwest::Client::builder()
        .user_agent("teams-lite/0.1 (+local mail client, sender icon)")
        .timeout(std::time::Duration::from_secs(6))
        .build()?;

    let mut answered = 0usize;
    for domain in &domains {
        println!("\n== {domain}");
        let mut found = false;
        for path in ["/favicon.ico", "/apple-touch-icon.png"] {
            match fetch(&http, &format!("https://{domain}{path}")).await {
                Ok(Some((kind, len, sniff))) => {
                    println!("   {path} -> {kind}, {len} B, sniffed {sniff}");
                    found = found || sniff != "not an image";
                }
                Ok(None) => println!("   {path} -> no icon"),
                Err(e) => println!("   {path} -> ERROR {e}"),
            }
        }
        // The declared one, which is what a site that serves no /favicon.ico uses.
        match declared_icon(&http, domain).await {
            Ok(Some(href)) => println!("   <link rel=icon> -> {href}"),
            Ok(None) => println!("   <link rel=icon> -> none declared"),
            Err(e) => println!("   <link rel=icon> -> ERROR {e}"),
        }
        // And what the module itself decides, which is what the app will show: the
        // domain reduced first, the address checked for being public, the bytes
        // sniffed rather than trusted.
        let reduced = teams_lite::sender_icon::registrable_domain(domain);
        match teams_lite::sender_icon::fetch_icon(&reduced).await {
            Ok(Some(icon)) => println!(
                "   -> sender_icon({reduced}) = {} , {} B",
                icon.content_type,
                icon.bytes.len()
            ),
            Ok(None) => println!("   -> sender_icon({reduced}) = none (initials stand)"),
            Err(e) => println!("   -> sender_icon({reduced}) REFUSED: {e}"),
        }
        if found {
            answered += 1;
        }
    }
    println!("\n== {answered}/{} domains served an icon at a well-known path", domains.len());
    Ok(())
}

/// Fetch one URL and report `(content-type, length, what the bytes actually are)`.
async fn fetch(
    http: &reqwest::Client,
    url: &str,
) -> Result<Option<(String, usize, &'static str)>> {
    let resp = http.get(url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let kind = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("(none)")
        .to_string();
    let bytes = resp.bytes().await?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some((kind, bytes.len(), sniff(&bytes))))
}

/// What a byte string really is, by its magic number — the only trustworthy answer.
fn sniff(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x00, 0x00, 0x01, 0x00, ..] => "ico",
        [0x89, b'P', b'N', b'G', ..] => "png",
        [0xFF, 0xD8, 0xFF, ..] => "jpeg",
        [b'G', b'I', b'F', b'8', ..] => "gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        _ if bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml") => "svg",
        _ => "not an image",
    }
}

/// The icon a site DECLARES in its home page head, for one that serves no
/// `/favicon.ico`. Read with a plain scan rather than a parser: this is a probe.
async fn declared_icon(http: &reqwest::Client, domain: &str) -> Result<Option<String>> {
    let resp = http.get(format!("https://{domain}/")).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let html = resp.text().await?;
    let head = &html[..html.len().min(200_000)];
    let lower = head.to_ascii_lowercase();
    let mut at = 0usize;
    while let Some(start) = lower[at..].find("<link") {
        let start = at + start;
        let end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
        let tag = &lower[start..end];
        if tag.contains("rel=") && tag.contains("icon") {
            if let Some(href) = tag.find("href=") {
                let rest = &head[start + href + 5..end.min(head.len())];
                let value = rest.trim_start_matches(['"', '\'']);
                let stop = value.find(['"', '\'', ' ']).unwrap_or(value.len());
                return Ok(Some(value[..stop].to_string()));
            }
        }
        at = end.max(start + 1);
    }
    Ok(None)
}
