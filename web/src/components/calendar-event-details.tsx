import { useMemo } from "react";
import {
  Bell,
  CalendarDays,
  Clock,
  ExternalLink,
  MapPin,
  Repeat,
  Users,
  Video,
} from "lucide-react";
import {
  calendarLabel,
  eventRepeats,
  eventTitle,
  personLabel,
  type CalendarEvent,
  type CalendarInfo,
  type EventPerson,
} from "~/lib/protocol";
import { formatEventTime } from "~/lib/calendar";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

// One event's details, as a dialog over whichever view opened it.
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
  event: CalendarEvent | null;
  calendars: CalendarInfo[];
  color: string;
  onClose: () => void;
}) {
  const event = props.event;
  const calendar = useMemo(
    () => props.calendars.find((c) => c.id === event?.calendar_id) ?? null,
    [props.calendars, event?.calendar_id],
  );

  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && props.onClose()}>
      {event && (
        <DialogContent
          data-testid="calendar-event-details"
          data-event-id={event.id}
          className="max-w-xl"
        >
          <DialogHeader>
            <div className="flex items-start gap-2.5 pr-8">
              <span
                aria-hidden
                style={{ backgroundColor: props.color }}
                className="mt-1.5 size-2.5 shrink-0 rounded-full"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle
                  data-testid="calendar-event-title"
                  className={cn(
                    "text-base leading-snug",
                    event.is_cancelled && "line-through opacity-70",
                  )}
                >
                  {eventTitle(event)}
                </DialogTitle>
                <p className="text-[12px] text-text-faint">
                  {[calendar ? calendarLabel(calendar) : "", "read-only"]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </div>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <Row icon={<Clock className="size-4" strokeWidth={1.6} />}>
              <span data-testid="calendar-event-when" className="text-[13px] text-foreground">
                {formatEventTime(event)}
              </span>
              {statusLine(event) && (
                <span className="text-[12px] text-text-faint">{statusLine(event)}</span>
              )}
            </Row>

            {eventRepeats(event) && (
              <Row icon={<Repeat className="size-4" strokeWidth={1.6} />}>
                <span className="text-[13px] text-text-dim">
                  {RECURRENCE_LABELS[event.recurrence] ?? "Part of a series"}
                  {event.series === "exception" && " · this occurrence was moved"}
                </span>
              </Row>
            )}

            {event.location && (
              <Row icon={<MapPin className="size-4" strokeWidth={1.6} />}>
                <span className="text-[13px] text-text-dim">{event.location}</span>
              </Row>
            )}

            {event.reminder_minutes >= 0 && (
              <Row icon={<Bell className="size-4" strokeWidth={1.6} />}>
                <span className="text-[13px] text-text-dim">
                  {event.reminder_minutes === 0
                    ? "Reminder at the start"
                    : `Reminder ${event.reminder_minutes} min before`}
                </span>
              </Row>
            )}

            {(event.organizer.name || event.organizer.address) && (
              <Row icon={<CalendarDays className="size-4" strokeWidth={1.6} />}>
                <span className="text-[13px] text-text-dim">
                  Organized by{" "}
                  <span className="text-foreground">{personLabel(event.organizer)}</span>
                </span>
              </Row>
            )}

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
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {event.join_url && (
              <a
                data-testid="calendar-event-join"
                href={event.join_url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Video className="size-3.5" strokeWidth={1.8} />
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
                <ExternalLink className="size-3.5" strokeWidth={1.8} />
                Open in Outlook
              </a>
            )}
            <p className="ml-auto text-[11px] text-text-faint">
              Answering an invitation happens in Outlook — this app never writes.
            </p>
          </div>
        </DialogContent>
      )}
    </Dialog>
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
    <Row icon={<Users className="size-4" strokeWidth={1.6} />}>
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
      {hidden > 0 && (
        <span className="pt-1 text-[11px] text-text-faint">and {hidden} more</span>
      )}
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
