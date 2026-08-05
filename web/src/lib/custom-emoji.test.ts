import { describe, it, expect } from "vitest";
import { bodyIsOnlyEmoji } from "./custom-emoji";
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
