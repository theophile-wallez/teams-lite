// Trouter event decoding: turn a raw real-time push into a store-ready Message.
//
// The trouter socket delivers requests as Socket.IO "3:::{...}" frames. The JSON
// request has { url, headers, body }. This module decodes the body — which may be
// gzipped and/or doubly-wrapped — into the EventMessage envelope and extracts new
// chat messages. Decoding pipeline (from EionRobb/purple-teams teams_trouter.c):
//
//   1. if headers["X-Microsoft-Skype-Content-Encoding"] == "gzip":
//        body = gunzip(base64_decode(body))
//   2. the body object may nest the real payload:
//        - "cp" field: base64 + gzip   -> replace body with decoded
//        - "gp" field: base64 only     -> replace body with decoded
//   3. if url ends with "/messaging" and body.type == "EventMessage":
//        resource = body.resource
//        resourceType in {NewMessage, MessageUpdate} -> a chat message
//
// This module is pure: no network, no websocket. The websocket loop calls
// `messages_from_frame` and feeds the results to the store.

use anyhow::{Context, Result};
use base64::Engine;
use serde_json::Value;
use std::io::Read;

use crate::store::Message;
use crate::teams_read;

/// Decode a Socket.IO "3:::" request payload (already stripped to the JSON object)
/// and return any chat messages it carries. Returns an empty vec for non-message
/// pushes (presence, thread updates, calls, etc.) — those are simply not our concern
/// for slice 2.
pub fn messages_from_request(request: &Value) -> Result<Vec<Message>> {
    let url = request.get("url").and_then(|u| u.as_str()).unwrap_or("");
    // Only chat traffic carries messages; skip everything else cheaply.
    if !url.ends_with("/messaging") {
        return Ok(Vec::new());
    }

    let gzipped = request
        .pointer("/headers/X-Microsoft-Skype-Content-Encoding")
        .and_then(|v| v.as_str())
        == Some("gzip");
    let raw_body = request.get("body").and_then(|b| b.as_str()).unwrap_or("");

    let body_json = decode_body(raw_body, gzipped)?;
    let payload = unwrap_nested(body_json)?;

    if payload.get("type").and_then(|t| t.as_str()) != Some("EventMessage") {
        return Ok(Vec::new());
    }
    Ok(messages_from_event(&payload))
}

/// Step 1: base64-decode + gunzip the outer body when it is gzip-encoded, then
/// parse it as JSON. When not gzipped, the body is already a JSON string.
fn decode_body(raw: &str, gzipped: bool) -> Result<Value> {
    if gzipped {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .context("base64 decode body")?;
        let text = gunzip(&bytes).context("gunzip body")?;
        serde_json::from_str(&text).context("parse gunzipped body")
    } else {
        serde_json::from_str(raw).context("parse body")
    }
}

/// Step 2: unwrap a payload nested under `cp` (base64+gzip) or `gp` (base64 only).
/// Returns the body unchanged when neither wrapper is present.
fn unwrap_nested(body: Value) -> Result<Value> {
    if let Some(cp) = body.get("cp").and_then(|c| c.as_str()) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(cp.trim()).context("base64 cp")?;
        let text = gunzip(&bytes).context("gunzip cp")?;
        return serde_json::from_str(&text).context("parse cp");
    }
    if let Some(gp) = body.get("gp").and_then(|g| g.as_str()) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(gp.trim()).context("base64 gp")?;
        let text = String::from_utf8(bytes).context("gp utf8")?;
        return serde_json::from_str(&text).context("parse gp");
    }
    Ok(body)
}

/// Step 3: pull chat messages out of an EventMessage envelope. Only NewMessage and
/// MessageUpdate carry displayable chat content; other resourceTypes are ignored.
fn messages_from_event(event: &Value) -> Vec<Message> {
    let resource_type = event.get("resourceType").and_then(|r| r.as_str()).unwrap_or("");
    if resource_type != "NewMessage" && resource_type != "MessageUpdate" {
        return Vec::new();
    }
    let Some(resource) = event.get("resource") else { return Vec::new() };

    // The message resource has the same shape the read API returns; derive the
    // conversation id from the resource itself.
    let conv_id = conversation_id_of(resource);
    if conv_id.is_empty() {
        return Vec::new();
    }
    teams_read::parse_message(resource, &conv_id).into_iter().collect()
}

/// Extract the conversation id from a message resource. The live shape uses
/// `conversationid`; some paths only carry `conversationLink` (…/conversations/{id}/…).
fn conversation_id_of(resource: &Value) -> String {
    if let Some(id) = resource.get("conversationid").and_then(|c| c.as_str()) {
        return id.to_string();
    }
    if let Some(link) = resource.get("conversationLink").and_then(|c| c.as_str()) {
        // .../v1/users/ME/conversations/{id}/messages/{msgId}
        if let Some(rest) = link.split("/conversations/").nth(1) {
            return rest.split('/').next().unwrap_or("").to_string();
        }
    }
    String::new()
}

/// gunzip raw bytes to a UTF-8 string.
fn gunzip(bytes: &[u8]) -> Result<String> {
    let mut d = flate2::read::GzDecoder::new(bytes);
    let mut s = String::new();
    d.read_to_string(&mut s).context("inflate gzip stream")?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;
    use std::io::Write;

    fn gzip_b64(s: &str) -> String {
        let mut e = GzEncoder::new(Vec::new(), Compression::default());
        e.write_all(s.as_bytes()).unwrap();
        let bytes = e.finish().unwrap();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
    }

    fn new_message_event() -> Value {
        json!({
            "type": "EventMessage",
            "resourceType": "NewMessage",
            "resource": {
                "id": "1784217926767",
                "sequenceId": 9186,
                "composetime": "2026-07-16T16:05:26.767Z",
                "content": "<p>message temps réel</p>",
                "messagetype": "RichText/Html",
                "imdisplayname": "Clément BOSLE",
                "conversationid": "19:abc@thread.v2"
            }
        })
    }

    #[test]
    fn plain_body_new_message() {
        let request = json!({
            "url": "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/.../messaging",
            "headers": {},
            "body": new_message_event().to_string()
        });
        let msgs = messages_from_request(&request).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "1784217926767");
        assert_eq!(msgs[0].seq, 9186);
        assert_eq!(msgs[0].conversation_id, "19:abc@thread.v2");
        assert_eq!(msgs[0].sender, "Clément BOSLE");
        assert_eq!(msgs[0].content, "<p>message temps réel</p>");
        assert_eq!(msgs[0].compose_time, 1784217926767);
    }

    #[test]
    fn gzipped_body() {
        let request = json!({
            "url": "https://x/messaging",
            "headers": { "X-Microsoft-Skype-Content-Encoding": "gzip" },
            "body": gzip_b64(&new_message_event().to_string())
        });
        let msgs = messages_from_request(&request).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].seq, 9186);
    }

    #[test]
    fn nested_cp_wrapper() {
        // outer body carries the real EventMessage under a gzipped+base64 "cp" field
        let outer = json!({ "cp": gzip_b64(&new_message_event().to_string()) });
        let request = json!({
            "url": "https://x/messaging",
            "headers": {},
            "body": outer.to_string()
        });
        let msgs = messages_from_request(&request).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "<p>message temps réel</p>");
    }

    #[test]
    fn nested_gp_wrapper() {
        // "gp" is base64 only (no gzip)
        let outer = json!({ "gp": b64(&new_message_event().to_string()) });
        let request = json!({
            "url": "https://x/messaging",
            "headers": {},
            "body": outer.to_string()
        });
        let msgs = messages_from_request(&request).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].seq, 9186);
    }

    #[test]
    fn conversation_link_fallback() {
        let mut ev = new_message_event();
        let res = ev.get_mut("resource").unwrap().as_object_mut().unwrap();
        res.remove("conversationid");
        res.insert(
            "conversationLink".into(),
            json!("https://x/v1/users/ME/conversations/19:link@thread.v2/messages/123"),
        );
        let request = json!({ "url": "https://x/messaging", "headers": {}, "body": ev.to_string() });
        let msgs = messages_from_request(&request).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].conversation_id, "19:link@thread.v2");
    }

    #[test]
    fn non_messaging_url_ignored() {
        let request = json!({
            "url": "https://x/unifiedPresenceService",
            "headers": {},
            "body": new_message_event().to_string()
        });
        assert!(messages_from_request(&request).unwrap().is_empty());
    }

    #[test]
    fn non_message_resource_type_ignored() {
        let ev = json!({
            "type": "EventMessage", "resourceType": "UserPresence",
            "resource": { "id": "x" }
        });
        let request = json!({ "url": "https://x/messaging", "headers": {}, "body": ev.to_string() });
        assert!(messages_from_request(&request).unwrap().is_empty());
    }

    #[test]
    fn message_update_is_captured() {
        let mut ev = new_message_event();
        ev.as_object_mut().unwrap().insert("resourceType".into(), json!("MessageUpdate"));
        let request = json!({ "url": "https://x/messaging", "headers": {}, "body": ev.to_string() });
        assert_eq!(messages_from_request(&request).unwrap().len(), 1);
    }
}
