import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Video01Icon } from "@hugeicons/core-free-icons";
import {
  calendarColor,
  eventTitle,
  type CalendarEvent,
  type CalendarInfo,
} from "~/lib/protocol";
import {
  eventSpan,
  formatEventTimeRange,
  formatTimeCompact,
  isDeclined,
  isTentative,
  isUnanswered,
} from "~/lib/calendar";
import { cn } from "~/lib/utils";
import { useAppState } from "./controller-context";

// The one visual vocabulary every calendar view draws events with — three shapes of
// the same thing, after the reference design (Notion Calendar by way of calendarcn):
//
//   BLOCK — a timed meeting in the hour grid. Tinted fill, a coloured rail down its
//           leading edge, title over time.
//   BAR   — an all-day or multi-day run, drawn across the days it covers as one
//           continuous line rather than a chip per day.
//   ITEM  — the month cell's and the sidebar's row: no fill at all, just the rail,
//           the start time and the title, so a cell of six of them stays quiet.
//
// An event's COLOUR is its CALENDAR's colour — that is what makes six overlaid
// calendars readable, and it is how Outlook and Teams do it. Everything else an event
// says about itself is therefore carried by its treatment rather than by a second
// colour: a declined or cancelled event is struck through, a tentative one hatched,
// an unanswered invitation outlined instead of filled, and anything already over is
// dimmed so the eye lands on what is still ahead. The predicates behind those live in
// `lib/calendar` and come straight from Graph's own fields.

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

/** What every event shape needs to know. */
type EventVisualProps = {
  event: CalendarEvent;
  /** The calendar's colour, as a CSS colour. Drives fill, rail and text through the
   *  `.calendar-event` recipe in app.css. */
  color: string;
  /** This event's details panel is open. */
  selected?: boolean;
  /** The event is over. Dimmed, never hidden. */
  past?: boolean;
  onOpen: (id: string) => void;
  className?: string;
  style?: React.CSSProperties;
};

/** The shared shell: the button, its identity for tests, and the state treatments
 *  that mean the same thing in every view. */
function eventShellProps(props: EventVisualProps) {
  const { event } = props;
  return {
    type: "button" as const,
    "data-testid": "calendar-event",
    "data-event-id": event.id,
    "data-selected": props.selected ? "true" : undefined,
    title: `${eventTitle(event)} · ${formatEventTimeRange(event)}`,
    "aria-label": `${eventTitle(event)}, ${formatEventTimeRange(event)}`,
    style: { "--event-color": props.color, ...props.style } as React.CSSProperties,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      props.onOpen(event.id);
    },
  };
}

/** Fill, rail and outline, shared by BLOCK and BAR (ITEM has no fill). */
function filledClasses(props: EventVisualProps) {
  const { event } = props;
  return cn(
    "calendar-event group/event relative flex min-w-0 select-none overflow-hidden text-left",
    "transition-[background-color,box-shadow,opacity] duration-150",
    // An answered event is filled; an unanswered invitation is left outlined, so
    // "I have not decided" is visible without a legend.
    isUnanswered(event)
      ? "bg-[var(--card)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--event-color)_45%,transparent)]"
      : "bg-[var(--event-fill)]",
    "hover:bg-[var(--event-fill-strong)]",
    props.selected &&
      "bg-[var(--event-fill-strong)] ring-2 ring-inset ring-[var(--event-color)] z-30",
    isTentative(event) && "calendar-hatch",
    isDeclined(event) && "opacity-60",
    props.past && !props.selected && "opacity-65",
  );
}

/** The coloured rail down an event's leading edge. Absolute, so it survives the
 *  block's own padding and never shifts the text. */
function Rail(props: { hidden?: boolean; rounded?: boolean }) {
  if (props.hidden) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute inset-y-0 left-0 w-[3px] bg-[var(--event-color)]",
        props.rounded && "rounded-l-[3px]",
      )}
    />
  );
}

/**
 * One timed meeting in the hour grid.
 *
 * The time is dropped when the block is too short to carry a second line — a
 * 15-minute hold is 12 pixels tall, and half a clock reading is worse than none.
 *
 * `tight` is the shortest of those: a block whose own height is less than one padded
 * line. It gives up its padding and centres the title on the block, because a title
 * clipped along its baseline is a title nobody can read. The block is never grown to
 * fit instead — that is what used to draw a quarter-hour meeting over the one after it
 * (see `layoutDayGrid`).
 */
export function EventBlock(props: EventVisualProps & { compact?: boolean; tight?: boolean }) {
  const { event } = props;
  const span = eventSpan(event);

  return (
    <button
      {...eventShellProps(props)}
      className={cn(
        filledClasses(props),
        "flex-col gap-px rounded-[4px] pl-2 pr-1",
        props.tight ? "justify-center py-0" : "py-[1px]",
        props.className,
      )}
    >
      <Rail rounded />
      <span
        className={cn(
          "w-full truncate text-[11px] font-semibold text-[var(--event-title)]",
          props.tight ? "leading-none" : "leading-[1.35]",
          isDeclined(event) && "line-through",
        )}
      >
        {eventTitle(event)}
      </span>
      {!props.compact && (
        <span className="w-full truncate text-[10px] leading-[1.35] tabular-nums text-[var(--event-meta)]">
          {formatEventTimeRange(event)}
        </span>
      )}
      {event.join_url && !props.compact && (
        <HugeiconsIcon
          icon={Video01Icon}
          className="absolute right-1 top-1 size-2.5 text-[var(--event-meta)]"
          strokeWidth={2}
          aria-hidden
        />
      )}
      <span className="sr-only">{formatTimeCompact(span.startMs)}</span>
    </button>
  );
}

/**
 * One all-day or multi-day run, as a bar across the days it covers.
 *
 * `continuesBefore` / `continuesAfter` say the run extends past the row it is drawn
 * in: the bar then loses that edge's rounding (and its rail), so a fortnight of leave
 * reads as one thing crossing two week rows rather than two separate holidays.
 */
export function EventBar(
  props: EventVisualProps & { continuesBefore?: boolean; continuesAfter?: boolean },
) {
  const { event } = props;
  const span = eventSpan(event);

  return (
    <button
      {...eventShellProps(props)}
      className={cn(
        filledClasses(props),
        "h-full items-center gap-1.5 py-0 pl-2 pr-1.5",
        props.continuesBefore ? "rounded-l-none" : "rounded-l-[4px]",
        props.continuesAfter ? "rounded-r-none" : "rounded-r-[4px]",
        props.className,
      )}
    >
      <Rail hidden={props.continuesBefore} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11px] font-semibold leading-none text-[var(--event-title)]",
          isDeclined(event) && "line-through",
        )}
      >
        {eventTitle(event)}
      </span>
      {!event.is_all_day && (
        // A timed event only rides in the band when it crosses midnight, and then its
        // start is the one thing the bar cannot show by its position.
        <span className="shrink-0 text-[10px] leading-none tabular-nums text-[var(--event-meta)]">
          {formatTimeCompact(span.startMs)}
        </span>
      )}
    </button>
  );
}

/**
 * The quiet shape: a rail, the start time and the title on one line.
 *
 * The month grid's and the sidebar's unit. No fill — a cell holding six of these
 * would otherwise be a block of colour, and the reference design's month view is
 * deliberately almost white.
 */
export function EventItem(props: EventVisualProps & { hideTime?: boolean }) {
  const { event } = props;
  const span = eventSpan(event);

  return (
    <button
      {...eventShellProps(props)}
      className={cn(
        "calendar-event group/event relative flex w-full min-w-0 select-none items-center gap-1 overflow-hidden",
        "rounded-[4px] pl-2 pr-1 text-left transition-colors duration-150",
        "hover:bg-[var(--event-fill)]",
        props.selected && "bg-[var(--event-fill-strong)] ring-1 ring-inset ring-[var(--event-color)]",
        isDeclined(event) && "opacity-60",
        props.past && !props.selected && "opacity-60",
        props.className,
      )}
    >
      <Rail rounded />
      {!props.hideTime && !event.is_all_day && (
        <span className="shrink-0 text-[11px] leading-[1.45] tabular-nums text-[var(--event-meta)]">
          {formatTimeCompact(span.startMs)}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11px] font-semibold leading-[1.45] text-[var(--event-title)]",
          isDeclined(event) && "line-through",
        )}
      >
        {eventTitle(event)}
      </span>
      {event.join_url && (
        <HugeiconsIcon
          icon={Video01Icon}
          className="size-2.5 shrink-0 text-[var(--event-meta)]"
          strokeWidth={2}
          aria-hidden
        />
      )}
    </button>
  );
}
