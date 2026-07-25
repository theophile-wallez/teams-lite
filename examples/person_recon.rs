// Manual live check for the person card: the three payloads it is built from.
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY:
//   1. the directory card   (POST /api/mt/beta/users/fetchShortProfile)
//   2. live presence        (POST {unifiedPresence}/v1/presence/getpresence/)
//   3. a message's mentions (`properties.mentions`, which maps a body span's
//      `itemid` to the person it names)
// It never publishes our own presence and never writes anything.
//
//   DBUS_SESSION_BUS_ADDRESS="unix:path=/proc/$(pgrep -f \
//     identity-broker/bin/microsoft-identity-broker|head -1)/root/run/user/0/bus" \
//     cargo run --example person_recon -- 8:orgid:<guid> [19:<conversation-id>]
use anyhow::Result;
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mris, conversation): (Vec<String>, Option<String>) = {
        let mut mris = Vec::new();
        let mut conv = None;
        for a in args {
            if a.starts_with("19:") {
                conv = Some(a);
            } else {
                mris.push(a);
            }
        }
        (mris, conv)
    };

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    let token = teams_lite::auth::get_token(teams_lite::teams_profiles::PROFILE_SCOPE).await?;
    let subjects = if mris.is_empty() {
        vec![session.self_mri.clone()]
    } else {
        mris
    };
    println!("== region={} self={}", session.region, session.self_mri);

    for p in teams_lite::teams_profiles::fetch_profiles(&http, &session, &token, &subjects).await? {
        println!(
            "\n-- profile {}\n   {} — {} / {} / {}\n   {} · {}",
            p.mri, p.display_name, p.job_title, p.department, p.company_name, p.email,
            p.office_location
        );
    }

    for p in teams_lite::teams_presence::fetch_presence(&http, &session, &token, &subjects).await? {
        println!(
            "\n-- presence {}\n   availability={} activity={} oof={} last_active_ms={}\n   note={:?} oof_note={:?}",
            p.mri, p.availability, p.activity, p.out_of_office, p.last_active_ms, p.note,
            p.out_of_office_note
        );
    }

    // Mentions: only visible on the raw message resource, so read one page and
    // print the mention metadata of every message whose body carries a mention.
    if let Some(conv) = conversation {
        let chat = session.endpoint("chatService").expect("chatService").trim_end_matches('/');
        let url = format!(
            "{chat}/v1/users/ME/conversations/{}/messages?pageSize=50&view=msnp24Equivalent",
            urlencoding::encode(&conv)
        );
        let resp = http
            .get(&url)
            .header("authentication", format!("skypetoken={}", session.skypetoken))
            .send()
            .await?;
        println!("\n== messages of {conv} -> {}", resp.status());
        let v: Value = serde_json::from_str(&resp.text().await?)?;
        for m in v.get("messages").and_then(|x| x.as_array()).into_iter().flatten() {
            let content = m.get("content").and_then(|x| x.as_str()).unwrap_or("");
            if !content.contains("schema.skype.com/Mention") {
                continue;
            }
            let props = match m.get("properties") {
                Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
                Some(v) => v.clone(),
                _ => Value::Null,
            };
            println!(
                "\n-- message {} from {:?}\n   body: {}\n   mentions: {}",
                m.get("id").unwrap_or(&Value::Null),
                m.get("imdisplayname").and_then(|x| x.as_str()).unwrap_or(""),
                content.chars().take(160).collect::<String>(),
                props.get("mentions").unwrap_or(&Value::Null),
            );
        }
    }
    Ok(())
}
