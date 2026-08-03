// Sending messages (slice 5). POST to the chatService messages endpoint.
//
// Shape proven from EionRobb/purple-teams (teams_send_message):
//   POST {chatService}/v1/users/ME/conversations/{convId}/messages
//   Header: Authentication: skypetoken=...
//   Body: {
//     "clientmessageid": "<unique epoch-ms>",  // dedups the echo that comes back
//     "content": "<html>",                      // user text, HTML-escaped
//     "messagetype": "RichText/Html",
//     "contenttype": "text",
//     "imdisplayname": "<our display name>"
//   }
//
// The server echoes the sent message back over the trouter with the same
// clientmessageid; our store dedups by server id, so the optimistic path and the
// echo converge without duplicates.

use anyhow::{Context, Result};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::teams::Session;

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_NAME_BYTES: usize = 255;
const AMS_CLIENT_VERSION: &str = "1415/26061118216";
const AMS_IMAGE_TYPE: &str = "http://schema.skype.com/AMSImage";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageUpload {
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImageParams {
    name: String,
    content_type: String,
    data_base64: String,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AmsImage {
    id: String,
    src: String,
    name: String,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyTo {
    pub compose_time: i64,
    pub sender: String,
    pub sender_mri: String,
    pub preview: String,
    pub before: String,
    pub after: String,
}

/// Escape user-typed plain text into the minimal HTML the RichText/Html type wants.
/// We send plain messages, so we only need to neutralize markup characters.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// A unique client message id: milliseconds since the Unix epoch. Teams uses this
/// to correlate the echoed message; uniqueness per-send is what matters.
pub fn new_client_message_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    ms.to_string()
}

/// Parse and validate the optional image object carried by the existing send RPC.
/// Decoding happens after a conservative encoded-length check, so an oversized
/// client value cannot allocate an unbounded decoded buffer.
pub fn parse_image(value: &Value) -> Result<ImageUpload> {
    let params: ImageParams = serde_json::from_value(value.clone()).context("invalid image")?;
    anyhow::ensure!(!params.name.is_empty(), "image name must not be empty");
    anyhow::ensure!(
        params.name.len() <= MAX_IMAGE_NAME_BYTES,
        "image name is too long"
    );
    anyhow::ensure!(
        !params.name.chars().any(|c| c.is_control()),
        "image name contains a control character"
    );

    let content_type = params.content_type.to_ascii_lowercase();
    anyhow::ensure!(
        matches!(
            content_type.as_str(),
            "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp"
                | "image/bmp"
                | "image/heic"
                | "image/heif"
        ),
        "unsupported image content type"
    );

    let max_encoded_len = MAX_IMAGE_BYTES.div_ceil(3) * 4;
    anyhow::ensure!(
        params.data_base64.len() <= max_encoded_len,
        "image exceeds the 10 MiB limit"
    );
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&params.data_base64)
        .context("image data is not valid base64")?;
    anyhow::ensure!(!bytes.is_empty(), "image data must not be empty");
    anyhow::ensure!(
        bytes.len() <= MAX_IMAGE_BYTES,
        "image exceeds the 10 MiB limit"
    );
    anyhow::ensure!(
        image_bytes_match_content_type(&bytes, &content_type),
        "image data does not match its content type"
    );

    validate_dimension("width", params.width)?;
    validate_dimension("height", params.height)?;

    Ok(ImageUpload {
        name: params.name,
        content_type,
        bytes,
        width: params.width,
        height: params.height,
    })
}

fn image_bytes_match_content_type(bytes: &[u8], content_type: &str) -> bool {
    match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        "image/heic" => is_iso_base_media_type(bytes, &[b"heic", b"heix", b"hevc", b"hevx"]),
        "image/heif" => is_iso_base_media_type(bytes, &[b"mif1", b"msf1", b"heif"]),
        _ => false,
    }
}

fn is_iso_base_media_type(bytes: &[u8], brands: &[&[u8; 4]]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && brands.iter().any(|brand| &bytes[8..12] == brand.as_slice())
}

fn validate_dimension(name: &str, value: Option<u32>) -> Result<()> {
    if let Some(value) = value {
        anyhow::ensure!(value > 0, "image {name} must be positive");
        anyhow::ensure!(
            value <= MAX_IMAGE_DIMENSION,
            "image {name} exceeds {MAX_IMAGE_DIMENSION} pixels"
        );
    }
    Ok(())
}

/// Send a message to a conversation. Returns the clientmessageid used (useful
/// for optimistic echo correlation).
///
/// `text` is the raw user input for a plain-text send. `content_html`, when set,
/// is the rich message body already normalized to the Teams-safe HTML subset by
/// the web client (see web/src/lib/rich-text.ts `serializeTeamsHtml`); it is
/// forwarded as the message content. The web read path renders inbound HTML
/// through an allowlist parser, so it is the XSS boundary; Teams also sanitizes
/// server-side. When both are present for a reply, the quote is prepended.
/// What a successful send tells us about the message that now exists.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Sent {
    /// The SERVER message id — what an edit, a reaction or a reply addresses.
    ///
    /// Teams returns no `id` field: the response body is `{"OriginalArrivalTime":
    /// 1785773946196}`, and a Teams message id IS its arrival time in epoch ms. That
    /// equality is what makes a streamed reply possible (post once, then edit as the
    /// answer grows) and it is verified against the real tenant — see
    /// `examples/agent_stream_probe.rs`. Empty when the response carried neither
    /// field: the message was still sent, so this is never an error here.
    pub id: String,
    /// The id we generated, which the trouter echo carries back.
    pub client_message_id: String,
}

pub async fn send_message(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    conversation_id: &str,
    text: &str,
    reply_to: Option<&ReplyTo>,
    content_html: Option<&str>,
    image: Option<&ImageUpload>,
) -> Result<Sent> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages",
        urlencoding::encode(conversation_id)
    );
    let cmid = new_client_message_id();
    let ams_image = match image {
        Some(image) => Some(upload_image(http, session, ic3, conversation_id, image).await?),
        None => None,
    };
    let body = build_body(
        &cmid,
        text,
        &session.self_name,
        reply_to,
        content_html,
        ams_image.as_ref(),
    );

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
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("send -> {status}: {}", body.chars().take(160).collect::<String>());
    }
    Ok(Sent { id: sent_message_id(&body), client_message_id: cmid })
}

/// The server message id in a send response, or `""` when it carries none.
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

async fn upload_image(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    conversation_id: &str,
    image: &ImageUpload,
) -> Result<AmsImage> {
    anyhow::ensure!(!ic3.is_empty(), "missing IC3 token");
    let ams = ams_endpoint(session)?;
    let create_url = format!("{ams}/v1/objects/");
    let create_body = build_ams_create_body(conversation_id, &image.name);
    let response = http
        .post(&create_url)
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", AMS_CLIENT_VERSION)
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
    validate_ams_id(id)?;

    let upload_url = format!("{ams}/v1/objects/{id}/content/imgpsh");
    let response = http
        .put(&upload_url)
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", AMS_CLIENT_VERSION)
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
        name: image.name.clone(),
        width: image.width,
        height: image.height,
    })
}

fn ams_endpoint(session: &Session) -> Result<&str> {
    session
        .endpoint("amsV2")
        .or_else(|| session.endpoint("ams"))
        .map(|endpoint| endpoint.trim_end_matches('/'))
        .filter(|endpoint| !endpoint.is_empty())
        .context("no amsV2 or ams endpoint in regionGtms")
}

fn validate_ams_id(id: &str) -> Result<()> {
    anyhow::ensure!(
        !id.is_empty()
            && id.len() <= 512
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "AMS image object response had an invalid id"
    );
    Ok(())
}

fn build_ams_create_body(conversation_id: &str, filename: &str) -> Value {
    json!({
        "type": "pish/image",
        "permissions": { (conversation_id): ["read"] },
        "sharingMode": "Inline",
        "filename": filename,
    })
}

/// Edit an existing message in place. Mirrors `send_message`, but targets the
/// message resource directly with `PUT`, so the server updates the original
/// message rather than creating a new one.
///
/// Shape proven from the Skype chatService messaging API (Terrance/SkPy,
/// `SkypeChat.editRaw`):
///   PUT {chatService}/v1/users/ME/conversations/{convId}/messages/{messageId}
///   Header: Authentication: skypetoken=...
///   Body: { "content": "<html>", "messagetype": "RichText/Html", "contenttype": "text" }
///
/// There is no `clientmessageid`: the message id already exists and identifies
/// the resource being replaced. The server echoes a `MessageUpdate` over the
/// trouter carrying the same message id and the new content.
/// Replace the content of one of our own messages.
///
/// `content_html` is the same escape hatch [`send_message`] has: when set it becomes
/// the body verbatim, so an edit can carry markup. The streamed agent reply lives on
/// it — the answer is one message edited as it grows, and an answer with paragraphs,
/// lists and code blocks would otherwise arrive as one run-on line (a newline means
/// nothing in HTML). `text` is escaped as before when it is `None`.
pub async fn edit_message(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    message_id: &str,
    text: &str,
    content_html: Option<&str>,
) -> Result<()> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}",
        urlencoding::encode(conversation_id),
        urlencoding::encode(message_id)
    );
    let body = build_edit_body(text, content_html, &session.self_name);

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
        .context("edit message request")?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!(
            "edit -> {status}: {}",
            txt.chars().take(160).collect::<String>()
        );
    }
    Ok(())
}

/// Set or clear OUR reaction (Teams "emotion") on a message. Teams keeps one
/// reaction per user per message, so setting a new `key` replaces any previous
/// one server-side; `on = false` clears our reaction for `key`.
///
/// Endpoint — the `properties?name=<name>` PUT pattern is proven in
/// EionRobb/purple-teams (e.g. `consumptionhorizon`), and the emotions body
/// mirrors the Skype chatService reaction API:
///   PUT {chatService}/v1/users/ME/conversations/{convId}/messages/{messageId}/properties?name=emotions
///   Header: Authentication: skypetoken=...
///   Body (add):    { "emotions": { "key": "<key>", "value": <epoch_ms> } }
///   Body (remove): { "emotions": { "key": "<key>", "value": 0 } }
///
/// Removal is a NON-destructive PUT (value 0), never a blanket DELETE of the
/// emotions property, so it can only clear OUR own reaction and can never wipe
/// other users' reactions. The `value: 0` clear is the single part not yet proven
/// against a live tenant; the display path stays authoritative from the inbound
/// `properties.emotions` snapshot regardless, so received reactions render
/// correctly even if this exact clear shape later needs a tweak.
pub async fn set_reaction(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    message_id: &str,
    key: &str,
    on: bool,
) -> Result<()> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}/properties?name=emotions",
        urlencoding::encode(conversation_id),
        urlencoding::encode(message_id)
    );
    let value = if on { now_ms() } else { 0 };
    let body = build_reaction_body(key, value);

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
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!(
            "react -> {status}: {}",
            txt.chars().take(160).collect::<String>()
        );
    }
    Ok(())
}

/// The Teams reply blockquote that quotes the message being replied to.
fn reply_quote(reply: &ReplyTo) -> String {
    format!(
        "<blockquote itemscope itemtype=\"http://schema.skype.com/Reply\" itemid=\"{time}\"><strong itemprop=\"mri\" itemid=\"{mri}\">{sender}</strong><span itemprop=\"time\" itemid=\"{time}\"></span><p itemprop=\"preview\">{preview}</p></blockquote>",
        time = reply.compose_time,
        mri = escape_html(&reply.sender_mri),
        sender = escape_html(&reply.sender),
        preview = escape_html(&reply.preview),
    )
}

fn message_content(
    text: &str,
    reply_to: Option<&ReplyTo>,
    content_html: Option<&str>,
    image: Option<&AmsImage>,
) -> String {
    let body = if let Some(html) = content_html.filter(|h| !h.is_empty()) {
        match reply_to {
            Some(reply) => format!("{}{}", reply_quote(reply), html),
            None => html.to_string(),
        }
    } else if let Some(reply) = reply_to {
        format!(
            "{}{}{}",
            paragraph(&reply.before),
            reply_quote(reply),
            paragraph(&reply.after)
        )
    } else {
        escape_html(text)
    };

    match image {
        Some(image) => format!("{body}{}", image_markup(image)),
        None => body,
    }
}

fn image_markup(image: &AmsImage) -> String {
    let dimensions = match (image.width, image.height) {
        (Some(width), Some(height)) => format!(" width=\"{width}\" height=\"{height}\""),
        (Some(width), None) => format!(" width=\"{width}\""),
        (None, Some(height)) => format!(" height=\"{height}\""),
        (None, None) => String::new(),
    };
    format!(
        "<p><img itemtype=\"{AMS_IMAGE_TYPE}\" src=\"{}\" alt=\"{}\"{dimensions}></p>",
        escape_html_attribute(&image.src),
        escape_html_attribute(&image.name),
    )
}

fn escape_html_attribute(value: &str) -> String {
    escape_html(value)
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn paragraph(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!("<p>{}</p>", escape_html(text).replace('\n', "<br>"))
}

/// Build the request body (pure, unit-tested).
fn build_body(
    client_message_id: &str,
    text: &str,
    self_name: &str,
    reply_to: Option<&ReplyTo>,
    content_html: Option<&str>,
    image: Option<&AmsImage>,
) -> serde_json::Value {
    let mut body = json!({
        "clientmessageid": client_message_id,
        "content": message_content(text, reply_to, content_html, image),
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": self_name,
    });
    if let Some(image) = image {
        body["amsreferences"] = json!([image.id]);
    }
    body
}

/// Build the edit request body (pure, unit-tested). There is no reply markup and —
/// unlike a send — no `clientmessageid`; `content_html` wins over the escaped text.
fn build_edit_body(
    text: &str,
    content_html: Option<&str>,
    self_name: &str,
) -> serde_json::Value {
    json!({
        "content": match content_html.filter(|html| !html.is_empty()) {
            Some(html) => html.to_string(),
            None => escape_html(text),
        },
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": self_name,
    })
}

/// Current time in milliseconds since the Unix epoch — the timestamp Teams
/// records for a reaction.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Build the reaction request body (pure, unit-tested). `value` is the reaction
/// timestamp in ms when adding, or 0 to clear our reaction.
fn build_reaction_body(key: &str, value: i64) -> serde_json::Value {
    json!({ "emotions": { "key": key, "value": value } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup_characters() {
        assert_eq!(escape_html("a < b & c > d"), "a &lt; b &amp; c &gt; d");
        assert_eq!(escape_html("plain text"), "plain text");
        // accents and emoji pass through untouched
        assert_eq!(escape_html("héllo 👋"), "héllo 👋");
    }

    #[test]
    fn a_send_response_yields_the_editable_message_id() {
        // The real shape (verified live): an arrival time, and no `id` field at all.
        assert_eq!(sent_message_id(r#"{"OriginalArrivalTime":1785773946196}"#), "1785773946196");
        // An explicit id wins if Teams ever starts returning one, in either type.
        assert_eq!(sent_message_id(r#"{"id":"42","OriginalArrivalTime":1}"#), "42");
        assert_eq!(sent_message_id(r#"{"id":42}"#), "42");
        // A body with nothing usable is not an error: the message was sent.
        assert_eq!(sent_message_id("{}"), "");
        assert_eq!(sent_message_id("not json"), "");
    }

    #[test]
    fn client_message_id_is_numeric_and_nonempty() {
        let id = new_client_message_id();
        assert!(!id.is_empty());
        assert!(id.chars().all(|c| c.is_ascii_digit()));
    }

    fn image_bytes(content_type: &str) -> Vec<u8> {
        match content_type.to_ascii_lowercase().as_str() {
            "image/png" => b"\x89PNG\r\n\x1a\ncontent".to_vec(),
            "image/jpeg" => b"\xff\xd8\xffcontent".to_vec(),
            "image/gif" => b"GIF89acontent".to_vec(),
            "image/webp" => b"RIFF\x04\0\0\0WEBPcontent".to_vec(),
            "image/bmp" => b"BMcontent".to_vec(),
            "image/heic" => b"\0\0\0\x18ftypheiccontent".to_vec(),
            "image/heif" => b"\0\0\0\x18ftypmif1content".to_vec(),
            _ => vec![1],
        }
    }

    fn image_value(content_type: &str, bytes: &[u8]) -> Value {
        json!({
            "name": "screen.png",
            "content_type": content_type,
            "data_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "width": 640,
            "height": 480,
        })
    }

    #[test]
    fn parses_supported_image_and_normalizes_content_type() {
        let bytes = image_bytes("image/png");
        let value = image_value("IMAGE/PNG", &bytes);
        let image = parse_image(&value).unwrap();
        assert_eq!(image.name, "screen.png");
        assert_eq!(image.content_type, "image/png");
        assert_eq!(image.bytes, bytes);
        assert_eq!(image.width, Some(640));
        assert_eq!(image.height, Some(480));
    }

    #[test]
    fn accepts_each_supported_image_content_type() {
        for content_type in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/bmp",
            "image/heic",
            "image/heif",
        ] {
            let bytes = image_bytes(content_type);
            let value = image_value(content_type, &bytes);
            assert!(parse_image(&value).is_ok(), "{content_type}");
        }
    }

    #[test]
    fn rejects_invalid_image_shapes_and_values() {
        let cases = [
            json!({
                "name": "screen.svg",
                "content_type": "image/svg+xml",
                "data_base64": "AQ==",
            }),
            json!({
                "name": "screen.png",
                "content_type": "image/png; charset=binary",
                "data_base64": "AQ==",
            }),
            json!({
                "name": "screen.png",
                "content_type": "image/png",
                "data_base64": "not base64",
            }),
            json!({
                "name": "screen.png",
                "content_type": "image/png",
                "data_base64": "",
            }),
            json!({
                "name": "screen.png",
                "content_type": "image/png",
                "data_base64": "AQ==",
                "width": 0,
            }),
            json!({
                "name": "screen.png",
                "content_type": "image/png",
                "data_base64": "AQ==",
                "height": MAX_IMAGE_DIMENSION + 1,
            }),
            json!({
                "name": "screen.png",
                "content_type": "image/png",
                "data_base64": "AQ==",
                "unexpected": true,
            }),
            json!({
                "name": "screen.png",
                "content_type": "image/png",
                "data_base64": base64::engine::general_purpose::STANDARD.encode(b"GIF89acontent"),
            }),
        ];
        for value in cases {
            assert!(parse_image(&value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn enforces_decoded_image_size_limit() {
        let mut allowed = vec![7; MAX_IMAGE_BYTES];
        allowed[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let value = image_value("image/png", &allowed);
        assert_eq!(parse_image(&value).unwrap().bytes.len(), MAX_IMAGE_BYTES);

        let mut oversized = vec![7; MAX_IMAGE_BYTES + 1];
        oversized[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let value = image_value("image/png", &oversized);
        assert!(parse_image(&value).is_err());
    }

    #[test]
    fn builds_ams_object_request() {
        let body = build_ams_create_body("19:chat@thread.v2", "screen.png");
        assert_eq!(body["type"], "pish/image");
        assert_eq!(body["permissions"]["19:chat@thread.v2"], json!(["read"]));
        assert_eq!(body["sharingMode"], "Inline");
        assert_eq!(body["filename"], "screen.png");
    }

    #[test]
    fn image_body_preserves_rich_html_and_adds_ams_reference() {
        let image = AmsImage {
            id: "0-weu-d1-image".into(),
            src: "https://ams.example/v1/objects/0-weu-d1-image/views/imgo".into(),
            name: "a & b.png".into(),
            width: Some(640),
            height: Some(480),
        };
        let body = build_body(
            "9",
            "plain fallback",
            "Me",
            None,
            Some("<p><strong>Rich</strong> text</p>"),
            Some(&image),
        );
        assert_eq!(body["amsreferences"], json!(["0-weu-d1-image"]));
        assert_eq!(body["messagetype"], "RichText/Html");
        assert_eq!(
            body["content"],
            concat!(
                "<p><strong>Rich</strong> text</p>",
                "<p><img itemtype=\"http://schema.skype.com/AMSImage\" ",
                "src=\"https://ams.example/v1/objects/0-weu-d1-image/views/imgo\" ",
                "alt=\"a &amp; b.png\" width=\"640\" height=\"480\"></p>"
            )
        );
    }

    #[test]
    fn image_body_preserves_reply_markup_and_plain_text() {
        let reply = ReplyTo {
            compose_time: 42,
            sender: "Alice".into(),
            sender_mri: "8:alice".into(),
            preview: "quoted".into(),
            before: String::new(),
            after: "reply text".into(),
        };
        let image = AmsImage {
            id: "image-id".into(),
            src: "https://ams.example/image".into(),
            name: "screen.png".into(),
            width: None,
            height: None,
        };
        let content = message_content("reply text", Some(&reply), None, Some(&image));
        assert!(content.starts_with("<blockquote itemscope"));
        assert!(content.contains("</blockquote><p>reply text</p>"));
        assert!(content.ends_with("alt=\"screen.png\"></p>"));
    }

    #[test]
    fn prefers_ams_v2_and_falls_back_to_ams() {
        let session = |gtms: Value| Session {
            skypetoken: String::new(),
            region: String::new(),
            gtms,
            self_name: String::new(),
            self_mri: String::new(),
        };
        assert_eq!(
            ams_endpoint(&session(
                json!({ "amsV2": "https://v2/", "ams": "https://v1/" })
            ))
            .unwrap(),
            "https://v2"
        );
        assert_eq!(
            ams_endpoint(&session(json!({ "ams": "https://v1/" }))).unwrap(),
            "https://v1"
        );
        assert!(ams_endpoint(&session(json!({}))).is_err());
    }

    #[test]
    fn validates_ams_object_id_before_url_interpolation() {
        assert!(validate_ams_id("0-weu-d1_abc.def").is_ok());
        assert!(validate_ams_id("../content").is_err());
        assert!(validate_ams_id("id/other").is_err());
        assert!(validate_ams_id("").is_err());
    }

    #[test]
    fn body_has_required_fields() {
        let b = build_body("12345", "hi <there>", "Théophile WALLEZ", None, None, None);
        assert_eq!(b["clientmessageid"], "12345");
        assert_eq!(b["content"], "hi &lt;there&gt;");
        assert_eq!(b["messagetype"], "RichText/Html");
        assert_eq!(b["contenttype"], "text");
        assert_eq!(b["imdisplayname"], "Théophile WALLEZ");
    }

    #[test]
    fn rich_content_html_is_forwarded_as_content() {
        let html = "<p>hi <strong>bold</strong> <a href=\"https://x\">link</a></p>";
        let b = build_body("9", "", "Me", None, Some(html), None);
        assert_eq!(b["content"], html);
    }

    #[test]
    fn empty_rich_content_html_falls_back_to_plain() {
        let b = build_body("9", "plain", "Me", None, Some(""), None);
        assert_eq!(b["content"], "plain");
    }

    #[test]
    fn rich_reply_prepends_quote_then_html_body() {
        let reply = ReplyTo {
            compose_time: 42,
            sender: "Alice".into(),
            sender_mri: "8:alice".into(),
            preview: "quoted".into(),
            before: String::new(),
            after: String::new(),
        };
        let content = message_content("", Some(&reply), Some("<p><em>rich</em> reply</p>"), None);
        assert!(content.starts_with("<blockquote itemscope"));
        assert!(content.ends_with("</blockquote><p><em>rich</em> reply</p>"));
    }

    #[test]
    fn body_encodes_native_teams_reply_markup() {
        let reply = ReplyTo {
            compose_time: 1_784_279_090_040,
            sender: "Bob & Alice".into(),
            sender_mri: "8:orgid:abc-123".into(),
            preview: "old <message>".into(),
            before: String::new(),
            after: "new <reply>".into(),
        };

        let b = build_body("12345", "new <reply>", "Me", Some(&reply), None, None);

        assert_eq!(
            b["content"],
            concat!(
                "<blockquote itemscope itemtype=\"http://schema.skype.com/Reply\" ",
                "itemid=\"1784279090040\"><strong itemprop=\"mri\" ",
                "itemid=\"8:orgid:abc-123\">Bob &amp; Alice</strong>",
                "<span itemprop=\"time\" itemid=\"1784279090040\"></span>",
                "<p itemprop=\"preview\">old &lt;message&gt;</p></blockquote>",
                "<p>new &lt;reply&gt;</p>"
            )
        );
    }

    #[test]
    fn reply_markup_preserves_cursor_position() {
        let reply = ReplyTo {
            compose_time: 42,
            sender: "Alice".into(),
            sender_mri: "8:alice".into(),
            preview: "quoted".into(),
            before: "First line".into(),
            after: "Second line".into(),
        };

        let content = message_content("First lineSecond line", Some(&reply), None, None);

        assert!(content.starts_with("<p>First line</p><blockquote"));
        assert!(content.ends_with("</blockquote><p>Second line</p>"));
    }

    #[test]
    fn edit_body_has_no_client_message_id_and_escapes_content() {
        let b = build_edit_body("updated <text> & more", None, "Théophile WALLEZ");
        assert!(b.get("clientmessageid").is_none());
        assert_eq!(b["content"], "updated &lt;text&gt; &amp; more");
        assert_eq!(b["messagetype"], "RichText/Html");
        assert_eq!(b["contenttype"], "text");
        assert_eq!(b["imdisplayname"], "Théophile WALLEZ");
    }

    #[test]
    fn edit_body_forwards_rich_content_html_verbatim() {
        // What the streamed agent reply rides on: an edit that keeps its markup.
        let b = build_edit_body("ignored", Some("<p>an <code>answer</code></p>"), "Me");
        assert_eq!(b["content"], "<p>an <code>answer</code></p>");
        // An empty html falls back to the escaped text, like a send does.
        let b = build_edit_body("plain", Some(""), "Me");
        assert_eq!(b["content"], "plain");
    }

    #[test]
    fn reaction_body_add_carries_key_and_timestamp() {
        let b = build_reaction_body("like", 1_700_000_000_000);
        assert_eq!(b["emotions"]["key"], "like");
        assert_eq!(b["emotions"]["value"], 1_700_000_000_000i64);
    }

    #[test]
    fn reaction_body_remove_uses_zero_value() {
        // Removal is a non-destructive PUT with value 0, never a DELETE.
        let b = build_reaction_body("heart", 0);
        assert_eq!(b["emotions"]["key"], "heart");
        assert_eq!(b["emotions"]["value"], 0);
    }
}
