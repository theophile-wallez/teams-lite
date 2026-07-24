import { useId } from "react";
import { cn } from "~/lib/utils";

/**
 * A faceted "person coin" placeholder avatar, in the spirit of Microsoft Teams'
 * generated avatars. Everything derives from a single hue, layered as:
 *
 *   1. halo   — a thin, low-opacity ring just outside the coin (a soft glow).
 *   2. coin   — the disc, filled with a vertical gradient (near-white tint at the
 *               top → a more saturated tint at the bottom).
 *   3. glyph  — head + shoulders, faceted: the head is split into 4 quadrants and
 *               the shoulders into 2 halves, each a slightly different shade of the
 *               hue arranged as a diagonal light→dark gradient. The thin gaps
 *               between facets are the coin gradient showing through (the crosshair).
 *
 * Colours live in CSS custom properties (see PERSON_COIN_TOKENS) so the whole
 * thing re-tints for dark mode from a single `[data-theme="dark"]` override —
 * each instance only sets its hue (`--pc-h`) inline. Sizing is caller-controlled
 * through `className` (defaults to a 36px avatar), mirroring <Avatar>.
 */

// Base hues, aligned index-for-index with AVATAR_TINTS in ./avatar
// (sky, violet, emerald, amber, rose, cyan). Kept in the same order and paired
// with the same hash below so a seed lands on the same colour family whether it
// renders as tinted initials (<Avatar>) or as a coin.
const PERSON_HUES = [199, 258, 160, 38, 350, 189];

/** Deterministic hue for a seed string — same hash/ordering as `tintFor`, so a
 *  subject keeps one colour identity across both avatar styles. */
export function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PERSON_HUES[hash % PERSON_HUES.length]!;
}

// Shared, theme-aware palette. Each token holds the `S% L%` (and alpha) pair fed
// into `hsl(var(--pc-h) …)`; only the hue varies per instance. Light lives on the
// class, dark overrides under the app's `[data-theme="dark"]` attribute. Rendered
// once and de-duplicated by React via the `href`/`precedence` props.
const PERSON_COIN_TOKENS = `
.person-coin {
  --pc-halo: 72% 82%; --pc-halo-a: .65;
  --pc-bg-top: 52% 97%; --pc-bg-bot: 60% 91%;
  --pc-tl: 60% 62%; --pc-tr: 64% 52%; --pc-bl: 56% 71%; --pc-br: 60% 61%;
  --pc-body-l: 58% 65%; --pc-body-r: 62% 55%;
}
[data-theme="dark"] .person-coin {
  --pc-halo: 42% 44%; --pc-halo-a: .5;
  --pc-bg-top: 28% 22%; --pc-bg-bot: 34% 15%;
  --pc-tl: 55% 60%; --pc-tr: 60% 50%; --pc-bl: 50% 68%; --pc-br: 57% 59%;
  --pc-body-l: 53% 63%; --pc-body-r: 60% 53%;
}`;

// Shoulders: the top half of an ellipse (rx 24, ry 20, centred at 50,78) dropping
// to y=96; the lower corners are rounded off by the coin clip.
const SHOULDERS = "M26,78 A24,20 0 0 1 74,78 L74,96 L26,96 Z";
const fill = (token: string) => ({ fill: `hsl(var(--pc-h) var(--pc-${token}))` });

export function PersonCoin({
  seed,
  hue,
  className,
  title,
}: {
  /** Seed string (name / id / MRI) → deterministic hue. Ignored if `hue` is set. */
  seed?: string;
  /** Explicit hue (0–360), for previews or forcing a colour. */
  hue?: number;
  /** Tailwind sizing/shape overrides; merged last. Defaults to a 36px coin. */
  className?: string;
  /** Accessible label. When omitted the coin is decorative (`aria-hidden`). */
  title?: string;
}) {
  const h = hue ?? hueFor(seed ?? "");
  const uid = useId().replace(/:/g, "");
  const bg = `pc-bg-${uid}`;

  return (
    <svg
      className={cn("person-coin size-9 shrink-0", className)}
      viewBox="0 0 100 100"
      style={{ "--pc-h": h } as React.CSSProperties}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title && <title>{title}</title>}
      <style href="person-coin-tokens" precedence="medium">
        {PERSON_COIN_TOKENS}
      </style>
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "hsl(var(--pc-h) var(--pc-bg-top))" }} />
          <stop offset="1" style={{ stopColor: "hsl(var(--pc-h) var(--pc-bg-bot))" }} />
        </linearGradient>
        <clipPath id={`pc-coin-${uid}`}>
          <circle cx="50" cy="50" r="42" />
        </clipPath>
        <clipPath id={`pc-head-${uid}`}>
          <circle cx="50" cy="40" r="14" />
        </clipPath>
        <clipPath id={`pc-l-${uid}`}>
          <rect x="0" y="0" width="49.1" height="100" />
        </clipPath>
        <clipPath id={`pc-r-${uid}`}>
          <rect x="50.9" y="0" width="49.1" height="100" />
        </clipPath>
      </defs>

      {/* halo */}
      <circle
        cx="50"
        cy="50"
        r="47.2"
        fill="none"
        strokeWidth="1.6"
        style={{ stroke: "hsl(var(--pc-h) var(--pc-halo) / var(--pc-halo-a))" }}
      />
      {/* coin */}
      <circle cx="50" cy="50" r="42" fill={`url(#${bg})`} />

      <g clipPath={`url(#pc-coin-${uid})`}>
        {/* shoulders, split L / R with a gap at x=50 */}
        <g clipPath={`url(#pc-l-${uid})`}>
          <path d={SHOULDERS} style={fill("body-l")} />
        </g>
        <g clipPath={`url(#pc-r-${uid})`}>
          <path d={SHOULDERS} style={fill("body-r")} />
        </g>
        {/* head, 4 facets with a cross-shaped gap */}
        <g clipPath={`url(#pc-head-${uid})`}>
          <rect x="34" y="25" width="15.1" height="14.1" style={fill("tl")} />
          <rect x="50.9" y="25" width="15.1" height="14.1" style={fill("tr")} />
          <rect x="34" y="40.9" width="15.1" height="14.1" style={fill("bl")} />
          <rect x="50.9" y="40.9" width="15.1" height="14.1" style={fill("br")} />
        </g>
      </g>
    </svg>
  );
}
