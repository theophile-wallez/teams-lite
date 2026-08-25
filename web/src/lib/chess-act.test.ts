import { describe, expect, it } from "vitest";
import { chessPublishFor } from "./chess-act";
import { PREMOVE_SPEND_MS } from "./chess-clock";
import type { ChessGame } from "./chess-thread";
import { newChessLedger, type ChessColor, type ChessLedger } from "./chess-wire";

const T0 = 1_800_000_000_000;
const ME = { mri: "8:orgid:me", name: "Clement", isSelf: true };
const ADA = { mri: "8:orgid:ada", name: "Ada", isSelf: false };

/** A ten-minute game we opened as white, Ada accepted, and one move played. */
function game(over: Partial<ChessGame> = {}): ChessGame {
  return {
    id: "aaa111",
    challengeMessageId: "m1",
    challengeSeq: 1,
    challenger: ME,
    challengerColor: "w",
    opponent: ADA,
    moves: [],
    moveClocks: [],
    time: { base: 600, increment: 0 },
    startedAt: T0,
    actedAt: { w: null, b: null },
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
    ledgers: { w: null, b: null },
    endedByRules: null,
    engine: null,
    absorbed: ["m1"],
    refusedPlies: [],
    ...over,
  };
}

/** Our own ledger, as the derivation would hand it back. */
function ours(color: ChessColor, over: Partial<ChessLedger> = {}) {
  return {
    messageId: "m1",
    seq: 1,
    ledger: { ...newChessLedger(color), opened: color === "w", ...over },
  };
}

describe("chessPublishFor", () => {
  it("SENDS a challenge, and every act after it EDITS the same message", () => {
    // The whole point of the ledger: the first act is a message, and nothing after it is.
    const open = chessPublishFor({
      gameId: "bbb222",
      game: null,
      color: "w",
      act: { kind: "open", time: { base: 600, increment: 0 }, color: "w" },
      nowMs: T0,
    });
    expect(open?.messageId).toBeNull();
    expect(open?.ledger.opened).toBe(true);
    expect(open?.ledger.time).toEqual({ base: 600, increment: 0 });

    const move = chessPublishFor({
      gameId: "aaa111",
      game: game({ ledgers: { w: ours("w"), b: null } }),
      color: "w",
      act: { kind: "move", san: "e4" },
      nowMs: T0 + 5_000,
    });
    expect(move?.messageId).toBe("m1");
  });

  it("CHARGES the mover what they really spent, and adds the increment", () => {
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: game({
        time: { base: 600, increment: 2 },
        ledgers: { w: ours("w"), b: null },
      }),
      color: "w",
      // Their turn started when the game was accepted, and they took twelve seconds.
      act: { kind: "move", san: "e4" },
      nowMs: T0 + 12_000,
    });
    expect(publish?.ledger.moves).toEqual([{ ply: 1, san: "e4", clockMs: 590_000 }]);
    // And what the board draws before the message lands says the same thing.
    expect(publish?.pending).toEqual({ ply: 1, san: "e4", clockMs: 590_000, at: T0 + 12_000 });
  });

  it("charges a PREMOVE a tenth of a second, whatever the opponent spent", () => {
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: game({
        moves: ["e4", "e5"],
        moveClocks: [598_000, 597_000],
        actedAt: { w: T0 + 2_000, b: T0 + 200_000 },
        turn: "w",
        ledgers: { w: ours("w", { moves: [{ ply: 1, san: "e4", clockMs: 598_000 }] }), b: null },
      }),
      color: "w",
      act: { kind: "move", san: "Nf3", premove: true },
      nowMs: T0 + 200_100,
    });
    // Their opponent thought for three minutes; the premove was already decided.
    expect(publish?.ledger.moves.at(-1)?.clockMs).toBe(598_000 - PREMOVE_SPEND_MS);
  });

  it("states NO clock in a game that has none", () => {
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: game({ time: null, ledgers: { w: ours("w"), b: null } }),
      color: "w",
      act: { kind: "move", san: "e4" },
      nowMs: T0 + 5_000,
    });
    expect(publish?.ledger.moves).toEqual([{ ply: 1, san: "e4", clockMs: null }]);
  });

  it("REFUSES an act the game does not admit, rather than posting a move that has gone", () => {
    // Not our turn: a stale press arriving after the opponent moved.
    expect(
      chessPublishFor({
        gameId: "aaa111",
        game: game({ turn: "b" }),
        color: "w",
        act: { kind: "move", san: "e4" },
        nowMs: T0,
      }),
    ).toBeNull();
    // A game nobody accepted has no moves in it.
    expect(
      chessPublishFor({
        gameId: "aaa111",
        game: game({ opponent: null }),
        color: "w",
        act: { kind: "move", san: "e4" },
        nowMs: T0,
      }),
    ).toBeNull();
    // Accepting one's own challenge, and accepting a draw nobody offered.
    expect(
      chessPublishFor({
        gameId: "aaa111",
        game: game({ opponent: null }),
        color: "b",
        act: { kind: "join" },
        nowMs: T0,
      }),
    ).toBeNull();
    expect(
      chessPublishFor({ gameId: "aaa111", game: game(), color: "w", act: { kind: "drawAccept" }, nowMs: T0 }),
    ).toBeNull();
  });

  it("anchors a draw offer at the ply the game is at, so a move answers it", () => {
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: game({ moves: ["e4", "e5"], turn: "w" }),
      color: "w",
      act: { kind: "draw" },
      nowMs: T0,
    });
    expect(publish?.ledger.drawOfferedAt).toBe(2);
  });

  it("drops our own standing offer when we MOVE, because the game is past it", () => {
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: game({ ledgers: { w: ours("w", { drawOfferedAt: 0 }), b: null } }),
      color: "w",
      act: { kind: "move", san: "e4" },
      nowMs: T0 + 1_000,
    });
    // The token is not written at all: the line says only what is still true.
    expect(publish?.ledger.drawOfferedAt).toBeNull();
  });

  it("claims a flag against whoever is ON the clock, never one's own, and dates the claim", () => {
    const fair = chessPublishFor({
      gameId: "aaa111",
      game: game({ turn: "b" }),
      color: "w",
      act: { kind: "flag" },
      nowMs: T0 + 90_000,
    });
    expect(fair?.ledger.flagged).toEqual({ color: "b", at: T0 + 90_000 });
    // On our own turn there is nobody to flag but ourselves, which is refused.
    expect(
      chessPublishFor({ gameId: "aaa111", game: game(), color: "w", act: { kind: "flag" }, nowMs: T0 }),
    ).toBeNull();
  });

  it("keeps a v1 player's first ledger honest about how they got into the game", () => {
    // Somebody who joined with an older build has no ledger; the first one they write says so,
    // rather than looking like a second challenge.
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: game({
        challenger: ADA,
        challengerColor: "w",
        opponent: ME,
        ourColor: "b",
        turn: "b",
        moves: ["e4"],
        moveClocks: [null],
      }),
      color: "b",
      act: { kind: "move", san: "e5" },
      nowMs: T0 + 3_000,
    });
    expect(publish?.messageId).toBeNull();
    expect(publish?.ledger.joined).toBe(true);
    expect(publish?.ledger.opened).toBe(false);
    expect(publish?.ledger.moves).toEqual([{ ply: 2, san: "e5", clockMs: 597_000 }]);
  });
});

describe("a move for the ENGINE", () => {
  /** A game against the computer: one ledger, the reader as white, the engine to move. */
  function vsEngine(over: Partial<ChessGame> = {}): ChessGame {
    return game({
      engine: { elo: 1800 },
      opponent: { mri: "", name: "Stockfish 1800", isSelf: false },
      moves: ["e4"],
      moveClocks: [598_000],
      turn: "b",
      ledgers: {
        w: ours("w", { engineElo: 1800, moves: [{ ply: 1, san: "e4", clockMs: 598_000 }] }),
        b: null,
      },
      ...over,
    });
  }

  it("writes the OTHER colour's ply into the reader's own ledger", () => {
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: vsEngine(),
      color: "w",
      act: { kind: "move", san: "e5", engine: { spentMs: 250 } },
      nowMs: T0 + 60_000,
    });
    // The reader's own message, holding a move black played.
    expect(publish?.messageId).toBe("m1");
    expect(publish?.ledger.moves.at(-1)).toEqual({ ply: 2, san: "e5", clockMs: 599_750 });
    // Charged what the SEARCH cost — 250 ms — rather than the minute that passed on the wall: the
    // engine cannot think while the app is closed, and a clock that said otherwise would hand the
    // reader a win on time they never played for.
    expect(publish?.ledger.moves.at(-1)?.clockMs).toBe(600_000 - 250);
  });

  it("is REFUSED in a game that is not against an engine", () => {
    // Otherwise a client could move for a colleague by claiming their opponent was a machine.
    expect(
      chessPublishFor({
        gameId: "aaa111",
        game: game({ turn: "b" }),
        color: "w",
        act: { kind: "move", san: "e5", engine: { spentMs: 10 } },
        nowMs: T0,
      }),
    ).toBeNull();
  });

  it("is REFUSED when it is not the engine's turn", () => {
    expect(
      chessPublishFor({
        gameId: "aaa111",
        game: vsEngine({ turn: "w" }),
        color: "w",
        act: { kind: "move", san: "e5", engine: { spentMs: 10 } },
        nowMs: T0,
      }),
    ).toBeNull();
  });

  it("offers neither a DRAW nor a FLAG against a machine", () => {
    // There is nobody to ask for a draw, and an engine's clock is never counted down by the wall —
    // so there is no flag to claim either.
    expect(
      chessPublishFor({ gameId: "aaa111", game: vsEngine(), color: "w", act: { kind: "draw" }, nowMs: T0 }),
    ).toBeNull();
    expect(
      chessPublishFor({ gameId: "aaa111", game: vsEngine(), color: "w", act: { kind: "flag" }, nowMs: T0 }),
    ).toBeNull();
  });

  it("still RESIGNS, because that is the reader's own act", () => {
    const publish = chessPublishFor({
      gameId: "aaa111",
      game: vsEngine(),
      color: "w",
      act: { kind: "resign" },
      nowMs: T0,
    });
    expect(publish?.ledger.resigned).toBe(true);
  });

  it("carries the ENGINE's strength when the game is opened", () => {
    const open = chessPublishFor({
      gameId: "eee111",
      game: null,
      color: "w",
      act: { kind: "open", color: "w", time: { base: 600, increment: 0 }, engineElo: 1320 },
      nowMs: T0,
    });
    expect(open?.ledger.engineElo).toBe(1320);
    expect(open?.messageId).toBeNull();
  });
});
