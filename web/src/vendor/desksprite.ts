/* ============================================================================
   desksprite v2.1.0 — https://github.com/welltilln/desksprite — by welltilln.
   Vendored here and converted from its own IIFE to a TypeScript module. The
   creature is theirs: the frame player, the walk cycle, the grab/dangle/throw
   physics, the scared tremble, the sweat drop and the speech bubble. What is this
   app's is marked — the patches marked PATCH, and the pointer and touch rails
   argued where they stand — and each says what it prevents.

   MIT License

   Copyright (c) 2026 welltilln

   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:

   The above copyright notice and this permission notice shall be included in all
   copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   SOFTWARE.
   ============================================================================ */

/**
 * A PET'S BODY — one canvas, one creature, and nothing left of the DESK it came from.
 *
 * Upstream is a desktop widget: a pixel worker sitting at a CRT with a clock, a calendar and lunch
 * at noon, who occasionally gets up to walk the whole browser window. What this app wants is the
 * WALKING half — a small creature that lives in a strip over a conversation, several of them at once,
 * one per person. So the desk, its clock, its calendar, lunch, the seat glide, the remote `skinUrl`
 * fetch and the injected `<style>` for that chrome are all gone, and with them `CATCH_MARGIN` and
 * `deskSeatX`: nothing CATCHES a thrown pet any more, because there is no seat to catch it into — a
 * thrown pet falls, bounces off the sides of its box and lands on the floor, every time. The `carry`
 * overlay went for the other reason a thing goes: `pet-skin.ts` drops that slot from all three
 * shipped skins, so drawing one would be code no art in this repo can reach. What is left is the part
 * with the character in it, and it is kept as close to welltilln's own arithmetic as the four
 * patches allow: every constant below carries the value their file gave it.
 *
 * **THE ART IS DATA AND THE SIZE COMES OUT OF IT** (`pet-skin.ts`, which owns the format and the only
 * validation of it — this module reads a skin and never judges one). A skin declares its own `size`,
 * and the shipped ones DISAGREE: `cat` and `duck` are 13x13 while `blue-boy` is 14x14, so the drawn
 * sprite is `skin.size.w * PX` by `skin.size.h * PX` — 52 px and 56 px — and nothing here may spell
 * either as a constant. A number that disagreed with the data it draws would squash somebody's art,
 * which is the failure § A picture somebody SENT is about ("the box IS the picture").
 *
 * **THE FALLBACK LADDER IS EXERCISED BY THE SHIPPED ART, not only by a fixture.** Not one of the
 * three skins carries `fall`, `work`, `done` or `error`, so `frameFor` falls back on every single
 * frame it draws: a held cat and a falling cat are the same rows, and a working one is its idle rows.
 * That is the normal path rather than an edge case, which is why the test walks `PET_SKINS` itself.
 *
 * **A SPRITE IS POSITIONED WITH `transform` AND WITH NOTHING ELSE.** This app has a measured motion
 * budget (§ When a message was sent, and the history's own twitch test), and a pet redraws sixty
 * times a second beside a virtualized conversation — so `top`/`left`/`width`/`filter` never appear on
 * a frame path. Upstream already did this for the body and this file does it for EVERYTHING, which is
 * what makes the canvas one flat frame drawn at its own origin. The tremble, the walk-bob and the
 * error droop are offsets, and inside a canvas the size a skin declares each one clipped what it
 * pushed out: a bob of one pixel row took the feet off the bottom edge, the droop's two took the
 * legs, the tremble took the ears off the top. The flip and the SQUASH are scales rather than
 * offsets, so they ride `transform-origin: 50% 100%` — the sprite's own feet — where a 1.35x widening
 * clips nothing either and stays planted on the floor by construction rather than by upstream's
 * `squash * 8` dip, which was a constant that happened to be close. So there is no `save`/`restore`
 * and no transform stack in the draw at all.
 *
 * **WHAT THE HOST OWES A SPRITE, in one place, because the next reader is in this file.** The canvas
 * is the CALLER's: it is mounted, kept and finally removed by them, and this engine only sizes and
 * places it — which means it must have a POSITIONED ancestor, since a pet's whole position is a
 * `transform` on an `absolute` element and the box the caller states is that ancestor's own. The
 * engine writes the geometry it needs onto the element (its size, `pixelated`, `pan-y`, the origin,
 * the cursor and `pointer-events: auto`) and never a colour. It creates ONE element of its own, the
 * bubble, inserted beside the canvas and carrying the class `pet-sprite-bubble` for the app's
 * stylesheet to dress; `destroy` takes that one away and leaves the canvas untouched. **And the layer
 * must NOT be `overflow: hidden`**: a landing squash is 1.35x wide, so a pet spans some nine pixels
 * past each side of its own box for the dozen frames the squash takes to relax, and a clipping
 * ancestor would take back exactly what scaling about the feet was for. A pet also walks a band the
 * caller chose, so nothing needs clipping to stay in bounds.
 *
 * **AND EXACTLY TWO CALLBACKS ARE OUTWARD-CAPABLE: `onTap` AND `onThrow`.** Both are a real
 * `pointerup` of the pointer that grabbed the pet, on its main button, split by whether the reader
 * carried it anywhere (PATCH 4, {@link TAP_SLOP}) — so a host may hang a published write on either
 * and it will only ever fire for a press the reader aimed here. `onGrab` is NOT one of them and never
 * can be: under `touch-action: pan-y` a vertical flick that starts on a pet grabs it for a frame or
 * two before the browser claims the gesture, so it fires for a scroll. Every other ending — a cancel,
 * another button, a second finger, a release that was lost — fires neither of the two.
 *
 * **AND WHY THE BUBBLE'S LOOK IS NOT THE ENGINE'S.** Upstream injected a stylesheet with its own
 * dark bubble in it; a second palette three centimetres from this app's own is the mistake § Project
 * shape bans for icons, in another vocabulary. Its position is the engine's because only the engine
 * knows where the pet is, and that is the whole of the split. It sits beside the canvas rather than
 * on the body because both are placed with a transform in the same box's coordinates — so a canvas
 * that is in no document has no bubble either, and `say` is then quietly a no-op, which is the honest
 * answer rather than a bubble floating in another coordinate system.
 *
 * **REDUCED MOTION AND A HIDDEN DOCUMENT ARE UPSTREAM'S OWN RULES, KEPT.** Under
 * `prefers-reduced-motion` a pet does not roam, does not tremble, does not squash on landing and is
 * dropped by the ticker after one frame rather than being animated in place; a throw lands at once
 * instead of arcing. A hidden document stops the loop and `visibilitychange` re-arms it. The app's own
 * rule is stricter still — the layer draws no pet at all under reduced motion — but that belongs to
 * the surface that mounts one, not here: a sprite told to move less must still be correct on its own.
 */

import type { PetSkin } from "~/lib/pet-skin";

/** One sprite pixel, in CSS px. Upstream's own value, and what makes a 13-row skin 52 px tall. */
export const PX = 4;

/** How far above the bottom of its box the floor is. */
export const FLOOR_MARGIN = 6;

/** Pixels per frame per frame, downward, while falling. */
export const GRAVITY = 0.9;

/** The fastest a throw can leave the pointer, on either axis. */
export const THROW_CAP = 22;

/** Air resistance on a throw's horizontal speed, per frame. */
const DRAG_FRICTION = 0.985;

/** What a bounce off the side of the box keeps of the speed it arrived with. */
const BOUNCE = 0.5;

/** Walk speed, before a skin's own `walkSpeed` multiplies it. */
const WALK_SPEED = { idle: 0.7, working: 1.5 } as const;

/** The DEFAULT ticks between two walk frames — about 150 ms, which is upstream's own stride, and the
 *  number `SKIN_FORMAT.md` documents. A skin may state its own `walkFrameTicks`; none of the three
 *  shipped ones does, so this is the stride every pet in this build really walks at. */
const WALK_FRAME_TICKS = 9;

/** Ticks a pet stands still after turning at the edge of its band. */
const TURN_PAUSE = 40;

/** An idle pet stops to look around: once every 420 ticks, for 70 of them. */
const IDLE_PAUSE = { every: 420, for: 70 } as const;

/** How fast a landing's squash relaxes, per frame. */
const SQUASH_DECAY = 0.08;

/** Above this fear a held pet sweats. */
const SWEAT_FEAR = 0.45;

/** The sweat drop's own colour — an engine overlay, so it is not the skin's to pick. */
const SWEAT_COLOUR = "#9FE0FF";

/** How far a terrified pet trembles, in px, at fear 1. */
const TREMBLE = 2.2;

/** How long a bubble stays up. */
const BUBBLE_MS = 2600;

/** What the app's own stylesheet styles. The engine sets no colour on it. */
const BUBBLE_CLASS = "pet-sprite-bubble";

/**
 * PATCH 4: HOW FAR A POINTER MAY TRAVEL AND STILL BE A TAP, in CSS px.
 *
 * Upstream had no threshold at all and needed none — its `dragEnd` was
 * `if (overScreen) seatInto(); else setLoc('falling')`, with no callback out of the engine, so a
 * press that moved nothing and a fling across the desk were the same harmless thing. The moment a
 * HOST hangs an outward write on the release (this app publishes a `play` act, which is an EDIT to a
 * real Teams message), they stop being the same thing: a pet WALKS over a scrolling column where
 * every row is a live target, so a reader aiming at a bubble, a reaction chip or a hold-to-open menu
 * that a 52px creature has wandered onto would have their gesture eaten AND an act published they
 * never asked for. At a phone's width there is no gutter, so that is the ordinary case.
 *
 * So a release is told apart by its DISTANCE from the grab, and the two endings are separate
 * callbacks. It is deliberately generous — ten pixels rather than the four a mouse-only widget would
 * use — because the two mistakes are not symmetric: a deliberate throw read as a tap publishes a PAT,
 * which is a reaction that toggles and takes itself back, while a tap read as a throw publishes an
 * act that costs the creature energy and is appended to its record for good. A thumb on a phone
 * wobbles several pixels on a press it means as a press.
 */
export const TAP_SLOP = 10;

/**
 * The stale-hold detector listens in the CAPTURE phase, and that is not a preference.
 *
 * It is registered on the document from inside the canvas's own `pointerdown` handler, and a listener
 * added on an ANCESTOR during a descendant's handler IS invoked for that same event on the way back up
 * — so in the bubble phase the grab's own press would immediately cancel the grab. The document's
 * capture phase has already been passed by then, so a capture listener sees the NEXT press and no
 * earlier one. It is spelled once, as a constant, because `removeEventListener` must be given the same
 * flag or the listener is never taken off.
 */
const LOST_RELEASE = { capture: true } as const;

/**
 * What a pet is DOING, which is the axis the caller sets and the frame ladder reads.
 *
 * Upstream calls this `status` and the four names are its own. `idle` is silent; the other three each
 * have a line a skin may write for them (`traits.messages`), and the fourth word those skins carry —
 * `seat` — is never spoken here, because the seat went with the desk.
 */
const STATES = ["idle", "working", "done", "error"] as const;
export type SpriteState = (typeof STATES)[number];

/** What a pet is doing with its BODY, which the engine decides and nobody sets. */
export type SpritePose = "still" | "walk" | "held" | "falling";

/** The arena a pet walks, in CSS px. The caller measures it and re-states it on every resize. */
export type SpriteBox = { width: number; height: number };

/** Where in that box this pet belongs, as fractions of its width. See PATCH 3. */
export type SpriteBand = { from: number; to: number };

/** What the engine says when a skin does not. Upstream's own words, minus `seat`. */
const SPEECH: Record<Exclude<SpriteState, "idle">, string> = {
  working: "on it!",
  done: "done ✓",
  error: "uh oh…",
};

/** The frame slot each state draws, before the ladder falls back to `idle`. */
const STATE_SLOT: Record<SpriteState, string> = {
  idle: "idle",
  working: "work",
  done: "done",
  error: "error",
};

// ── Pure helpers ────────────────────────────────────────────────────────────────
// Everything above the canvas work is a function of its arguments, so the parts with arithmetic in
// them are tested with no browser at all (`desksprite.test.ts`). They are exported for that reason
// rather than because a caller needs them.

/**
 * The rows a pose and a state draw, or null when there are none to draw.
 *
 * `walk` answers null because it is a LIST and the caller cycles it — the one pose whose frame
 * depends on a counter rather than on a state. Everything else resolves through upstream's ladder:
 * `fall` falls back to `held`, and `work` / `done` / `error` to `idle`. A slot written in the wrong
 * shape — the copied-`walk`-block mistake `pet-skin.ts` describes — reads as absent here and takes
 * the same fallback, because this engine draws nothing rather than throwing inside a frame.
 */
export function frameFor(skin: PetSkin, pose: SpritePose, state: string): string[] | null {
  if (pose === "walk") return null;
  if (pose === "held") return rowsOf(skin, "held");
  if (pose === "falling") return rowsOf(skin, "fall") ?? rowsOf(skin, "held");
  const slot = STATE_SLOT[spriteState(state)];
  return rowsOf(skin, slot) ?? rowsOf(skin, "idle");
}

/**
 * The floor of a box, for a sprite that tall.
 *
 * PATCH 2 lives here as much as anywhere: upstream read `global.innerHeight`, which is the wrong
 * number for a creature that lives in a strip over a conversation. Floored at zero, so a box shorter
 * than the pet leaves it standing at the top rather than drawn above the box altogether.
 */
export function spriteFloor(box: SpriteBox, spriteHeight: number): number {
  return Math.max(0, box.height - FLOOR_MARGIN - spriteHeight);
}

/**
 * The x range a pet wanders, in px — PATCH 3.
 *
 * The band is fractions of the box's width and the answer is where the sprite's own left edge may
 * be, so the whole creature stays inside it: `max` already has its width taken off. Three things it
 * refuses, each because the alternative strands a pet somewhere nobody can see it — a band written
 * backwards is read as the range it describes, a band narrower than the sprite collapses to one
 * point rather than inverting, and a fraction that is not a number falls back to the whole box.
 */
export function bandBounds(
  band: SpriteBand,
  box: SpriteBox,
  spriteWidth: number,
): { min: number; max: number } {
  const maxX = Math.max(0, box.width - spriteWidth);
  const from = fraction(band.from, 0);
  const to = fraction(band.to, 1);
  const min = clamp(Math.min(from, to) * box.width, 0, maxX);
  const max = clamp(Math.max(from, to) * box.width - spriteWidth, min, maxX);
  return { min, max };
}

/** Where a thrown pet is, and how fast — the four numbers `fallStep` moves. */
export type FallBody = { x: number; y: number; vx: number; vy: number };

/**
 * One frame of a throw: gravity, drift, friction, and a bounce off either side of the box.
 *
 * The ORDER is upstream's and it is load-bearing — x moves by the speed it arrived with, y by the
 * speed gravity has just given it, and the friction lands before the bounce so a bounce keeps half of
 * what the air already took. Landing is NOT decided here: the caller compares y with the floor, which
 * is what keeps this a function of its arguments. `maxX` is the whole BOX rather than the band,
 * because a throw is allowed to cross a band and the walk is what brings the pet back into it.
 */
export function fallStep(body: FallBody, maxX: number): FallBody {
  const vy = body.vy + GRAVITY;
  const y = body.y + vy;
  let x = body.x + body.vx;
  let vx = body.vx * DRAG_FRICTION;
  if (x < 0) {
    x = 0;
    vx = Math.abs(vx) * BOUNCE;
  }
  if (x > maxX) {
    x = maxX;
    vx = -Math.abs(vx) * BOUNCE;
  }
  return { x, y, vx, vy };
}

/** An unknown state reads as `idle`, which is upstream's own rule: a name from a newer build — or a
 *  mood this engine has never heard of — must leave a pet drawn rather than blank. */
function spriteState(value: string): SpriteState {
  return STATES.find((state) => state === value) ?? "idle";
}

function fraction(value: number, fallback: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A skin's rows for one slot, or null when that slot is absent or is not rows of text. */
function rowsOf(skin: PetSkin, slot: string): string[] | null {
  const value = skin.frames[slot];
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((row) => typeof row === "string") ? (value as string[]) : null;
}

/** The walk cycle's frames, dropping any written in the wrong shape. */
function walkFrames(skin: PetSkin): string[][] {
  const value = skin.frames["walk"];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (frame): frame is string[] =>
      Array.isArray(frame) && frame.length > 0 && frame.every((row) => typeof row === "string"),
  );
}

/** A trait is a suggestion rather than a contract, so a bad value means "use the default". */
function traitNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// ── The frame player ────────────────────────────────────────────────────────────

/** A resolved colour per pixel, or null where nothing is drawn. */
type ColourGrid = (string | null)[][];

function frameToGrid(rows: string[], palette: PetSkin["palette"]): ColourGrid {
  return rows.map((row) =>
    Array.from(row, (glyph) => {
      if (glyph === "." || glyph === " ") return null;
      // A glyph the palette does not hold is TRANSPARENT — the format says so, which is exactly why
      // `pet-skin.ts` validates for it: a typo is a hole in the creature rather than a failure.
      return palette[glyph] ?? null;
    }),
  );
}

/**
 * Resolved grids, cached per skin and then per frame-rows.
 *
 * Keyed by the skin OBJECT and then by the rows ARRAY, both by reference, so a swapped skin
 * transparently gets a fresh cache and the old one is collected — there is nothing to invalidate.
 * It matters because `frameToGrid` is O(w*h) and a pet resolves a frame sixty times a second.
 */
const gridCache = new WeakMap<PetSkin, Map<string[], ColourGrid>>();

function gridFor(skin: PetSkin, rows: string[]): ColourGrid {
  let byRows = gridCache.get(skin);
  if (!byRows) {
    byRows = new Map();
    gridCache.set(skin, byRows);
  }
  let grid = byRows.get(rows);
  if (!grid) {
    grid = frameToGrid(rows, skin.palette);
    byRows.set(rows, grid);
  }
  return grid;
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  grid: ColourGrid,
  ox: number,
  oy: number,
  px: number,
): void {
  for (const [y, row] of grid.entries()) {
    for (const [x, colour] of row.entries()) {
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(ox + x * px, oy + y * px, px, px);
    }
  }
}

// ── PATCH 1: ONE TICKER FOR EVERY PET ───────────────────────────────────────────
// Upstream's `start()` armed a `requestAnimationFrame` loop per instance, which is right for one
// desk widget and wrong for a conversation drawing a pet per person: five pets meant five loops
// racing each other, five `document.hidden` checks and five chances to leave one running after its
// element was gone. There is one loop here that every live sprite registers with, and it stops when
// the last one leaves — openpets does exactly this with a single 16 ms interval.
//
// A sprite leaves the set by ANSWERING FALSE from its own step rather than by stopping the loop for
// its neighbours, and under reduced motion that is every pose but a throw in flight. It is NOT
// narrowed further than that, and the reason is `pauseFor`: a pet standing at the end of its band is
// counting ticks down, so one dropped for standing still would never resume. What a pet that is
// really still costs is one clear and a few dozen `fillRect`s a frame — a dirty check that skipped
// the draw would have to name every input the frame reads (the pose, the state, x, y, the walk
// counter, the squash, the pause, the tremble's own randomness), and one forgotten is a pet frozen
// mid-stride.

type Ticking = { step(): boolean };

const live = new Set<Ticking>();
let pending: number | null = null;
let watchingVisibility = false;

function arm(): void {
  if (pending !== null || live.size === 0 || document.hidden) return;
  pending = requestAnimationFrame(tick);
}

function tick(): void {
  pending = null;
  // A hidden document stops the loop — upstream's own rule. `visibilitychange` re-arms it, which is
  // why nothing here has to poll to find out the tab came back.
  if (document.hidden) return;
  for (const sprite of [...live]) if (!sprite.step()) live.delete(sprite);
  arm();
}

function join(sprite: Ticking): void {
  live.add(sprite);
  if (!watchingVisibility) {
    document.addEventListener("visibilitychange", arm);
    watchingVisibility = true;
  }
  arm();
}

function leave(sprite: Ticking): void {
  live.delete(sprite);
  if (live.size > 0) return;
  if (pending !== null) {
    cancelAnimationFrame(pending);
    pending = null;
  }
  if (watchingVisibility) {
    document.removeEventListener("visibilitychange", arm);
    watchingVisibility = false;
  }
}

// ── One sprite ──────────────────────────────────────────────────────────────────

/** Everything a caller can do to a live pet. */
export type SpriteHandle = {
  /** What it is doing: `idle`, `working`, `done` or `error`. Anything else reads as `idle`. */
  setState(state: string): void;
  /** Put a line above its head. Nothing is said for an empty string. */
  say(text: string): void;
  /** Re-state the arena — PATCH 2. The caller owns the resize; this engine watches no window. */
  setBox(box: SpriteBox): void;
  /**
   * Re-state WHERE IN THE BOX this pet belongs — PATCH 3, and the reason that patch exists at all.
   *
   * A caller that shares one box between several creatures re-cuts every band whenever one arrives
   * or leaves, and without this the only way to hand a sprite its new lane was to DESTROY it and
   * build another — which loses everything the closure holds. Three things went with it, and all
   * three were visible: a fresh sprite starts at `bounds.min`, so every pet in the box SNAPPED to
   * the left edge of its new lane the moment anybody spawned; it starts at the engine's own `idle`,
   * so a working creature walked at idle pace and never spoke again; and re-stating the state to
   * repair that made it SPEAK, so a spawn put a speech bubble over every other pet in the box.
   *
   * Nothing is clamped here on purpose: the pet is simply outside its new lane, and a WALKING one
   * strolls back in from wherever it is (that is the same patch's own rule for a pet the reader has
   * THROWN out of its band). A clamp would be the teleport this method exists to delete.
   *
   * The exception, stated because a comment that overclaims sends its next reader hunting a bug
   * that is not there: `roamStep` returns early for `state === "error"` and does not run at all
   * while a pet is `held` or `falling` — so an ERRORED creature stands outside its re-cut lane
   * until its state changes. The cost is cosmetic and bounded: it is still inside the BOX, still
   * drawn, and all that happens is that two lanes overlap for a while.
   */
  setBand(band: SpriteBand): void;
  /** Stop animating, take the bubble away, and let go of every listener. */
  destroy(): void;
};

export type SpriteOptions = {
  /** The canvas the pet is drawn on. The caller mounts it; the engine sizes and places it. */
  canvas: HTMLCanvasElement;
  skin: PetSkin;
  box: SpriteBox;
  band: SpriteBand;
  /**
   * The reader picked it up. **Wire nothing outward or irreversible to this.** A touch scroll that
   * starts on the pet grabs it for a frame or two before the browser claims the gesture (see
   * `dragMove`), so this fires for a gesture nobody meant as a grab. `onThrow` is the one with the
   * rails on it.
   */
  onGrab?: () => void;
  /**
   * The reader PRESSED it and let go without carrying it anywhere — PATCH 4.
   *
   * This and {@link onThrow} are the TWO outward-capable callbacks and the only two: both fire on a
   * real `pointerup` of the SAME POINTER that grabbed the pet, on that pointer's MAIN button, and
   * they are exclusive — one release is exactly one of them, decided by the distance travelled
   * against {@link TAP_SLOP}. Every rail below is shared, so neither can be reached by a gesture the
   * reader did not aim at this pet.
   */
  onTap?: () => void;
  /**
   * The reader CARRIED it somewhere and let go — a throw, past {@link TAP_SLOP}.
   *
   * Both this and {@link onTap} are callbacks an OUTWARD action may hang on, and they are the only
   * two here that may. A release reaches one of them only when it is a real `pointerup` of the SAME
   * POINTER that grabbed the pet, on that pointer's MAIN button. Every other ending of a drag reaches
   * the pet and NEITHER callback: a gesture the browser cancelled (a scroll), a release of another
   * button or another finger (which does not end the drag at all), and a hold whose release was LOST
   * — a swallowed release, a mouse let go outside the window — which ends as a cancel rather than
   * waiting to be mistaken for the reader's next click. Each of those was a door an unmeant write
   * walked through; what is left is a press and a release the reader aimed at this pet, split by
   * whether they moved it.
   */
  onThrow?: () => void;
  /** The reader asked for less movement. The caller resolves the query; this engine never asks. */
  reducedMotion?: boolean;
};

export function createSprite(options: SpriteOptions): SpriteHandle {
  const { canvas, skin } = options;
  // The band is a VARIABLE and not a const — PATCH 3. It is the one thing about a sprite that the
  // caller re-decides while the creature lives (a lane is a share of a box several pets divide), and
  // `setBand` is what makes re-deciding it cost nothing. See that method for the three defects a
  // rebuild carried.
  let band = options.band;
  const reducedMotion = options.reducedMotion === true;
  const doc = canvas.ownerDocument;

  // The sprite's own footprint, out of the skin's declared size — never a constant.
  const width = skin.size.w * PX;
  const height = skin.size.h * PX;
  // Both of these are resolved ONCE. Upstream re-read its traits every step so a runtime skin swap
  // would change pace immediately; a skin is captured per sprite here and cannot be swapped, so a
  // per-frame re-read would be the same answer sixty times a second — and `walkFrames` would re-filter
  // the whole cycle with it.
  const cycle = walkFrames(skin);
  // NOTE for whoever first authors a skin with this trait: `traitNumber` admits any finite value above
  // zero, so a FRACTION is accepted and is nonsense as a tick count — `0.5` advances the frame every
  // tick and `0.3` never advances it at all, since `body.t % 0.3` is float noise that rarely lands on
  // zero. Either one is a pet that walks without animating. It is left unguarded rather than clamped
  // because a trait is a suggestion by design (`pet-skin.ts` validates none of them) and no shipped
  // skin declares this one, so a guard here would be a rule invented for a value nothing states.
  const walkFrameTicks = traitNumber(skin.traits?.walkFrameTicks, WALK_FRAME_TICKS);

  let box = options.box;
  let bounds = bandBounds(band, box, width);
  let state: SpriteState = "idle";
  let pose: "roaming" | "held" | "falling" = "roaming";
  let destroyed = false;
  /** The pointer this pet is being dragged BY, or null. See `isDragPointer`. */
  let dragPointer: number | null = null;
  let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  // The bubble's own box, measured once per line it says (see `positionBubble`).
  let bubbleW = 140;
  let bubbleH = 28;
  let lastX = 0;
  let lastY = 0;

  const body = {
    x: bounds.min,
    y: spriteFloor(box, height),
    vx: 0,
    vy: 0,
    /** Which way it faces, and what flips the frame. */
    dir: 1,
    /** The walk cycle's counter. */
    frame: 0,
    /** Ticks since it was born, which every cadence here is modulo of. */
    t: 0,
    /** Ticks left standing still. */
    pauseFor: 0,
    /** How high off the floor it is being held, 0…1 — what the tremble and the sweat read. */
    fear: 0,
    /** How flat the landing left it, 1…0. */
    squash: 0,
    grabDX: width / 2,
    grabDY: height / 2,
    /** Where the pointer was when it picked this pet up — PATCH 4, and the only thing that tells a
     *  TAP from a THROW. It is the grab's own point rather than `lastX`/`lastY`, which every move
     *  overwrites: a pet carried out and back would otherwise measure as a press. */
    grabX: 0,
    grabY: 0,
  };

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.imageRendering = "pixelated";
  canvas.style.willChange = "transform";
  // The squash and the flip are scaled about the FEET, which is what plants them on the floor.
  canvas.style.transformOrigin = "50% 100%";
  canvas.style.cursor = "grab";
  // A pet lives in an overlay that lets clicks through to the conversation under it, so the one
  // element here that must catch a pointer says so itself rather than relying on its host.
  canvas.style.pointerEvents = "auto";
  // `pan-y` AND NEVER `none`: a vertical touch has to scroll the conversation this pet floats over.
  // `none` is the measured chess-board failure in another vocabulary (§ Chess in a conversation — the
  // renderer wrote it on all 32 pieces and "a finger landing on an occupied square could not scroll
  // the conversation"), and it would be worse here, because this dead zone WALKS: a reader flicks up,
  // their thumb lands on a pet that has wandered under it, and the history does not move. With `pan-y`
  // the browser takes the vertical gesture and fires `pointercancel`, which `dragEnd` already treats
  // as a drop, and the horizontal drag still reaches `dragMove`. The cost is stated where it is paid:
  // a pet cannot be thrown straight UP by touch, only sideways — and a mouse keeps every direction.
  canvas.style.touchAction = "pan-y";

  const bubble = doc.createElement("div");
  bubble.className = BUBBLE_CLASS;
  bubble.hidden = true;
  bubble.style.position = "absolute";
  bubble.style.left = "0";
  bubble.style.top = "0";
  bubble.style.pointerEvents = "none";
  bubble.style.whiteSpace = "nowrap";
  const speaks = canvas.insertAdjacentElement("afterend", bubble) !== null;

  function floor(): number {
    return spriteFloor(box, height);
  }

  /** Whether an event belongs to the pointer that grabbed this pet. See `onPointerDown` for why. */
  function isDragPointer(event: PointerEvent): boolean {
    return dragPointer !== null && event.pointerId === dragPointer;
  }

  /**
   * How high off the floor it is being held, which the tremble and the sweat read.
   *
   * NOTE: it is not refreshed while FALLING — this runs on a grab, on a move and on a resize, so a
   * dropped pet trembles at the fear it had at RELEASE all the way down rather than calming as it
   * nears the floor. Upstream's own shape, left alone: the fall lasts a few dozen frames and the
   * alternative is a fear that fights the sweat drop's own threshold on the way down.
   */
  function updateFear(): void {
    const level = floor();
    body.fear = clamp((level - body.y) / Math.max(1, level), 0, 1);
  }

  /** The rows to draw right now: the walk cycle while walking, the ladder otherwise. */
  function rowsNow(walking: boolean): string[] | null {
    // A skin with no usable walk frames stands still rather than vanishing while it moves.
    if (walking && cycle.length > 0) {
      return cycle[body.frame % cycle.length] ?? null;
    }
    return frameFor(skin, pose === "roaming" ? "still" : pose, state);
  }

  /**
   * Draw the frame and place the element, in one pass, because the two can never disagree about which
   * frame they are showing.
   *
   * EVERY transform is the ELEMENT's (see the docstring): the tremble, the walk-bob and the droop
   * because they are offsets, and the flip and the squash because `transform-origin: 50% 100%` scales
   * them about the sprite's own feet. So the canvas holds one frame drawn flat at its own origin, with
   * no `save`/`restore` and no `translate` pair — and upstream's `squash * 8` dip is gone with them,
   * because a scale about the feet keeps the feet planted by construction rather than by a constant
   * that happened to be close.
   */
  function render(): void {
    const scared = pose === "held" || pose === "falling";
    const walking = pose === "roaming" && body.pauseFor <= 0 && state !== "error";
    const tremble = scared && !reducedMotion ? body.fear * TREMBLE : 0;
    const jx = tremble ? Math.round((Math.random() * 2 - 1) * tremble) : 0;
    const jy = tremble ? Math.round((Math.random() * 2 - 1) * tremble) : 0;
    const bob = walking && body.frame % 2 ? 1 : 0;
    const droop = state === "error" ? 2 : 0;
    const flip = body.dir < 0 && !scared ? -1 : 1;
    const x = Math.round(body.x + jx);
    const y = Math.round(body.y + jy + (bob + droop) * PX);
    const sx = flip * (1 + body.squash * 0.35);
    const sy = 1 - body.squash * 0.35;
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const rows = rowsNow(walking);
    if (!rows) return;
    drawFrame(ctx, gridFor(skin, rows), 0, 0, PX);
    // The sweat drop is the engine's, not the skin's — and it is placed off the skin's own width so a
    // narrow creature cannot sweat outside its box. It flips and squashes with the pet, because the
    // element carries both and the drop is inside it.
    if (scared && body.fear > SWEAT_FEAR) {
      ctx.fillStyle = SWEAT_COLOUR;
      ctx.fillRect((skin.size.w - 2) * PX, 3 * PX, 2, 4);
    }
  }

  /**
   * Where the bubble sits, from the two numbers `say` measured.
   *
   * It is called on every frame a bubble is up, so it READS no layout: `offsetWidth` in here was a
   * forced reflow sixty times a second for 2.6 s, and the text cannot change while one is shown. What
   * that costs is a bubble whose own box grows AFTER it was measured — a font landing late — being
   * placed for the size it had; the next line it says is measured again.
   */
  function positionBubble(): void {
    if (!speaks || bubble.hidden) return;
    const left = clamp(body.x + width / 2 - bubbleW / 2, 0, Math.max(0, box.width - bubbleW));
    const top = Math.max(0, body.y - bubbleH + 2);
    bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function say(text: string): void {
    if (destroyed || !text || !speaks) return;
    bubble.textContent = text;
    bubble.hidden = false;
    bubbleW = bubble.offsetWidth || 140;
    bubbleH = bubble.offsetHeight || 28;
    positionBubble();
    if (bubbleTimer !== null) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
    }, BUBBLE_MS);
  }

  function setPose(next: typeof pose): void {
    pose = next;
    canvas.style.cursor = next === "held" ? "grabbing" : next === "roaming" ? "grab" : "default";
    join(ticking);
  }

  function land(): void {
    body.y = floor();
    body.vy = 0;
    body.vx = 0;
    body.squash = reducedMotion ? 0 : 1;
    setPose("roaming");
  }

  /**
   * One step of the walk — PATCH 3.
   *
   * Upstream turned at 0 and at the window's own right edge, which put every pet on one page in one
   * lane: three of them bunched at the same end and read as broken. A pet turns at the edges of its
   * BAND instead, and a pet the reader has thrown out of its band walks back into it rather than
   * standing where it landed. A pet in `error` STANDS STILL, which is upstream's own rule and the
   * movement refusal in miniature — it advances its walk counter and nothing draws it, because
   * `render` withholds the walk cycle from an errored pet. That increment is upstream's own dead
   * store, kept because deleting it is a change to a vendored engine for no visible gain.
   */
  function roamStep(): void {
    if (state === "error") {
      if (body.t % walkFrameTicks === 0) body.frame++;
      return;
    }
    if (body.pauseFor > 0) {
      body.pauseFor--;
      return;
    }
    const speed =
      (state === "working" ? WALK_SPEED.working : WALK_SPEED.idle) *
      traitNumber(skin.traits?.walkSpeed, 1);
    if (body.x < bounds.min) {
      body.dir = 1;
      body.x = Math.min(bounds.min, body.x + speed);
    } else if (body.x > bounds.max) {
      body.dir = -1;
      body.x = Math.max(bounds.max, body.x - speed);
    } else {
      body.x += body.dir * speed;
      if (body.x >= bounds.max) {
        body.x = bounds.max;
        body.dir = -1;
        body.pauseFor = TURN_PAUSE;
      }
      if (body.x <= bounds.min) {
        body.x = bounds.min;
        body.dir = 1;
        body.pauseFor = TURN_PAUSE;
      }
      if (state === "idle" && body.t % IDLE_PAUSE.every === 0) body.pauseFor = IDLE_PAUSE.for;
    }
    if (body.t % walkFrameTicks === 0) body.frame++;
  }

  const ticking: Ticking = {
    step(): boolean {
      if (destroyed) return false;
      body.t++;
      if (body.squash > 0) body.squash = Math.max(0, body.squash - SQUASH_DECAY);
      if (pose === "falling") {
        // Under reduced motion a throw does not arc: it is over where it started.
        if (reducedMotion) land();
        else {
          const next = fallStep(body, Math.max(0, box.width - width));
          body.x = next.x;
          body.y = next.y;
          body.vx = next.vx;
          body.vy = next.vy;
          if (body.y >= floor()) land();
        }
      } else if (pose === "roaming" && !reducedMotion) {
        roamStep();
      }
      render();
      positionBubble();
      // A pet that moves on its own wants the next frame. Under reduced motion nothing does — a drag
      // draws itself — so the ticker lets it go rather than spinning over a still creature.
      return !reducedMotion || pose === "falling";
    },
  };

  /**
   * A drag is a DELTA, and that is what reconciles two coordinate systems.
   *
   * A pointer is in the viewport and a pet is in its box, so `grabDX` absorbs the difference at the
   * moment of the grab and every move after it is the distance the pointer travelled — which is also
   * what lets the reader carry a pet clean out of its box and throw it back in. What it cannot
   * survive is the box MOVING under the pointer mid-drag, and under `touch-action: pan-y` that is an
   * ORDINARY case rather than a hypothetical: a vertical flick that STARTS ON THE PET is delivered
   * here for a frame or two — the pet jumps to the finger — before the browser claims the gesture as
   * a scroll and fires `pointercancel`. `dragEnd` takes that as a drop with no momentum and no
   * `onThrow`, so what the reader sees is a pet that hopped and fell while the conversation scrolled
   * under it. That flicker is the price of a history that scrolls, and it is bounded.
   *
   * THE UPGRADE, if it proves to matter on a real phone: adopt a TOUCH grab only on the first move
   * that is more horizontal than vertical — a carousel's own rule — so the pick-up waits for proof
   * the gesture is a drag. It is deliberately not done here, because it changes how a pet is grabbed
   * and, with `onThrow` railed, the flicker is the only thing left to buy.
   */
  function dragMove(event: PointerEvent): void {
    if (!isDragPointer(event)) return;
    body.x = event.clientX - body.grabDX;
    body.y = event.clientY - body.grabDY;
    body.vx = clamp((event.clientX - lastX) * 0.6 + body.vx * 0.4, -THROW_CAP, THROW_CAP);
    body.vy = clamp((event.clientY - lastY) * 0.6 + body.vy * 0.4, -THROW_CAP, THROW_CAP);
    lastX = event.clientX;
    lastY = event.clientY;
    updateFear();
    render();
    positionBubble();
  }

  /**
   * The reader let go — or the BROWSER took the gesture away, which here is an ordinary event rather
   * than an edge case (see `dragMove`).
   *
   * Being held IS being dragged, so there is no second flag for it: two answers to "is the reader
   * holding this pet?" is one of them going stale, and the pose is also what stops one release
   * becoming two throws when `pointerup` and `pointercancel` both land here.
   *
   * **ONE PATH FOR THE PHYSICS, TWO ANSWERS FOR WHAT THE READER MEANT.** A pet that was picked up
   * lands whichever way the gesture ended, because it really was in the air. But a CANCEL is not a
   * throw: it carries no momentum, so the pet drops where it stands instead of being flung across the
   * strip by the scroll flick that cancelled it — and it never calls `onThrow`. That callback is an
   * OUTWARD action in this app: a host hangs a published act off it, an edit to a real Teams message,
   * and an outward action is the user's own deliberate press (§ Sending messages). A scroll is not
   * one, and every accidental one starting on a pet would otherwise publish a write.
   *
   * **A THROW IS A `pointerup` AND NOTHING ELSE**, which is why one function serves all THREE endings
   * and the whole rule is one comparison. `pointerup` on the document carries no promise about which
   * button or which pointer, and both other doors were open: holding a pet with the left button and
   * RIGHT-clicking fires a `pointerup` for the same pointer with `button === 2`, which threw the pet
   * out of the reader's hand and published an act with the left button still down; and a second FINGER
   * tapping anywhere fired one too. So a release that is not the grabbing pointer's main button is not
   * a release of the grab, and it is ignored.
   *
   * **A RELEASE IS A TAP OR A THROW, and NOTHING ELSE IS EITHER — PATCH 4.** Upstream had no such
   * split and needed none, because it called nothing out of the engine; a HOST that publishes on a
   * release does need it, or a press that moved nothing publishes the act a fling was meant to. The
   * distance from the grab point decides ({@link TAP_SLOP}), and the two are exclusive: one release
   * fires exactly one callback. Only a real `pointerup` reaches either, so every rail below covers
   * both — a cancel, another button, another finger and a lost release each fire NEITHER.
   *
   * **THE THIRD ENDING IS A RELEASE THAT NEVER ARRIVED, and it is why this is also the `pointerdown`
   * listener.** Ignoring the wrong release leaves the pet HELD, which is right while a hand really
   * holds it and wrong once the hold has gone stale — and it goes stale two ordinary ways: a context
   * menu can swallow the left release, and a mouse released OUTSIDE the browser window delivers no
   * `pointerup` to the page at all. A stale hold is not harmless, because the reader's next ordinary
   * click carries the same mouse `pointerId` and `button === 0`: it passes every guard above and
   * publishes an act on an interaction that had nothing to do with the pet. So a PRESS BY THE POINTER
   * THAT IS SUPPOSEDLY STILL HOLDING THIS PET is read as proof that its release was lost — a mouse's
   * `pointerId` is constant for the life of the mouse, so that press is the same pointer pressing
   * twice with no release in between — and a lost release is a cancel: no momentum, no `onThrow`.
   * What it costs is that a right-click while dragging now DROPS the pet instead of keeping it in
   * hand, which is the lesser of the two: a clean drop with nothing published, against a write the
   * reader's next click would have made.
   */
  function dragEnd(event: PointerEvent): void {
    if (destroyed || pose !== "held" || !isDragPointer(event)) return;
    if (event.type === "pointerup" && event.button !== 0) return;
    const released = event.type === "pointerup";
    // PATCH 4: the distance from the GRAB decides which of the two the reader meant. It is measured
    // here rather than tracked per move because a pet carried out of its box and brought back is a
    // press by this measure and a fling by any other — and the reader's hand is the authority.
    const threw =
      released && Math.hypot(event.clientX - body.grabX, event.clientY - body.grabY) > TAP_SLOP;
    endDrag();
    if (!threw) {
      // A tap drops where it stands, like a cancel: its own velocity is whatever a few pixels of
      // wobble gave it, and a creature flicked across the strip by a press reads as a bug.
      body.vx = 0;
      body.vy = 0;
    }
    dragPointer = null;
    setPose("falling");
    if (threw) options.onThrow?.();
    else if (released) options.onTap?.();
  }

  function endDrag(): void {
    doc.removeEventListener("pointermove", dragMove);
    doc.removeEventListener("pointerup", dragEnd);
    // A touch gesture the browser interrupts is treated as a drop, or the pet stays stuck to a
    // pointer that is no longer there.
    doc.removeEventListener("pointercancel", dragEnd);
    doc.removeEventListener("pointerdown", dragEnd, LOST_RELEASE);
  }

  /**
   * Only the PRIMARY pointer's MAIN button picks a pet up, and the pointer that did is remembered.
   *
   * Everything after the grab is delivered on the DOCUMENT — which is what lets the reader carry a pet
   * anywhere — and the document promises nothing about which pointer an event belongs to. So the id is
   * captured here and `isDragPointer` is the gate on both handlers: without it a second finger's
   * `pointermove` TELEPORTED the pet to it with a large velocity, and its release published a throw
   * nobody made. `isPrimary` keeps a second finger from starting one in the first place, and
   * `button !== 0` keeps a right- or middle-click from doing it.
   *
   * A pet is deliberately NOT grabbable while it is `falling` — upstream's own gate — which on a high
   * drop is about a second of dead target under the reader's finger. It is defensible: a pet in the
   * air is not somewhere a hand can reach, and catching one would need the drag to adopt a body that
   * already has velocity.
   */
  function onPointerDown(event: PointerEvent): void {
    if (destroyed || pose !== "roaming") return;
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    dragPointer = event.pointerId;
    body.grabDX = event.clientX - body.x;
    body.grabDY = event.clientY - body.y;
    body.grabX = event.clientX;
    body.grabY = event.clientY;
    body.vx = 0;
    body.vy = 0;
    lastX = event.clientX;
    lastY = event.clientY;
    updateFear();
    setPose("held");
    render();
    doc.addEventListener("pointermove", dragMove);
    doc.addEventListener("pointerup", dragEnd);
    doc.addEventListener("pointercancel", dragEnd);
    doc.addEventListener("pointerdown", dragEnd, LOST_RELEASE);
    options.onGrab?.();
  }

  canvas.addEventListener("pointerdown", onPointerDown);

  render();
  join(ticking);

  return {
    setState(next: string): void {
      const wanted = spriteState(next);
      // Only a CHANGE speaks: a surface that re-states the same state on every render must not make
      // the pet repeat itself, and the words are a skin's personality rather than a heartbeat.
      if (destroyed || wanted === state) return;
      state = wanted;
      if (wanted !== "idle") say(skin.traits?.messages?.[wanted] ?? SPEECH[wanted]);
      // No `join` on either of these two: a pet that moves is already in the set and one that does
      // not has nothing to animate, so the render above is the whole of the work.
      render();
    },
    say,
    setBox(next: SpriteBox): void {
      if (destroyed) return;
      box = next;
      bounds = bandBounds(band, box, width);
      // A box that narrowed under the pet would leave it off the edge, which is the whole reason the
      // caller re-states one; the walk brings it back into its band from there. A HELD pet is left
      // exactly where the reader's finger has it — upstream's own resize excluded that pose, because
      // clamping a pet somebody is holding yanks it out of their hand for a frame, and the throw's
      // own bounce puts it back inside the box anyway.
      //
      // **AND THE FLOOR MOVES BOTH WAYS, which is the half that was missing — PATCH 2.** A floor
      // that ROSE (a box that got shorter) re-seats the pet at once, because there is nowhere else
      // for it to be. A floor that DROPPED left it in MID-AIR, and nothing ever brought it down: a
      // `roaming` pet walks at a fixed y and only `falling` reads gravity, so it kept pacing an
      // empty stretch of the box with its own trigger up to 400 px below it. Measured: growing the
      // arena from 500 px to 900 px tall left a 406 px gap. Every trigger is ordinary — rotating a
      // phone, an on-screen keyboard closing, un-maximising a window, an iOS toolbar collapsing —
      // and the comment above named only the narrowing case, which is the half that was thought
      // about. It FALLS instead, which hands the problem to the pose a thrown pet already uses, so
      // the arc, the landing and the squash are all written.
      if (pose !== "held") {
        body.x = clamp(body.x, 0, Math.max(0, box.width - width));
        body.y = Math.min(body.y, floor());
        if (body.y < floor()) setPose("falling");
      }
      updateFear();
      render();
      positionBubble();
    },
    setBand(next: SpriteBand): void {
      if (destroyed) return;
      band = next;
      bounds = bandBounds(band, box, width);
      // No clamp and no render: the pet is where it was, its lane has moved, and the walk brings it
      // over — which is the whole difference between this and being rebuilt at the new lane's edge.
      // A pet that is not walking (errored, held, falling) waits where it is; see the handle's own
      // docstring for why that is left alone.
    },
    destroy(): void {
      // NOTE: this leaves `dragPointer` set and the pose `held` if the handle is destroyed mid-drag,
      // and that is inert rather than tidy: `destroyed` gates every entry point, the listeners are
      // gone with `endDrag`, and the whole closure dies with the handle. Zeroing them would be
      // housekeeping nobody can observe.
      destroyed = true;
      leave(ticking);
      if (bubbleTimer !== null) clearTimeout(bubbleTimer);
      canvas.removeEventListener("pointerdown", onPointerDown);
      endDrag();
      // The bubble is ours and goes; the CANVAS is the caller's and is left exactly where it was.
      bubble.remove();
    },
  };
}
