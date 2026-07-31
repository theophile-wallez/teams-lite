// Generate the PNG app icons an installed web app needs, from the same mark as
// public/favicon.svg.
//
// Why draw the mark in code instead of rasterizing the SVG: iOS wants PNG (an
// `apple-touch-icon` may not be an SVG, and a Home Screen web app without one gets a
// screenshot of the page as its icon), and this machine has no SVG rasterizer. The
// mark is three primitives — a rounded square, a hairline ring, and a "T" of two
// round-capped strokes — so a 60-line signed-distance rasterizer is smaller than the
// dependency that would otherwise appear here, and it runs anywhere Bun does.
//
// The geometry below mirrors public/favicon.svg in its 32-unit viewBox. Change one,
// change the other.
//
// Run: bun run scripts/generate-app-icons.ts   (from web/)
// The output is committed; this is not part of the build.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- the mark, in favicon.svg's 32-unit space ---------------------------------

const VIEWBOX = 32;
const BACKGROUND = { r: 0x0a, g: 0x0a, b: 0x0a };
const ACCENT = { r: 0x68, g: 0x75, b: 0xe6 };
/** Corner radius of the tile, and of the hairline ring inside it. */
const TILE_RADIUS = 7;
const RING_INSET = 1.5;
const RING_RADIUS = 6;
const RING_OPACITY = 0.35;
/** The "T": a horizontal bar and a stem, both round-capped. */
const STROKE_WIDTH = 2.6;
const BAR = { x1: 10, y1: 10.5, x2: 22, y2: 10.5 };
const STEM = { x1: 16, y1: 10.5, x2: 16, y2: 22 };

/** Samples per pixel edge. 4 => 16 samples, which is enough to hide the stair-steps
 *  on the ring at 180px and costs nothing at these sizes. */
const SUPERSAMPLE = 4;

type Rgb = { r: number; g: number; b: number };

/** Signed distance to a rounded rectangle centred on (cx, cy). Negative inside. */
function roundedRectDistance(
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const dx = Math.abs(x - cx) - (halfWidth - radius);
  const dy = Math.abs(y - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a round-capped segment (a capsule) of the given width. */
function strokeDistance(
  x: number,
  y: number,
  segment: { x1: number; y1: number; x2: number; y2: number },
  width: number,
): number {
  const px = x - segment.x1;
  const py = y - segment.y1;
  const vx = segment.x2 - segment.x1;
  const vy = segment.y2 - segment.y1;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (px * vx + py * vy) / lengthSquared));
  return Math.hypot(px - vx * t, py - vy * t) - width / 2;
}

/** Coverage of a shape at one sample: 1 inside, 0 outside. Hard-edged, because the
 *  supersampling above is what smooths the result. */
function inside(distance: number): number {
  return distance <= 0 ? 1 : 0;
}

function mix(base: Rgb, over: Rgb, alpha: number): Rgb {
  return {
    r: Math.round(base.r + (over.r - base.r) * alpha),
    g: Math.round(base.g + (over.g - base.g) * alpha),
    b: Math.round(base.b + (over.b - base.b) * alpha),
  };
}

type IconShape = {
  /** Rounded tile with transparent corners, or a full-bleed square. iOS masks the
   *  corners of an apple-touch-icon itself, and a maskable icon must fill its box. */
  fullBleed: boolean;
  /** How much of the box the mark occupies. A maskable icon keeps the glyph inside
   *  the 80% safe zone, because the launcher may crop to a circle. */
  scale: number;
  /** Draw the hairline ring. Off for anything the platform masks: the mask's corner
   *  radius is larger than the ring's inset, so it would cut the ring's corners and
   *  leave four floating arcs. */
  ring: boolean;
};

/** Render one icon as RGBA bytes. */
function render(size: number, shape: IconShape): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const unit = VIEWBOX / size; // one pixel, in mark units
  const centre = VIEWBOX / 2;
  const half = (VIEWBOX / 2) * shape.scale;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let alphaSum = 0;
      let colour: Rgb = BACKGROUND;
      let colourSamples = 0;
      let accentSum = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          // Sample at the centre of each sub-pixel, in mark units.
          const x = (px + (sx + 0.5) / SUPERSAMPLE) * unit;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) * unit;
          // The mark, scaled about the centre: undo the scale to reuse the
          // 32-unit geometry.
          const mx = centre + (x - centre) / shape.scale;
          const my = centre + (y - centre) / shape.scale;

          const tile = shape.fullBleed
            ? 1
            : inside(roundedRectDistance(x, y, centre, centre, half, half, TILE_RADIUS * shape.scale));
          if (tile === 0) continue;
          alphaSum += 1;
          colourSamples += 1;

          // The hairline ring: the boundary of a rounded rect, given a width.
          const ring = Math.abs(
            roundedRectDistance(
              mx,
              my,
              centre,
              centre,
              VIEWBOX / 2 - RING_INSET,
              VIEWBOX / 2 - RING_INSET,
              RING_RADIUS,
            ),
          );
          const onRing = shape.ring ? inside(ring - 0.5) * RING_OPACITY : 0;
          const onGlyph =
            inside(strokeDistance(mx, my, BAR, STROKE_WIDTH)) ||
            inside(strokeDistance(mx, my, STEM, STROKE_WIDTH))
              ? 1
              : 0;
          accentSum += Math.max(onRing, onGlyph);
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (py * size + px) * 4;
      if (colourSamples > 0) colour = mix(BACKGROUND, ACCENT, accentSum / colourSamples);
      pixels[offset] = colour.r;
      pixels[offset + 1] = colour.g;
      pixels[offset + 2] = colour.b;
      pixels[offset + 3] = Math.round((alphaSum / samples) * 255);
    }
  }
  return pixels;
}

// ---- PNG encoding ------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode RGBA bytes as an 8-bit truecolour-with-alpha PNG. */
function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline, as PNG requires.
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

// ---- output ------------------------------------------------------------------

const ICONS: { file: string; size: number; shape: IconShape }[] = [
  // The manifest's "any" icons: the tile with its own rounded corners.
  { file: "icon-192.png", size: 192, shape: { fullBleed: false, scale: 1, ring: true } },
  { file: "icon-512.png", size: 512, shape: { fullBleed: false, scale: 1, ring: true } },
  // Maskable: fills the box, mark inside the safe zone, because a launcher may
  // crop it to a circle.
  { file: "icon-maskable-512.png", size: 512, shape: { fullBleed: true, scale: 0.78, ring: false } },
  // iOS masks the corners itself, so this one is a full square with a little air
  // around the mark. 180px is what current iPhones ask for.
  { file: "apple-touch-icon-180.png", size: 180, shape: { fullBleed: true, scale: 0.84, ring: false } },
];

const outDir = join(import.meta.dir, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });
for (const icon of ICONS) {
  const png = encodePng(icon.size, render(icon.size, icon.shape));
  writeFileSync(join(outDir, icon.file), png);
  console.log(`[icons] ${icon.file} — ${icon.size}×${icon.size}, ${png.length} bytes`);
}
