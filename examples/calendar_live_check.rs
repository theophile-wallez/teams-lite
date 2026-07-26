// Manual live check for the READ-ONLY calendar surface, through the production code
// path.
//
// Exercises `teams_lite::calendar` end to end against the real tenant — calendar
// resolution, a month view with recurrence expanded, paging, and the invariants the
// store and the UI both depend on — and reports what it found. This is the calendar
// sibling of `mail_live_check.rs`: not a unit test, a hands-on verification that the
// implementation works against the real account.
//
//   DBUS_SESSION_BUS_ADDRESS="unix:path=/proc/$(pgrep -f \
//     identity-broker/bin/microsoft-identity-broker|head -1)/root/run/user/0/bus" \
//     cargo run --example calendar_live_check -- 2026-07
//
// READS ONLY, and it prints STRUCTURE, never content: subjects, attendees, locations
// and join URLs stay out of the output. What it shows is counts, shapes and the
// invariants — enough to verify the pipeline, nothing that spills a calendar into a
// terminal scrollback or a transcript.
use anyhow::Result;
use teams_lite::calendar::{self, Month};

#[tokio::main]
async fn main() -> Result<()> {
    let month_arg = std::env::args().nth(1).unwrap_or_else(|| "2026-07".to_string());
    let month = Month::of(&month_arg)
        .ok_or_else(|| anyhow::anyhow!("pass a month as YYYY-MM, got {month_arg:?}"))?;

    let http = reqwest::Client::new();
    let token = teams_lite::auth::get_token(calendar::CALENDAR_SCOPE).await?;

    println!("== calendars ==");
    let calendars = calendar::fetch_calendars(&http, &token).await?;
    for cal in &calendars {
        println!(
            "  pos={:<2} default={:<5} can_edit={:<5} hex={:<8} name_len={}",
            cal.position,
            cal.is_default,
            cal.can_edit,
            if cal.hex_color.is_empty() { "-" } else { &cal.hex_color },
            // The name identifies nothing useful here.
            cal.name.chars().count(),
        );
    }
    // The invariant the UI's default depends on.
    assert!(
        calendars.first().is_some_and(|c| c.is_default),
        "the default calendar must sort first"
    );

    let primary = calendars
        .iter()
        .find(|c| c.is_default)
        .ok_or_else(|| anyhow::anyhow!("no default calendar resolved"))?;

    println!("== view {} ({} .. {}) ==", month.key(), month.start(), month.end());
    let view = calendar::fetch_view(&http, &token, &primary.id, &month.start(), &month.end()).await?;
    println!("  {} events, truncated={}", view.events.len(), view.truncated);

    let all_day = view.events.iter().filter(|e| e.is_all_day).count();
    let cancelled = view.events.iter().filter(|e| e.is_cancelled).count();
    let online = view.events.iter().filter(|e| !e.join_url.is_empty()).count();
    let organizer = view.events.iter().filter(|e| e.is_organizer).count();
    let recurring = view
        .events
        .iter()
        .filter(|e| e.series != "singleInstance")
        .count();
    let capped = view
        .events
        .iter()
        .filter(|e| e.attendee_count as usize > calendar::MAX_ATTENDEES)
        .count();
    println!(
        "  all_day={all_day} cancelled={cancelled} joinable={online} organizer={organizer} \
         recurring={recurring} attendee_lists_capped={capped}"
    );

    let biggest = view.events.iter().map(|e| e.attendee_count).max().unwrap_or(0);
    println!("  largest attendee list={biggest} (stored at most {})", calendar::MAX_ATTENDEES);

    println!("== invariants ==");
    let mut previous = String::new();
    for event in &view.events {
        // Every timestamp reached the canonical shape, or ordering and range queries
        // would be wrong everywhere downstream.
        assert_eq!(event.start.len(), 20, "start is not a canonical timestamp");
        assert!(event.start.ends_with('Z'), "start is not UTC-suffixed");
        assert!(event.end >= event.start, "an event ends before it starts");
        // Graph was asked for `start/dateTime` order and must have honoured it: the
        // store and the views both rely on this order being total.
        assert!(event.start >= previous, "the view is not ordered by start");
        previous = event.start.clone();
        // Everything the view returned really is in the window we asked for — the
        // same predicate the store and the pruning use.
        assert!(
            calendar::overlaps(event, &month.start(), &month.end()),
            "an event outside the requested window came back"
        );
        assert_eq!(event.calendar_id, primary.id);
        assert!(event.attendees.len() <= calendar::MAX_ATTENDEES);
    }
    println!("  ordering, canonical timestamps, window and attendee cap all hold");

    println!("== all-day boundaries ==");
    match view.events.iter().find(|e| e.is_all_day) {
        Some(event) => {
            // An all-day event must be midnight-to-midnight, or the front-end's
            // date-only placement would put it on the wrong day.
            println!("  {} .. {} (exclusive end)", event.start, event.end);
            assert!(event.start.ends_with("T00:00:00Z"), "all-day start is not midnight");
            assert!(event.end.ends_with("T00:00:00Z"), "all-day end is not midnight");
        }
        None => println!("  (no all-day event in this month)"),
    }

    println!("== a multi-month span (one request, paged) ==");
    // What a month grid actually asks for: its leading and trailing days reach into
    // the neighbouring months, and one sync covers the whole span in a single call.
    let span = calendar::months_covering(&month.start(), &month.next().end());
    println!(
        "  months_covering -> {:?}",
        span.iter().map(Month::key).collect::<Vec<_>>()
    );
    let wide = calendar::fetch_view(
        &http,
        &token,
        &primary.id,
        &span.first().unwrap().start(),
        &span.last().unwrap().end(),
    )
    .await?;
    println!("  {} events, truncated={}", wide.events.len(), wide.truncated);
    // Paging must not repeat: one row per occurrence id.
    let unique: std::collections::HashSet<&str> =
        wide.events.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(unique.len(), wide.events.len(), "paging returned a duplicate event");
    println!("  no duplicates across pages");

    println!("OK — calendars resolved, view ordered and windowed, paging consistent");
    Ok(())
}
