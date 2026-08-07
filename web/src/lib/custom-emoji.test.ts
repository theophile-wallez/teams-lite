import { describe, it, expect } from "vitest";
import {
  bodyIsOnlyEmoji,
  customEmojiNameError,
  emojiSuggestions,
  emojiQueryBefore,
  extractableCustomEmoji,
  insertedEmojiName,
  originalArtUrl,
} from "./custom-emoji";
import { parseRichHtml } from "./rich-text";

describe("customEmojiNameError", () => {
  it("names a taken emoji with Slack's own sentence", () => {
    expect(customEmojiNameError("shipit", ["shipit"])).toBe(
      "If your emoji name is taken, choose another.",
    );
    expect(customEmojiNameError("Ship It", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("shipit", [])).toBeNull();
  });

  it("ports the name rule from custom_emoji::is_valid_name", () => {
    expect(customEmojiNameError("shipit", [])).toBeNull();
    expect(customEmojiNameError("ship-it_2+", [])).toBeNull();
    expect(customEmojiNameError("0", [])).toBeNull();
    expect(customEmojiNameError("a".repeat(64), [])).toBeNull();
    expect(customEmojiNameError("", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("ShipIt", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("+ship", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("-ship", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("_ship", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("ship it", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("ship:it", [])).toMatch(/lowercase/);
    expect(customEmojiNameError("a".repeat(65), [])).toMatch(/lowercase/);
  });
});

describe("emojiSuggestions", () => {
  function emoji(name: string): import("./protocol").CustomEmoji {
    return {
      name,
      alias_of: "",
      content_type: "image/png",
      width: 64,
      height: 64,
      source: "local",
      added_ms: Date.now(),
    };
  }

  it("offers custom emoji before Unicode ones", () => {
    const pack = [emoji("smirk-cat"), emoji("shipit")];
    const unicode: [string, string][] = [
      ["smile", "😄"],
      ["smiley", "😃"],
    ];
    const out = emojiSuggestions("sm", pack, unicode);
    expect(out[0]).toEqual({ kind: "custom", name: "smirk-cat" });
    // Every custom result precedes the first Unicode one.
    const firstUnicode = out.findIndex((s) => s.kind === "unicode");
    const lastCustom = out.map((s, i) => (s.kind === "custom" ? i : -1)).filter((i) => i >= 0);
    // Unconditionally: the fixture holds both kinds, so a guard here would let the
    // ordering this test is named after go untested the day the ranking dropped one band.
    expect(firstUnicode).toBeGreaterThanOrEqual(0);
    expect(Math.max(...lastCustom)).toBeLessThan(firstUnicode);
  });

  it("matches an alias by its own name", () => {
    const pack = [{ ...emoji("ship"), alias_of: "shipit" }];
    expect(emojiSuggestions("shi", pack, [])).toEqual([{ kind: "custom", name: "ship" }]);
  });

  it("offers the pack for an empty query, so a lone colon shows what this machine holds", () => {
    const pack = [emoji("shipit"), emoji("smirk-cat")];
    expect(emojiSuggestions("", pack, [["smile", "😄"]])).toEqual([
      { kind: "custom", name: "shipit" },
      { kind: "custom", name: "smirk-cat" },
    ]);
  });

  it("offers no UNICODE emoji for an empty query, which would bury the pack", () => {
    // Every shortcode matches an empty prefix, so the ten that came first alphabetically
    // would be the whole list — and the pack is what the reader asked to see.
    const unicode: [string, string][] = [
      ["smile", "😄"],
      ["zzz", "💤"],
    ];
    expect(emojiSuggestions("", [emoji("shipit")], unicode)).toEqual([
      { kind: "custom", name: "shipit" },
    ]);
  });

  it("sorts the empty query's rows by name, whatever order the pack arrived in", () => {
    // The store orders them (`ORDER BY name ASC`) and the mock does not, so the menu must
    // not depend on which backend answered.
    const pack = [emoji("shipit"), emoji("partyparrot"), emoji("ship")];
    expect(emojiSuggestions("", pack, []).map((s) => s.name)).toEqual([
      "partyparrot",
      "ship",
      "shipit",
    ]);
  });

  it("leaves Unicode out of the empty query, whose first rows would be `:100:` and `:1234:`", () => {
    // The index is in generated order, not alphabetical, so its head is noise in front of
    // the rows the user opened the menu for. One typed letter brings the band back.
    const unicode: [string, string][] = [
      ["100", "💯"],
      ["1234", "🔢"],
    ];
    expect(emojiSuggestions("", [], unicode)).toEqual([]);
    expect(emojiSuggestions("1", [], unicode)).toEqual([
      { kind: "unicode", name: "100", native: "💯" },
      { kind: "unicode", name: "1234", native: "🔢" },
    ]);
  });

  it("holds the empty query to the same limit as any other", () => {
    const pack = Array.from({ length: 30 }, (_, i) => emoji(`art-${i}`));
    expect(emojiSuggestions("", pack, []).length).toBe(10);
    expect(emojiSuggestions("", pack, [], 3).length).toBe(3);
  });

  it("offers nothing for an empty query on a machine with no pack", () => {
    expect(emojiSuggestions("", [], [["smile", "😄"]])).toEqual([]);
  });
});

describe("emojiQueryBefore", () => {
  it("returns null for prose with a colon, not an emoji code", () => {
    expect(emojiQueryBefore("note: this")).toBeNull();
  });

  it("returns null for a completed emoji code", () => {
    expect(emojiQueryBefore(":shipit:")).toBeNull();
  });

  it("finds the second query in a row of emoji codes", () => {
    const result = emojiQueryBefore(":shipit: :par");
    expect(result).toEqual({ query: "par", at: 9 });
  });

  it("returns null for a query longer than the 64-character bound", () => {
    const longQuery = ":a".repeat(33);
    expect(emojiQueryBefore(longQuery)).toBeNull();
  });

  it("makes a lone colon a query, with nothing typed after it", () => {
    expect(emojiQueryBefore(":")).toEqual({ query: "", at: 0 });
  });

  it("makes a lone colon after a space a query too", () => {
    expect(emojiQueryBefore("ok :")).toEqual({ query: "", at: 3 });
    expect(emojiQueryBefore("look at this :")).toEqual({ query: "", at: 13 });
  });

  it("returns null once a space follows the colon, because that is prose", () => {
    expect(emojiQueryBefore(": ")).toBeNull();
    expect(emojiQueryBefore(":  ")).toBeNull();
    expect(emojiQueryBefore("note: ")).toBeNull();
    expect(emojiQueryBefore(":ship it")).toBeNull();
  });

  it("still returns null for a colon glued to a word — a time, and prose", () => {
    // The rule that keeps "note:" out is the character BEFORE the colon, and a lone
    // colon must not weaken it.
    expect(emojiQueryBefore("note:")).toBeNull();
    expect(emojiQueryBefore("18:")).toBeNull();
    expect(emojiQueryBefore("18:30")).toBeNull();
    expect(emojiQueryBefore("https:")).toBeNull();
  });
});

describe("insertedEmojiName", () => {
  function emoji(name: string, aliasOf = ""): import("./protocol").CustomEmoji {
    return {
      name,
      alias_of: aliasOf,
      content_type: "image/png",
      width: 64,
      height: 64,
      source: "local",
      added_ms: Date.now(),
    };
  }

  it("returns the emoji's own name for an ordinary emoji", () => {
    const pack = [emoji("shipit")];
    expect(insertedEmojiName({ name: "shipit" }, pack)).toBe("shipit");
  });

  it("returns the alias target for an alias", () => {
    const pack = [emoji("ship", "shipit")];
    expect(insertedEmojiName({ name: "ship" }, pack)).toBe("shipit");
  });

  it("returns the suggestion name when the emoji is absent from the pack", () => {
    expect(insertedEmojiName({ name: "unknown" }, [])).toBe("unknown");
  });
});

describe("originalArtUrl", () => {
  it("asks AMS for the bytes as uploaded, not for Teams' static rendition", () => {
    expect(
      originalArtUrl("https://eu-api.asm.skype.com/v1/objects/0-eu-d1-abc/views/imgo"),
    ).toBe("https://eu-api.asm.skype.com/v1/objects/0-eu-d1-abc/content/imgpsh");
    // Teams rewrites the host at storage, so the rule cannot key on one.
    expect(
      originalArtUrl(
        "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-fr-d2-x/views/imgo",
      ),
    ).toBe("https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-fr-d2-x/content/imgpsh");
  });

  it("leaves every other URL byte-identical", () => {
    const same = [
      // A glyph from Teams' own personal-expressions CDN — no object store in sight.
      "https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/x.png",
      // One of our own blob URLs, which the pack hands over already loaded.
      "blob:http://127.0.0.1:19440/2f1c-4a",
      // A rendition this app has not measured, and the plain object.
      "https://eu-api.asm.skype.com/v1/objects/0-a/views/imgpsh",
      "https://eu-api.asm.skype.com/v1/objects/0-a/content/imgpsh",
      "https://eu-api.asm.skype.com/v1/objects/0-a",
      // Not an object URL at all, and not the whole URL either.
      "https://eu-api.asm.skype.com/v2/objects/0-a/views/imgo",
      "https://eu-api.asm.skype.com/v1/objects/0-a/views/imgo/thumb",
      "https://eu-api.asm.skype.com/v1/objects/0-a/views/imgo?v=2",
      // http is never proxied, so it is never rewritten either.
      "http://eu-api.asm.skype.com/v1/objects/0-a/views/imgo",
      "",
    ];
    for (const url of same) expect(originalArtUrl(url)).toBe(url);
  });
});

describe("extractableCustomEmoji", () => {
  const EMOJI_URL = "https://eu-api.asm.skype.com/v1/objects/0-a/views/imgo";
  const EMOJI_IMG = `<img itemtype="http://schema.skype.com/Emoji" itemid="shipit" alt=":shipit:" src="${EMOJI_URL}" width="20" height="20">`;

  function emoji(name: string): import("./protocol").CustomEmoji {
    return {
      name,
      alias_of: "",
      content_type: "image/png",
      width: 64,
      height: 64,
      source: "local",
      added_ms: Date.now(),
    };
  }

  it("returns the first custom emoji when the pack does not have it", () => {
    const nodes = parseRichHtml(`<p>Check out ${EMOJI_IMG}</p>`);
    const result = extractableCustomEmoji(nodes, []);
    expect(result).toEqual({ src: EMOJI_URL, code: "shipit" });
  });

  it("returns null when the pack already has that code", () => {
    const nodes = parseRichHtml(`<p>Check out ${EMOJI_IMG}</p>`);
    const pack = [emoji("shipit")];
    expect(extractableCustomEmoji(nodes, pack)).toBeNull();
  });

  it("returns null when the message has no custom emoji", () => {
    const nodes = parseRichHtml("<p>Just plain text</p>");
    expect(extractableCustomEmoji(nodes, [])).toBeNull();
  });

  it("returns the first emoji when there are multiple", () => {
    const SECOND_EMOJI = EMOJI_IMG.replace("shipit", "rocket").replace(":shipit:", ":rocket:");
    const nodes = parseRichHtml(`<p>${EMOJI_IMG} and ${SECOND_EMOJI}</p>`);
    const result = extractableCustomEmoji(nodes, []);
    expect(result).toEqual({ src: EMOJI_URL, code: "shipit" });
  });

  it("finds emoji nested in formatting elements", () => {
    const nodes = parseRichHtml(`<p><strong>Check ${EMOJI_IMG} this</strong></p>`);
    const result = extractableCustomEmoji(nodes, []);
    expect(result).toEqual({ src: EMOJI_URL, code: "shipit" });
  });

  it("finds emoji in list items", () => {
    const nodes = parseRichHtml(`<ul><li>${EMOJI_IMG}</li></ul>`);
    const result = extractableCustomEmoji(nodes, []);
    expect(result).toEqual({ src: EMOJI_URL, code: "shipit" });
  });
});

describe("bodyIsOnlyEmoji", () => {
  const EMOJI_URL = "https://eu-api.asm.skype.com/v1/objects/0-a/views/imgo";
  const emojiImg = (code: string) =>
    `<img itemtype="http://schema.skype.com/Emoji" itemid="${code}" alt=":${code}:" src="${EMOJI_URL}" width="20" height="20">`;

  it("says yes to one emoji on its own", () => {
    expect(bodyIsOnlyEmoji(parseRichHtml(emojiImg("shipit")))).toBe(true);
  });

  it("says yes to an emoji inside the paragraph Teams really sends", () => {
    // Teams wraps a body in `<p>`, so the emoji is never a top-level node in practice —
    // the paragraph is the shape every real message arrives in.
    expect(bodyIsOnlyEmoji(parseRichHtml(`<p>${emojiImg("shipit")}</p>`))).toBe(true);
  });

  it("says yes to two emoji and the whitespace between and after them", () => {
    // Whitespace is why this is a walk and not an equality check. Teams wraps the body in a
    // paragraph and indents what it wraps, and a phone keyboard commits a trailing space
    // when the send key is pressed — so a message the user typed as nothing but emoji
    // arrives with blanks around them, and reading those as words would draw it as an
    // ordinary bubble.
    const body = `<p> ${emojiImg("shipit")} ${emojiImg("partyparrot")} </p>`;
    expect(bodyIsOnlyEmoji(parseRichHtml(body))).toBe(true);
  });

  it("says yes to an emoji nested inside formatting", () => {
    // The recursion is the half that breaks silently: a body that stops being emoji-only
    // one element deeper still renders, just with the wrong chrome and the wrong size.
    expect(bodyIsOnlyEmoji(parseRichHtml(`<p><strong>${emojiImg("shipit")}</strong></p>`))).toBe(
      true,
    );
  });

  it("says yes to an emoji beside an EMPTY element, which is not a word", () => {
    // The shape that used to fail. "Does this hold an emoji?" was answered by a second
    // recursion, re-run at every depth — so the empty `<em>` recursed into a subtree with
    // no emoji in it, answered no, and a message that is nothing but emoji was drawn as an
    // ordinary bubble at text size.
    const body = `<p><em></em>${emojiImg("shipit")}</p>`;
    expect(bodyIsOnlyEmoji(parseRichHtml(body))).toBe(true);
  });

  it("says no to an emoji with one word beside it", () => {
    expect(bodyIsOnlyEmoji(parseRichHtml(`<p>${emojiImg("shipit")} ship</p>`))).toBe(false);
  });

  it("says no to words alone", () => {
    expect(bodyIsOnlyEmoji(parseRichHtml("<p>ship it</p>"))).toBe(false);
  });

  it("says no to an empty body, which has no emoji to draw large", () => {
    expect(bodyIsOnlyEmoji([])).toBe(false);
    expect(bodyIsOnlyEmoji(parseRichHtml("<p> </p>"))).toBe(false);
  });
});
