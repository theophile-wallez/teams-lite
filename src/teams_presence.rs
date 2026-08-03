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
// Reading is the bulk of this module. It also holds the ONE write the app makes to
// this service — the "Always available" setting (see below) — and nothing else:
// everything about other people is read exactly as hovering a name in Teams does.
// (Microsoft Graph `/presence` is not usable here: the broker token has no
// Presence.Read consent and answers 403.)
//
// ---------------------------------------------------------------------------
// PUBLISHING OUR OWN PRESENCE ("Always available")
//
// Proven shape (recon against the live tenant, read back through `fetch_presence`
// after every step):
//   PUT {unifiedPresence}/v1/me/endpoints/
//     Auth: Bearer {PRESENCE_SCOPE token} + x-skypetoken. The profile-audience
//       token that reads presence is REFUSED here (401, substatus 40102).
//     Body: { "id": "<uuid>", "availability": "Available",
//             "activity": "Available", "deviceType": "Web" }
//     -> 201 Created, and our presence goes Offline -> Available.
//   DELETE {unifiedPresence}/v1/me/endpoints/{id}
//     -> 200 OK, and our presence goes back to what Teams computes (Offline when no
//        other client of ours is running).
//
// WHY AN ENDPOINT, AND NOT THE MANUAL STATUS. The service also takes
// `PUT /v1/me/forceavailability/ {"availability":"Available"}` — the manual status a
// Teams client sets when the user picks one by hand — and it answers 200. It is NOT
// used here, because every spelling of the matching DELETE is refused (401), so this
// app could set that state and never take it back. A setting whose off switch cannot
// undo its on switch is not a setting. The endpoint registration is symmetric, which
// is the whole reason it is the mechanism.
//
// WHAT THE ENDPOINT MEANS. An endpoint is one running client of ours reporting that
// it is there. The service accepts NO other availability on it (`Away`, `Busy` and
// `DoNotDisturb` are all 400), and `deviceType` is required — so a registration says
// exactly one thing: "this device is present and available". Teams then aggregates
// our endpoints, which is why one always-on registration keeps us green.
//
// IT IS THE USER'S OWN STATUS, AND OUTWARD. Every colleague sees the green dot, so
// the RPC that turns it on is in `OUTWARD_METHODS`, it is off by default, and a
// read-only backend never registers anything.

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::teams::Session;
use crate::teams_profiles::is_person_mri;

/// regionGtms key holding the presence service base URL, with a fixed fallback
/// for a session whose directory omits it.
const PRESENCE_HOST_KEY: &str = "unifiedPresence";
const PRESENCE_HOST_FALLBACK: &str = "https://presence.teams.microsoft.com";

/// The broker scope whose token the presence service accepts on its own `/v1/me/*`
/// writes. The profile-audience token that READS presence is refused there, so the
/// publish path has its own credential.
pub const PRESENCE_SCOPE: &str = "https://presence.teams.microsoft.com/.default";

/// The only availability an endpoint registration may report (the service answers
/// 400 to every other member of its enum) and the required device label.
const ENDPOINT_AVAILABILITY: &str = "Available";
const ENDPOINT_DEVICE_TYPE: &str = "Web";

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

    let url = format!("{}/v1/presence/getpresence/", presence_host(session));
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

/// The presence service's base URL for this session: the directory's own entry when
/// it looks usable, else the fixed fallback. Never a host derived from anything a
/// caller passed in — the skypetoken travels on every request below.
fn presence_host(session: &Session) -> &str {
    session
        .endpoint(PRESENCE_HOST_KEY)
        .filter(|h| h.starts_with("https://"))
        .unwrap_or(PRESENCE_HOST_FALLBACK)
        .trim_end_matches('/')
}

/// The body of an endpoint registration. Pure, so the one shape the tenant accepts
/// is pinned by a test rather than by a live call.
fn endpoint_body(endpoint_id: &str) -> Value {
    json!({
        "id": endpoint_id,
        "availability": ENDPOINT_AVAILABILITY,
        "activity": ENDPOINT_AVAILABILITY,
        "deviceType": ENDPOINT_DEVICE_TYPE,
    })
}

/// Register (or refresh) `endpoint_id` as an endpoint of ours reporting Available,
/// which is what makes our own presence green for everybody who can see us.
///
/// OUTWARD: this publishes the user's own status. Callers must have the user's
/// consent — the "Always available" setting, off by default — and a read-only backend
/// must never reach this function.
///
/// Idempotent on the id: the same id re-registered is the same endpoint refreshed, so
/// the heartbeat that keeps us green never accumulates endpoints, and two backends
/// sharing one store refresh one registration rather than two.
pub async fn register_available_endpoint(
    http: &reqwest::Client,
    session: &Session,
    presence_token: &str,
    endpoint_id: &str,
) -> Result<()> {
    anyhow::ensure!(!endpoint_id.is_empty(), "an endpoint registration needs an id");
    let url = format!("{}/v1/me/endpoints/", presence_host(session));
    let resp = http
        .put(&url)
        .bearer_auth(presence_token)
        .header("x-skypetoken", &session.skypetoken)
        .header("content-type", "application/json")
        .body(endpoint_body(endpoint_id).to_string())
        .send()
        .await
        .context("register presence endpoint")?;
    let status = resp.status();
    anyhow::ensure!(status.is_success(), "register presence endpoint -> {status}");
    Ok(())
}

/// Remove our endpoint registration, so Teams computes our presence again exactly as
/// it did before it existed. The undo half of [`register_available_endpoint`], and the
/// reason that function is the mechanism this app uses.
pub async fn remove_endpoint(
    http: &reqwest::Client,
    session: &Session,
    presence_token: &str,
    endpoint_id: &str,
) -> Result<()> {
    anyhow::ensure!(!endpoint_id.is_empty(), "an endpoint removal needs an id");
    let url = format!("{}/v1/me/endpoints/{endpoint_id}", presence_host(session));
    let resp = http
        .delete(&url)
        .bearer_auth(presence_token)
        .header("x-skypetoken", &session.skypetoken)
        .send()
        .await
        .context("remove presence endpoint")?;
    let status = resp.status();
    // A registration the service no longer knows about is already in the state the
    // caller asked for, so 404 is success — otherwise turning the setting off could
    // fail forever on an endpoint that expired on its own.
    anyhow::ensure!(
        status.is_success() || status == reqwest::StatusCode::NOT_FOUND,
        "remove presence endpoint -> {status}"
    );
    Ok(())
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

    #[test]
    fn an_endpoint_registration_carries_the_one_body_the_service_accepts() {
        // Pinned against the live tenant: `deviceType` is required (its absence is a
        // 400), and `Available` is the only availability an endpoint may report
        // (`Away`, `Busy` and `DoNotDisturb` are all 400).
        let body = endpoint_body("39e52755-ca79-44ae-92d1-8db72a50e7f4");
        assert_eq!(body["id"], "39e52755-ca79-44ae-92d1-8db72a50e7f4");
        assert_eq!(body["availability"], "Available");
        assert_eq!(body["activity"], "Available");
        assert_eq!(body["deviceType"], "Web");
    }

    /// The code of one module, without its test module and without comments — so a
    /// doc block may keep explaining what the code may not do. Same shape as the
    /// scans that keep `mail` and `calendar` read-only.
    fn code_only(source: &str) -> String {
        source
            .split("#[cfg(test)]")
            .next()
            .unwrap_or(source)
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The manual-status endpoint (`/v1/me/forceavailability/`) must stay out of the
    /// crate's CODE: the service accepts that write and refuses every matching
    /// DELETE, so an app that set it could never take it back. The endpoint
    /// registration — which is symmetric — is the mechanism, and this test is what
    /// keeps a later change from quietly reaching for the one-way one.
    #[test]
    fn no_code_names_the_one_way_manual_status_write() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(std::path::Path::new("src"), &mut files);
        assert!(files.len() > 5, "no Rust sources found to scan");
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            assert!(
                !code_only(&source).contains("forceavailability"),
                "{} names the manual-status write. This app could set it and never take it \
                 back — every DELETE the service offers is refused — so the reversible \
                 endpoint registration is the only mechanism allowed here.",
                file.display()
            );
        }
    }

    /// Which HTTP verbs this module issues, and no more. The read path POSTs to
    /// getpresence; the setting PUTs one endpoint registration and DELETEs it again.
    /// A fourth verb here is a new outward action, and it needs its own consent gate
    /// rather than a quiet addition to this file.
    #[test]
    fn this_module_issues_exactly_three_requests() {
        let code = code_only(include_str!("teams_presence.rs"));
        for (verb, expected) in [(".post(", 1), (".put(", 1), (".delete(", 1)] {
            assert_eq!(code.matches(verb).count(), expected, "the `{verb}` count changed");
        }
        for verb in [".patch(", ".request("] {
            assert!(!code.contains(verb), "`{verb}` is a new outward action, and needs a gate");
        }
    }
}
