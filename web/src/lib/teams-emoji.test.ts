import { describe, it, expect } from "vitest";
import { mediaNeedsProxy } from "./protocol";
import {
  appleEmojiUrl,
  canReactWith,
  customReactionArt,
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
  // Through `appleEmojiUrl` rather than through the code-point helper it is built on: the
  // URL is what a caller can ask for, and the file names ARE the padding rule.
  it("names an emoji by its code points, padded the way the files are", () => {
    expect(appleEmojiUrl("❤️")).toBe("/emoji/apple/64/2764-fe0f.png");
    expect(appleEmojiUrl("#️⃣")).toBe("/emoji/apple/64/0023-fe0f-20e3.png");
    expect(appleEmojiUrl("👍🏼")).toBe("/emoji/apple/64/1f44d-1f3fc.png");
  });

  it("serves them from our own origin, never a CDN", () => {
    expect(appleEmojiUrl("🔥")).toBe("/emoji/apple/64/1f525.png");
  });
});

describe("customReactionArt", () => {
  const OBJECT_URL = "https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/views/imgo";

  it("hands back the whole URL the key carries", () => {
    expect(customReactionArt(`tlcustom-${OBJECT_URL}`)).toEqual({ src: OBJECT_URL });
  });

  it("is a URL the media proxy will carry, so the art needs no second rail", () => {
    const art = customReactionArt(`tlcustom-${OBJECT_URL}`);
    expect(art).not.toBeNull();
    expect(mediaNeedsProxy(art!.src)).toBe(true);
  });

  it("leaves Microsoft's own keys alone", () => {
    expect(customReactionArt("like")).toBeNull();
    expect(customReactionArt("yes-tone2")).toBeNull();
    expect(reactionEmoji("like")).toBe("👍");
  });

  it("names no art for a key that carries no URL", () => {
    // The shape this app used to mint: a NAME and an AMS id, with no host and no
    // delimiter that a legal name could not contain (`blob-2`, `parrot-1`).
    expect(customReactionArt("tlcustom-shipit-0-weu-d1-abc")).toBeNull();
    expect(customReactionArt("tlcustom-")).toBeNull();
  });

  it("refuses a key that would make the reader's browser fetch a stranger's server", () => {
    // The key above is one WE minted, which proves nothing about an inbound one: a key is
    // written by whoever reacted, and Teams accepts an arbitrary long one. Drawing this
    // would issue the request as the bubble rendered — a tracking pixel arriving as a
    // reaction, in an app that strips them out of mail bodies.
    expect(customReactionArt("tlcustom-https://evil.example/p.png")).toBeNull();
    expect(customReactionArt("tlcustom-https://evil.example/p.png?who=reader")).toBeNull();
    // A look-alike host is not the proxy's either.
    expect(customReactionArt("tlcustom-https://skype.com.evil.example/p.png")).toBeNull();
    // And the legitimate key still draws, so the rail refuses hosts rather than reactions.
    expect(customReactionArt(`tlcustom-${OBJECT_URL}`)).toEqual({ src: OBJECT_URL });
  });
});
