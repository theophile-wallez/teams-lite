// Node's types are referenced for this file only (tsconfig.json lists just
// "vite/client"): the last test reads the stylesheet from disk, because Vitest stubs
// CSS imports out to an empty string — including `?raw`.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  APPEARANCES,
  DEFAULT_APPEARANCE,
  THEME_COLORS,
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

describe("THEME_COLORS", () => {
  it("matches the page background of each theme in theme.css", () => {
    // An installed app paints its status-bar band from `theme-color`, so a value
    // that drifts from `--background` shows up as a coloured strip above the app —
    // on a phone, where nobody is running the test suite. Read the stylesheet
    // rather than trusting the copy.
    const css = readFileSync(new URL("../styles/theme.css", import.meta.url), "utf8");
    const backgrounds = [...css.matchAll(/--background:\s*(#[0-9a-fA-F]{3,8});/g)].map(
      (match) => match[1]!.toLowerCase(),
    );
    // The file declares the light palette first, then the dark one.
    expect(backgrounds.length).toBe(2);
    expect(THEME_COLORS.light.toLowerCase()).toBe(backgrounds[0]);
    expect(THEME_COLORS.dark.toLowerCase()).toBe(backgrounds[1]);
  });
});
