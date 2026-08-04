// Manual live check for mail avatars: can an SMTP address be resolved to a Teams
// identity, and does that identity have a profile photo?
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY. It issues two
// kinds of request and writes nothing:
//   1. POST /api/mt/beta/users/fetchShortProfile?isMailAddress=true — the same
//      endpoint that names a 1:1 chat, asked with addresses instead of mris.
//   2. GET  /api/mt/beta/users/{mri}/profilepicturev2 — the existing photo proxy.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example mail_avatar_recon -- [address …]
//
// With no argument it reads the newest page of the Inbox and probes every distinct
// address on it (sender and recipients), which is exactly the population the mail
// UI has to draw.
use anyhow::Result;
use serde_json::Value;

use teams_lite::teams_profiles::PROFILE_SCOPE;

/// The endpoint under test: the short-profile lookup, told its input is mail.
const BY_MAIL_URL: &str = "https://teams.microsoft.com/api/mt/beta/users/fetchShortProfile?isMailAddress=true&enableGuest=true&skypeTeamsInfo=true";

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let profile = teams_lite::auth::get_token(PROFILE_SCOPE).await?;
    println!("== region={} self={}", session.region, session.self_mri);

    let addresses = if args.is_empty() {
        addresses_from_inbox(&http).await?
    } else {
        args
    };
    println!("== probing {} address(es)", addresses.len());

    // One batch, the way the backend would ask.
    let body = {
        let mut arr: Vec<&str> = vec![""];
        arr.extend(addresses.iter().map(String::as_str));
        serde_json::to_string(&arr)?
    };
    let resp = http
        .post(BY_MAIL_URL)
        .bearer_auth(&profile)
        .header("x-skypetoken", &session.skypetoken)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await?;
    println!("== fetchShortProfile?isMailAddress=true -> {}", resp.status());
    let text = resp.text().await?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if v.is_null() {
        println!("   body: {}", &text[..text.len().min(400)]);
        return Ok(());
    }

    for item in v.get("value").and_then(|x| x.as_array()).into_iter().flatten() {
        let field = |key: &str| item.get(key).and_then(|x| x.as_str()).unwrap_or("");
        let mri = field("mri");
        println!(
            "\n-- {} -> mri={:?} objectId={:?} name={:?} type={:?}",
            field("email"),
            mri,
            field("objectId"),
            field("displayName"),
            field("type"),
        );
        if mri.is_empty() {
            continue;
        }
        let photo = teams_lite::teams_avatars::fetch_avatar(
            &http,
            &session,
            &profile,
            teams_lite::teams_avatars::AvatarKind::User,
            mri,
        )
        .await;
        match photo {
            Ok(Some(media)) => {
                println!("   photo: {} bytes, {}", media.bytes.len(), media.content_type)
            }
            Ok(None) => println!("   photo: none (falls back to initials)"),
            Err(e) => println!("   photo: ERROR {e:#}"),
        }
    }

    // What the payload does NOT answer for is as interesting as what it does: an
    // address the directory does not know must be absent, not invented.
    let known: Vec<String> = v
        .get("value")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
        .filter_map(|i| i.get("email").and_then(|x| x.as_str()).map(str::to_lowercase))
        .collect();
    let missing: Vec<&String> =
        addresses.iter().filter(|a| !known.contains(&a.to_lowercase())).collect();
    println!("\n== unresolved: {}/{} {missing:?}", missing.len(), addresses.len());
    Ok(())
}

/// Every distinct address on the newest page of the Inbox — the real population.
async fn addresses_from_inbox(http: &reqwest::Client) -> Result<Vec<String>> {
    let token = teams_lite::auth::get_token(teams_lite::mail::MAIL_SCOPE).await?;
    let folders = teams_lite::mail::fetch_folders(http, &token).await?;
    let inbox = folders
        .iter()
        .find(|f| f.well_known.eq_ignore_ascii_case("Inbox"))
        .or_else(|| folders.first())
        .ok_or_else(|| anyhow::anyhow!("no mail folder"))?;
    let messages = teams_lite::mail::fetch_newest(http, &token, &inbox.id, 20).await?;
    let mut out: Vec<String> = Vec::new();
    for mail in &messages {
        for address in std::iter::once(&mail.from).chain(&mail.to).chain(&mail.cc) {
            let a = address.address.trim();
            if !a.is_empty() && !out.iter().any(|held| held.eq_ignore_ascii_case(a)) {
                out.push(a.to_string());
            }
        }
    }
    out.truncate(40);
    Ok(out)
}
