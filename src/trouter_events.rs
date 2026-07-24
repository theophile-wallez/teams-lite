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
// Pushes on a calling worker URL (…/NGCallManagerWin, …/SkypeSpacesWeb) are decoded
// separately into raw `CallFrame`s — the native calling wire schema is proprietary,
// so we forward the whole envelope rather than a typed shape (experimental).
//
// This module is pure: no network, no websocket. The websocket loop calls
// `messages_from_frame` and feeds the results to the store.

use anyhow::{Context, Result};
use base64::Engine;
use serde_json::Value;
use std::io::Read;

use crate::store::Message;
use crate::teams_read;
use crate::teams_readstate;

/// A live typing/presence signal for one conversation. `is_typing` is true for a
/// `Control/Typing` frame (started) and false for `Control/ClearTyping` (stopped).
/// Ephemeral — never persisted: the server resolves `sender_mri` to a display
/// name and forwards it to the UIs, which show a transient "… is typing" hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypingEvent {
    pub conversation_id: String,
    pub sender_mri: String,
    pub is_typing: bool,
}

/// A raw native-CALLING frame (call invite / state / hangup), decoded from a
/// trouter push on a calling worker URL (…/NGCallManagerWin or …/SkypeSpacesWeb).
///
/// The native call wire schema is proprietary and only partially known, so this
/// deliberately carries the FULL decoded envelope (`body`, with any nested `cp`/`gp`
/// payload expanded under `_decoded`) rather than a tight typed shape. The server
/// logs it (behind TEAMS_LITE_CALL_DEBUG) and forwards it to the UI, so a live call
/// pins down the exact schema. Experimental: only produced when calling is enabled
/// (the calling trouter registrations are opt-in — see `trouter::register`).
#[derive(Debug, Clone, PartialEq)]
pub struct CallFrame {
    /// The trouter request URL the frame arrived on (identifies the calling worker).
    pub url: String,
    /// Best-effort call id, for correlating an invite with its later state frames.
    pub call_id: String,
    /// The fully-decoded envelope, for logging + forwarding while the schema is
    /// still being reverse-engineered.
    pub body: Value,
}

/// A live read-receipt signal: one member's read position moved in a
/// conversation. Teams pushes this as a `ThreadActivity/MemberConsumptionHorizon
/// Update` message on the same channel as chat; we surface it as ephemeral state
/// (never persisted) so the "seen by" avatars update without re-polling. The
/// server resolves `member_mri` to a display name before forwarding to the UIs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadReceiptEvent {
    pub conversation_id: String,
    pub member_mri: String,
    /// The id of the last message this member has read (a real message id).
    pub last_read_message_id: String,
    /// When they read it (epoch ms), or 0 when Teams omitted it.
    pub read_time_ms: i64,
}

/// Everything one real-time push carries: chat messages, typing signals,
/// read-receipt updates, and (experimental) native calling frames. Chat, typing,
/// and receipts are decoded from the same EventMessage envelope, so we decode once
/// and split; calling frames arrive on a separate worker URL with a proprietary
/// payload.
#[derive(Debug, Default, PartialEq)]
pub struct Realtime {
    pub messages: Vec<Message>,
    pub typing: Vec<TypingEvent>,
    pub read_receipts: Vec<ReadReceiptEvent>,
    pub calls: Vec<CallFrame>,
}

/// Decode a Socket.IO "3:::" request payload (already stripped to the JSON object)
/// and return everything it carries: chat messages, typing signals, and — when
/// calling is enabled — native calling frames. Other pushes (presence, thread
/// updates, etc.) yield an empty result.
pub fn realtime_from_request(request: &Value) -> Result<Realtime> {
    let url = request.get("url").and_then(|u| u.as_str()).unwrap_or("");

    // Native calling pushes arrive on a dedicated worker URL (…/NGCallManagerWin
    // or …/SkypeSpacesWeb), NOT on /messaging, and carry a proprietary payload —
    // decode them separately into raw `CallFrame`s (see `CallFrame`).
    if is_calling_url(url) {
        return Ok(Realtime {
            calls: call_frames_from_request(request, url)?,
            ..Default::default()
        });
    }

    // Only chat traffic carries messages/typing; skip everything else cheaply.
    if !url.ends_with("/messaging") {
        return Ok(Realtime::default());
    }

    let gzipped = request
        .pointer("/headers/X-Microsoft-Skype-Content-Encoding")
        .and_then(|v| v.as_str())
        == Some("gzip");
    let raw_body = request.get("body").and_then(|b| b.as_str()).unwrap_or("");

    let body_json = decode_body(raw_body, gzipped)?;
    let payload = unwrap_nested(body_json)?;

    if payload.get("type").and_then(|t| t.as_str()) != Some("EventMessage") {
        return Ok(Realtime::default());
    }
    Ok(Realtime {
        messages: messages_from_event(&payload),
        typing: typing_from_event(&payload),
        read_receipts: read_receipts_from_event(&payload),
        ..Default::default()
    })
}

/// Back-compat convenience: just the chat messages from a push. Kept so callers
/// (and tests) that only care about messages stay unchanged.
pub fn messages_from_request(request: &Value) -> Result<Vec<Message>> {
    Ok(realtime_from_request(request)?.messages)
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

/// True for a trouter push delivered to one of the native calling workers
/// (NextGenCalling → …/NGCallManagerWin, SkypeSpacesWeb → …/SkypeSpacesWeb).
/// These carry call setup/state/hangup, not chat.
fn is_calling_url(url: &str) -> bool {
    url.ends_with("NGCallManagerWin") || url.contains("SkypeSpacesWeb")
}

/// Decode a native calling push into a `CallFrame`. The outer envelope carries
/// routing fields (evt/callId/callerId); the actual callNotification is nested
/// under `cp` (gzip+base64) or `gp` (base64). We expand that inner payload under
/// `_decoded` rather than replacing the outer object, so nothing is lost while the
/// proprietary schema is still being reverse-engineered. An empty or malformed
/// body yields no frame rather than erroring the whole push.
fn call_frames_from_request(request: &Value, url: &str) -> Result<Vec<CallFrame>> {
    let gzipped = request
        .pointer("/headers/X-Microsoft-Skype-Content-Encoding")
        .and_then(|v| v.as_str())
        == Some("gzip");
    let raw_body = request.get("body").and_then(|b| b.as_str()).unwrap_or("");
    if raw_body.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut body = decode_body(raw_body, gzipped)?;
    if let Some(inner) = try_unwrap_nested(&body) {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("_decoded".to_string(), inner);
        }
    }
    let call_id = extract_call_id(&body);
    Ok(vec![CallFrame { url: url.to_string(), call_id, body }])
}

/// Like `unwrap_nested`, but returns the decoded inner payload (or `None`) instead
/// of replacing the body — and never errors, so a malformed calling frame is just
/// left un-expanded rather than dropping the whole push.
fn try_unwrap_nested(body: &Value) -> Option<Value> {
    if let Some(cp) = body.get("cp").and_then(|c| c.as_str()) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(cp.trim()).ok()?;
        let text = gunzip(&bytes).ok()?;
        return serde_json::from_str(&text).ok();
    }
    if let Some(gp) = body.get("gp").and_then(|g| g.as_str()) {
        let bytes = base64::engine::general_purpose::STANDARD.decode(gp.trim()).ok()?;
        let text = String::from_utf8(bytes).ok()?;
        return serde_json::from_str(&text).ok();
    }
    None
}

/// Best-effort call id for correlating an invite with its later state/hangup
/// frames. Checks the outer envelope first, then the decoded inner notification.
fn extract_call_id(body: &Value) -> String {
    fn pick(v: &Value) -> String {
        for key in ["callId", "callID", "id"] {
            match v.get(key) {
                Some(Value::String(s)) => return s.clone(),
                Some(Value::Number(n)) => return n.to_string(),
                _ => {}
            }
        }
        String::new()
    }
    let outer = pick(body);
    if !outer.is_empty() {
        return outer;
    }
    body.get("_decoded").map(pick).unwrap_or_default()
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

/// Pull typing signals out of an EventMessage envelope. Teams delivers typing as
/// a `NewMessage` resource whose `messagetype` is `Control/Typing` (started) or
/// `Control/ClearTyping` (stopped) — the same channel as chat, which is exactly
/// why `parse_message` drops them from history. Here we surface them instead as
/// ephemeral presence, keyed by conversation and sender MRI. Other resource
/// types and message types yield nothing.
fn typing_from_event(event: &Value) -> Vec<TypingEvent> {
    if event.get("resourceType").and_then(|r| r.as_str()) != Some("NewMessage") {
        return Vec::new();
    }
    let Some(resource) = event.get("resource") else { return Vec::new() };
    let messagetype = resource
        .get("messagetype")
        .or_else(|| resource.get("messageType"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let is_typing = match messagetype {
        "Control/Typing" => true,
        "Control/ClearTyping" => false,
        _ => return Vec::new(),
    };
    let conversation_id = conversation_id_of(resource);
    let sender_mri = resource
        .get("from")
        .and_then(|x| x.as_str())
        .map(teams_read::normalize_mri)
        .unwrap_or_default();
    if conversation_id.is_empty() || sender_mri.is_empty() {
        return Vec::new();
    }
    vec![TypingEvent { conversation_id, sender_mri, is_typing }]
}

/// Pull read-receipt updates out of an EventMessage envelope. Teams delivers a
/// member's moved read position as a `NewMessage` resource whose `messagetype`
/// is `ThreadActivity/MemberConsumptionHorizonUpdate` and whose `content` is a
/// JSON string carrying the reader's MRI and their new consumption horizon (see
/// `teams_readstate::parse_horizon_update_content`) — the same channel as chat,
/// which is exactly why `parse_message` drops it from history. Other resource /
/// message types, and a horizon that means "never read", yield nothing.
fn read_receipts_from_event(event: &Value) -> Vec<ReadReceiptEvent> {
    if event.get("resourceType").and_then(|r| r.as_str()) != Some("NewMessage") {
        return Vec::new();
    }
    let Some(resource) = event.get("resource") else { return Vec::new() };
    let messagetype = resource
        .get("messagetype")
        .or_else(|| resource.get("messageType"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if messagetype != "ThreadActivity/MemberConsumptionHorizonUpdate" {
        return Vec::new();
    }
    let conversation_id = conversation_id_of(resource);
    let content = resource.get("content").and_then(|c| c.as_str()).unwrap_or("");
    let Some(horizon) = teams_readstate::parse_horizon_update_content(content) else {
        return Vec::new();
    };
    let member_mri = teams_read::normalize_mri(&horizon.mri);
    if conversation_id.is_empty() || member_mri.is_empty() {
        return Vec::new();
    }
    vec![ReadReceiptEvent {
        conversation_id,
        member_mri,
        last_read_message_id: horizon.last_read_message_id,
        read_time_ms: horizon.read_time_ms,
    }]
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

    #[test]
    fn typing_control_frame_yields_no_message() {
        // Teams pushes a typing indicator as a live `NewMessage` whose messagetype
        // is a control type and whose body is a bare notifications endpoint URL.
        // It passes the resourceType gate, so it must be dropped by parse_message.
        let ev = json!({
            "type": "EventMessage",
            "resourceType": "NewMessage",
            "resource": {
                "id": "1784217930000",
                "sequenceId": 9187,
                "composetime": "2026-07-16T16:05:30.000Z",
                "messagetype": "Control/Typing",
                "content": "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:bea5de00-723a-4526-b216-4cc52ac383f9",
                "conversationid": "19:abc@thread.v2"
            }
        });
        let request = json!({ "url": "https://x/messaging", "headers": {}, "body": ev.to_string() });
        assert!(messages_from_request(&request).unwrap().is_empty());
    }

    fn control_event(messagetype: &str) -> Value {
        json!({
            "type": "EventMessage",
            "resourceType": "NewMessage",
            "resource": {
                "id": "typing-1",
                "messagetype": messagetype,
                "content": "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:bea5de00",
                "from": "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:bea5de00",
                "conversationid": "19:abc@thread.v2"
            }
        })
    }

    #[test]
    fn typing_signal_extracted_from_control_frame() {
        // Control/Typing -> a typing signal (and no chat message), with the sender
        // MRI normalized out of the contacts URL.
        let req = json!({ "url": "https://x/messaging", "headers": {}, "body": control_event("Control/Typing").to_string() });
        let rt = realtime_from_request(&req).unwrap();
        assert!(rt.messages.is_empty(), "a typing frame is not a chat message");
        assert_eq!(rt.typing.len(), 1);
        let t = &rt.typing[0];
        assert_eq!(t.conversation_id, "19:abc@thread.v2");
        assert_eq!(t.sender_mri, "8:orgid:bea5de00");
        assert!(t.is_typing);

        // Control/ClearTyping -> a stop signal.
        let req = json!({ "url": "https://x/messaging", "headers": {}, "body": control_event("Control/ClearTyping").to_string() });
        let rt = realtime_from_request(&req).unwrap();
        assert_eq!(rt.typing.len(), 1);
        assert!(!rt.typing[0].is_typing);
    }

    #[test]
    fn normal_message_carries_no_typing_signal() {
        let request = json!({
            "url": "https://x/messaging",
            "headers": {},
            "body": new_message_event().to_string()
        });
        let rt = realtime_from_request(&request).unwrap();
        assert_eq!(rt.messages.len(), 1);
        assert!(rt.typing.is_empty());
        assert!(rt.read_receipts.is_empty());
    }

    #[test]
    fn consumption_horizon_update_yields_a_read_receipt_not_a_message() {
        // Teams pushes another member's moved read position as a live `NewMessage`
        // whose messagetype is a ThreadActivity control type and whose `content`
        // is a JSON horizon. It must decode to a read receipt (and no chat
        // message), with the reader MRI normalized out of any contacts URL.
        let ev = json!({
            "type": "EventMessage",
            "resourceType": "NewMessage",
            "resource": {
                "id": "1784217930000",
                "messagetype": "ThreadActivity/MemberConsumptionHorizonUpdate",
                "from": "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:reader",
                "content": "{\"user\":\"8:orgid:reader\",\"consumptionhorizon\":\"1784217900000;1784217901000;0\"}",
                "conversationid": "19:abc@thread.v2"
            }
        });
        let req = json!({ "url": "https://x/messaging", "headers": {}, "body": ev.to_string() });
        let rt = realtime_from_request(&req).unwrap();
        assert!(rt.messages.is_empty(), "a horizon update is not a chat message");
        assert!(rt.typing.is_empty());
        assert_eq!(rt.read_receipts.len(), 1);
        let r = &rt.read_receipts[0];
        assert_eq!(r.conversation_id, "19:abc@thread.v2");
        assert_eq!(r.member_mri, "8:orgid:reader");
        assert_eq!(r.last_read_message_id, "1784217900000");
        assert_eq!(r.read_time_ms, 1784217901000);
    }

    // ---- native calling (experimental) ------------------------------------

    /// The inner callNotification the calling service nests under `cp`, modeled on
    /// the envelope EionRobb/purple-teams documents (from/to, media, keys, links).
    fn call_notification_inner() -> Value {
        json!({
            "from": { "id": "8:orgid:caller-guid", "displayName": "Alice Caller", "endpointId": "ep-1" },
            "to": { "id": "8:orgid:me-guid", "endpointId": "ep-2" },
            "mediaContent": { "contentType": "application/sdp-ngc-0.5", "blob": "v=0\r\n...", "mediaLegId": "leg-1" },
            "udpKey": { "sessionKey": "k", "ticket": "t" },
            "links": { "mediaAnswer": "cc://ma", "reject": "cc://rj", "attach": "cc://at" }
        })
    }

    #[test]
    fn calling_frame_is_decoded_and_inner_expanded() {
        // Incoming call: outer envelope carries routing fields + the gzipped inner
        // notification under `cp`. We must keep BOTH — the outer id and the expanded
        // inner payload — and produce no chat message.
        let outer = json!({
            "evt": 107,
            "callId": "call-abc-123",
            "callerId": "8:orgid:caller-guid",
            "cp": gzip_b64(&call_notification_inner().to_string())
        });
        let request = json!({
            "url": "https://trouter.example/v4/f/xyz/NGCallManagerWin",
            "headers": {},
            "body": outer.to_string()
        });
        let rt = realtime_from_request(&request).unwrap();
        assert!(rt.messages.is_empty(), "a call frame is not a chat message");
        assert!(rt.typing.is_empty());
        assert_eq!(rt.calls.len(), 1);
        let c = &rt.calls[0];
        assert_eq!(c.call_id, "call-abc-123");
        assert!(c.url.ends_with("NGCallManagerWin"));
        // The nested callNotification is expanded under `_decoded`, not lost.
        assert_eq!(c.body["_decoded"]["mediaContent"]["contentType"], "application/sdp-ngc-0.5");
        assert_eq!(c.body["_decoded"]["from"]["displayName"], "Alice Caller");
        // The outer routing fields survive alongside it.
        assert_eq!(c.body["callerId"], "8:orgid:caller-guid");
    }

    #[test]
    fn skypespacesweb_url_is_treated_as_calling() {
        // A plain (un-nested) state frame on the SkypeSpacesWeb worker.
        let request = json!({
            "url": "https://trouter.example/v4/f/xyz/SkypeSpacesWeb",
            "headers": {},
            "body": json!({ "callId": "c-9", "state": "connected" }).to_string()
        });
        let rt = realtime_from_request(&request).unwrap();
        assert_eq!(rt.calls.len(), 1);
        assert_eq!(rt.calls[0].call_id, "c-9");
    }

    #[test]
    fn calling_frame_id_falls_back_to_inner_notification() {
        // Outer envelope has no id; the id lives in the nested notification.
        let inner = json!({ "callId": "inner-77", "from": { "displayName": "Bob" } });
        let outer = json!({ "evt": 107, "cp": gzip_b64(&inner.to_string()) });
        let request = json!({
            "url": "https://trouter.example/v4/f/xyz/NGCallManagerWin",
            "headers": {},
            "body": outer.to_string()
        });
        let rt = realtime_from_request(&request).unwrap();
        assert_eq!(rt.calls.len(), 1);
        assert_eq!(rt.calls[0].call_id, "inner-77");
    }

    #[test]
    fn messaging_push_carries_no_calls() {
        let request = json!({
            "url": "https://x/messaging",
            "headers": {},
            "body": new_message_event().to_string()
        });
        let rt = realtime_from_request(&request).unwrap();
        assert_eq!(rt.messages.len(), 1);
        assert!(rt.calls.is_empty());
    }

    #[test]
    fn other_non_messaging_url_yields_no_calls() {
        // A non-calling, non-messaging push (e.g. presence) must not be mistaken
        // for a call even if it happens to carry a `callId`-shaped field.
        let request = json!({
            "url": "https://x/unifiedPresenceService",
            "headers": {},
            "body": json!({ "callId": "should-be-ignored" }).to_string()
        });
        let rt = realtime_from_request(&request).unwrap();
        assert!(rt.calls.is_empty());
        assert!(rt.messages.is_empty());
    }
}
