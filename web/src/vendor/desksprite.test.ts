// The engine's PURE half, with no canvas and no DOM anywhere in it — which is exactly what the
// vendored file was split for. What is tested is the arithmetic a wrong number makes invisible: a
// frame ladder that falls through to nothing draws an empty creature, a band that inverts strands a
// pet off the edge of its box, and a physics step whose order slipped by one frame still looks like
// gravity. Every one of those fails by DRAWING rather than by throwing, so a test is the only reader
// that can see it.
//
// The ladder and the box are walked over `PET_SKINS` itself rather than over fixtures alone, because
// the shipped art is where the fallbacks really live: not one of the three skins carries `fall`,
// `work`, `done` or `error`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PET_SKINS, petSkin, type PetSkin } from "~/lib/pet-skin";
import {
  FLOOR_MARGIN,
  GRAVITY,
  PX,
  TAP_SLOP,
  THROW_CAP,
  bandBounds,
  fallStep,
  frameFor,
  spriteFloor,
  type FallBody,
} from "./desksprite";

/** A skin that carries every optional slot, which no shipped one does. */
const RICH: PetSkin = {
  name: "rich",
  label: "Rich",
  palette: { ".": null, X: "#FFFFFF" },
  size: { w: 2, h: 2 },
  anchor: { x: 1, y: 2 },
  frames: {
    idle: ["X.", ".X"],
    held: ["XX", ".."],
    walk: [["X.", "X."], [".X", ".X"]],
    fall: ["..", "XX"],
    work: ["XX", "XX"],
    done: ["X.", "X."],
    error: [".X", ".X"],
  },
};

describe("the constants upstream chose", () => {
  it("are the values it chose", () => {
    // Move one of these and the creature is a different animal: PX decides how big a skin is drawn,
    // and the other three are the whole feel of a throw.
    expect(PX).toBe(4);
    expect(GRAVITY).toBe(0.9);
    expect(THROW_CAP).toBe(22);
    expect(FLOOR_MARGIN).toBe(6);
  });

  it("keeps TAP_SLOP a real distance, because ZERO restores the whole class of bug", () => {
    // The one constant here that is NOT upstream's: it is PATCH 4's, and it is the only thing
    // standing between a press and a published act. At 0 every release is a throw, so a tap on a pet
    // that has wandered over somebody's message publishes a `play` — an edit to a real Teams
    // message. Every test that scans for `> TAP_SLOP` still passes at 0, so the VALUE is pinned here.
    expect(TAP_SLOP).toBe(10);
    // And it sits at platform convention rather than above it: Chromium's scroll touch-slop is 8 CSS
    // px, Android's `ViewConfiguration` 8 dp, iOS about 10 pt. A thumb wobbles; a mouse does not, and
    // it is the thumb this app is read with.
    expect(TAP_SLOP).toBeGreaterThanOrEqual(8);
    expect(TAP_SLOP).toBeLessThanOrEqual(12);
  });
});

describe("the frame ladder", () => {
  it("hands a walk back to the caller, because a walk is a list", () => {
    for (const skin of PET_SKINS) expect(frameFor(skin, "walk", "idle")).toBeNull();
  });

  it("draws a shipped skin's idle rows for every state, since none of them carries the four", () => {
    for (const skin of PET_SKINS) {
      const idle = skin.frames["idle"];
      for (const state of ["idle", "working", "done", "error"]) {
        expect(frameFor(skin, "still", state)).toBe(idle);
      }
    }
  });

  it("falls a shipped skin back onto its held rows, since none of them carries a fall", () => {
    for (const skin of PET_SKINS) {
      expect(frameFor(skin, "falling", "idle")).toBe(skin.frames["held"]);
      expect(frameFor(skin, "held", "idle")).toBe(skin.frames["held"]);
    }
  });

  it("prefers a skin's own slot wherever it has one", () => {
    expect(frameFor(RICH, "falling", "idle")).toBe(RICH.frames["fall"]);
    expect(frameFor(RICH, "still", "working")).toBe(RICH.frames["work"]);
    expect(frameFor(RICH, "still", "done")).toBe(RICH.frames["done"]);
    expect(frameFor(RICH, "still", "error")).toBe(RICH.frames["error"]);
    expect(frameFor(RICH, "still", "idle")).toBe(RICH.frames["idle"]);
  });

  it("reads a state it has never heard of as idle", () => {
    // A mood name from a newer build must leave a pet drawn rather than blank.
    expect(frameFor(RICH, "still", "hungry")).toBe(RICH.frames["idle"]);
    expect(frameFor(RICH, "still", "")).toBe(RICH.frames["idle"]);
  });

  it("takes the fallback for a slot written in the wrong shape", () => {
    // The copied-`walk`-block mistake: rows that are arrays draw garbage, so they read as absent.
    const bent: PetSkin = {
      ...RICH,
      frames: { ...RICH.frames, work: [["XX", "XX"]] as unknown as string[], error: [] },
    };
    expect(frameFor(bent, "still", "working")).toBe(bent.frames["idle"]);
    expect(frameFor(bent, "still", "error")).toBe(bent.frames["idle"]);
  });

  it("answers null for a skin with nothing to draw at all", () => {
    const empty: PetSkin = { ...RICH, frames: {} };
    expect(frameFor(empty, "still", "idle")).toBeNull();
    expect(frameFor(empty, "held", "idle")).toBeNull();
    expect(frameFor(empty, "falling", "idle")).toBeNull();
  });
});

describe("the floor of a box", () => {
  it("stands the sprite its own height above the bottom, less the margin", () => {
    expect(spriteFloor({ width: 800, height: 400 }, 52)).toBe(400 - FLOOR_MARGIN - 52);
  });

  it("is the SKIN's height, and the shipped ones disagree about it", () => {
    // 13x13 and 14x14: 52 px and 56 px. A constant here would squash one of the two.
    expect(petSkin("cat").size.h * PX).toBe(52);
    expect(petSkin("blue-boy").size.h * PX).toBe(56);
    const box = { width: 800, height: 400 };
    expect(spriteFloor(box, 52) - spriteFloor(box, 56)).toBe(4);
  });

  it("never puts a pet above its box, however short the box is", () => {
    expect(spriteFloor({ width: 800, height: 20 }, 52)).toBe(0);
    expect(spriteFloor({ width: 800, height: 0 }, 52)).toBe(0);
  });
});

describe("a home band", () => {
  const box = { width: 1000, height: 400 };

  it("is fractions of the box, and keeps the whole sprite inside them", () => {
    expect(bandBounds({ from: 0.2, to: 0.6 }, box, 52)).toEqual({ min: 200, max: 548 });
  });

  it("reads a band written backwards as the range it describes", () => {
    expect(bandBounds({ from: 0.6, to: 0.2 }, box, 52)).toEqual(
      bandBounds({ from: 0.2, to: 0.6 }, box, 52),
    );
  });

  it("collapses a band narrower than the sprite rather than inverting it", () => {
    const { min, max } = bandBounds({ from: 0.5, to: 0.52 }, box, 52);
    expect(max).toBe(min);
    expect(min).toBe(500);
  });

  it("never lets the sprite hang off the right of the box", () => {
    for (const width of [0, 40, 300, 1000, 4000]) {
      const { min, max } = bandBounds({ from: 0, to: 1 }, { width, height: 400 }, 52);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(Math.max(0, width - 52));
      expect(max).toBeGreaterThanOrEqual(min);
    }
  });

  it("clamps a fraction outside 0…1, and falls back on one that is not a number", () => {
    expect(bandBounds({ from: -3, to: 9 }, box, 52)).toEqual({ min: 0, max: 948 });
    expect(bandBounds({ from: Number.NaN, to: Number.NaN }, box, 52)).toEqual({
      min: 0,
      max: 948,
    });
  });
});

describe("one frame of a throw", () => {
  const still: FallBody = { x: 100, y: 100, vx: 0, vy: 0 };

  it("moves x by the speed it arrived with and y by the speed gravity just gave it", () => {
    // The order is upstream's: a y that moved by the OLD vy is a throw one frame behind itself.
    const out = fallStep({ x: 100, y: 100, vx: 10, vy: 2 }, 900);
    expect(out.x).toBe(110);
    expect(out.vy).toBe(2 + GRAVITY);
    expect(out.y).toBe(100 + 2 + GRAVITY);
  });

  it("takes friction off the horizontal speed", () => {
    expect(fallStep({ ...still, vx: 10 }, 900).vx).toBeCloseTo(9.85, 10);
  });

  it("falls straight down when it was dropped rather than thrown", () => {
    expect(fallStep(still, 900)).toEqual({ x: 100, y: 100.9, vx: 0, vy: 0.9 });
  });

  it("bounces off the left of the box, keeping half of what the air left", () => {
    const out = fallStep({ x: 10, y: 100, vx: -40, vy: 0 }, 900);
    expect(out.x).toBe(0);
    expect(out.vx).toBeCloseTo((40 * 0.985) / 2, 10);
  });

  it("bounces off the right of the box, and the right is the WHOLE box", () => {
    // A throw is allowed to leave its band — the walk is what brings the pet back into one.
    const out = fallStep({ x: 890, y: 100, vx: 40, vy: 0 }, 900);
    expect(out.x).toBe(900);
    expect(out.vx).toBeCloseTo((-40 * 0.985) / 2, 10);
  });

  it("leaves a pet inside a box narrower than itself at zero rather than off either edge", () => {
    expect(fallStep({ x: 5, y: 0, vx: 30, vy: 0 }, 0).x).toBe(0);
  });
});

describe("the rails on onThrow", () => {
  // A SOURCE SCAN, in the register `engine-file.test.ts` (which scans its own module for `Bun.`),
  // `icon-library.test.ts` (which scans the tree for a second icon package) and `update.test.ts`
  // (which scans every phase for a commit sha) already use. It is here because `onThrow` is the one
  // callback an OUTWARD action may hang on — a host publishes an act off it, an edit to a real Teams
  // message — and its guards live in `dragEnd`, which is closed over inside `createSprite` and
  // reachable only through a real `PointerEvent` on a mounted canvas. So the realistic regression is
  // not a wrong answer at runtime: it is one of these guards being DELETED or INVERTED by a later
  // refactor, which a scan catches at unit speed.
  //
  // **IT IS NOT THE WHOLE ASSERTION, and nobody should mistake it for one.** It cannot prove that a
  // browser fires `pointercancel` for a vertical flick, that a second finger's events are really
  // ignored, or that a right-click's release really leaves the pet held — those are facts about a
  // browser, and the e2e spec owns them. What it proves is that the code still says what it must.
  const source = readFileSync(new URL("./desksprite.ts", import.meta.url), "utf8");

  /**
   * One function's own CODE, with the comments stripped so no assertion can be met by prose.
   *
   * NOTE: it runs its `expect`s in the describe BODY, so a renamed or deleted function surfaces as a
   * collection error rather than as a named test failure. That is loud enough — the run fails and the
   * message says which marker is missing — and the alternative is a lazy accessor per slice for a
   * failure mode that is a rename.
   */
  function code(from: string, to: string): string {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    expect(start, `desksprite.ts still declares ${from}`).toBeGreaterThan(-1);
    expect(end, `desksprite.ts still declares ${to}`).toBeGreaterThan(start);
    return source
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }

  const dragEnd = code("function dragEnd(", "function endDrag(");
  const endDrag = code("function endDrag(", "function onPointerDown(");
  const dragMove = code("function dragMove(", "function dragEnd(");
  const onPointerDown = code("function onPointerDown(", "canvas.addEventListener(");

  it("calls each outward callback from exactly ONE place in the whole module", () => {
    // A second call site is a second set of rails to keep in step, which is how the first one was
    // lost. NOTE: these reads are over the WHOLE source rather than a comment-stripped slice, so a
    // docstring that ever writes the literal `options.onThrow` fails it — the safe direction, and the
    // message names the count.
    expect(source.match(/options\.onThrow/g)).toHaveLength(1);
    expect(source.match(/options\.onTap/g)).toHaveLength(1);
    expect(dragEnd).toContain("options.onThrow");
    expect(dragEnd).toContain("options.onTap");
  });

  it("reaches either callback only for a real pointerup, and that is the polarity", () => {
    // The whole condition, not its parts: `event.type !== "pointercancel"` would still contain both
    // halves and would publish an act for a lost release. It is `released` that carries it since
    // PATCH 4 — `threw` now also carries the distance — and BOTH names hang off it.
    expect(dragEnd).toContain('const released = event.type === "pointerup";');
    expect(dragEnd).toMatch(/const threw =\s*released &&/);
    expect(dragEnd).toMatch(/if \(threw\)\s*options\.onThrow/);
    expect(dragEnd).toMatch(/else if \(released\)\s*options\.onTap/);
  });

  it("splits a TAP from a THROW by the distance from the GRAB — PATCH 4", () => {
    // Without a threshold a press that moved nothing reached `onThrow`, so a host publishing a `play`
    // act from it edited a real Teams message for a tap aimed at whatever the creature had wandered
    // over. The distance is measured from the grab's OWN point and not from `lastX`/`lastY`, which
    // every move overwrites: a pet carried out of its box and brought back is a press by that measure.
    expect(dragEnd).toContain("Math.hypot(event.clientX - body.grabX, event.clientY - body.grabY)");
    expect(dragEnd).toMatch(/> TAP_SLOP/);
    expect(onPointerDown).toContain("body.grabX = event.clientX;");
    expect(onPointerDown).toContain("body.grabY = event.clientY;");
    // A tap keeps no momentum, so a press cannot fling the creature across its own strip.
    expect(dragEnd).toMatch(/if \(!threw\) \{[\s\S]*?body\.vx = 0;[\s\S]*?body\.vy = 0;/);
  });

  it("ends a drag only on the grabbing pointer's MAIN button", () => {
    // The whole GUARD line, `!` included: `pose !== "held" || isDragPointer(event)` reads as sensible
    // and inverts the rail, so an assertion on the bare call would pass over it.
    expect(dragEnd).toContain(
      'if (destroyed || pose !== "held" || !isDragPointer(event)) return;',
    );
    expect(dragEnd).toContain('if (event.type === "pointerup" && event.button !== 0) return;');
  });

  it("reads a press by the grabbing pointer as a LOST release", () => {
    // The stale hold: without this, the reader's next ordinary click passed every guard above and
    // published an act for an interaction that had nothing to do with the pet.
    expect(onPointerDown).toContain('doc.addEventListener("pointerdown", dragEnd, LOST_RELEASE)');
    expect(endDrag).toContain('doc.removeEventListener("pointerdown", dragEnd, LOST_RELEASE)');
    // CAPTURE, or the grab's own press cancels the grab it just made.
    expect(source).toContain("const LOST_RELEASE = { capture: true } as const;");
  });

  it("moves a pet only for the pointer that grabbed it", () => {
    // Without this a second finger teleported the pet to itself with a large velocity.
    expect(dragMove).toContain("if (!isDragPointer(event)) return;");
  });

  it("grabs only with the primary pointer's main button, and remembers which", () => {
    // The whole line again, for the reason above: `if (event.isPrimary || …)` is the inversion.
    expect(onPointerDown).toContain("if (!event.isPrimary || event.button !== 0) return;");
    expect(onPointerDown).toContain("dragPointer = event.pointerId");
  });
});
