import { describe, expect, it } from "vitest";
import {
  CHESS_ENGINE_DEFAULT_ELO,
  CHESS_ENGINE_HASH_MB,
  CHESS_ENGINE_MAX_ELO,
  CHESS_ENGINE_MIN_ELO,
  CHESS_ENGINE_STRENGTHS,
  chessEngineGo,
  chessEngineRowLabel,
  chessEngineSetup,
  chessEngineStrengthFor,
  chessEngineWorkerUrl,
  megabytes,
  NO_CHESS_ENGINE,
  parseBestMove,
} from "./chess-engine";

const OPENING = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("the strengths offered", () => {
  it("stays inside the engine's OWN range, whose floor is 1320", () => {
    // Measured off the binary: `option name UCI_Elo type spin default 1320 min 1320 max 3190`.
    for (const rung of CHESS_ENGINE_STRENGTHS) {
      expect(rung.elo).toBeGreaterThanOrEqual(CHESS_ENGINE_MIN_ELO);
      expect(rung.elo).toBeLessThanOrEqual(CHESS_ENGINE_MAX_ELO);
      // A search a reader waits for is a search that has to end: even the top rung is barely a
      // second, because a board that pauses for five is a board that feels broken.
      expect(rung.movetimeMs).toBeGreaterThan(0);
      expect(rung.movetimeMs).toBeLessThanOrEqual(2_000);
    }
    // The ends are NAMED, because a bare number says nothing about what it is the end of.
    expect(CHESS_ENGINE_STRENGTHS[0]?.note).toMatch(/floor/);
    expect(CHESS_ENGINE_STRENGTHS.at(-1)?.note).toMatch(/full/);
    expect(CHESS_ENGINE_STRENGTHS.at(-1)?.elo).toBe(CHESS_ENGINE_MAX_ELO);
    // Ascending, and no two the same: a picker of seven presses where two play alike is six.
    const elos = CHESS_ENGINE_STRENGTHS.map((r) => r.elo);
    expect([...elos].sort((a, b) => a - b)).toEqual(elos);
    expect(new Set(elos).size).toBe(elos.length);
  });

  it("opens on a strength somebody can beat", () => {
    expect(CHESS_ENGINE_DEFAULT_ELO).toBeGreaterThanOrEqual(CHESS_ENGINE_MIN_ELO);
    expect(CHESS_ENGINE_DEFAULT_ELO).toBeLessThan(CHESS_ENGINE_MAX_ELO);
    expect(CHESS_ENGINE_STRENGTHS.some((r) => r.elo === CHESS_ENGINE_DEFAULT_ELO)).toBe(true);
  });

  it("CLAMPS a strength from outside the range rather than refusing to play", () => {
    // A game opened by another build, or a number nobody offers: the game is real either way, and a
    // board that would not move would strand it.
    expect(chessEngineStrengthFor(50).elo).toBe(CHESS_ENGINE_MIN_ELO);
    expect(chessEngineStrengthFor(9_000).elo).toBe(CHESS_ENGINE_MAX_ELO);
    // And a strength BETWEEN two rungs is played at the number the game states, with the nearer
    // rung's own search time.
    const between = chessEngineStrengthFor(1750);
    expect(between.elo).toBe(1750);
    expect(between.movetimeMs).toBe(
      CHESS_ENGINE_STRENGTHS.find((r) => r.elo === 1800)?.movetimeMs,
    );
  });
});

describe("chessEngineSetup", () => {
  it("asks for the Elo it was given, and says the strength is LIMITED", () => {
    const lines = chessEngineSetup(1500);
    expect(lines).toContain("uci");
    expect(lines).toContain("setoption name UCI_LimitStrength value true");
    expect(lines).toContain("setoption name UCI_Elo value 1500");
    expect(lines).toContain(`setoption name Hash value ${CHESS_ENGINE_HASH_MB}`);
    expect(lines.at(-1)).toBe("isready");
    // `UCI_Elo` means nothing without the flag, so the flag comes with it — in that order.
    expect(lines.indexOf("setoption name UCI_LimitStrength value true")).toBeLessThan(
      lines.indexOf("setoption name UCI_Elo value 1500"),
    );
  });

  it("takes the CAP OFF at full strength, rather than capping at the maximum", () => {
    const lines = chessEngineSetup(CHESS_ENGINE_MAX_ELO);
    expect(lines).toContain("setoption name UCI_LimitStrength value false");
    expect(lines.some((line) => line.includes("UCI_Elo"))).toBe(false);
  });

  it("keeps the hash small, because this runs on a phone too", () => {
    expect(CHESS_ENGINE_HASH_MB).toBeLessThanOrEqual(32);
  });
});

describe("chessEngineGo", () => {
  it("asks about a POSITION rather than a move list", () => {
    // A FEN is one line whatever the game's length, and it cannot disagree with the board the
    // reader is looking at — `startpos moves …` would be a second spelling of the move list.
    expect(chessEngineGo(OPENING, 1800)).toEqual([
      `position fen ${OPENING}`,
      "go movetime 250",
    ]);
  });
});

describe("parseBestMove", () => {
  it("reads the move, and its promotion", () => {
    expect(parseBestMove("bestmove e2e4")).toEqual({ from: "e2", to: "e4" });
    expect(parseBestMove("bestmove e2e4 ponder e7e5")).toEqual({ from: "e2", to: "e4" });
    expect(parseBestMove("bestmove e7e8q")).toEqual({ from: "e7", to: "e8", promotion: "q" });
    expect(parseBestMove("  bestmove a1h8n  ")).toEqual({ from: "a1", to: "h8", promotion: "n" });
  });

  it("is null for everything else the engine prints", () => {
    // A mated position answers `(none)`: there is no move to play, and the board's own rules have
    // already ended the game.
    expect(parseBestMove("bestmove (none)")).toBeNull();
    expect(parseBestMove("info depth 12 score cp 31")).toBeNull();
    expect(parseBestMove("readyok")).toBeNull();
    expect(parseBestMove("")).toBeNull();
    expect(parseBestMove("bestmove z9z9")).toBeNull();
  });
});

describe("chessEngineWorkerUrl", () => {
  it("takes the path the BACKEND named, and nothing else", () => {
    // A Worker is CODE: a page that accepted any string would run whatever a backend answered.
    expect(chessEngineWorkerUrl("/__engine/18.0.0-lite-single-a8fbc05e/stockfish-18-lite-single.js"))
      .toBe("/__engine/18.0.0-lite-single-a8fbc05e/stockfish-18-lite-single.js");
    for (const bad of [
      "",
      "stockfish.js",
      "https://example.com/evil.js",
      "//example.com/evil.js",
      "/__engine/../../etc/passwd",
      "/other/stockfish.js",
    ]) {
      expect(chessEngineWorkerUrl(bad), bad).toBeNull();
    }
  });
});

describe("what the row says", () => {
  it("names the SIZE before the press, because that is what the reader decides with", () => {
    const absent = { ...NO_CHESS_ENGINE, label: "Stockfish 18 Lite", bytes: 7_316_081 };
    expect(chessEngineRowLabel(absent)).toContain("7.3 MB");
    expect(chessEngineRowLabel(absent)).toMatch(/fetch/i);
  });

  it("counts the fetch while it runs, and never says 100% before it is done", () => {
    const half = { ...NO_CHESS_ENGINE, bytes: 1000, received: 500, downloading: true };
    expect(chessEngineRowLabel(half)).toContain("50%");
    const nearly = { ...NO_CHESS_ENGINE, bytes: 1000, received: 1000, downloading: true };
    expect(chessEngineRowLabel(nearly)).toContain("99%");
  });

  it("says it is here once it is", () => {
    expect(chessEngineRowLabel({ ...NO_CHESS_ENGINE, label: "Stockfish 18 Lite", present: true }))
      .toBe("Stockfish 18 Lite is on this machine");
  });

  it("reads as ABSENT before the backend has answered", () => {
    // A hopeful `present` would offer a game whose first move nothing could make.
    expect(NO_CHESS_ENGINE.present).toBe(false);
    expect(NO_CHESS_ENGINE.worker_path).toBe("");
  });
});

describe("megabytes", () => {
  it("is a size a reader can read", () => {
    expect(megabytes(7_316_081)).toBe("7.3 MB");
    expect(megabytes(0)).toBe("0 MB");
    expect(megabytes(-1)).toBe("0 MB");
  });
});
