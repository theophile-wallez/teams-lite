// Manual live check for DELETING a message: post one, delete it, then read the
// message resource back and prove Teams marked it rather than kept it.
//
// It exercises what the `delete` RPC in src/bin/server.rs calls
// (`teams_send::delete_message`) and pins the one fact the read path rests on: a
// deletion is a message whose `properties.deletetime` is set and whose body is
// blank — which is exactly what `teams_read::is_deleted` looks for, and therefore
// what turns the bubble into the "You deleted this message" placeholder.
//
// It is NOT a unit test: it posts to real Teams, and then removes what it posted.
// The conversation is a CONST, not an argument — the sandbox channel from AGENTS.md,
// the one place a send is pre-authorized. Do not parameterize it: an example that can
// act anywhere is an outward action waiting for a typo, and
// `.claude/hooks/guard-live-automation.sh` (rule 1c) refuses to run one.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example message_delete_probe
//
use anyhow::{Context, Result};
use serde_json::Value;

use teams_lite::{teams, teams_send};

/// The sandbox channel (AGENTS.md § Sending messages). The only pre-authorized
/// target, and the only conversation this file may ever name.
const SANDBOX_THREAD: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    // 1. Post the message this probe will remove. The ic3 token only uploads an
    // image or emoji, and there is none here, so it stays empty.
    let sent = teams_send::send_message(
        &http,
        &session,
        "",
        SANDBOX_THREAD,
        // No thread: every probe posts to the sandbox chat, which has no threads to post into.
        None,
        "",
        None,
        Some("<p>delete probe — this message removes itself</p>"),
        &[],
        &[],
        // A probe mentions nobody: a mention notifies the person it names.
        &[],
        // Posted now: this probe deletes what it posts.
        None,
        None, // no title: a probe posts no channel post
        // A probe seals nothing: it posts to the sandbox chat in the clear.
        None,
    )
    .await
    .context("post the message to delete")?;
    anyhow::ensure!(!sent.id.is_empty(), "the send returned no message id to delete");
    println!("posted, id = {}", sent.id);

    // 2. The message exists and carries no deletion marker yet.
    let before = read_message(&http, &session, &sent.id).await?;
    anyhow::ensure!(
        deletion_time(&before).is_none(),
        "a freshly sent message already looks deleted: {before}"
    );

    // 3. Delete it.
    teams_send::delete_message(&http, &session, SANDBOX_THREAD, &sent.id)
        .await
        .context("delete the message")?;
    println!("deleted");

    // 4. Read it back. A 2xx is not proof: what matters is the shape Teams now holds,
    // because that shape is what every client — ours included — renders from.
    let after = read_message(&http, &session, &sent.id).await?;
    let content = after.get("content").and_then(Value::as_str).unwrap_or_default();
    match deletion_time(&after) {
        Some(time) => println!("Teams holds deletetime = {time}, content = {content:?}"),
        None => anyhow::bail!("the message carries no deletetime after the delete: {after}"),
    }
    anyhow::ensure!(
        content.trim().is_empty(),
        "the body survived the deletion server-side: {content:?}"
    );

    println!("OK — a delete leaves a blank message carrying a deletetime");
    Ok(())
}

/// One message resource in the sandbox channel, as Teams currently holds it.
async fn read_message(
    http: &reqwest::Client,
    session: &teams::Session,
    message_id: &str,
) -> Result<Value> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}",
        urlencoding::encode(SANDBOX_THREAD),
        urlencoding::encode(message_id)
    );
    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("read the message back")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    anyhow::ensure!(
        status.is_success(),
        "read -> {status}: {}",
        body.chars().take(160).collect::<String>()
    );
    serde_json::from_str(&body).context("the message body is not JSON")
}

/// The `properties.deletetime` Teams stamps on a deleted message, whatever shape the
/// properties arrive in (an object, or a JSON string) — the same two shapes
/// `teams_read::is_deleted` handles.
fn deletion_time(message: &Value) -> Option<String> {
    let properties = message.get("properties")?;
    let owned: Value = match properties.as_str() {
        Some(encoded) => serde_json::from_str(encoded).ok()?,
        None => properties.clone(),
    };
    let time = owned.get("deletetime")?;
    let time = time
        .as_str()
        .map(str::to_string)
        .or_else(|| time.as_i64().map(|n| n.to_string()))?;
    (!time.is_empty() && time != "0").then_some(time)
}
