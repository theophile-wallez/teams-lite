// teams-lite — theme resolver.
//
// Ported (near-verbatim) from opencode's TUI theme engine
// (packages/tui/src/theme/index.ts in anomalyco/opencode). It turns a theme JSON
// (opencode's format: a `defs` table + a `theme` map of tokens, each a hex, an
// ANSI index, a def-reference, or a { dark, light } variant) into a fully
// resolved set of RGBA colors — the SAME token vocabulary opencode defines.
//
// teams-lite is dark-only, so callers resolve the "dark" variant. The teams-lite
// UI layer (./index.ts) extends the resolved palette with chat-specific roles.

import { RGBA } from "@opentui/core";

// The complete opencode token set. Kept identical to opencode's Theme so every
// color opencode defines is available here, even the ones teams-lite doesn't
// paint yet (diff*, markdown*, syntax*).
export type Theme = {
  readonly primary: RGBA;
  readonly secondary: RGBA;
  readonly accent: RGBA;
  readonly error: RGBA;
  readonly warning: RGBA;
  readonly success: RGBA;
  readonly info: RGBA;
  readonly text: RGBA;
  readonly textMuted: RGBA;
  readonly selectedListItemText: RGBA;
  readonly background: RGBA;
  readonly backgroundPanel: RGBA;
  readonly backgroundElement: RGBA;
  readonly backgroundMenu: RGBA;
  readonly border: RGBA;
  readonly borderActive: RGBA;
  readonly borderSubtle: RGBA;
  readonly diffAdded: RGBA;
  readonly diffRemoved: RGBA;
  readonly diffContext: RGBA;
  readonly diffHunkHeader: RGBA;
  readonly diffHighlightAdded: RGBA;
  readonly diffHighlightRemoved: RGBA;
  readonly diffAddedBg: RGBA;
  readonly diffRemovedBg: RGBA;
  readonly diffContextBg: RGBA;
  readonly diffLineNumber: RGBA;
  readonly diffAddedLineNumberBg: RGBA;
  readonly diffRemovedLineNumberBg: RGBA;
  readonly markdownText: RGBA;
  readonly markdownHeading: RGBA;
  readonly markdownLink: RGBA;
  readonly markdownLinkText: RGBA;
  readonly markdownCode: RGBA;
  readonly markdownBlockQuote: RGBA;
  readonly markdownEmph: RGBA;
  readonly markdownStrong: RGBA;
  readonly markdownHorizontalRule: RGBA;
  readonly markdownListItem: RGBA;
  readonly markdownListEnumeration: RGBA;
  readonly markdownImage: RGBA;
  readonly markdownImageText: RGBA;
  readonly markdownCodeBlock: RGBA;
  readonly syntaxComment: RGBA;
  readonly syntaxKeyword: RGBA;
  readonly syntaxFunction: RGBA;
  readonly syntaxVariable: RGBA;
  readonly syntaxString: RGBA;
  readonly syntaxNumber: RGBA;
  readonly syntaxType: RGBA;
  readonly syntaxOperator: RGBA;
  readonly syntaxPunctuation: RGBA;
  readonly thinkingOpacity: number;
  _hasSelectedListItemText: boolean;
};

type ThemeColor = Exclude<keyof Theme, "thinkingOpacity" | "_hasSelectedListItemText">;

type HexColor = `#${string}`;
type RefName = string;
type Variant = {
  dark: HexColor | RefName;
  light: HexColor | RefName;
};
type ColorValue = HexColor | RefName | Variant | RGBA | number;

export type ThemeJson = {
  $schema?: string;
  defs?: Record<string, HexColor | RefName>;
  theme: Omit<Record<ThemeColor, ColorValue>, "selectedListItemText" | "backgroundMenu"> & {
    selectedListItemText?: ColorValue;
    backgroundMenu?: ColorValue;
    thinkingOpacity?: number;
  };
};

// Contrast-aware foreground for a selected list item, matching opencode: an
// explicit token wins; on a transparent background it picks black/white by
// luminance; otherwise it falls back to the background color.
export function selectedForeground(theme: Theme, bg?: RGBA): RGBA {
  if (theme._hasSelectedListItemText) return theme.selectedListItemText;
  if (theme.background.a === 0) {
    const target = bg ?? theme.primary;
    const luminance = 0.299 * target.r + 0.587 * target.g + 0.114 * target.b;
    return luminance > 0.5 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255);
  }
  return theme.background;
}

function ansiToRgba(code: number): RGBA {
  if (code < 16) {
    const ansiColors = [
      "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    return RGBA.fromHex(ansiColors[code] ?? "#000000");
  }
  if (code < 232) {
    const index = code - 16;
    const b = index % 6;
    const g = Math.floor(index / 6) % 6;
    const r = Math.floor(index / 36);
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    return RGBA.fromInts(val(r), val(g), val(b));
  }
  if (code < 256) {
    const gray = (code - 232) * 10 + 8;
    return RGBA.fromInts(gray, gray, gray);
  }
  return RGBA.fromInts(0, 0, 0);
}

export function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): Theme {
  const defs = theme.defs ?? {};
  function resolveColor(c: ColorValue, chain: string[] = []): RGBA {
    if (c instanceof RGBA) return c;
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0);
      if (c.startsWith("#")) return RGBA.fromHex(c);
      if (chain.includes(c)) {
        throw new Error(`Circular color reference: ${[...chain, c].join(" -> ")}`);
      }
      const next = defs[c] ?? theme.theme[c as ThemeColor];
      if (next === undefined) {
        throw new Error(`Color reference "${c}" not found in defs or theme`);
      }
      return resolveColor(next, [...chain, c]);
    }
    if (typeof c === "number") return ansiToRgba(c);
    // { dark, light } variant — fall back to the other mode if one is missing.
    return resolveColor(c[mode] ?? c.dark ?? c.light, chain);
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(([key]) => key !== "selectedListItemText" && key !== "backgroundMenu" && key !== "thinkingOpacity")
      .map(([key, value]) => [key, resolveColor(value as ColorValue)]),
  ) as Partial<Record<ThemeColor, RGBA>>;

  const hasSelectedListItemText = theme.theme.selectedListItemText !== undefined;
  resolved.selectedListItemText = hasSelectedListItemText
    ? resolveColor(theme.theme.selectedListItemText!)
    : resolved.background;

  resolved.backgroundMenu =
    theme.theme.backgroundMenu !== undefined ? resolveColor(theme.theme.backgroundMenu) : resolved.backgroundElement;

  const thinkingOpacity = theme.theme.thinkingOpacity ?? 0.6;

  return { ...resolved, _hasSelectedListItemText: hasSelectedListItemText, thinkingOpacity } as Theme;
}
