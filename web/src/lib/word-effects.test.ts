import { describe, expect, it } from "vitest";
import { splitWordEffects, wordEffect } from "~/lib/word-effects";

describe("wordEffect", () => {
  it("sparkles the nicknames whatever their accents and casing", () => {
    for (const word of ["bebou", "bébou", "Bébou", "BEBOU", "BÉBOU", "bibou", "Bìbou"]) {
      expect(wordEffect(word), word).toBe("sparkle");
    }
  });

  it("kicks the football words, hyphenated or not", () => {
    for (const word of ["baby", "Baby", "BABY", "babyfoot", "baby-foot", "Baby-Foot", "BABYFOOT"]) {
      expect(wordEffect(word), word).toBe("football");
    }
  });

  it("matches plurals", () => {
    expect(wordEffect("bébous")).toBe("sparkle");
    expect(wordEffect("bibous")).toBe("sparkle");
    expect(wordEffect("babys")).toBe("football");
    expect(wordEffect("baby-foots")).toBe("football");
  });

  it("rejects other words", () => {
    for (const word of ["bebo", "bebout", "bisou", "about", "babyfooter", "babel", "s", ""]) {
      expect(wordEffect(word), word).toBe(null);
    }
  });
});

describe("splitWordEffects", () => {
  it("returns one plain segment when there is no decorated word", () => {
    expect(splitWordEffects("hello there")).toEqual([{ text: "hello there", effect: null }]);
  });

  it("isolates the word, keeping its original spelling", () => {
    expect(splitWordEffects("hey Bébou !")).toEqual([
      { text: "hey ", effect: null },
      { text: "Bébou", effect: "sparkle" },
      { text: " !", effect: null },
    ]);
  });

  it("keeps a hyphenated football word whole", () => {
    expect(splitWordEffects("on joue au baby-foot ?")).toEqual([
      { text: "on joue au ", effect: null },
      { text: "baby-foot", effect: "football" },
      { text: " ?", effect: null },
    ]);
  });

  it("tags each word with its own effect", () => {
    expect(splitWordEffects("bibou, babyfoot ?")).toEqual([
      { text: "bibou", effect: "sparkle" },
      { text: ", ", effect: null },
      { text: "babyfoot", effect: "football" },
      { text: " ?", effect: null },
    ]);
  });

  it("keeps surrounding punctuation out of the decorated segment", () => {
    expect(splitWordEffects("(bebou), bibou?")).toEqual([
      { text: "(", effect: null },
      { text: "bebou", effect: "sparkle" },
      { text: "), ", effect: null },
      { text: "bibou", effect: "sparkle" },
      { text: "?", effect: null },
    ]);
  });

  it("handles a decorated word at either edge of the text", () => {
    expect(splitWordEffects("bébou")).toEqual([{ text: "bébou", effect: "sparkle" }]);
    expect(splitWordEffects("coucou bébou")).toEqual([
      { text: "coucou ", effect: null },
      { text: "bébou", effect: "sparkle" },
    ]);
  });

  it("ignores a decorated word buried inside a longer word", () => {
    expect(splitWordEffects("bebouille and rebebou")).toEqual([
      { text: "bebouille and rebebou", effect: null },
    ]);
    expect(splitWordEffects("babyfooteux")).toEqual([{ text: "babyfooteux", effect: null }]);
  });

  it("still lights up a listed word inside a compound that is not itself listed", () => {
    expect(splitWordEffects("mon bibou-chou")).toEqual([
      { text: "mon ", effect: null },
      { text: "bibou", effect: "sparkle" },
      { text: "-chou", effect: null },
    ]);
    expect(splitWordEffects("baby-foot-machin")).toEqual([
      { text: "baby", effect: "football" },
      { text: "-foot-machin", effect: null },
    ]);
  });

  it("preserves the full text across every segment", () => {
    const text = "Bébou, bibou, and bebous play baby-foot with a babyfoot bar";
    expect(
      splitWordEffects(text)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });
});
