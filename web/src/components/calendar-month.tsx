import { useMemo } from "react";
import {
  compareForDisplay,
  dayKey,
  eventSpan,
  eventsForDay,
  isSameDay,
  isSameMonth,
  layoutDayBand,
  monthGridDays,
  weekdayLabels,
  weeksOf,
} from "~/lib/calendar";
import type { CalendarEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { EventBlock, EventChip } from "./calendar-event";

// The month grid: the reference design's fixed 6×7 matrix, with the leading and
// trailing days of the neighbouring months dimmed rather than blanked.
//
// Two kinds of thing are drawn per week row, and the difference is what makes the
// grid readable:
//   - BARS for all-day and multi-day events, laid out in lanes across the row so a
//     week of leave is one continuous line rather than five disconnected chips (see
//     `layoutDayBand`);
//   - CHIPS for the timed events of a single day, listed under the bars.
// Both are computed per row, which is why each row reserves exactly as much height
// for bars as its own bars need.

/** Height of one all-day bar, and of one timed chip, in pixels. Fixed so a row can
 *  work out how many chips fit under its bars. */
const BAR_HEIGHT = 18;
const CHIP_HEIGHT = 18;
/** Room for the day number above everything else. */
const DAY_NUMBER_HEIGHT = 22;

export function CalendarMonth(props: {
  anchor: Date;
  today: Date;
  events: CalendarEvent[];
  weekStartsOn: number;
  colorOf: (calendarId: string) => string;
  onOpenEvent: (id: string) => void;
  /** Clicking a day's number opens that day. */
  onPickDay: (day: Date) => void;
}) {
  const weeks = useMemo(
    () => weeksOf(monthGridDays(props.anchor, props.weekStartsOn)),
    [props.anchor, props.weekStartsOn],
  );
  const labels = useMemo(() => weekdayLabels(props.weekStartsOn), [props.weekStartsOn]);

  return (
    <div data-testid="calendar-month" className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-border-subtle">
        {labels.map((label) => (
          <div
            key={label}
            className="truncate px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-text-faint"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-fr">
        {weeks.map((week) => (
          <MonthWeek
            key={dayKey(week[0]!)}
            days={week}
            anchor={props.anchor}
            today={props.today}
            events={props.events}
            colorOf={props.colorOf}
            onOpenEvent={props.onOpenEvent}
            onPickDay={props.onPickDay}
          />
        ))}
      </div>
    </div>
  );
}

function MonthWeek(props: {
  days: Date[];
  anchor: Date;
  today: Date;
  events: CalendarEvent[];
  colorOf: (calendarId: string) => string;
  onOpenEvent: (id: string) => void;
  onPickDay: (day: Date) => void;
}) {
  const bars = useMemo(() => layoutDayBand(props.events, props.days), [props.events, props.days]);
  const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0);

  // Timed events per day, in display order, excluding whatever the bars already show.
  const timedByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const day of props.days) {
      const timed = eventsForDay(props.events, day)
        .filter((event) => !eventSpan(event).banded)
        .sort(compareForDisplay);
      map.set(dayKey(day), timed);
    }
    return map;
  }, [props.events, props.days]);

  return (
    <div className="relative grid min-h-0 grid-cols-7 border-b border-border-subtle last:border-b-0">
      {props.days.map((day) => {
        const outside = !isSameMonth(day, props.anchor);
        const today = isSameDay(day, props.today);
        const timed = timedByDay.get(dayKey(day)) ?? [];
        return (
          <div
            key={dayKey(day)}
            data-testid="calendar-day"
            data-day={dayKey(day)}
            data-today={today ? "true" : undefined}
            data-outside={outside ? "true" : undefined}
            className={cn(
              "flex min-w-0 flex-col overflow-hidden border-r border-border-subtle last:border-r-0",
              outside && "bg-element/40",
            )}
          >
            <div className="flex shrink-0 items-center justify-center px-1 pt-1">
              <button
                type="button"
                onClick={() => props.onPickDay(day)}
                aria-label={day.toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
                className={cn(
                  "grid size-[22px] place-items-center rounded-full text-[11px] font-medium tabular-nums transition-colors",
                  today
                    ? "bg-primary text-primary-foreground"
                    : outside
                      ? "text-text-faint hover:bg-accent hover:text-foreground"
                      : "text-text-dim hover:bg-accent hover:text-foreground",
                )}
              >
                {day.getDate()}
              </button>
            </div>
            {/* Space kept clear for this row's bars, which are absolutely
                positioned over the whole row rather than per cell. */}
            <div style={{ height: laneCount * BAR_HEIGHT }} aria-hidden />
            <DayChips
              events={timed}
              colorOf={props.colorOf}
              onOpenEvent={props.onOpenEvent}
              onPickDay={() => props.onPickDay(day)}
            />
          </div>
        );
      })}

      {/* The row's all-day / multi-day bars, spanning columns. */}
      {bars.map((bar) => (
        <EventBlock
          key={bar.event.id}
          event={bar.event}
          color={props.colorOf(bar.event.calendar_id)}
          onOpen={props.onOpenEvent}
          continuesBefore={bar.continuesBefore}
          continuesAfter={bar.continuesAfter}
          className="absolute z-10"
          style={{
            top: DAY_NUMBER_HEIGHT + 4 + bar.lane * BAR_HEIGHT,
            height: BAR_HEIGHT - 3,
            left: `calc(${(bar.startIndex / 7) * 100}% + 3px)`,
            width: `calc(${((bar.endIndex - bar.startIndex + 1) / 7) * 100}% - 6px)`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * A day cell's timed events, capped by the space available.
 *
 * The cap is measured, not guessed: the cell is a flex child of a fractional grid
 * row, so how many chips fit depends on the viewport. A container query would be
 * ideal; instead the list scrolls when it overflows and the overflow is announced by
 * a "+N" affordance that opens the day — which is both simpler and never wrong.
 */
function DayChips(props: {
  events: CalendarEvent[];
  colorOf: (calendarId: string) => string;
  onOpenEvent: (id: string) => void;
  onPickDay: () => void;
}) {
  const MAX_VISIBLE = 3;
  const shown = props.events.slice(0, MAX_VISIBLE);
  const hidden = props.events.length - shown.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden px-0.5 pb-0.5">
      {shown.map((event) => (
        <EventChip
          key={event.id}
          event={event}
          color={props.colorOf(event.calendar_id)}
          onOpen={props.onOpenEvent}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          data-testid="calendar-day-more"
          onClick={props.onPickDay}
          style={{ height: CHIP_HEIGHT }}
          className="shrink-0 truncate rounded-md px-1.5 text-left text-[11px] font-medium text-text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          +{hidden} more
        </button>
      )}
    </div>
  );
}
