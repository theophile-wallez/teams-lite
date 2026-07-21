// Behavior tests for the pure theme builder: it resolves an opencode theme JSON,
// applies teams-lite's chat-role overrides, and flattens everything into a CSS
// custom-property map plus a static stylesheet. We feed a small inline ThemeJson
// rather than depending on the generated theme-list.gen.ts artifacts.
import { describe, it, expect } from "vitest";
import { buildThemeEntry, buildVars, themeStylesheet, themeList } from "./themes";
import { resolveTheme } from "./theme-resolve";
import type { ThemeJson } from "./theme-resolve";
import type { ThemeEntry } from "./themes";

// A minimal-but-complete theme: every base role the builder reads, as plain hex.
const SAMPLE: ThemeJson = {
  theme: {
    primary: "#4a8be0",
    secondary: "#7fb0e0",
    accent: "#5c9cf5",
    error: "#d08770",
    warning: "#f5a742",
    success: "#7fd88f",
    info: "#56b6c2",
    text: "#eeeeee",
    textMuted: "#808080",
    background: "#0a0a0a",
    backgroundPanel: "#141414",
    backgroundElement: "#1e1e1e",
    border: "#484848",
    borderActive: "#606060",
    borderSubtle: "#3c3c3c",
  },
};

// Matches both the opaque "rgb(r g b)" and the alpha "rgb(r g b / a)" forms.
const COLOR = /^(rgb\(\d{1,3} \d{1,3} \d{1,3}( \/ [\d.]+)?\)|transparent)$/;

const KEY_VARS = ["--background", "--foreground", "--primary", "--bubble-mine"] as const;

describe("buildThemeEntry", () => {
  it("names the entry and produces valid color strings for every key var", () => {
    const entry = buildThemeEntry("teams", SAMPLE);

    expect(entry.id).toBe("teams");
    expect(entry.name).toBe("Teams");
    for (const key of KEY_VARS) {
      expect(entry.vars[key], key).toMatch(COLOR);
    }
    expect(entry.vars["--background"]).toBe("rgb(10 10 10)");
    expect(entry.vars["--foreground"]).toBe("rgb(238 238 238)");
    expect(entry.vars["--primary"]).toBe("rgb(74 139 224)");
  });

  it("pins the teams --bubble-mine override to #2b5278", () => {
    const entry = buildThemeEntry("teams", SAMPLE);
    expect(entry.vars["--bubble-mine"]).toBe("rgb(43 82 120)");
  });

  it("computes --bubble-mine from primary/element when the theme has no override", () => {
    const entry = buildThemeEntry("sample", SAMPLE);

    expect(entry.name).toBe("Sample");
    // mix(#1e1e1e, #4a8be0, 0.22) rounded per channel.
    expect(entry.vars["--bubble-mine"]).toBe("rgb(40 54 73)");
    expect(entry.vars["--bubble-mine"]).not.toBe("rgb(43 82 120)");
  });
});

describe("buildVars", () => {
  it("exposes the pinned teams override at the buildVars layer too", () => {
    const vars = buildVars(resolveTheme(SAMPLE, "dark"), "teams");
    expect(vars["--bubble-mine"]).toBe("rgb(43 82 120)");
    expect(vars["--foreground"]).toBe("rgb(238 238 238)");
  });
});

describe("themeStylesheet", () => {
  it("emits a :root default block and a per-theme data-theme block", () => {
    const teams = buildThemeEntry("teams", SAMPLE);
    const css = themeStylesheet([teams]);

    expect(css).toContain(":root {");
    expect(css).toContain('[data-theme="teams"] {');
    // The :root fallback carries the default theme's pinned bubble.
    expect(css).toContain("--bubble-mine: rgb(43 82 120);");
  });
});

describe("themeList", () => {
  it("puts the default theme first, then the rest alphabetically", () => {
    const entries: ThemeEntry[] = [
      buildThemeEntry("sample", SAMPLE),
      buildThemeEntry("teams", SAMPLE),
    ];

    const list = themeList(entries);

    expect(list[0]?.id).toBe("teams");
    expect(list.map((t) => t.id)).toEqual(["teams", "sample"]);
  });
});
