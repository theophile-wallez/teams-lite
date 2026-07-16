// teams-lite — REALTIME PROBE (step 1: endpoint registration)
//
// Path B: Skype/Teams messaging long-poll (simpler than trouter socket.io).
//   auth (broker) -> authz -> skypetoken + chatService host
//   -> POST /v1/users/ME/endpoints  (learn: direct registrationToken or a challenge?)
//
// Secrets (skypetoken, registrationToken) are NEVER printed.

use anyhow::{Context, Result};
use serde_json::Value;
use teams_lite::auth;

const SKYPE_SCOPE: &str = "https://api.spaces.skype.com/.default";
const AUTHZ_HOSTS: &[&str] = &[
    "https://teams.cloud.microsoft/api/authsvc/v1.0/authz",
    "https://teams.microsoft.com/api/authsvc/v1.0/authz",
];

#[tokio::main]
async fn main() -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("teams-lite/0.1")
        .http1_only()
        .build()?;

    // 1. skype token -> authz -> skypetoken + chatService host
    let skype = auth::get_token(SKYPE_SCOPE).await.context("skype token")?;
    let mut authz: Option<Value> = None;
    for url in AUTHZ_HOSTS {
        let r = client
            .post(*url)
            .bearer_auth(&skype)
            .header("content-type", "application/json")
            .body("{}".to_string())
            .send()
            .await?;
        if r.status().is_success() {
            authz = Some(r.json().await?);
            break;
        }
    }
    let authz = authz.context("authz failed")?;
    let skypetoken = authz
        .pointer("/tokens/skypeToken")
        .and_then(|v| v.as_str())
        .context("no skypetoken")?
        .to_string();
    let chat = authz
        .pointer("/regionGtms/chatService")
        .and_then(|v| v.as_str())
        .context("no chatService endpoint")?
        .to_string();
    println!("[ok] chatService = {chat}");

    // 2. register a messaging endpoint
    let auth_hdr = format!("skypetoken={skypetoken}");
    let ep_url = format!("{chat}/v1/users/ME/endpoints");
    let resp = client
        .post(&ep_url)
        .header("Authentication", &auth_hdr)
        .header("content-type", "application/json")
        .body(r#"{"endpointFeatures":"Agent"}"#)
        .send()
        .await?;
    let status = resp.status();
    println!("\nPOST {ep_url}\n -> {status}");

    println!("-- interesting response headers (secrets redacted) --");
    for (k, v) in resp.headers() {
        let name = k.as_str();
        let nl = name.to_lowercase();
        let val = v.to_str().unwrap_or("<bin>");
        if nl == "set-registrationtoken" {
            // keep endpointId / expires, redact the token itself
            let safe: Vec<&str> = val
                .split(';')
                .filter(|p| !p.trim_start().to_lowercase().starts_with("registrationtoken="))
                .collect();
            println!("  set-registrationtoken: [registrationToken REDACTED];{}", safe.join(";"));
        } else if nl.contains("registration")
            || nl == "location"
            || nl.contains("endpoint")
            || nl == "www-authenticate"
            || nl == "x-ms-diagnostics"
        {
            println!("  {name}: {val}");
        }
    }

    let body = resp.text().await?;
    println!("-- body (truncated) --\n{}", body.chars().take(600).collect::<String>());
    Ok(())
}
