import { describe, it, expect } from "vitest";
import {
  actorLabel,
  activityVerb,
  formatRelativeTime,
  isReaction,
  leadingEmoji,
  notificationHeadline,
  sourceContext,
} from "./notifications";
import type { Notification } from "./protocol";

function notification(over: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    activity_type: "reactionInChat",
    activity_subtype: "laugh",
    actor_name: "Clément DELBARRE",
    actor_mri: "8:orgid:abc",
    source_thread_id: "19:abc@unq.gbl.spaces",
    source_message_id: "1784000000001",
    source_thread_topic: "",
    preview: "the target message",
    timestamp: 1_784_000_000_000,
    count: 1,
    is_read: false,
    ...over,
  };
}

describe("activityVerb / headline", () => {
  it("phrases a reaction with its emoji", () => {
    expect(activityVerb(notification({ activity_subtype: "heart" }))).toBe("reacted with ❤️");
    expect(notificationHeadline(notification({ activity_subtype: "heart" }))).toBe(
      "Clément DELBARRE reacted with ❤️",
    );
  });

  it("handles mentions and replies", () => {
    expect(activityVerb(notification({ activity_type: "mention" }))).toBe("mentioned you");
    expect(activityVerb(notification({ activity_type: "replyInChat" }))).toBe("replied to you");
  });

  it("phrases a followed-thread reply as a plain reply (not directed at us)", () => {
    // The Following feed (`activityType: "threads"`) is activity in a thread we
    // follow, not aimed at us — so it says "replied", never "…to you".
    expect(activityVerb(notification({ activity_type: "threads" }))).toBe("replied");
  });

  it("falls back for unknown activity types", () => {
    expect(activityVerb(notification({ activity_type: "somethingNew" }))).toBe(
      "sent you an activity",
    );
  });
});

describe("sourceContext", () => {
  it("returns the trimmed source thread topic, or empty when absent", () => {
    expect(sourceContext(notification({ source_thread_topic: "Platform Team" }))).toBe(
      "Platform Team",
    );
    expect(sourceContext(notification({ source_thread_topic: "  [Run] Devs  " }))).toBe(
      "[Run] Devs",
    );
    expect(sourceContext(notification({ source_thread_topic: "" }))).toBe("");
    expect(sourceContext(notification({ source_thread_topic: "   " }))).toBe("");
  });
});

describe("isReaction / leadingEmoji", () => {
  it("returns the reaction emoji for reactions and null otherwise", () => {
    expect(isReaction(notification())).toBe(true);
    expect(leadingEmoji(notification({ activity_subtype: "sad" }))).toBe("🙁");
    expect(isReaction(notification({ activity_type: "mention" }))).toBe(false);
    expect(leadingEmoji(notification({ activity_type: "mention" }))).toBeNull();
  });
});

describe("actorLabel", () => {
  it("falls back when the actor name is missing", () => {
    expect(actorLabel(notification({ actor_name: "" }))).toBe("Someone");
    expect(actorLabel(notification({ actor_name: "   " }))).toBe("Someone");
    expect(actorLabel(notification())).toBe("Clément DELBARRE");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_784_000_000_000;
  it("formats recent windows compactly", () => {
    expect(formatRelativeTime(now, now)).toBe("now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });

  it("uses a short date beyond a week and is empty for a zero timestamp", () => {
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).toMatch(/\w/);
    expect(formatRelativeTime(0, now)).toBe("");
  });
});
