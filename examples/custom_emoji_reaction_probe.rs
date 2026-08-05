// Manual live check for CUSTOM EMOJI REACTIONS: post one message, react to it with the
// key this app really mints — `tlcustom-<the AMS object URL>` — read the
// properties.emotions snapshot back, then clear with `value: 0` and read again.
//
// It exercises what custom emoji reactions rest on: whether Teams accepts an arbitrary
// emotion key, whether it survives the round trip unchanged (the key IS the art's
// address, so a key the service rewrote would leave every reader with nothing to fetch),
// what its length ceiling is, and whether the `value: 0` clear works as expected.
//
// The key is built by `custom_emoji::custom_reaction_key` and the upload by
// `teams_send::upload_ams_object_url`, both shipped: a probe that spelled either itself
// would measure a shape the app does not send. It used to spell the key — name first,
// then the id — and that shape could not be read back at all, since a legal emoji name
// may hold digits and hyphens and so can the id.
//
// It is NOT a unit test: it posts to real Teams and sets a reaction. The conversation
// is therefore a CONST, not an argument — the sandbox channel from CLAUDE.md, the one
// place a send is pre-authorized. Do not parameterize it: an example that can post
// anywhere is a send waiting for a typo, and `.claude/hooks/guard-live-automation.sh`
// (rule 1c) refuses to run one.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example custom_emoji_reaction_probe
//
use anyhow::{Context, Result};
use serde_json::Value;

use teams_lite::{custom_emoji, teams, teams_send};

/// The sandbox channel (CLAUDE.md § Sending messages). The only pre-authorized
/// target, and the only conversation this file may ever name.
const SANDBOX: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/// IC3 token scope for AMS uploads (from src/bin/server.rs:119).
const IC3_SCOPE: &str = "https://ic3.teams.office.com/Teams.AccessAsUser.All";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    // Get IC3 token for AMS upload.
    let ic3 = teams_lite::auth::get_token(IC3_SCOPE)
        .await
        .context("acquire IC3 token")?;

    // 1. Upload a small PNG and keep the URL its art is served from — the whole of what
    //    the reaction key carries.
    let green_png = build_1x1_green_png();
    println!("uploading green.png ({} bytes)...", green_png.len());
    let object_url =
        teams_send::upload_ams_object_url(&http, &session, &ic3, SANDBOX, "green.png", &green_png)
            .await
            .context("upload green.png")?;
    println!("green.png -> {}", object_url);

    // 2. POST one message to react to.
    let sent = teams_send::send_message(
        &http,
        &session,
        &ic3,
        SANDBOX,
        "reaction probe — this message gets a custom emoji reaction",
        None,
        None,
        None,
        &[],
        &[],
    )
    .await
    .context("post the message")?;
    anyhow::ensure!(!sent.id.is_empty(), "the send returned no message id");
    println!("posted message, id = {}", sent.id);

    // 3. Set a custom emoji reaction with the key the app mints: `tlcustom-<objectUrl>`.
    let custom_key = custom_emoji::custom_reaction_key(&object_url);
    println!("\nsetting custom emoji reaction with key = {}", custom_key);
    println!("  ({} characters)", custom_key.len());
    let set_result = set_reaction_raw(&http, &session, &sent.id, &custom_key, true).await;
    match &set_result {
        Ok(()) => println!("reaction PUT succeeded (2xx)"),
        Err(e) => {
            println!("reaction PUT failed:");
            println!("  {}", e);
        }
    }

    // 4. Read the message's properties.emotions back and print the snapshot.
    let emotions_after_set = read_emotions(&http, &session, &sent.id).await?;
    println!("\nproperties.emotions after setting:");
    println!("{}", serde_json::to_string_pretty(&emotions_after_set).unwrap_or_default());

    let key_accepted = set_result.is_ok();
    let key_present = emotion_entry_exists(&emotions_after_set, &custom_key);
    println!("key accepted (2xx): {}", if key_accepted { "yes" } else { "no" });
    println!("key present in snapshot: {}", if key_present { "yes" } else { "no" });
    // The key IS the address of the art, so a key the service normalized — lowercased, or
    // truncated — would leave every reader with a URL that fetches nothing.
    println!(
        "key round-tripped byte for byte: {}",
        if emotion_key_verbatim(&emotions_after_set, &custom_key) { "yes" } else { "no" }
    );

    // Cleared straight away rather than left up for a human to look at: nobody has ever
    // observed what a stock Teams client draws for one of these, and the pause used to be
    // for exactly that. A reaction on a real thread is left there as briefly as possible.
    std::thread::sleep(std::time::Duration::from_secs(3));

    // 5. Clear the reaction with value: 0.
    println!("\nclearing reaction with value: 0...");
    let clear_result = set_reaction_raw(&http, &session, &sent.id, &custom_key, false).await;
    match &clear_result {
        Ok(()) => println!("clear PUT succeeded (2xx)"),
        Err(e) => {
            println!("clear PUT failed:");
            println!("  {}", e);
        }
    }

    // 6. Read properties.emotions again after the clear.
    let emotions_after_clear = read_emotions(&http, &session, &sent.id).await?;
    println!("\nproperties.emotions after clearing:");
    println!("{}", serde_json::to_string_pretty(&emotions_after_clear).unwrap_or_default());

    let key_present_after = emotion_entry_exists(&emotions_after_clear, &custom_key);
    let our_value_after = emotion_value_for(&emotions_after_clear, &custom_key, &session.self_mri);
    println!("key present in snapshot: {}", if key_present_after { "yes" } else { "no" });
    println!("our value after clear: {}", our_value_after);

    // 7. Test a deliberately long key to find the length ceiling. An object URL is about
    //    100 characters, so this is the headroom the key shape has.
    let long_key = format!("tlcustom-{}", "a".repeat(280));
    println!("\nsetting long key ({} chars)...", long_key.len());
    let long_result = set_reaction_raw(&http, &session, &sent.id, &long_key, true).await;
    let long_accepted = long_result.is_ok();
    println!("long key ({} chars) accepted: {}", long_key.len(), if long_accepted { "yes" } else { "no" });

    if long_accepted {
        let emotions_long = read_emotions(&http, &session, &sent.id).await?;
        let long_present = emotion_entry_exists(&emotions_long, &long_key);
        println!("long key present in snapshot: {}", if long_present { "yes" } else { "no" });

        std::thread::sleep(std::time::Duration::from_secs(3));
        let cleared = set_reaction_raw(&http, &session, &sent.id, &long_key, false).await;
        println!("long key cleared: {}", if cleared.is_ok() { "yes" } else { "no" });
    }

    println!("\nOK — custom emoji reaction probe complete");
    Ok(())
}

/// Build a 1×1 green PNG (67 bytes).
fn build_1x1_green_png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, // RGB
        0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
        0x08, 0xd7, 0x63, 0x60, 0xf8, 0x0f, 0x00, 0x00, // green pixel
        0x01, 0x01, 0x01, 0x00, 0x18, 0xd0, 0x84, 0x8f,
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND chunk
        0xae, 0x42, 0x60, 0x82,
    ]
}

/// Set or clear a reaction with explicit HTTP handling so non-2xx responses are
/// captured and printed. Mirrors teams_send::set_reaction but returns the raw
/// response for inspection.
async fn set_reaction_raw(
    http: &reqwest::Client,
    session: &teams::Session,
    message_id: &str,
    key: &str,
    on: bool,
) -> Result<()> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}/properties?name=emotions",
        urlencoding::encode(SANDBOX),
        urlencoding::encode(message_id)
    );
    let value = if on { now_ms() } else { 0 };
    let body = serde_json::json!({ "emotions": { "key": key, "value": value } });

    let resp = http
        .put(&url)
        .header(
            "authentication",
            format!("skypetoken={}", session.skypetoken),
        )
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("set reaction request")?;

    let status = resp.status();
    let resp_body = resp.text().await.unwrap_or_default();

    // Print the response details regardless of status.
    println!("  status: {}", status);
    if !resp_body.is_empty() {
        println!("  body: {}", resp_body.chars().take(500).collect::<String>());
    }
    // Also print relevant headers if available (these are from the original request,
    // response headers would need to be captured before .text()).

    if !status.is_success() {
        anyhow::bail!("reaction -> {status}");
    }
    Ok(())
}

/// Current time in milliseconds since the Unix epoch.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read the properties.emotions value from one message.
async fn read_emotions(
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
        urlencoding::encode(SANDBOX),
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
        body.chars().take(500).collect::<String>()
    );
    let parsed: Value = serde_json::from_str(&body).context("the message body is not JSON")?;

    // properties can be either an object or a JSON-encoded string.
    let properties = parsed.get("properties");
    let emotions = match properties {
        Some(Value::String(s)) => {
            let props: Value = serde_json::from_str(s).unwrap_or(Value::Null);
            props.get("emotions").cloned().unwrap_or(Value::Null)
        }
        Some(Value::Object(obj)) => obj.get("emotions").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };

    Ok(emotions)
}

/// Whether the snapshot carries the key EXACTLY as it was sent. `emotion_entry_exists`
/// answers the same question, so this is really an assertion about the comparison itself
/// being byte-for-byte — spelled out because the key is a URL a reader has to fetch.
fn emotion_key_verbatim(emotions: &Value, key: &str) -> bool {
    emotions
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| entry.get("key").and_then(Value::as_str))
                .any(|found| found == key)
        })
        .unwrap_or(false)
}

/// Check whether an emotion entry with the given key exists in the emotions array.
/// The array shape is: `[{"key": "...", "users": [...]}]`.
fn emotion_entry_exists(emotions: &Value, key: &str) -> bool {
    emotions
        .as_array()
        .map(|arr| arr.iter().any(|entry| {
            entry.get("key").and_then(Value::as_str) == Some(key)
        }))
        .unwrap_or(false)
}

/// Extract our own emotion value for a given key. Returns the value as a string,
/// or "not found" if the key or our user entry does not exist.
/// The array shape is: `[{"key": "...", "users": [{"mri": "...", "value": "..."}]}]`.
fn emotion_value_for(emotions: &Value, key: &str, mri: &str) -> String {
    emotions
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
                .and_then(|entry| entry.get("users"))
                .and_then(Value::as_array)
                .and_then(|users| {
                    users.iter()
                        .find(|user| user.get("mri").and_then(Value::as_str) == Some(mri))
                        .and_then(|user| user.get("value"))
                        .and_then(Value::as_str)
                })
        })
        .unwrap_or("not found")
        .to_string()
}
