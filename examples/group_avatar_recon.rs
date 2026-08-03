// Manual live recon for a GROUP CHAT's custom picture.
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY (GET only).
// The question it answers: where does Teams keep the avatar a user uploads for a
// group chat, and what fetches its bytes?
//
// Four probes per group chat:
//   1. the CSA chat container      — every key, plus anything picture-shaped
//   2. the chatService thread      — GET {chatService}/v1/threads/{id}  (properties.picture)
//   3. the candidate photo URLs    — the mt/beta endpoints, status + content-type
//   4. the picture itself          — through `teams_media::fetch_media`, the path
//                                    the app actually uses (size + content type)
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example group_avatar_recon -- [title-substring]
use anyhow::Result;
use serde_json::Value;

/// Keys whose name suggests an image, so recon reports a field we did not predict.
fn looks_pictureish(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["pic", "photo", "avatar", "image", "img", "thumb", "icon"]
        .iter()
        .any(|needle| k.contains(needle))
}

/// Walk a JSON value and print every path whose key looks picture-shaped.
fn report_pictureish(prefix: &str, v: &Value) {
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                let path = format!("{prefix}/{k}");
                if looks_pictureish(k) {
                    println!("      {path} = {}", truncate(&child.to_string()));
                }
                report_pictureish(&path, child);
            }
        }
        Value::Array(items) => {
            for (i, child) in items.iter().enumerate() {
                report_pictureish(&format!("{prefix}/{i}"), child);
            }
        }
        _ => {}
    }
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= 220 {
        return s.to_string();
    }
    format!("{}…", s.chars().take(220).collect::<String>())
}

#[tokio::main]
async fn main() -> Result<()> {
    let filter = std::env::args().nth(1).unwrap_or_default().to_lowercase();

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let csa_token = teams_lite::auth::get_token(teams_lite::teams_read::CSA_SCOPE).await?;
    let profile_token = teams_lite::auth::get_token(teams_lite::teams_profiles::PROFILE_SCOPE).await?;
    let chat = session.endpoint("chatService").expect("chatService").trim_end_matches('/').to_string();
    println!("== region={} self={}", session.region, session.self_mri);

    // 1. The CSA snapshot: the raw group-chat containers.
    let resp = http
        .get("https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true")
        .bearer_auth(&csa_token)
        .header("x-skypetoken", &session.skypetoken)
        .send()
        .await?;
    println!("== CSA users/me -> {}", resp.status());
    let csa: Value = serde_json::from_str(&resp.text().await?)?;

    let chats = csa
        .pointer("/chats")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let groups: Vec<&Value> = chats
        .iter()
        .filter(|c| {
            let is_one = c.get("isOneOnOne").and_then(|x| x.as_bool()).unwrap_or(false);
            let title = c.get("title").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
            !is_one && (filter.is_empty() || title.contains(&filter))
        })
        .collect();
    println!("== {} group chat(s) match\n", groups.len());

    for c in groups.iter().take(12) {
        let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let title = c.get("title").and_then(|x| x.as_str()).unwrap_or("");
        let keys: Vec<&str> = c.as_object().map(|m| m.keys().map(|k| k.as_str()).collect()).unwrap_or_default();
        println!("-- {title:?}  {id}");
        println!("   CSA keys: {}", keys.join(", "));
        println!("   picture-shaped fields:");
        report_pictureish("", c);
        if let Some(props) = c.get("threadProperties") {
            println!("   threadProperties: {}", truncate(&props.to_string()));
        }

        // 2. The chatService thread resource — where thread properties live in full.
        let url = format!("{chat}/v1/threads/{}?view=msnp24Equivalent", urlencoding::encode(id));
        let resp = http
            .get(&url)
            .header("authentication", format!("skypetoken={}", session.skypetoken))
            .send()
            .await?;
        let status = resp.status();
        let body = resp.text().await?;
        println!("   GET /v1/threads/{{id}} -> {status}");
        if status.is_success() {
            let thread: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            if let Some(props) = thread.get("properties") {
                let pkeys: Vec<&str> =
                    props.as_object().map(|m| m.keys().map(|k| k.as_str()).collect()).unwrap_or_default();
                println!("      properties keys: {}", pkeys.join(", "));
                for name in ["picture", "threadPicture", "avatarUrl", "topic"] {
                    if let Some(v) = props.get(name) {
                        println!("      properties.{name} = {}", truncate(&v.to_string()));
                    }
                }
            }
            report_pictureish("      thread", &thread);
        } else {
            println!("      body: {}", truncate(&body));
        }

        // 3. Candidate photo endpoints, by analogy with the user/team ones.
        for (label, probe) in [
            (
                "mt/beta/chats/{id}/picture",
                format!("https://teams.microsoft.com/api/mt/beta/chats/{}/picture", urlencoding::encode(id)),
            ),
            (
                "mt/beta/threads/{id}/profilepicturev2",
                format!(
                    "https://teams.microsoft.com/api/mt/beta/threads/{}/profilepicturev2?size=HR192x192",
                    urlencoding::encode(id)
                ),
            ),
        ] {
            let resp = http
                .get(&probe)
                .bearer_auth(&profile_token)
                .header("x-skypetoken", &session.skypetoken)
                .send()
                .await;
            match resp {
                Ok(r) => {
                    let st = r.status();
                    let ct = r
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    let len = r.bytes().await.map(|b| b.len()).unwrap_or(0);
                    println!("   {label} -> {st} {ct} ({len} bytes)");
                }
                Err(e) => println!("   {label} -> error {e}"),
            }
        }

        // 4. The picture the app will actually load: the CSA `picture` value, parsed
        //    the way the sync parses it, fetched the way the media proxy fetches it.
        let picture = c
            .get("picture")
            .and_then(|x| x.as_str())
            .map(|raw| raw.trim().strip_prefix("URL@").unwrap_or(raw.trim()).to_string())
            .unwrap_or_default();
        if picture.is_empty() {
            println!("   media proxy -> no picture on this chat");
        } else {
            println!(
                "   media proxy allowed={}",
                teams_lite::teams_media::is_allowed_media_url(&picture)
            );
            match teams_lite::teams_media::fetch_media(&http, &session, &picture).await {
                Ok(m) => println!("   media proxy -> OK {} ({} bytes)", m.content_type, m.bytes.len()),
                Err(e) => println!("   media proxy -> ERR {e:#}"),
            }
        }
        println!();
    }

    Ok(())
}
