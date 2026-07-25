// Read a person's Teams presence ("Available", "Busy", "In a meeting", …).
//
// Proven shape (recon against the live tenant):
//   POST {unifiedPresence}/v1/presence/getpresence/
//     where {unifiedPresence} is the regionGtms entry (e.g.
//     https://presence.teams.microsoft.com) — the same service the Teams client
//     talks to.
//   Auth: Bearer {PROFILE_SCOPE token} + x-skypetoken   (same pair as the photo
//     and short-profile endpoints; the skypetoken alone is refused).
//   Body: [ { "mri": "8:orgid:<guid>" }, … ]
//   Resp: [ { "mri": "…", "status": 20000, "etag": "…", "presence": {
//              "availability": "Available",       // the coarse state
//              "activity": "InAMeeting",          // the finer reason
//              "lastActiveTime": "2026-07-25T11:26:12.58Z",
//              "calendarData": { "isOutOfOffice": true,
//                                "outOfOfficeNote": { "message": "OOO", … } },
//              "note": { "message": "<custom status>", … },
//              "sourceNetwork": "SameEnterprise" } } ]
//
// READ-ONLY: this module never publishes or forces OUR own presence — it only
// reads other people's, exactly as hovering a name in Teams does. (Microsoft
// Graph `/presence` is not usable here: the broker token has no Presence.Read
// consent and answers 403.)

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::teams::Session;
use crate::teams_profiles::is_person_mri;

/// regionGtms key holding the presence service base URL, with a fixed fallback
/// for a session whose directory omits it.
const PRESENCE_HOST_KEY: &str = "unifiedPresence";
const PRESENCE_HOST_FALLBACK: &str = "https://presence.teams.microsoft.com";

/// How many mris one request may carry (the UI asks for one person at a time;
/// the cap bounds the request body for any future batch caller).
pub const MAX_BATCH: usize = 100;

/// One person's presence. `availability` is the coarse state Teams colours the
/// badge by ("Available", "Away", "BeRightBack", "Busy", "DoNotDisturb",
/// "Offline", "PresenceUnknown"); `activity` is the finer reason it labels
/// ("InAMeeting", "InACall", "Presenting", "OffWork", …). Both are passed through
/// verbatim rather than mapped to an enum: Teams keeps adding activities, and an
/// unknown one should degrade to its availability colour, not be dropped.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Presence {
    pub mri: String,
    pub availability: String,
    pub activity: String,
    /// When this person was last active, in epoch ms; 0 when unreported.
    pub last_active_ms: i64,
    /// Their calendar says they are out of office (Teams shows this as a distinct
    /// badge, even while the availability is Offline/Busy).
    pub out_of_office: bool,
    /// The automatic-reply text that comes with `out_of_office` (often empty).
    pub out_of_office_note: String,
    /// Their custom status message ("note"), empty when unset.
    pub note: String,
}

impl Presence {
    /// A presence we know nothing about — what the UI shows while it is loading or
    /// when the service has no answer for this person.
    pub fn unknown(mri: &str) -> Self {
        Self {
            mri: mri.to_string(),
            availability: "PresenceUnknown".to_string(),
            activity: "PresenceUnknown".to_string(),
            ..Self::default()
        }
    }
}

/// Fetch presence for a batch of people. Best-effort by design: an mri the
/// service does not answer for is simply absent from the result.
pub async fn fetch_presence(
    http: &reqwest::Client,
    session: &Session,
    profile_token: &str,
    mris: &[String],
) -> Result<Vec<Presence>> {
    if mris.is_empty() {
        return Ok(Vec::new());
    }
    anyhow::ensure!(mris.len() <= MAX_BATCH, "too many mris in one presence request");
    anyhow::ensure!(
        mris.iter().all(|m| is_person_mri(m)),
        "refusing to fetch presence for a non-person mri"
    );

    let host = session
        .endpoint(PRESENCE_HOST_KEY)
        .filter(|h| h.starts_with("https://"))
        .unwrap_or(PRESENCE_HOST_FALLBACK)
        .trim_end_matches('/');
    let url = format!("{host}/v1/presence/getpresence/");
    let body = json!(mris.iter().map(|m| json!({ "mri": m })).collect::<Vec<_>>());

    let resp = http
        .post(&url)
        .bearer_auth(profile_token)
        .header("x-skypetoken", &session.skypetoken)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .context("getpresence request")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("getpresence -> {status}");
    }
    let v: Value = serde_json::from_str(&resp.text().await?).context("parse getpresence")?;
    Ok(parse_presence(&v))
}

/// Extract the presences from the response array. An entry without an mri or
/// without a `presence` object is dropped; a person the service reports as
/// unknown is kept (as "PresenceUnknown") so the caller can tell "we asked and
/// nobody knows" from "we never asked".
fn parse_presence(v: &Value) -> Vec<Presence> {
    let mut out = Vec::new();
    for item in v.as_array().into_iter().flatten() {
        let Some(mri) = item.get("mri").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(p) = item.get("presence") else { continue };
        let text = |v: Option<&Value>| {
            v.and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or_default()
                .to_string()
        };
        let calendar = p.get("calendarData");
        out.push(Presence {
            mri: mri.to_string(),
            availability: text(p.get("availability")),
            activity: text(p.get("activity")),
            last_active_ms: p
                .get("lastActiveTime")
                .and_then(|x| x.as_str())
                .map(crate::teams_read::parse_iso_ms)
                .unwrap_or(0),
            out_of_office: calendar
                .and_then(|c| c.get("isOutOfOffice"))
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            out_of_office_note: text(
                calendar
                    .and_then(|c| c.get("outOfOfficeNote"))
                    .and_then(|n| n.get("message")),
            ),
            note: text(p.get("note").and_then(|n| n.get("message"))),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_live_response() {
        // Captured from the tenant: one person offline with an out-of-office note,
        // one available in a meeting with a custom status.
        let v = json!([
            {
                "etag": "A0207169355",
                "mri": "8:orgid:bea5de00",
                "presence": {
                    "activity": "Offline",
                    "availability": "Offline",
                    "calendarData": {
                        "isOutOfOffice": true,
                        "outOfOfficeNote": { "message": "OOO", "publishTime": "2026-07-25T17:03:37Z" }
                    },
                    "lastActiveTime": "2026-07-24T07:37:52.604Z",
                    "note": { "message": "", "publishTime": "2026-06-22T09:04:40Z" },
                    "sourceNetwork": "SameEnterprise"
                },
                "status": 20000
            },
            {
                "mri": "8:orgid:aaa",
                "presence": {
                    "activity": "InAMeeting",
                    "availability": "Busy",
                    "calendarData": { "isOutOfOffice": false },
                    "note": { "message": "Focusing" }
                },
                "status": 20000
            }
        ]);
        let list = parse_presence(&v);
        assert_eq!(list.len(), 2);
        assert_eq!(
            list[0],
            Presence {
                mri: "8:orgid:bea5de00".into(),
                availability: "Offline".into(),
                activity: "Offline".into(),
                last_active_ms: crate::teams_read::parse_iso_ms("2026-07-24T07:37:52.604Z"),
                out_of_office: true,
                out_of_office_note: "OOO".into(),
                note: String::new(),
            }
        );
        assert_eq!(list[1].availability, "Busy");
        assert_eq!(list[1].activity, "InAMeeting");
        assert_eq!(list[1].note, "Focusing");
        assert_eq!(list[1].last_active_ms, 0, "no lastActiveTime -> 0");
        assert!(!list[1].out_of_office);
    }

    #[test]
    fn keeps_an_unknown_presence_and_drops_malformed_entries() {
        let v = json!([
            { "mri": "8:orgid:unknown", "presence": { "availability": "PresenceUnknown", "activity": "PresenceUnknown", "sourceNetwork": "Unknown" } },
            { "mri": "8:orgid:no-presence" },
            { "presence": { "availability": "Available" } }
        ]);
        let list = parse_presence(&v);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].availability, "PresenceUnknown");
    }

    #[test]
    fn empty_or_unexpected_shapes_are_empty() {
        assert!(parse_presence(&json!([])).is_empty());
        assert!(parse_presence(&json!({})).is_empty());
        assert!(parse_presence(&Value::Null).is_empty());
    }

    #[test]
    fn unknown_is_a_usable_placeholder() {
        let p = Presence::unknown("8:orgid:x");
        assert_eq!(p.availability, "PresenceUnknown");
        assert_eq!(p.last_active_ms, 0);
    }
}
