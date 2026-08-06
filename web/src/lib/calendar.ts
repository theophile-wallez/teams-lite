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

/** Saturday or Sunday. Only used to tint the grid, never to hide anything by itself
 *  (that is the "Weekends" view setting's job). */
export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** Drop Saturdays and Sundays from a row of days when the user has turned weekends
 *  off. Every layout function here is index-based over the array it is given, so a
 *  five-day row needs no other change. */
export function workdaysOnly(days: Date[], showWeekends: boolean): Date[] {
  return showWeekends ? days : days.filter((day) => !isWeekend(day));
}

/**
 * The ISO 8601 week number of a date (weeks start on Monday, week 1 is the one
 * holding the first Thursday).
 *
 * Shown next to the period in the header and, optionally, as the month grid's
 * leading column — the number people quote in "let's do it in W31".
 */
export function isoWeekNumber(date: Date): number {
  // Shift onto the Thursday of the same ISO week, then count weeks from the first
  // Thursday of that Thursday's year. This is the standard trick, and it is why the
  // year boundary needs no special case.
  const thursday = addDays(startOfDay(date), 3 - ((date.getDay() + 6) % 7));
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const shift = (firstThursday.getDay() + 6) % 7;
  const week1Monday = addDays(firstThursday, -shift);
  return Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * DAY_MS)) + 1;
}

/** The viewer's time zone, the way a calendar labels its hour gutter: the short
 *  name when the platform has one ("CEST"), else a UTC offset ("GMT+2"). */
export function timezoneLabel(now: Date = new Date()): string {
  const short = now
    .toLocaleTimeString(undefined, { timeZoneName: "short" })
    .match(/\b([A-Z]{2,5})$/);
  if (short) return short[1]!;
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  const minutes = Math.abs(offsetMinutes) % 60;
  return `GMT${sign}${hours}${minutes ? `:${`${minutes}`.padStart(2, "0")}` : ""}`;
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

// ---- what an event says about itself ---------------------------------------
//
// Colour is reserved for WHICH CALENDAR an event belongs to (that is what makes six
// overlaid calendars readable), so everything else an event carries has to be said by
// its treatment instead: struck through, hatched, outlined, dimmed. These predicates
// are the single source of truth for which is which, keyed off Graph's own fields.

/** The user has not answered this invitation yet — drawn outlined rather than filled. */
export function isUnanswered(event: Pick<CalendarEvent, "response">): boolean {
  return event.response === "notResponded" || event.response === "none";
}

/** The user declined it, or the organizer cancelled it — struck through. */
export function isDeclined(
  event: Pick<CalendarEvent, "response" | "is_cancelled">,
): boolean {
  return event.response === "declined" || event.is_cancelled;
}

/** A "maybe" — hatched, the way every calendar draws a tentative hold. */
export function isTentative(event: Pick<CalendarEvent, "response" | "show_as">): boolean {
  return event.response === "tentativelyAccepted" || event.show_as === "tentative";
}

/** Already over. Past events are dimmed so the eye lands on what is still ahead. */
export function isPast(event: Pick<CalendarEvent, "start" | "end" | "is_all_day">, now: Date): boolean {
  return eventSpan(event).endMs <= now.getTime();
}

/** Hide declined and cancelled events, for the "Declined events" view setting. */
export function withoutDeclined(events: CalendarEvent[], showDeclined: boolean): CalendarEvent[] {
  return showDeclined ? events : events.filter((event) => !isDeclined(event));
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

// ---- the month grid --------------------------------------------------------
//
// A month cell has room for a handful of rows and no more, and the count depends on
// the viewport — a 6×7 grid in a 700px pane gives each cell ~100px, in a 1200px one
// ~180px. So the cell's capacity is MEASURED (`monthSlotCount`) and then SHARED
// between the row's bars and the day's own chips, rather than guessed per kind. That
// is what makes "+N more" honest: it counts exactly what did not fit.

/** Height of one row inside a month cell — a bar or a chip — including its gap. */
export const MONTH_SLOT_HEIGHT = 19;
/** Room the day number takes above the slots. */
export const MONTH_DAY_HEADER_HEIGHT = 26;
/** A cell always offers at least one slot (if only for "+N more") and never more than
 *  this, so a tall viewport does not turn the grid into a list. */
const MONTH_MIN_SLOTS = 1;
const MONTH_MAX_SLOTS = 8;

/** How many rows of events a month cell of `cellHeight` pixels can show. */
export function monthSlotCount(cellHeight: number): number {
  const usable = cellHeight - MONTH_DAY_HEADER_HEIGHT;
  const raw = Math.floor(usable / MONTH_SLOT_HEIGHT);
  return Math.max(MONTH_MIN_SLOTS, Math.min(MONTH_MAX_SLOTS, raw));
}

/** One day of a month row: the timed events it shows, and how many it could not. */
export type MonthDayCell = {
  day: Date;
  /** Timed events that fit, in display order. */
  items: CalendarEvent[];
  /** How many of the day's events are not drawn at all — the "+N more" count. */
  hidden: number;
};

/** A whole week row of the month grid, laid out. */
export type MonthRow = {
  /** All-day and multi-day bars, in lanes across the row. */
  bars: DayBandBar[];
  /** How many lanes the bars need — the number of slots they consume in every cell,
   *  so a bar keeps one straight line across the row. */
  laneCount: number;
  cells: MonthDayCell[];
};

/**
 * Lay out one week row of the month grid within a budget of `slots` rows per cell.
 *
 * Bars take the top lanes (uniformly across the row — that is what lanes are for),
 * and each day fills what is left with its own timed events. When a day has more than
 * fits, the last slot becomes the overflow indicator, so the count it shows includes
 * the event it displaced.
 */
export function layoutMonthRow(events: CalendarEvent[], days: Date[], slots: number): MonthRow {
  const bars = layoutDayBand(events, days);
  const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0);
  const free = Math.max(0, slots - laneCount);

  const cells = days.map((day) => {
    const timed = eventsForDay(events, day).filter((event) => !eventSpan(event).banded);
    // One slot has to pay for the indicator itself, or "+1 more" would sit where the
    // event it is hiding could have been drawn.
    const shown = timed.length > free ? Math.max(0, free - 1) : timed.length;
    return { day, items: timed.slice(0, shown), hidden: timed.length - shown };
  });

  return { bars, laneCount, cells };
}

// ---- the hour grid ---------------------------------------------------------

/**
 * One timed event positioned in a day column. Every number is a PERCENTAGE of the
 * column, so the grid resizes with the viewport and the component does no arithmetic.
 *
 * `top`/`height` come from the clock. `left`/`width` come from the overlap: three
 * meetings at 10:00 cannot each be full width, or two of them would be invisible.
 * They CASCADE rather than tile — each takes a wide slice and the next one overlaps
 * its right edge, so every meeting keeps its leading edge (where the title starts)
 * clear and the last one still reaches the right of the column. That is what Notion
 * Calendar, Outlook and Google all do, and it beats tiling in a 130px week column
 * where a strict third is too narrow to read.
 */
export type TimedBlock = {
  event: CalendarEvent;
  top: number;
  height: number;
  left: number;
  width: number;
  column: number;
  columns: number;
};

/** How much of the column is left clear on the right, so a block never touches the
 *  next day's border and an empty slot stays clickable. */
const COLUMN_RIGHT_GAP_PERCENT = 6;
/** How far each cascaded block is overlapped by the one after it. */
const COLUMN_OVERLAP_PERCENT = 10;

/** The height a short block is grown to, as a percentage of the day. A 5-minute
 *  meeting is otherwise a 2px sliver with no room for its own title. It is a courtesy
 *  and not a floor: it yields to the meeting that follows (see `layoutDayGrid`). */
const MIN_BLOCK_PERCENT = (30 / (24 * 60)) * 100;

/** What a block keeps when the meeting after it leaves less room than that — enough
 *  for the rail and a line of fill, so the event is still visible and clickable. */
const MIN_VISIBLE_BLOCK_PERCENT = (5 / (24 * 60)) * 100;

/**
 * Lay out a day's timed events as positioned blocks.
 *
 * Overlaps are resolved in CLUSTERS: consecutive events that overlap each other form
 * a group, every member of the group is given a column, and the group's width is the
 * number of columns it needed. Computing it per cluster rather than per day is what
 * keeps a lone afternoon meeting full-width even when the morning was triple-booked.
 *
 * A short block is grown to `MIN_BLOCK_PERCENT` so its title fits, and that growth is
 * BOUNDED by the next meeting's start (`roomMs`). Unbounded, a 15-minute meeting was
 * drawn 30 minutes tall and covered the meeting that started at its end — two blocks
 * printed over each other where the calendar holds no overlap at all. A cascade is how
 * this grid states a real overlap, so it must never state one the day does not have.
 */
export function layoutDayGrid(
  events: CalendarEvent[],
  day: Date,
  options: {
    /** Right-hand breathing room, as a percentage. The Day view passes 0: one column
     *  wide enough for everything has nothing to gain from a gap. */
    rightGapPercent?: number;
  } = {},
): TimedBlock[] {
  const rightGap = options.rightGapPercent ?? COLUMN_RIGHT_GAP_PERCENT;
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + DAY_MS;

  const timed = events
    .map((event) => ({ event, span: eventSpan(event) }))
    .filter(({ span }) => !span.banded && spanOverlaps(span, dayStart, dayEnd))
    .sort((a, b) => a.span.startMs - b.span.startMs || a.event.id.localeCompare(b.event.id));

  /**
   * The start of the first meeting after `index` that begins once `endMs` has passed
   * — the end of the day when there is none.
   *
   * That meeting is the one drawn UNDER this block in the same column: a meeting
   * starting earlier than `endMs` overlaps this one and takes a column of its own, and
   * the column is reused by the first event free to take it, which is this one.
   */
  const nextStart = (index: number, endMs: number): number => {
    for (let i = index + 1; i < timed.length; i++) {
      const start = Math.max(timed[i]!.span.startMs, dayStart);
      if (start >= endMs) return start;
    }
    return dayEnd;
  };

  const blocks: TimedBlock[] = [];
  /** The events of the cluster being built, the columns they occupy, and how far each
   *  one may grow beyond its own duration. */
  let cluster: {
    event: CalendarEvent;
    startMs: number;
    endMs: number;
    roomMs: number;
    column: number;
  }[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const columns = Math.max(...cluster.map((item) => item.column)) + 1;
    for (const item of cluster) {
      const rawTop = clamp(((item.startMs - dayStart) / DAY_MS) * 100, 0, 100);
      const rawHeight = ((item.endMs - item.startMs) / DAY_MS) * 100;
      const room = (item.roomMs / DAY_MS) * 100;
      // A short meeting is grown until its title fits, or until the next meeting
      // starts — whichever comes first. A real duration is never shortened, because
      // `roomMs` is at least the event's own length.
      const height = clamp(
        Math.max(rawHeight, Math.min(MIN_BLOCK_PERCENT, room)),
        MIN_VISIBLE_BLOCK_PERCENT,
        100,
      );
      const { left, width } = cascade(item.column, columns, rightGap);
      blocks.push({
        event: item.event,
        // The room above wins over the exact position for the last minutes of the day:
        // a block is nudged up to sit flush with the bottom rather than overflowing it.
        top: Math.min(rawTop, 100 - height),
        height,
        left,
        width,
        column: item.column,
        columns,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  timed.forEach(({ event, span }, index) => {
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

    cluster.push({ event, startMs, endMs, roomMs: nextStart(index, endMs) - startMs, column });
    clusterEnd = Math.max(clusterEnd, endMs);
  });
  flush();

  return blocks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where one of `columns` cascaded blocks sits horizontally, as percentages.
 *
 * Solving `columns * width - (columns - 1) * overlap = 100 - gap` keeps the run
 * flush with both edges of the column whatever the count; the last block absorbs the
 * rounding so it always ends exactly on the gap.
 */
function cascade(column: number, columns: number, rightGap: number): { left: number; width: number } {
  const usable = 100 - rightGap;
  if (columns <= 1) return { left: 0, width: usable };
  const overlap = Math.min(COLUMN_OVERLAP_PERCENT, usable / columns);
  const width = (usable + overlap * (columns - 1)) / columns;
  const left = column * (width - overlap);
  return { left, width: column === columns - 1 ? usable - left : width };
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

/**
 * An event's time in the few characters a grid block has: "10–11 AM", "9:30–10:15".
 *
 * The period is written once when both ends share it — the reference design's touch,
 * and worth the trouble because "2–3 PM" fits a week column where "2:00 PM – 3:00 PM"
 * does not. Done by comparing the two formatted strings rather than by assuming a
 * 12-hour clock, so a 24-hour locale simply never has a suffix to drop.
 */
export function formatEventTimeRange(event: CalendarEvent): string {
  const span = eventSpan(event);
  if (event.is_all_day) return "All day";
  const from = formatTimeCompact(span.startMs);
  const to = formatTimeCompact(span.endMs);
  if (span.endMs <= span.startMs) return from;
  const suffix = from.match(/[^\d:\s]+$/)?.[0];
  if (suffix && to.endsWith(suffix)) {
    return `${from.slice(0, -suffix.length).trim()}\u2013${to}`;
  }
  return `${from}\u2013${to}`;
}

/** The heading above the grid: the month the view sits in, or the two it straddles. */
export function formatRangeTitle(
  mode: CalendarViewMode,
  anchor: Date,
  weekStartsOn: number = WEEK_STARTS_ON,
): string {
  const month = (date: Date, withYear: boolean) =>
    date.toLocaleDateString(undefined, withYear ? { month: "long", year: "numeric" } : { month: "short" });

  if (mode === "month" || mode === "day") return month(anchor, true);

  const range = visibleRange(mode, anchor, weekStartsOn);
  const last = addDays(range.end, -1);
  if (isSameMonth(range.start, last)) return month(range.start, true);
  return `${month(range.start, false)} \u2013 ${month(last, true)}`;
}

/** The muted line beside the heading: which week, which day, how far the list looks. */
export function formatRangeSubtitle(
  mode: CalendarViewMode,
  anchor: Date,
  weekStartsOn: number = WEEK_STARTS_ON,
): string {
  switch (mode) {
    case "month":
      return "";
    case "week":
      return `Week ${isoWeekNumber(startOfWeek(anchor, weekStartsOn))}`;
    case "day":
      // The month repeats what the heading already says, and is worth it: "Sunday 26"
      // is the one combination Intl orders unpredictably across locales.
      return anchor.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
    case "agenda":
      return `Next ${AGENDA_DAYS} days`;
  }
}

/** A day's heading in the agenda: "Today", "Tomorrow", else a full weekday + date. */
export function formatAgendaDay(day: Date, now: Date): string {
  if (isSameDay(day, now)) return "Today";
  if (isSameDay(day, addDays(startOfDay(now), 1))) return "Tomorrow";
  return day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
