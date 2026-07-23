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
use serde_json::json;

use crate::teams::Session;

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

/// Send a message to a conversation. Returns the clientmessageid used (useful
/// for optimistic echo correlation).
///
/// `text` is the raw user input for a plain-text send. `content_html`, when set,
/// is the rich message body already normalized to the Teams-safe HTML subset by
/// the web client (see web/src/lib/rich-text.ts `serializeTeamsHtml`); it is
/// forwarded as the message content. The web read path renders inbound HTML
/// through an allowlist parser, so it is the XSS boundary; Teams also sanitizes
/// server-side. When both are present for a reply, the quote is prepended.
pub async fn send_message(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    text: &str,
    reply_to: Option<&ReplyTo>,
    content_html: Option<&str>,
) -> Result<String> {
    let chat = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat}/v1/users/ME/conversations/{}/messages",
        urlencoding::encode(conversation_id)
    );
    let cmid = new_client_message_id();
    let body = build_body(&cmid, text, &session.self_name, reply_to, content_html);

    let resp = http
        .post(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("send message request")?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("send -> {status}: {}", txt.chars().take(160).collect::<String>());
    }
    Ok(cmid)
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
pub async fn edit_message(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    message_id: &str,
    text: &str,
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
    let body = build_edit_body(text, &session.self_name);

    let resp = http
        .put(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("edit message request")?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("edit -> {status}: {}", txt.chars().take(160).collect::<String>());
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
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("set reaction request")?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        anyhow::bail!("react -> {status}: {}", txt.chars().take(160).collect::<String>());
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

fn message_content(text: &str, reply_to: Option<&ReplyTo>, content_html: Option<&str>) -> String {
    // Rich send: the body is pre-normalized Teams-safe HTML from the web client.
    if let Some(html) = content_html.filter(|h| !h.is_empty()) {
        return match reply_to {
            Some(reply) => format!("{}{}", reply_quote(reply), html),
            None => html.to_string(),
        };
    }

    let Some(reply) = reply_to else {
        return escape_html(text);
    };
    format!(
        "{}{}{}",
        paragraph(&reply.before),
        reply_quote(reply),
        paragraph(&reply.after)
    )
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
) -> serde_json::Value {
    json!({
        "clientmessageid": client_message_id,
        "content": message_content(text, reply_to, content_html),
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": self_name,
    })
}

/// Build the edit request body (pure, unit-tested). Edits carry plain text, so
/// there is no reply markup and — unlike a send — no `clientmessageid`.
fn build_edit_body(text: &str, self_name: &str) -> serde_json::Value {
    json!({
        "content": escape_html(text),
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
    fn client_message_id_is_numeric_and_nonempty() {
        let id = new_client_message_id();
        assert!(!id.is_empty());
        assert!(id.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn body_has_required_fields() {
        let b = build_body("12345", "hi <there>", "Théophile WALLEZ", None, None);
        assert_eq!(b["clientmessageid"], "12345");
        assert_eq!(b["content"], "hi &lt;there&gt;");
        assert_eq!(b["messagetype"], "RichText/Html");
        assert_eq!(b["contenttype"], "text");
        assert_eq!(b["imdisplayname"], "Théophile WALLEZ");
    }

    #[test]
    fn rich_content_html_is_forwarded_as_content() {
        let html = "<p>hi <strong>bold</strong> <a href=\"https://x\">link</a></p>";
        let b = build_body("9", "", "Me", None, Some(html));
        assert_eq!(b["content"], html);
    }

    #[test]
    fn empty_rich_content_html_falls_back_to_plain() {
        let b = build_body("9", "plain", "Me", None, Some(""));
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
        let content = message_content("", Some(&reply), Some("<p><em>rich</em> reply</p>"));
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

        let b = build_body("12345", "new <reply>", "Me", Some(&reply), None);

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
    fn reply_markup_preserves_cursor_position() {        let reply = ReplyTo {
            compose_time: 42,
            sender: "Alice".into(),
            sender_mri: "8:alice".into(),
            preview: "quoted".into(),
            before: "First line".into(),
            after: "Second line".into(),
        };

        let content = message_content("First lineSecond line", Some(&reply), None);

        assert!(content.starts_with("<p>First line</p><blockquote"));
        assert!(content.ends_with("</blockquote><p>Second line</p>"));
    }

    #[test]
    fn edit_body_has_no_client_message_id_and_escapes_content() {
        let b = build_edit_body("updated <text> & more", "Théophile WALLEZ");
        assert!(b.get("clientmessageid").is_none());
        assert_eq!(b["content"], "updated &lt;text&gt; &amp; more");
        assert_eq!(b["messagetype"], "RichText/Html");
        assert_eq!(b["contenttype"], "text");
        assert_eq!(b["imdisplayname"], "Théophile WALLEZ");
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
