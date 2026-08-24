import { describe, expect, it } from "vitest";
import {
  availabilityLine,
  hhmmFromMinutes,
  hoursDraft,
  hoursFromSlider,
  hoursLabel,
  hoursSlider,
  minutesFromHhmm,
  MINUTES_PER_DAY,
  suggestedZone,
} from "./presence-hours";
import type { AppSettings } from "./protocol";

const SETTINGS: AppSettings = {
  gitlab_host: "gitlab.com",
  gitlab_token_set: false,
  linear_token_set: false,
  ghost_mode: false,
  always_available: false,
  available_from: null,
  available_to: null,
  available_zone: null,
  available_now: false,
  sender_icons: true,
  emoji_auto_import: true,
  sealed_push_words: false,
};

describe("hoursDraft", () => {
  it("reads both ends, or neither, and calls one end what it is", () => {
    expect(hoursDraft("08:00", "19:00")).toEqual({
      kind: "hours",
      hours: { from: "08:00", to: "19:00" },
    });
    // Empty is all day — what this setting did before it grew hours.
    expect(hoursDraft("", "")).toEqual({ kind: "all-day" });
    expect(hoursDraft("  ", "")).toEqual({ kind: "all-day" });
    // One end is not something the backend can store: a half window reads both as "all day
    // from 8" and as "8 until whenever", so nothing is sent until the reader says which.
    expect(hoursDraft("08:00", "").kind).toBe("incomplete");
    expect(hoursDraft("", "19:00").kind).toBe("incomplete");
  });
});

describe("availabilityLine", () => {
  it("says Teams decides while the switch is off", () => {
    expect(availabilityLine(SETTINGS)).toContain("Teams decides your status");
  });

  it("says all day when the switch is on with no hours", () => {
    const line = availabilityLine({ ...SETTINGS, always_available: true, available_now: true });
    expect(line).toContain("all day");
  });

  it("names the end of the hours while they are running", () => {
    const line = availabilityLine({
      ...SETTINGS,
      always_available: true,
      available_from: "08:00",
      available_to: "19:00",
      available_now: true,
    });
    expect(line).toContain("19:00");
    expect(line).not.toContain("all day");
  });

  it("names the START of the hours while the status is not published", () => {
    // The state the whole feature exists for: 03:00, the switch on, and nothing green.
    const line = availabilityLine({
      ...SETTINGS,
      always_available: true,
      available_from: "08:00",
      available_to: "19:00",
      available_now: false,
    });
    expect(line).toContain("08:00");
    expect(line).toContain("Teams decides your status");
  });
});

describe("hoursLabel", () => {
  it("spells a window with an en dash", () => {
    expect(hoursLabel({ from: "08:00", to: "19:00" })).toBe("08:00 – 19:00");
  });
});

describe("the slider's two ends", () => {
  it("reads an ordinary window as two ordered thumbs", () => {
    expect(hoursSlider({ from: "08:00", to: "19:00" })).toEqual({
      values: [8 * 60, 19 * 60],
      wrapped: false,
    });
  });

  it("reads a window that crosses midnight as the same thumbs, filled OUTSIDE", () => {
    // A slider's thumbs cannot pass each other, so 22:00-06:00 is the pair [06:00, 22:00]
    // with the green on the outside — which is what `wrapped` tells the pane to draw.
    expect(hoursSlider({ from: "22:00", to: "06:00" })).toEqual({
      values: [6 * 60, 22 * 60],
      wrapped: true,
    });
  });

  it("stands for nothing when there is no window to draw", () => {
    expect(hoursSlider(null)).toBeNull();
    // Two equal hours are what the backend refuses, so the slider has no span for them.
    expect(hoursSlider({ from: "09:00", to: "09:00" })).toBeNull();
    expect(hoursSlider({ from: "9am", to: "19:00" })).toBeNull();
  });

  it("keeps the MODE when a drag is turned back into a window", () => {
    // The same two positions, and the opposite half of the day: without the mode, one drag
    // would silently turn a night shift into a working day.
    expect(hoursFromSlider([6 * 60, 22 * 60], false)).toEqual({ from: "06:00", to: "22:00" });
    expect(hoursFromSlider([6 * 60, 22 * 60], true)).toEqual({ from: "22:00", to: "06:00" });
    // Radix hands the values in thumb order, which is not always ascending.
    expect(hoursFromSlider([22 * 60, 6 * 60], false)).toEqual({ from: "06:00", to: "22:00" });
    // Midnight at either end is 00:00, never 24:00 — the wire takes one spelling.
    expect(hoursFromSlider([0, MINUTES_PER_DAY], false)).toEqual({ from: "00:00", to: "00:00" });
  });

  it("round-trips an hour through minutes", () => {
    expect(minutesFromHhmm("08:30")).toBe(8 * 60 + 30);
    expect(minutesFromHhmm("00:00")).toBe(0);
    expect(minutesFromHhmm("23:59")).toBe(23 * 60 + 59);
    for (const bad of ["", "8", "24:00", "12:60", "8:00pm"]) {
      expect(minutesFromHhmm(bad)).toBeNull();
    }
    expect(hhmmFromMinutes(8 * 60 + 30)).toBe("08:30");
    expect(hhmmFromMinutes(MINUTES_PER_DAY)).toBe("00:00");
  });
});

describe("suggestedZone", () => {
  it("offers the browser's zone only when it is not the stored one", () => {
    // The whole reason the zone is a setting: the reader travels, the backend does not.
    expect(suggestedZone("Europe/Paris", "Asia/Tokyo")).toBe("Asia/Tokyo");
    // A control that changes nothing reads as a bug.
    expect(suggestedZone("Asia/Tokyo", "Asia/Tokyo")).toBeNull();
    expect(suggestedZone(null, null)).toBeNull();
    // Nothing stored is the machine's zone, which the reader cannot see — so the offer stands.
    expect(suggestedZone(null, "Europe/Paris")).toBe("Europe/Paris");
  });
});
