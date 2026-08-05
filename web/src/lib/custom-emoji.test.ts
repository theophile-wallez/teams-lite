import { describe, it, expect } from "vitest";
import { bodyIsOnlyEmoji, customEmojiNameError, emojiSuggestions } from "./custom-emoji";
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
    const unicode: [string, string][] = [["smile", "😄"], ["smiley", "😃"]];
    const out = emojiSuggestions("sm", pack, unicode);
    expect(out[0]).toEqual({ kind: "custom", name: "smirk-cat" });
    expect(out.map((s) => s.name)).toContain("smile");
  });

  it("matches an alias by its own name", () => {
    const pack = [{ ...emoji("ship"), alias_of: "shipit" }];
    expect(emojiSuggestions("shi", pack, [])).toEqual([{ kind: "custom", name: "ship" }]);
  });

  it("offers nothing for an empty query, so a lone colon opens no menu", () => {
    expect(emojiSuggestions("", [emoji("shipit")], [])).toEqual([]);
  });
});
