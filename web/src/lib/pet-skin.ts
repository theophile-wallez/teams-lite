/**
 * A PET'S ART, AS DATA — and that is why this feature ships no pixels at all.
 *
 * A skin is a palette of single characters, a size, a foot anchor, and frames whose rows are
 * strings: about two kilobytes of text, in this repo, imported like any other module. Compare the
 * chess ENGINE (§ Playing STOCKFISH), which is 7.3 MB fetched on a press and then verified against
 * a pinned digest, and every rail that comes with bytes off the internet — a constant URL, a
 * length, a SHA-256, a cache path, a raster sniff. NONE of that exists here, because nothing is
 * fetched: there is no request when a pet is drawn, nothing to cache, no digest to pin and no
 * third-party art licence to honour at runtime. What it costs is stated where the rule is: art is
 * limited to a few dozen palette characters and hand-authored rows, so a skin is a sprite and never
 * a photograph.
 *
 * **THE FORMAT IS desksprite's, NOT OURS** — `cat` and `blue-boy` are **welltilln's** own art, MIT:
 * each one's `author` field is the credit, and the licence text itself travels with the vendored
 * engine that reads them. They are adapted in three respects and no more — a `label` added, their
 * `carry` overlay dropped since nothing in this app draws one, and `blue-boy`'s one shorthand colour
 * (`#fff`) written out as `#FFFFFF`, which is the only place the art's own VALUES were rewritten: the
 * format documents `#RRGGBB`, so a strict six-digit parser would refuse the shorthand. `duck` is
 * ours. Nothing else is renamed for taste: the engine reads these files field for field, so a field
 * spelled differently here is a field it cannot find — and it would fail by drawing NOTHING rather
 * than by throwing.
 *
 * **A SKIN DECLARES ITS OWN SIZE, AND THE SHIPPED ONES DISAGREE.** Measured: `cat` is 13x13 and
 * `blue-boy` is 14x14. So nothing anywhere may hard-code 13 — a canvas is `size.w * PX` by
 * `size.h * PX` — and a constant that disagreed with the data it draws would silently squash
 * somebody's art, which is the class of bug § A picture somebody SENT is about ("the box IS the
 * picture").
 *
 * **THE REQUIRED SLOTS ARE `idle`, `held` AND `walk`; THE OTHER FOUR HAVE A LADDER** — `fall` falls
 * back to `held`, and `work`, `done` and `error` fall back to `idle`. The ladder is resolved by the
 * ENGINE rather than here, because those are the engine's own state names, and this module would be
 * a second answer to a question it already answers. It is documented here because it is what makes
 * an absent slot LEGAL — and it is the normal path rather than an edge case: not one of the three
 * bundled skins carries any of the four, which `pet-skin.test.ts` pins over the real set.
 *
 * **`petSkin` NEVER THROWS, AND AN UNKNOWN NAME IS THE ORDINARY CASE.** The skin travels on the
 * wire (`s.<name>` in pet-wire.ts), so a colleague on a newer build names art this one does not
 * hold. Their creature is still theirs and their ledger is still readable, so it is drawn in the
 * default art: a pet in the wrong skin is a pet, while a page that threw is no pet at all — the
 * reading § The local agent's default provider already takes ("a typo must not empty a menu").
 *
 * **`validatePetSkin` IS A TEST'S INSTRUMENT, NOT A TRUST BOUNDARY**, and saying so is what keeps
 * it the right size. These three files are in this repo and nothing fetches a fourth, so nobody
 * hostile ever writes one — what DOES write one is a person editing ASCII art by hand, where a row
 * that loses one character is invisible to the eye and shears every pixel below it out of place. So
 * it refuses exactly the mistakes hand-authoring makes, and it skips what the TYPE already refuses:
 * a skin with no `label` never compiles, so the validator does not repeat that.
 *
 * **THE TWO MISTAKES THE EYE CANNOT SEE AT ALL are what it exists for**, and both fail by drawing
 * rather than by raising: a character the palette does not hold is drawn TRANSPARENT (the format
 * says so in as many words), so a `Y` typed as `I` is a hole in the creature; and a slot written in
 * the wrong shape — one frame where the engine indexes a list, or a copied `walk` block left in
 * `idle` — is a row that is an array, drawn as garbage. Neither is reachable by the row-length rule.
 */

import blueBoyArt from "../skins/blue-boy.json";
import catArt from "../skins/cat.json";
import duckArt from "../skins/duck.json";
import { PET_SKIN } from "./pet-wire";

/** One skin: the art, and the two words a reader needs to pick it. */
export type PetSkin = {
  /** The key that travels on the wire, held to `PET_SKIN`'s own charset (pet-wire.ts). */
  name: string;
  /** What a reader sees in the picker. Never the `name`: a wire key is lowercase and hyphenated. */
  label: string;
  /** Who drew it. Credit, and the only place a licence obligation is discharged. */
  author?: string;
  /** A single character to `#RRGGBB`, or to null for a transparent pixel. `"."` must be null. */
  palette: Record<string, string | null>;
  /** The bounding box every frame must fit inside, in pixels. */
  size: { w: number; h: number };
  /** The foot point, from the top-left. The engine seats a sprite by `anchor.y`. */
  anchor: { x: number; y: number };
  /** A slot is one frame (`string[]`) — except `walk`, which is a list of them. */
  frames: Record<string, string[] | string[][]>;
  /** Suggestions the engine may take or ignore; a missing one falls back to its own default. */
  traits?: { walkSpeed?: number; walkFrameTicks?: number; messages?: Record<string, string> };
};

/** The three slots a skin must carry. Everything else has a fallback (see the ladder above). */
const REQUIRED_SLOTS = ["idle", "held", "walk"] as const;

/** The one slot that is a LIST of frames: the engine cycles it while the sprite is roaming. */
const FRAME_LIST_SLOT = "walk";

/** The art a name nobody holds falls back to. Named off the object so the two cannot disagree. */
const DEFAULT_SKIN: PetSkin = catArt;

/** Every skin this build holds, in the order a picker offers them. */
export const PET_SKINS: PetSkin[] = [DEFAULT_SKIN, blueBoyArt, duckArt];

/** The name a pet takes when nobody has chosen one. */
export const PET_DEFAULT_SKIN: string = DEFAULT_SKIN.name;

/** The art a name asks for, or the default. Never throws — see the docstring above for why. */
export function petSkin(name: string): PetSkin {
  return PET_SKINS.find((skin) => skin.name === name) ?? DEFAULT_SKIN;
}

/**
 * Why a skin is not one, or null when it is.
 *
 * It takes `unknown` and answers a sentence rather than throwing, so a caller can name the file and
 * the slot at fault — which is the whole point when the thing at fault is a row of characters.
 */
export function validatePetSkin(skin: unknown): string | null {
  if (typeof skin !== "object" || skin === null) return "a skin must be an object";
  const it = skin as Partial<PetSkin>;

  // The name is tested as the TOKEN the wire would carry, against the wire's OWN regex rather than a
  // copy of its charset: a skin whose name a ledger cannot hold is a skin nobody could ever publish,
  // and two spellings of one charset drift the moment one of them is loosened.
  if (typeof it.name !== "string" || !PET_SKIN.test(`s.${it.name}`)) {
    return `a name must match ${PET_SKIN.source} as a wire token — it cannot carry ${JSON.stringify(it.name)}`;
  }

  const palette: unknown = it.palette;
  if (typeof palette !== "object" || palette === null) return `${it.name} carries no palette`;
  if ((palette as Record<string, unknown>)["."] !== null) {
    return `${it.name} must map "." to null, which is the transparent pixel`;
  }
  const known = new Set(Object.keys(palette));

  const width = it.size?.w;
  const height = it.size?.h;
  if (!isWholePixel(width) || !isWholePixel(height)) {
    return `${it.name} needs a size in whole pixels`;
  }

  const frames: unknown = it.frames;
  if (typeof frames !== "object" || frames === null) return `${it.name} carries no frames`;
  const slots = frames as Record<string, unknown>;

  for (const slot of REQUIRED_SLOTS) {
    if (!(slot in slots)) return `${it.name} carries no ${slot} frame`;
  }

  for (const [slot, value] of Object.entries(slots)) {
    // The SHAPE is decided per slot, and the mistake runs both ways: one frame written where the
    // engine indexes a list is a `walk[0]` that is a string, and a copied `walk` block left in
    // `idle` is a row that is an array. Both draw garbage rather than failing.
    const asList = slot === FRAME_LIST_SLOT;
    const list = framesOf(value, asList);
    if (!list) {
      const shape = asList ? "a list of frames" : "rows of text";
      return `${it.name}'s ${slot} must be ${shape}`;
    }
    if (list.length === 0) return `${it.name}'s ${slot} holds no frame`;

    for (const [index, frame] of list.entries()) {
      const where = `${it.name}'s ${slot}${asList ? `[${index}]` : ""}`;
      if (frame.length === 0) return `${where} holds no rows`;
      if (frame.length > height) {
        return `${where} is ${frame.length} rows tall, over the ${height} it declares`;
      }
      const first = frame[0]?.length ?? 0;
      const unmapped = new Set<string>();
      for (const [row, line] of frame.entries()) {
        if (line.length !== first) {
          return `${where} row ${row} is ${line.length} characters where row 0 is ${first}`;
        }
        if (line.length > width) {
          return `${where} row ${row} is ${line.length} wide, over the ${width} it declares`;
        }
        // A space is transparent BY DESIGN — the format offers it for readability in a dense row —
        // so it is never unmapped. Everything else the palette does not hold is a hole.
        for (const glyph of line) if (glyph !== " " && !known.has(glyph)) unmapped.add(glyph);
      }
      if (unmapped.size > 0) {
        const holes = [...unmapped].sort().map((glyph) => JSON.stringify(glyph));
        return `${where} draws ${holes.join(", ")}, which its palette does not hold`;
      }
    }
  }

  return null;
}

/** The slot's frames as a list, or null when it is not written in the shape that slot takes. */
function framesOf(value: unknown, asList: boolean): string[][] | null {
  if (!Array.isArray(value)) return null;
  const rows = (frame: unknown) => Array.isArray(frame) && frame.every((r) => typeof r === "string");
  if (asList) return value.every(rows) ? (value as string[][]) : null;
  return value.every((row) => typeof row === "string") ? [value as string[]] : null;
}

function isWholePixel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
