/**
 * The layer's PURE decisions, with no DOM and no canvas anywhere.
 *
 * Everything the overlay decides before it touches an element — which creatures fit, where each may
 * walk, how big its art is drawn, and what it is doing — is an exported function for exactly this
 * reason (see pet-layer.tsx).
 *
 * The last block SCANS THE SOURCE for the rules a fixture cannot drive, in the discipline
 * `engine-file.test.ts` and `icon-library.test.ts` already use. It catches a deletion or an inversion
 * at unit speed and it proves nothing about a browser: that a vertical flick really cancels, that the
 * arena really passes pointers through, and that a resize re-states the box rather than rebuilding the
 * sprite are facts about a mounted page, and they belong to `pet.spec.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChessGame } from "~/lib/chess-thread";
import { PET_DEFAULT_SKIN, PET_SKINS, type PetSkin } from "~/lib/pet-skin";
import type { Pet } from "~/lib/pet-thread";
import { FLOOR_MARGIN, PX } from "~/vendor/desksprite";
import { CHESS_STRIP_HEIGHT_PX } from "./chess-games-strip";
import {
  petArtFits,
  petArtFor,
  petBand,
  petSpriteBox,
  petSpriteState,
  petsDrawn,
  PET_LAYER_BOTTOM_PX,
  PET_LAYER_MAX,
  PET_LAYER_MIN_PX,
  PET_LAYER_TOP_PX,
  PET_MAX_PX,
} from "./pet-layer";

function pet(over: Partial<Pet> = {}): Pet {
  return {
    id: "7f3a1c",
    owner: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
    skin: "cat",
    birth: 1_000,
    gone: false,
    messageId: "m1",
    acts: [],
    pats: 0,
    absorbed: ["m1"],
    ...over,
  };
}

describe("petBand", () => {
  it("gives three pets a third of the width each, in order and touching", () => {
    const bands = [0, 1, 2].map((index) => petBand(index, 3));
    expect(bands).toEqual([
      { from: 0, to: 1 / 3 },
      { from: 1 / 3, to: 2 / 3 },
      { from: 2 / 3, to: 1 },
    ]);
  });

  it("gives ONE pet the whole width rather than the left third of an empty strip", () => {
    expect(petBand(0, 1)).toEqual({ from: 0, to: 1 });
  });

  it("tiles the arena exactly, so no two pets share a stretch of floor", () => {
    for (const count of [1, 2, 3]) {
      const bands = Array.from({ length: count }, (_, index) => petBand(index, count));
      expect(bands[0]!.from).toBe(0);
      expect(bands.at(-1)!.to).toBe(1);
      for (let i = 1; i < bands.length; i += 1) expect(bands[i]!.from).toBe(bands[i - 1]!.to);
    }
  });

  it("answers a lane for a count of zero rather than dividing by it", () => {
    expect(petBand(0, 0)).toEqual({ from: 0, to: 1 });
  });

  it("clamps an index outside the count into the last lane", () => {
    expect(petBand(9, 2)).toEqual(petBand(1, 2));
    expect(petBand(-1, 2)).toEqual(petBand(0, 2));
  });
});

describe("petsDrawn", () => {
  it("leaves a pet that has GONE out — its record stays, its creature does not", () => {
    const here = pet({ id: "aaaaaa" });
    const gone = pet({ id: "bbbbbb", gone: true });
    expect(petsDrawn([here, gone])).toEqual({ drawn: [here], hidden: 0 });
  });

  it("draws at most PET_LAYER_MAX and COUNTS the rest", () => {
    const pets = ["a", "b", "c", "d", "e"].map((id) => pet({ id: id.repeat(6) }));
    const { drawn, hidden } = petsDrawn(pets);
    expect(drawn).toHaveLength(PET_LAYER_MAX);
    expect(drawn).toEqual(pets.slice(0, PET_LAYER_MAX));
    expect(hidden).toBe(pets.length - PET_LAYER_MAX);
  });

  it("counts nothing hidden when a pet over the bound has gone home", () => {
    const pets = [pet({ id: "aaaaaa" }), pet({ id: "bbbbbb" }), pet({ id: "cccccc" }), pet({ id: "dddddd", gone: true })];
    expect(petsDrawn(pets).hidden).toBe(0);
  });

  it("NEVER leaves the reader's OWN pet out — this menu is the only way to reach one", () => {
    const others = ["a", "b", "c", "d"].map((id) => pet({ id: id.repeat(6) }));
    const mine = pet({ id: "efefef", owner: { mri: "8:orgid:me", name: "Me", isSelf: true } });
    const { drawn, hidden } = petsDrawn([...others, mine]);
    expect(drawn).toContain(mine);
    expect(drawn).toHaveLength(PET_LAYER_MAX);
    expect(hidden).toBe(5 - PET_LAYER_MAX);
    // Ours is lifted to the front and the rest keep their own order, so exactly one lane moves.
    expect(drawn).toEqual([mine, others[0], others[1]]);
  });

  it("re-orders NOTHING while ours already fits", () => {
    const mine = pet({ id: "efefef", owner: { mri: "8:orgid:me", name: "Me", isSelf: true } });
    const here = [pet({ id: "aaaaaa" }), mine, pet({ id: "cccccc" })];
    expect(petsDrawn(here).drawn).toEqual(here);
  });
});

describe("the arena's own bounds", () => {
  it("clears the chess strip by the strip's OWN measurement, not by its chip's", () => {
    // 44 is the chip; the strip is the chip plus its container's padding. Restated wrong, the arena
    // began inside a live strip and painted its own count label over the strip's.
    expect(PET_LAYER_TOP_PX).toBe(CHESS_STRIP_HEIGHT_PX);
    expect(PET_LAYER_TOP_PX).toBeGreaterThan(44);
  });

  it("refuses to draw in a box with no room for a creature, its floor and its trigger", () => {
    expect(PET_LAYER_MIN_PX).toBeGreaterThan(PET_MAX_PX + FLOOR_MARGIN);
    // The two insets alone can take the whole of a short viewport, which is what the guard is for.
    expect(PET_LAYER_TOP_PX + PET_LAYER_BOTTOM_PX).toBeGreaterThan(PET_LAYER_MIN_PX);
  });
});

describe("petSpriteBox and the cap", () => {
  it("reads a skin's OWN size rather than a constant — and the shipped ones disagree", () => {
    const sizes = PET_SKINS.map((skin) => petSpriteBox(skin));
    // `cat` and `duck` are 13x13 and `blue-boy` 14x14, which is the whole reason nothing here
    // spells 52 as a number: a constant would squash one of the three.
    expect(new Set(sizes.map((box) => box.w)).size).toBeGreaterThan(1);
    for (const [index, box] of sizes.entries()) {
      expect(box.w).toBe(PET_SKINS[index]!.size.w * PX);
      expect(box.h).toBe(PET_SKINS[index]!.size.h * PX);
    }
  });

  it("admits every skin this build ships", () => {
    for (const skin of PET_SKINS) expect(petArtFits(skin)).toBe(true);
  });

  it("refuses art that would draw bigger than PET_MAX_PX on either side", () => {
    const wide = { size: { w: PET_MAX_PX / PX + 1, h: 4 } } as PetSkin;
    const tall = { size: { w: 4, h: PET_MAX_PX / PX + 1 } } as PetSkin;
    expect(petArtFits(wide)).toBe(false);
    expect(petArtFits(tall)).toBe(false);
  });

  it("draws a name this build does not hold in the default art rather than nothing at all", () => {
    expect(petArtFor("a-skin-from-a-newer-build").name).toBe(PET_DEFAULT_SKIN);
  });

  it("draws each shipped skin in its own art", () => {
    for (const skin of PET_SKINS) expect(petArtFor(skin.name)).toBe(skin);
  });
});

describe("petSpriteState", () => {
  const mine = pet({ owner: { mri: "8:orgid:me", name: "Me", isSelf: true } });

  it("is idle with nothing going on", () => {
    expect(petSpriteState({ pet: mine, agentRun: null, games: [] })).toBe("idle");
  });

  it("works, finishes and fails with the reader's OWN agent run", () => {
    expect(petSpriteState({ pet: mine, agentRun: { phase: "thinking" }, games: [] })).toBe("working");
    expect(petSpriteState({ pet: mine, agentRun: { phase: "done" }, games: [] })).toBe("done");
    expect(petSpriteState({ pet: mine, agentRun: { phase: "error" }, games: [] })).toBe("error");
  });

  it("leaves a COLLEAGUE's pet out of our own agent run — this page holds no run of theirs", () => {
    expect(petSpriteState({ pet: pet(), agentRun: { phase: "thinking" }, games: [] })).toBe("idle");
  });

  it("works while a live game waits for the owner, and not once it is somebody else's turn", () => {
    const games = [game({ turn: "w" })];
    expect(petSpriteState({ pet: pet(), agentRun: null, games })).toBe("working");
    expect(petSpriteState({ pet: pet(), agentRun: null, games: [game({ turn: "b" })] })).toBe("idle");
  });

  it("ignores a game nobody has joined and one that is over", () => {
    expect(petSpriteState({ pet: pet(), agentRun: null, games: [game({ opponent: null })] })).toBe("idle");
    expect(
      petSpriteState({
        pet: pet(),
        agentRun: null,
        games: [game({ outcome: { kind: "resigned", by: "b" } })],
      }),
    ).toBe("idle");
  });

  it("waits for nobody on an EMPTY mri — an authorless record is not a person to be on the clock", () => {
    const nameless = pet({ owner: { mri: "", name: "", isSelf: false } });
    const games = [game({ turn: "w", challengerMri: "" })];
    expect(petSpriteState({ pet: nameless, agentRun: null, games })).toBe("idle");
  });
});

/** A game shaped only as far as `petSpriteState` reads it: who is to move, whether anybody joined,
 *  and whether it is over. Cast rather than built in full — a whole `ChessGame` here would be a
 *  fixture about chess in a test about pets. */
function game(over: {
  turn?: "w" | "b";
  opponent?: unknown;
  outcome?: unknown;
  challengerMri?: string;
}): ChessGame {
  const mri = over.challengerMri ?? "8:orgid:ada";
  return {
    turn: over.turn ?? "w",
    challengerColor: "w",
    challenger: { mri, name: "Ada", isSelf: false },
    opponent: "opponent" in over ? over.opponent : { mri: "8:orgid:me", name: "Me", isSelf: true },
    outcome: over.outcome ?? { kind: "playing" },
  } as unknown as ChessGame;
}

/**
 * FIVE RULES A READER COULD DELETE AND NO OTHER TEST WOULD NOTICE.
 *
 * Each is a RULING rather than a behaviour a fixture can drive — the geometry needs a browser, the
 * gestures need a real `PointerEvent` on a mounted canvas, and the outward writes need a mock — so
 * they are pinned the way `engine-file.test.ts`, `icon-library.test.ts` and `update.test.ts` already
 * pin theirs: by scanning the source. What this catches is a deletion, an inversion and a re-key at
 * unit speed; what it CANNOT do is prove the browser behaves, which is `pet.spec.ts`'s half and is
 * named in each assertion below so nobody mistakes one for the other.
 */
describe("the layer's rulings, scanned", () => {
  const HERE = new URL(".", import.meta.url).pathname;
  const read = (name: string) => readFileSync(join(HERE, name), "utf8");
  /** Comments stripped, because every one of these rules is ARGUED in prose right beside itself and
   *  a scan that read the argument would pass on the sentence describing the bug.
   *
   *  The line-comment regex MIRRORS `src/vendor/desksprite.test.ts`'s own `code()` — `/\/\/.*$/gm`,
   *  unanchored — and that is the whole point of it: this file used `/^\s*\/\/.*$/gm`, which strips a
   *  comment on a line of its OWN and leaves a TRAILING one. Measured: deleting the remove row's
   *  `disabled={busy}` and quoting it in a trailing comment inside that row passed all 31. A weaker
   *  third spelling of a strip is how a closed defect re-opens, so if these two ever disagree again the
   *  stronger one is the answer. Whole-line stripping cannot join two lines either way — the regex
   *  leaves the newline. */
  const code = (name: string) =>
    read(name)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  const layer = code("pet-layer.tsx");
  const menu = code("pet-menu.tsx");
  const engine = code("../vendor/desksprite.ts");

  it("never clips the arena, which would take back the squash's own 1.35x", () => {
    // ONE SPELLING IS NOT THE RULE, and this asserted one. Measured: `+ overflow-clip` and
    // `+ overflow-x-hidden` on the arena's own className each passed all 31 tests — and
    // horizontal is exactly the axis the rule is about, since the squash puts a sprite some nine
    // pixels past EACH SIDE of its box. `overflow-x-hidden` is a class this repo already uses
    // elsewhere, so it is the likely accident rather than an exotic one. The match covers every
    // Tailwind spelling and an inline `style={{ overflow: "hidden" }}` with it; neither file holds
    // a legitimate `overflow` outside the comments `code()` has already stripped.
    expect(layer).not.toMatch(/overflow[-:]/);
    expect(menu).not.toMatch(/overflow[-:]/);
  });

  it("passes NO `onGrab` to the engine at all — a scroll that starts on a pet fires it", () => {
    expect(layer).not.toContain("onGrab");
    // And the engine still offers one, so this is a decision here rather than an absence upstream.
    expect(engine).toContain("onGrab");
  });

  it("hangs the two outward gestures on the two RAILED callbacks", () => {
    expect(layer).toContain("onTap: () => tapRef.current()");
    expect(layer).toContain("onThrow: () => throwRef.current()");
  });

  it("splits a TAP from a THROW by DISTANCE, so a press cannot publish a fling's act", () => {
    // The whole of finding 1: without a threshold, `pointerdown` + `pointerup` with no movement
    // reached `onThrow` and published a `play` act — an edit to a real Teams message — for a press
    // aimed at whatever the creature had wandered over. A behavioural proof needs a browser and is
    // `pet.spec.ts`'s; this pins that the comparison exists, is a distance, and decides both names.
    expect(engine).toContain("Math.hypot(event.clientX - body.grabX, event.clientY - body.grabY)");
    expect(engine).toMatch(/> TAP_SLOP/);
    expect(engine).toContain("if (threw) options.onThrow?.();");
    expect(engine).toContain("else if (released) options.onTap?.();");
    // The grab point is captured where the grab happens, and it is not `lastX`, which every move
    // overwrites — a pet carried out and back would otherwise measure as a press.
    expect(engine).toContain("body.grabX = event.clientX;");
  });

  it("gates every publishing control on the pending ENTRY, never on its act", () => {
    // `?.act` is null for a despawn, a skin and a spawn — exactly the presses with no optimistic
    // draw — so a check written that way would leave a dead control with no sentence and no cue.
    // THE TERMINATOR IS PART OF THE ASSERTION. Without the `;` this was a PREFIX check, satisfied by
    // `const busy = pending !== undefined && pending.act !== null;` — which is byte for byte the defect
    // the next line's own comment describes, and passed all 31 (measured). The `pending?.act` guard
    // misses that spelling because it carries no `?.`.
    // The bare `pending.act` is NOT asserted absent: the optimistic draw legitimately reads it
    // (`pending?.pet === pet.id && pending.act ? …`), so that guard would fail the real component.
    expect(menu).toContain("const busy = pending !== undefined;");
    expect(menu).not.toContain("pending?.act");
    // EACH ROW'S WINDOW ENDS AT THE NEXT ROW, never at a character count. A 400-character window
    // from `pet-feed` reached `pet-play`'s own `disabled={busy}`, so deleting the feed row's guard
    // left every test in this file green (measured) — the same neighbour-satisfies-the-window
    // defect that hid `publishPetLedger`'s error write behind `patPet`'s identical line. A window
    // must be bounded by a marker the text inside it cannot itself contain, and one element's JSX
    // carries exactly one `data-testid=`.
    //
    // AND WHAT IS ASSERTED IS THE DISABLING SPELLING, never the word `busy`. A bounded window is
    // still not one element's JSX — `pet-remove`'s spans 22 lines including its own handler — so
    // `toContain("busy")` was met by any mention of it: deleting `disabled={busy}` and writing
    // `if (busy) return;` inside `onSelect` passed all 31 (measured), and so did swapping the feed
    // row for `onSelect={busy ? undefined : act(...)}`. Both are the exact defect the rule exists to
    // prevent — a row drawn live, pressed, and inert, with no sentence and no cue, on the two acts
    // (despawn, skin) that have no optimistic draw to mask it.
    //
    // AND EACH GATE CARRIES A LEADING SPACE, which is what makes it the `disabled` PROP rather than a
    // word ending in it. `aria-disabled={busy}` contains `disabled={busy}` by substring, and switching
    // all five rows to it passed all 31 with `tsc` clean (measured) — a shippable edit that leaves
    // every row LIVE, because Radix reads only the `disabled` prop and `dropdown-menu.tsx` styles
    // `data-[disabled]`, which Radix sets from that prop alone. So `onSelect` fires, the second press
    // is swallowed by `publishPetLedger`'s own in-flight guard, and there is no `petError`, no cue and
    // no status: pressed, and inert, with no sentence. Do not simplify the space away.
    const rows: [string, string][] = [
      ['data-testid="pet-feed"', " disabled={busy}"],
      ['data-testid="pet-play"', " disabled={busy}"],
      ['data-testid="pet-nap"', " disabled={busy}"],
      // The skin rows name themselves with a template literal, so the marker is its prefix — and
      // they were outside the old loop entirely, which left three more publishing rows unpinned.
      // A skin composes a second condition, so the prefix is what is asserted.
      ["data-testid={`pet-skin-", " disabled={busy ||"],
      ['data-testid="pet-remove"', " disabled={busy}"],
    ];
    for (const [row, gate] of rows) {
      const at = menu.indexOf(row);
      expect(at, row).toBeGreaterThan(-1);
      const next = menu.indexOf("data-testid=", at + row.length);
      expect(menu.slice(at, next === -1 ? undefined : next), row).toContain(gate);
    }
    // And the GESTURE takes the same answer, because a throw contends on the same one message.
    expect(layer).toContain("if (props.pending) return;");
  });

  it("draws no Feed, Play or Nap for a reader with no RECORD — not a disabled one", () => {
    expect(menu).toContain("hasOwnPet ? (");
    // A RECORD, `gone` or not — and the `&& !it.gone` that used to be here is the bug, not the rule.
    // A departed owner may still feed a friend's creature (the record stays after a despawn precisely
    // so its acts still count), and `petPublishFor` asks for `mine` and never for `!mine.gone` on those
    // three presses. So this menu hid the rows and told them "Feeding and playing take a companion of
    // your own" — false — while the THROW gesture in the same lane published the very act it hid.
    expect(menu).toContain("props.pets.some((it) => it.owner.isSelf)");
    expect(menu).not.toContain("it.owner.isSelf && !it.gone");
  });

  it("re-states a lane instead of REBUILDING the creature in it", () => {
    // The create effect was keyed on the band once, so a fourth person spawning re-cut every lane,
    // destroyed every sprite and built each one back at `bounds.min` — three pets snapping to the
    // left edge of their new lanes, at the engine's own `idle`, and speaking as their state was
    // re-stated. The engine's `setBand` is the root fix; this pins that the layer really uses it and
    // that the rebuild is keyed on the ART alone. That a pet WALKS into its new lane needs a browser,
    // and `pet.spec.ts` owns it.
    expect(layer).toContain("handleRef.current?.setBand(props.band)");
    expect(layer).toMatch(/\}, \[art\]\);/);
    expect(engine).toContain("setBand(next: SpriteBand)");
  });

  it("gates the layer on real pet DATA, never on the route", () => {
    // `petsShown` reads `true` on the first committed render whatever the reader chose, so a layer
    // that keyed on the route would draw a pet for one frame to somebody who turned it off.
    expect(layer).toContain("if (!shown || reduce) return null;");
    expect(layer).toContain("if (drawn.length === 0) return null;");
  });
});
