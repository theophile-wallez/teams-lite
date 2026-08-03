// Read receipts ("seen by"): who has read a conversation, and up to which
// message. Teams tracks each roster member's read position as a "consumption
// horizon" and exposes it to this client two ways:
//
//   1. PULL — `GET {chatService}/v1/threads/{threadId}/consumptionhorizons`
//      returns EVERY member's current horizon (see `fetch_consumption_horizons`).
//      Used on open to seed the receipts.
//   2. PUSH — a live `ThreadActivity/MemberConsumptionHorizonUpdate` message on
//      the trouter channel whenever one member's horizon moves (decoded in
//      `trouter_events`, parsed here by `parse_horizon_update_content`). Used to
//      keep the receipts live without polling.
//
// A horizon is a `;`-delimited string: `"<lastReadMessageId>;<readTimeMs>;
// <clientMessageId>"`. Field 0 is a real Teams message id (arrival-time in ms,
// so it maps directly onto a message's `id`/`seq`); the reader has seen every
// message up to and including it. Field 1 is when they read it.
//
// One WRITE lives here — [`set_consumption_horizon`], which moves OUR OWN horizon
// and is what marks a thread read (see the `mark_read` RPC in src/bin/server.rs).
// It is outward-facing: it clears the unread marker in every Teams client the user
// owns AND shows a read receipt to the other party, so it is gated exactly like
// sending — the write token, refused read-only, and an `OUTWARD_METHODS` entry.
// Nothing else in this module writes: the two fetches above only GET.

use anyhow::{Context, Result};
use serde_json::Value;

/// One member's read position in a conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumptionHorizon {
    /// The member's MRI (e.g. `8:orgid:<guid>`).
    pub mri: String,
    /// The id of the last message this member has read. May be `"0"` (or empty)
    /// when they have never read anything — such entries are dropped by the
    /// fetch, so a value here is always a real message id.
    pub last_read_message_id: String,
    /// When they read it (epoch ms), or 0 when Teams omitted it.
    pub read_time_ms: i64,
}

/// Fetch every roster member's read position for a conversation.
///
/// Hits the dedicated `consumptionhorizons` thread sub-resource with the
/// skypetoken (the same `Authentication: skypetoken=…` scheme the read API uses,
/// NOT a Bearer). Returns one entry per member that has actually read something;
/// members with a `"0"`/empty horizon are dropped. The caller filters out our
/// own MRI — this returns everyone, including us.
///
/// Best-effort by contract: a thread with read receipts disabled (tenant policy)
/// or too many members (Teams stops tracking past ~20) simply yields no usable
/// entries; a transient failure surfaces as an error for the caller's retry
/// policy to handle.
pub async fn fetch_consumption_horizons(
    http: &reqwest::Client,
    session: &crate::teams::Session,
    conversation_id: &str,
) -> Result<Vec<ConsumptionHorizon>> {
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat_service}/v1/threads/{}/consumptionhorizons",
        urlencoding::encode(conversation_id)
    );
    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("consumptionhorizons request")?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        anyhow::bail!("consumptionhorizons -> {status}");
    }
    let v: Value = serde_json::from_str(&body).context("parse consumptionhorizons")?;
    Ok(parse_consumption_horizons(&v))
}

/// Move OUR OWN read position to `last_read_message_id` — the write that marks a
/// conversation read.
///
/// OUTWARD: Teams propagates the new horizon to every client the user is signed in
/// on (the unread marker clears on their phone and in the desktop app) and shows it
/// to the other party as a read receipt. Only the gated `mark_read` RPC calls this.
///
/// Hits the conversation's `consumptionhorizon` property with the skypetoken, the
/// same auth scheme the fetch above uses. `read_time_ms` is when the user read it
/// (epoch ms); the third horizon field is a client message id Teams does not need
/// here, so it is `0`. Verified against the live tenant: the PUT answers 200 and the
/// CSA aggregator then reports the thread as read.
pub async fn set_consumption_horizon(
    http: &reqwest::Client,
    session: &crate::teams::Session,
    conversation_id: &str,
    last_read_message_id: &str,
    read_time_ms: i64,
) -> Result<()> {
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat_service}/v1/users/ME/conversations/{}/properties?name=consumptionhorizon",
        urlencoding::encode(conversation_id)
    );
    let resp = http
        .put(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .json(&serde_json::json!({
            "consumptionhorizon": horizon_value(last_read_message_id, read_time_ms)
        }))
        .send()
        .await
        .context("consumptionhorizon PUT")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("consumptionhorizon PUT -> {status} {}", body.trim());
    }
    Ok(())
}

/// Format a horizon for the wire: `"<lastReadMessageId>;<readTimeMs>;<clientMessageId>"`,
/// the exact shape [`parse_horizon`] decodes. Pure, so the wire format is pinned by a
/// unit test instead of by a live call.
pub fn horizon_value(last_read_message_id: &str, read_time_ms: i64) -> String {
    format!("{last_read_message_id};{read_time_ms};0")
}

/// Parse the `consumptionhorizons` response into read positions, dropping members
/// who have never read (`"0"`/empty). Pure, so it is unit-testable against a
/// captured payload.
pub fn parse_consumption_horizons(v: &Value) -> Vec<ConsumptionHorizon> {
    let Some(list) = v.get("consumptionhorizons").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| {
            let mri = entry.get("id").and_then(Value::as_str)?.to_string();
            let horizon = entry.get("consumptionhorizon").and_then(Value::as_str)?;
            let (last_read_message_id, read_time_ms) = parse_horizon(horizon)?;
            Some(ConsumptionHorizon { mri, last_read_message_id, read_time_ms })
        })
        .collect()
}

/// Decode a `ThreadActivity/MemberConsumptionHorizonUpdate` push body (the
/// message resource's `content`, a JSON string like
/// `{"user":"<mri>","consumptionhorizon":"<id>;<ms>;<clientId>",…}`) into one
/// member's read position. Returns `None` when the body is not the expected
/// shape or carries an empty/`"0"` horizon.
pub fn parse_horizon_update_content(content: &str) -> Option<ConsumptionHorizon> {
    let v: Value = serde_json::from_str(content).ok()?;
    let mri = v.get("user").and_then(Value::as_str)?.to_string();
    let horizon = v.get("consumptionhorizon").and_then(Value::as_str)?;
    let (last_read_message_id, read_time_ms) = parse_horizon(horizon)?;
    Some(ConsumptionHorizon { mri, last_read_message_id, read_time_ms })
}

/// Split a horizon string `"<lastReadMessageId>;<readTimeMs>;<clientMessageId>"`
/// into (last-read message id, read time ms). Returns `None` when there is no
/// real read position — an empty or `"0"` message id means "never read".
fn parse_horizon(horizon: &str) -> Option<(String, i64)> {
    let mut parts = horizon.split(';');
    let message_id = parts.next()?.trim();
    if message_id.is_empty() || message_id == "0" {
        return None;
    }
    let read_time_ms = parts.next().and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(0);
    Some((message_id.to_string(), read_time_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_all_members_and_drops_never_read() {
        let v = json!({
            "id": "19:abc@thread.v2",
            "version": "1784217926767",
            "consumptionhorizons": [
                { "id": "8:orgid:me",    "consumptionhorizon": "1784217926767;1784217930000;0", "messageVisibilityTime": 1 },
                { "id": "8:orgid:other", "consumptionhorizon": "1784217900000;1784217901000;123", "messageVisibilityTime": 1 },
                { "id": "8:orgid:never", "consumptionhorizon": "0;0;0", "messageVisibilityTime": 1 },
                { "id": "8:orgid:empty", "consumptionhorizon": "", "messageVisibilityTime": 1 }
            ]
        });
        let horizons = parse_consumption_horizons(&v);
        assert_eq!(horizons.len(), 2, "the '0' and empty horizons are dropped");
        assert_eq!(horizons[0].mri, "8:orgid:me");
        assert_eq!(horizons[0].last_read_message_id, "1784217926767");
        assert_eq!(horizons[0].read_time_ms, 1784217930000);
        assert_eq!(horizons[1].mri, "8:orgid:other");
        assert_eq!(horizons[1].last_read_message_id, "1784217900000");
    }

    #[test]
    fn missing_array_yields_empty() {
        assert!(parse_consumption_horizons(&json!({ "id": "x" })).is_empty());
        assert!(parse_consumption_horizons(&json!({})).is_empty());
    }

    #[test]
    fn parses_live_push_content() {
        let content = json!({
            "user": "8:orgid:other",
            "consumptionhorizon": "1784217900000;1784217901000;0",
            "messageVisibilityTime": 1784217800000i64,
            "version": "1784217901000"
        })
        .to_string();
        let h = parse_horizon_update_content(&content).unwrap();
        assert_eq!(h.mri, "8:orgid:other");
        assert_eq!(h.last_read_message_id, "1784217900000");
        assert_eq!(h.read_time_ms, 1784217901000);
    }

    #[test]
    fn live_push_never_read_is_none() {
        let content = json!({ "user": "8:orgid:x", "consumptionhorizon": "0;0;0" }).to_string();
        assert!(parse_horizon_update_content(&content).is_none());
    }

    // The horizon we write must be the exact shape we read back, or Teams silently
    // keeps the thread unread. Round-tripping our own formatter through the parser
    // pins both halves at once.
    #[test]
    fn our_horizon_round_trips_through_the_parser() {
        let wire = horizon_value("1784217926767", 1784217930000);
        assert_eq!(wire, "1784217926767;1784217930000;0");
        let v = json!({
            "consumptionhorizons": [{ "id": "8:orgid:me", "consumptionhorizon": wire }]
        });
        let h = &parse_consumption_horizons(&v)[0];
        assert_eq!(h.last_read_message_id, "1784217926767");
        assert_eq!(h.read_time_ms, 1784217930000);
    }

    #[test]
    fn live_push_malformed_is_none() {
        assert!(parse_horizon_update_content("not json").is_none());
        assert!(parse_horizon_update_content(r#"{"user":"8:x"}"#).is_none());
    }
}
