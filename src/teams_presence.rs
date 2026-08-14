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
//
// ---------------------------------------------------------------------------
// AND IT KEEPS HOURS ([`AvailableHours`])
//
// A plain switch published Available at 03:00 as eagerly as at 11:00, which is a green
// dot with nobody human behind it — the one thing a status somebody reads to decide
// whether to write must not be. So the setting carries a WINDOW ("08:00-19:00") and the
// ZONE it is kept in ("Europe/Paris"), the heartbeat registers only inside it and
// withdraws once at its end, and the status outside it is whatever Teams computes on its
// own — exactly as with the setting off.
//
// The zone is the user's and not the machine's, because the PERSON travels while the
// always-on service stays in one flat: 08:00 set in Paris is not 08:00 read from Tokyo
// (see [`minute_of_day`]). Its absence is the machine's own zone, which is what an install
// that never set one keeps.
//
// The window is OPTIONAL, and its absence is all day: that is what the setting did
// before it grew one, so an install that never sets hours behaves as it always did.
// [`should_publish`] is the one spelling of "should this machine be green right now",
// read by the RPC, by the heartbeat and by the settings answer alike.

use anyhow::{Context, Result};
use chrono::Timelike;
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

/// Minutes in a day, which is the range every minute-of-day below lives in.
const MINUTES_PER_DAY: u32 = 24 * 60;

/// The hours "Always available" keeps the user green, as minutes since local midnight.
///
/// The END IS EXCLUSIVE, because that is what the two numbers read as: 08:00-19:00 is
/// green through 18:59 and hands the status back at 19:00.
///
/// A window whose end is BEFORE its start WRAPS past midnight — 22:00-06:00 is a night
/// shift, and refusing it would be an arbitrary limit on the same comparison inverted.
/// `from == to` is the one pair refused: it reads equally as "never" and as "all day",
/// and one character deciding between those is a setting nobody can check. All day is
/// the ABSENCE of a window (see [`AvailableHours::parse_setting`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AvailableHours {
    /// Minutes since local midnight, inclusive.
    pub from: u32,
    /// Minutes since local midnight, exclusive.
    pub to: u32,
}

impl AvailableHours {
    /// The window a caller asked for, as two `HH:MM` strings. Validating, because this
    /// is what an RPC's params reach: an hour this function will not build can never be
    /// stored, so every later read of the setting is a window or nothing.
    pub fn parse_pair(from: &str, to: &str) -> Result<Self> {
        let from = parse_hhmm(from).with_context(|| format!("`from` is not an HH:MM time: {from}"))?;
        let to = parse_hhmm(to).with_context(|| format!("`to` is not an HH:MM time: {to}"))?;
        anyhow::ensure!(
            from != to,
            "the two hours must differ: leave them out for all day, and an end before its \
             start is a window that crosses midnight"
        );
        Ok(Self { from, to })
    }

    /// The window as it is stored, and as `parse_setting` reads it back.
    pub fn as_setting(&self) -> String {
        format!("{}-{}", format_hhmm(self.from), format_hhmm(self.to))
    }

    /// The stored window, or `None` for all day.
    ///
    /// A value this cannot parse reads as all day rather than as an error, so there is ONE
    /// answer to "what are the hours" for the settings the UI draws and for the heartbeat
    /// that acts on them. Only a write outside [`AvailableHours::parse_pair`] can produce
    /// one, and a disagreement between those two readers would be a switch that says one
    /// thing while the machine does another.
    pub fn parse_setting(text: &str) -> Option<Self> {
        let (from, to) = text.trim().split_once('-')?;
        Self::parse_pair(from, to).ok()
    }

    /// Does the window cover this minute of the local day?
    pub fn covers(&self, minute_of_day: u32) -> bool {
        if self.from <= self.to {
            minute_of_day >= self.from && minute_of_day < self.to
        } else {
            // Wraps past midnight: green from the start of the evening to the end of the
            // morning, and nothing in the daylight between them.
            minute_of_day >= self.from || minute_of_day < self.to
        }
    }
}

/// `HH:MM` -> minutes since midnight. Strict on purpose: this is what decides whether a
/// window can be stored at all, and a lenient parse of an hour is a status published at
/// an hour nobody chose.
fn parse_hhmm(text: &str) -> Option<u32> {
    let (h, m) = text.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Minutes since midnight -> `HH:MM`, the spelling `parse_hhmm` reads and the one an
/// `<input type="time">` takes.
pub fn format_hhmm(minute_of_day: u32) -> String {
    let minute_of_day = minute_of_day % MINUTES_PER_DAY;
    format!("{:02}:{:02}", minute_of_day / 60, minute_of_day % 60)
}

/// Whether this machine should be publishing an Available endpoint at `minute_of_day`:
/// the switch, narrowed by the window when there is one.
///
/// Pure, and the ONE spelling of the question — the RPC, the heartbeat and the settings
/// answer all read it, because two answers to "am I green now?" is the bug that shows up
/// as a switch saying one thing while colleagues see another.
pub fn should_publish(enabled: bool, hours: Option<AvailableHours>, minute_of_day: u32) -> bool {
    enabled && hours.is_none_or(|window| window.covers(minute_of_day))
}

/// The minute of the day `now` falls on, in the zone the WINDOW is kept in.
///
/// Local rather than UTC because the user writes "8am to 7pm" meaning their own morning,
/// and the process that has to decide at 03:00 with every window closed is the only thing
/// here holding a clock.
///
/// `zone` is the user's own, and `None` is the MACHINE's — which is the older behaviour and
/// the right default, but not an answer this feature can rest on: the person travels and the
/// machine they run this on does not. Somebody who set 08:00-19:00 in Paris and is reading
/// this from Tokyo wants their green dot in Tokyo's morning, and the always-on service is
/// still in a flat in Paris. So the zone is a SETTING, resolved from the IANA database with
/// its DST rules rather than from an offset stored beside the window — an offset is an hour
/// wrong for half the year, and an hour is exactly the size of the mistake this whole
/// feature exists to avoid.
pub fn minute_of_day(now: chrono::DateTime<chrono::Utc>, zone: Option<chrono_tz::Tz>) -> u32 {
    match zone {
        Some(zone) => {
            let there = now.with_timezone(&zone);
            there.hour() * 60 + there.minute()
        }
        None => {
            let here = now.with_timezone(&chrono::Local);
            here.hour() * 60 + here.minute()
        }
    }
}

/// The zone an `available_zone` setting names, or `None` for the machine's own.
///
/// Strict, and for the reason [`AvailableHours::parse_pair`] is: a name this refuses is
/// never stored, so every later read of that row is a zone or the machine's. A stored name
/// the database no longer knows (a zone renamed between chrono-tz releases) reads as the
/// machine's rather than as an error — the same direction `AvailableHours::parse_setting`
/// fails in, because the alternative is a setting pane that cannot draw itself.
pub fn parse_zone(name: &str) -> Option<chrono_tz::Tz> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    name.parse::<chrono_tz::Tz>().ok()
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

    #[test]
    fn an_hour_is_read_strictly_and_written_back_the_same_way() {
        assert_eq!(parse_hhmm("08:00"), Some(8 * 60));
        assert_eq!(parse_hhmm("00:00"), Some(0));
        assert_eq!(parse_hhmm("23:59"), Some(23 * 60 + 59));
        assert_eq!(parse_hhmm(" 19:30 "), Some(19 * 60 + 30));
        for bad in ["", "8", "8:00pm", "24:00", "12:60", "-1:00", "12:0a", "12"] {
            assert_eq!(parse_hhmm(bad), None, "{bad:?} is not an hour");
        }
        for minute in [0, 8 * 60, 19 * 60 + 5, 23 * 60 + 59] {
            assert_eq!(parse_hhmm(&format_hhmm(minute)), Some(minute));
        }
    }

    #[test]
    fn a_window_covers_its_start_and_stops_at_its_end() {
        let hours = AvailableHours::parse_pair("08:00", "19:00").unwrap();
        assert!(!hours.covers(7 * 60 + 59));
        assert!(hours.covers(8 * 60), "the start is inside the window");
        assert!(hours.covers(18 * 60 + 59));
        assert!(!hours.covers(19 * 60), "the end is not: 19:00 hands the status back");
        assert!(!hours.covers(3 * 60), "03:00 is the hour this whole window exists for");
    }

    #[test]
    fn a_window_whose_end_is_before_its_start_crosses_midnight() {
        let night = AvailableHours::parse_pair("22:00", "06:00").unwrap();
        assert!(night.covers(23 * 60));
        assert!(night.covers(0), "midnight is inside a night shift");
        assert!(night.covers(5 * 60 + 59));
        assert!(!night.covers(6 * 60));
        assert!(!night.covers(12 * 60), "the daylight between the ends is outside it");
    }

    #[test]
    fn two_equal_hours_are_refused_because_they_read_both_ways() {
        // "never" and "all day" are both plausible readings of 09:00-09:00, so the caller
        // has to say which: all day is the absence of a window.
        let err = AvailableHours::parse_pair("09:00", "09:00").unwrap_err().to_string();
        assert!(err.contains("must differ"), "{err}");
        assert!(AvailableHours::parse_pair("09:00", "9am").is_err());
        assert!(AvailableHours::parse_pair("", "19:00").is_err());
    }

    #[test]
    fn a_stored_window_round_trips_and_anything_else_reads_as_all_day() {
        let hours = AvailableHours::parse_pair("08:00", "19:00").unwrap();
        assert_eq!(hours.as_setting(), "08:00-19:00");
        assert_eq!(AvailableHours::parse_setting("08:00-19:00"), Some(hours));
        // Nothing stored, and nothing this module would ever have written: all day, which
        // is what the setting meant before it grew hours.
        for all_day in ["", "   ", "08:00", "08:00-", "yes", "08:00-08:00", "08:00-25:00"] {
            assert_eq!(
                AvailableHours::parse_setting(all_day),
                None,
                "{all_day:?} must read as all day"
            );
        }
    }

    #[test]
    fn the_switch_decides_first_and_the_window_only_narrows_it() {
        let hours = AvailableHours::parse_pair("08:00", "19:00").unwrap();
        // Off is off, whatever the hours say — the switch is the consent.
        assert!(!should_publish(false, None, 12 * 60));
        assert!(!should_publish(false, Some(hours), 12 * 60));
        // On with no window is all day, which is what this setting always did.
        for minute in [0, 3 * 60, 12 * 60, 23 * 60 + 59] {
            assert!(should_publish(true, None, minute));
        }
        assert!(should_publish(true, Some(hours), 12 * 60));
        assert!(!should_publish(true, Some(hours), 3 * 60));
    }

    #[test]
    fn the_minute_of_the_day_is_the_one_in_the_users_own_zone() {
        // The instant the whole setting is about: the middle of a Paris night.
        let at = "2026-08-14T01:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap();
        let paris = parse_zone("Europe/Paris").unwrap();
        let tokyo = parse_zone("Asia/Tokyo").unwrap();
        assert_eq!(minute_of_day(at, Some(paris)), 3 * 60, "03:00 in August (UTC+2)");
        assert_eq!(minute_of_day(at, Some(tokyo)), 10 * 60);
        assert_eq!(minute_of_day(at, parse_zone("UTC")), 60);

        // So one window answers differently in two places, which is the whole feature: the
        // person travels and the machine they run this on does not.
        let hours = AvailableHours::parse_pair("08:00", "19:00").unwrap();
        assert!(!should_publish(true, Some(hours), minute_of_day(at, Some(paris))));
        assert!(should_publish(true, Some(hours), minute_of_day(at, Some(tokyo))));

        // No zone is the machine's own, which is the older behaviour.
        assert!(minute_of_day(at, None) < MINUTES_PER_DAY);
    }

    #[test]
    fn the_zone_reads_the_iana_database_and_refuses_anything_else() {
        assert_eq!(parse_zone("Europe/Paris").map(|z| z.name()), Some("Europe/Paris"));
        assert_eq!(parse_zone("  Asia/Tokyo  ").map(|z| z.name()), Some("Asia/Tokyo"));
        // Nothing, and nothing this app would have written, is the machine's own zone.
        for machine in ["", "   "] {
            assert!(parse_zone(machine).is_none());
        }
        // A typo, an offset and a Windows label are all refused: a zone answered with this
        // machine's would publish somebody's status at hours nobody chose.
        for bad in ["Europe/Pariss", "+02:00", "CEST", "Romance Standard Time", "paris"] {
            assert!(parse_zone(bad).is_none(), "{bad:?} is not an IANA zone");
        }
    }

    #[test]
    fn a_zone_keeps_its_hours_across_a_dst_change() {
        // The reason this is a zone NAME and not an offset: Paris is UTC+2 in August and
        // UTC+1 in December, so a stored offset would publish 08:00-19:00 as 07:00-18:00 for
        // half the year — an hour wrong, which is the mistake the window exists to avoid.
        let paris = parse_zone("Europe/Paris").unwrap();
        let summer = "2026-08-14T06:30:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap();
        let winter = "2026-12-14T07:30:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap();
        assert_eq!(minute_of_day(summer, Some(paris)), 8 * 60 + 30);
        assert_eq!(minute_of_day(winter, Some(paris)), 8 * 60 + 30);
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
