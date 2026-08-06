import {
  ArrowDown01Icon,
  DotIcon,
  File01Icon,
  LockIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

// The glyphs the merge-request diff's file tree draws, taken from THIS app's icon library.
//
// `@pierre/trees` ships a file-type icon pack of its own — a coloured glyph per extension —
// and it is a good one. It is also a second icon set: a different grid, a different stroke
// weight, a different corner radius, which is exactly what § Project shape bans and what
// `icon-library.test.ts` scans the source tree for. A row that mixed them would read as two
// designs sharing one screen, and here the mixing is at its worst: the tree sits three
// centimetres from the app's own tab strip.
//
// So the vendor's own seam is used instead of its pack. `@pierre/trees` renders into a shadow
// root and accepts `icons: { spriteSheet, remap }` for precisely this: a sprite of `<symbol>`
// definitions injected into that root, and a map from its four slots onto their ids. What this
// module does is turn hugeicons' own data into that sprite — so the tree draws hugeicons, at
// hugeicons' weight, and there is still ONE icon library in this app.
//
// It is the same choice made for magicui's `ShineBorder` and for `thinking-orbs`: keep the
// vendor's component, own the boundary. What stays THEIRS is the git status tint per row —
// added, modified, renamed, deleted — because that is a colour vocabulary rather than an icon
// set, and it is the thing the row is saying.

/** Pierre's four icon SLOTS, and the hugeicons glyph each one takes.
 *
 *  The symbol ids are this app's own on purpose. Pierre PREPENDS its built-in sprite to the
 *  shadow root and appends a custom one after it, and a `<use href="#id">` resolves to the
 *  first match in document order — so a sprite that reused pierre's four ids loses to pierre's
 *  every time. That was the first attempt, and the capture showed their filled document glyph
 *  where hugeicons' outline should have been. */
const TREE_ICONS: { slot: string; id: string; icon: IconSvgElement }[] = [
  // DOWN, because pierre rotates this one for the fold state and the rotation it applies is
  // `-90deg` on a COLLAPSED row: the resting glyph is the open one. A right-facing chevron
  // here left every expanded directory pointing at its own children.
  { slot: "file-tree-icon-chevron", id: "teams-lite-tree-chevron", icon: ArrowDown01Icon },
  { slot: "file-tree-icon-file", id: "teams-lite-tree-file", icon: File01Icon },
  // The dot marks a FOLDED directory that holds a change, so the row already reads as a
  // directory and the glyph only has to be a mark.
  { slot: "file-tree-icon-dot", id: "teams-lite-tree-dot", icon: DotIcon },
  // A diff has no ignored file, so this slot is never drawn — it is filled because a slot
  // whose symbol is missing draws an empty box rather than nothing.
  { slot: "file-tree-icon-lock", id: "teams-lite-tree-lock", icon: LockIcon },
];

/** Serialize one hugeicons glyph into the body of an SVG `<symbol>`.
 *
 *  Hugeicons holds an icon as `[tag, attributes][]` for React to spread, so the camelCased
 *  attribute names have to become their SVG spellings and React's own `key` has to go. Every
 *  value is escaped: this string is injected as HTML into the tree's shadow root, and a glyph
 *  is the last place to trust an interpolation. */
function symbolBody(icon: IconSvgElement): string {
  return icon
    .map(([tag, attrs]) => {
      const written = Object.entries(attrs ?? {})
        .filter(([name]) => name !== "key")
        .map(([name, value]) => `${svgAttributeName(name)}="${escapeAttribute(String(value))}"`)
        .join(" ");
      return `<${tag}${written ? ` ${written}` : ""} />`;
    })
    .join("");
}

/** `strokeLinecap` → `stroke-linecap`. React's spelling is not SVG's. */
function svgAttributeName(name: string): string {
  return name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The sprite `@pierre/trees` injects into its shadow root, holding this app's own glyphs.
 *
 * `currentColor` throughout, which is what lets the tree tint a row by its git status: the
 * status colour is the row's `color`, and the glyph follows it. Hugeicons draws on a 24×24
 * grid, so every symbol declares that `viewBox` — a symbol without one is drawn at the size
 * of its host and clipped.
 */
export const FILE_TREE_SPRITE: string = [
  '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">',
  ...TREE_ICONS.map(
    ({ id, icon }) =>
      `<symbol id="${id}" viewBox="0 0 24 24" fill="none">${symbolBody(icon)}</symbol>`,
  ),
  "</svg>",
].join("");

/**
 * What to hand `useFileTree` as its `icons`.
 *
 * All four parts are needed, and each turns off something different:
 *   - `set: "none"` drops the per-extension pack;
 *   - `colored: false` drops its per-extension colouring, so a glyph takes the row's own
 *     colour — which is what makes the git status tint reach it;
 *   - `spriteSheet` puts this app's symbols in the shadow root;
 *   - `remap` points each slot at one of them, BY THIS APP'S OWN ID (see `TREE_ICONS`).
 *
 * `viewBox` travels per entry because hugeicons draws on a 24-unit grid where pierre's `Icon`
 * assumes 16 — the glyph is still rendered into the row's 16px box, at the right scale.
 */
export const FILE_TREE_ICONS = {
  set: "none",
  colored: false,
  spriteSheet: FILE_TREE_SPRITE,
  remap: Object.fromEntries(
    TREE_ICONS.map(({ slot, id }) => [slot, { name: id, viewBox: "0 0 24 24" }]),
  ),
} as const;
