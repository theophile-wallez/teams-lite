// Manual live check for an OUTBOUND @mention: send a message that mentions somebody,
// then read it back and see what Teams stored.
//
// It pins the one fact the composer's mention rests on: a mention is a PAIR — an inert
// span in the body carrying only an index, and a `properties.mentions` entry keyed by
// that index saying who the index names (`teams_send::build_body` writes it,
// `teams_read::parse_mentions` reads it). Nothing but a live round-trip proves the two
// halves agree, because a wrong shape does not fail: the message simply arrives with
// blue text that notifies nobody.
//
// It is NOT a unit test: it posts to real Teams. Two rails, both deliberate:
//   - the conversation is a CONST — the sandbox channel from AGENTS.md, the one place a
//     send is pre-authorized. Do not parameterize it (rule 1c of
//     .claude/hooks/guard-live-automation.sh refuses an example that can post anywhere).
//   - the mention names US and nobody else. A mention notifies the person it names, and
//     a colleague never agreed to be pinged by a probe, so the only identity this file
//     may mention is `session.self_mri`.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example mention_send_probe
use anyhow::{Context, Result};

use teams_lite::{teams, teams_read, teams_send};

/// The sandbox channel (AGENTS.md § Sending messages). The only pre-authorized
/// target, and the only conversation this file may ever name.
const SANDBOX_THREAD: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    // The pair, exactly as the composer builds it: one span with an index, one mention
    // entry naming who that index is. The mentioned person is us.
    let name = if session.self_name.is_empty() {
        "me".to_string()
    } else {
        session.self_name.clone()
    };
    let html = format!(
        "<p><span itemscope=\"\" itemtype=\"http://schema.skype.com/Mention\" itemid=\"0\">{}</span> \
         mention shape probe</p>",
        teams_send::escape_html(&name)
    );
    let mentions = vec![teams_send::Mention {
        itemid: 0,
        mri: session.self_mri.clone(),
        display_name: name.clone(),
    }];

    let sent = teams_send::send_message(
        &http,
        &session,
        "",
        SANDBOX_THREAD,
        "",
        None,
        Some(&html),
        &[],
        &mentions,
    )
    .await
    .context("send the mention")?;
    println!("sent id={} clientmessageid={}", sent.id, sent.client_message_id);

    // Read it back through the ordinary read path: what the parser recovers is what the
    // web app renders, so this is the assertion that matters.
    let page = teams_read::fetch_newest(&http, &session, SANDBOX_THREAD)
        .await
        .context("read the thread back")?;
    let ours = page
        .messages
        .iter()
        .find(|m| m.id == sent.id)
        .or_else(|| page.messages.last())
        .context("the thread came back empty")?;
    println!("== content: {}", ours.content);
    println!("== mentions: {}", ours.mentions);
    let parsed: serde_json::Value =
        serde_json::from_str(&ours.mentions).context("stored mentions are not JSON")?;
    let first = parsed.get(0).context("Teams stored NO mention for this message")?;
    anyhow::ensure!(
        first.get("mri").and_then(serde_json::Value::as_str) == Some(session.self_mri.as_str()),
        "the mention came back naming somebody else: {first}"
    );
    println!("== the mention round-tripped: {first}");
    Ok(())
}
