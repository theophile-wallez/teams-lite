import { useEffect, useMemo, useRef } from "react";
import {
  dayKey,
  isSameDay,
  layoutDayBand,
  layoutDayGrid,
  nowIndicatorPercent,
} from "~/lib/calendar";
import type { CalendarEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { EventBlock } from "./calendar-event";

// The hour grid, shared by the Week and Day views: an all-day band pinned above a
// scrollable 24-hour body, with one column per day.
//
// Timed blocks are absolutely positioned from percentages computed by
// `layoutDayGrid`, which also resolves overlaps into side-by-side columns — three
// meetings at 10:00 take a third of the width each, because a stack of full-width
// blocks would hide two of them entirely.

/** Height of one hour row. Chosen so a 30-minute meeting still has room for its
 *  title on one line, and a working day fits a laptop viewport without scrolling. */
const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Where the body scrolls to on first paint when the range does not include today:
 *  the start of a working day, not midnight. */
const DEFAULT_SCROLL_HOUR = 8;
/** Height of one all-day bar in the band. */
const BAND_BAR_HEIGHT = 20;
/** Width of the hour gutter. Also the left inset of the band, so its bars line up
 *  with the columns beneath them. */
const GUTTER_CLASS = "w-14 shrink-0";

export function CalendarTimeGrid(props: {
  days: Date[];
  today: Date;
  events: CalendarEvent[];
  colorOf: (calendarId: string) => string;
  onOpenEvent: (id: string) => void;
  onPickDay: (day: Date) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bars = useMemo(() => layoutDayBand(props.events, props.days), [props.events, props.days]);
  const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0);

  // Open on the interesting part of the day rather than on midnight: the current
  // hour when today is on screen, else the start of the working day. Runs once per
  // range change, and only moves the scroll position — never the layout.
  const rangeKey = props.days.map(dayKey).join(",");
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const showsToday = props.days.some((day) => isSameDay(day, props.today));
    const hour = showsToday ? Math.max(0, props.today.getHours() - 1) : DEFAULT_SCROLL_HOUR;
    // Back off a few pixels so the topmost hour label — which sits just ABOVE the
    // line it names — is not clipped by the band above it.
    body.scrollTop = Math.max(0, hour * HOUR_HEIGHT - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the range, not the Date identities
  }, [rangeKey]);

  return (
    <div data-testid="calendar-time-grid" className="flex min-h-0 flex-1 flex-col">
      {/* Day headers. */}
      <div className="flex shrink-0 border-b border-border-subtle">
        <div className={GUTTER_CLASS} aria-hidden />
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
              className="flex min-w-0 flex-1 flex-col items-center gap-0.5 border-r border-border-subtle px-1 py-2 transition-colors last:border-r-0 hover:bg-accent"
            >
              <span className="truncate text-[11px] uppercase tracking-wide text-text-faint">
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span
                className={cn(
                  "grid size-6 place-items-center rounded-full text-[13px] font-medium tabular-nums",
                  today ? "bg-primary text-primary-foreground" : "text-foreground",
                )}
              >
                {day.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      {/* The all-day band. Only takes space when there is something in it. */}
      {laneCount > 0 && (
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
            style={{ height: laneCount * BAND_BAR_HEIGHT + 6 }}
          >
            {/* Column separators, so the band reads as part of the grid. */}
            <div className="absolute inset-0 flex" aria-hidden>
              {props.days.map((day) => (
                <div key={dayKey(day)} className="flex-1 border-r border-border-subtle last:border-r-0" />
              ))}
            </div>
            {bars.map((bar) => (
              <EventBlock
                key={bar.event.id}
                event={bar.event}
                color={props.colorOf(bar.event.calendar_id)}
                onOpen={props.onOpenEvent}
                continuesBefore={bar.continuesBefore}
                continuesAfter={bar.continuesAfter}
                className="absolute"
                style={{
                  top: 3 + bar.lane * BAND_BAR_HEIGHT,
                  height: BAND_BAR_HEIGHT - 3,
                  left: `calc(${(bar.startIndex / props.days.length) * 100}% + 3px)`,
                  width: `calc(${((bar.endIndex - bar.startIndex + 1) / props.days.length) * 100}% - 6px)`,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* The 24-hour body. */}
      <div ref={bodyRef} data-testid="calendar-hours" className="flex min-h-0 flex-1 overflow-y-auto">
        <div className={cn(GUTTER_CLASS, "relative")} aria-hidden>
          {HOURS.map((hour) => (
            <div key={hour} style={{ height: HOUR_HEIGHT }} className="relative">
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
              today={props.today}
              events={props.events}
              colorOf={props.colorOf}
              onOpenEvent={props.onOpenEvent}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn(props: {
  day: Date;
  today: Date;
  events: CalendarEvent[];
  colorOf: (calendarId: string) => string;
  onOpenEvent: (id: string) => void;
}) {
  const blocks = useMemo(() => layoutDayGrid(props.events, props.day), [props.events, props.day]);
  const nowPercent = nowIndicatorPercent(props.day, props.today);
  const height = 24 * HOUR_HEIGHT;

  return (
    <div
      data-testid="calendar-day-column"
      data-day={dayKey(props.day)}
      className="relative min-w-0 flex-1 border-r border-border-subtle last:border-r-0"
      style={{ height }}
    >
      {/* Hour lines. */}
      <div className="absolute inset-0" aria-hidden>
        {HOURS.map((hour) => (
          <div
            key={hour}
            style={{ height: HOUR_HEIGHT }}
            className="border-t border-border-subtle first:border-t-0"
          />
        ))}
      </div>

      {blocks.map((block) => (
        <EventBlock
          key={block.event.id}
          event={block.event}
          color={props.colorOf(block.event.calendar_id)}
          onOpen={props.onOpenEvent}
          showTime={block.height * height > 3600}
          className="absolute"
          style={{
            top: `${block.top}%`,
            height: `${block.height}%`,
            // Overlapping meetings tile the column; a small right inset keeps the
            // last one clear of the next day's border.
            left: `calc(${(block.column / block.columns) * 100}% + 2px)`,
            width: `calc(${(1 / block.columns) * 100}% - 4px)`,
          }}
        />
      ))}

      {nowPercent !== null && (
        <div
          data-testid="calendar-now-line"
          className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
          style={{ top: `${nowPercent}%` }}
          aria-hidden
        >
          <span className="-ml-1 size-2 shrink-0 rounded-full bg-destructive" />
          <span className="h-px flex-1 bg-destructive" />
        </div>
      )}
    </div>
  );
}

/** An hour label in the viewer's locale ("09:00" or "9 AM"). */
function formatHour(hour: number): string {
  return new Date(2026, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}
