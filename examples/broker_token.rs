// Manual live check: acquire a real broker token through the production auth path.
//
// This is NOT a unit test — it talks to a live Microsoft Identity Broker. Nothing has to
// be exported first: the library finds the broker's bus itself, on every connection
// (`src/intune.rs` — the running Intune container's bus, or this shell's own session bus
// on a classic-Intune host):
//
//   cargo run --example broker_token
//
// Prints the scope and a short token prefix on success; anything else is a failure.
use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let scope = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://api.spaces.skype.com/.default".to_string());
    let token = teams_lite::auth::get_token(&scope).await?;
    let prefix: String = token.chars().take(16).collect();
    println!(
        "OK scope={scope} token_len={} token_prefix={prefix}…",
        token.len()
    );
    Ok(())
}
