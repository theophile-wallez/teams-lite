import { describe, it, expect } from "vitest";
import {
  actorLabel,
  activityVerb,
  formatRelativeTime,
  isReaction,
  leadingEmoji,
  notificationHeadline,
  reactionEmoji,
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
    preview: "the target message",
    timestamp: 1_784_000_000_000,
    count: 1,
    is_read: false,
    ...over,
  };
}

describe("reactionEmoji", () => {
  it("maps every known Teams reaction subtype", () => {
    expect(reactionEmoji("like")).toBe("👍");
    expect(reactionEmoji("heart")).toBe("❤️");
    expect(reactionEmoji("laugh")).toBe("😂");
    expect(reactionEmoji("surprised")).toBe("😮");
    expect(reactionEmoji("sad")).toBe("😢");
    expect(reactionEmoji("angry")).toBe("😡");
    expect(reactionEmoji("handshake")).toBe("🤝");
    expect(reactionEmoji("confused")).toBe("😕");
  });

  it("is case-insensitive and falls back for unknown subtypes", () => {
    expect(reactionEmoji("LAUGH")).toBe("😂");
    expect(reactionEmoji("someNewReaction")).toBe("👍");
    expect(reactionEmoji("")).toBe("👍");
  });
});

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

  it("falls back for unknown activity types", () => {
    expect(activityVerb(notification({ activity_type: "somethingNew" }))).toBe(
      "sent you an activity",
    );
  });
});

describe("isReaction / leadingEmoji", () => {
  it("returns the reaction emoji for reactions and null otherwise", () => {
    expect(isReaction(notification())).toBe(true);
    expect(leadingEmoji(notification({ activity_subtype: "sad" }))).toBe("😢");
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
