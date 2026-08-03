// Manual live check for a thread's roster: who a conversation's members are, which
// is what an @mention list in the composer offers (src/teams_members.rs).
//
// This is NOT a unit test — it talks to the live tenant, READ-ONLY. One GET per
// thread and nothing else:
//   GET {chatService}/v1/threads/{threadId}?view=msnp24Equivalent
//
// It prints the raw member shape (the keys the payload actually carries) before the
// parsed view, because the parser is written from what this shows and not the other
// way round.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example thread_members_recon -- 19:<thread-id>
use anyhow::{Context, Result};
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<()> {
    let thread = std::env::args()
        .nth(1)
        .context("usage: thread_members_recon <thread-id>")?;

    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let session = teams_lite::teams::connect(&http).await?;
    println!("== region={} self={}", session.region, session.self_mri);

    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/threads/{}?view=msnp24Equivalent",
        urlencoding::encode(&thread)
    );
    println!("== GET {url}");
    let response = http
        .get(&url)
        .header(
            "authentication",
            format!("skypetoken={}", session.skypetoken),
        )
        .send()
        .await
        .context("fetch thread")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    println!("== {status}");
    if !status.is_success() {
        println!("{}", text.chars().take(400).collect::<String>());
        return Ok(());
    }

    let parsed: Value = serde_json::from_str(&text).context("thread is not JSON")?;
    if let Some(object) = parsed.as_object() {
        let mut keys: Vec<&String> = object.keys().collect();
        keys.sort();
        println!("== top-level keys: {keys:?}");
    }
    let members = parsed
        .get("members")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    println!("== {} members", members.len());
    if let Some(first) = members.first() {
        println!("== one member verbatim: {first}");
    }
    for member in &members {
        println!(
            "   {} role={:?} friendlyName={:?}",
            member.get("id").and_then(Value::as_str).unwrap_or(""),
            member.get("role").and_then(Value::as_str).unwrap_or(""),
            member
                .get("friendlyName")
                .or_else(|| member.get("friendlyname"))
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
    }

    println!("== parsed by teams_members");
    let people = teams_lite::teams_members::fetch_thread_members(&http, &session, &thread).await?;
    for person in &people {
        println!("   {} {:?}", person.mri, person.display_name);
    }
    Ok(())
}
