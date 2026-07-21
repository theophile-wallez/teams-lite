// Minimal color type for the web theme engine — a browser-safe stand-in for
// @opentui/core's RGBA, exposing just what the ported theme resolver needs.

export type Rgb = { r: number; g: number; b: number; a: number };

export function fromInts(r: number, g: number, b: number, a = 255): Rgb {
  return { r, g, b, a: a / 255 };
}

export function fromHex(hex: string): Rgb {
  let h = hex.replace(/^#/, "").trim();
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length === 6) h += "ff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = parseInt(h.slice(6, 8), 16);
  return { r, g, b, a: (Number.isNaN(a) ? 255 : a) / 255 };
}

/** Linear blend of two colors in 0-255 space (ported from the TUI theme). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const l = (x: number, y: number) => Math.round(x + (y - x) * t);
  return { r: l(a.r, b.r), g: l(a.g, b.g), b: l(a.b, b.b), a: a.a + (b.a - a.a) * t };
}

/** Serialize to a CSS color. Uses rgb()/rgba() so alpha (e.g. transparent) works. */
export function toCss(c: Rgb): string {
  if (c.a >= 1) return `rgb(${c.r} ${c.g} ${c.b})`;
  if (c.a <= 0) return "transparent";
  return `rgb(${c.r} ${c.g} ${c.b} / ${c.a.toFixed(3)})`;
}

/** Relative luminance (0..1) for contrast decisions. */
export function luminance(c: Rgb): number {
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

export const WHITE = fromInts(255, 255, 255);
export const BLACK = fromInts(0, 0, 0);
