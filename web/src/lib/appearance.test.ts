import { describe, it, expect } from "vitest";
import {
  APPEARANCES,
  DEFAULT_APPEARANCE,
  appearanceLabel,
  coerceAppearance,
  isAppearance,
  resolveTheme,
} from "./appearance";

describe("isAppearance", () => {
  it("accepts the three valid preferences", () => {
    expect(isAppearance("system")).toBe(true);
    expect(isAppearance("light")).toBe(true);
    expect(isAppearance("dark")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isAppearance("teams")).toBe(false);
    expect(isAppearance("dracula")).toBe(false);
    expect(isAppearance(null)).toBe(false);
    expect(isAppearance(undefined)).toBe(false);
    expect(isAppearance(42)).toBe(false);
  });
});

describe("coerceAppearance", () => {
  it("passes through valid preferences", () => {
    expect(coerceAppearance("light")).toBe("light");
    expect(coerceAppearance("dark")).toBe("dark");
    expect(coerceAppearance("system")).toBe("system");
  });

  it("falls back to the default for legacy theme ids or junk", () => {
    // Users upgrading from the old 34-theme picker had ids like these stored.
    expect(coerceAppearance("dracula")).toBe(DEFAULT_APPEARANCE);
    expect(coerceAppearance("nord")).toBe(DEFAULT_APPEARANCE);
    expect(coerceAppearance(null)).toBe(DEFAULT_APPEARANCE);
    expect(coerceAppearance("")).toBe(DEFAULT_APPEARANCE);
  });
});

describe("resolveTheme", () => {
  it("returns the explicit choice regardless of the OS setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("follows the OS setting when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("appearanceLabel", () => {
  it("gives a human label for every appearance", () => {
    for (const pref of APPEARANCES) {
      expect(appearanceLabel(pref)).toBeTruthy();
    }
    expect(appearanceLabel("system")).toBe("System");
    expect(appearanceLabel("light")).toBe("Light");
    expect(appearanceLabel("dark")).toBe("Dark");
  });
});

describe("defaults", () => {
  it("defaults to system so new users follow their OS", () => {
    expect(DEFAULT_APPEARANCE).toBe("system");
    expect(APPEARANCES).toContain(DEFAULT_APPEARANCE);
  });
});
