import { useMemo } from "react";
import { Video } from "lucide-react";
import {
  calendarColor,
  eventTitle,
  type CalendarEvent,
  type CalendarInfo,
} from "~/lib/protocol";
import { eventSpan, formatTimeCompact } from "~/lib/calendar";
import { cn } from "~/lib/utils";
import { useAppState } from "./controller-context";

// The one visual vocabulary every calendar view draws events with.
//
// An event's colour comes from its CALENDAR, not from its own properties: that is
// what makes six overlaid calendars readable at a glance, and it is how Outlook and
// Teams do it. Everything else an event says about itself is carried by the chip's
// treatment rather than by another colour — a declined or cancelled event is struck
// through, a tentative one is hatched, one the user has not answered is outlined
// instead of filled.

/** Resolve calendar id → display colour once per calendar list. */
export function useCalendarColors(): (calendarId: string) => string {
  const calendars = useAppState((s) => s.calendars);
  return useMemo(() => colorLookup(calendars), [calendars]);
}

/** Pure calendar-id → colour lookup, with the app accent as the last resort (an
 *  event whose calendar we have not loaded yet still has to be visible). */
export function colorLookup(calendars: CalendarInfo[]): (calendarId: string) => string {
  const byId = new Map(calendars.map((c) => [c.id, calendarColor(c)]));
  return (calendarId: string) => byId.get(calendarId) ?? "var(--primary)";
}

/** How an event is filled: solid-ish for one the user is going to, outlined for one
 *  they have not answered. Keyed off Graph's own `response`, so it says something
 *  true rather than decorative. */
function isUnanswered(event: CalendarEvent): boolean {
  return event.response === "notResponded" || event.response === "none";
}

function isDeclined(event: CalendarEvent): boolean {
  return event.response === "declined" || event.is_cancelled;
}

function isTentative(event: CalendarEvent): boolean {
  return event.response === "tentativelyAccepted" || event.show_as === "tentative";
}

/** The inline custom properties every chip style keys off. `color-mix` does the
 *  tinting, so one colour drives fill, border and text in both themes. */
function chipVars(color: string): React.CSSProperties {
  return { "--event-color": color } as React.CSSProperties;
}

/**
 * One event as a compact chip: a coloured dot, its start time and its title on a
 * single line. The month grid's and the sidebar's unit.
 */
export function EventChip(props: {
  event: CalendarEvent;
  color: string;
  onOpen: (id: string) => void;
  /** Hide the time (the agenda already shows it in its own column). */
  hideTime?: boolean;
  className?: string;
}) {
  const { event } = props;
  const span = eventSpan(event);
  const declined = isDeclined(event);

  return (
    <button
      type="button"
      data-testid="calendar-event"
      data-event-id={event.id}
      title={eventTitle(event)}
      style={chipVars(props.color)}
      onClick={(e) => {
        e.stopPropagation();
        props.onOpen(event.id);
      }}
      className={cn(
        "group/event flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left",
        "text-[11px] leading-tight transition-colors",
        "hover:bg-[color-mix(in_srgb,var(--event-color)_18%,transparent)]",
        declined && "opacity-55",
        props.className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isUnanswered(event)
            ? "ring-1 ring-inset ring-[var(--event-color)]"
            : "bg-[var(--event-color)]",
        )}
      />
      {!props.hideTime && !event.is_all_day && (
        <span className="shrink-0 tabular-nums text-text-faint">
          {formatTimeCompact(span.startMs)}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-text-dim group-hover/event:text-foreground",
          declined && "line-through",
        )}
      >
        {eventTitle(event)}
      </span>
      {event.join_url && (
        <Video className="size-2.5 shrink-0 text-text-faint" strokeWidth={2} aria-hidden />
      )}
    </button>
  );
}

/**
 * One event as a filled block: the week/day grid's positioned unit and the all-day
 * band's bar. Bigger than a chip, so it carries a second line when it has room.
 */
export function EventBlock(props: {
  event: CalendarEvent;
  color: string;
  onOpen: (id: string) => void;
  /** Show the time under the title (only when the block is tall enough). */
  showTime?: boolean;
  /** The bar is clipped at the row's leading / trailing edge. */
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { event } = props;
  const span = eventSpan(event);
  const declined = isDeclined(event);
  const unanswered = isUnanswered(event);

  return (
    <button
      type="button"
      data-testid="calendar-event"
      data-event-id={event.id}
      title={eventTitle(event)}
      style={{ ...chipVars(props.color), ...props.style }}
      onClick={(e) => {
        e.stopPropagation();
        props.onOpen(event.id);
      }}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden px-1.5 py-0.5 text-left text-[11px] leading-tight",
        "border-l-2 border-[var(--event-color)] transition-[filter,opacity]",
        "hover:brightness-[0.97] dark:hover:brightness-110",
        // Answered events are filled; an unanswered invitation is left outlined, so
        // "I have not decided" is visible without a legend.
        unanswered
          ? "bg-[color-mix(in_srgb,var(--event-color)_8%,var(--card))] ring-1 ring-inset ring-[color-mix(in_srgb,var(--event-color)_35%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--event-color)_16%,var(--card))]",
        // A tentative event gets the hatch every calendar uses for "maybe".
        isTentative(event) && "calendar-hatch",
        props.continuesBefore ? "rounded-l-none border-l-0" : "rounded-l-md",
        props.continuesAfter ? "rounded-r-none" : "rounded-r-md",
        declined && "opacity-55",
        props.className,
      )}
    >
      <span
        className={cn(
          "truncate font-medium text-foreground",
          declined && "line-through",
        )}
      >
        {eventTitle(event)}
      </span>
      {props.showTime && !event.is_all_day && (
        // Start only: a week column is ~110px wide, and a full range would truncate
        // the one part of the time that matters. The range is in the details panel.
        <span className="truncate text-[10px] tabular-nums text-text-dim">
          {formatTimeCompact(span.startMs)}
        </span>
      )}
    </button>
  );
}
