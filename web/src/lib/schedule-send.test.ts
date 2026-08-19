import { describe, expect, it } from "vitest";
import {
  MAX_SCHEDULE_AHEAD_MS,
  SCHEDULE_HINT,
  SCHEDULE_EVENING_HOUR,
  SCHEDULE_MORNING_HOUR,
  datetimeLocalValue,
  parseDatetimeLocal,
  presetRowLabel,
  scheduleLabel,
  scheduleRefusal,
  schedulePresets,
  scheduledBanner,
  scheduledRowLabel,
} from "./schedule-send";

/** A Wednesday at 10:00 local time. */
const wednesdayMorning = new Date(2026, 7, 19, 10, 0, 0, 0);

describe("schedulePresets", () => {
  it("offers this evening, tomorrow morning and Monday morning", () => {
    const presets = schedulePresets(wednesdayMorning);
    expect(presets.map((p) => p.key)).toEqual(["evening", "tomorrow", "monday"]);
    const [evening, tomorrow, monday] = presets.map((p) => new Date(p.at)) as [Date, Date, Date];
    expect(evening.getHours()).toBe(SCHEDULE_EVENING_HOUR);
    expect(evening.getDate()).toBe(19);
    expect(tomorrow.getHours()).toBe(SCHEDULE_MORNING_HOUR);
    expect(tomorrow.getDate()).toBe(20);
    // The Monday after this Wednesday, never today and never a day already gone.
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(24);
  });

  it("drops a preset that has already passed rather than shifting it", () => {
    // 20:00 — "this evening" is behind us, and the menu must not offer a moment the
    // backend would refuse.
    const presets = schedulePresets(new Date(2026, 7, 19, 20, 0, 0, 0));
    expect(presets.map((p) => p.key)).toEqual(["tomorrow", "monday"]);
  });

  it("drops a preset that duplicates another moment", () => {
    // On a SUNDAY, tomorrow morning IS Monday morning: two rows doing one thing ask the
    // reader to compare them to learn nothing.
    const sunday = new Date(2026, 7, 23, 10, 0, 0, 0);
    expect(sunday.getDay()).toBe(0);
    const presets = schedulePresets(sunday);
    expect(presets.map((p) => p.key)).toEqual(["evening", "tomorrow"]);
  });

  it("never offers a moment in the past, whatever the day", () => {
    for (let day = 19; day < 26; day += 1) {
      for (const hour of [0, 8, 9, 12, 18, 19, 23]) {
        const now = new Date(2026, 7, day, hour, 30, 0, 0);
        for (const preset of schedulePresets(now)) {
          expect(preset.at).toBeGreaterThan(now.getTime());
          expect(scheduleRefusal(preset.at, now.getTime())).toBeNull();
        }
      }
    }
  });
});

describe("scheduleLabel", () => {
  it("names today and tomorrow rather than a date", () => {
    expect(scheduleLabel(new Date(2026, 7, 19, 18, 0).getTime(), wednesdayMorning)).toMatch(
      /^today at /,
    );
    expect(scheduleLabel(new Date(2026, 7, 20, 9, 0).getTime(), wednesdayMorning)).toMatch(
      /^tomorrow at /,
    );
  });

  it("names the weekday inside a week and the date beyond it", () => {
    expect(scheduleLabel(new Date(2026, 7, 24, 9, 0).getTime(), wednesdayMorning)).toMatch(
      /^Monday at /,
    );
    expect(scheduleLabel(new Date(2026, 8, 30, 9, 0).getTime(), wednesdayMorning)).not.toMatch(
      /^(today|tomorrow|Monday) /,
    );
  });
});

describe("scheduleRefusal", () => {
  it("refuses a moment that has passed", () => {
    const now = wednesdayMorning.getTime();
    expect(scheduleRefusal(now - 1, now)).toBeTruthy();
    expect(scheduleRefusal(now, now)).toBeTruthy();
    expect(scheduleRefusal(now + 1000, now)).toBeNull();
  });

  it("refuses a moment past the 120-day ceiling the backend enforces", () => {
    const now = wednesdayMorning.getTime();
    expect(scheduleRefusal(now + MAX_SCHEDULE_AHEAD_MS, now)).toBeNull();
    expect(scheduleRefusal(now + MAX_SCHEDULE_AHEAD_MS + 1, now)).toBeTruthy();
  });

  it("refuses a half-typed picker value rather than sending NaN", () => {
    expect(scheduleRefusal(parseDatetimeLocal(""), wednesdayMorning.getTime())).toBeTruthy();
    expect(
      scheduleRefusal(parseDatetimeLocal("not a date"), wednesdayMorning.getTime()),
    ).toBeTruthy();
  });
});

describe("the native picker's value", () => {
  it("round-trips LOCAL time, never UTC", () => {
    // `toISOString` would move the moment by the timezone offset, so the reader would be
    // offered a different hour from the one they picked.
    const value = datetimeLocalValue(wednesdayMorning);
    expect(value).toBe("2026-08-19T10:00");
    expect(parseDatetimeLocal(value)).toBe(wednesdayMorning.getTime());
  });
});

describe("what a queued message says about itself", () => {
  it("the banner names the moment, because the message is in no thread", () => {
    const note = scheduledBanner([new Date(2026, 7, 20, 9, 0).getTime()], wednesdayMorning);
    expect(note).toContain("tomorrow at");
    expect(note?.toLowerCase()).toContain("will be sent");
  });

  it("nothing queued is no banner at all", () => {
    // It is DERIVED from the queue, which is what keeps it honest: a line set by the send
    // that queued a message went stale the moment that message was cancelled.
    expect(scheduledBanner([], wednesdayMorning)).toBeNull();
  });

  it("several queued count themselves and name the SOONEST", () => {
    const monday = new Date(2026, 7, 24, 9, 0).getTime();
    const tomorrow = new Date(2026, 7, 20, 9, 0).getTime();
    // Given out of order on purpose: the caller hands over what is queued, not a sorted list.
    const note = scheduledBanner([monday, tomorrow], wednesdayMorning);
    expect(note).toContain("2 messages scheduled");
    expect(note).toContain("tomorrow at");
    expect(note).not.toContain("Monday");
  });

  it("a MENU row names the moment once, capitalised", () => {
    // It used to carry a name AND a time — "Tomorrow morning" beside "tomorrow at 09:00" —
    // which is one fact twice and wrapped the row onto two lines.
    const [, tomorrow] = schedulePresets(wednesdayMorning);
    const label = presetRowLabel(tomorrow!, wednesdayMorning);
    expect(label).toMatch(/^Tomorrow at /);
    expect(label.toLowerCase()).not.toContain("morning");
  });

  it("a row in the list says when it GOES, not when it was queued", () => {
    // The row answers "what have I got waiting", so it reads as an instruction about the
    // future rather than as a timestamp — which is what a message bubble already carries.
    const row = scheduledRowLabel(new Date(2026, 7, 20, 9, 0).getTime(), wednesdayMorning);
    expect(row).toMatch(/^Send tomorrow at /);
  });

  it("the hint promises the cancel this app really has", () => {
    // It used to send the reader to Teams, because nothing here could cancel one. The
    // measured DELETE changed that, and a hint that still pointed away would be this app
    // hiding a feature it has.
    expect(SCHEDULE_HINT.toLowerCase()).toContain("cancel");
    expect(SCHEDULE_HINT.toLowerCase()).not.toContain("in teams itself");
  });
});
