// Measure what AMS returns for an uploaded animated GIF.
//
// The symptom: a user uploaded an animated GIF as a custom emoji, sent it, and the
// emoji renders as a STILL image in teams-lite. The send path uploads bytes to AMS
// then references them by object URL; the page fetches that URL through the backend's
// authenticated proxy and builds a Blob. Animation survives if the bytes coming back
// are still an animated GIF with `image/gif` type.
//
// This probe answers: which AMS view path, if any, returns the original animated GIF?
//
// It is READ-ONLY: it fetches an object the user already uploaded and writes nothing
// to the tenant. It names no conversation and posts nothing.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example custom_emoji_gif_probe
//
use anyhow::{Context, Result};

use teams_lite::{teams, teams_media};

/// A real AMS object URL — an animated GIF the user uploaded as a custom emoji. This
/// probe fetches views of this object only; it names no conversation and posts nothing.
const OBJECT: &str = "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d4-597f8a1a853d6a8cafa96336192d8606";

/// Candidate view/content paths to measure. Each is appended to the base object URL.
const CANDIDATE_PATHS: &[&str] = &[
    "/views/imgo",
    "/views/imgpsh",
    "/views/original",
    "/content/imgpsh",
    "/content/original",
    "",
];

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);
    println!("probing object: {OBJECT}\n");

    for path in CANDIDATE_PATHS {
        let url = format!("{OBJECT}{path}");
        let path_label = if path.is_empty() { "(bare)" } else { path };

        let result = teams_media::fetch_media(&http, &session, &url).await;

        match result {
            Ok(media) => {
                let first_bytes = format_first_bytes(&media.bytes);
                let verdict = analyze_gif(&media.bytes);
                println!(
                    "{:20} → {} | {} | {} bytes | {} | {}",
                    path_label,
                    "200 OK",
                    media.content_type,
                    media.bytes.len(),
                    first_bytes,
                    verdict
                );
            }
            Err(e) => {
                println!("{:20} → refused: {}", path_label, e);
            }
        }
    }

    println!("\n=== Conclusion ===");
    for path in CANDIDATE_PATHS {
        let url = format!("{OBJECT}{path}");
        if let Ok(media) = teams_media::fetch_media(&http, &session, &url).await {
            let verdict = analyze_gif(&media.bytes);
            if verdict.contains("animated GIF") {
                let path_label = if path.is_empty() { "the bare object URL" } else { path };
                println!("✓ {path_label} returns an animated GIF");
                return Ok(());
            }
        }
    }
    println!("✗ No path returns an animated GIF");

    Ok(())
}

/// Format the first 6 bytes of a buffer as ASCII where printable, plus hex.
fn format_first_bytes(bytes: &[u8]) -> String {
    let n = bytes.len().min(6);
    let ascii: String = bytes[..n]
        .iter()
        .map(|&b| if b.is_ascii_graphic() || b == b' ' {
            b as char
        } else {
            '.'
        })
        .collect();
    let hex: String = bytes[..n]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{:6} [{}]", ascii, hex)
}

/// Analyze bytes to determine if they represent an animated GIF.
fn analyze_gif(bytes: &[u8]) -> &'static str {
    if bytes.len() < 6 {
        return "too short";
    }

    let header = &bytes[..6];
    let is_gif = header == b"GIF87a" || header == b"GIF89a";

    if !is_gif {
        return "not a GIF";
    }

    // Count image descriptor blocks (0x2C separator).
    let image_count = bytes.windows(1).filter(|w| w[0] == 0x2C).count();

    // Look for NETSCAPE2.0 application extension (marker for looping GIFs).
    let has_netscape = bytes
        .windows(11)
        .any(|w| w == b"NETSCAPE2.0");

    if image_count > 1 || has_netscape {
        "animated GIF"
    } else {
        "still GIF (single frame)"
    }
}
