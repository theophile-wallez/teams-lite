import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  BellIcon,
  CalendarDaysIcon,
  Cancel01Icon,
  ChevronDownIcon,
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
import { MeetingJoinButton } from "./meeting-join-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

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
      // `min-w-0`, because the panel's width is its HOST's decision and never its
      // content's. It is a grid item in the dialog, where `min-width: auto` let one
      // unbreakable word widen the whole panel past the dialog that clips it — and what
      // fell off the clip was the last thing in the footer, so the event kept its Join
      // and lost the way out to Outlook. The word is real and arrives from the tenant on
      // most invitations: Graph's `bodyPreview` opens with the 80-character rule of
      // underscores Outlook draws above a Teams block (see `break-words` below).
      className="calendar-event flex min-w-0 max-h-full flex-col"
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
            <span className="break-words text-[13px] text-text-dim">{event.location}</span>
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

        {/* `break-words`, because an invitation's body is the tenant's text and not
            ours: the Teams block Outlook writes into it opens with a rule of 80
            underscores and carries a join link with no spaces in it, and each is ONE
            word. Broken, they wrap; unbroken, they decide how wide this panel is. */}
        {event.preview && (
          <p className="max-h-32 overflow-y-auto whitespace-pre-line break-words pl-7 text-[12px] leading-relaxed text-text-dim">
            {event.preview}
          </p>
        )}
      </div>

      {/* The user's own clicks. Nothing here acts on the calendar. */}
      <footer className="flex shrink-0 flex-col gap-2 border-t border-border-subtle p-3.5">
        <div className="flex items-center gap-2">
          {/* Join with audio, HERE. Beside the way out to real Teams rather than instead
              of it: this app carries a microphone and nothing else, so a meeting with a
              shared screen is still one to open there. */}
          <MeetingJoinButton
            meeting={{ kind: "link", joinUrl: event.join_url }}
            subject={event.subject}
          />
          <OpenIn event={event} />
        </div>
        <p className="text-[11px] text-text-faint">
          Answering an invitation happens in Outlook — this app never writes.
        </p>
      </footer>
    </div>
  );
}

/** One place this event exists OUTSIDE this app. Every one of them is a link the USER
 *  follows — never something the app opens, prefetches or answers on their behalf. */
type Destination = {
  /** What the row says. The trigger above it already said "Open in". */
  label: string;
  href: string;
  icon: IconSvgElement;
  testId: string;
};

/** Teams first: it is the meeting, where Outlook is the invitation around it. */
function destinationsOf(event: CalendarEvent): Destination[] {
  const destinations: Destination[] = [];
  if (event.join_url) {
    destinations.push({
      label: "Teams",
      href: event.join_url,
      icon: Video01Icon,
      testId: "calendar-event-join",
    });
  }
  if (event.web_link) {
    destinations.push({
      label: "Outlook",
      href: event.web_link,
      icon: ExternalLinkIcon,
      testId: "calendar-event-outlook",
    });
  }
  return destinations;
}

/** The box both shapes below wear — the chip the calendar's own view menu is drawn as,
 *  so a way out of the app never reads as the primary action beside it. */
const CHIP =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-card px-3 text-[13px] text-text-dim shadow-chip transition-colors hover:text-foreground";

/**
 * "Open in" — every way out of this app, in ONE control.
 *
 * The panel is 320px beside its event, and a phone's screen in a dialog. "Join here" plus
 * "Open in Teams" plus "Open in Outlook" is wider than either, and on a phone the last of
 * them fell off the panel's own clip: the event kept the join and lost the way out. So the
 * ways out collapse into one menu, and the footer holds two controls at every width — what
 * THIS app does with the meeting, and what another app does with it.
 *
 * A menu holds a CHOICE, so it is drawn only where there is one. An ordinary event — an
 * Outlook link and no meeting — keeps the labelled link it always was, because a menu
 * whose single row is already named by its trigger asks for a click to say nothing.
 */
function OpenIn(props: { event: CalendarEvent }) {
  const destinations = destinationsOf(props.event);
  const [open, setOpen] = useState(false);

  // ESCAPE IS OURS WHILE THE MENU IS OPEN, and it has to be. On a wide screen the panel
  // under this menu is a Radix POPOVER, and `@radix-ui/react-popover` carries its own copy
  // of the dismissable-layer module — so it keeps a layer stack of its own, cannot know a
  // menu opened above it, and its document-capture Escape handler (registered first, when
  // the panel opened) closed the whole PANEL from under the menu. One key, two layers.
  //
  // A capture listener on the WINDOW runs before every listener on the document, so this
  // one closes the menu, stops the key there, and leaves the panel to the next Escape. It
  // is the same on a phone, where the panel is a dialog that does share the stack: one
  // spelling for both surfaces beats a behaviour that depends on the width.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open]);

  const [first] = destinations;
  if (!first) return null;

  if (destinations.length === 1) {
    return (
      <a
        data-testid={first.testId}
        href={first.href}
        target="_blank"
        rel="noreferrer noopener"
        className={CHIP}
      >
        <HugeiconsIcon icon={first.icon} className="size-3.5" strokeWidth={1.8} />
        Open in {first.label}
      </a>
    );
  }

  return (
    // Non-modal, for the reason `calendar-view-menu` gives: a modal Radix menu parks
    // `pointer-events: none` on the body until its close animation ends, so the very next
    // click — the one that puts this panel away — is swallowed.
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger
        data-testid="calendar-event-open-in"
        aria-label="Open this event in another app"
        className={cn(CHIP, "data-[state=open]:text-foreground")}
      >
        Open in
        <HugeiconsIcon
          icon={ChevronDownIcon}
          className="size-3.5 text-text-faint"
          strokeWidth={2}
        />
      </DropdownMenuTrigger>
      {/* Upward: the trigger is the last row of the panel, so a menu below it would hang
          off the panel's own foot. Radix flips it back down where there is no room. */}
      <DropdownMenuContent side="top" align="start" className="min-w-[10rem]">
        {destinations.map((destination) => (
          <DropdownMenuItem key={destination.testId} asChild>
            {/* The row IS the link, so a middle click and a long press behave the way
                they do everywhere else, and Radix's own keyboard select follows it. */}
            <a
              data-testid={destination.testId}
              href={destination.href}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open in ${destination.label}`}
            >
              <HugeiconsIcon
                icon={destination.icon}
                className="size-4 text-text-faint"
                strokeWidth={1.8}
              />
              {destination.label}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
