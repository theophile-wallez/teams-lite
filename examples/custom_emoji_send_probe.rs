// Manual live check for INLINE CUSTOM EMOJI: upload two images via AMS, post one
// message whose content embeds both as `<img itemtype="http://schema.skype.com/Emoji"`
// with `src`, `width`, `height`, and `itemid`/`alt`, then read the message back and
// report whether Teams' server-side sanitizer kept those attributes and whether the
// images stayed inline BETWEEN the surrounding words.
//
// It also checks whether a SECOND message may re-reference the first AMS object id,
// which is what sharing one uploaded image across multiple messages depends on.
//
// This exercises what Task 5 (inline rendering) and Task 6 (upload once, use many
// times) rest on: that Teams accepts custom emoji markup shaped as the spec § 5.2
// describes, and that AMS objects are reusable.
//
// It is NOT a unit test: it posts to real Teams. The conversation is therefore a
// CONST, not an argument — the sandbox channel from CLAUDE.md, the one place a send is
// pre-authorized. Do not parameterize it: an example that can post anywhere is a send
// waiting for a typo, and `.claude/hooks/guard-live-automation.sh` (rule 1c) refuses
// to run one.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example custom_emoji_send_probe
//
use anyhow::{Context, Result};
use serde_json::Value;

use teams_lite::{teams, teams_send};

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

    // Get IC3 token for AMS uploads.
    let ic3 = teams_lite::auth::get_token(IC3_SCOPE)
        .await
        .context("acquire IC3 token")?;

    // 1. Upload two small PNGs: a 1×1 red square and a 2×2 blue square, built inline.
    let red_png = build_1x1_red_png();
    let blue_png = build_2x2_blue_png();

    println!("uploading red.png ({} bytes)...", red_png.len());
    let image1 = teams_send::ImageUpload {
        name: "red.png".to_string(),
        content_type: "image/png".to_string(),
        bytes: red_png,
        width: Some(1),
        height: Some(1),
    };
    let ams1 = upload_image_and_get_id(&http, &session, &ic3, &image1)
        .await
        .context("upload red.png")?;
    println!("red.png -> AMS id = {}", ams1.id);

    println!("uploading blue.png ({} bytes)...", blue_png.len());
    let image2 = teams_send::ImageUpload {
        name: "blue.png".to_string(),
        content_type: "image/png".to_string(),
        bytes: blue_png,
        width: Some(2),
        height: Some(2),
    };
    let ams2 = upload_image_and_get_id(&http, &session, &ic3, &image2)
        .await
        .context("upload blue.png")?;
    println!("blue.png -> AMS id = {}", ams2.id);

    // 2. POST one message with both images embedded as custom emoji markup, positioned
    // BETWEEN surrounding words to verify they stay inline.
    let content = format!(
        "before <img itemtype=\"http://schema.skype.com/Emoji\" itemid=\"a\" alt=\":a:\" \
         src=\"{}\" width=\"20\" height=\"20\"> middle <img itemtype=\"http://schema.skype.com/Emoji\" \
         itemid=\"b\" alt=\":b:\" src=\"{}\" width=\"20\" height=\"20\"> after",
        ams1.src, ams2.src
    );
    let sent = send_with_ams_refs(&http, &session, &ic3, SANDBOX, &content, &[&ams1.id, &ams2.id])
        .await
        .context("send message with custom emoji")?;
    anyhow::ensure!(!sent.id.is_empty(), "the send returned no message id");
    println!("posted message 1, id = {}", sent.id);

    // 3. Read the message back and print the RAW stored body verbatim.
    let stored1 = read_message(&http, &session, &sent.id).await?;
    println!("\n=== Message 1 stored body (raw) ===");
    println!("{}", stored1.get("content").and_then(Value::as_str).unwrap_or(""));
    println!("=== End raw body ===\n");

    // 4. Check what survived: itemtype, src, width, height, and inline positioning.
    let body = stored1.get("content").and_then(Value::as_str).unwrap_or("");

    let itemtype_survived = body.contains("itemtype=\"http://schema.skype.com/Emoji\"");
    let src_survived = body.contains("src=") && body.contains(&ams1.id);
    let width_survived = body.contains("width=\"20\"");
    let height_survived = body.contains("height=\"20\"");

    // Check that both images are still BETWEEN the words: "before" precedes the first
    // image, "middle" sits between the two images, and "after" follows the second.
    let before_pos = body.find("before");
    let first_img_pos = body.find(&ams1.id);
    let middle_pos = body.find("middle");
    let second_img_pos = body.find(&ams2.id);
    let after_pos = body.find("after");

    let inline = match (before_pos, first_img_pos, middle_pos, second_img_pos, after_pos) {
        (Some(b), Some(i1), Some(m), Some(i2), Some(a)) => {
            b < i1 && i1 < m && m < i2 && i2 < a
        }
        _ => false,
    };

    println!("itemtype survived: {}", if itemtype_survived { "yes" } else { "no" });
    println!("src survived: {}", if src_survived { "yes" } else { "no" });
    println!("width survived: {}", if width_survived { "yes" } else { "no" });
    println!("height survived: {}", if height_survived { "yes" } else { "no" });
    println!("images stayed inline: {}", if inline { "yes" } else { "no" });

    // 5. POST a second message re-referencing the FIRST AMS object id.
    let content2 = format!(
        "second message reusing <img itemtype=\"http://schema.skype.com/Emoji\" \
         itemid=\"a\" alt=\":a:\" src=\"{}\" width=\"20\" height=\"20\"> red.png",
        ams1.src
    );
    let result2 = send_with_ams_refs(&http, &session, &ic3, SANDBOX, &content2, &[&ams1.id]).await;
    match result2 {
        Ok(sent2) => {
            println!("\nsecond message accepted, id = {}", sent2.id);
            let stored2 = read_message(&http, &session, &sent2.id).await?;
            let body2 = stored2.get("content").and_then(Value::as_str).unwrap_or("");
            let reuse_worked = body2.contains(&ams1.id);
            println!("AMS object re-reference worked: {}", if reuse_worked { "yes" } else { "no" });
        }
        Err(e) => {
            println!("\nsecond message refused: {}", e);
            println!("AMS object re-reference: not supported");
        }
    }

    println!("\nOK — custom emoji send probe complete");
    Ok(())
}

/// Build a 1×1 red PNG (67 bytes).
fn build_1x1_red_png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, // RGB
        0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
        0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, // red pixel
        0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb4,
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND chunk
        0xae, 0x42, 0x60, 0x82,
    ]
}

/// Build a 2×2 blue PNG (77 bytes).
fn build_2x2_blue_png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, // 2×2
        0x08, 0x02, 0x00, 0x00, 0x00, 0xfd, 0xd4, 0x9a, 0x73, // RGB
        0x00, 0x00, 0x00, 0x16, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
        0x08, 0xd7, 0x63, 0xfc, 0xcf, 0xc0, 0xf0, 0x9f, // blue pixels
        0x81, 0x81, 0xe1, 0x3f, 0x03, 0x03, 0xc3, 0x7f,
        0x06, 0x00, 0x09, 0x1f, 0x03, 0xfe, 0x87, 0x5c,
        0xac, 0x0f,
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND chunk
        0xae, 0x42, 0x60, 0x82,
    ]
}

/// Upload one image to AMS and return its id and src. Extracted from
/// `teams_send::upload_image` (which is private), duplicating the two-request dance
/// so the probe can name an image id explicitly in the message body.
#[derive(Debug, Clone)]
struct AmsImage {
    id: String,
    src: String,
}

async fn upload_image_and_get_id(
    http: &reqwest::Client,
    session: &teams::Session,
    ic3: &str,
    image: &teams_send::ImageUpload,
) -> Result<AmsImage> {
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
        .context("AMS image object response had no id")?;

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

    Ok(AmsImage {
        id: id.to_string(),
        src: format!("{ams}/v1/objects/{id}/views/imgo"),
    })
}

fn ams_endpoint(session: &teams::Session) -> Result<&str> {
    session
        .endpoint("amsV2")
        .or_else(|| session.endpoint("ams"))
        .map(|endpoint| endpoint.trim_end_matches('/'))
        .filter(|endpoint| !endpoint.is_empty())
        .context("no amsV2 or ams endpoint in regionGtms")
}

/// Send a message with explicit HTML content and amsreferences array.
async fn send_with_ams_refs(
    http: &reqwest::Client,
    session: &teams::Session,
    _ic3: &str,
    conversation_id: &str,
    content: &str,
    ams_ids: &[&str],
) -> Result<teams_send::Sent> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages",
        urlencoding::encode(conversation_id)
    );
    let cmid = teams_send::new_client_message_id();

    let mut body = serde_json::json!({
        "clientmessageid": cmid,
        "content": content,
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": session.self_name,
    });
    if !ams_ids.is_empty() {
        body["amsreferences"] = serde_json::json!(ams_ids);
    }

    let resp = http
        .post(&url)
        .header(
            "authentication",
            format!("skypetoken={}", session.skypetoken),
        )
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("send message request")?;
    let status = resp.status();
    let resp_body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("send -> {status}: {}", resp_body.chars().take(160).collect::<String>());
    }

    Ok(teams_send::Sent {
        id: sent_message_id(&resp_body),
        client_message_id: cmid,
    })
}

/// The server message id in a send response, or `""` when it carries none.
/// Copied from teams_send.rs (private).
fn sent_message_id(body: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    parsed
        .get("id")
        .or_else(|| parsed.get("OriginalArrivalTime"))
        .and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|n| n.to_string())))
        .unwrap_or_default()
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
    serde_json::from_str(&body).context("the message body is not JSON")
}
