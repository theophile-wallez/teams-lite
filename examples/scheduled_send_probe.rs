// Manual live check for a SCHEDULED send: hand Teams a message to deliver later, read
// back what the service is holding, cancel one, and watch the other arrive.
//
// It pins the four facts the feature rests on, and only a live round-trip can give any of
// them — a wrong shape does not fail here, it posts the message IMMEDIATELY, which is the
// one outcome a scheduled send must never have:
//   1. `properties.scheduledsendtime` (quoted epoch ms) makes the service HOLD the message
//      — `teams_send::SCHEDULED_SEND_TIME`, written by `build_body`.
//   2. what a held send answers with, since a Teams message id IS its arrival time and a
//      message that has not arrived may not have one yet.
//   3. whether a held message is visible in the ORDINARY history, which decides whether
//      the app needs a list of its own or the thread already is one.
//   4. whether DELETE cancels a held message — the undo the whole feature needs, since a
//      message the user cannot stop is an outward action nothing takes back.
//
// It is NOT a unit test: it posts to real Teams. Two rails, both deliberate:
//   - the conversation is a CONST — the sandbox channel from AGENTS.md, the one place a
//     send is pre-authorized. Do not parameterize it (rule 1c of
//     .claude/hooks/guard-live-automation.sh refuses an example that can post anywhere).
//   - both messages it posts are reversible: one is cancelled before it is ever delivered,
//     and the other is a line of probe text in the sandbox thread.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example scheduled_send_probe
use anyhow::{Context, Result};
use serde_json::Value;

use teams_lite::{teams, teams_read, teams_send};

/// The sandbox channel (AGENTS.md § Sending messages). The only pre-authorized
/// target, and the only conversation this file may ever name.
const SANDBOX_THREAD: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/// How far ahead the message we let DELIVER is scheduled. Long enough that the service
/// really has to hold it, short enough that one run of this probe sees it land.
const DELIVER_IN_SECONDS: i64 = 75;

/// How far ahead the message we CANCEL is scheduled. Far enough that it cannot be
/// delivered while the probe is still deciding whether the deletion worked.
const CANCEL_IN_SECONDS: i64 = 30 * 60;

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    let now = now_ms();
    let deliver_at = now + DELIVER_IN_SECONDS * 1000;
    let cancel_at = now + CANCEL_IN_SECONDS * 1000;

    // 1 + 2. Hand the service a message to deliver in just over a minute.
    let delivered = teams_send::send_message(
        &http,
        &session,
        "",
        SANDBOX_THREAD,
        "",
        None,
        Some("<p>scheduled send probe — this line was queued ahead of time</p>"),
        &[],
        &[],
        // A probe mentions nobody: a mention notifies the person it names.
        &[],
        Some(deliver_at),
    )
    .await
    .context("schedule the message that should be delivered")?;
    println!(
        "scheduled for +{DELIVER_IN_SECONDS}s: id={:?} clientmessageid={}",
        delivered.id, delivered.client_message_id
    );

    // 3. Is a held message in the ordinary history already? If it is, the thread IS the
    //    list of scheduled messages and the app needs no second surface.
    let page = teams_read::fetch_newest(&http, &session, SANDBOX_THREAD)
        .await
        .context("read the ordinary history")?;
    let in_history = page.messages.iter().any(|m| m.id == delivered.id && !delivered.id.is_empty());
    println!(
        "== ordinary history: {} messages, holds the scheduled one: {in_history}",
        page.messages.len()
    );

    // The held message, as the service describes it.
    let held = scheduled_view(&http, &session).await.context("read the scheduled view")?;
    report_scheduled("after scheduling one", &held);

    // 4. Schedule a second one far out and cancel it, which is the undo the feature needs.
    let doomed = teams_send::send_message(
        &http,
        &session,
        "",
        SANDBOX_THREAD,
        "",
        None,
        Some("<p>scheduled send probe — this line is cancelled before it is delivered</p>"),
        &[],
        &[],
        &[],
        Some(cancel_at),
    )
    .await
    .context("schedule the message that should be cancelled")?;
    println!("scheduled for +{CANCEL_IN_SECONDS}s: id={:?}", doomed.id);

    let before = scheduled_view(&http, &session).await?;
    report_scheduled("after scheduling both", &before);

    if doomed.id.is_empty() {
        println!("!! the send answered no id, so there is nothing to address a cancel to");
    } else {
        match teams_send::delete_message(&http, &session, SANDBOX_THREAD, &doomed.id).await {
            Ok(()) => println!("== DELETE on a held message: accepted"),
            Err(e) => println!("!! DELETE on a held message: {e}"),
        }
        let after = scheduled_view(&http, &session).await?;
        report_scheduled("after cancelling one", &after);
        let still_there = after.iter().any(|m| message_id(m) == doomed.id);
        println!("== the cancelled one is still held: {still_there}");
    }

    // And the one we left alone: does the service really post it?
    let wait = (deliver_at - now_ms()).max(0) + 20_000;
    println!("waiting {}s for the delivery…", wait / 1000);
    tokio::time::sleep(std::time::Duration::from_millis(wait as u64)).await;

    let after = teams_read::fetch_newest(&http, &session, SANDBOX_THREAD)
        .await
        .context("read the history back after the delivery")?;
    let arrived = after
        .messages
        .iter()
        .find(|m| m.content.contains("queued ahead of time"));
    match arrived {
        Some(m) => println!(
            "== DELIVERED: id={} compose_time={} sender={}",
            m.id, m.compose_time, m.sender
        ),
        None => println!("!! the scheduled message has NOT arrived in the ordinary history"),
    }
    let still_held = scheduled_view(&http, &session).await?;
    report_scheduled("after the delivery", &still_held);
    Ok(())
}

/// What the service is holding for this thread: the ordinary messages endpoint asked with
/// `?view=scheduled`, which is the only read path for a held message (there is no
/// `/scheduledmessages` collection — every spelling of it answers 404).
async fn scheduled_view(http: &reqwest::Client, session: &teams::Session) -> Result<Vec<Value>> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages?view=scheduled",
        urlencoding::encode(SANDBOX_THREAD)
    );
    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("scheduled view request")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    anyhow::ensure!(
        status.is_success(),
        "scheduled view -> {status}: {}",
        body.chars().take(160).collect::<String>()
    );
    let parsed: Value = serde_json::from_str(&body).context("scheduled view is not JSON")?;
    Ok(parsed
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// Print the SHAPE of what is held — ids, the scheduled time and the property names —
/// and never anybody's words: this runs against the real tenant.
fn report_scheduled(when: &str, messages: &[Value]) {
    println!("== scheduled view {when}: {} held", messages.len());
    for m in messages {
        let properties = m.get("properties").and_then(Value::as_object);
        let names: Vec<&str> = properties
            .map(|p| p.keys().map(String::as_str).collect())
            .unwrap_or_default();
        println!(
            "   id={} scheduledsendtime={:?} properties={names:?}",
            message_id(m),
            properties
                .and_then(|p| p.get(teams_send::SCHEDULED_SEND_TIME))
                .and_then(Value::as_str),
        );
    }
}

fn message_id(message: &Value) -> String {
    message
        .get("id")
        .and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string())))
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
