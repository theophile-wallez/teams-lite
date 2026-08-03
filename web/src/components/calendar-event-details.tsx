import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BellIcon,
  CalendarDaysIcon,
  Cancel01Icon,
  Clock01Icon,
  ExternalLinkIcon,
  MapPinIcon,
  RepeatIcon,
  UserMultiple02Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import {
  calendarLabel,
  eventRepeats,
  eventTitle,
  personLabel,
  type CalendarEvent,
  type CalendarInfo,
  type EventPerson,
} from "~/lib/protocol";
import { formatEventTime, isDeclined } from "~/lib/calendar";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";

// One event's details, as a self-contained panel. Its host decides where it appears:
// a popover pinned to the event on a wide screen, a dialog on a narrow one (see
// calendar-event-popover.tsx).
//
// READ-ONLY, and it says so. There is no Accept / Decline / Tentative row, and their
// absence is deliberate rather than unfinished: answering an invitation mails the
// organizer, and the backend has no path that could (see src/calendar.rs). What the
// panel does offer are the two things that are the USER's own click — joining the
// meeting, and opening it in Outlook where answering is possible.

/** Human label for Graph's `response` values. */
const RESPONSE_LABELS: Record<string, string> = {
  organizer: "You're the organizer",
  accepted: "Accepted",
  declined: "Declined",
  tentativelyAccepted: "Tentative",
  notResponded: "Not answered",
  none: "",
};

/** Human label for Graph's `showAs` values. */
const SHOW_AS_LABELS: Record<string, string> = {
  free: "Free",
  tentative: "Tentative",
  busy: "Busy",
  oof: "Out of office",
  workingElsewhere: "Working elsewhere",
  unknown: "",
};

/** Human label for a recurrence pattern type. */
const RECURRENCE_LABELS: Record<string, string> = {
  daily: "Repeats daily",
  weekly: "Repeats weekly",
  absoluteMonthly: "Repeats monthly",
  relativeMonthly: "Repeats monthly",
  absoluteYearly: "Repeats yearly",
  relativeYearly: "Repeats yearly",
};

export function CalendarEventDetails(props: {
  event: CalendarEvent;
  calendars: CalendarInfo[];
  color: string;
  onClose: () => void;
}) {
  const { event } = props;
  const calendar = useMemo(
    () => props.calendars.find((c) => c.id === event.calendar_id) ?? null,
    [props.calendars, event.calendar_id],
  );

  return (
    <div
      data-testid="calendar-event-details"
      data-event-id={event.id}
      style={{ ["--event-color" as string]: props.color }}
      className="calendar-event flex max-h-full flex-col"
    >
      <header className="flex shrink-0 items-start gap-2.5 border-b border-border-subtle p-3.5">
        <span
          aria-hidden
          className="mt-1 h-9 w-[3px] shrink-0 rounded-full bg-[var(--event-color)]"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2
            data-testid="calendar-event-title"
            className={cn(
              "truncate text-[15px] font-semibold leading-snug text-foreground",
              isDeclined(event) && "line-through opacity-70",
            )}
            title={eventTitle(event)}
          >
            {eventTitle(event)}
          </h2>
          <p data-testid="calendar-event-when" className="text-[12px] text-text-dim">
            {formatEventTime(event)}
          </p>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close"
          data-testid="calendar-event-close"
          className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-lg text-text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.8} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
        {statusLine(event) && (
          <Row icon={<HugeiconsIcon icon={Clock01Icon} className="size-4" strokeWidth={1.6} />}>
            <span className="text-[13px] text-text-dim">{statusLine(event)}</span>
          </Row>
        )}

        {eventRepeats(event) && (
          <Row icon={<HugeiconsIcon icon={RepeatIcon} className="size-4" strokeWidth={1.6} />}>
            <span className="text-[13px] text-text-dim">
              {RECURRENCE_LABELS[event.recurrence] ?? "Part of a series"}
              {event.series === "exception" && " · this occurrence was moved"}
            </span>
          </Row>
        )}

        {event.location && (
          <Row icon={<HugeiconsIcon icon={MapPinIcon} className="size-4" strokeWidth={1.6} />}>
            <span className="text-[13px] text-text-dim">{event.location}</span>
          </Row>
        )}

        {event.reminder_minutes >= 0 && (
          <Row icon={<HugeiconsIcon icon={BellIcon} className="size-4" strokeWidth={1.6} />}>
            <span className="text-[13px] text-text-dim">
              {event.reminder_minutes === 0
                ? "Reminder at the start"
                : `Reminder ${event.reminder_minutes} min before`}
            </span>
          </Row>
        )}

        <Row icon={<HugeiconsIcon icon={CalendarDaysIcon} className="size-4" strokeWidth={1.6} />}>
          <span className="text-[13px] text-text-dim">
            {calendar ? calendarLabel(calendar) : "Calendar"} · read-only
          </span>
          {(event.organizer.name || event.organizer.address) && (
            <span className="text-[12px] text-text-faint">
              Organized by {personLabel(event.organizer)}
            </span>
          )}
        </Row>

        {event.attendee_count > 0 && <Attendees event={event} />}

        {event.categories.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 pl-7">
            {event.categories.map((category) => (
              <li
                key={category}
                className="rounded-full bg-element px-2 py-0.5 text-[11px] text-text-dim"
              >
                {category}
              </li>
            ))}
          </ul>
        )}

        {event.preview && (
          <p className="max-h-32 overflow-y-auto whitespace-pre-line pl-7 text-[12px] leading-relaxed text-text-dim">
            {event.preview}
          </p>
        )}
      </div>

      {/* The user's own clicks. Nothing here acts on the calendar. */}
      <footer className="flex shrink-0 flex-col gap-2 border-t border-border-subtle p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {event.join_url && (
            <a
              data-testid="calendar-event-join"
              href={event.join_url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <HugeiconsIcon icon={Video01Icon} className="size-3.5" strokeWidth={1.8} />
              Join meeting
            </a>
          )}
          {event.web_link && (
            <a
              data-testid="calendar-event-outlook"
              href={event.web_link}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-1.5 text-[13px] text-text-dim shadow-chip transition-colors hover:text-foreground"
            >
              <HugeiconsIcon icon={ExternalLinkIcon} className="size-3.5" strokeWidth={1.8} />
              Open in Outlook
            </a>
          )}
        </div>
        <p className="text-[11px] text-text-faint">
          Answering an invitation happens in Outlook — this app never writes.
        </p>
      </footer>
    </div>
  );
}

/** One labelled line: a leading icon in a fixed gutter, then its content. */
function Row(props: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-text-faint" aria-hidden>
        {props.icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">{props.children}</div>
    </div>
  );
}

/** The user's own answer plus how the event shows on their calendar. */
function statusLine(event: CalendarEvent): string {
  const parts = [RESPONSE_LABELS[event.response] ?? "", SHOW_AS_LABELS[event.show_as] ?? ""];
  if (event.is_cancelled) parts.unshift("Cancelled");
  return parts.filter(Boolean).join(" · ");
}

/** The attendee list, capped by the backend. The true total is always shown, so a
 *  777-person invitation never looks like a 20-person one. */
function Attendees(props: { event: CalendarEvent }) {
  const { attendees, attendee_count: total } = props.event;
  const hidden = total - attendees.length;

  return (
    <Row icon={<HugeiconsIcon icon={UserMultiple02Icon} className="size-4" strokeWidth={1.6} />}>
      <span className="text-[13px] text-text-dim">
        {total} {total === 1 ? "attendee" : "attendees"}
      </span>
      <ul data-testid="calendar-event-attendees" className="flex flex-col gap-1 pt-1">
        {attendees.map((person) => (
          <li key={person.address || person.name} className="flex items-center gap-2">
            <Avatar
              seed={person.address || person.name}
              label={personLabel(person)}
              fallback="person"
              className="size-5 text-[9px]"
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-dim">
              {personLabel(person)}
            </span>
            <AttendeeStatus person={person} />
          </li>
        ))}
      </ul>
      {hidden > 0 && <span className="pt-1 text-[11px] text-text-faint">and {hidden} more</span>}
    </Row>
  );
}

function AttendeeStatus(props: { person: EventPerson }) {
  const label = RESPONSE_LABELS[props.person.response];
  if (!label) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-[10px]",
        props.person.response === "accepted"
          ? "text-success"
          : props.person.response === "declined"
            ? "text-destructive"
            : "text-text-faint",
      )}
    >
      {label}
    </span>
  );
}
