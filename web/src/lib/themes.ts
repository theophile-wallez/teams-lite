// teams-lite web — theme builder (pure).
//
// Resolves an opencode theme JSON with the ported engine (./theme-resolve) and
// extends it with teams-lite's chat-client roles — the same extension the
// terminal UI applies (ui/src/theme/index.ts) — then flattens the result into a
// map of CSS custom properties (shadcn tokens + teams roles).
//
// This module is PURE: it takes assets as input and has no Vite/glob/fs deps, so
// it runs both in the browser test env and in the plain-Bun theme generator
// (scripts/gen-theme.ts). The generator emits a static stylesheet + a tiny theme
// list, so none of this code (nor the 34 theme JSONs) ships in the client bundle.

import { fromHex, luminance, mix, toCss, WHITE, type Rgb } from "./color";
import { resolveTheme, type Theme as BaseTheme, type ThemeJson } from "./theme-resolve";

const hex = (h: string) => fromHex(h);

export const DEFAULT_THEME_ID = "teams";

export const DISPLAY_NAMES: Record<string, string> = {
  teams: "Teams",
  opencode: "OpenCode",
  aura: "Aura",
  ayu: "Ayu",
  carbonfox: "Carbonfox",
  "catppuccin-frappe": "Catppuccin Frappé",
  "catppuccin-macchiato": "Catppuccin Macchiato",
  catppuccin: "Catppuccin",
  cobalt2: "Cobalt2",
  cursor: "Cursor",
  dracula: "Dracula",
  everforest: "Everforest",
  flexoki: "Flexoki",
  github: "GitHub",
  gruvbox: "Gruvbox",
  kanagawa: "Kanagawa",
  "lucent-orng": "Lucent Orange",
  material: "Material",
  matrix: "Matrix",
  mercury: "Mercury",
  monokai: "Monokai",
  nightowl: "Night Owl",
  nord: "Nord",
  "one-dark": "One Dark",
  orng: "Orange",
  "osaka-jade": "Osaka Jade",
  palenight: "Palenight",
  rosepine: "Rosé Pine",
  solarized: "Solarized",
  synthwave84: "Synthwave '84",
  tokyonight: "Tokyo Night",
  vercel: "Vercel",
  vesper: "Vesper",
  zenburn: "Zenburn",
};

export function displayName(id: string): string {
  return (
    DISPLAY_NAMES[id] ??
    id
      .split(/[-_]/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

interface ChatOverrides {
  bubbleMine?: Rgb;
  quoteIncoming?: Rgb;
  quoteMine?: Rgb;
  senderName?: Rgb;
  senderNameMine?: Rgb;
  quoteTextIncoming?: Rgb;
  quoteTextMine?: Rgb;
}

const OVERRIDES: Record<string, ChatOverrides> = {
  teams: {
    bubbleMine: hex("#2b5278"),
    quoteIncoming: hex("#2f2f2f"),
    quoteMine: hex("#1e3a54"),
    senderName: hex("#7fb0e0"),
    senderNameMine: hex("#a9c2dd"),
    quoteTextIncoming: hex("#b6b6b6"),
    quoteTextMine: hex("#c3d3e3"),
  },
};

export type ThemeVars = Record<string, string>;

function contrastFor(bg: Rgb): Rgb {
  return luminance(bg) > 0.5 ? hex("#0a0a0a") : hex("#ffffff");
}

/** Build the CSS-variable map for one resolved base theme. */
export function buildVars(base: BaseTheme, id: string): ThemeVars {
  const o = OVERRIDES[id] ?? {};
  const bgEl = base.backgroundElement;
  const border = base.border;
  const primary = base.primary;
  const bubbleMine = o.bubbleMine ?? mix(bgEl, primary, 0.22);

  const textDim = mix(base.text, base.textMuted, 0.4);
  const textFaint = mix(base.textMuted, base.background, 0.4);
  const rowHovered = mix(bgEl, border, 0.4);
  const rowOpen = mix(bgEl, border, 0.7);
  const quoteIncoming = o.quoteIncoming ?? mix(bgEl, border, 0.55);
  const quoteMine = o.quoteMine ?? mix(bubbleMine, base.background, 0.45);
  const senderName = o.senderName ?? primary;
  const senderNameMine = o.senderNameMine ?? mix(primary, WHITE, 0.25);
  const quoteTextIncoming = o.quoteTextIncoming ?? base.textMuted;
  const quoteTextMine = o.quoteTextMine ?? mix(base.textMuted, base.text, 0.4);

  return {
    "--background": toCss(base.background),
    "--foreground": toCss(base.text),
    "--card": toCss(base.backgroundPanel),
    "--card-foreground": toCss(base.text),
    "--popover": toCss(base.backgroundMenu),
    "--popover-foreground": toCss(base.text),
    "--primary": toCss(primary),
    "--primary-foreground": toCss(contrastFor(primary)),
    "--secondary": toCss(base.backgroundElement),
    "--secondary-foreground": toCss(base.text),
    "--muted": toCss(base.backgroundElement),
    "--muted-foreground": toCss(base.textMuted),
    "--accent": toCss(rowHovered),
    "--accent-foreground": toCss(base.text),
    "--destructive": toCss(base.error),
    "--destructive-foreground": toCss(contrastFor(base.error)),
    "--border": toCss(border),
    "--input": toCss(border),
    "--ring": toCss(primary),

    "--panel": toCss(base.backgroundPanel),
    "--element": toCss(base.backgroundElement),
    "--border-subtle": toCss(base.borderSubtle),
    "--border-active": toCss(base.borderActive),
    "--text-dim": toCss(textDim),
    "--text-faint": toCss(textFaint),
    "--success": toCss(base.success),
    "--warning": toCss(base.warning),
    "--info": toCss(base.info),
    "--secondary-accent": toCss(base.secondary),
    "--unread-dot": toCss(primary),
    "--row-idle": toCss(base.backgroundPanel),
    "--row-selected": toCss(base.backgroundElement),
    "--row-hovered": toCss(rowHovered),
    "--row-open": toCss(rowOpen),
    "--bubble-mine": toCss(bubbleMine),
    "--bubble-mine-foreground": toCss(WHITE),
    "--bubble-incoming": toCss(bgEl),
    "--bubble-incoming-foreground": toCss(base.text),
    "--quote-mine": toCss(quoteMine),
    "--quote-incoming": toCss(quoteIncoming),
    "--quote-text-mine": toCss(quoteTextMine),
    "--quote-text-incoming": toCss(quoteTextIncoming),
    "--sender-name": toCss(senderName),
    "--sender-name-mine": toCss(senderNameMine),
  };
}

export type ThemeEntry = { id: string; name: string; vars: ThemeVars };

/** Resolve + extend a single theme asset. Throws on a malformed asset. */
export function buildThemeEntry(id: string, json: ThemeJson): ThemeEntry {
  return { id, name: displayName(id), vars: buildVars(resolveTheme(json, "dark"), id) };
}

/** Build every theme entry from an id->json map, skipping malformed ones. */
export function buildThemeEntries(assets: Record<string, ThemeJson>): ThemeEntry[] {
  const entries: ThemeEntry[] = [];
  for (const [id, json] of Object.entries(assets)) {
    try {
      entries.push(buildThemeEntry(id, json));
    } catch {
      // Skip a malformed theme rather than break the registry.
    }
  }
  return entries;
}

/** The picker list: default first, then alphabetical by display name. */
export function themeList(entries: ThemeEntry[]): { id: string; name: string }[] {
  return entries
    .map((t) => ({ id: t.id, name: t.name }))
    .sort((a, b) =>
      a.id === DEFAULT_THEME_ID ? -1 : b.id === DEFAULT_THEME_ID ? 1 : a.name.localeCompare(b.name),
    );
}

function varsToCss(vars: ThemeVars): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
}

/**
 * The full stylesheet: a :root default (Teams) plus one [data-theme] block per
 * theme. Emitted once by the generator into a static CSS file.
 */
export function themeStylesheet(entries: ThemeEntry[]): string {
  const blocks: string[] = [];
  const fallback = entries.find((t) => t.id === DEFAULT_THEME_ID) ?? entries[0];
  if (fallback) blocks.push(`:root { ${varsToCss(fallback.vars)} }`);
  for (const t of entries) blocks.push(`[data-theme="${t.id}"] { ${varsToCss(t.vars)} }`);
  return blocks.join("\n");
}
