// The one timestamp shape every Microsoft Graph surface in this crate stores.
//
// Graph hands out ISO 8601 timestamps in several widths: mail's
// `receivedDateTime` arrives as `2026-06-30T14:20:16Z`, a calendar event's
// `start.dateTime` as `2026-07-01T06:30:00.0000000` (seven fractional digits and no
// zone suffix — the zone travels beside it in `start.timeZone`). Both are reduced
// here to ONE canonical form: `YYYY-MM-DDTHH:MM:SSZ`.
//
// Why that matters more than tidiness: fixed-width UTC text sorts
// lexicographically exactly as it sorts chronologically. Every ordering, range
// predicate and page boundary in the crate — in SQLite, on the wire, and in the
// front-ends — is therefore a plain string comparison, and no date arithmetic
// exists on the Rust side at all. The UI parses these strings once, for display.
//
// Callers are responsible for having asked Graph for UTC (mail's
// `receivedDateTime` is always UTC; the calendar view sends
// `Prefer: outlook.timezone="UTC"`). This function only normalizes the WIDTH — it
// cannot convert a zone it was never told about, so it refuses nothing and assumes
// nothing.

/// Truncate an ISO 8601 UTC timestamp to whole seconds, yielding
/// `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Anything that is not a plausible `YYYY-MM-DDTHH:MM:SS` prefix yields `""`, and
/// its record is then skipped by the caller rather than stored under a key that
/// would mis-sort.
pub fn normalize_timestamp(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() < 19 {
        return String::new();
    }
    let head = &raw[..19];
    let bytes = head.as_bytes();
    let shape_ok = bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && head
            .char_indices()
            .filter(|(i, _)| ![4, 7, 10, 13, 16].contains(i))
            .all(|(_, c)| c.is_ascii_digit());
    if !shape_ok {
        return String::new();
    }
    format!("{head}Z")
}

/// The `YYYY-MM-DD` date part of a normalized timestamp, or `""` if it is not one.
///
/// Used for the all-day boundary of a calendar event, whose start and end are
/// midnight markers rather than instants.
pub fn date_part(timestamp: &str) -> &str {
    if timestamp.len() >= 10 {
        &timestamp[..10]
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_timestamps_to_whole_seconds() {
        // Already second-precision: unchanged.
        assert_eq!(
            normalize_timestamp("2026-06-30T14:20:16Z"),
            "2026-06-30T14:20:16Z"
        );
        // Fractional seconds are truncated, so every stored value is fixed width.
        assert_eq!(
            normalize_timestamp("2026-06-30T14:20:16.1234567Z"),
            "2026-06-30T14:20:16Z"
        );
        // Graph's calendar shape: seven fractional digits and NO zone suffix (the
        // zone rides alongside in `start.timeZone`).
        assert_eq!(
            normalize_timestamp("2026-07-01T06:30:00.0000000"),
            "2026-07-01T06:30:00Z"
        );
        // Whitespace is tolerated.
        assert_eq!(
            normalize_timestamp("  2026-01-02T03:04:05Z  "),
            "2026-01-02T03:04:05Z"
        );
        // Anything not shaped like a timestamp is refused (the caller skips it).
        assert_eq!(normalize_timestamp(""), "");
        assert_eq!(normalize_timestamp("2026-06-30"), "");
        assert_eq!(normalize_timestamp("not a timestamp at all"), "");
        assert_eq!(normalize_timestamp("2026/06/30T14:20:16Z"), "");
        assert_eq!(normalize_timestamp("2026-06-30 14:20:16Z"), "");
    }

    #[test]
    fn normalized_timestamps_sort_chronologically_as_text() {
        // The property every ORDER BY and range predicate depends on: fixed-width
        // UTC text sorts exactly as time does, so no date arithmetic is needed.
        let mut stamps = vec![
            normalize_timestamp("2026-06-30T14:20:16Z"),
            normalize_timestamp("2025-12-31T23:59:59Z"),
            normalize_timestamp("2026-07-01T00:00:00Z"),
            normalize_timestamp("2026-06-30T14:20:15.999Z"),
        ];
        stamps.sort();
        assert_eq!(
            stamps,
            vec![
                "2025-12-31T23:59:59Z",
                "2026-06-30T14:20:15Z",
                "2026-06-30T14:20:16Z",
                "2026-07-01T00:00:00Z",
            ]
        );
    }

    #[test]
    fn extracts_the_date_part() {
        assert_eq!(date_part("2026-07-13T00:00:00Z"), "2026-07-13");
        assert_eq!(date_part("2026-07-13"), "2026-07-13");
        assert_eq!(date_part("nope"), "");
        assert_eq!(date_part(""), "");
    }
}
