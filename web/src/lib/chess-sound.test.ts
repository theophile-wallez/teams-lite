import { describe, expect, it } from "vitest";
import {
  CHESS_SOUNDS,
  CHESS_SOUND_FILE,
  chessOutcomeSound,
  chessSoundFileNames,
  chessSoundFor,
  chessSoundUrl,
  playChessSound,
  primeChessSounds,
  type ChessSoundName,
} from "./chess-sound";

const names: ChessSoundName[] = [
  "move",
  "moveOpponent",
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
  "notify",
];

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

  it("tells the reader's own move from the OPPONENT's, and only for a plain move", () => {
    // The one split chess.com makes, and the one worth having: it says a move ARRIVED without the
    // reader looking at the board.
    expect(chessSoundFor({ flags: "n", mine: true })).toBe("move");
    expect(chessSoundFor({ flags: "n", mine: false })).toBe("moveOpponent");
    // Everything else is the same sound whoever did it — chess.com's own arrangement: a capture is a
    // capture, and a check is the thing to hear whoever delivered it.
    expect(chessSoundFor({ flags: "c", mine: false })).toBe("capture");
    expect(chessSoundFor({ flags: "k", mine: false })).toBe("castle");
    expect(chessSoundFor({ flags: "np", promotion: "q", mine: false })).toBe("promote");
    expect(chessSoundFor({ flags: "n", check: true, mine: false })).toBe("check");
  });

  it("treats an unstated side as the reader's own, because a WATCHER has no opponent", () => {
    // A board somebody is only watching would otherwise draw every move as "the opponent's".
    expect(chessSoundFor({ flags: "n" })).toBe("move");
    expect(chessSoundFor({ flags: "n", mine: undefined })).toBe("move");
  });

  it("says nothing about how a game ENDED, which is not a move", () => {
    expect(chessOutcomeSound("win")).toBe("win");
    expect(chessOutcomeSound("lose")).toBe("lose");
    expect(chessOutcomeSound("draw")).toBe("draw");
  });
});

describe("the recordings", () => {
  it("names one of chess.com's files for every sound, and nothing but those files", () => {
    for (const name of names) {
      const file = CHESS_SOUND_FILE[name];
      expect(file, name).toBeTruthy();
      // A stem, never a path and never a URL: the address is built from the route the BACKEND named.
      expect(file, name).toMatch(/^[a-z-]+$/);
    }
    expect(Object.keys(CHESS_SOUND_FILE).sort()).toEqual([...names].sort());
  });

  it("resolves WIN, LOSE and DRAW to one file, because chess.com has one ending sound", () => {
    // A stated trade rather than an oversight: the three names stay because the synthesized fallback
    // still tells them apart, and the result is on screen the moment a game finishes.
    expect(CHESS_SOUND_FILE.win).toBe("game-end");
    expect(CHESS_SOUND_FILE.lose).toBe("game-end");
    expect(CHESS_SOUND_FILE.draw).toBe("game-end");
  });

  it("needs exactly the twelve files this build pins", () => {
    // `chess_sound::SOUND_FILES` is the other side of this, and a Rust test scans this file for each
    // name. Twelve recordings over fourteen names is the whole of the arithmetic.
    expect(chessSoundFileNames()).toHaveLength(12);
    expect(new Set(chessSoundFileNames()).size).toBe(12);
  });

  it("builds an address only from a route this app serves", () => {
    const route = "/__chess-sound/chesscom-default-94997488/";
    expect(chessSoundUrl(route, "capture")).toBe(`${route}capture.mp3`);
    expect(chessSoundUrl(route, "win")).toBe(`${route}game-end.mp3`);
    // The BACKEND names the route, so this is a guard rather than a parse — the rule
    // `chessEngineWorkerUrl` holds for the Worker's own path.
    for (const bad of [
      "https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/",
      "/__chess-sound/../secrets/",
      "/__chess-sound//x/",
      "/sounds/",
      "/__chess-sound/v1",
      "",
    ]) {
      expect(chessSoundUrl(bad, "move"), bad).toBeNull();
    }
  });
});

describe("the synthesized fallback", () => {
  it("holds a recipe for every sound this feature can ask for", () => {
    // It is what plays until the recordings are on this machine — and for ever on one that cannot
    // reach them — so a missing recipe is a board that goes silent rather than a board that sounds
    // less good.
    for (const name of names) {
      const recipe = CHESS_SOUNDS[name];
      expect(recipe, name).toBeDefined();
      expect(recipe.layers.length, name).toBeGreaterThan(0);
    }
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
    // the same layers — the opponent's move included, which is the whole point of that name.
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
    expect(() => playChessSound("moveOpponent", true)).not.toThrow();
  });

  it("fetches nothing where there is no browser to fetch with", () => {
    // `primeChessSounds` is called from an effect, and this module is imported by code that is
    // server-rendered: it must be inert rather than throwing on a missing window.
    expect(() => primeChessSounds("/__chess-sound/chesscom-default-94997488/")).not.toThrow();
  });
});
