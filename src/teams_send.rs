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

/// Send a plain-text message to a conversation. Returns the clientmessageid used
/// (useful for optimistic echo correlation). `text` is the raw user input.
pub async fn send_message(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    text: &str,
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
    let body = build_body(&cmid, text, &session.self_name);

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

/// Build the request body (pure, unit-tested).
fn build_body(client_message_id: &str, text: &str, self_name: &str) -> serde_json::Value {
    json!({
        "clientmessageid": client_message_id,
        "content": escape_html(text),
        "messagetype": "RichText/Html",
        "contenttype": "text",
        "imdisplayname": self_name,
    })
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
        let b = build_body("12345", "hi <there>", "Théophile WALLEZ");
        assert_eq!(b["clientmessageid"], "12345");
        assert_eq!(b["content"], "hi &lt;there&gt;");
        assert_eq!(b["messagetype"], "RichText/Html");
        assert_eq!(b["contenttype"], "text");
        assert_eq!(b["imdisplayname"], "Théophile WALLEZ");
    }
}
