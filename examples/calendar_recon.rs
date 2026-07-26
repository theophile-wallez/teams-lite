// Spike: what does Graph hand us for the user's Teams/Outlook calendar?
//
// De-risks the calendar surface before any of it is built: which calendars exist,
// whether `/me/calendarView` is usable with the broker token we already hold, and
// which properties a real event carries (all-day, recurring, Teams online meeting,
// response status, categories…).
//
//   DBUS_SESSION_BUS_ADDRESS="unix:path=/proc/$(pgrep -f \
//     identity-broker/bin/microsoft-identity-broker|head -1)/root/run/user/0/bus" \
//     cargo run --example calendar_recon -- 2026-07-01T00:00:00Z 2026-08-01T00:00:00Z
//
// READS ONLY, and prints SHAPE, never content: property names, types, counts and
// string lengths. Subjects, attendees, bodies and locations stay out of the output
// so a recon run never spills the user's calendar into a transcript.
use anyhow::Result;
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let start = args.next().unwrap_or_else(|| "2026-07-01T00:00:00Z".into());
    let end = args.next().unwrap_or_else(|| "2026-08-01T00:00:00Z".into());

    let http = reqwest::Client::new();
    let token = teams_lite::auth::get_token(teams_lite::teams_media::GRAPH_SCOPE).await?;

    println!("== /me/calendars ==");
    let calendars = get(
        &http,
        &token,
        "https://graph.microsoft.com/v1.0/me/calendars?$top=50",
        None,
    )
    .await?;
    match calendars["value"].as_array() {
        Some(items) => {
            println!("  {} calendars", items.len());
            for cal in items {
                println!(
                    "    id_len={:<4} name_len={:<3} default={:<5} canEdit={:<5} color={:?} hexColor={:?} owner={}",
                    cal["id"].as_str().unwrap_or_default().len(),
                    cal["name"].as_str().unwrap_or_default().chars().count(),
                    cal["isDefaultCalendar"].as_bool().unwrap_or(false),
                    cal["canEdit"].as_bool().unwrap_or(false),
                    cal["color"].as_str().unwrap_or("-"),
                    cal["hexColor"].as_str().unwrap_or("-"),
                    cal["owner"].is_object(),
                );
            }
        }
        None => println!("  no `value` array: {}", shape(&calendars)),
    }

    println!("== /me/calendarView ({start} .. {end}) ==");
    let select = "id,iCalUId,subject,bodyPreview,start,end,isAllDay,isCancelled,isOrganizer,\
                  showAs,sensitivity,importance,type,seriesMasterId,recurrence,location,\
                  locations,organizer,attendees,onlineMeeting,onlineMeetingProvider,\
                  isOnlineMeeting,webLink,categories,responseStatus,createdDateTime,\
                  lastModifiedDateTime,hasAttachments,allowNewTimeProposals,reminderMinutesBeforeStart";
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/calendarView\
         ?startDateTime={start}&endDateTime={end}&$select={select}&$orderby={}&$top=50",
        urlencoding::encode("start/dateTime")
    );
    // Ask for UTC explicitly: without the Prefer header Graph answers in the
    // mailbox's own time zone, which would make every stored timestamp ambiguous.
    let view = get(&http, &token, &url, Some("outlook.timezone=\"UTC\"")).await?;
    let events = view["value"].as_array().cloned().unwrap_or_default();
    println!("  {} events in the window", events.len());
    println!("  @odata.nextLink present: {}", view["@odata.nextLink"].is_string());

    let all_day = events.iter().filter(|e| e["isAllDay"].as_bool() == Some(true)).count();
    let cancelled = events.iter().filter(|e| e["isCancelled"].as_bool() == Some(true)).count();
    let online = events.iter().filter(|e| e["isOnlineMeeting"].as_bool() == Some(true)).count();
    let organizer = events.iter().filter(|e| e["isOrganizer"].as_bool() == Some(true)).count();
    let occurrences = events
        .iter()
        .filter(|e| e["type"].as_str().is_some_and(|t| t != "singleInstance"))
        .count();
    println!(
        "  all_day={all_day} cancelled={cancelled} online_meeting={online} \
         organizer={organizer} recurring_occurrences={occurrences}"
    );

    let mut types = std::collections::BTreeMap::<String, usize>::new();
    let mut show_as = std::collections::BTreeMap::<String, usize>::new();
    let mut responses = std::collections::BTreeMap::<String, usize>::new();
    let mut providers = std::collections::BTreeMap::<String, usize>::new();
    for event in &events {
        *types.entry(str_of(&event["type"])).or_default() += 1;
        *show_as.entry(str_of(&event["showAs"])).or_default() += 1;
        *responses
            .entry(str_of(&event["responseStatus"]["response"]))
            .or_default() += 1;
        *providers.entry(str_of(&event["onlineMeetingProvider"])).or_default() += 1;
    }
    println!("  type={types:?}");
    println!("  showAs={show_as:?}");
    println!("  responseStatus.response={responses:?}");
    println!("  onlineMeetingProvider={providers:?}");

    println!("== one event, property by property (shape only) ==");
    if let Some(event) = events.first() {
        for (key, value) in event.as_object().into_iter().flatten() {
            println!("    {key:<28} {}", shape(value));
        }
        println!("  start/end sub-shape:");
        println!("    start.dateTime = {:?}", event["start"]["dateTime"].as_str());
        println!("    start.timeZone = {:?}", event["start"]["timeZone"].as_str());
        println!("    end.timeZone   = {:?}", event["end"]["timeZone"].as_str());
        println!(
            "    attendee[0] keys = {:?}",
            event["attendees"][0]
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
        );
        println!(
            "    onlineMeeting keys = {:?}",
            event["onlineMeeting"]
                .as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
        );
    } else {
        println!("  (no events in the window)");
    }

    println!("== an all-day event's start/end, if any ==");
    if let Some(event) = events.iter().find(|e| e["isAllDay"].as_bool() == Some(true)) {
        println!("    start = {:?}", event["start"]["dateTime"].as_str());
        println!("    end   = {:?}", event["end"]["dateTime"].as_str());
        println!("    tz    = {:?}", event["start"]["timeZone"].as_str());
    }

    println!("== a Teams meeting's join info, if any ==");
    if let Some(event) = events.iter().find(|e| e["onlineMeeting"].is_object()) {
        let meeting = &event["onlineMeeting"];
        println!("    joinUrl_len       = {}", meeting["joinUrl"].as_str().unwrap_or_default().len());
        println!("    conferenceId      = {}", meeting["conferenceId"].is_string());
        println!("    tollNumber        = {}", meeting["tollNumber"].is_string());
        println!("    provider          = {:?}", event["onlineMeetingProvider"].as_str());
    }

    println!("== mailbox time zone (/me/mailboxSettings) ==");
    match get(
        &http,
        &token,
        "https://graph.microsoft.com/v1.0/me/mailboxSettings?$select=timeZone,workingHours",
        None,
    )
    .await
    {
        Ok(settings) => {
            println!("    timeZone     = {:?}", settings["timeZone"].as_str());
            println!("    workingHours = {}", shape(&settings["workingHours"]));
            println!(
                "    workingHours.daysOfWeek = {:?}",
                settings["workingHours"]["daysOfWeek"].as_array().map(Vec::len)
            );
            println!(
                "    workingHours start/end  = {:?} .. {:?} tz={:?}",
                settings["workingHours"]["startTime"].as_str(),
                settings["workingHours"]["endTime"].as_str(),
                settings["workingHours"]["timeZone"]["name"].as_str(),
            );
        }
        Err(e) => println!("    unavailable: {e}"),
    }

    println!("OK — recon complete");
    Ok(())
}

/// One Graph GET. Read-only by construction, exactly like `mail::graph_get`.
async fn get(
    http: &reqwest::Client,
    token: &str,
    url: &str,
    prefer: Option<&str>,
) -> Result<Value> {
    let mut req = http.get(url).bearer_auth(token);
    if let Some(prefer) = prefer {
        req = req.header("Prefer", prefer);
    }
    let resp = req.send().await?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_default();
        anyhow::bail!("graph -> {status} {detail}");
    }
    Ok(serde_json::from_str(&body)?)
}

/// Describe a JSON value's TYPE (and size), never its content.
fn shape(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => format!("bool({b})"),
        Value::Number(n) => format!("number({n})"),
        Value::String(s) => format!("string(len={})", s.chars().count()),
        Value::Array(a) => format!("array(len={})", a.len()),
        Value::Object(o) => format!("object({:?})", o.keys().collect::<Vec<_>>()),
    }
}

fn str_of(value: &Value) -> String {
    value.as_str().unwrap_or("-").to_string()
}
