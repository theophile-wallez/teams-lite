import { describe, it, expect } from "vitest";
import {
  bodyIsOnlyEmoji,
  customEmojiNameError,
  emojiSuggestions,
  emojiQueryBefore,
  extractableCustomEmoji,
  insertedEmojiName,
} from "./custom-emoji";
import { parseRichHtml } from "./rich-text";

describe("bodyIsOnlyEmoji", () => {
  const EMOJI_IMG =
    '<img itemtype="http://schema.skype.com/Emoji" itemid="shipit" alt=":shipit:" ' +
    'src="https://eu-api.asm.skype.com/v1/objects/0-a/views/imgo" width="20" height="20">';

  it("returns true for a single custom emoji", () => {
    const nodes = parseRichHtml(`<p>${EMOJI_IMG}</p>`);
    expect(bodyIsOnlyEmoji(nodes)).toBe(true);
  });

  it("returns false for emoji plus a word", () => {
    const nodes = parseRichHtml(`<p>${EMOJI_IMG} hello</p>`);
    expect(bodyIsOnlyEmoji(nodes)).toBe(false);
  });

  it("returns true for two emoji and a space", () => {
    const nodes = parseRichHtml(`<p>${EMOJI_IMG} ${EMOJI_IMG}</p>`);
    expect(bodyIsOnlyEmoji(nodes)).toBe(true);
  });

  it("returns false for an empty body", () => {
    const nodes = parseRichHtml("<p></p>");
    expect(bodyIsOnlyEmoji(nodes)).toBe(false);
  });

  it("returns false for text only", () => {
    const nodes = parseRichHtml("<p>hello</p>");
    expect(bodyIsOnlyEmoji(nodes)).toBe(false);
  });

  it("returns true for emoji with only whitespace and line breaks", () => {
    const nodes = parseRichHtml(`<p>${EMOJI_IMG}<br>${EMOJI_IMG}</p>`);
    expect(bodyIsOnlyEmoji(nodes)).toBe(true);
  });
});

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
    if (firstUnicode >= 0 && lastCustom.length > 0) {
      expect(Math.max(...lastCustom)).toBeLessThan(firstUnicode);
    }
  });

  it("matches an alias by its own name", () => {
    const pack = [{ ...emoji("ship"), alias_of: "shipit" }];
    expect(emojiSuggestions("shi", pack, [])).toEqual([{ kind: "custom", name: "ship" }]);
  });

  it("offers nothing for an empty query, so a lone colon opens no menu", () => {
    expect(emojiSuggestions("", [emoji("shipit")], [])).toEqual([]);
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

  it("returns null for a lone colon", () => {
    expect(emojiQueryBefore(":")).toBeNull();
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

  it("strips colons from the code", () => {
    const nodes = parseRichHtml(`<p>${EMOJI_IMG}</p>`);
    const result = extractableCustomEmoji(nodes, []);
    expect(result?.code).toBe("shipit");
  });

  it("returns null when emoji has no src", () => {
    const BROKEN_IMG = '<img itemtype="http://schema.skype.com/Emoji" itemid="shipit" alt=":shipit:">';
    const nodes = parseRichHtml(`<p>${BROKEN_IMG}</p>`);
    expect(extractableCustomEmoji(nodes, [])).toBeNull();
  });

  it("returns null when emoji has no code", () => {
    const BROKEN_IMG = `<img itemtype="http://schema.skype.com/Emoji" itemid="shipit" src="${EMOJI_URL}">`;
    const nodes = parseRichHtml(`<p>${BROKEN_IMG}</p>`);
    expect(extractableCustomEmoji(nodes, [])).toBeNull();
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
