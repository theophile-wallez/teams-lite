// Behavior tests for presenting a person's presence: what the badge is coloured
// by, what the card calls the state, and when it says "last seen".
import { describe, it, expect } from "vitest";
import { lastSeenLabel, presenceIsUnknown, presenceLabel, presenceTone } from "./presence";
import type { PersonPresence } from "./protocol";

function presence(patch: Partial<PersonPresence> = {}): PersonPresence {
  return {
    mri: "8:orgid:aaa",
    availability: "Available",
    activity: "Available",
    last_active_ms: 0,
    out_of_office: false,
    out_of_office_note: "",
    note: "",
    ...patch,
  };
}

describe("presenceTone", () => {
  it("maps Teams availabilities to their colour family", () => {
    expect(presenceTone(presence({ availability: "Available" }))).toBe("available");
    expect(presenceTone(presence({ availability: "AvailableIdle" }))).toBe("available");
    expect(presenceTone(presence({ availability: "Busy" }))).toBe("busy");
    expect(presenceTone(presence({ availability: "DoNotDisturb" }))).toBe("busy");
    expect(presenceTone(presence({ availability: "Away" }))).toBe("away");
    expect(presenceTone(presence({ availability: "BeRightBack" }))).toBe("away");
    expect(presenceTone(presence({ availability: "Offline" }))).toBe("offline");
  });

  it("treats a missing or unrecognized presence as unknown", () => {
    expect(presenceTone(null)).toBe("unknown");
    expect(presenceTone(undefined)).toBe("unknown");
    expect(presenceTone(presence({ availability: "PresenceUnknown" }))).toBe("unknown");
    expect(presenceTone(presence({ availability: "SomethingNew" }))).toBe("unknown");
  });

  it("shows out-of-office only when the live state says less", () => {
    // Offline + calendar OOF -> Teams' out-of-office badge.
    expect(
      presenceTone(presence({ availability: "Offline", activity: "Offline", out_of_office: true })),
    ).toBe("oof");
    // Actively in a meeting while also OOF -> the live state wins.
    expect(
      presenceTone(presence({ availability: "Busy", activity: "InAMeeting", out_of_office: true })),
    ).toBe("busy");
  });
});

describe("presenceLabel", () => {
  it("prefers the finer activity over the coarse availability", () => {
    expect(presenceLabel(presence({ availability: "Busy", activity: "InAMeeting" }))).toBe(
      "In a meeting",
    );
    expect(presenceLabel(presence({ availability: "Busy", activity: "InACall" }))).toBe("In a call");
    expect(presenceLabel(presence({ availability: "DoNotDisturb", activity: "Presenting" }))).toBe(
      "Presenting",
    );
  });

  it("falls back to the availability when the activity just restates it", () => {
    expect(presenceLabel(presence({ availability: "Available", activity: "Available" }))).toBe(
      "Available",
    );
    expect(presenceLabel(presence({ availability: "BeRightBack", activity: "BeRightBack" }))).toBe(
      "Be right back",
    );
  });

  it("humanizes a state Teams adds that we don't know yet", () => {
    expect(presenceLabel(presence({ availability: "InSomeNewState", activity: "InSomeNewState" }))).toBe(
      "In some new state",
    );
  });

  it("says out of office when that is the most useful thing to say", () => {
    expect(
      presenceLabel(presence({ availability: "Offline", activity: "Offline", out_of_office: true })),
    ).toBe("Out of office");
    // …but never hides a live state behind it.
    expect(
      presenceLabel(presence({ availability: "Busy", activity: "InAMeeting", out_of_office: true })),
    ).toBe("In a meeting");
    // Nothing known at all, but the calendar says away.
    expect(
      presenceLabel(
        presence({ availability: "PresenceUnknown", activity: "PresenceUnknown", out_of_office: true }),
      ),
    ).toBe("Out of office");
  });

  it("reads as Unknown when there is nothing to say", () => {
    expect(presenceLabel(null)).toBe("Unknown");
    expect(presenceLabel(presence({ availability: "PresenceUnknown", activity: "PresenceUnknown" }))).toBe(
      "Unknown",
    );
  });
});

describe("presenceIsUnknown", () => {
  it("is true only when we have nothing meaningful", () => {
    expect(presenceIsUnknown(null)).toBe(true);
    expect(presenceIsUnknown(presence({ availability: "PresenceUnknown" }))).toBe(true);
    expect(presenceIsUnknown(presence({ availability: "Offline" }))).toBe(false);
    // An unknown availability with the calendar saying out-of-office is still
    // worth showing.
    expect(
      presenceIsUnknown(presence({ availability: "PresenceUnknown", out_of_office: true })),
    ).toBe(false);
  });
});

describe("lastSeenLabel", () => {
  const now = 1_800_000_000_000;
  const offline = (lastActive: number) =>
    presence({ availability: "Offline", activity: "Offline", last_active_ms: lastActive });

  it("describes how long ago someone unreachable was active", () => {
    expect(lastSeenLabel(offline(now - 30_000), now)).toBe("Last seen just now");
    expect(lastSeenLabel(offline(now - 20 * 60_000), now)).toBe("Last seen 20 min ago");
    expect(lastSeenLabel(offline(now - 3 * 3_600_000), now)).toBe("Last seen 3 h ago");
    expect(lastSeenLabel(offline(now - 26 * 3_600_000), now)).toBe("Last seen yesterday");
    expect(lastSeenLabel(offline(now - 3 * 24 * 3_600_000), now)).toBe("Last seen 3 days ago");
  });

  it("stays quiet when the figure would be noise or misleading", () => {
    // Reachable: their state already says everything.
    expect(lastSeenLabel(presence({ last_active_ms: now - 60_000 }), now)).toBeNull();
    // No timestamp, or none at all.
    expect(lastSeenLabel(offline(0), now)).toBeNull();
    expect(lastSeenLabel(null, now)).toBeNull();
    // Over a week ago, or a clock skew putting it in the future.
    expect(lastSeenLabel(offline(now - 40 * 24 * 3_600_000), now)).toBeNull();
    expect(lastSeenLabel(offline(now + 60_000), now)).toBeNull();
  });

  it("still reports it for someone out of office", () => {
    const oof = presence({
      availability: "Offline",
      activity: "Offline",
      out_of_office: true,
      last_active_ms: now - 45 * 60_000,
    });
    expect(lastSeenLabel(oof, now)).toBe("Last seen 45 min ago");
  });
});
