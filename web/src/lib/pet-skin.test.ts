import { describe, expect, it } from "vitest";
import { PET_DEFAULT_SKIN, PET_SKINS, petSkin, validatePetSkin, type PetSkin } from "./pet-skin";
import { parsePetLedger } from "./pet-wire";

/** The smallest thing that is a skin: two frames and a two-frame walk, all 2x2. */
function skin(over: Partial<PetSkin> = {}): PetSkin {
  return {
    name: "test",
    label: "Test",
    palette: { ".": null, X: "#000000" },
    size: { w: 2, h: 2 },
    anchor: { x: 1, y: 2 },
    frames: {
      idle: ["XX", "X."],
      held: ["XX", ".X"],
      walk: [
        ["XX", "X."],
        ["XX", ".X"],
      ],
    },
    ...over,
  };
}

describe("the bundled art", () => {
  it("is valid, every skin of it", () => {
    for (const art of PET_SKINS) {
      expect(validatePetSkin(art), `${art.name} is not a valid skin`).toBeNull();
    }
  });

  it("names a default that is really in the set", () => {
    expect(PET_SKINS.map((art) => art.name)).toContain(PET_DEFAULT_SKIN);
  });

  it("draws every frame at exactly the size it declares", () => {
    // The validator refuses a frame OVER the box; this asserts the shipped art fills it, because a
    // skin whose art is smaller than its own size draws a creature adrift in an oversized canvas.
    for (const art of PET_SKINS) {
      for (const value of Object.values(art.frames)) {
        const frames = Array.isArray(value[0]) ? (value as string[][]) : [value as string[]];
        for (const frame of frames) {
          expect(frame.length, `${art.name} is not ${art.size.h} rows tall`).toBe(art.size.h);
          for (const row of frame) {
            expect(row.length, `${art.name} has a row that is not ${art.size.w} wide`).toBe(
              art.size.w,
            );
          }
        }
      }
    }
  });

  it("carries no fall, work, done or error, so the engine's fallback ladder is the normal path", () => {
    // The four ladder slots by name, rather than the whole key set: a skin that later gains a `work`
    // frame is legal, and must not fail a test about the ladder being the path nothing avoids.
    for (const art of PET_SKINS) {
      for (const slot of ["fall", "work", "done", "error"]) {
        expect(Object.keys(art.frames), `${art.name} carries ${slot}`).not.toContain(slot);
      }
    }
  });

  it("holds a skin with no traits at all, so an engine default is exercised too", () => {
    expect(PET_SKINS.some((art) => art.traits === undefined)).toBe(true);
    expect(PET_SKINS.some((art) => art.traits?.messages !== undefined)).toBe(true);
  });

  it("keeps every message a pet says short enough to read over its head", () => {
    for (const art of PET_SKINS) {
      for (const [state, said] of Object.entries(art.traits?.messages ?? {})) {
        expect(said.length, `${art.name} says too much about ${state}`).toBeLessThan(40);
      }
    }
  });

  it("credits the art it did not draw", () => {
    for (const art of PET_SKINS) {
      expect(art.author, `${art.name} credits nobody`).toBeTruthy();
    }
    expect(petSkin("cat").author).toContain("welltilln");
    expect(petSkin("blue-boy").author).toContain("welltilln");
  });
});

describe("a name is the key the wire carries", () => {
  it("survives a ledger, for every skin in the set", () => {
    for (const art of PET_SKINS) {
      expect(parsePetLedger("7f3a1c", `v1 s.${art.name}`)?.skin).toBe(art.name);
    }
  });

  it("is refused here in exactly the shapes the wire drops", () => {
    // `validatePetSkin` tests `PET_SKIN` itself, so the two cannot disagree by construction; this
    // drives the real parse anyway, because the agreement that matters is with a ledger and not with
    // a regex.
    for (const name of ["Cat", "-cat", "cat.2", "a".repeat(25), ""]) {
      expect(validatePetSkin(skin({ name }))).not.toBeNull();
      expect(parsePetLedger("7f3a1c", `v1 s.${name}`)?.skin).toBe("");
    }
  });
});

describe("petSkin", () => {
  it("answers the art a name asks for", () => {
    expect(petSkin("duck").name).toBe("duck");
  });

  it("falls back to the default rather than throwing, for a name no build here holds", () => {
    expect(petSkin("unicorn-from-a-newer-build")).toBe(petSkin(PET_DEFAULT_SKIN));
    expect(petSkin("").name).toBe(PET_DEFAULT_SKIN);
  });
});

describe("validatePetSkin", () => {
  it("passes the smallest thing that is a skin", () => {
    expect(validatePetSkin(skin())).toBeNull();
  });

  it("refuses a name outside the wire's own charset", () => {
    expect(validatePetSkin(skin({ name: "Blue Boy" }))).toContain("a name must match");
  });

  it("refuses a palette that does not map \".\" to null", () => {
    expect(validatePetSkin(skin({ palette: { X: "#000000" } }))).toContain('must map "." to null');
    expect(validatePetSkin(skin({ palette: { ".": "#ffffff", X: "#000000" } }))).toContain(
      'must map "." to null',
    );
  });

  it("refuses a missing required slot, and names which one", () => {
    for (const slot of ["idle", "held", "walk"]) {
      const frames = { ...skin().frames };
      delete frames[slot];
      expect(validatePetSkin(skin({ frames }))).toBe(`test carries no ${slot} frame`);
    }
  });

  it("refuses a walk that is one frame rather than a list of them", () => {
    const frames = { ...skin().frames, walk: ["XX", "X."] };
    expect(validatePetSkin(skin({ frames }))).toContain("walk must be a list of frames");
  });

  it("refuses a walk that is a list of no frames at all", () => {
    expect(validatePetSkin(skin({ frames: { ...skin().frames, walk: [] } }))).toBe(
      "test's walk holds no frame",
    );
  });

  it("refuses any OTHER slot that is a list of frames, which is a copied walk block", () => {
    const one = [["XX", "X."]];
    expect(validatePetSkin(skin({ frames: { ...skin().frames, idle: one } }))).toBe(
      "test's idle must be rows of text",
    );
    expect(validatePetSkin(skin({ frames: { ...skin().frames, error: one } }))).toBe(
      "test's error must be rows of text",
    );
  });

  it("refuses a character the palette does not hold, and names it", () => {
    // The mistake the eye cannot see: the engine draws an unmapped character TRANSPARENT, so a `X`
    // typed as an `I` is a hole in the creature rather than an error anybody hears about.
    const frames = { ...skin().frames, idle: ["XI", "Xq"] };
    expect(validatePetSkin(skin({ frames }))).toBe(
      'test\'s idle draws "I", "q", which its palette does not hold',
    );
  });

  it("takes a SPACE for transparent, so a padded row is not a hole", () => {
    const frames = { idle: ["X ", " X"], held: ["  ", "XX"], walk: [["X ", "XX"]] };
    expect(validatePetSkin(skin({ frames }))).toBeNull();
  });

  it("refuses a frame WIDER than the size it declares", () => {
    const frames = { ...skin().frames, idle: ["XXX", "XXX"] };
    expect(validatePetSkin(skin({ frames }))).toContain("is 3 wide, over the 2");
  });

  it("refuses a frame TALLER than the size it declares", () => {
    const frames = { ...skin().frames, idle: ["XX", "XX", "XX"] };
    expect(validatePetSkin(skin({ frames }))).toContain("is 3 rows tall, over the 2");
  });

  it("refuses rows of unequal length, which is the mistake hand-authored art really makes", () => {
    const frames = { ...skin().frames, held: ["XX", "X"] };
    expect(validatePetSkin(skin({ frames }))).toBe(
      "test's held row 1 is 1 characters where row 0 is 2",
    );
  });

  it("reads an OPTIONAL slot by the same rules", () => {
    const frames = { ...skin().frames, work: ["XX", "X"] };
    expect(validatePetSkin(skin({ frames }))).toContain("work row 1");
  });

  it("names which walk frame is at fault", () => {
    const frames = { ...skin().frames, walk: [["XX", "XX"], ["XX", "X"]] };
    expect(validatePetSkin(skin({ frames }))).toContain("walk[1] row 1");
  });

  it("names the rest of what a skin cannot be", () => {
    expect(validatePetSkin(skin({ palette: undefined as never }))).toBe("test carries no palette");
    expect(validatePetSkin(skin({ size: { w: 0, h: 2 } }))).toBe("test needs a size in whole pixels");
    expect(validatePetSkin(skin({ frames: undefined as never }))).toBe("test carries no frames");
    expect(validatePetSkin(skin({ frames: { ...skin().frames, held: [] } }))).toBe(
      "test's held holds no rows",
    );
    expect(validatePetSkin(skin({ frames: { ...skin().frames, idle: "XX" as never } }))).toBe(
      "test's idle must be rows of text",
    );
  });

  it("answers a sentence rather than throwing, whatever it is handed", () => {
    for (const junk of [null, undefined, 42, "cat", [], { name: "cat" }]) {
      expect(validatePetSkin(junk)).toBeTypeOf("string");
    }
  });
});
