// teams-lite web — theme resolver.
//
// Ported from ui/src/theme/resolve.ts (itself ported from opencode's TUI theme
// engine). Turns an opencode theme JSON (a `defs` table + a `theme` token map,
// each entry a hex, an ANSI index, a def-reference, or a { dark, light } variant)
// into a fully resolved set of colors. teams-lite is dark-only, so callers
// resolve the "dark" variant. Uses the browser-safe Rgb type from ./color.

import { fromHex, fromInts, type Rgb } from "./color";

export type Theme = {
  readonly primary: Rgb;
  readonly secondary: Rgb;
  readonly accent: Rgb;
  readonly error: Rgb;
  readonly warning: Rgb;
  readonly success: Rgb;
  readonly info: Rgb;
  readonly text: Rgb;
  readonly textMuted: Rgb;
  readonly selectedListItemText: Rgb;
  readonly background: Rgb;
  readonly backgroundPanel: Rgb;
  readonly backgroundElement: Rgb;
  readonly backgroundMenu: Rgb;
  readonly border: Rgb;
  readonly borderActive: Rgb;
  readonly borderSubtle: Rgb;
};

type ThemeColor = keyof Theme;

type HexColor = `#${string}`;
type RefName = string;
type Variant = { dark: HexColor | RefName; light: HexColor | RefName };
type ColorValue = HexColor | RefName | Variant | number;

export type ThemeJson = {
  $schema?: string;
  defs?: Record<string, HexColor | RefName>;
  theme: Record<string, ColorValue>;
};

function ansiToRgb(code: number): Rgb {
  if (code < 16) {
    const ansiColors = [
      "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    return fromHex(ansiColors[code] ?? "#000000");
  }
  if (code < 232) {
    const index = code - 16;
    const b = index % 6;
    const g = Math.floor(index / 6) % 6;
    const r = Math.floor(index / 36);
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    return fromInts(val(r), val(g), val(b));
  }
  if (code < 256) {
    const gray = (code - 232) * 10 + 8;
    return fromInts(gray, gray, gray);
  }
  return fromInts(0, 0, 0);
}

export function resolveTheme(theme: ThemeJson, mode: "dark" | "light" = "dark"): Theme {
  const defs = theme.defs ?? {};
  function resolveColor(c: ColorValue, chain: string[] = []): Rgb {
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return fromInts(0, 0, 0, 0);
      if (c.startsWith("#")) return fromHex(c);
      if (chain.includes(c)) {
        throw new Error(`Circular color reference: ${[...chain, c].join(" -> ")}`);
      }
      const next = defs[c] ?? theme.theme[c];
      if (next === undefined) {
        throw new Error(`Color reference "${c}" not found in defs or theme`);
      }
      return resolveColor(next, [...chain, c]);
    }
    if (typeof c === "number") return ansiToRgb(c);
    return resolveColor(c[mode] ?? c.dark ?? c.light, chain);
  }

  const keys: ThemeColor[] = [
    "primary", "secondary", "accent", "error", "warning", "success", "info",
    "text", "textMuted", "background", "backgroundPanel", "backgroundElement",
    "border", "borderActive", "borderSubtle",
  ];
  const resolved: Partial<Record<ThemeColor, Rgb>> = {};
  for (const key of keys) {
    const value = theme.theme[key];
    if (value !== undefined) resolved[key] = resolveColor(value);
  }

  resolved.selectedListItemText =
    theme.theme.selectedListItemText !== undefined
      ? resolveColor(theme.theme.selectedListItemText)
      : resolved.background;
  resolved.backgroundMenu =
    theme.theme.backgroundMenu !== undefined
      ? resolveColor(theme.theme.backgroundMenu)
      : resolved.backgroundElement;

  return resolved as Theme;
}
