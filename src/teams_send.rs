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

/// How many images one message may carry. A product rule rather than a protocol one:
/// Teams takes more, and this bounds what one send makes this app upload — and what a
/// mis-paste can put in front of the thread.
pub const MAX_IMAGES: usize = 10;

/// Ceiling on the images of ONE message, added up. Each is already capped at
/// [`MAX_IMAGE_BYTES`]; this bounds the whole request, which arrives as a single
/// base64 JSON frame over the local socket — so it must stay well under the WebSocket
/// read limits in src/bin/server.rs and the relay's own frame cap in web/server.ts.
pub const MAX_IMAGES_TOTAL_BYTES: usize = 30 * 1024 * 1024;
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

/// One custom emoji being sent.
///
/// The bytes are uploaded to Teams' AMS service, and the code in the message body is
/// substituted with the inline emoji markup pointing at the uploaded object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmojiArt {
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// One @mention carried by an outbound message.
///
/// A Teams mention lives in two places at once, and both are needed: the body holds an
/// otherwise inert span that carries ONLY an index —
/// `<span itemscope itemtype="http://schema.skype.com/Mention" itemid="0">John</span>`
/// — while WHO it names lives in `properties.mentions`, keyed by that same `itemid`.
/// The read path decodes exactly this pair (`parse_mentions` in src/teams_read.rs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    /// The index the body's span carries. Assigned by the composer in document order.
    pub itemid: u32,
    /// The mentioned person's MRI — what makes Teams notify them.
    pub mri: String,
    /// The text the span shows. Teams lets the author shorten it ("John De Doe" ->
    /// "John"), so it is not necessarily the person's full directory name.
    pub display_name: String,
}

/// How many people one message may mention. Far above any real message, and it bounds
/// what a client can make this app put in one request.
pub const MAX_MENTIONS: usize = 64;

/// How long a mention's display text may get. A mention shows a name, not a paragraph.
const MAX_MENTION_NAME_BYTES: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MentionParams {
    itemid: u32,
    mri: String,
    display_name: String,
}

/// Parse and validate the optional `mentions` list carried by the send RPC.
///
/// Every mention must name a person (never a thread or an app), carry visible text, and
/// be addressed by an `itemid` no other mention in the same message uses — otherwise
/// two spans in the body would resolve to one person and one of them would point at
/// nobody.
pub fn parse_mentions(value: &Value) -> Result<Vec<Mention>> {
    let list = value.as_array().context("mentions must be a list")?;
    anyhow::ensure!(list.len() <= MAX_MENTIONS, "too many mentions in one message");
    let mut out: Vec<Mention> = Vec::with_capacity(list.len());
    for entry in list {
        let params: MentionParams =
            serde_json::from_value(entry.clone()).context("invalid mention")?;
        anyhow::ensure!(
            crate::teams_profiles::is_person_mri(&params.mri),
            "a mention must name a person"
        );
        let display_name = params.display_name.trim().to_string();
        anyhow::ensure!(!display_name.is_empty(), "a mention must show a name");
        anyhow::ensure!(
            display_name.len() <= MAX_MENTION_NAME_BYTES,
            "a mention's name is too long"
        );
        anyhow::ensure!(
            !display_name.chars().any(char::is_control),
            "a mention's name contains a control character"
        );
        anyhow::ensure!(
            out.iter().all(|m| m.itemid != params.itemid),
            "two mentions share one itemid"
        );
        out.push(Mention { itemid: params.itemid, mri: params.mri, display_name });
    }
    Ok(out)
}

/// The `itemid`s the mention spans in a message body actually carry.
///
/// Used to refuse a message that would notify somebody it does not visibly name: a
/// mention in `properties` with no span in the body is an invisible ping.
pub fn mention_span_itemids(html: &str) -> Vec<u32> {
    let mut out = Vec::new();
    for span in html.split("<span").skip(1) {
        let head = match span.find('>') {
            Some(end) => &span[..end],
            None => span,
        };
        if !head.contains("schema.skype.com/Mention") {
            continue;
        }
        let Some(at) = head.find("itemid=") else { continue };
        let value: String = head[at + "itemid=".len()..]
            .trim_start_matches(['"', '\''])
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if let Ok(itemid) = value.parse::<u32>() {
            out.push(itemid);
        }
    }
    out
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

/// The pictures a `send` carries, read out of its whole params object.
///
/// It reads the params rather than one field so it can refuse the SINGLE-`image` shape a
/// page from before this feature sends. That page exists in practice: a backend restart
/// swaps the bundle while an open tab keeps its old JavaScript (see AGENTS.md
/// § Automation safety), and `images` being absent would otherwise mean "no pictures" —
/// so the caption would go out alone, answered `sent: true`, with the screenshot the user
/// staged dropped and nothing anywhere saying so.
pub fn parse_send_images(params: &Value) -> Result<Vec<ImageUpload>> {
    anyhow::ensure!(
        params.get("image").is_none_or(Value::is_null),
        "this page is too old to send pictures — reload it and try again"
    );
    match params.get("images") {
        Some(value) => parse_images(value),
        None => Ok(Vec::new()),
    }
}

/// Parse and validate the `images` list itself.
///
/// A message carries as many pictures as the user pasted, in the order they picked them.
/// Both ceilings are enforced here — the composer states them too, but a client is what a
/// mis-paste happens in and the bytes are what this machine then uploads.
pub fn parse_images(value: &Value) -> Result<Vec<ImageUpload>> {
    let list = value.as_array().context("images must be a list")?;
    anyhow::ensure!(
        list.len() <= MAX_IMAGES,
        "a message carries at most {MAX_IMAGES} images"
    );
    let mut out: Vec<ImageUpload> = Vec::with_capacity(list.len());
    let mut total = 0usize;
    for entry in list {
        let image = parse_image(entry)?;
        total += image.bytes.len();
        anyhow::ensure!(
            total <= MAX_IMAGES_TOTAL_BYTES,
            "those images add up to more than {} MiB",
            MAX_IMAGES_TOTAL_BYTES / (1024 * 1024)
        );
        out.push(image);
    }
    Ok(out)
}

/// Parse and validate one image object out of that list. Decoding happens after a
/// conservative encoded-length check, so an oversized client value cannot allocate an
/// unbounded decoded buffer.
fn parse_image(value: &Value) -> Result<ImageUpload> {
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
    images: &[ImageUpload],
    emoji_ids: &[String],
    mentions: &[Mention],
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
    // In the order the user picked them, one upload at a time: the message body names
    // them in that order, and a failure here happens before the message POST — so
    // nothing is posted and what did upload is an unreferenced AMS blob.
    //
    // Which picture failed travels with the error. With ten of them, "the send failed" on
    // its own leaves the reader removing pictures at random to find the one the tenant
    // refused.
    let mut ams_images = Vec::with_capacity(images.len());
    for (index, image) in images.iter().enumerate() {
        ams_images.push(
            upload_image(http, session, ic3, conversation_id, image)
                .await
                .with_context(|| {
                    format!("image {} of {} ({})", index + 1, images.len(), image.name)
                })?,
        );
    }
    let body = build_body(
        &cmid,
        text,
        &session.self_name,
        reply_to,
        content_html,
        &ams_images,
        emoji_ids,
        mentions,
    )?;

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

/// Upload one object to Teams' AMS service: the two-request dance every emoji and every
/// attachment photo uses. Returns the object id.
pub async fn upload_ams_object(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    conversation_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<String> {
    anyhow::ensure!(!ic3.is_empty(), "missing IC3 token");
    let ams = ams_endpoint(session)?;
    let create_url = format!("{ams}/v1/objects/");
    let create_body = build_ams_create_body(conversation_id, name);
    let response = http
        .post(&create_url)
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", AMS_CLIENT_VERSION)
        .json(&create_body)
        .send()
        .await
        .context("create AMS object")?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "create AMS object -> {status}: {}",
            text.chars().take(160).collect::<String>()
        );
    }
    let response: Value = response.json().await.context("parse AMS object")?;
    let id = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .context("AMS object response had no id")?;
    validate_ams_id(id)?;

    let upload_url = format!("{ams}/v1/objects/{id}/content/imgpsh");
    let response = http
        .put(&upload_url)
        .bearer_auth(ic3)
        .header("x-ms-migration", "True")
        .header("x-ms-client-version", AMS_CLIENT_VERSION)
        .header("content-type", "application/octet-stream")
        .body(bytes.to_vec())
        .send()
        .await
        .context("upload AMS content")?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "upload AMS content -> {status}: {}",
            text.chars().take(160).collect::<String>()
        );
    }

    Ok(id.to_string())
}

/// Upload one object and return the URL its bytes are served from — the `views/imgo`
/// view an inline emoji's `src` and a custom reaction's key both point at.
pub async fn upload_ams_object_url(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    conversation_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<String> {
    let id = upload_ams_object(http, session, ic3, conversation_id, name, bytes).await?;
    Ok(ams_object_url(ams_endpoint(session)?, &id))
}

/// The one spelling of an AMS object's view URL, so an emoji's `src`, an image
/// attachment's and a custom reaction key can never disagree about it.
fn ams_object_url(ams: &str, id: &str) -> String {
    format!("{ams}/v1/objects/{}/views/imgo", urlencoding::encode(id))
}

async fn upload_image(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    conversation_id: &str,
    image: &ImageUpload,
) -> Result<AmsImage> {
    let id = upload_ams_object(http, session, ic3, conversation_id, &image.name, &image.bytes).await?;
    let src = ams_object_url(ams_endpoint(session)?, &id);
    Ok(AmsImage {
        id,
        src,
        name: image.name.clone(),
        width: image.width,
        height: image.height,
    })
}

/// Resolve custom emoji codes in an outbound message: upload each distinct emoji's art
/// to Teams' AMS, then substitute the `:code:` with the inline emoji markup pointing at
/// the uploaded object. Returns the rewritten HTML and the AMS object ids for
/// `amsreferences`.
///
/// The upload is injected rather than called here, so the loop below — the dedupe, the
/// order the ids come out in, and the substitution that follows — is the one the tests
/// drive too. A second copy of it written inside a test would stay green after the
/// shipped one lost its dedupe.
pub async fn resolve_custom_emoji(
    http: &reqwest::Client,
    session: &Session,
    ic3: &str,
    conversation_id: &str,
    html: &str,
    art: &[EmojiArt],
) -> Result<(String, Vec<String>)> {
    rewrite_custom_emoji(ams_endpoint(session)?, html, art, |name, bytes| async move {
        upload_ams_object(http, session, ic3, conversation_id, &name, &bytes).await
    })
    .await
}

/// Substitute every code in `html` with the markup for the object its art was uploaded
/// to, uploading each distinct code exactly once. `upload` takes the emoji's name and
/// bytes and answers with the AMS object id.
async fn rewrite_custom_emoji<F, Fut>(
    ams: &str,
    html: &str,
    art: &[EmojiArt],
    upload: F,
) -> Result<(String, Vec<String>)>
where
    F: Fn(String, Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    let codes = crate::custom_emoji::codes_in_body(html);
    let mut uploaded: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut ids = Vec::new();

    for code in codes {
        if uploaded.contains_key(&code) {
            continue;
        }
        if let Some(emoji) = art.iter().find(|e| e.name == code) {
            let id = upload(emoji.name.clone(), emoji.bytes.clone()).await?;
            uploaded.insert(code, ams_object_url(ams, &id));
            ids.push(id);
        }
    }

    let rewritten = crate::custom_emoji::substitute_codes(html, &|name| uploaded.get(name).cloned());
    Ok((rewritten, ids))
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
///
/// `mentions` is the same pair a send carries, and an edit needs it for the same reason:
/// an agent's answer is a message whose body only exists after the edit, so a mention it
/// writes can be attached nowhere else (see `agent_run_to_completion` in
/// src/bin/server.rs). The rule that refuses a mention with no span in the body holds
/// here too.
pub async fn edit_message(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    message_id: &str,
    text: &str,
    content_html: Option<&str>,
    mentions: &[Mention],
) -> Result<()> {
    let url = message_url(session, conversation_id, message_id)?;
    let body = build_edit_body(text, content_html, &session.self_name, mentions)?;

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

/// Delete one of OUR OWN messages. Teams keeps the message row and marks it as
/// deleted, which is why the read path recognizes a deletion by
/// `properties.deletetime` rather than by a message that vanished (see
/// [`crate::teams_read::parse_message`]).
///
/// Shape — the message resource, addressed with the verb that removes it:
///   DELETE {chatService}/v1/users/ME/conversations/{convId}/messages/{messageId}
///   Header: Authentication: skypetoken=...
///
/// There is no body: the id identifies the message being removed. The server echoes
/// a `MessageUpdate` over the trouter carrying the same id, an empty content and a
/// `deletetime`, so every client — ours included — converges on the placeholder.
///
/// IRREVERSIBLE, and outward: the message disappears for everybody in the thread,
/// on every device. Teams is the authority on who may delete what; this app offers
/// it on the user's own messages only (see the `delete` RPC in src/bin/server.rs).
pub async fn delete_message(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    message_id: &str,
) -> Result<()> {
    let url = message_url(session, conversation_id, message_id)?;

    let resp = http
        .delete(&url)
        .header(
            "authentication",
            format!("skypetoken={}", session.skypetoken),
        )
        .send()
        .await
        .context("delete message request")?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!(
            "delete -> {status}: {}",
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
    let url = format!(
        "{}/properties?name=emotions",
        message_url(session, conversation_id, message_id)?
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

/// The empty blocks an editor leaves at the edge of a body: the paragraph a
/// trailing Enter opened, and the hard break a trailing Shift+Enter added. The
/// tokens are lowercase, as every client of this crate emits them (the web
/// serializer in `web/src/lib/rich-text.ts`, and `agent_markdown`).
const EMPTY_EDGE_BLOCKS: [&str; 6] = [
    "<p></p>",
    "<p><br></p>",
    "<p>&nbsp;</p>",
    "<br>",
    "<br/>",
    "<br />",
];

/// Trim an outbound HTML body: drop the whitespace and the empty blocks at both
/// edges. A leading or a trailing blank line carries nothing, and Teams keeps it
/// for as long as the message exists.
///
/// This is the last net, and it is deliberately coarse: it reads no structure, so
/// it only removes what sits at an edge of the string. A client that knows the
/// tree — the web serializer — also trims the edge *inside* the first and the last
/// block. Both are needed: a body reaches this function from the local agent and
/// from an example too, not only from the web app.
pub fn trim_message_html(html: &str) -> &str {
    let mut trimmed = html.trim();
    loop {
        let before = trimmed;
        for token in EMPTY_EDGE_BLOCKS {
            trimmed = trimmed.strip_prefix(token).unwrap_or(trimmed).trim_start();
            trimmed = trimmed.strip_suffix(token).unwrap_or(trimmed).trim_end();
        }
        if trimmed == before {
            return trimmed;
        }
    }
}

fn message_content(
    text: &str,
    reply_to: Option<&ReplyTo>,
    content_html: Option<&str>,
    images: &[AmsImage],
) -> String {
    let text = text.trim();
    let content_html = content_html.map(trim_message_html);
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

    body + &images.iter().map(image_markup).collect::<String>()
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
    // The two paragraphs around a reply quote are trimmed one by one: each is its
    // own block, so a blank at its edge is a blank line next to the quote.
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    format!("<p>{}</p>", escape_html(text).replace('\n', "<br>"))
}

/// The chatService URL of ONE message resource — what an edit, a reaction and a
/// deletion all address. One place, so the conversation and the message id are
/// percent-encoded the same way in all three (a channel id carries `:` and `@`, a
/// thread reply id carries `;`).
fn message_url(session: &Session, conversation_id: &str, message_id: &str) -> Result<String> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    Ok(format!(
        "{chat}/v1/users/ME/conversations/{}/messages/{}",
        urlencoding::encode(conversation_id),
        urlencoding::encode(message_id)
    ))
}

/// Build the request body (pure, unit-tested).
///
/// A mention is refused when the body carries no span for it: `properties.mentions` is
/// what notifies the person, so a mention with nothing to show would ping somebody the
/// message never names. The `properties.mentions` value is a JSON-encoded STRING, which
/// is the shape the read path receives back from Teams (`parse_mentions` in
/// src/teams_read.rs) and the shape a self-mention was verified with against the tenant
/// (examples/mention_send_probe.rs).
fn build_body(
    client_message_id: &str,
    text: &str,
    self_name: &str,
    reply_to: Option<&ReplyTo>,
    content_html: Option<&str>,
    images: &[AmsImage],
    emoji_ids: &[String],
    mentions: &[Mention],
) -> Result<serde_json::Value> {
    let content = message_content(text, reply_to, content_html, images);
    let mut body = json!({
        "clientmessageid": client_message_id,
        "content": content,
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": self_name,
    });
    // One list for both kinds of AMS object the body can name: the emoji art the
    // codes were substituted with, then the images the user attached. Teams reads it
    // as a set of references, so the order is only this app's own — emoji first,
    // because a `:code:` sits inside the sentence the images follow.
    let mut ams_refs = emoji_ids.to_vec();
    ams_refs.extend(images.iter().map(|image| image.id.clone()));
    if !ams_refs.is_empty() {
        body["amsreferences"] = json!(ams_refs);
    }
    attach_mentions(&mut body, &content, mentions)?;
    Ok(body)
}

/// Write `properties.mentions` onto a message body, refusing a mention the body does not
/// visibly name.
///
/// One function for both verbs: a send and an edit write the same message content, so a
/// mention must mean the same thing on each and a rail that held on only one of them
/// would be a rail an edit walks around.
fn attach_mentions(body: &mut Value, content: &str, mentions: &[Mention]) -> Result<()> {
    if mentions.is_empty() {
        return Ok(());
    }
    let in_body = mention_span_itemids(content);
    for mention in mentions {
        anyhow::ensure!(
            in_body.contains(&mention.itemid),
            "a mention has no span in the message body"
        );
    }
    let list: Vec<Value> = mentions
        .iter()
        .map(|mention| {
            json!({
                "@type": "http://schema.skype.com/Mention",
                "itemid": mention.itemid,
                "mri": mention.mri,
                "mentionType": "person",
                "displayName": mention.display_name,
            })
        })
        .collect();
    body["properties"] = json!({ "mentions": Value::Array(list).to_string() });
    Ok(())
}

/// Build the edit request body (pure, unit-tested). There is no reply markup and —
/// unlike a send — no `clientmessageid`; `content_html` wins over the escaped text.
/// The body is trimmed exactly as a send is: an edit writes the same message
/// content, so it must not be the way a blank edge gets in.
fn build_edit_body(
    text: &str,
    content_html: Option<&str>,
    self_name: &str,
    mentions: &[Mention],
) -> Result<serde_json::Value> {
    let content = match content_html.map(trim_message_html).filter(|html| !html.is_empty()) {
        Some(html) => html.to_string(),
        None => escape_html(text.trim()),
    };
    let mut body = json!({
        "content": content,
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": self_name,
    });
    attach_mentions(&mut body, &content, mentions)?;
    Ok(body)
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
            std::slice::from_ref(&image),
            &[],
            &[],
        )
        .unwrap();
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

    // A message carries as many pictures as the user pasted: one `<img>` per image, in
    // the order they were picked, and every AMS id in `amsreferences` — the field was
    // already an array, so nothing about the Teams shape is invented here.
    #[test]
    fn several_images_each_get_their_markup_and_their_ams_reference() {
        let image = |n: u32| AmsImage {
            id: format!("id-{n}"),
            src: format!("https://ams.example/{n}"),
            name: format!("shot-{n}.png"),
            width: None,
            height: None,
        };
        let images = [image(1), image(2), image(3)];
        let body = build_body("9", "", "Me", None, Some("<p>three shots</p>"), &images, &[], &[]).unwrap();
        assert_eq!(body["amsreferences"], json!(["id-1", "id-2", "id-3"]));
        let content = body["content"].as_str().unwrap();
        assert!(content.starts_with("<p>three shots</p>"));
        assert_eq!(content.matches("<img itemtype=").count(), 3);
        let order: Vec<usize> = ["shot-1.png", "shot-2.png", "shot-3.png"]
            .iter()
            .map(|name| content.find(name).unwrap())
            .collect();
        assert!(order[0] < order[1] && order[1] < order[2], "kept in order");
    }

    #[test]
    fn parses_an_image_list_and_refuses_more_than_the_ceiling() {
        let bytes = image_bytes("image/png");
        let one = image_value("image/png", &bytes);
        let list = |count: usize| Value::Array(vec![one.clone(); count]);

        assert!(parse_images(&json!([])).unwrap().is_empty());
        assert_eq!(parse_images(&list(MAX_IMAGES)).unwrap().len(), MAX_IMAGES);
        assert!(parse_images(&list(MAX_IMAGES + 1)).is_err());
        // A list is a list: the single object the RPC used to take is not one.
        assert!(parse_images(&one).is_err());
        // One bad entry refuses the whole message rather than silently dropping a
        // picture the user watched themselves add.
        assert!(parse_images(&json!([one.clone(), { "name": "x.svg", "content_type": "image/svg+xml", "data_base64": "AQ==" }])).is_err());
    }

    // A page from before this feature sends `image`, not `images`. Reading `images` alone
    // would call that "no pictures" and post the caption by itself — answered `sent: true`,
    // with the screenshot dropped and nothing anywhere saying so. An open tab keeps its old
    // JavaScript across a backend restart, so that page is a real one.
    #[test]
    fn an_older_pages_single_image_is_refused_rather_than_dropped() {
        let bytes = image_bytes("image/png");
        let one = image_value("image/png", &bytes);

        let refused = parse_send_images(&json!({ "text": "look", "image": one.clone() }));
        let message = refused.unwrap_err().to_string();
        assert!(message.contains("reload"), "says what to do: {message}");

        // The shapes that are not that page: the list, an explicit null, and no key at all.
        assert_eq!(parse_send_images(&json!({ "images": [one] })).unwrap().len(), 1);
        assert!(parse_send_images(&json!({ "image": Value::Null })).unwrap().is_empty());
        assert!(parse_send_images(&json!({ "text": "hi" })).unwrap().is_empty());
    }

    #[test]
    fn refuses_images_that_add_up_past_the_total_ceiling() {
        // Each one is inside MAX_IMAGE_BYTES; enough of them are not, and a request this
        // app cannot hold has to be refused with a sentence rather than by the socket.
        let each = MAX_IMAGES_TOTAL_BYTES / 4 + 1;
        assert!(each <= MAX_IMAGE_BYTES, "each is a legal image on its own");
        let mut bytes = vec![7; each];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let value = image_value("image/png", &bytes);
        let list = |count: usize| Value::Array(vec![value.clone(); count]);
        assert_eq!(parse_images(&list(3)).unwrap().len(), 3);
        assert!(parse_images(&list(4)).is_err());
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
        let content = message_content("reply text", Some(&reply), None, std::slice::from_ref(&image));
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

    // One message resource, three verbs: an edit PUTs it, a deletion DELETEs it and a
    // reaction PUTs a property under it. So the ids must be encoded here, once — a
    // channel id carries `:` and `@`, and a thread reply id carries `;`.
    #[test]
    fn a_message_url_encodes_the_conversation_and_the_message_id() {
        let session = Session {
            skypetoken: String::new(),
            region: String::new(),
            gtms: json!({ "chatService": "https://chat.example/" }),
            self_name: String::new(),
            self_mri: String::new(),
        };
        assert_eq!(
            message_url(&session, "19:abc@thread.v2", "1785773946196").unwrap(),
            "https://chat.example/v1/users/ME/conversations/19%3Aabc%40thread.v2/messages/1785773946196"
        );
        assert_eq!(
            message_url(&session, "19:abc@thread.v2", "1;messageid=2").unwrap(),
            "https://chat.example/v1/users/ME/conversations/19%3Aabc%40thread.v2/messages/1%3Bmessageid%3D2"
        );
        // No chatService endpoint: fail before any request is built.
        let blind = Session {
            skypetoken: String::new(),
            region: String::new(),
            gtms: json!({}),
            self_name: String::new(),
            self_mri: String::new(),
        };
        assert!(message_url(&blind, "19:abc@thread.v2", "1").is_err());
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
        let b = build_body("12345", "hi <there>", "Théophile WALLEZ", None, None, &[], &[], &[]).unwrap();
        assert_eq!(b["clientmessageid"], "12345");
        assert_eq!(b["content"], "hi &lt;there&gt;");
        assert_eq!(b["messagetype"], "RichText/Html");
        assert_eq!(b["contenttype"], "text");
        assert_eq!(b["imdisplayname"], "Théophile WALLEZ");
    }

    #[test]
    fn rich_content_html_is_forwarded_as_content() {
        let html = "<p>hi <strong>bold</strong> <a href=\"https://x\">link</a></p>";
        let b = build_body("9", "", "Me", None, Some(html), &[], &[], &[]).unwrap();
        assert_eq!(b["content"], html);
    }

    #[test]
    fn empty_rich_content_html_falls_back_to_plain() {
        let b = build_body("9", "plain", "Me", None, Some(""), &[], &[], &[]).unwrap();
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
        let content = message_content("", Some(&reply), Some("<p><em>rich</em> reply</p>"), &[]);
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

        let b = build_body("12345", "new <reply>", "Me", Some(&reply), None, &[], &[], &[]).unwrap();

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

        let content = message_content("First lineSecond line", Some(&reply), None, &[]);

        assert!(content.starts_with("<p>First line</p><blockquote"));
        assert!(content.ends_with("</blockquote><p>Second line</p>"));
    }

    #[test]
    fn edit_body_has_no_client_message_id_and_escapes_content() {
        let b = build_edit_body("updated <text> & more", None, "Théophile WALLEZ", &[]).unwrap();
        assert!(b.get("clientmessageid").is_none());
        assert_eq!(b["content"], "updated &lt;text&gt; &amp; more");
        assert_eq!(b["messagetype"], "RichText/Html");
        assert_eq!(b["contenttype"], "text");
        assert_eq!(b["imdisplayname"], "Théophile WALLEZ");
    }

    #[test]
    fn edit_body_forwards_rich_content_html_verbatim() {
        // What the streamed agent reply rides on: an edit that keeps its markup.
        let b = build_edit_body("ignored", Some("<p>an <code>answer</code></p>"), "Me", &[]).unwrap();
        assert_eq!(b["content"], "<p>an <code>answer</code></p>");
        // An empty html falls back to the escaped text, like a send does.
        let b = build_edit_body("plain", Some(""), "Me", &[]).unwrap();
        assert_eq!(b["content"], "plain");
    }

    #[test]
    fn plain_text_is_trimmed_before_it_goes_out() {
        let b = build_body("1", "  hi there\n\n", "Me", None, None, &[], &[], &[]).unwrap();
        assert_eq!(b["content"], "hi there");
        // A body of whitespace only becomes empty rather than a blank message.
        let b = build_body("1", " \n\t ", "Me", None, None, &[], &[], &[]).unwrap();
        assert_eq!(b["content"], "");
        // An edit trims the same way.
        let b = build_edit_body("\n updated \n", None, "Me", &[]).unwrap();
        assert_eq!(b["content"], "updated");
    }

    #[test]
    fn html_body_loses_its_whitespace_and_empty_edge_blocks() {
        // The paragraph a trailing Enter opened, and the break a Shift+Enter added.
        assert_eq!(trim_message_html("<p>hi</p><p></p>"), "<p>hi</p>");
        assert_eq!(
            trim_message_html("<p>hi</p><p><br></p><p>&nbsp;</p>"),
            "<p>hi</p>"
        );
        assert_eq!(trim_message_html("<p></p>\n<p>hi</p>\n<br />"), "<p>hi</p>");
        assert_eq!(trim_message_html("  <p>hi</p>  "), "<p>hi</p>");
        // An empty block inside the body is content: only an edge is trimmed.
        assert_eq!(
            trim_message_html("<p>a</p><p></p><p>b</p>"),
            "<p>a</p><p></p><p>b</p>"
        );
        // Nothing left but spacers means nothing to send.
        assert_eq!(trim_message_html("<p></p><br>"), "");
    }

    #[test]
    fn html_body_is_trimmed_on_send_and_on_edit() {
        let b = build_body("9", "", "Me", None, Some("<p>hi</p><p><br></p>"), &[], &[], &[]).unwrap();
        assert_eq!(b["content"], "<p>hi</p>");
        let b = build_edit_body("", Some(" <p>answer</p><p></p>"), "Me", &[]).unwrap();
        assert_eq!(b["content"], "<p>answer</p>");
        // An html body of spacers only falls back to the plain text, as an empty
        // one already did.
        let b = build_body("9", "plain", "Me", None, Some("<p><br></p>"), &[], &[], &[]).unwrap();
        assert_eq!(b["content"], "plain");
    }

    #[test]
    fn reply_paragraphs_are_trimmed_one_by_one() {
        let reply = ReplyTo {
            compose_time: 42,
            sender: "Alice".into(),
            sender_mri: "8:alice".into(),
            preview: "quoted".into(),
            before: "  before \n".into(),
            after: "\n after  ".into(),
        };
        let content = message_content("", Some(&reply), None, &[]);
        assert!(content.starts_with("<p>before</p><blockquote"));
        assert!(content.ends_with("</blockquote><p>after</p>"));
    }

    // ---- @mentions ---------------------------------------------------------

    fn mention_html(itemid: u32, name: &str) -> String {
        format!(
            "<p><span itemscope=\"\" itemtype=\"http://schema.skype.com/Mention\" \
             itemid=\"{itemid}\">{name}</span> hello</p>"
        )
    }

    #[test]
    fn a_mention_travels_as_a_span_index_and_a_properties_entry() {
        let mentions = vec![Mention {
            itemid: 0,
            mri: "8:orgid:abc-123".into(),
            display_name: "John".into(),
        }];
        let html = mention_html(0, "John");
        let body = build_body("9", "", "Me", None, Some(&html), &[], &[], &mentions).unwrap();
        assert_eq!(body["content"], html, "the span stays in the body verbatim");
        // `properties.mentions` is a JSON-encoded STRING — the shape the read path
        // decodes and the shape the tenant accepted.
        let raw = body["properties"]["mentions"].as_str().expect("a JSON string");
        let parsed: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(
            parsed,
            json!([{
                "@type": "http://schema.skype.com/Mention",
                "itemid": 0,
                "mri": "8:orgid:abc-123",
                "mentionType": "person",
                "displayName": "John",
            }])
        );
    }

    #[test]
    fn a_message_with_no_mention_carries_no_properties() {
        let body = build_body("9", "hi", "Me", None, None, &[], &[], &[]).unwrap();
        assert!(body.get("properties").is_none());
    }

    #[test]
    fn a_mention_the_body_never_shows_is_refused() {
        // An invisible ping: `properties` would notify the person, but the reader sees
        // no mention at all.
        let mentions = vec![Mention {
            itemid: 1,
            mri: "8:orgid:abc".into(),
            display_name: "John".into(),
        }];
        let html = mention_html(0, "John");
        assert!(build_body("9", "", "Me", None, Some(&html), &[], &[], &mentions).is_err());
        assert!(build_body("9", "plain text", "Me", None, None, &[], &[], &mentions).is_err());
    }

    #[test]
    fn an_edit_carries_its_mentions_exactly_as_a_send_does() {
        // The agent's answer needs this: the body only exists after the edit, so a
        // mention it writes can travel nowhere else.
        let mentions = vec![Mention {
            itemid: 0,
            mri: "8:orgid:abc-123".into(),
            display_name: "John".into(),
        }];
        let html = mention_html(0, "John");
        let sent = build_body("9", "", "Me", None, Some(&html), &[], &[], &mentions).unwrap();
        let edited = build_edit_body("", Some(&html), "Me", &mentions).unwrap();
        assert_eq!(edited["properties"], sent["properties"]);
        assert_eq!(edited["content"], html);
        // And the same rail holds: an edit cannot notify somebody its body never names.
        let invisible = vec![Mention { itemid: 7, ..mentions[0].clone() }];
        assert!(build_edit_body("", Some(&html), "Me", &invisible).is_err());
        // An edit with no mention carries no `properties`, as before.
        assert!(build_edit_body("hi", None, "Me", &[]).unwrap().get("properties").is_none());
    }

    #[test]
    fn reads_the_itemids_of_the_mention_spans_in_a_body() {
        let html = format!("{}{}", mention_html(0, "John"), mention_html(3, "Ada"));
        assert_eq!(mention_span_itemids(&html), vec![0, 3]);
        // A span that is not a mention, and a mention without an index, name nobody.
        assert!(mention_span_itemids("<p><span class=\"x\" itemid=\"2\">t</span></p>").is_empty());
        assert!(
            mention_span_itemids(
                "<span itemtype=\"http://schema.skype.com/Mention\">John</span>"
            )
            .is_empty()
        );
    }

    #[test]
    fn parses_a_mention_list_from_the_wire() {
        let value = json!([
            { "itemid": 0, "mri": "8:orgid:abc", "display_name": "  John  " },
            { "itemid": 1, "mri": "8:orgid:def", "display_name": "Ada Lovelace" }
        ]);
        let mentions = parse_mentions(&value).unwrap();
        assert_eq!(mentions.len(), 2);
        assert_eq!(mentions[0].display_name, "John", "the name is trimmed");
        assert_eq!(mentions[1].mri, "8:orgid:def");
    }

    #[test]
    fn refuses_a_mention_that_names_nobody_or_repeats_an_itemid() {
        let cases = [
            // A thread, an app: neither is a person a mention may notify.
            json!([{ "itemid": 0, "mri": "19:abc@thread.v2", "display_name": "General" }]),
            json!([{ "itemid": 0, "mri": "28:app-guid", "display_name": "A bot" }]),
            // Nothing to show.
            json!([{ "itemid": 0, "mri": "8:orgid:abc", "display_name": "   " }]),
            // A name that is a paragraph, and one carrying a control character.
            json!([{ "itemid": 0, "mri": "8:orgid:abc", "display_name": "x".repeat(MAX_MENTION_NAME_BYTES + 1) }]),
            json!([{ "itemid": 0, "mri": "8:orgid:abc", "display_name": "Jo\u{0}hn" }]),
            // Two spans resolving to one person, so one of them points at nobody.
            json!([
                { "itemid": 0, "mri": "8:orgid:abc", "display_name": "John" },
                { "itemid": 0, "mri": "8:orgid:def", "display_name": "Ada" }
            ]),
            // Shapes that are not a mention list at all.
            json!({ "itemid": 0 }),
            json!([{ "itemid": 0, "mri": "8:orgid:abc", "display_name": "John", "extra": 1 }]),
            json!([{ "mri": "8:orgid:abc", "display_name": "John" }]),
        ];
        for value in cases {
            assert!(parse_mentions(&value).is_err(), "accepted {value}");
        }
        // The cap bounds one message.
        let many: Vec<Value> = (0..=MAX_MENTIONS as u32)
            .map(|i| json!({ "itemid": i, "mri": "8:orgid:abc", "display_name": "John" }))
            .collect();
        assert!(parse_mentions(&Value::Array(many)).is_err());
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

    // ---- custom emoji ------------------------------------------------------

    fn art_of(name: &str) -> EmojiArt {
        EmojiArt {
            name: name.to_string(),
            content_type: "image/png".to_string(),
            bytes: vec![1, 2, 3],
        }
    }

    /// Drive the SHIPPED loop with a stub upload, and report every name it asked for.
    /// The whole point is that no test re-implements `rewrite_custom_emoji`: a copy would
    /// keep passing after the real one lost its `contains_key` guard and uploaded the
    /// same art twice.
    async fn rewrite_with_stub_upload(
        html: &str,
        art: &[EmojiArt],
    ) -> (String, Vec<String>, Vec<String>) {
        let asked = std::cell::RefCell::new(Vec::new());
        let (html, ids) = rewrite_custom_emoji("https://ams.example", html, art, |name, _bytes| {
            asked.borrow_mut().push(name.clone());
            async move { Ok(format!("0-{name}")) }
        })
        .await
        .expect("the stub upload never fails");
        (html, ids, asked.into_inner())
    }

    fn build_body_for_test_with_refs(refs: &[String]) -> Value {
        build_body("1", "", "Me", None, None, &[], refs, &[]).unwrap()
    }

    #[tokio::test]
    async fn a_body_with_no_code_is_untouched_and_references_nothing() {
        let (html, refs, uploads) = rewrite_with_stub_upload("<p>hello</p>", &[]).await;
        assert_eq!(html, "<p>hello</p>");
        assert!(refs.is_empty());
        assert!(uploads.is_empty(), "nothing to upload, so nothing was uploaded");
    }

    #[tokio::test]
    async fn each_distinct_code_uploads_once_and_lands_in_amsreferences() {
        let art = [art_of("shipit"), art_of("party")];
        let (html, refs, uploads) =
            rewrite_with_stub_upload("<p>:shipit: :party: :shipit:</p>", &art).await;
        assert_eq!(uploads, vec!["shipit", "party"], "twice in one body is ONE upload");
        assert_eq!(refs.len(), 2, "twice in one body is one object");
        assert_eq!(html.matches("itemid=\"shipit\"").count(), 2, "both occurrences are drawn");
    }

    #[tokio::test]
    async fn the_body_carries_every_reference_it_names() {
        let art = [art_of("shipit")];
        let (html, refs, _) = rewrite_with_stub_upload("<p>:shipit:</p>", &art).await;
        for id in &refs {
            assert!(html.contains(id.as_str()), "an amsreference no body names is a leak");
        }
    }

    #[test]
    fn build_body_takes_many_amsreferences() {
        let body = build_body_for_test_with_refs(&["0-a".into(), "0-b".into()]);
        assert_eq!(body["amsreferences"], json!(["0-a", "0-b"]));
    }
}
