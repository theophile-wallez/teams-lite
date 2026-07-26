import { useEffect, useMemo, useRef, useState } from "react";
import {
  MONTH_DAY_HEADER_HEIGHT,
  MONTH_SLOT_HEIGHT,
  dayKey,
  isPast,
  isSameDay,
  isSameMonth,
  isWeekend,
  isoWeekNumber,
  layoutMonthRow,
  monthGridDays,
  monthSlotCount,
  weeksOf,
  workdaysOnly,
  type MonthRow,
} from "~/lib/calendar";
import type { CalendarEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { EventBar, EventItem } from "./calendar-event";

// The month grid: a fixed 6×7 matrix, so its height never jumps between months.
//
// After the reference design (calendarcn / Notion Calendar): day numbers on the RIGHT,
// the first of a month labelled with the month's name, weekends washed, and the
// leading/trailing days of the neighbouring months present but muted rather than
// blanked. Two kinds of thing are drawn per row, and the difference is what makes the
// grid readable:
//   - BARS for all-day and multi-day events, laid out in lanes across the row so a
//     week of leave is one continuous line rather than five disconnected chips;
//   - ITEMS for the timed events of a single day, listed under the bars.
//
// How many of either fit is MEASURED, not guessed: the cell height depends on the
// viewport, so the grid observes its own size, works out a slot budget, and lets
// `layoutMonthRow` share that budget between the row's bars and each day's own events.
// The "+N more" that follows is therefore always exactly right, which the previous
// fixed cap of three was not.

/** Width of the optional ISO week-number column. */
const WEEK_NUMBER_WIDTH = 30;
/** Fallback cell size for the first paint, before the grid has been measured. */
const ESTIMATED_CELL_HEIGHT = 120;
const ESTIMATED_CELL_WIDTH = 120;
/** Under this, a cell's rows drop the start time and keep the title. */
const NARROW_CELL_WIDTH = 92;

export function CalendarMonth(props: {
  anchor: Date;
  today: Date;
  events: CalendarEvent[];
  weekStartsOn: number;
  showWeekends: boolean;
  showWeekNumbers: boolean;
  colorOf: (calendarId: string) => string;
  openEventId: string | null;
  onOpenEvent: (id: string) => void;
  /** Clicking a day's number — or its "+N more" — opens that day. */
  onPickDay: (day: Date) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState({ height: ESTIMATED_CELL_HEIGHT, width: ESTIMATED_CELL_WIDTH });

  const weeks = useMemo(
    () => weeksOf(monthGridDays(props.anchor, props.weekStartsOn)).map((week) => ({
      days: workdaysOnly(week, props.showWeekends),
      weekNumber: isoWeekNumber(week[0]!),
    })),
    [props.anchor, props.weekStartsOn, props.showWeekends],
  );
  const labels = useMemo(
    () => workdaysOnly(monthGridDays(props.anchor, props.weekStartsOn).slice(0, 7), props.showWeekends)
      .map((day) => day.toLocaleDateString(undefined, { weekday: "short" })),
    [props.anchor, props.weekStartsOn, props.showWeekends],
  );

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () =>
      setCell({
        height: grid.clientHeight / Math.max(1, weeks.length),
        width: grid.clientWidth / Math.max(1, labels.length),
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [weeks.length, labels.length]);

  const slots = monthSlotCount(cell.height);
  // On a phone a cell is ~55px wide: there is room for a title OR a time, and the title
  // is the one that identifies the meeting. Measured rather than keyed off a breakpoint,
  // because the same pane is narrow on a split desktop window too.
  const hideItemTime = cell.width < NARROW_CELL_WIDTH;
  const columns = `${props.showWeekNumbers ? `${WEEK_NUMBER_WIDTH}px ` : ""}repeat(${labels.length}, minmax(0, 1fr))`;

  return (
    <div data-testid="calendar-month" className="flex min-h-0 flex-1 flex-col">
      <div
        className="grid shrink-0 border-b border-border-subtle"
        style={{ gridTemplateColumns: columns }}
      >
        {props.showWeekNumbers && (
          <div className="py-1.5 text-center text-[10px] font-medium uppercase text-text-faint">W</div>
        )}
        {labels.map((label) => (
          <div
            key={label}
            className="truncate px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-text-faint"
          >
            {label}
          </div>
        ))}
      </div>

      <div ref={gridRef} className="grid min-h-0 flex-1 auto-rows-fr">
        {weeks.map((week) => (
          <MonthWeek
            key={dayKey(week.days[0]!)}
            days={week.days}
            weekNumber={week.weekNumber}
            columns={columns}
            slots={slots}
            hideItemTime={hideItemTime}
            anchor={props.anchor}
            today={props.today}
            events={props.events}
            showWeekNumbers={props.showWeekNumbers}
            colorOf={props.colorOf}
            openEventId={props.openEventId}
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
  weekNumber: number;
  columns: string;
  slots: number;
  hideItemTime: boolean;
  anchor: Date;
  today: Date;
  events: CalendarEvent[];
  showWeekNumbers: boolean;
  colorOf: (calendarId: string) => string;
  openEventId: string | null;
  onOpenEvent: (id: string) => void;
  onPickDay: (day: Date) => void;
}) {
  const row: MonthRow = useMemo(
    () => layoutMonthRow(props.events, props.days, props.slots),
    [props.events, props.days, props.slots],
  );
  const barsHeight = row.laneCount * MONTH_SLOT_HEIGHT;

  return (
    <div
      className="relative grid min-h-0 border-b border-border-subtle last:border-b-0"
      style={{ gridTemplateColumns: props.columns }}
    >
      {props.showWeekNumbers && (
        <div
          data-testid="calendar-week-number"
          className="border-r border-border-subtle pt-1.5 text-center text-[10px] tabular-nums text-text-faint"
        >
          {props.weekNumber}
        </div>
      )}

      {row.cells.map((cell) => {
        const outside = !isSameMonth(cell.day, props.anchor);
        const today = isSameDay(cell.day, props.today);
        const firstOfMonth = cell.day.getDate() === 1;
        return (
          <div
            key={dayKey(cell.day)}
            data-testid="calendar-day"
            data-day={dayKey(cell.day)}
            data-today={today ? "true" : undefined}
            data-outside={outside ? "true" : undefined}
            className={cn(
              "flex min-w-0 flex-col overflow-hidden border-r border-border-subtle last:border-r-0",
              isWeekend(cell.day) && "bg-calendar-weekend",
            )}
          >
            <div
              className="flex shrink-0 items-center justify-end px-1"
              style={{ height: MONTH_DAY_HEADER_HEIGHT }}
            >
              <button
                type="button"
                onClick={() => props.onPickDay(cell.day)}
                aria-label={cell.day.toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
                className={cn(
                  "flex h-[19px] min-w-[19px] items-center gap-1 rounded-md px-1 text-[11px] font-medium tabular-nums transition-colors",
                  today
                    ? "bg-primary text-primary-foreground"
                    : outside
                      ? "text-text-faint hover:bg-accent hover:text-foreground"
                      : "text-text-dim hover:bg-accent hover:text-foreground",
                )}
              >
                {/* The 1st says which month it opens — the one day where a bare number
                    is ambiguous in a grid that shows three months' worth of them. */}
                {firstOfMonth && (
                  <span className="font-semibold">
                    {cell.day.toLocaleDateString(undefined, { month: "short" })}
                  </span>
                )}
                {cell.day.getDate()}
              </button>
            </div>

            {/* Space kept clear for this row's bars, which are absolutely positioned
                over the whole row rather than per cell. */}
            <div style={{ height: barsHeight }} aria-hidden />

            <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden px-0.5 pb-0.5">
              {cell.items.map((event) => (
                <EventItem
                  key={event.id}
                  event={event}
                  color={props.colorOf(event.calendar_id)}
                  selected={props.openEventId === event.id}
                  past={isPast(event, props.today)}
                  hideTime={props.hideItemTime}
                  onOpen={props.onOpenEvent}
                  className="shrink-0"
                  style={{ height: MONTH_SLOT_HEIGHT - 1 }}
                />
              ))}
              {cell.hidden > 0 && (
                <button
                  type="button"
                  data-testid="calendar-day-more"
                  onClick={() => props.onPickDay(cell.day)}
                  style={{ height: MONTH_SLOT_HEIGHT - 1 }}
                  className="shrink-0 truncate rounded-[4px] px-1.5 text-left text-[11px] font-semibold text-text-dim transition-colors hover:bg-accent hover:text-foreground"
                >
                  {cell.hidden} more
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* The row's all-day / multi-day bars, spanning columns. Inset past the
          week-number gutter so their percentages are of the day columns alone. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0"
        style={{ left: props.showWeekNumbers ? WEEK_NUMBER_WIDTH : 0 }}
      >
        {row.bars.map((bar) => (
          <EventBar
            key={bar.event.id}
            event={bar.event}
            color={props.colorOf(bar.event.calendar_id)}
            selected={props.openEventId === bar.event.id}
            past={isPast(bar.event, props.today)}
            onOpen={props.onOpenEvent}
            continuesBefore={bar.continuesBefore}
            continuesAfter={bar.continuesAfter}
            className="pointer-events-auto absolute"
            style={{
              top: MONTH_DAY_HEADER_HEIGHT + bar.lane * MONTH_SLOT_HEIGHT,
              height: MONTH_SLOT_HEIGHT - 2,
              left: `calc(${(bar.startIndex / props.days.length) * 100}% + 2px)`,
              width: `calc(${((bar.endIndex - bar.startIndex + 1) / props.days.length) * 100}% - 4px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
