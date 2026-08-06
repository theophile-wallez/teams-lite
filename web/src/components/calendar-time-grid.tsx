import { useEffect, useMemo, useRef, useState } from "react";
import {
  dayKey,
  isSameDay,
  isWeekend,
  isPast,
  layoutDayBand,
  layoutDayGrid,
  nowIndicatorPercent,
  timezoneLabel,
} from "~/lib/calendar";
import type { CalendarEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { EventBar, EventBlock } from "./calendar-event";

// The hour grid, shared by the Week and Day views: a header of days, an all-day band,
// and a scrollable 24-hour body with one column per day.
//
// Laid out after the reference design (calendarcn / Notion Calendar):
//   - the hour gutter is labelled with the viewer's TIME ZONE at the top, because a
//     grid of clock times means nothing without one;
//   - a day header is "Mon 20" on one line, with today's number in a filled badge;
//   - the all-day band is always present, even empty, so switching weeks never shifts
//     the grid under the pointer;
//   - "now" is a badge in the gutter, a solid line across today and a hairline across
//     the other days — so a glance at any column says whether it is before or after.
//
// Timed blocks are positioned from percentages computed by `layoutDayGrid`, which also
// resolves overlaps: they cascade rather than tile, so three meetings at 10:00 each
// keep a readable leading edge instead of taking a third of the column each.

/** Smallest hour row that still fits a 30-minute meeting's title. Rows grow beyond it
 *  when the viewport is tall enough to show a whole day without scrolling. */
const MIN_HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Where the body scrolls to on first paint when the range does not include today:
 *  the start of a working day, not midnight. */
const DEFAULT_SCROLL_HOUR = 8;
/** Height of one all-day bar in the band, and the band's floor: an empty band still
 *  reserves one lane. */
const BAND_LANE_HEIGHT = 22;
/** Under this height a block is shorter than one padded line of title, so it drops its
 *  padding and centres the title instead (see `EventBlock`). */
const TIGHT_BLOCK_HEIGHT = 18;
/** Width of the hour gutter. Also the left inset of the header and the band, so their
 *  columns line up with the ones beneath them. */
const GUTTER_CLASS = "w-14 shrink-0";

export function CalendarTimeGrid(props: {
  days: Date[];
  today: Date;
  events: CalendarEvent[];
  colorOf: (calendarId: string) => string;
  openEventId: string | null;
  onOpenEvent: (id: string) => void;
  onPickDay: (day: Date) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hourHeight, setHourHeight] = useState(MIN_HOUR_HEIGHT);
  const now = useNow();

  const bars = useMemo(() => layoutDayBand(props.events, props.days), [props.events, props.days]);
  const laneCount = Math.max(1, bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0));
  const bandHeight = laneCount * BAND_LANE_HEIGHT + 4;
  const bodyHeight = 24 * hourHeight;
  const singleDay = props.days.length === 1;

  // Hours stretch to fill a tall viewport rather than leaving the grid short with dead
  // space under it — the reference design's behaviour, and the reason the height is
  // measured instead of fixed.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setHourHeight(Math.max(MIN_HOUR_HEIGHT, Math.floor(body.clientHeight / 24)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  // Open on the interesting part of the day rather than on midnight: the current hour
  // when today is on screen, else the start of the working day. Runs once per range
  // change, and only moves the scroll position — never the layout.
  const rangeKey = props.days.map(dayKey).join(",");
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const showsToday = props.days.some((day) => isSameDay(day, props.today));
    const hour = showsToday ? Math.max(0, props.today.getHours() - 1) : DEFAULT_SCROLL_HOUR;
    // Back off a few pixels so the topmost hour label — which sits just ABOVE the line
    // it names — is not clipped by the band above it.
    body.scrollTop = Math.max(0, hour * hourHeight - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the range, not the Date identities
  }, [rangeKey, hourHeight]);

  const nowPercent = useMemo(() => {
    const today = props.days.find((day) => isSameDay(day, now));
    return today ? nowIndicatorPercent(today, now) : null;
  }, [props.days, now]);

  return (
    <div data-testid="calendar-time-grid" className="flex min-h-0 flex-1 flex-col">
      {/* Day headers, with the time zone over the gutter. */}
      <div className="flex shrink-0 border-b border-border-subtle">
        <div
          className={cn(
            GUTTER_CLASS,
            "flex items-end justify-end pb-1.5 pr-2 text-[10px] uppercase tracking-wide text-text-faint",
          )}
        >
          {timezoneLabel(now)}
        </div>
        {props.days.map((day) => {
          const today = isSameDay(day, props.today);
          return (
            <button
              key={dayKey(day)}
              type="button"
              data-testid="calendar-day-header"
              data-day={dayKey(day)}
              data-today={today ? "true" : undefined}
              onClick={() => props.onPickDay(day)}
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1.5 py-2 transition-colors hover:bg-accent",
                isWeekend(day) && "bg-calendar-weekend",
              )}
            >
              <span
                className={cn(
                  "truncate text-[12px]",
                  today ? "font-medium text-foreground" : "text-text-dim",
                )}
              >
                {day.toLocaleDateString(undefined, { weekday: singleDay ? "long" : "short" })}
              </span>
              <span
                className={cn(
                  "grid h-5 min-w-5 place-items-center rounded-md px-1 text-[12px] tabular-nums",
                  today ? "bg-primary font-medium text-primary-foreground" : "text-text-faint",
                )}
              >
                {day.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      {/* The all-day band, always present so the grid never shifts between weeks. */}
      <div className="flex shrink-0 border-b border-border-subtle">
        <div
          className={cn(
            GUTTER_CLASS,
            "pr-2 pt-1.5 text-right text-[10px] uppercase tracking-wide text-text-faint",
          )}
        >
          All day
        </div>
        <div
          data-testid="calendar-all-day-band"
          className="relative min-w-0 flex-1"
          style={{ height: bandHeight }}
        >
          {/* Column separators and weekend tint, so the band reads as part of the grid. */}
          <div className="absolute inset-0 flex" aria-hidden>
            {props.days.map((day) => (
              <div
                key={dayKey(day)}
                className={cn(
                  "flex-1 border-r border-calendar-line last:border-r-0",
                  isWeekend(day) && "bg-calendar-weekend",
                )}
              />
            ))}
          </div>
          {bars.map((bar) => (
            <EventBar
              key={bar.event.id}
              event={bar.event}
              color={props.colorOf(bar.event.calendar_id)}
              selected={props.openEventId === bar.event.id}
              past={isPast(bar.event, now)}
              onOpen={props.onOpenEvent}
              continuesBefore={bar.continuesBefore}
              continuesAfter={bar.continuesAfter}
              className="absolute"
              style={{
                top: 2 + bar.lane * BAND_LANE_HEIGHT,
                height: BAND_LANE_HEIGHT - 4,
                left: `calc(${(bar.startIndex / props.days.length) * 100}% + 2px)`,
                width: `calc(${((bar.endIndex - bar.startIndex + 1) / props.days.length) * 100}% - 4px)`,
              }}
            />
          ))}
        </div>
      </div>

      {/* The 24-hour body. */}
      <div ref={bodyRef} data-testid="calendar-hours" className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex" style={{ height: bodyHeight }}>
          <div className={cn(GUTTER_CLASS, "relative")} aria-hidden>
            {HOURS.map((hour) => (
              <div key={hour} style={{ height: hourHeight }} className="relative">
                {/* The label sits on the line it names, not inside the slot below it. */}
                <span className="absolute -top-1.5 right-2 text-[10px] tabular-nums text-text-faint">
                  {hour === 0 ? "" : formatHour(hour)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-1">
            {props.days.map((day) => (
              <DayColumn
                key={dayKey(day)}
                day={day}
                now={now}
                events={props.events}
                hourHeight={hourHeight}
                fullWidth={singleDay}
                colorOf={props.colorOf}
                openEventId={props.openEventId}
                onOpenEvent={props.onOpenEvent}
              />
            ))}
          </div>

          {nowPercent !== null && (
            <NowLine days={props.days} today={props.today} now={now} percent={nowPercent} />
          )}
        </div>
      </div>
    </div>
  );
}

function DayColumn(props: {
  day: Date;
  now: Date;
  events: CalendarEvent[];
  hourHeight: number;
  /** The Day view has one column, so its blocks need no right-hand gap. */
  fullWidth: boolean;
  colorOf: (calendarId: string) => string;
  openEventId: string | null;
  onOpenEvent: (id: string) => void;
}) {
  const blocks = useMemo(
    () => layoutDayGrid(props.events, props.day, props.fullWidth ? { rightGapPercent: 0 } : {}),
    [props.events, props.day, props.fullWidth],
  );
  const height = 24 * props.hourHeight;

  return (
    <div
      data-testid="calendar-day-column"
      data-day={dayKey(props.day)}
      className={cn(
        "relative min-w-0 flex-1 border-r border-calendar-line last:border-r-0",
        isWeekend(props.day) && "bg-calendar-weekend",
      )}
      style={{ height }}
    >
      {/* Hour lines. */}
      <div className="absolute inset-0" aria-hidden>
        {HOURS.map((hour) => (
          <div
            key={hour}
            style={{ height: props.hourHeight }}
            className="border-t border-calendar-line first:border-t-0"
          />
        ))}
      </div>

      {blocks.map((block) => {
        const blockHeight = (block.height / 100) * height;
        return (
          <EventBlock
            key={block.event.id}
            event={block.event}
            color={props.colorOf(block.event.calendar_id)}
            selected={props.openEventId === block.event.id}
            past={isPast(block.event, props.now)}
            onOpen={props.onOpenEvent}
            // Under about 40 minutes there is only room for one line, and the title is
            // the line worth keeping.
            compact={blockHeight < 34}
            // A quarter of an hour is 12px at the shortest hour row, which is less than
            // one padded line: the title then has to take the whole block.
            tight={blockHeight < TIGHT_BLOCK_HEIGHT}
            className="absolute"
            style={{
              top: `${block.top}%`,
              height: `${block.height}%`,
              left: `${block.left}%`,
              width: `${block.width}%`,
              // Later columns of a cascade paint over earlier ones, which is what makes
              // the overlap read as depth rather than as a collision.
              zIndex: 10 + block.column,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * The "now" line: a badge in the gutter, a solid rule across today's column and a
 * hairline across the rest.
 *
 * Drawn as one overlay over the whole body rather than per column, so the line is
 * continuous — the version that stops at today's edges reads as an event, not as a
 * time.
 */
function NowLine(props: { days: Date[]; today: Date; now: Date; percent: number }) {
  return (
    <div
      data-testid="calendar-now-line"
      className="pointer-events-none absolute inset-x-0 z-20 flex -translate-y-1/2 items-center"
      style={{ top: `${props.percent}%` }}
      aria-hidden
    >
      <div className={cn(GUTTER_CLASS, "flex justify-end pr-1")}>
        <span className="whitespace-nowrap rounded-[3px] bg-destructive px-1 py-px text-[10px] font-medium leading-tight tabular-nums text-white">
          {props.now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      </div>
      <div className="flex min-w-0 flex-1">
        {props.days.map((day) => (
          <div
            key={dayKey(day)}
            className={cn(
              "flex-1 bg-destructive",
              isSameDay(day, props.today) ? "h-[2px] rounded-full" : "h-px opacity-40",
            )}
          />
        ))}
      </div>
    </div>
  );
}

/** A clock that ticks once a minute — enough for a line that moves 1px every 90
 *  seconds, and cheap enough to leave running while the calendar is on screen. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** An hour label in the viewer's locale ("09:00" or "9 AM"). */
function formatHour(hour: number): string {
  return new Date(2026, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}
