// Manual live check for the SHAPE of a meeting join link, READ-ONLY.
//
// Joining a meeting needs three things out of that link: the meeting's thread, the
// message it hangs off, and the `meetingInfo` the calling service wants
// (`{tenantId, organizerId}` — see NATIVE-CALLING.md and `calling::MeetingJoin`).
// Everything is in the URL Graph already gives us (`onlineMeeting.joinUrl`), so this
// proves the parse against the user's own real meetings instead of against a guess.
//
// It reads the calendar and nothing else: no join, no ring, no write. And it prints
// the SHAPE rather than the values — a join URL is a key to a real meeting, and this
// output ends up in a terminal, a journal or a transcript.
//
//   . bin/broker-env.sh && teams_lite_export_broker_bus && \
//     cargo run --example meeting_join_recon
use anyhow::{Context, Result};

/// The window to read, as arguments — no date crate in this tree, and a window the
/// caller states is a window they can move to find a meeting.
const DEFAULT_START: &str = "2026-08-01T00:00:00Z";
const DEFAULT_END: &str = "2026-09-01T00:00:00Z";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;
    let token = teams_lite::auth::get_token(teams_lite::calendar::CALENDAR_SCOPE)
        .await
        .context("acquire the calendar token")?;

    let mut args = std::env::args().skip(1);
    let start = args.next().unwrap_or_else(|| DEFAULT_START.into());
    let end = args.next().unwrap_or_else(|| DEFAULT_END.into());
    println!("== reading {start} .. {end}");

    let calendars = teams_lite::calendar::fetch_calendars(&http, &token).await?;
    let mut events = Vec::new();
    for calendar in &calendars {
        let view =
            teams_lite::calendar::fetch_view(&http, &token, &calendar.id, &start, &end).await?;
        events.extend(view.events);
    }
    println!("== {} events over {} calendars", events.len(), calendars.len());

    let mut with_link = 0usize;
    let mut parsed = 0usize;
    for event in &events {
        if event.join_url.trim().is_empty() {
            continue;
        }
        with_link += 1;
        match teams_lite::calling::MeetingJoin::from_join_url(&event.join_url) {
            Some(join) => {
                parsed += 1;
                println!(
                    "   ok   thread={} message={} tenant={} organizer={} channel={}",
                    shape(&join.thread_id),
                    shape(&join.message_id),
                    present(join.tenant_id.as_deref()),
                    present(join.organizer_mri.as_deref()),
                    join.is_channel_meeting(),
                );
            }
            // The one case worth seeing in full: a link shape the parser does not know.
            // Its host and path tell us what to add; its ids are still not printed.
            None => println!("   MISS {}", redact(&event.join_url)),
        }
    }
    println!("== {with_link} events carry a join link, {parsed} parsed");
    if with_link > parsed {
        println!("== a MISS above is a link shape `MeetingJoin::from_join_url` has to learn");
    }
    Ok(())
}

/// A value's shape, never its value: the prefix that identifies the kind, then the
/// length. Enough to see that a thread is a `19:meeting_…@thread.v2` and that an id
/// is there at all.
fn shape(value: &str) -> String {
    if value.is_empty() {
        return "<none>".into();
    }
    let prefix: String = value.chars().take(12).collect();
    format!("{prefix}…[{}]", value.len())
}

fn present(value: Option<&str>) -> &'static str {
    match value {
        Some(v) if !v.is_empty() => "yes",
        _ => "no",
    }
}

/// A URL with every path segment and every query value dropped — the structure only.
fn redact(url: &str) -> String {
    let (base, query) = url.split_once('?').unwrap_or((url, ""));
    let path: Vec<&str> = base.split('/').take(5).collect();
    let keys: Vec<&str> = query
        .split('&')
        .filter_map(|pair| pair.split('=').next())
        .filter(|k| !k.is_empty())
        .collect();
    format!("{}/… ?{}", path.join("/"), keys.join("&"))
}
