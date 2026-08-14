import { describe, expect, it } from "vitest";
import { availabilityLine, hoursDraft, hoursLabel } from "./presence-hours";
import type { AppSettings } from "./protocol";

const SETTINGS: AppSettings = {
  gitlab_host: "gitlab.com",
  gitlab_token_set: false,
  linear_token_set: false,
  ghost_mode: false,
  always_available: false,
  available_from: null,
  available_to: null,
  available_now: false,
  sender_icons: true,
  emoji_auto_import: true,
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
