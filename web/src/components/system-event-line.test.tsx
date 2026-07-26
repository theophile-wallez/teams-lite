// DOM-level tests for the system lines: a call notice, a thread activity (member
// added, message pinned), and — the one that matters most for a wire contract that
// keeps growing — an event kind this client does not know, which must render
// nothing at all rather than leak its payload into the timeline.
//
// Server-rendered, so no effects run: a thread activity shows the names Teams sent,
// which is exactly the first paint before any directory lookup answers.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SystemEventLine } from "./system-event-line";
import { ControllerProvider } from "./controller-context";
import type { SystemEvent } from "~/lib/protocol";

/** A backend URL nothing listens on: the provider only constructs a client here. */
const OFFLINE_URL = "ws://127.0.0.1:1";

function render(event: SystemEvent): string {
  return renderToStaticMarkup(
    <ControllerProvider url={OFFLINE_URL}>
      <SystemEventLine event={event} />
    </ControllerProvider>,
  );
}

describe("SystemEventLine — unknown kinds", () => {
  it("renders nothing for a kind this client predates", () => {
    expect(render({ kind: "thread_renamed" })).toBe("");
  });

  it("renders nothing rather than the raw payload of a nameless event", () => {
    const rawish = { kind: "", event: "whatever" } as SystemEvent;
    expect(render(rawish)).toBe("");
  });
});

describe("SystemEventLine — call events", () => {
  const out = render({ kind: "call", event: "ended", duration_seconds: 600 });

  it("renders a centered pill labelled with the call outcome", () => {
    expect(out).toContain('data-testid="system-event"');
    expect(out).toContain('data-system-event="call"');
    expect(out).toContain('data-call-event="ended"');
    expect(out).toContain("Call ended · 10 min");
  });

  it("flags a missed call instead of blending it in", () => {
    const missed = render({ kind: "call", event: "missed" });
    expect(missed).toContain("text-destructive");
    expect(missed).toContain("Missed call");
  });
});

describe("SystemEventLine — thread activities", () => {
  it("renders a member addition as a centered system line, like a call", () => {
    const out = render({
      kind: "thread_activity",
      event: "member_added",
      time_ms: 1781160917613,
      actor_mri: "8:orgid:actor",
      members: ["Nathan CAPIAUX"],
      member_mris: ["8:orgid:n"],
    });
    expect(out).toContain('data-testid="system-event"');
    expect(out).toContain('data-system-event="thread_activity"');
    expect(out).toContain('data-thread-activity="member_added"');
    expect(out).toContain("Nathan CAPIAUX was added to the chat");
  });

  it("counts members Teams did not name, rather than claiming there is one", () => {
    const out = render({
      kind: "thread_activity",
      event: "member_added",
      time_ms: 1,
      actor_mri: "8:orgid:actor",
      members: ["", ""],
      member_mris: ["8:orgid:a", "8:orgid:b"],
    });
    expect(out).toContain("2 people were added to the chat");
  });

  it("renders a pin and an unpin", () => {
    expect(render({ kind: "thread_activity", event: "pinned", time_ms: 1 })).toContain(
      "A message was pinned",
    );
    expect(render({ kind: "thread_activity", event: "unpinned", time_ms: 1 })).toContain(
      "A message was unpinned",
    );
  });

  it("renders nothing for a thread activity it has no sentence for", () => {
    expect(render({ kind: "thread_activity", event: "topic_updated", time_ms: 1 })).toBe("");
  });

  it("never renders the event's raw fields", () => {
    const out = render({
      kind: "thread_activity",
      event: "pinned",
      time_ms: 1781884089268,
      actor_mri: "8:orgid:e6d68aad",
    });
    expect(out).not.toContain("8:orgid:e6d68aad");
    expect(out).not.toContain("1781884089268");
  });
});

describe("SystemEventLine — meeting activities", () => {
  // Teams sends these as ordinary-looking messages whose localised body ("Scheduled
  // a meeting") used to be attributed to a contacts URL; the backend now keys them
  // off `properties.meeting["@type"]` (see parse_meeting_activity).
  const meeting = {
    kind: "meeting",
    event: "scheduled",
    title: "LAB GEN AI Monthly",
    start_ms: Date.UTC(2026, 4, 4, 12, 30),
    end_ms: Date.UTC(2026, 4, 4, 13, 30),
    location: "Microsoft Teams Meeting",
    organizer_mri: "8:orgid:8bbe7426",
    join_url: "https://teams.microsoft.com/l/meetup-join/x",
  } as const satisfies SystemEvent;

  it("renders a centered pill naming the meeting", () => {
    const out = render(meeting);
    expect(out).toContain('data-system-event="meeting"');
    expect(out).toContain('data-meeting="scheduled"');
    expect(out).toContain("Meeting scheduled · LAB GEN AI Monthly");
  });

  it("shows the schedule and a link that hands off to Teams", () => {
    const out = render(meeting);
    expect(out).toContain('data-testid="meeting-schedule"');
    expect(out).toContain('data-testid="meeting-join"');
    expect(out).toContain("https://teams.microsoft.com/l/meetup-join/x");
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("offers no join link on a cancelled meeting — there is nothing to join", () => {
    const out = render({ ...meeting, event: "cancelled" });
    expect(out).toContain("Meeting cancelled · LAB GEN AI Monthly");
    expect(out).not.toContain('data-testid="meeting-join"');
  });

  it("omits the default Teams location, keeps a real one", () => {
    expect(render(meeting)).not.toContain('data-testid="meeting-location"');
    const inRoom = render({ ...meeting, location: "Room 4.02" });
    expect(inRoom).toContain('data-testid="meeting-location"');
    expect(inRoom).toContain("Room 4.02");
  });

  it("renders nothing for a meeting activity it has no words for", () => {
    expect(render({ ...meeting, event: "reminded" })).toBe("");
  });

  it("never renders the event's raw fields", () => {
    const out = render(meeting);
    expect(out).not.toContain("8:orgid:8bbe7426");
    expect(out).not.toContain(String(meeting.start_ms));
  });
});
