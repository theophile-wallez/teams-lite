// teams-lite — theme registry + reactive active theme.
//
// Loads every opencode theme asset (theme/assets/*.json), resolves each with the
// ported opencode engine (./resolve), and extends the resolved opencode palette
// with teams-lite's own chat-client roles (bubbles, quotes, sidebar emphasis,
// splash pulse). The active theme is a Solid signal so a theme picker can preview
// live by setting it and revert by setting it back.
//
// Built-in themes = teams-lite's own "teams" (blue/black, default) + all of
// opencode's shipped themes (opencode, tokyonight, catppuccin, gruvbox, nord, …).

import { createMemo, createSignal } from "solid-js";
import { RGBA } from "@opentui/core";
import { resolveTheme, type Theme as BaseTheme, type ThemeJson } from "./resolve";

import aura from "./assets/aura.json" with { type: "json" };
import ayu from "./assets/ayu.json" with { type: "json" };
import carbonfox from "./assets/carbonfox.json" with { type: "json" };
import catppuccinFrappe from "./assets/catppuccin-frappe.json" with { type: "json" };
import catppuccinMacchiato from "./assets/catppuccin-macchiato.json" with { type: "json" };
import catppuccin from "./assets/catppuccin.json" with { type: "json" };
import cobalt2 from "./assets/cobalt2.json" with { type: "json" };
import cursor from "./assets/cursor.json" with { type: "json" };
import dracula from "./assets/dracula.json" with { type: "json" };
import everforest from "./assets/everforest.json" with { type: "json" };
import flexoki from "./assets/flexoki.json" with { type: "json" };
import github from "./assets/github.json" with { type: "json" };
import gruvbox from "./assets/gruvbox.json" with { type: "json" };
import kanagawa from "./assets/kanagawa.json" with { type: "json" };
import lucentOrng from "./assets/lucent-orng.json" with { type: "json" };
import material from "./assets/material.json" with { type: "json" };
import matrix from "./assets/matrix.json" with { type: "json" };
import mercury from "./assets/mercury.json" with { type: "json" };
import monokai from "./assets/monokai.json" with { type: "json" };
import nightowl from "./assets/nightowl.json" with { type: "json" };
import nord from "./assets/nord.json" with { type: "json" };
import oneDark from "./assets/one-dark.json" with { type: "json" };
import opencode from "./assets/opencode.json" with { type: "json" };
import orng from "./assets/orng.json" with { type: "json" };
import osakaJade from "./assets/osaka-jade.json" with { type: "json" };
import palenight from "./assets/palenight.json" with { type: "json" };
import rosepine from "./assets/rosepine.json" with { type: "json" };
import solarized from "./assets/solarized.json" with { type: "json" };
import synthwave84 from "./assets/synthwave84.json" with { type: "json" };
import tokyonight from "./assets/tokyonight.json" with { type: "json" };
import vercel from "./assets/vercel.json" with { type: "json" };
import vesper from "./assets/vesper.json" with { type: "json" };
import zenburn from "./assets/zenburn.json" with { type: "json" };
import teams from "./assets/teams.json" with { type: "json" };

// A resolved opencode palette plus teams-lite's own UI roles.
export interface Theme extends BaseTheme {
  id: string;
  name: string;
  // Sidebar text emphasis levels between `text` and `textMuted`.
  textDim: RGBA;
  textFaint: RGBA;
  unreadDot: RGBA;
  // Conversation-list row backgrounds (brighter = more active).
  rowIdle: RGBA;
  rowSelected: RGBA;
  rowHovered: RGBA;
  rowOpen: RGBA;
  // Chat bubbles + quotes.
  bubbleIncoming: RGBA;
  bubbleMine: RGBA;
  quoteIncoming: RGBA;
  quoteMine: RGBA;
  senderName: RGBA;
  senderNameMine: RGBA;
  quoteTextIncoming: RGBA;
  quoteTextMine: RGBA;
  // Splash "wave" pulse ramp (dark → bright accent).
  pulseRamp: RGBA[];
}

const WHITE = RGBA.fromInts(255, 255, 255);
const hex = (h: string) => RGBA.fromHex(h);

// Linear blend of two colors in 0-255 space.
function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const [ar, ag, ab] = a.toInts();
  const [br, bg, bb] = b.toInts();
  const l = (x: number, y: number) => Math.round(x + (y - x) * t);
  return RGBA.fromInts(l(ar, br), l(ag, bg), l(ab, bb));
}

// Optional per-theme pins for chat colors. Themes without an entry derive their
// chat palette from primary/greys; "teams" keeps its hand-tuned blue bubbles.
interface ChatOverrides {
  bubbleMine?: RGBA;
  quoteIncoming?: RGBA;
  quoteMine?: RGBA;
  senderName?: RGBA;
  senderNameMine?: RGBA;
  quoteTextIncoming?: RGBA;
  quoteTextMine?: RGBA;
  pulseRamp?: RGBA[];
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
    pulseRamp: ["#1e293b", "#294056", "#3b6ea5", "#4a8be0", "#60a5fa"].map(hex),
  },
};

function extend(base: BaseTheme, id: string, name: string): Theme {
  const o = OVERRIDES[id] ?? {};
  const bgEl = base.backgroundElement;
  const border = base.border;
  const primary = base.primary;
  const bubbleMine = o.bubbleMine ?? mix(bgEl, primary, 0.22);
  return {
    ...base,
    id,
    name,
    textDim: mix(base.text, base.textMuted, 0.4),
    textFaint: mix(base.textMuted, base.background, 0.4),
    unreadDot: primary,
    rowIdle: base.backgroundPanel,
    rowSelected: base.backgroundElement,
    rowHovered: mix(bgEl, border, 0.4),
    rowOpen: mix(bgEl, border, 0.7),
    bubbleIncoming: bgEl,
    bubbleMine,
    quoteIncoming: o.quoteIncoming ?? mix(bgEl, border, 0.55),
    quoteMine: o.quoteMine ?? mix(bubbleMine, base.background, 0.45),
    senderName: o.senderName ?? primary,
    senderNameMine: o.senderNameMine ?? mix(primary, WHITE, 0.25),
    quoteTextIncoming: o.quoteTextIncoming ?? base.textMuted,
    quoteTextMine: o.quoteTextMine ?? mix(base.textMuted, base.text, 0.4),
    pulseRamp: o.pulseRamp ?? [
      base.backgroundPanel,
      mix(base.background, primary, 0.4),
      mix(base.background, primary, 0.7),
      primary,
      mix(primary, WHITE, 0.3),
    ],
  };
}

// Raw theme JSONs keyed by id. Casting through unknown: these are opencode's own
// vetted assets and teams.json, all in opencode's theme schema.
const ASSETS = {
  teams,
  opencode,
  aura,
  ayu,
  carbonfox,
  "catppuccin-frappe": catppuccinFrappe,
  "catppuccin-macchiato": catppuccinMacchiato,
  catppuccin,
  cobalt2,
  cursor,
  dracula,
  everforest,
  flexoki,
  github,
  gruvbox,
  kanagawa,
  "lucent-orng": lucentOrng,
  material,
  matrix,
  mercury,
  monokai,
  nightowl,
  nord,
  "one-dark": oneDark,
  orng,
  "osaka-jade": osakaJade,
  palenight,
  rosepine,
  solarized,
  synthwave84,
  tokyonight,
  vercel,
  vesper,
  zenburn,
} as unknown as Record<string, ThemeJson>;

const NAMES: Record<string, string> = {
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

function displayName(id: string): string {
  return NAMES[id] ?? id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Resolve every asset (dark variant) once, extended with teams-lite roles. A
// theme that fails to resolve is skipped so it can never break startup.
const built: Record<string, Theme> = {};
for (const [id, json] of Object.entries(ASSETS)) {
  try {
    built[id] = extend(resolveTheme(json, "dark"), id, displayName(id));
  } catch {
    // Skip a malformed theme rather than crash the UI.
  }
}

export const DEFAULT_THEME_ID = "teams";
const fallback = built[DEFAULT_THEME_ID] ?? Object.values(built)[0];
if (!fallback) throw new Error("no themes resolved");

export const themes: Record<string, Theme> = built;

// Theme list for a picker: default first, then alphabetical by display name.
export const themeList: { id: string; name: string }[] = Object.values(built)
  .map((t) => ({ id: t.id, name: t.name }))
  .sort((a, b) =>
    a.id === DEFAULT_THEME_ID ? -1 : b.id === DEFAULT_THEME_ID ? 1 : a.name.localeCompare(b.name),
  );

// Active theme (reactive). TEAMS_THEME can pick the initial theme for previewing.
const requested = process.env.TEAMS_THEME;
const initialId = requested && built[requested] ? requested : DEFAULT_THEME_ID;
const [activeThemeId, setActiveThemeId] = createSignal<string>(initialId);
export { activeThemeId, setActiveThemeId };

const active = createMemo<Theme>(() => built[activeThemeId()] ?? fallback);

/** The active theme. Read reactively in components: `theme().background`. */
export function theme(): Theme {
  return active();
}
