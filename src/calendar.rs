// The Teams/Outlook calendar, read-only, over Microsoft Graph.
//
// The same broker/PRT identity that backs Teams and the mailbox also carries the
// calendar: the Office FOCI client id holds the consent already, so no new app
// registration, consent or auth flow is involved (see `auth`). Verified against the
// real tenant with `examples/calendar_recon.rs` — six calendars, `/me/calendarView`
// answering with recurrence already expanded, Teams join URLs present on 47 of 50
// meetings in a five-week window.
//
// READ-ONLY BY CONSTRUCTION, exactly like `mail`. This module issues GET requests
// and nothing else. There is no create, update, delete, accept, decline, tentative,
// cancel or forward path anywhere in it — not "not exposed yet", but absent, so no
// caller can reach one. That discipline is not optional for a calendar: creating an
// event mails an invitation to every attendee, and responding to one mails the
// organizer. Both are irreversible actions performed as the user, in the same class
// as a Teams message posted to a colleague. Two tests at the bottom of this file
// enforce the property mechanically: one asserts this module contains no non-GET
// verb, the other that the crate names none of Graph's calendar-write endpoints. If
// responding to invitations is ever wanted it is a deliberate feature with its own
// consent gate and its own entry in `OUTWARD_METHODS` — never a quiet addition here.
//
// Shape of the sync, and why:
//   - `/me/calendars/{id}/calendarView` — NOT `/events`. The view endpoint expands
//     recurrence server-side, so a weekly stand-up arrives as one row per
//     occurrence (`type: "occurrence"`, plus `"exception"` for a moved one). Asking
//     for `/events` instead would mean re-implementing RFC 5545 expansion, time zone
//     and DST rules included, to render a week grid.
//   - `Prefer: outlook.timezone="UTC"`. Without it Graph answers in the mailbox's
//     own zone, and `/me/mailboxSettings` is 403 on this tenant so we could not even
//     find out which zone that was. Everything is stored in UTC and rendered in the
//     browser's local zone.
//   - The sync unit is a CALENDAR-MONTH, not the exact window the user is looking
//     at. A week view straddling two months would otherwise be a cache miss forever;
//     with whole months, "have I synced this?" is one key lookup per month, and the
//     months a range needs are pure arithmetic ([`months_covering`]). Re-reading a
//     whole month also lets the store notice events DELETED in real Outlook
//     (`Store::prune_calendar_window`), which asking only for "what changed" would
//     not.
//   - Paging follows `@odata.nextLink` — a busy month exceeds any one page.
//
// Timestamps are normalized to `YYYY-MM-DDTHH:MM:SSZ` by `graph_time`, so range
// queries and ordering are plain string comparisons in SQLite and no date
// arithmetic exists on the Rust side. All-day events are the one subtlety: Graph
// gives them midnight-to-midnight UTC markers with an EXCLUSIVE end, and they must
// be placed on those calendar dates rather than converted to a local instant — the
// front-end does that from the date part alone.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::graph_time::normalize_timestamp;

/// Graph host every request targets. The bearer token is only ever sent here.
const GRAPH_HOST: &str = "graph.microsoft.com";

/// Broker scope for the calendar. Deliberately the SAME scope string mail and the
/// SharePoint/OneDrive media path already use, so all three share one entry in the
/// process-wide token cache and one refresh (see `auth::TokenCache`).
pub const CALENDAR_SCOPE: &str = crate::teams_media::GRAPH_SCOPE;

/// Events per `calendarView` page. Graph caps `$top` well above this; the value is
/// chosen so an ordinary month is one round-trip.
const VIEW_PAGE_SIZE: u32 = 100;

/// Hard cap on `@odata.nextLink` hops for one window. A month with more events than
/// this is truncated rather than paged forever — and the caller is TOLD
/// ([`CalendarView::truncated`]) instead of being handed a silently short list.
const MAX_VIEW_PAGES: usize = 12;

/// How many attendees are kept per event.
///
/// Real invitations are enormous: the recon spike found a single meeting with 170
/// attendees, and storing every one for every occurrence of every recurring meeting
/// would dwarf the rest of the row. The UI shows a handful and a count, so that is
/// what is stored — with [`CalendarEvent::attendee_count`] preserving the truth
/// about how many there really are.
pub const MAX_ATTENDEES: usize = 20;

/// Event fields the calendar needs. `body` is deliberately ABSENT: an event body is
/// a full HTML mail (the meeting invitation), and no view here renders one.
/// `bodyPreview` gives the plain first lines, which is what a details panel shows.
const EVENT_SELECT: &str = "id,subject,bodyPreview,start,end,isAllDay,isCancelled,isOrganizer,\
                            showAs,sensitivity,importance,type,recurrence,location,organizer,\
                            attendees,onlineMeeting,isOnlineMeeting,webLink,categories,\
                            responseStatus,hasAttachments,reminderMinutesBeforeStart";

/// One of the mailbox's calendars, as the sidebar lists them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Calendar {
    pub id: String,
    pub name: String,
    /// Outlook's own colour for the calendar as `#rrggbb`, or empty when it uses
    /// the automatic colour. The UI falls back to a palette keyed by position, so a
    /// calendar always has a stable colour either way.
    pub hex_color: String,
    /// The mailbox's primary calendar — the one Teams meetings land in, and the one
    /// shown by default.
    pub is_default: bool,
    /// Whether Outlook itself would let this calendar be edited. Recorded for
    /// display honesty only: THIS app never writes, whatever the flag says.
    pub can_edit: bool,
    /// Sort position: the default calendar first, then Graph's own order.
    pub position: i64,
}

/// A person on an event: the organizer, or one attendee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventPerson {
    pub name: String,
    pub address: String,
    /// The attendee's own answer — `accepted` | `declined` | `tentative` |
    /// `notResponded` | `none`. Empty for an organizer.
    pub response: String,
    /// `required` | `optional` | `resource`. Empty for an organizer.
    pub kind: String,
}

/// One occurrence on the calendar, as every view renders it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarEvent {
    /// Graph's occurrence id. Unique per occurrence, so a weekly meeting yields a
    /// distinct row per week — which is what makes it addressable and cacheable.
    pub id: String,
    pub calendar_id: String,
    pub subject: String,
    /// Graph's own plain-text first lines of the invitation body.
    pub preview: String,
    /// ISO 8601 UTC, whole seconds. The ordering and range key.
    pub start: String,
    /// ISO 8601 UTC, whole seconds, EXCLUSIVE — Graph's own convention, kept as-is.
    /// For an all-day event this is midnight after the last day.
    pub end: String,
    pub is_all_day: bool,
    pub is_cancelled: bool,
    pub is_organizer: bool,
    pub organizer: EventPerson,
    /// The location's display name (a room, an address, or "Microsoft Teams
    /// Meeting"). Empty when the event has none.
    pub location: String,
    /// The Teams join URL, when this is an online meeting. A link the USER clicks —
    /// nothing here ever joins anything.
    pub join_url: String,
    /// Outlook-on-the-web deep link for the event, for "Open in Outlook".
    pub web_link: String,
    /// `free` | `tentative` | `busy` | `oof` | `workingElsewhere` | `unknown`.
    pub show_as: String,
    /// The user's own answer to the invitation (see [`EventPerson::response`]), or
    /// `organizer` when they own it.
    pub response: String,
    /// `singleInstance` | `occurrence` | `exception` | `seriesMaster` — how this row
    /// relates to a recurring series.
    pub series: String,
    /// The series' recurrence pattern (`daily` | `weekly` | `absoluteMonthly` | …)
    /// when Graph sent one, else empty. Occurrences carry no pattern of their own;
    /// [`CalendarEvent::series`] is what tells the UI an event repeats.
    pub recurrence: String,
    pub importance: String,
    pub sensitivity: String,
    pub categories: Vec<String>,
    /// Up to [`MAX_ATTENDEES`] attendees.
    pub attendees: Vec<EventPerson>,
    /// How many attendees the event really has, before the cap.
    pub attendee_count: i64,
    pub has_attachments: bool,
    pub reminder_minutes: i64,
}

/// One fetched window of a calendar.
#[derive(Debug, Clone, Default)]
pub struct CalendarView {
    pub events: Vec<CalendarEvent>,
    /// True when [`MAX_VIEW_PAGES`] was reached and the window holds more events
    /// than were read. Surfaced rather than swallowed: a silently short month reads
    /// as a quiet day.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// HTTP — GET only.
// ---------------------------------------------------------------------------

/// Issue one Graph GET and parse the JSON body.
///
/// The ONLY request builder in this module, and it is a GET. Everything else goes
/// through it, which is what makes "this module cannot change the user's calendar" a
/// structural property rather than a promise (see the module doc and the tests).
///
/// `url` must already be a full `https://graph.microsoft.com/...` URL — either built
/// by [`endpoint`] or handed back by Graph as an `@odata.nextLink` — so the bearer
/// token is only ever sent to Graph.
async fn graph_get(
    http: &reqwest::Client,
    token: &str,
    url: &str,
    prefer: Option<&str>,
) -> Result<Value> {
    anyhow::ensure!(
        url.starts_with(&format!("https://{GRAPH_HOST}/")),
        "refusing to send the Graph token to a non-Graph URL"
    );
    let mut req = http.get(url).bearer_auth(token);
    if let Some(prefer) = prefer {
        req = req.header("Prefer", prefer);
    }
    let resp = req.send().await.context("graph calendar request")?;
    let status = resp.status();
    let body = resp.text().await.context("read graph calendar response")?;
    if !status.is_success() {
        // Surface Graph's own message (it names the offending property/filter), but
        // never the token or the whole payload.
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_default();
        anyhow::bail!("graph calendar -> {status} {detail}");
    }
    serde_json::from_str(&body).context("parse graph calendar response")
}

/// A `/v1.0/me/...` endpoint URL. Callers pass the already-encoded query.
fn endpoint(path: &str) -> String {
    format!("https://{GRAPH_HOST}/v1.0/me{path}")
}

/// Percent-encode one OData query-parameter value.
fn q(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

// ---------------------------------------------------------------------------
// Calendar-month arithmetic
//
// The sync unit (see the module doc). Pure string/integer work on the canonical
// timestamp shape — deliberately not a date library: the only operations needed are
// "which month is this in" and "the month after", and both are two lines that a
// test can pin exactly.
// ---------------------------------------------------------------------------

/// A calendar month, the unit a sync covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Month {
    pub year: i32,
    /// 1–12.
    pub month: u32,
}

/// Never walk more than three years of months for one request, however wide (or
/// malformed) a range a client asks for.
const MAX_MONTHS_PER_RANGE: usize = 36;

impl Month {
    /// The month an ISO timestamp (or a bare `YYYY-MM` / `YYYY-MM-DD`) falls in.
    pub fn of(timestamp: &str) -> Option<Month> {
        let raw = timestamp.trim();
        if raw.len() < 7 {
            return None;
        }
        let year: i32 = raw.get(0..4)?.parse().ok()?;
        if raw.as_bytes().get(4) != Some(&b'-') {
            return None;
        }
        let month: u32 = raw.get(5..7)?.parse().ok()?;
        if !(1..=12).contains(&month) {
            return None;
        }
        Some(Month { year, month })
    }

    /// `YYYY-MM` — the key this month is recorded under in the store.
    pub fn key(&self) -> String {
        format!("{:04}-{:02}", self.year, self.month)
    }

    /// Midnight UTC on the first of this month, in the canonical timestamp shape.
    pub fn start(&self) -> String {
        format!("{:04}-{:02}-01T00:00:00Z", self.year, self.month)
    }

    /// The following month.
    pub fn next(&self) -> Month {
        if self.month >= 12 {
            Month { year: self.year + 1, month: 1 }
        } else {
            Month { year: self.year, month: self.month + 1 }
        }
    }

    /// Midnight UTC on the first of the FOLLOWING month — this month's exclusive end.
    pub fn end(&self) -> String {
        self.next().start()
    }
}

/// Every calendar month a `[start, end)` range touches, in order.
///
/// Empty when `start` is not a parseable timestamp or the range is empty/reversed,
/// which the caller treats as "nothing to sync" rather than guessing at a window.
pub fn months_covering(start: &str, end: &str) -> Vec<Month> {
    let Some(mut month) = Month::of(start) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let mut months = Vec::new();
    // A month belongs to the range while it begins before the range ends. The first
    // month always qualifies (it contains `start`), so an inner range never yields
    // an empty list.
    while months.len() < MAX_MONTHS_PER_RANGE {
        months.push(month);
        let next = month.next();
        if next.start().as_str() >= end {
            break;
        }
        month = next;
    }
    months
}

/// Whether an event overlaps the window `[start, end)`.
///
/// THE definition of "is this event in this window", and deliberately the only one:
/// `Store::calendar_events` implements the same two clauses in SQL, and a sync's
/// pruning uses this function to decide which fetched events a month is allowed to
/// keep. If the two ever disagreed, a re-sync would delete events it had just
/// stored.
///
/// The second clause is not redundant. An event with a zero-length span — Graph does
/// emit them, and [`parse_event`] clamps a missing end to the start — has
/// `end == start` and fails `end > start_of_window` even while sitting inside it.
/// "Starts within the window" catches exactly that.
pub fn overlaps(event: &CalendarEvent, start: &str, end: &str) -> bool {
    event.start.as_str() < end
        && (event.end.as_str() > start || event.start.as_str() >= start)
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

/// The mailbox's calendars, default first then Graph's own order.
pub async fn fetch_calendars(http: &reqwest::Client, token: &str) -> Result<Vec<Calendar>> {
    let url = endpoint(
        "/calendars?$top=50&$select=id,name,hexColor,color,isDefaultCalendar,canEdit,owner",
    );
    let value = graph_get(http, token, &url, None).await?;
    let mut calendars: Vec<Calendar> = value["value"]
        .as_array()
        .map(|items| items.iter().enumerate().filter_map(parse_calendar).collect())
        .unwrap_or_default();
    anyhow::ensure!(!calendars.is_empty(), "no calendars returned");
    // The default calendar leads: it is the one Teams meetings land in, so it is
    // what the UI shows before the user has chosen anything.
    calendars.sort_by_key(|c| (!c.is_default, c.position));
    for (position, calendar) in calendars.iter_mut().enumerate() {
        calendar.position = position as i64;
    }
    Ok(calendars)
}

/// Parse one `calendar` resource. `None` when it carries no id (an error envelope,
/// or a shape we don't recognize) rather than inventing a calendar.
fn parse_calendar((index, value): (usize, &Value)) -> Option<Calendar> {
    let id = value["id"].as_str()?.to_string();
    // `hexColor` is empty for a calendar on the automatic colour, and Graph also
    // sends the enum `color` ("lightBlue", "auto"); only a real hex is useful here,
    // and the UI's own palette covers the rest.
    let hex_color = value["hexColor"]
        .as_str()
        .map(str::trim)
        .filter(|c| c.starts_with('#') && c.len() == 7)
        .unwrap_or_default()
        .to_string();
    Some(Calendar {
        id,
        name: value["name"].as_str().unwrap_or_default().trim().to_string(),
        hex_color,
        is_default: value["isDefaultCalendar"].as_bool().unwrap_or(false),
        can_edit: value["canEdit"].as_bool().unwrap_or(false),
        position: index as i64,
    })
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/// Every occurrence in one calendar between `start` (inclusive) and `end`
/// (exclusive), both canonical UTC timestamps.
///
/// Recurrence is already expanded by Graph, and `@odata.nextLink` is followed up to
/// [`MAX_VIEW_PAGES`]. Results are returned in Graph's start order.
pub async fn fetch_view(
    http: &reqwest::Client,
    token: &str,
    calendar_id: &str,
    start: &str,
    end: &str,
) -> Result<CalendarView> {
    let mut url = endpoint(&format!(
        "/calendars/{}/calendarView?startDateTime={}&endDateTime={}\
         &$select={EVENT_SELECT}&$orderby={}&$top={VIEW_PAGE_SIZE}",
        q(calendar_id),
        q(start),
        q(end),
        q("start/dateTime"),
    ));

    let mut view = CalendarView::default();
    for page in 0..MAX_VIEW_PAGES {
        // Everything is read, stored and compared in UTC — see the module doc on why
        // this header is not optional.
        let value = graph_get(http, token, &url, Some("outlook.timezone=\"UTC\"")).await?;
        view.events.extend(parse_events(&value, calendar_id));
        match value["@odata.nextLink"].as_str() {
            Some(next) if page + 1 < MAX_VIEW_PAGES => url = next.to_string(),
            // More pages exist but we have read our fill: say so.
            Some(_) => view.truncated = true,
            None => break,
        }
    }
    Ok(view)
}

/// Decode a `value` array of `event` resources, skipping anything without an id or a
/// usable start/end (which could not be placed on a grid or ordered).
pub fn parse_events(value: &Value, calendar_id: &str) -> Vec<CalendarEvent> {
    value["value"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| parse_event(item, calendar_id))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_event(value: &Value, calendar_id: &str) -> Option<CalendarEvent> {
    let id = value["id"].as_str()?.to_string();
    let start = normalize_timestamp(value["start"]["dateTime"].as_str()?);
    let end_raw = normalize_timestamp(value["end"]["dateTime"].as_str().unwrap_or_default());
    if start.is_empty() {
        return None;
    }
    // A missing or backwards end would make the event invisible to every range
    // query; clamp it to the start so the event still shows, as a point in time.
    let end = if end_raw < start { start.clone() } else { end_raw };

    let attendees_raw = value["attendees"].as_array().map(Vec::as_slice).unwrap_or_default();
    let attendees: Vec<EventPerson> = attendees_raw
        .iter()
        .filter_map(parse_attendee)
        .take(MAX_ATTENDEES)
        .collect();

    Some(CalendarEvent {
        id,
        calendar_id: calendar_id.to_string(),
        subject: value["subject"].as_str().unwrap_or_default().trim().to_string(),
        preview: collapse_whitespace(value["bodyPreview"].as_str().unwrap_or_default()),
        start,
        end,
        is_all_day: value["isAllDay"].as_bool().unwrap_or(false),
        is_cancelled: value["isCancelled"].as_bool().unwrap_or(false),
        is_organizer: value["isOrganizer"].as_bool().unwrap_or(false),
        organizer: parse_person(&value["organizer"]).unwrap_or_default(),
        location: value["location"]["displayName"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string(),
        join_url: value["onlineMeeting"]["joinUrl"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string(),
        web_link: value["webLink"].as_str().unwrap_or_default().to_string(),
        show_as: value["showAs"].as_str().unwrap_or("unknown").to_string(),
        response: value["responseStatus"]["response"]
            .as_str()
            .unwrap_or("none")
            .to_string(),
        series: value["type"].as_str().unwrap_or("singleInstance").to_string(),
        recurrence: value["recurrence"]["pattern"]["type"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        importance: value["importance"].as_str().unwrap_or("normal").to_string(),
        sensitivity: value["sensitivity"].as_str().unwrap_or("normal").to_string(),
        categories: value["categories"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|c| c.as_str())
                    .map(|c| c.trim().to_string())
                    .filter(|c| !c.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        attendees,
        attendee_count: attendees_raw.len() as i64,
        has_attachments: value["hasAttachments"].as_bool().unwrap_or(false),
        reminder_minutes: value["reminderMinutesBeforeStart"].as_i64().unwrap_or(-1),
    })
}

impl Default for EventPerson {
    fn default() -> Self {
        EventPerson {
            name: String::new(),
            address: String::new(),
            response: String::new(),
            kind: String::new(),
        }
    }
}

/// Graph wraps a person as `{ "emailAddress": { "name", "address" } }`. `None` when
/// neither field is present, so an absent organizer stays absent instead of becoming
/// an empty person.
fn parse_person(value: &Value) -> Option<EventPerson> {
    let inner = value.get("emailAddress").unwrap_or(value);
    let name = inner["name"].as_str().unwrap_or_default().trim().to_string();
    let address = inner["address"].as_str().unwrap_or_default().trim().to_string();
    if name.is_empty() && address.is_empty() {
        return None;
    }
    Some(EventPerson {
        name,
        address,
        response: String::new(),
        kind: String::new(),
    })
}

/// One attendee: a person plus their answer and whether they are required.
fn parse_attendee(value: &Value) -> Option<EventPerson> {
    let mut person = parse_person(value)?;
    person.response = value["status"]["response"]
        .as_str()
        .unwrap_or("none")
        .to_string();
    person.kind = value["type"].as_str().unwrap_or("required").to_string();
    Some(person)
}

/// Collapse runs of whitespace (including the newlines Graph's `bodyPreview`
/// carries) into single spaces, so a preview is one clean line.
fn collapse_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Persistence
//
// The calendar is local-first exactly like chat and mail: a fetch writes through to
// SQLite and the UI is served from there, so re-opening a month costs no network.
// These helpers own the mapping between the Graph shapes above and the store's rows,
// keeping that translation out of the request handlers (mirrors
// `mail::persist_headers`).
// ---------------------------------------------------------------------------

/// Serialize a person list the way the store holds it (and the UI reads it).
pub fn people_json(people: &[EventPerson]) -> String {
    Value::Array(
        people
            .iter()
            .map(|p| {
                serde_json::json!({
                    "name": p.name,
                    "address": p.address,
                    "response": p.response,
                    "kind": p.kind,
                })
            })
            .collect(),
    )
    .to_string()
}

/// Serialize a category list the way the store holds it.
fn categories_json(categories: &[String]) -> String {
    Value::Array(categories.iter().map(|c| Value::String(c.clone())).collect()).to_string()
}

/// Persist a calendar list, returning true when any calendar's metadata moved (so
/// the caller emits `calendars_changed` only on a real change).
pub fn persist_calendars(store: &crate::store::Store, calendars: &[Calendar]) -> Result<bool> {
    store.transaction(|| {
        let mut changed = false;
        for calendar in calendars {
            changed |= store.upsert_calendar(&crate::store::CalendarUpdate {
                id: &calendar.id,
                name: &calendar.name,
                hex_color: &calendar.hex_color,
                is_default: calendar.is_default,
                can_edit: calendar.can_edit,
                position: calendar.position,
            })?;
        }
        Ok(changed)
    })
}

/// Persist a window of events, returning how many rows actually changed.
///
/// One transaction for the whole window: the store's batching is what keeps a busy
/// month a single commit instead of a hundred (see `Store::transaction`).
pub fn persist_events(store: &crate::store::Store, events: &[CalendarEvent]) -> Result<usize> {
    store.transaction(|| {
        let mut changed = 0;
        for event in events {
            let organizer = &event.organizer;
            let attendees = people_json(&event.attendees);
            let categories = categories_json(&event.categories);
            if store.upsert_calendar_event(&crate::store::CalendarEventUpdate {
                id: &event.id,
                calendar_id: &event.calendar_id,
                subject: &event.subject,
                preview: &event.preview,
                start_utc: &event.start,
                end_utc: &event.end,
                is_all_day: event.is_all_day,
                is_cancelled: event.is_cancelled,
                is_organizer: event.is_organizer,
                organizer_name: &organizer.name,
                organizer_address: &organizer.address,
                location: &event.location,
                join_url: &event.join_url,
                web_link: &event.web_link,
                show_as: &event.show_as,
                response: &event.response,
                series: &event.series,
                recurrence: &event.recurrence,
                importance: &event.importance,
                sensitivity: &event.sensitivity,
                categories: &categories,
                attendees: &attendees,
                attendee_count: event.attendee_count,
                has_attachments: event.has_attachments,
                reminder_minutes: event.reminder_minutes,
            })? {
                changed += 1;
            }
        }
        Ok(changed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Strip `//` line comments so a source-scanning guardrail inspects CODE, not
    /// the prose that explains it (this file's own module doc necessarily names the
    /// endpoints it forbids). A `//` preceded by `:` is left alone so the `https://`
    /// inside a string literal survives — otherwise everything after a URL on the
    /// same line would look like a comment, and a forbidden token hiding after one
    /// would slip through.
    ///
    /// Same helper as `mail::tests::strip_line_comments`, deliberately duplicated:
    /// each guardrail test stays readable and self-contained in the module it
    /// guards, and neither can be weakened by an edit to the other.
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| {
                let bytes = line.as_bytes();
                let mut cut = line.len();
                for i in 0..bytes.len().saturating_sub(1) {
                    if bytes[i] == b'/' && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
                        cut = i;
                        break;
                    }
                }
                &line[..cut]
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// THE no-write guarantee, enforced on this module's own source: every request
    /// goes through `graph_get`, and no other HTTP verb appears anywhere in the
    /// file. A future edit that adds a `.post(...)` — creating an event, accepting
    /// an invitation — fails this test instead of quietly gaining the ability to
    /// mail every attendee of a meeting as the user.
    #[test]
    fn module_issues_only_get_requests() {
        let source = include_str!("calendar.rs");
        // Skip this test module, whose own body necessarily names the forbidden
        // verbs, then strip comments so the doc block above does not match either.
        let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(source));
        assert!(code.contains("async fn graph_get"), "scanned the wrong text");
        for verb in [".post(", ".put(", ".patch(", ".delete(", ".request("] {
            assert!(
                !code.contains(verb),
                "src/calendar.rs must issue GET requests only, found `{verb}`. The calendar is \
                 read-only by construction: creating an event mails an invitation to every \
                 attendee and responding to one mails the organizer, so a write path here is a \
                 deliberate feature that needs its own consent gate."
            );
        }
    }

    /// True when `code` names `endpoint` as a whole path segment.
    ///
    /// A Graph action is the LAST segment of a URL (`…/events/{id}/accept`), so the
    /// name is always followed by a quote, a brace or the end of the string — never
    /// by another letter. Requiring that is what keeps the scan precise instead of
    /// merely long: `/accept` must still fire on the real call, and must not fire on
    /// the native-calling callback path `/call/acceptance/`, which reaches the Teams
    /// calling service and no calendar (see `src/calling.rs`). Same reasoning as the
    /// leading slash above — `tentativelyAccepted` is a value we read, and
    /// `/tentativelyAccept` could only be a call.
    fn names_endpoint(code: &str, endpoint: &str) -> bool {
        code.match_indices(endpoint).any(|(at, _)| {
            let after = code[at + endpoint.len()..].chars().next();
            !after.is_some_and(|c| c.is_ascii_alphanumeric())
        })
    }

    /// The scan above is only worth having if it still fires on the real spelling,
    /// so pin both halves: every Graph action as it would really be written, and the
    /// one native-calling path that shares a prefix with `/accept`.
    #[test]
    fn the_endpoint_scan_catches_a_real_graph_action_and_not_a_calling_path() {
        for real in [
            "let url = format!(\"{GRAPH}/me/events/{id}/accept\");",
            "post(&format!(\"{base}/decline\"))",
            "\"/tentativelyAccept\"",
            "get(GRAPH.to_string() + \"/me/events/1/cancel\")",
        ] {
            assert!(
                ["/accept", "/decline", "/tentativelyAccept", "/cancel"]
                    .iter()
                    .any(|e| names_endpoint(real, e)),
                "the scan must still catch: {real}"
            );
        }
        // The calling plane's own callback paths are not calendar writes.
        for calling in ["\"/call/acceptance/\"", "\"/call/acknowledgement/\""] {
            for endpoint in ["/accept", "/decline", "/cancel", "/forward"] {
                assert!(
                    !names_endpoint(calling, endpoint),
                    "{calling} is a Teams calling callback, not a calendar write"
                );
            }
        }
    }

    /// Graph's calendar-write endpoints must not exist anywhere in the crate.
    ///
    /// The token this app already holds carries the consent to use them, so — as
    /// with `sendMail` — the only thing standing between this codebase and an
    /// invitation going out under the user's name is that no code names them. This
    /// test keeps it that way.
    #[test]
    fn crate_contains_no_calendar_write_endpoint() {
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
        // Every action Graph exposes on an `event`, as it appears in a URL path. The
        // leading slash is what keeps this precise: `tentativelyAccepted` is a
        // legitimate *response value* we read and store, while `/tentativelyAccept`
        // could only ever be a call.
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            let code =
                strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(&source));
            for endpoint in [
                "/tentativelyAccept",
                "/accept",
                "/decline",
                "/cancel",
                "/forward",
                "/snoozeReminder",
                "/dismissReminder",
            ] {
                assert!(
                    !names_endpoint(&code, endpoint),
                    "{} names the Graph calendar endpoint `{endpoint}`. Acting on an event is \
                     forbidden here: it mails the organizer or every attendee as the user, and \
                     cannot be recalled.",
                    file.display()
                );
            }
        }
    }

    #[test]
    fn parses_a_calendar_event() {
        let value = json!({
            "value": [{
                "id": "AAMk-event-1",
                "subject": "  Architecture guild  ",
                "bodyPreview": "Agenda:\r\n\r\n- local-first   storage\n- the write lock",
                // Graph's calendar shape: seven fractional digits, no zone suffix.
                "start": { "dateTime": "2026-07-01T06:30:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-07-01T07:15:00.0000000", "timeZone": "UTC" },
                "isAllDay": false,
                "isCancelled": false,
                "isOrganizer": false,
                "showAs": "tentative",
                "sensitivity": "normal",
                "importance": "normal",
                "type": "occurrence",
                "location": { "displayName": "Microsoft Teams Meeting" },
                "organizer": { "emailAddress": { "name": "Lucas Silva", "address": "lucas@example.com" } },
                "attendees": [
                    {
                        "emailAddress": { "name": "Me", "address": "me@example.com" },
                        "status": { "response": "accepted" },
                        "type": "required"
                    },
                    {
                        "emailAddress": { "address": "ada@example.com" },
                        "status": { "response": "notResponded" },
                        "type": "optional"
                    }
                ],
                "onlineMeeting": { "joinUrl": "https://teams.microsoft.com/l/meetup-join/x" },
                "isOnlineMeeting": true,
                "webLink": "https://outlook.office.com/calendar/item/x",
                "categories": ["Platform", " "],
                "responseStatus": { "response": "accepted", "time": "2026-06-01T09:00:00Z" },
                "hasAttachments": false,
                "reminderMinutesBeforeStart": 15
            }]
        });
        let events = parse_events(&value, "cal-1");
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.id, "AAMk-event-1");
        assert_eq!(e.calendar_id, "cal-1");
        assert_eq!(e.subject, "Architecture guild");
        // The preview is collapsed to a single clean line.
        assert_eq!(e.preview, "Agenda: - local-first storage - the write lock");
        // Both timestamps land in the canonical shape, whatever width Graph used.
        assert_eq!(e.start, "2026-07-01T06:30:00Z");
        assert_eq!(e.end, "2026-07-01T07:15:00Z");
        assert_eq!(e.show_as, "tentative");
        assert_eq!(e.series, "occurrence");
        assert_eq!(e.response, "accepted");
        assert_eq!(e.organizer.name, "Lucas Silva");
        assert_eq!(e.location, "Microsoft Teams Meeting");
        assert!(e.join_url.starts_with("https://teams.microsoft.com/"));
        assert_eq!(e.attendees.len(), 2);
        assert_eq!(e.attendees[1].address, "ada@example.com");
        assert_eq!(e.attendees[1].response, "notResponded");
        assert_eq!(e.attendees[1].kind, "optional");
        assert_eq!(e.attendee_count, 2);
        // A blank category is dropped rather than rendered as an empty chip.
        assert_eq!(e.categories, vec!["Platform".to_string()]);
        assert_eq!(e.reminder_minutes, 15);
    }

    #[test]
    fn skips_events_without_an_id_or_a_start() {
        // Neither could be addressed or placed on a grid, so they are dropped rather
        // than stored under an invented key.
        let value = json!({
            "value": [
                { "subject": "no id", "start": { "dateTime": "2026-07-01T06:30:00.0000000" } },
                { "id": "e2", "subject": "no start" },
                { "id": "e3", "start": { "dateTime": "tomorrow" } },
                { "id": "e4", "start": { "dateTime": "2026-07-01T06:30:00.0000000" },
                  "end": { "dateTime": "2026-07-01T07:00:00.0000000" } }
            ]
        });
        let events = parse_events(&value, "c");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "e4");
    }

    #[test]
    fn clamps_a_missing_or_backwards_end_to_the_start() {
        // Such an event would otherwise fall out of every range query and vanish.
        let value = json!({
            "value": [
                { "id": "e1", "start": { "dateTime": "2026-07-01T09:00:00.0000000" } },
                { "id": "e2", "start": { "dateTime": "2026-07-01T09:00:00.0000000" },
                  "end": { "dateTime": "2026-07-01T08:00:00.0000000" } }
            ]
        });
        let events = parse_events(&value, "c");
        assert_eq!(events.len(), 2);
        for event in &events {
            assert_eq!(event.end, "2026-07-01T09:00:00Z");
        }
    }

    #[test]
    fn keeps_an_all_day_events_midnight_boundaries_verbatim() {
        // Graph gives an all-day event midnight-to-midnight UTC with an EXCLUSIVE
        // end. Both are stored as-is: converting them to a local instant is what
        // would slide a holiday onto the wrong day, and only the front-end knows
        // which zone to render in.
        let value = json!({
            "value": [{
                "id": "holiday",
                "subject": "Summer leave",
                "isAllDay": true,
                "start": { "dateTime": "2026-07-13T00:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-07-18T00:00:00.0000000", "timeZone": "UTC" }
            }]
        });
        let event = &parse_events(&value, "c")[0];
        assert!(event.is_all_day);
        assert_eq!(event.start, "2026-07-13T00:00:00Z");
        assert_eq!(event.end, "2026-07-18T00:00:00Z");
    }

    #[test]
    fn caps_the_attendee_list_but_keeps_the_true_count() {
        // Real invitations reach the hundreds (the recon spike found one with 170).
        let attendees: Vec<Value> = (0..170)
            .map(|i| {
                json!({
                    "emailAddress": { "address": format!("p{i}@example.com") },
                    "status": { "response": "notResponded" },
                    "type": "required"
                })
            })
            .collect();
        let value = json!({
            "value": [{
                "id": "big",
                "start": { "dateTime": "2026-07-01T09:00:00.0000000" },
                "end": { "dateTime": "2026-07-01T10:00:00.0000000" },
                "attendees": attendees
            }]
        });
        let event = &parse_events(&value, "c")[0];
        assert_eq!(event.attendees.len(), MAX_ATTENDEES);
        assert_eq!(event.attendee_count, 170);
    }

    #[test]
    fn defaults_are_safe_for_a_sparse_event() {
        let value = json!({
            "value": [{
                "id": "sparse",
                "start": { "dateTime": "2026-07-01T09:00:00.0000000" },
                "end": { "dateTime": "2026-07-01T10:00:00.0000000" }
            }]
        });
        let e = &parse_events(&value, "c")[0];
        assert_eq!(e.show_as, "unknown");
        assert_eq!(e.response, "none");
        assert_eq!(e.series, "singleInstance");
        assert_eq!(e.importance, "normal");
        assert_eq!(e.organizer, EventPerson::default());
        assert!(e.categories.is_empty());
        // -1, not 0: "no reminder recorded" must not read as "remind me at the start".
        assert_eq!(e.reminder_minutes, -1);
    }

    #[test]
    fn parses_calendars_default_first_and_only_real_hex_colours() {
        let value = json!({
            "value": [
                { "id": "c-birthdays", "name": "Birthdays", "color": "auto", "hexColor": "",
                  "isDefaultCalendar": false, "canEdit": false },
                { "id": "c-main", "name": "Calendar", "color": "lightBlue", "hexColor": "#9fe1e7",
                  "isDefaultCalendar": true, "canEdit": true },
                { "id": "c-team", "name": "Team", "color": "auto", "hexColor": "#16a765",
                  "isDefaultCalendar": false, "canEdit": false },
                { "name": "no id" }
            ]
        });
        let calendars: Vec<Calendar> = value["value"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter_map(parse_calendar)
            .collect();
        assert_eq!(calendars.len(), 3);
        // A calendar on the automatic colour reports no hex; the UI's palette covers it.
        assert_eq!(calendars[0].hex_color, "");
        assert_eq!(calendars[1].hex_color, "#9fe1e7");
        assert!(calendars[1].is_default);
    }

    #[test]
    fn resolves_the_month_a_timestamp_falls_in() {
        assert_eq!(
            Month::of("2026-07-26T14:20:16Z"),
            Some(Month { year: 2026, month: 7 })
        );
        assert_eq!(Month::of("2026-01"), Some(Month { year: 2026, month: 1 }));
        assert_eq!(Month::of("2026-13-01T00:00:00Z"), None);
        assert_eq!(Month::of("2026/07/26"), None);
        assert_eq!(Month::of("nope"), None);
        assert_eq!(Month::of(""), None);
    }

    #[test]
    fn month_bounds_are_canonical_timestamps() {
        let july = Month { year: 2026, month: 7 };
        assert_eq!(july.key(), "2026-07");
        assert_eq!(july.start(), "2026-07-01T00:00:00Z");
        assert_eq!(july.end(), "2026-08-01T00:00:00Z");
        // December rolls the year over.
        let december = Month { year: 2026, month: 12 };
        assert_eq!(december.end(), "2027-01-01T00:00:00Z");
    }

    #[test]
    fn months_covering_spans_every_month_a_range_touches() {
        // A month view: exactly its own month.
        assert_eq!(
            months_covering("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z")
                .iter()
                .map(Month::key)
                .collect::<Vec<_>>(),
            vec!["2026-07"]
        );
        // A week straddling two months needs both — the reason months, not the
        // requested window, are the sync unit.
        assert_eq!(
            months_covering("2026-06-28T00:00:00Z", "2026-07-05T00:00:00Z")
                .iter()
                .map(Month::key)
                .collect::<Vec<_>>(),
            vec!["2026-06", "2026-07"]
        );
        // A month grid's leading/trailing days reach into three months.
        assert_eq!(
            months_covering("2026-06-28T00:00:00Z", "2026-08-09T00:00:00Z")
                .iter()
                .map(Month::key)
                .collect::<Vec<_>>(),
            vec!["2026-06", "2026-07", "2026-08"]
        );
        // A range ending exactly on a month boundary does NOT pull in the next month.
        assert_eq!(
            months_covering("2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z")
                .iter()
                .map(Month::key)
                .collect::<Vec<_>>(),
            vec!["2026-12"]
        );
        // A single day is one month.
        assert_eq!(
            months_covering("2026-07-26T00:00:00Z", "2026-07-27T00:00:00Z")
                .iter()
                .map(Month::key)
                .collect::<Vec<_>>(),
            vec!["2026-07"]
        );
    }

    #[test]
    fn months_covering_refuses_an_empty_reversed_or_unparseable_range() {
        assert!(months_covering("2026-07-05T00:00:00Z", "2026-07-01T00:00:00Z").is_empty());
        assert!(months_covering("2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z").is_empty());
        assert!(months_covering("nope", "2026-07-01T00:00:00Z").is_empty());
    }

    #[test]
    fn months_covering_is_bounded() {
        // However wide a range a client asks for, the walk stops.
        let months = months_covering("2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z");
        assert_eq!(months.len(), MAX_MONTHS_PER_RANGE);
    }

    /// Build a minimal event for the overlap tests.
    fn span(id: &str, start: &str, end: &str) -> CalendarEvent {
        let value = json!({
            "value": [{
                "id": id,
                "start": { "dateTime": start },
                "end": { "dateTime": end }
            }]
        });
        parse_events(&value, "c").remove(0)
    }

    #[test]
    fn overlaps_matches_the_stores_own_range_predicate() {
        let window = ("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z");
        let cases = [
            // (event span, expected)
            (("2026-07-05T09:00:00Z", "2026-07-05T10:00:00Z"), false), // before
            (("2026-07-12T09:00:00Z", "2026-07-13T00:00:00Z"), false), // ends as it starts
            (("2026-07-11T00:00:00Z", "2026-07-16T00:00:00Z"), true),  // straddles
            (("2026-07-13T09:00:00Z", "2026-07-13T10:00:00Z"), true),  // inside
            (("2026-07-14T00:00:00Z", "2026-07-14T01:00:00Z"), false), // starts as it ends
            // A zero-length event on the window's first instant: the case the second
            // clause exists for.
            (("2026-07-13T00:00:00Z", "2026-07-13T00:00:00Z"), true),
        ];
        for ((start, end), expected) in cases {
            let event = span("e", start, end);
            assert_eq!(
                overlaps(&event, window.0, window.1),
                expected,
                "{start}..{end} against {}..{}",
                window.0,
                window.1
            );
        }
    }

    #[test]
    fn endpoints_stay_on_graph_and_encode_their_arguments() {
        // A calendar id contains base64 characters (`+`, `/`, `=`) that must not
        // leak into the URL structure.
        let url = endpoint(&format!("/calendars/{}/calendarView", q("AAMk/id+with=pad")));
        assert!(url.starts_with("https://graph.microsoft.com/v1.0/me/"));
        assert!(!url.contains("id+with"));
        assert!(url.contains("AAMk%2Fid%2Bwith%3Dpad"));
    }

    #[tokio::test]
    async fn refuses_to_send_the_token_to_a_non_graph_url() {
        // Defence in depth around the one request builder. It matters more here than
        // in `mail`: `fetch_view` follows an `@odata.nextLink` that the RESPONSE
        // chose, so the check is on a URL this code did not build.
        let http = reqwest::Client::new();
        let err = graph_get(&http, "secret-token", "https://evil.example.com/steal", None)
            .await
            .expect_err("a non-Graph URL must be refused");
        assert!(err.to_string().contains("non-Graph URL"));
    }
}
