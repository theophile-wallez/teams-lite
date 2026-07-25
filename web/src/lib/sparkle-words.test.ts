import { describe, expect, it } from "vitest";
import { isSparkleWord, splitSparkleWords } from "~/lib/sparkle-words";

describe("isSparkleWord", () => {
  it("matches the nicknames whatever their accents and casing", () => {
    for (const word of ["bebou", "bébou", "Bébou", "BEBOU", "BÉBOU", "bibou", "Bìbou"]) {
      expect(isSparkleWord(word), word).toBe(true);
    }
  });

  it("matches plurals", () => {
    expect(isSparkleWord("bébous")).toBe(true);
    expect(isSparkleWord("bibous")).toBe(true);
  });

  it("rejects other words", () => {
    for (const word of ["bebo", "bebout", "bisou", "about", "s", ""]) {
      expect(isSparkleWord(word), word).toBe(false);
    }
  });
});

describe("splitSparkleWords", () => {
  it("returns one plain segment when there is no nickname", () => {
    expect(splitSparkleWords("hello there")).toEqual([{ text: "hello there", sparkle: false }]);
  });

  it("isolates the nickname, keeping its original spelling", () => {
    expect(splitSparkleWords("hey Bébou !")).toEqual([
      { text: "hey ", sparkle: false },
      { text: "Bébou", sparkle: true },
      { text: " !", sparkle: false },
    ]);
  });

  it("keeps surrounding punctuation out of the sparkling segment", () => {
    expect(splitSparkleWords("(bebou), bibou?")).toEqual([
      { text: "(", sparkle: false },
      { text: "bebou", sparkle: true },
      { text: "), ", sparkle: false },
      { text: "bibou", sparkle: true },
      { text: "?", sparkle: false },
    ]);
  });

  it("handles a nickname at either edge of the text", () => {
    expect(splitSparkleWords("bébou")).toEqual([{ text: "bébou", sparkle: true }]);
    expect(splitSparkleWords("coucou bébou")).toEqual([
      { text: "coucou ", sparkle: false },
      { text: "bébou", sparkle: true },
    ]);
  });

  it("ignores a nickname buried inside a longer word", () => {
    expect(splitSparkleWords("bebouille and rebebou")).toEqual([
      { text: "bebouille and rebebou", sparkle: false },
    ]);
  });

  it("preserves the full text across every segment", () => {
    const text = "Bébou, bibou, and bebous walk into a bar";
    expect(
      splitSparkleWords(text)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });
});
