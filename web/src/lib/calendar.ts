// Calendar geometry: the pure date and layout math behind the calendar views.
//
// Everything here is a plain function of its inputs — no React, no store, no clock
// except where a `now` is passed in — so the awkward parts (which days a month grid
// shows, where two overlapping meetings sit, which lane a week of leave takes) are
// unit-tested instead of eyeballed in a browser.
//
// TWO TIME MODELS, and keeping them apart is the whole trick:
//
//   - A TIMED event is an instant range. The backend sends UTC; `Date.parse` turns
//     that into a local instant and every view positions it in local time. A 09:00
//     UTC meeting is at 11:00 in Paris, which is correct and what the user expects.
//
//   - An ALL-DAY event is not an instant range at all, it is a run of DATES. Graph
//     expresses it as midnight-to-midnight UTC with an exclusive end, and converting
//     those to local instants is exactly how a holiday slides onto the wrong day
//     west of Greenwich. So all-day events are read from the DATE PART of the
//     timestamp only ([`eventSpan`]) and pinned to those calendar dates.
//
// Days are identified by a local `YYYY-MM-DD` key throughout ([`dayKey`]), never by
// an index into an array or a UTC date part.

import type { CalendarEvent } from "./protocol";

/** Which views the calendar offers. */
export type CalendarViewMode = "month" | "week" | "day" | "agenda";

/**
 * The first day of the week, as a `Date.getDay()` value (0 = Sunday).
 *
 * Monday, matching Outlook and Teams in this tenant's locale — the reference design
 * this UI follows draws a Sunday-first grid, but the week's first day is a locale
 * property rather than a design one. Every function below takes it as an argument, so
 * switching is a one-line change and both orders are covered by tests.
 */
export const WEEK_STARTS_ON = 1;

/** How many days a month grid always shows: six weeks, so its height never jumps
 *  between months (the reference design's 6×7 matrix). */
export const MONTH_GRID_DAYS = 42;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- days ------------------------------------------------------------------

/** Local `YYYY-MM-DD` for a date. The identity of a day everywhere in the calendar. */
export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local midnight at the start of `date`'s day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `n` days after `date`, at local midnight. Uses the calendar-date constructor
 *  rather than millisecond arithmetic, so a DST transition never lands the result on
 *  23:00 the previous day. */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** `n` months after `date`, clamped to the last day of the target month (so a step
 *  from 31 January lands on 28/29 February rather than skipping into March). */
export function addMonths(date: Date, n: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
}

/** Local midnight on the first day of `date`'s week. */
export function startOfWeek(date: Date, weekStartsOn: number = WEEK_STARTS_ON): Date {
  const day = startOfDay(date);
  const shift = (day.getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -shift);
}

/** Local midnight on the first of `date`'s month. */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Whether two dates fall on the same local day. */
export function isSameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

/** Whether `date` is in `anchor`'s month — what dims a month grid's leading and
 *  trailing days. */
export function isSameMonth(date: Date, anchor: Date): boolean {
  return date.getFullYear() === anchor.getFullYear() && date.getMonth() === anchor.getMonth();
}

/** The weekday headers, in the grid's own order, as short locale names. */
export function weekdayLabels(weekStartsOn: number = WEEK_STARTS_ON): string[] {
  // Any week will do; 2026-03-01 was a Sunday, so offsetting from it gives every
  // weekday in order without depending on today's date.
  const sunday = new Date(2026, 2, 1);
  return Array.from({ length: 7 }, (_, i) =>
    addDays(sunday, (weekStartsOn + i) % 7).toLocaleDateString(undefined, { weekday: "short" }),
  );
}

/** The 42 days a month grid shows: `anchor`'s month plus the leading and trailing
 *  days that complete six weeks. */
export function monthGridDays(anchor: Date, weekStartsOn: number = WEEK_STARTS_ON): Date[] {
  const first = startOfWeek(startOfMonth(anchor), weekStartsOn);
  return Array.from({ length: MONTH_GRID_DAYS }, (_, i) => addDays(first, i));
}

/** Split a flat list of grid days into weeks of seven. */
export function weeksOf(days: Date[]): Date[][] {
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

// ---- the visible range -----------------------------------------------------

/** A half-open `[start, end)` range of local days. */
export type DayRange = { start: Date; end: Date };

/** The days a view covers: the whole 6-week grid for a month, seven days for a week,
 *  one for a day, and a fortnight from the anchor for the agenda. */
export function visibleRange(
  mode: CalendarViewMode,
  anchor: Date,
  weekStartsOn: number = WEEK_STARTS_ON,
): DayRange {
  switch (mode) {
    case "month": {
      const days = monthGridDays(anchor, weekStartsOn);
      return { start: days[0]!, end: addDays(days[days.length - 1]!, 1) };
    }
    case "week": {
      const start = startOfWeek(anchor, weekStartsOn);
      return { start, end: addDays(start, 7) };
    }
    case "day": {
      const start = startOfDay(anchor);
      return { start, end: addDays(start, 1) };
    }
    case "agenda": {
      const start = startOfDay(anchor);
      return { start, end: addDays(start, AGENDA_DAYS) };
    }
  }
}

/** How far ahead the agenda list looks. Two weeks: long enough to be a plan, short
 *  enough that its months are one cache unit on the backend. */
export const AGENDA_DAYS = 14;

/** Every day in a range, as local midnights. */
export function daysIn(range: DayRange): Date[] {
  const days: Date[] = [];
  for (let day = range.start; day < range.end; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The range to ask the backend for: the visible range as ISO 8601 UTC instants.
 *
 *  The local range is converted honestly rather than truncated to dates — the backend
 *  stores UTC, and the first hours of a local day belong to the previous UTC one. The
 *  backend widens whatever it gets to whole calendar months anyway (its cache unit),
 *  so this only has to be correct, not aligned. */
export function requestRange(range: DayRange): { start: string; end: string } {
  return { start: toIsoSeconds(range.start), end: toIsoSeconds(range.end) };
}

/** An ISO 8601 UTC timestamp truncated to whole seconds — the shape the backend and
 *  the store use everywhere (see `graph_time` on the Rust side). */
export function toIsoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Move the anchor one view forward or back (`delta` of ±1). */
export function shiftAnchor(
  mode: CalendarViewMode,
  anchor: Date,
  delta: number,
  weekStartsOn: number = WEEK_STARTS_ON,
): Date {
  switch (mode) {
    case "month":
      return addMonths(startOfMonth(anchor), delta);
    case "week":
      return addDays(startOfWeek(anchor, weekStartsOn), delta * 7);
    case "day":
      return addDays(anchor, delta);
    case "agenda":
      return addDays(anchor, delta * AGENDA_DAYS);
  }
}

// ---- event spans -----------------------------------------------------------

/** An event resolved to local millisecond bounds, plus how it should be laid out. */
export type EventSpan = {
  /** Local instant the event begins. */
  startMs: number;
  /** Local instant the event ends, EXCLUSIVE. Never less than `startMs`. */
  endMs: number;
  /** Whether the event belongs in the all-day band rather than the hour grid: an
   *  actual all-day event, or a timed one that crosses midnight and so cannot be
   *  drawn as a block in a single day column. */
  banded: boolean;
};

/**
 * Resolve an event to local bounds.
 *
 * All-day events are read from the DATE PART of their timestamps and pinned to those
 * calendar dates — see the two time models in this module's header. Timed events are
 * parsed as the UTC instants they are.
 */
export function eventSpan(event: Pick<CalendarEvent, "start" | "end" | "is_all_day">): EventSpan {
  if (event.is_all_day) {
    const start = localMidnightFromDatePart(event.start);
    const end = localMidnightFromDatePart(event.end);
    // Graph's all-day end is exclusive; a malformed or equal end still has to cover
    // at least the first day, or the event would be invisible.
    const safeEnd = end > start ? end : start + DAY_MS;
    return { startMs: start, endMs: safeEnd, banded: true };
  }
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const startMs = Number.isFinite(start) ? start : 0;
  const endMs = Number.isFinite(end) && end > startMs ? end : startMs;
  // A timed event that crosses midnight cannot be a block in one day's column, so it
  // rides in the all-day band like a multi-day event does.
  const banded = dayKey(new Date(startMs)) !== dayKey(new Date(Math.max(startMs, endMs - 1)));
  return { startMs, endMs, banded };
}

/** Local midnight for the `YYYY-MM-DD` part of a timestamp, as epoch ms. */
function localMidnightFromDatePart(timestamp: string): number {
  const [year, month, day] = timestamp.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return 0;
  return new Date(year, month - 1, day).getTime();
}

/** Whether an event overlaps `[start, end)` of local instants. Mirrors the backend's
 *  own overlap rule, zero-length events included (see `calendar::overlaps` in Rust). */
export function spanOverlaps(span: EventSpan, startMs: number, endMs: number): boolean {
  return span.startMs < endMs && (span.endMs > startMs || span.startMs >= startMs);
}

/** Whether an event touches a given local day. */
export function eventTouchesDay(
  event: Pick<CalendarEvent, "start" | "end" | "is_all_day">,
  day: Date,
): boolean {
  const dayStart = startOfDay(day).getTime();
  return spanOverlaps(eventSpan(event), dayStart, dayStart + DAY_MS);
}

/** The events that touch a day, earliest first — banded ones before timed ones, the
 *  order every view lists them in. */
export function eventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  return events.filter((event) => eventTouchesDay(event, day)).sort(compareForDisplay);
}

/** Display order within a day: all-day and multi-day events first (they are the
 *  day's context), then by start, then longest first, then by id for stability. */
export function compareForDisplay(a: CalendarEvent, b: CalendarEvent): number {
  const spanA = eventSpan(a);
  const spanB = eventSpan(b);
  if (spanA.banded !== spanB.banded) return spanA.banded ? -1 : 1;
  if (spanA.startMs !== spanB.startMs) return spanA.startMs - spanB.startMs;
  const lengthA = spanA.endMs - spanA.startMs;
  const lengthB = spanB.endMs - spanB.startMs;
  if (lengthA !== lengthB) return lengthB - lengthA;
  return a.id.localeCompare(b.id);
}

// ---- the all-day band ------------------------------------------------------

/**
 * One event drawn as a horizontal bar across a row of days.
 *
 * `startIndex`/`endIndex` are inclusive column indices into the row that was laid
 * out, already clipped to it; `continuesBefore`/`continuesAfter` say the event
 * extends past the clip, which is what lets the bar be drawn with an open edge
 * instead of pretending the week is the whole event.
 */
export type DayBandBar = {
  event: CalendarEvent;
  startIndex: number;
  endIndex: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

/**
 * Lay out the banded events of a row of consecutive days into lanes.
 *
 * Greedy by display order: each bar takes the lowest lane free for every column it
 * covers, so a long event keeps one straight line across the row and short ones fill
 * in beneath it. That is the arrangement every calendar uses, and the reason it has to
 * be computed rather than left to the DOM: two bars in the same lane would overlap.
 */
export function layoutDayBand(events: CalendarEvent[], days: Date[]): DayBandBar[] {
  if (days.length === 0) return [];
  const rowStart = startOfDay(days[0]!).getTime();
  const rowEnd = addDays(startOfDay(days[days.length - 1]!), 1).getTime();

  const banded = events
    .filter((event) => eventSpan(event).banded)
    .filter((event) => spanOverlaps(eventSpan(event), rowStart, rowEnd))
    .sort(compareForDisplay);

  /** Which columns each lane has taken. */
  const lanes: boolean[][] = [];
  const bars: DayBandBar[] = [];

  for (const event of banded) {
    const span = eventSpan(event);
    const startIndex = days.findIndex((day) => {
      const dayStart = startOfDay(day).getTime();
      return spanOverlaps(span, dayStart, dayStart + DAY_MS);
    });
    if (startIndex < 0) continue;
    let endIndex = startIndex;
    for (let i = days.length - 1; i >= startIndex; i--) {
      const dayStart = startOfDay(days[i]!).getTime();
      if (spanOverlaps(span, dayStart, dayStart + DAY_MS)) {
        endIndex = i;
        break;
      }
    }

    let lane = 0;
    for (;;) {
      if (!lanes[lane]) lanes[lane] = [];
      const taken = lanes[lane]!;
      let free = true;
      for (let i = startIndex; i <= endIndex; i++) {
        if (taken[i]) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let i = startIndex; i <= endIndex; i++) taken[i] = true;
        break;
      }
      lane++;
    }

    bars.push({
      event,
      startIndex,
      endIndex,
      lane,
      continuesBefore: span.startMs < rowStart,
      continuesAfter: span.endMs > rowEnd,
    });
  }
  return bars;
}

// ---- the hour grid ---------------------------------------------------------

/**
 * One timed event positioned in a day column.
 *
 * `top`/`height` are percentages of the 24-hour column. `column` of `columns` places
 * side-by-side overlapping meetings: three meetings at 10:00 each take a third of the
 * width, which is the only way a busy morning stays readable.
 */
export type TimedBlock = {
  event: CalendarEvent;
  top: number;
  height: number;
  column: number;
  columns: number;
};

/** The shortest block the grid will draw, as a percentage of the day. A 5-minute
 *  meeting is otherwise a 2px sliver with no room for its own title. */
const MIN_BLOCK_PERCENT = (30 / (24 * 60)) * 100;

/**
 * Lay out a day's timed events as positioned blocks.
 *
 * Overlaps are resolved in CLUSTERS: consecutive events that overlap each other form
 * a group, every member of the group is given a column, and the group's width is the
 * number of columns it needed. Computing it per cluster rather than per day is what
 * keeps a lone afternoon meeting full-width even when the morning was triple-booked.
 */
export function layoutDayGrid(events: CalendarEvent[], day: Date): TimedBlock[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + DAY_MS;

  const timed = events
    .map((event) => ({ event, span: eventSpan(event) }))
    .filter(({ span }) => !span.banded && spanOverlaps(span, dayStart, dayEnd))
    .sort((a, b) => a.span.startMs - b.span.startMs || a.event.id.localeCompare(b.event.id));

  const blocks: TimedBlock[] = [];
  /** The events of the cluster being built, and the columns they occupy. */
  let cluster: { event: CalendarEvent; startMs: number; endMs: number; column: number }[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const columns = Math.max(...cluster.map((item) => item.column)) + 1;
    for (const item of cluster) {
      const rawTop = clamp(((item.startMs - dayStart) / DAY_MS) * 100, 0, 100);
      const rawHeight = ((item.endMs - item.startMs) / DAY_MS) * 100;
      // The minimum height wins over the exact position: a 15-minute meeting at
      // 23:45 is nudged up to sit flush with the bottom rather than being squashed
      // to an illegible sliver or overflowing the column.
      const height = clamp(Math.max(rawHeight, MIN_BLOCK_PERCENT), MIN_BLOCK_PERCENT, 100);
      blocks.push({
        event: item.event,
        top: Math.min(rawTop, 100 - height),
        height,
        column: item.column,
        columns,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const { event, span } of timed) {
    // Clip to the day so an event running past midnight fills the column to the
    // bottom rather than overflowing it.
    const startMs = Math.max(span.startMs, dayStart);
    const endMs = Math.min(Math.max(span.endMs, startMs), dayEnd);

    if (startMs >= clusterEnd) flush();

    // The lowest column free among the cluster members this event actually overlaps.
    const taken = new Set(
      cluster.filter((item) => item.endMs > startMs).map((item) => item.column),
    );
    let column = 0;
    while (taken.has(column)) column++;

    cluster.push({ event, startMs, endMs, column });
    clusterEnd = Math.max(clusterEnd, endMs);
  }
  flush();

  return blocks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Where "now" sits in a day column, as a percentage, or null when `now` is not that
 *  day (so the indicator only ever draws on today). */
export function nowIndicatorPercent(day: Date, now: Date): number | null {
  if (!isSameDay(day, now)) return null;
  const dayStart = startOfDay(day).getTime();
  return clamp(((now.getTime() - dayStart) / DAY_MS) * 100, 0, 100);
}

// ---- formatting ------------------------------------------------------------

/** A single clock time ("09:30"), in the viewer's locale. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A clock time with the minutes dropped when they are zero ("2 PM", "14:00" →
 *  "14"; but "2:30 PM" kept in full).
 *
 *  For the narrow places — a month-grid chip, a week-column block — where the time
 *  competes with the title for a hundred-odd pixels. On the hour is the common case,
 *  and ":00" is three characters that say nothing. */
export function formatTimeCompact(ms: number): string {
  const date = new Date(ms);
  if (date.getMinutes() !== 0) return formatTime(ms);
  return date.toLocaleTimeString(undefined, { hour: "numeric" });
}

/** An event's time as a view shows it: "All day", "09:30 – 10:15", or a dated range
 *  when it spans more than one day. */
export function formatEventTime(event: CalendarEvent): string {
  const span = eventSpan(event);
  if (event.is_all_day) {
    const days = Math.round((span.endMs - span.startMs) / DAY_MS);
    if (days <= 1) return "All day";
    const last = new Date(span.endMs - DAY_MS);
    return `All day · ${formatDayShort(new Date(span.startMs))} – ${formatDayShort(last)}`;
  }
  if (span.banded) {
    return `${formatDayShort(new Date(span.startMs))} ${formatTime(span.startMs)} – ${formatDayShort(
      new Date(span.endMs),
    )} ${formatTime(span.endMs)}`;
  }
  if (span.endMs <= span.startMs) return formatTime(span.startMs);
  return `${formatTime(span.startMs)} – ${formatTime(span.endMs)}`;
}

/** "26 Jul" — a compact day for inline use. */
export function formatDayShort(date: Date): string {
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The heading above the grid: "July 2026", "20 – 26 Jul 2026", "Sunday 26 July 2026". */
export function formatRangeTitle(
  mode: CalendarViewMode,
  anchor: Date,
  weekStartsOn: number = WEEK_STARTS_ON,
): string {
  switch (mode) {
    case "month":
      return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    case "day":
      return anchor.toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    case "week":
    case "agenda": {
      const range = visibleRange(mode, anchor, weekStartsOn);
      const last = addDays(range.end, -1);
      const sameMonth = isSameMonth(range.start, last);
      const from = range.start.toLocaleDateString(
        undefined,
        sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" },
      );
      const to = last.toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return `${from} – ${to} ${last.getFullYear()}`;
    }
  }
}

/** A day's heading in the agenda: "Today", "Tomorrow", else a full weekday + date. */
export function formatAgendaDay(day: Date, now: Date): string {
  if (isSameDay(day, now)) return "Today";
  if (isSameDay(day, addDays(startOfDay(now), 1))) return "Tomorrow";
  return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
