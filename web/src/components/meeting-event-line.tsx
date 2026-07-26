import { CalendarClock, CalendarX2, ExternalLink } from "lucide-react";
import {
  formatMeetingEvent,
  formatMeetingSchedule,
  type MeetingSystemEvent,
} from "~/lib/protocol";
import { SystemLine } from "./system-line";

/** The glyph per meeting activity. A cancellation reads differently at a glance;
 *  scheduling and updating share the calendar-with-clock. An event we have no words
 *  for never reaches here (see {@link formatMeetingEvent}). */
const MEETING_ICON = {
  scheduled: CalendarClock,
  cancelled: CalendarX2,
  updated: CalendarClock,
} as const;

/**
 * A centered, muted system line for a scheduled-meeting activity — "Meeting
 * scheduled · LAB GEN AI Monthly", with its local time range and a link into real
 * Teams. Rendered in the timeline in place of a chat bubble, like a call event.
 *
 * Before the backend understood these frames they arrived as ordinary messages whose
 * localised body ("Scheduled a meeting") was attributed to a raw contacts URL, which
 * is what item 9 of TODO-message-rendering.md was about.
 *
 * The join link deliberately hands off to Teams rather than pretending to join:
 * teams-lite has no calling stack, and a link is honest about that. A cancelled
 * meeting shows no join link at all — there is nothing left to join.
 */
export function MeetingEventLine(props: { event: MeetingSystemEvent }) {
  const { event } = props;
  const label = formatMeetingEvent(event);
  if (!label) return null;
  const schedule = formatMeetingSchedule(event);
  const location = event.location?.trim() ?? "";
  const joinUrl = event.event === "cancelled" ? "" : (event.join_url?.trim() ?? "");
  const Icon = MEETING_ICON[event.event as keyof typeof MEETING_ICON] ?? CalendarClock;

  return (
    <SystemLine kind={event.kind} icon={Icon} label={label} data={{ "data-meeting": event.event }}>
      {schedule ? (
        <span data-testid="meeting-schedule" className="text-text-faint">
          {schedule}
        </span>
      ) : null}
      {/* "Microsoft Teams Meeting" is the default and says nothing a reader of this
          app does not already know; a real room or address is worth a line. */}
      {location && location.toLowerCase() !== "microsoft teams meeting" ? (
        <span data-testid="meeting-location" className="text-text-faint">
          {location}
        </span>
      ) : null}
      {joinUrl ? (
        <a
          data-testid="meeting-join"
          href={joinUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          Join
          <ExternalLink className="size-3 shrink-0" strokeWidth={1.8} aria-hidden />
        </a>
      ) : null}
    </SystemLine>
  );
}
