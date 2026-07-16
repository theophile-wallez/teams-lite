// teams-lite — AUTH SPIKE
//
// Goal: prove we can authenticate against Microsoft Teams' internal API using the
// OAuth 2.0 device-code flow, WITHOUT reimplementing the browser SAML/MFA dance.
//
// Flow (constants reverse-engineered from the fossteams/teams-api project):
//   1. device-code request           -> user_code + verification URL
//   2. poll token endpoint           -> AAD access token for resource=api.spaces.skype.com
//   3. POST /authsvc/v1.0/authz      -> skypetoken (valid ~1 day) + region service endpoints
//   4. (bonus) refresh for chatsvcagg-> GET conversations = proof the token reads real data
//
// This spike stores nothing on disk. Tokens live in memory for the run only.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::time::{Duration, Instant};

// Microsoft Teams first-party web client id (public client).
const CLIENT_ID: &str = "5e3ce6c0-2b1f-4285-8d4b-75ee78787346";
// v1 endpoints let us request first-party `resource` audiences directly.
// `organizations` = work/school accounts (Teams). Switch to `common` if needed.
const AUTHORITY: &str = "https://login.microsoftonline.com/organizations";
const SKYPE_RESOURCE: &str = "https://api.spaces.skype.com";
const CHATSVCAGG_RESOURCE: &str = "https://chatsvcagg.teams.microsoft.com";
const AUTHZ_URL: &str = "https://teams.microsoft.com/api/authsvc/v1.0/authz";
const CSA_CONVERSATIONS: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

/// Step 1: request a device code for the Skype resource.
async fn request_device_code(client: &reqwest::Client) -> Result<Value> {
    let resp = client
        .post(format!("{AUTHORITY}/oauth2/devicecode"))
        .form(&[("client_id", CLIENT_ID), ("resource", SKYPE_RESOURCE)])
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(anyhow!("devicecode request failed: {status}\n{text}"));
    }
    serde_json::from_str(&text).context("parse devicecode response")
}

/// Step 2: poll until the user finishes signing in, then return the token JSON.
async fn poll_for_token(client: &reqwest::Client, device_code: &str, mut interval: u64) -> Result<Value> {
    interval = interval.max(1);
    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let resp = client
            .post(format!("{AUTHORITY}/oauth2/token"))
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", CLIENT_ID),
                ("resource", SKYPE_RESOURCE),
                ("code", device_code),
            ])
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if status.is_success() {
            return serde_json::from_str(&text).context("parse token response");
        }
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match str_field(&body, "error").unwrap_or("") {
            "authorization_pending" => continue,
            "slow_down" => interval += 5,
            "authorization_declined" => return Err(anyhow!("sign-in declined by user")),
            "expired_token" | "code_expired" => return Err(anyhow!("device code expired — rerun")),
            other => return Err(anyhow!("token poll failed [{other}]: {status}\n{text}")),
        }
    }
}

/// Refresh-token exchange to get an access token for a different first-party resource.
async fn token_for_resource(client: &reqwest::Client, refresh_token: &str, resource: &str) -> Result<Value> {
    let resp = client
        .post(format!("{AUTHORITY}/oauth2/token"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("resource", resource),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(anyhow!("refresh for {resource} failed: {status}\n{text}"));
    }
    serde_json::from_str(&text).context("parse refresh response")
}

/// Step 3: exchange the Skype-resource AAD token for the Teams skypetoken.
async fn authz(client: &reqwest::Client, skype_access_token: &str) -> Result<Value> {
    let resp = client
        .post(AUTHZ_URL)
        .bearer_auth(skype_access_token)
        .header("content-type", "application/json")
        .send()
        .await?;
    let status = resp.status();
    let text = resp.text().await?;
    if !status.is_success() {
        return Err(anyhow!("authz failed: {status}\n{text}\n(hint: try adding header ms-teams-authz-type)"));
    }
    serde_json::from_str(&text).context("parse authz response")
}

#[tokio::main]
async fn main() -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("teams-lite-spike/0.1")
        .build()?;

    // 1. Device code
    let dc = request_device_code(&client).await?;
    let device_code = str_field(&dc, "device_code").ok_or_else(|| anyhow!("no device_code"))?;
    let user_code = str_field(&dc, "user_code").unwrap_or("<none>");
    let verify = str_field(&dc, "verification_url")
        .or_else(|| str_field(&dc, "verification_uri"))
        .unwrap_or("https://microsoft.com/devicelogin");
    let interval = dc.get("interval").and_then(|v| v.as_u64()).unwrap_or(5);

    println!("\n===== AUTH =====");
    match str_field(&dc, "message") {
        Some(m) => println!("{m}"),
        None => println!("Open {verify} and enter code: {user_code}"),
    }
    println!("Waiting for sign-in...\n");

    // 2. Poll for the Skype-resource token
    let token = poll_for_token(&client, device_code, interval).await?;
    let access_token = str_field(&token, "access_token").ok_or_else(|| anyhow!("no access_token"))?;
    let refresh_token = str_field(&token, "refresh_token");
    println!("[ok] AAD access token acquired for {SKYPE_RESOURCE}");

    // 3. Exchange for the Teams skypetoken (also returns region + service endpoints)
    let t0 = Instant::now();
    let authz_resp = authz(&client, access_token).await?;
    let region = str_field(&authz_resp, "region").unwrap_or("?");
    let skypetoken = authz_resp.pointer("/tokens/skypeToken").and_then(|v| v.as_str());
    let csa_ep = authz_resp
        .pointer("/regionGtms/chatServiceAggregator")
        .and_then(|v| v.as_str());
    println!("[ok] authz succeeded in {:?} — region = {region}", t0.elapsed());
    match skypetoken {
        Some(_) => println!("[ok] skypetoken obtained (valid ~1 day)"),
        None => println!("[warn] authz ok but no skypetoken field found"),
    }
    if let Some(ep) = csa_ep {
        println!("      chatServiceAggregator endpoint = {ep}");
    }

    // 4. Bonus proof: list real conversations via the Chat Service Aggregator.
    match refresh_token {
        Some(rt) => match token_for_resource(&client, rt, CHATSVCAGG_RESOURCE).await {
            Ok(csa_tok) => {
                let csa_access = str_field(&csa_tok, "access_token").unwrap_or("");
                let resp = client.get(CSA_CONVERSATIONS).bearer_auth(csa_access).send().await?;
                let status = resp.status();
                let body = resp.text().await?;
                println!("\n===== CONVERSATIONS ===== status = {status}");
                match serde_json::from_str::<Value>(&body) {
                    Ok(v) => {
                        let chats = v.get("chats").and_then(|c| c.as_array()).map(|a| a.len());
                        let teams = v.get("teams").and_then(|c| c.as_array()).map(|a| a.len());
                        println!("chats = {chats:?}, teams = {teams:?}");
                    }
                    Err(_) => println!("{}", body.chars().take(500).collect::<String>()),
                }
            }
            Err(e) => println!("[warn] could not get chatsvcagg token: {e}"),
        },
        None => println!("[warn] no refresh_token returned — skipping conversations proof"),
    }

    println!("\n===== RESULT =====");
    if skypetoken.is_some() {
        println!("✅ AUTH PROVEN: device-code flow works in this tenant. Foundation is viable.");
    } else {
        println!("⚠️  Partial: got AAD token but authz did not return a skypetoken. Investigate the authz call.");
    }
    Ok(())
}
