import { describe, expect, it } from "vitest";
import {
  CHESS_SOUNDS,
  chessOutcomeSound,
  chessSoundFor,
  playChessSound,
  type ChessSoundName,
} from "./chess-sound";

describe("chessSoundFor", () => {
  it("names the sound a move earns, from what the move DID", () => {
    // chess.js's own flags: `c` a capture, `e` en passant, `k`/`q` castling, `p` a promotion.
    expect(chessSoundFor({ flags: "n" })).toBe("move");
    expect(chessSoundFor({ flags: "c", captured: "p" })).toBe("capture");
    expect(chessSoundFor({ flags: "e" })).toBe("capture");
    expect(chessSoundFor({ flags: "k" })).toBe("castle");
    expect(chessSoundFor({ flags: "q" })).toBe("castle");
    expect(chessSoundFor({ flags: "np", promotion: "q" })).toBe("promote");
  });

  it("lets CHECK win over everything else, because it is what the reader must hear", () => {
    // A capture that also checks is a check: the sharpest thing a move says is the thing to say.
    expect(chessSoundFor({ flags: "c", captured: "n", check: true })).toBe("check");
    expect(chessSoundFor({ flags: "n", check: true })).toBe("check");
  });

  it("says nothing about how a game ENDED, which is not a move", () => {
    expect(chessOutcomeSound("win")).toBe("win");
    expect(chessOutcomeSound("lose")).toBe("lose");
    expect(chessOutcomeSound("draw")).toBe("draw");
  });
});

describe("the palette", () => {
  const names: ChessSoundName[] = [
    "move",
    "capture",
    "castle",
    "check",
    "promote",
    "start",
    "win",
    "lose",
    "draw",
    "illegal",
    "premove",
    "lowTime",
  ];

  it("holds a recipe for every sound this feature can ask for", () => {
    for (const name of names) {
      const recipe = CHESS_SOUNDS[name];
      expect(recipe, name).toBeDefined();
      expect(recipe.layers.length, name).toBeGreaterThan(0);
    }
    // And nothing else: a name with no recipe would be a silent event nobody could hear was
    // missing.
    expect(Object.keys(CHESS_SOUNDS).sort()).toEqual([...names].sort());
  });

  it("is SHORT and QUIET, because a board makes a noise per move", () => {
    for (const [name, recipe] of Object.entries(CHESS_SOUNDS)) {
      for (const layer of recipe.layers) {
        // Nothing rings for a second: the commonest sound here happens every few seconds.
        expect(layer.at + layer.attack + layer.decay, `${name} runs long`).toBeLessThanOrEqual(0.6);
        // And nothing is loud enough to be the loudest thing on the machine.
        expect(layer.peak, `${name} is loud`).toBeLessThanOrEqual(0.25);
        expect(layer.peak, `${name} is silent`).toBeGreaterThan(0);
      }
    }
  });

  it("gives each sound its own SHAPE rather than one click at another volume", () => {
    // A reader should hear WHICH it was without looking at the board, so no two recipes may be
    // the same layers.
    const shapes = Object.values(CHESS_SOUNDS).map((recipe) => JSON.stringify(recipe.layers));
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe("playChessSound", () => {
  it("does nothing at all when the reader has the app's sounds off", () => {
    // The app has ONE sound switch (see lib/sounds.ts) and a board is not the exception to it.
    // Nothing to assert but the absence of a throw: there is no AudioContext here, which is the
    // other half of what this pins — the module is safe to import anywhere.
    expect(() => playChessSound("move", false)).not.toThrow();
  });

  it("does nothing where Web Audio does not exist, rather than throwing", () => {
    // Server-rendered, and a browser too old for it: the sound is a no-op and the board draws.
    expect(() => playChessSound("capture", true)).not.toThrow();
  });
});
