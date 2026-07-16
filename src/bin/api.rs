// teams-lite — API SPIKE
//
// Proves the broker-minted token drives the REAL Teams API:
//   1. get skype-resource token via broker (silent, device-compliant)
//   2. POST /authsvc/v1.0/authz  -> skypetoken + region + regionGtms endpoints
//   3. print region + which endpoints exist (harvest trouter/websocket hosts)
//
// Prints no raw tokens.

use anyhow::{Context, Result};
use serde_json::Value;
use teams_lite::auth;

const SKYPE_SCOPE: &str = "https://api.spaces.skype.com/.default";
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";

// authz has lived on both hosts; try the modern one first.
const AUTHZ_HOSTS: &[&str] = &[
    "https://teams.cloud.microsoft/api/authsvc/v1.0/authz",
    "https://teams.microsoft.com/api/authsvc/v1.0/authz",
];

#[tokio::main]
async fn main() -> Result<()> {
    println!("Acquiring tokens via broker (silent)...");
    let skype = auth::get_token(SKYPE_SCOPE).await.context("skype token")?;
    let _ic3 = auth::get_token(IC3_SCOPE).await.context("ic3 token")?;
    println!("[ok] skype + ic3 tokens acquired\n");

    let client = reqwest::Client::builder()
        .user_agent("teams-lite/0.1")
        .http1_only() // avoid h2 (no Content-Length) — the edge returns 411 otherwise
        .build()?;

    let mut authz: Option<Value> = None;
    for url in AUTHZ_HOSTS {
        let resp = client
            .post(*url)
            .bearer_auth(&skype)
            .header("content-type", "application/json")
            .body("{}".to_string()) // non-empty body => Content-Length present (server 411s without it)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        println!("authz {url} -> {status}");
        if status.is_success() {
            authz = Some(serde_json::from_str(&text).context("parse authz")?);
            break;
        }
        println!("   {}", text.chars().take(200).collect::<String>());
    }

    let v = match authz {
        Some(v) => v,
        None => {
            println!("\n❌ authz failed on all hosts — will adjust headers/host.");
            return Ok(());
        }
    };

    let region = v.get("region").and_then(|x| x.as_str()).unwrap_or("?");
    let has_skypetoken = v.pointer("/tokens/skypeToken").is_some();
    println!("\n[ok] region = {region} | skypetoken present = {has_skypetoken}");

    println!("\n== regionGtms endpoints (real, region-correct hosts) ==");
    if let Some(g) = v.get("regionGtms").and_then(|g| g.as_object()) {
        // Known-useful endpoints
        for k in ["chatService", "chatServiceAggregator", "middleTier", "unifiedPresence"] {
            if let Some(val) = g.get(k).and_then(|x| x.as_str()) {
                println!("  {k} = {val}");
            }
        }
        // Anything real-time related (trouter / websocket / push / notification)
        println!("  -- real-time candidates --");
        for (k, val) in g {
            let kl = k.to_lowercase();
            if kl.contains("trouter") || kl.contains("socket") || kl.contains("push")
                || kl.contains("notification") || kl.contains("presence")
            {
                if let Some(s) = val.as_str() {
                    println!("  [rt] {k} = {s}");
                }
            }
        }
    }

    println!("\nDONE — region + skypetoken + endpoints ⇒ the broker token drives the real Teams API. ✅");
    Ok(())
}
