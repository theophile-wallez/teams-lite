// Teams "activity feed" (the `48:notifications` thread) decoding.
//
// `48:notifications` is NOT a chat. Every frame it delivers is a system message
// whose chat `content` is always empty — the real payload lives in
// `properties.activity`. Treated as a chat (as the message pipeline does by
// default) these render as blank bubbles with a raw MRI-URL title. This module
// turns those frames into structured `Notification`s — someone reacted to,
// replied to, or mentioned you — and fetches the feed on demand.
//
// Pure decoding lives here and is unit-tested against the real payload shape;
// the front-end owns all presentation (emoji, phrasing) so the wire stays a
// faithful mirror of Teams' own fields.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::teams::Session;
use crate::teams_read::parse_iso_ms;

/// The well-known id of the Teams activity/notifications thread.
pub const NOTIFICATIONS_THREAD: &str = "48:notifications";

/// Default number of feed entries to fetch.
pub const DEFAULT_NOTIFICATIONS_LIMIT: u32 = 30;

/// True only for the activity/notifications system thread.
///
/// Deliberately an exact match: `48:notes` (notes-to-self) is a real chat and
/// must keep flowing through the normal message pipeline.
pub fn is_notifications_thread(id: &str) -> bool {
    id == NOTIFICATIONS_THREAD
}

/// One decoded activity-feed entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    /// The underlying frame id (stable key for de-dup in the UI).
    pub id: String,
    /// Raw Teams activity type, passed through so the front-end can phrase and
    /// iconize it (e.g. "reactionInChat", "mention", "reply"). We intentionally
    /// do not map it to copy here — presentation belongs to the UI.
    pub activity_type: String,
    /// Reaction flavor for reaction activities (e.g. "like", "heart", "laugh");
    /// empty for non-reaction activities.
    pub activity_subtype: String,
    /// Who triggered it — display name and MRI (for the avatar seed).
    pub actor_name: String,
    pub actor_mri: String,
    /// The chat/channel the activity happened in, so the UI can open it.
    pub source_thread_id: String,
    /// Short preview of the target message (may be "image", a filename, etc.).
    pub preview: String,
    /// When it happened (epoch ms).
    pub timestamp_ms: i64,
    /// How many actors Teams aggregated into this entry (its `count`, min 1).
    pub count: i64,
    /// Teams' own server-side read state for this entry.
    pub is_read: bool,
}

/// Decode a single notifications frame into a `Notification`, or `None` when the
/// frame carries no `properties.activity` payload (nothing to show).
pub fn parse_activity(frame: &Value) -> Option<Notification> {
    let id = frame.get("id").and_then(Value::as_str)?.to_string();
    let props = decode_properties(frame);
    let activity = props.get("activity")?;
    let field = |key: &str| activity.get(key).and_then(Value::as_str).unwrap_or("").to_string();

    let activity_type = field("activityType");
    if activity_type.is_empty() {
        return None;
    }

    // Prefer the activity's own timestamp; fall back to the frame compose time.
    let timestamp_ms = activity
        .get("activityTimestamp")
        .and_then(Value::as_str)
        .map(parse_iso_ms)
        .filter(|&ms| ms > 0)
        .or_else(|| frame.get("composetime").and_then(Value::as_str).map(parse_iso_ms))
        .unwrap_or(0);

    Some(Notification {
        id,
        activity_type,
        activity_subtype: field("activitySubtype"),
        actor_name: field("sourceUserImDisplayName"),
        actor_mri: field("sourceUserId"),
        source_thread_id: field("sourceThreadId"),
        preview: field("messagePreview"),
        timestamp_ms,
        count: parse_count(activity.get("count")),
        is_read: props.get("isread").map(is_truthy).unwrap_or(false),
    })
}

/// Parse a `/messages` page of the notifications thread into notifications,
/// newest-first. Frames without an activity payload are skipped.
pub fn parse_notifications_page(page: &Value) -> Vec<Notification> {
    let mut out: Vec<Notification> = page
        .get("messages")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_activity).collect())
        .unwrap_or_default();
    out.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    out
}

/// Fetch the newest page of the activity feed from chatService and decode it.
pub async fn fetch_notifications(
    http: &reqwest::Client,
    session: &Session,
    limit: u32,
) -> Result<Vec<Notification>> {
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat_service}/v1/users/ME/conversations/{}/messages?pageSize={limit}&view=msnp24Equivalent",
        urlencoding::encode(NOTIFICATIONS_THREAD)
    );
    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("chatService notifications request")?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        anyhow::bail!("chatService notifications -> {status}");
    }
    let v: Value = serde_json::from_str(&body).context("parse notifications page")?;
    Ok(parse_notifications_page(&v))
}

/// `properties` may arrive as a nested object or as a JSON-encoded string (Teams
/// double-encodes it on some shapes — same as `parse_attachments`). Decode both.
fn decode_properties(frame: &Value) -> Value {
    match frame.get("properties") {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        _ => Value::Null,
    }
}

/// Teams sends `count` as a string ("1") on the read API and occasionally as a
/// number on live frames; accept both and never drop below 1.
fn parse_count(v: Option<&Value>) -> i64 {
    let n = match v {
        Some(Value::String(s)) => s.parse().unwrap_or(1),
        Some(Value::Number(n)) => n.as_i64().unwrap_or(1),
        _ => 1,
    };
    n.max(1)
}

/// `isread` is a stringly-typed bool ("true"/"false") on the read API; also
/// accept a real JSON bool defensively.
fn is_truthy(v: &Value) -> bool {
    match v {
        Value::String(s) => s.eq_ignore_ascii_case("true"),
        Value::Bool(b) => *b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A faithful reaction frame, mirroring a real `48:notifications` message
    /// captured from the tenant (properties.activity is the whole payload).
    fn reaction_frame() -> Value {
        json!({
            "id": "1784735081915",
            "composetime": "2026-07-22T15:44:41.9150000Z",
            "content": "",
            "contenttype": "text",
            "messagetype": "Text",
            "from": "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:me",
            "conversationid": "48:notifications",
            "sequenceId": 15610_i64,
            "properties": {
                "isread": "false",
                "activity": {
                    "activityId": 141687964019_i64,
                    "activitySubtype": "sad",
                    "activityTimestamp": "2026-07-22T15:44:41.414Z",
                    "activityType": "reactionInChat",
                    "count": "1",
                    "messagePreview": "0 pause quoi",
                    "sourceMessageId": 1784734634778_i64,
                    "sourceThreadId": "19:abc_def@unq.gbl.spaces",
                    "sourceUserId": "8:orgid:bea5de00",
                    "sourceUserImDisplayName": "Clément DELBARRE",
                    "targetUserId": "8:orgid:me"
                }
            }
        })
    }

    #[test]
    fn parses_a_reaction_frame_into_a_notification() {
        let n = parse_activity(&reaction_frame()).expect("should parse");
        assert_eq!(n.id, "1784735081915");
        assert_eq!(n.activity_type, "reactionInChat");
        assert_eq!(n.activity_subtype, "sad");
        assert_eq!(n.actor_name, "Clément DELBARRE");
        assert_eq!(n.actor_mri, "8:orgid:bea5de00");
        assert_eq!(n.source_thread_id, "19:abc_def@unq.gbl.spaces");
        assert_eq!(n.preview, "0 pause quoi");
        assert_eq!(n.count, 1);
        assert!(!n.is_read);
        // 2026-07-22T15:44:41.414Z
        assert!(n.timestamp_ms > 1_700_000_000_000);
    }

    #[test]
    fn decodes_json_encoded_properties_string() {
        // Some frames double-encode `properties` as a JSON string.
        let mut frame = reaction_frame();
        let props = frame.get("properties").unwrap().clone();
        frame["properties"] = Value::String(serde_json::to_string(&props).unwrap());
        let n = parse_activity(&frame).expect("should still parse");
        assert_eq!(n.activity_type, "reactionInChat");
        assert_eq!(n.actor_name, "Clément DELBARRE");
    }

    #[test]
    fn frame_without_activity_is_skipped() {
        let frame = json!({ "id": "x", "content": "", "properties": { "isread": "true" } });
        assert!(parse_activity(&frame).is_none());
        let frame_no_props = json!({ "id": "y", "content": "hi" });
        assert!(parse_activity(&frame_no_props).is_none());
    }

    #[test]
    fn is_read_accepts_string_and_bool() {
        let mut frame = reaction_frame();
        frame["properties"]["isread"] = json!("true");
        assert!(parse_activity(&frame).unwrap().is_read);
        frame["properties"]["isread"] = json!(true);
        assert!(parse_activity(&frame).unwrap().is_read);
        frame["properties"].as_object_mut().unwrap().remove("isread");
        assert!(!parse_activity(&frame).unwrap().is_read);
    }

    #[test]
    fn count_defaults_to_one_and_accepts_numbers() {
        let mut frame = reaction_frame();
        frame["properties"]["activity"]["count"] = json!(3);
        assert_eq!(parse_activity(&frame).unwrap().count, 3);
        frame["properties"]["activity"].as_object_mut().unwrap().remove("count");
        assert_eq!(parse_activity(&frame).unwrap().count, 1);
        frame["properties"]["activity"]["count"] = json!("0");
        assert_eq!(parse_activity(&frame).unwrap().count, 1);
    }

    #[test]
    fn page_is_newest_first_and_drops_non_activity_frames() {
        let mut older = reaction_frame();
        older["id"] = json!("older");
        older["properties"]["activity"]["activityTimestamp"] = json!("2026-07-22T10:00:00.000Z");
        let mut newer = reaction_frame();
        newer["id"] = json!("newer");
        newer["properties"]["activity"]["activityTimestamp"] = json!("2026-07-22T20:00:00.000Z");
        let junk = json!({ "id": "junk", "content": "" });

        let page = json!({ "messages": [older, junk, newer] });
        let out = parse_notifications_page(&page);
        assert_eq!(out.len(), 2, "the non-activity frame is dropped");
        assert_eq!(out[0].id, "newer", "sorted newest-first");
        assert_eq!(out[1].id, "older");
    }

    #[test]
    fn only_the_exact_notifications_thread_matches() {
        assert!(is_notifications_thread("48:notifications"));
        assert!(!is_notifications_thread("48:notes"));
        assert!(!is_notifications_thread("19:abc@thread.v2"));
    }
}
