import { describe, expect, it } from "vitest";
import { formatShortcut, hasModifier, isAppleKeyboard } from "./platform";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("isAppleKeyboard", () => {
  it("recognizes a Mac by its platform", () => {
    expect(isAppleKeyboard({ platform: "MacIntel", userAgent: MAC_UA })).toBe(true);
  });

  it("recognizes an iPhone", () => {
    expect(isAppleKeyboard({ platform: "iPhone", userAgent: "" })).toBe(true);
  });

  it("falls back to the user agent when the platform is missing", () => {
    expect(isAppleKeyboard({ userAgent: MAC_UA })).toBe(true);
  });

  it("reports Linux and Windows as non-Apple", () => {
    expect(isAppleKeyboard({ platform: "Linux x86_64", userAgent: LINUX_UA })).toBe(false);
    expect(isAppleKeyboard({ platform: "Win32", userAgent: "" })).toBe(false);
  });

  it("reports a browser that answers nothing as non-Apple", () => {
    expect(isAppleKeyboard({})).toBe(false);
  });
});

describe("hasModifier", () => {
  it("accepts Ctrl and Cmd alike, so the same shortcut works on every keyboard", () => {
    expect(hasModifier({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(hasModifier({ ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("rejects a bare key", () => {
    expect(hasModifier({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("juxtaposes the glyphs on a Mac and joins them elsewhere", () => {
    expect(formatShortcut("K", "⌘")).toBe("⌘K");
    expect(formatShortcut("K", "Ctrl")).toBe("Ctrl+K");
  });
});
