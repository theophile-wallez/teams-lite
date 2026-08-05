// Manual live check for CUSTOM EMOJI REACTIONS: post one message, react to it with
// an arbitrary emotion key shaped as `tlcustom-<shortcode>-<ams_id>`, read the
// properties.emotions snapshot back, then clear with `value: 0` and read again.
//
// It exercises what Task 13 (custom emoji reactions) rests on: whether Teams accepts
// an arbitrary emotion key, what its length ceiling is if one exists, and whether the
// `value: 0` clear works as expected.
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

use teams_lite::{teams, teams_send};

/// The sandbox channel (CLAUDE.md § Sending messages). The only pre-authorized
/// target, and the only conversation this file may ever name.
const SANDBOX: &str = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::new();
    let session = teams::connect(&http).await.context("connect to Teams")?;
    println!("signed in as {} ({})", session.self_name, session.self_mri);

    // Get IC3 token for AMS upload.
    let ic3 = teams_lite::auth::get_token("https://api.aps.skype.com/.default")
        .await
        .context("acquire IC3 token")?;

    // 1. Upload a small PNG to get an AMS id for the custom emoji reaction key.
    let green_png = build_1x1_green_png();
    println!("uploading green.png ({} bytes)...", green_png.len());
    let image = teams_send::ImageUpload {
        name: "green.png".to_string(),
        content_type: "image/png".to_string(),
        bytes: green_png,
        width: Some(1),
        height: Some(1),
    };
    let ams_id = upload_and_get_id(&http, &session, &ic3, &image)
        .await
        .context("upload green.png")?;
    println!("green.png -> AMS id = {}", ams_id);

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
    )
    .await
    .context("post the message")?;
    anyhow::ensure!(!sent.id.is_empty(), "the send returned no message id");
    println!("posted message, id = {}", sent.id);

    // 3. Set a custom emoji reaction: arbitrary key shaped as `tlcustom-shipit-<ams_id>`.
    let custom_key = format!("tlcustom-shipit-{}", ams_id);
    println!("\nsetting custom emoji reaction with key = {}", custom_key);
    let set_result = set_reaction_raw(&http, &session, SANDBOX, &sent.id, &custom_key, true).await;
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

    // Check whether the custom key appears in the snapshot.
    let custom_key_present = emotions_after_set
        .as_object()
        .and_then(|obj| obj.get(&session.self_mri))
        .and_then(Value::as_object)
        .map(|user_emotions| user_emotions.contains_key(&custom_key))
        .unwrap_or(false);
    println!("custom key present in emotions: {}", if custom_key_present { "yes" } else { "no" });

    // 5. Clear the reaction with value: 0.
    println!("\nclearing reaction with value: 0...");
    let clear_result = set_reaction_raw(&http, &session, SANDBOX, &sent.id, &custom_key, false).await;
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

    let custom_key_after_clear = emotions_after_clear
        .as_object()
        .and_then(|obj| obj.get(&session.self_mri))
        .and_then(Value::as_object)
        .map(|user_emotions| user_emotions.contains_key(&custom_key))
        .unwrap_or(false);
    println!("custom key still present after clear: {}", if custom_key_after_clear { "yes" } else { "no" });

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

/// Upload one image to AMS and return only its id. Duplicates the two-request AMS
/// dance from teams_send::upload_image (which is private) so the probe can construct
/// a custom reaction key from the id.
async fn upload_and_get_id(
    http: &reqwest::Client,
    session: &teams::Session,
    ic3: &str,
    image: &teams_send::ImageUpload,
) -> Result<String> {
    anyhow::ensure!(!ic3.is_empty(), "missing IC3 token");
    let ams = ams_endpoint(session)?;

    // Step 1: POST to /v1/objects/ to create the object.
    let create_url = format!("{ams}/v1/objects/");
    let create_body = serde_json::json!({
        "type": "pish/image",
        "permissions": { (SANDBOX): ["read"] },
        "sharingMode": "Inline",
        "filename": image.name,
    });
    let response = http
        .post(&create_url)
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", "1415/26061118216")
        .json(&create_body)
        .send()
        .await
        .context("create AMS image object")?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "create AMS image object -> {status}: {}",
            text.chars().take(160).collect::<String>()
        );
    }
    let response: Value = response.json().await.context("parse AMS image object")?;
    let id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .context("AMS image object response had no id")?
        .to_string();

    // Step 2: PUT to /v1/objects/{id}/content/imgpsh to upload the bytes.
    let upload_url = format!("{ams}/v1/objects/{id}/content/imgpsh");
    let response = http
        .put(&upload_url)
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", "1415/26061118216")
        .header("content-type", "application/octet-stream")
        .body(image.bytes.clone())
        .send()
        .await
        .context("upload AMS image content")?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "upload AMS image content -> {status}: {}",
            text.chars().take(160).collect::<String>()
        );
    }

    Ok(id)
}

fn ams_endpoint(session: &teams::Session) -> Result<&str> {
    session
        .endpoint("amsV2")
        .or_else(|| session.endpoint("ams"))
        .map(|endpoint| endpoint.trim_end_matches('/'))
        .filter(|endpoint| !endpoint.is_empty())
        .context("no amsV2 or ams endpoint in regionGtms")
}

/// Set or clear a reaction with explicit HTTP handling so non-2xx responses are
/// captured and printed. Mirrors teams_send::set_reaction but returns the raw
/// response for inspection.
async fn set_reaction_raw(
    http: &reqwest::Client,
    session: &teams::Session,
    conversation_id: &str,
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
        urlencoding::encode(conversation_id),
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
        body.chars().take(160).collect::<String>()
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
