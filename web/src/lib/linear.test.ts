import { describe, it, expect } from "vitest";
import {
  badgedPriority,
  formatDueDate,
  progressPercent,
  stateColor,
  stateShape,
} from "./linear";

describe("stateShape", () => {
  it("maps every Linear category to a shape", () => {
    expect(stateShape("backlog")).toBe("backlog");
    expect(stateShape("unstarted")).toBe("unstarted");
    expect(stateShape("started")).toBe("started");
    expect(stateShape("completed")).toBe("completed");
    expect(stateShape("canceled")).toBe("canceled");
  });

  it("borrows a shape for the categories Linear draws the same way", () => {
    // Triage sits before the backlog, and a paused project is a started one that
    // stopped — Linear gives neither an icon of its own.
    expect(stateShape("triage")).toBe("backlog");
    expect(stateShape("planned")).toBe("unstarted");
    expect(stateShape("paused")).toBe("started");
  });

  it("has no shape for an unknown or absent category", () => {
    // A category we do not know must not be drawn as if we did.
    expect(stateShape("something_new")).toBeNull();
    expect(stateShape("")).toBeNull();
    expect(stateShape(undefined)).toBeNull();
    expect(stateShape(null)).toBeNull();
  });
});

describe("stateColor", () => {
  it("accepts a hex colour, in either length", () => {
    expect(stateColor("#5e6ad2")).toBe("#5e6ad2");
    expect(stateColor("#F2994A")).toBe("#F2994A");
    expect(stateColor("  #abc  ")).toBe("#abc");
  });

  it("drops anything that is not a hex colour", () => {
    // The value lands in an inline style and comes from a remote API, so only the
    // one shape we expect is let through.
    expect(stateColor("red")).toBeUndefined();
    expect(stateColor("rgb(1,2,3)")).toBeUndefined();
    expect(stateColor("#12345")).toBeUndefined();
    expect(stateColor("#5e6ad2; background: url(http://x)")).toBeUndefined();
    expect(stateColor("")).toBeUndefined();
    expect(stateColor(undefined)).toBeUndefined();
  });
});

describe("badgedPriority", () => {
  it("badges only Urgent and High", () => {
    expect(badgedPriority(1)).toBe(1);
    expect(badgedPriority(2)).toBe(2);
  });

  it("leaves the middle of the scale unbadged", () => {
    // A badge on nearly every card is the same as a badge on none.
    expect(badgedPriority(0)).toBeNull();
    expect(badgedPriority(3)).toBeNull();
    expect(badgedPriority(4)).toBeNull();
    expect(badgedPriority(undefined)).toBeNull();
    expect(badgedPriority(null)).toBeNull();
  });
});

describe("progressPercent", () => {
  it("rounds a 0–1 fraction to a whole percentage", () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(0.013157894736842105)).toBe(1);
    expect(progressPercent(0.425)).toBe(43);
    expect(progressPercent(1)).toBe(100);
  });

  it("clamps a value outside the documented range", () => {
    // A bar must never outrun its own track.
    expect(progressPercent(1.4)).toBe(100);
    expect(progressPercent(-0.2)).toBe(0);
  });

  it("is null when there is no progress to show", () => {
    expect(progressPercent(undefined)).toBeNull();
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent(Number.NaN)).toBeNull();
  });
});

describe("formatDueDate", () => {
  const today = new Date(2026, 7, 3); // 3 Aug 2026, local time.

  /** The expected label, built the way the code does — the month's abbreviation is
   *  the runtime's to choose ("Sep" or "Sept"), so asserting one spelling would
   *  test ICU rather than this function. */
  const dayMonth = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });

  it("formats a date in the current year without it", () => {
    expect(formatDueDate("2026-09-11", today)).toBe(dayMonth(2026, 9, 11));
  });

  it("keeps the year when it is not the current one", () => {
    expect(formatDueDate("2025-01-07", today)).toBe(`${dayMonth(2025, 1, 7)} 2025`);
  });

  it("reads the date in local time, not UTC", () => {
    // Parsed through `new Date("2026-01-01")` this is UTC midnight, which is 31 Dec
    // for anyone west of Greenwich — a due date off by one day. The day number is
    // the assertion; the month abbreviation is the runtime's business.
    expect(formatDueDate("2026-01-01", today)).toBe(dayMonth(2026, 1, 1));
    // Whatever the locale's word order, the day must read 1 — never 31.
    expect(formatDueDate("2026-01-01", today)).not.toContain("31");
  });

  it("is null for a missing or malformed date", () => {
    expect(formatDueDate(undefined)).toBeNull();
    expect(formatDueDate(null)).toBeNull();
    expect(formatDueDate("")).toBeNull();
    expect(formatDueDate("2026-09")).toBeNull();
    expect(formatDueDate("11/09/2026")).toBeNull();
  });
});
