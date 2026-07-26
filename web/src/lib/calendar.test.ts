import { describe, it, expect } from "vitest";
import {
  AGENDA_DAYS,
  MONTH_GRID_DAYS,
  addDays,
  addMonths,
  compareForDisplay,
  dayKey,
  daysIn,
  eventSpan,
  eventTouchesDay,
  eventsForDay,
  formatEventTime,
  formatEventTimeRange,
  formatRangeSubtitle,
  formatRangeTitle,
  formatTimeCompact,
  isDeclined,
  isPast,
  isTentative,
  isUnanswered,
  isWeekend,
  isoWeekNumber,
  layoutDayBand,
  layoutDayGrid,
  layoutMonthRow,
  monthGridDays,
  monthSlotCount,
  nowIndicatorPercent,
  requestRange,
  shiftAnchor,
  startOfWeek,
  timezoneLabel,
  visibleRange,
  weekdayLabels,
  weeksOf,
  withoutDeclined,
  workdaysOnly,
} from "./calendar";
import type { CalendarEvent } from "./protocol";

/** A timed event over a local-time range, expressed the way the backend sends it
 *  (ISO UTC). The tests build UTC strings from local dates so they are independent
 *  of the machine's zone. */
function timed(id: string, startLocal: Date, endLocal: Date, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return event(id, startLocal.toISOString(), endLocal.toISOString(), false, over);
}

/** An all-day event over `[fromDate, toDateExclusive)`, as Graph sends it: midnight
 *  UTC markers with an exclusive end. */
function allDay(id: string, from: string, toExclusive: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return event(id, `${from}T00:00:00Z`, `${toExclusive}T00:00:00Z`, true, over);
}

function event(
  id: string,
  start: string,
  end: string,
  isAllDay: boolean,
  over: Partial<CalendarEvent>,
): CalendarEvent {
  return {
    id,
    calendar_id: "cal",
    subject: id,
    preview: "",
    start,
    end,
    is_all_day: isAllDay,
    is_cancelled: false,
    is_organizer: false,
    organizer: { name: "", address: "", response: "", kind: "" },
    location: "",
    join_url: "",
    web_link: "",
    show_as: "busy",
    response: "none",
    series: "singleInstance",
    recurrence: "",
    importance: "normal",
    sensitivity: "normal",
    categories: [],
    attendees: [],
    attendee_count: 0,
    has_attachments: false,
    reminder_minutes: 15,
    ...over,
  };
}

/** A local date at a given wall-clock time, for building fixtures. */
function at(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

describe("day helpers", () => {
  it("keys days by their LOCAL date, not a UTC one", () => {
    // 23:30 local on the 26th is the 27th in UTC in eastern zones; the key must
    // follow the day the user is looking at.
    const late = at(2026, 7, 26, 23, 30);
    expect(dayKey(late)).toBe("2026-07-26");
  });

  it("steps days and months without drifting", () => {
    expect(dayKey(addDays(at(2026, 7, 31), 1))).toBe("2026-08-01");
    expect(dayKey(addDays(at(2026, 1, 1), -1))).toBe("2025-12-31");
    // 31 January + 1 month clamps to February's last day rather than skipping to March.
    expect(dayKey(addMonths(at(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(dayKey(addMonths(at(2026, 12, 15), 1))).toBe("2027-01-15");
  });

  it("starts the week on the configured day", () => {
    // 2026-07-26 is a Sunday.
    expect(dayKey(startOfWeek(at(2026, 7, 26), 1))).toBe("2026-07-20"); // Monday-first
    expect(dayKey(startOfWeek(at(2026, 7, 26), 0))).toBe("2026-07-26"); // Sunday-first
    expect(dayKey(startOfWeek(at(2026, 7, 20), 1))).toBe("2026-07-20");
  });

  it("labels weekdays in the grid's own order", () => {
    const monday = weekdayLabels(1);
    const sunday = weekdayLabels(0);
    expect(monday).toHaveLength(7);
    // Same seven names, rotated by one.
    expect(monday.slice(0, 6)).toEqual(sunday.slice(1));
    expect(monday[6]).toBe(sunday[0]);
  });
});

describe("weekends", () => {
  it("names Saturday and Sunday", () => {
    expect(isWeekend(at(2026, 7, 25))).toBe(true); // Saturday
    expect(isWeekend(at(2026, 7, 26))).toBe(true); // Sunday
    expect(isWeekend(at(2026, 7, 24))).toBe(false);
  });

  it("drops them from a row only when asked", () => {
    const week = Array.from({ length: 7 }, (_, i) => addDays(at(2026, 7, 20), i));
    expect(workdaysOnly(week, true)).toHaveLength(7);
    const workdays = workdaysOnly(week, false);
    expect(workdays).toHaveLength(5);
    expect(workdays.map(dayKey)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
    ]);
  });
});

describe("isoWeekNumber", () => {
  it("numbers weeks the way ISO 8601 does", () => {
    // Week 1 is the one holding the first Thursday, so it can start in December.
    expect(isoWeekNumber(at(2026, 1, 1))).toBe(1); // a Thursday
    expect(isoWeekNumber(at(2025, 12, 29))).toBe(1); // the Monday of that same week
    expect(isoWeekNumber(at(2026, 7, 20))).toBe(30);
    expect(isoWeekNumber(at(2026, 7, 26))).toBe(30); // the Sunday closes week 30
    // 2026 is a 53-week year, and its week 53 runs into January 2027.
    expect(isoWeekNumber(at(2026, 12, 31))).toBe(53);
    expect(isoWeekNumber(at(2027, 1, 3))).toBe(53);
  });
});

describe("timezoneLabel", () => {
  it("is either a short zone name or a UTC offset", () => {
    expect(timezoneLabel(at(2026, 7, 26, 12))).toMatch(/^([A-Z]{2,5}|GMT[+-]\d{1,2}(:\d{2})?)$/);
  });
});

describe("monthGridDays", () => {
  it("always yields six full weeks, month-aligned", () => {
    const days = monthGridDays(at(2026, 7, 15), 1);
    expect(days).toHaveLength(MONTH_GRID_DAYS);
    // July 2026 starts on a Wednesday, so a Monday-first grid opens on 29 June.
    expect(dayKey(days[0]!)).toBe("2026-06-29");
    expect(dayKey(days[41]!)).toBe("2026-08-09");
    expect(weeksOf(days)).toHaveLength(6);
    expect(weeksOf(days)[0]).toHaveLength(7);
  });

  it("keeps a fixed height for a month that fits in five weeks", () => {
    // February 2026 begins on a Sunday and has 28 days — five rows would do, but the
    // grid must not change height between months.
    expect(monthGridDays(at(2026, 2, 10), 1)).toHaveLength(MONTH_GRID_DAYS);
  });
});

describe("visibleRange", () => {
  it("covers the whole grid for a month", () => {
    const range = visibleRange("month", at(2026, 7, 15), 1);
    expect(dayKey(range.start)).toBe("2026-06-29");
    expect(daysIn(range)).toHaveLength(MONTH_GRID_DAYS);
  });

  it("covers seven days for a week and one for a day", () => {
    expect(daysIn(visibleRange("week", at(2026, 7, 22), 1))).toHaveLength(7);
    const day = visibleRange("day", at(2026, 7, 22, 15), 1);
    expect(daysIn(day)).toHaveLength(1);
    expect(dayKey(day.start)).toBe("2026-07-22");
  });

  it("covers a fortnight from the anchor for the agenda", () => {
    expect(daysIn(visibleRange("agenda", at(2026, 7, 22), 1))).toHaveLength(AGENDA_DAYS);
  });
});

describe("requestRange", () => {
  it("converts the local window to canonical UTC instants", () => {
    const range = visibleRange("day", at(2026, 7, 22), 1);
    const { start, end } = requestRange(range);
    // Whole seconds, Z-suffixed — the shape the backend stores.
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(start < end).toBe(true);
    // Exactly 24 hours apart, whatever the local offset.
    expect(Date.parse(end) - Date.parse(start)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("shiftAnchor", () => {
  it("moves by the unit the view shows", () => {
    expect(dayKey(shiftAnchor("month", at(2026, 7, 15), 1, 1))).toBe("2026-08-01");
    expect(dayKey(shiftAnchor("month", at(2026, 1, 15), -1, 1))).toBe("2025-12-01");
    expect(dayKey(shiftAnchor("week", at(2026, 7, 22), 1, 1))).toBe("2026-07-27");
    expect(dayKey(shiftAnchor("day", at(2026, 7, 22), -1, 1))).toBe("2026-07-21");
    expect(dayKey(shiftAnchor("agenda", at(2026, 7, 1), 1, 1))).toBe("2026-07-15");
  });
});

describe("eventSpan", () => {
  it("pins an all-day event to its calendar dates, never a local instant", () => {
    // The bug this prevents: converting midnight UTC to a local instant slides a
    // holiday onto the previous day west of Greenwich.
    const leave = allDay("leave", "2026-07-13", "2026-07-18");
    const span = eventSpan(leave);
    expect(dayKey(new Date(span.startMs))).toBe("2026-07-13");
    // The end is exclusive, so the last covered day is the 17th.
    expect(dayKey(new Date(span.endMs - 1))).toBe("2026-07-17");
    expect(span.banded).toBe(true);
  });

  it("covers at least one day when an all-day event has a broken end", () => {
    const span = eventSpan(allDay("odd", "2026-07-13", "2026-07-13"));
    expect(dayKey(new Date(span.startMs))).toBe("2026-07-13");
    expect(dayKey(new Date(span.endMs - 1))).toBe("2026-07-13");
  });

  it("treats a timed event as the instants it is", () => {
    const meeting = timed("m", at(2026, 7, 22, 9, 30), at(2026, 7, 22, 10, 15));
    const span = eventSpan(meeting);
    expect(new Date(span.startMs).getHours()).toBe(9);
    expect(new Date(span.endMs).getHours()).toBe(10);
    expect(span.banded).toBe(false);
  });

  it("bands a timed event that crosses midnight", () => {
    // It cannot be drawn as a block inside one day column, so it belongs in the band.
    const overnight = timed("night", at(2026, 7, 22, 23, 0), at(2026, 7, 23, 1, 0));
    expect(eventSpan(overnight).banded).toBe(true);
  });

  it("does not band an event that ends exactly at midnight", () => {
    const evening = timed("evening", at(2026, 7, 22, 22, 0), at(2026, 7, 23, 0, 0));
    expect(eventSpan(evening).banded).toBe(false);
  });

  it("survives an unparseable timestamp instead of producing NaN geometry", () => {
    const broken = event("broken", "not a date", "also not", false, {});
    const span = eventSpan(broken);
    expect(Number.isFinite(span.startMs)).toBe(true);
    expect(Number.isFinite(span.endMs)).toBe(true);
  });
});

describe("eventTouchesDay / eventsForDay", () => {
  const leave = allDay("leave", "2026-07-13", "2026-07-18");
  const monday = timed("monday", at(2026, 7, 13, 9, 0), at(2026, 7, 13, 10, 0));
  const friday = timed("friday", at(2026, 7, 17, 14, 0), at(2026, 7, 17, 15, 0));

  it("includes a multi-day event on every day it covers", () => {
    for (const day of [13, 14, 15, 16, 17]) {
      expect(eventTouchesDay(leave, at(2026, 7, day))).toBe(true);
    }
    // The exclusive end day is not covered.
    expect(eventTouchesDay(leave, at(2026, 7, 18))).toBe(false);
    expect(eventTouchesDay(leave, at(2026, 7, 12))).toBe(false);
  });

  it("lists a day's events with the banded ones first", () => {
    const events = eventsForDay([monday, leave, friday], at(2026, 7, 13));
    expect(events.map((e) => e.id)).toEqual(["leave", "monday"]);
  });

  it("orders same-start events longest first, then by id", () => {
    const long = timed("b-long", at(2026, 7, 13, 9, 0), at(2026, 7, 13, 11, 0));
    const short = timed("a-short", at(2026, 7, 13, 9, 0), at(2026, 7, 13, 9, 30));
    expect([short, long].sort(compareForDisplay).map((e) => e.id)).toEqual(["b-long", "a-short"]);
  });
});

describe("layoutDayBand", () => {
  const week = Array.from({ length: 7 }, (_, i) => addDays(at(2026, 7, 13), i)); // Mon 13 → Sun 19

  it("spans a bar across the days it covers and clips it to the row", () => {
    const leave = allDay("leave", "2026-07-15", "2026-07-22"); // Wed → past Sunday
    const [bar] = layoutDayBand([leave], week);
    expect(bar!.startIndex).toBe(2); // Wednesday
    expect(bar!.endIndex).toBe(6); // clipped at Sunday
    expect(bar!.continuesBefore).toBe(false);
    expect(bar!.continuesAfter).toBe(true);
  });

  it("marks a bar that began before the row", () => {
    const leave = allDay("leave", "2026-07-06", "2026-07-15");
    const [bar] = layoutDayBand([leave], week);
    expect(bar!.startIndex).toBe(0);
    expect(bar!.endIndex).toBe(1); // covers Mon + Tue
    expect(bar!.continuesBefore).toBe(true);
    expect(bar!.continuesAfter).toBe(false);
  });

  it("stacks overlapping bars into separate lanes and reuses a free lane", () => {
    const long = allDay("long", "2026-07-13", "2026-07-16"); // Mon–Wed
    const clash = allDay("clash", "2026-07-14", "2026-07-15"); // Tue
    const later = allDay("later", "2026-07-17", "2026-07-18"); // Fri — lane 0 is free again
    const bars = layoutDayBand([long, clash, later], week);
    const lane = (id: string) => bars.find((b) => b.event.id === id)!.lane;
    expect(lane("long")).toBe(0);
    expect(lane("clash")).toBe(1);
    expect(lane("later")).toBe(0);
  });

  it("ignores timed events that belong in the hour grid", () => {
    const meeting = timed("m", at(2026, 7, 13, 9, 0), at(2026, 7, 13, 10, 0));
    expect(layoutDayBand([meeting], week)).toHaveLength(0);
  });

  it("includes a timed event that crosses midnight", () => {
    const overnight = timed("night", at(2026, 7, 14, 23, 0), at(2026, 7, 15, 1, 0));
    const bars = layoutDayBand([overnight], week);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.startIndex).toBe(1);
    expect(bars[0]!.endIndex).toBe(2);
  });

  it("returns nothing for an empty row", () => {
    expect(layoutDayBand([allDay("x", "2026-07-13", "2026-07-14")], [])).toEqual([]);
  });
});

describe("layoutDayGrid", () => {
  const day = at(2026, 7, 22);

  it("positions a block as a percentage of the day", () => {
    const noon = timed("noon", at(2026, 7, 22, 12, 0), at(2026, 7, 22, 13, 0));
    const [block] = layoutDayGrid([noon], day);
    expect(block!.top).toBeCloseTo(50, 5);
    expect(block!.height).toBeCloseTo(100 / 24, 5);
    expect(block!.columns).toBe(1);
  });

  it("splits overlapping meetings into side-by-side columns", () => {
    const events = [
      timed("a", at(2026, 7, 22, 10, 0), at(2026, 7, 22, 11, 0)),
      timed("b", at(2026, 7, 22, 10, 30), at(2026, 7, 22, 11, 30)),
      timed("c", at(2026, 7, 22, 10, 45), at(2026, 7, 22, 11, 15)),
    ];
    const blocks = layoutDayGrid(events, day);
    expect(blocks.map((b) => b.column).sort()).toEqual([0, 1, 2]);
    // The whole cluster shares one width, so the columns tile exactly.
    expect(new Set(blocks.map((b) => b.columns))).toEqual(new Set([3]));
  });

  it("keeps a non-overlapping meeting full width even after a busy cluster", () => {
    const events = [
      timed("a", at(2026, 7, 22, 10, 0), at(2026, 7, 22, 11, 0)),
      timed("b", at(2026, 7, 22, 10, 30), at(2026, 7, 22, 11, 30)),
      timed("alone", at(2026, 7, 22, 15, 0), at(2026, 7, 22, 16, 0)),
    ];
    const blocks = layoutDayGrid(events, day);
    const alone = blocks.find((b) => b.event.id === "alone")!;
    expect(alone.columns).toBe(1);
    expect(alone.column).toBe(0);
  });

  it("reuses a column once the earlier meeting has ended within a cluster", () => {
    // a 10–11, b 10:30–12 (overlaps a), c 11–12 (overlaps b but not a) → c takes a's
    // column, and the cluster is two wide rather than three.
    const events = [
      timed("a", at(2026, 7, 22, 10, 0), at(2026, 7, 22, 11, 0)),
      timed("b", at(2026, 7, 22, 10, 30), at(2026, 7, 22, 12, 0)),
      timed("c", at(2026, 7, 22, 11, 0), at(2026, 7, 22, 12, 0)),
    ];
    const blocks = layoutDayGrid(events, day);
    const column = (id: string) => blocks.find((b) => b.event.id === id)!.column;
    expect(column("a")).toBe(0);
    expect(column("b")).toBe(1);
    expect(column("c")).toBe(0);
    expect(new Set(blocks.map((b) => b.columns))).toEqual(new Set([2]));
  });

  it("gives a very short meeting a legible minimum height", () => {
    const brief = timed("brief", at(2026, 7, 22, 9, 0), at(2026, 7, 22, 9, 5));
    const [block] = layoutDayGrid([brief], day);
    // 5 minutes is 0.35% of a day; the block must be taller than that.
    expect(block!.height).toBeGreaterThan(1);
  });

  it("never lets a block run past the bottom of the column", () => {
    const late = timed("late", at(2026, 7, 22, 23, 45), at(2026, 7, 23, 0, 0));
    const [block] = layoutDayGrid([late], day);
    expect(block!.top + block!.height).toBeLessThanOrEqual(100.001);
  });

  it("excludes banded events", () => {
    expect(layoutDayGrid([allDay("x", "2026-07-22", "2026-07-23")], day)).toHaveLength(0);
  });
});

describe("layoutDayGrid horizontal cascade", () => {
  const day = at(2026, 7, 22);

  it("gives a lone meeting the column, less the right-hand gap", () => {
    const [block] = layoutDayGrid([timed("m", at(2026, 7, 22, 9), at(2026, 7, 22, 10))], day);
    expect(block!.left).toBe(0);
    expect(block!.width).toBeGreaterThan(90);
    expect(block!.width).toBeLessThan(100);
  });

  it("takes the whole column when the gap is waived (the Day view)", () => {
    const [block] = layoutDayGrid([timed("m", at(2026, 7, 22, 9), at(2026, 7, 22, 10))], day, {
      rightGapPercent: 0,
    });
    expect(block!.width).toBe(100);
  });

  it("cascades overlapping meetings so each keeps its leading edge", () => {
    const events = [
      timed("a", at(2026, 7, 22, 10, 0), at(2026, 7, 22, 11, 0)),
      timed("b", at(2026, 7, 22, 10, 30), at(2026, 7, 22, 11, 30)),
      timed("c", at(2026, 7, 22, 10, 45), at(2026, 7, 22, 11, 15)),
    ];
    const blocks = layoutDayGrid(events, day).sort((x, y) => x.column - y.column);
    const lefts = blocks.map((b) => b.left);
    // Strictly increasing, and every leading edge is well clear of the next one.
    expect(lefts[0]).toBe(0);
    expect(lefts[1]! - lefts[0]!).toBeGreaterThan(15);
    expect(lefts[2]! - lefts[1]!).toBeGreaterThan(15);
    // The run still ends exactly on the gap — no block escapes the column.
    const last = blocks[blocks.length - 1]!;
    expect(last.left + last.width).toBeCloseTo(94, 5);
    for (const block of blocks) expect(block.left + block.width).toBeLessThanOrEqual(94.001);
  });
});

describe("monthSlotCount", () => {
  it("scales with the cell and stays within bounds", () => {
    expect(monthSlotCount(0)).toBe(1);
    expect(monthSlotCount(40)).toBe(1);
    expect(monthSlotCount(120)).toBeGreaterThan(monthSlotCount(80));
    expect(monthSlotCount(4000)).toBeLessThanOrEqual(8);
  });
});

describe("layoutMonthRow", () => {
  const week = Array.from({ length: 7 }, (_, i) => addDays(at(2026, 7, 20), i)); // Mon 20 → Sun 26

  it("reserves the top slots for the row's bars and fills the rest per day", () => {
    const leave = allDay("leave", "2026-07-21", "2026-07-24"); // Tue–Thu
    const one = timed("one", at(2026, 7, 21, 9), at(2026, 7, 21, 10));
    const two = timed("two", at(2026, 7, 21, 11), at(2026, 7, 21, 12));
    const row = layoutMonthRow([leave, one, two], week, 4);

    expect(row.laneCount).toBe(1);
    expect(row.bars.map((b) => b.event.id)).toEqual(["leave"]);
    const tuesday = row.cells[1]!;
    expect(tuesday.items.map((e) => e.id)).toEqual(["one", "two"]);
    expect(tuesday.hidden).toBe(0);
    // A day with nothing of its own still gets a cell.
    expect(row.cells).toHaveLength(7);
    expect(row.cells[0]!.items).toEqual([]);
  });

  it("counts the event the indicator displaces in its own total", () => {
    const events = [0, 1, 2, 3, 4].map((i) =>
      timed(`m${i}`, at(2026, 7, 22, 9 + i), at(2026, 7, 22, 10 + i)),
    );
    // Three slots, no bars: two events are drawn and the third slot says "+3 more" —
    // three, not two, because the indicator took a slot an event could have used.
    const row = layoutMonthRow(events, week, 3);
    const wednesday = row.cells[2]!;
    expect(wednesday.items.map((e) => e.id)).toEqual(["m0", "m1"]);
    expect(wednesday.hidden).toBe(3);
  });

  it("hides every timed event when the bars have taken the budget", () => {
    const bars = [
      allDay("a", "2026-07-20", "2026-07-27"),
      allDay("b", "2026-07-20", "2026-07-27"),
    ];
    const meeting = timed("m", at(2026, 7, 22, 9), at(2026, 7, 22, 10));
    const row = layoutMonthRow([...bars, meeting], week, 2);
    expect(row.laneCount).toBe(2);
    expect(row.cells[2]!.items).toEqual([]);
    expect(row.cells[2]!.hidden).toBe(1);
  });
});

describe("event state", () => {
  it("reads the user's own answer, not a decoration", () => {
    expect(isUnanswered(timed("a", at(2026, 7, 22, 9), at(2026, 7, 22, 10)))).toBe(true);
    expect(isUnanswered(timed("b", at(2026, 7, 22, 9), at(2026, 7, 22, 10), { response: "accepted" }))).toBe(
      false,
    );
    expect(isDeclined(timed("c", at(2026, 7, 22, 9), at(2026, 7, 22, 10), { response: "declined" }))).toBe(true);
    expect(isDeclined(timed("d", at(2026, 7, 22, 9), at(2026, 7, 22, 10), { is_cancelled: true }))).toBe(true);
    expect(
      isTentative(timed("e", at(2026, 7, 22, 9), at(2026, 7, 22, 10), { response: "tentativelyAccepted" })),
    ).toBe(true);
    expect(isTentative(timed("f", at(2026, 7, 22, 9), at(2026, 7, 22, 10), { show_as: "tentative" }))).toBe(
      true,
    );
  });

  it("knows what is already over, all-day events by their last date", () => {
    const now = at(2026, 7, 22, 12);
    expect(isPast(timed("done", at(2026, 7, 22, 9), at(2026, 7, 22, 10)), now)).toBe(true);
    expect(isPast(timed("running", at(2026, 7, 22, 11, 30), at(2026, 7, 22, 12, 30)), now)).toBe(false);
    // An all-day event covering today is not past, even though its start was midnight.
    expect(isPast(allDay("today", "2026-07-22", "2026-07-23"), now)).toBe(false);
    expect(isPast(allDay("yesterday", "2026-07-21", "2026-07-22"), now)).toBe(true);
  });

  it("filters declined events out only when asked", () => {
    const kept = timed("kept", at(2026, 7, 22, 9), at(2026, 7, 22, 10), { response: "accepted" });
    const gone = timed("gone", at(2026, 7, 22, 9), at(2026, 7, 22, 10), { response: "declined" });
    expect(withoutDeclined([kept, gone], true).map((e) => e.id)).toEqual(["kept", "gone"]);
    expect(withoutDeclined([kept, gone], false).map((e) => e.id)).toEqual(["kept"]);
  });
});

describe("nowIndicatorPercent", () => {
  it("places the line only on today", () => {
    const now = at(2026, 7, 22, 6, 0);
    expect(nowIndicatorPercent(at(2026, 7, 22), now)).toBeCloseTo(25, 5);
    expect(nowIndicatorPercent(at(2026, 7, 23), now)).toBeNull();
  });
});

describe("formatTimeCompact", () => {
  it("drops the minutes when they are zero and keeps them otherwise", () => {
    const onTheHour = formatTimeCompact(at(2026, 7, 22, 14, 0).getTime());
    const halfPast = formatTimeCompact(at(2026, 7, 22, 14, 30).getTime());
    expect(onTheHour).not.toContain(":00");
    expect(halfPast).toContain("30");
    // Both still name the same hour.
    expect(onTheHour.replace(/\D/g, "")).toBe(halfPast.replace(/\D/g, "").slice(0, -2));
  });
});

describe("formatEventTime", () => {
  it("says All day for a one-day all-day event", () => {
    expect(formatEventTime(allDay("x", "2026-07-13", "2026-07-14"))).toBe("All day");
  });

  it("names the inclusive last day of a multi-day all-day event", () => {
    const label = formatEventTime(allDay("leave", "2026-07-13", "2026-07-18"));
    expect(label.startsWith("All day · ")).toBe(true);
    // 17, not the exclusive 18.
    expect(label).toContain("17");
    expect(label).not.toContain("18");
  });

  it("renders a timed range", () => {
    const label = formatEventTime(timed("m", at(2026, 7, 22, 9, 30), at(2026, 7, 22, 10, 15)));
    expect(label).toContain("–");
    expect(label).toMatch(/9|09/);
  });
});

describe("formatEventTimeRange", () => {
  it("writes a shared period once", () => {
    const range = formatEventTimeRange(timed("m", at(2026, 7, 22, 14, 0), at(2026, 7, 22, 15, 0)));
    const single = formatTimeCompact(at(2026, 7, 22, 15, 0).getTime());
    const suffix = single.match(/[^\d:\s]+$/)?.[0];
    expect(range).toContain("\u2013");
    if (suffix) {
      // "2–3 PM", never "2 PM–3 PM".
      expect(range.split(suffix)).toHaveLength(2);
    }
  });

  it("keeps both periods when they differ", () => {
    const range = formatEventTimeRange(timed("m", at(2026, 7, 22, 11, 0), at(2026, 7, 22, 14, 0)));
    expect(range).toMatch(/11/);
    expect(range).toMatch(/2|14/);
  });

  it("says All day for an all-day event", () => {
    expect(formatEventTimeRange(allDay("x", "2026-07-22", "2026-07-23"))).toBe("All day");
  });
});

describe("formatRangeTitle / formatRangeSubtitle", () => {
  it("names the month a view sits in, and both when it straddles two", () => {
    expect(formatRangeTitle("month", at(2026, 7, 15), 1)).toMatch(/2026/);
    // The week of 29 June 2026 runs into July.
    const straddle = formatRangeTitle("week", at(2026, 7, 1), 1);
    expect(straddle).toContain("\u2013");
    expect(formatRangeTitle("week", at(2026, 7, 22), 1)).not.toContain("\u2013");
  });

  it("says which week, which day, and how far the agenda looks", () => {
    expect(formatRangeSubtitle("week", at(2026, 7, 22), 1)).toBe("Week 30");
    expect(formatRangeSubtitle("month", at(2026, 7, 22), 1)).toBe("");
    expect(formatRangeSubtitle("day", at(2026, 7, 22), 1)).toMatch(/22/);
    expect(formatRangeSubtitle("agenda", at(2026, 7, 22), 1)).toBe(`Next ${AGENDA_DAYS} days`);
  });
});
