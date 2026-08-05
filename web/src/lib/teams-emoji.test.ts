import { describe, it, expect } from "vitest";
import {
  appleEmojiUrl,
  canReactWith,
  customReactionArt,
  customReactionKey,
  emojiUnified,
  reactionEmoji,
  teamsReactionKey,
  REACTION_PICKER,
} from "./teams-emoji";

describe("reactionEmoji", () => {
  it("maps the classic reactions the way Microsoft's catalog does", () => {
    expect(reactionEmoji("like")).toBe("👍");
    expect(reactionEmoji("heart")).toBe("❤️");
    // Teams' "laugh" is 😆; 😂 is a different reaction (`cwl`, crying with
    // laughter), and both turn up on real messages.
    expect(reactionEmoji("laugh")).toBe("😆");
    expect(reactionEmoji("cwl")).toBe("😂");
    expect(reactionEmoji("surprised")).toBe("😮");
    expect(reactionEmoji("sad")).toBe("🙁");
    expect(reactionEmoji("angry")).toBe("😠");
  });

  it("resolves the extended reactions a real tenant sends", () => {
    // Teams' own animated emoji, named rather than encoded…
    expect(reactionEmoji("fire")).toBe("🔥");
    expect(reactionEmoji("skull")).toBe("💀");
    expect(reactionEmoji("rofl")).toBe("🤣");
    expect(reactionEmoji("croissant")).toBe("🥐");
    // …and the `<code points>_<name>` form for plain Unicode emoji.
    expect(reactionEmoji("1f389_partypopper")).toBe("🎉");
    expect(reactionEmoji("2728_sparkles")).toBe("✨");
    expect(reactionEmoji("1f4af_hundredpointssymbol")).toBe("💯");
  });

  it("applies skin tone suffixes to the base reaction", () => {
    expect(reactionEmoji("yes-tone2")).toBe("👍🏼");
    expect(reactionEmoji("handshake-tone5")).toBe("🤝🏿");
  });

  it("is case-insensitive", () => {
    expect(reactionEmoji("LAUGH")).toBe("😆");
    expect(reactionEmoji("  Fire  ")).toBe("🔥");
  });

  it("decodes an unknown key that still carries its code points", () => {
    // A reaction added after our catalog snapshot: the id names the emoji.
    expect(reactionEmoji("1f9ff_amulet")).toBe("🧿");
  });

  it("falls back to a neutral glyph for anything unresolvable", () => {
    // `follow` and `acks` are real subtypes with no emoji in the catalog.
    expect(reactionEmoji("follow")).toBe("👍");
    expect(reactionEmoji("someNewReaction")).toBe("👍");
    expect(reactionEmoji("")).toBe("👍");
  });
});

describe("teamsReactionKey", () => {
  it("names an emoji the way Teams does", () => {
    expect(teamsReactionKey("👍")).toBe("like");
    expect(teamsReactionKey("🔥")).toBe("fire");
    expect(teamsReactionKey("🎉")).toBe("1f389_partypopper");
  });

  it("matches regardless of the presentation selector", () => {
    expect(teamsReactionKey("❤️")).toBe("heart");
    expect(teamsReactionKey("❤")).toBe("heart");
  });

  it("routes a skin tone through an id Microsoft documents as toneable", () => {
    // 👍 is `like` plain, but a toned thumbs-up is the hand gesture `yes` —
    // `yes-tone2` is exactly what a real tenant stores.
    expect(teamsReactionKey("👍🏼")).toBe("yes-tone2");
    expect(teamsReactionKey("🤝🏿")).toBe("handshake-tone5");
  });

  it("reacts untoned rather than inventing a suffix Teams doesn't accept", () => {
    // Defensive: today every toneable emoji-mart skin resolves to a documented
    // `-tone{n}` id, but if a future emoji set tones an emoji Microsoft's tables
    // don't, the reaction degrades to the plain one instead of sending a key no
    // Teams client could render (or silently doing nothing).
    expect(teamsReactionKey("🥐\u{1F3FD}")).toBe("croissant");
  });

  it("has no key for an emoji Teams cannot react with", () => {
    expect(teamsReactionKey("👨‍👩‍👧‍👦")).toBeNull();
    expect(canReactWith("👨‍👩‍👧‍👦")).toBe(false);
    expect(canReactWith("🔥")).toBe(true);
  });

  it("round-trips every reaction in the quick row", () => {
    for (const { key, emoji } of REACTION_PICKER) {
      expect(reactionEmoji(key)).toBe(emoji);
      expect(teamsReactionKey(emoji)).toBe(key);
    }
  });
});

describe("REACTION_PICKER", () => {
  it("offers the six classic reactions in Teams order", () => {
    expect(REACTION_PICKER.map((r) => r.key)).toEqual([
      "like",
      "heart",
      "laugh",
      "surprised",
      "sad",
      "angry",
    ]);
  });
});

describe("Apple emoji images", () => {
  it("names an emoji by its code points, padded the way the files are", () => {
    expect(emojiUnified("🔥")).toBe("1f525");
    expect(emojiUnified("❤️")).toBe("2764-fe0f");
    expect(emojiUnified("#️⃣")).toBe("0023-fe0f-20e3");
    expect(emojiUnified("👍🏼")).toBe("1f44d-1f3fc");
  });

  it("serves them from our own origin, never a CDN", () => {
    expect(appleEmojiUrl("🔥")).toBe("/emoji/apple/64/1f525.png");
  });
});

describe("customReactionKey", () => {
  it("names the art in the key, and reads it back", () => {
    const key = customReactionKey("shipit", "0-weu-d1-abc");
    expect(customReactionArt(key)).toEqual({
      name: "shipit",
      src: expect.stringContaining("0-weu-d1-abc"),
    });
  });

  it("round-trips a name with hyphens", () => {
    const key = customReactionKey("smirk-cat", "0-frc-d4-xyz123");
    const parsed = customReactionArt(key);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("smirk-cat");
    expect(parsed!.src).toContain("0-frc-d4-xyz123");
  });

  it("leaves Microsoft's own keys alone", () => {
    expect(customReactionArt("like")).toBeNull();
    expect(customReactionArt("yes-tone2")).toBeNull();
    expect(reactionEmoji("like")).toBe("👍");
  });
});
