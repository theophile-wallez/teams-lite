import { describe, expect, it } from "vitest";
import {
  chessOpponentMri,
  chessSeriesBetween,
  chessSeriesGames,
  chessSeriesWords,
  formatChessPoints,
} from "./chess-series";
import type { ChessGame, ChessOutcome } from "./chess-thread";

const ME = { mri: "8:orgid:me", name: "Clement", isSelf: true };
const ADA = { mri: "8:orgid:ada", name: "Ada", isSelf: false };
const GRACE = { mri: "8:orgid:grace", name: "Grace", isSelf: false };

/** One finished game, as the derivation would hand it back. */
function game(id: string, over: Partial<ChessGame> = {}): ChessGame {
  return {
    id,
    challengeMessageId: `m-${id}`,
    challengeSeq: 1,
    challenger: ME,
    challengerColor: "w",
    opponent: ADA,
    moves: [],
    moveClocks: [],
    time: { base: 600, increment: 0 },
    startedAt: 0,
    actedAt: { w: null, b: null },
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
    ledgers: { w: null, b: null },
    endedByRules: null,
    engine: null,
    absorbed: [],
    refusedPlies: [],
    ...over,
  };
}

/** A game we won, lost, or drew — the three the score is made of. */
function won(id: string, over: Partial<ChessGame> = {}): ChessGame {
  return game(id, { outcome: { kind: "resigned", by: "b" }, ...over });
}
function lost(id: string, over: Partial<ChessGame> = {}): ChessGame {
  return game(id, { outcome: { kind: "resigned", by: "w" }, ...over });
}
function drawn(id: string, over: Partial<ChessGame> = {}): ChessGame {
  return game(id, { outcome: { kind: "drawAgreed" }, ...over });
}

describe("chessOpponentMri", () => {
  it("names the other person by MRI, whichever side of the challenge the reader was on", () => {
    expect(chessOpponentMri(game("a"))).toBe(ADA.mri);
    // Ada challenged us: the opponent is the challenger.
    expect(
      chessOpponentMri(game("b", { challenger: ADA, opponent: ME, ourColor: "b" })),
    ).toBe(ADA.mri);
  });

  it("names nobody for a game the reader is watching, one nobody accepted, or the ENGINE", () => {
    expect(chessOpponentMri(game("a", { ourColor: null, challenger: ADA, opponent: GRACE }))).toBeNull();
    expect(chessOpponentMri(game("b", { opponent: null }))).toBeNull();
    // A machine keeps no score with anybody — and its MRI is empty, which would otherwise pool
    // every engine game in one series.
    expect(
      chessOpponentMri(
        game("c", { engine: { elo: 1800 }, opponent: { mri: "", name: "Stockfish 1800", isSelf: false } }),
      ),
    ).toBeNull();
  });
});

describe("chessSeriesBetween", () => {
  it("counts a draw as a HALF for each side, so the points add up to the games", () => {
    const series = chessSeriesBetween([won("a"), lost("b"), drawn("c"), drawn("d")], ADA.mri);
    expect(series).toEqual({ played: 4, wins: 1, losses: 1, draws: 2, us: 2, them: 2 });
    expect(series.us + series.them).toBe(series.played);
  });

  it("reads every way a game ends", () => {
    const outcomes: [ChessOutcome, "us" | "them"][] = [
      [{ kind: "resigned", by: "b" }, "us"],
      [{ kind: "resigned", by: "w" }, "them"],
      [{ kind: "timeout", loser: "b" }, "us"],
      [{ kind: "timeout", loser: "w" }, "them"],
    ];
    outcomes.forEach(([outcome, winner], index) => {
      const series = chessSeriesBetween([game(`g${index}`, { outcome })], ADA.mri);
      expect(series.played).toBe(1);
      expect(series[winner]).toBe(1);
    });
    // A MATE the wire states: the mating move is the last ply, so the side to move is mated.
    // We are white and it is black's move, so black is the one mated.
    const mate = chessSeriesBetween([game("m", { moves: ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"], turn: "b" })], ADA.mri);
    expect(mate).toMatchObject({ played: 1, wins: 1, us: 1 });
  });

  it("leaves out a game in progress, a challenge nobody took up, and somebody ELSE's game", () => {
    const series = chessSeriesBetween(
      [
        won("a"),
        game("b"), // still playing
        game("c", { outcome: { kind: "declined", withdrawn: false }, opponent: null }),
        game("d", { outcome: { kind: "declined", withdrawn: true }, opponent: null }),
        // Grace's game against us — a different series in the same conversation.
        won("e", { opponent: GRACE }),
        // Two colleagues playing each other in a group chat, which is none of our business.
        won("f", { challenger: ADA, opponent: GRACE, ourColor: null }),
      ],
      ADA.mri,
    );
    expect(series).toEqual({ played: 1, wins: 1, losses: 0, draws: 0, us: 1, them: 0 });
  });

  it("keeps two opponents' series apart in one conversation", () => {
    const games = [won("a"), won("b"), lost("c", { opponent: GRACE })];
    expect(chessSeriesBetween(games, ADA.mri).played).toBe(2);
    expect(chessSeriesBetween(games, GRACE.mri)).toMatchObject({ played: 1, losses: 1 });
    // A name is never the key: an empty MRI counts nothing at all.
    expect(chessSeriesBetween(games, "").played).toBe(0);
  });
});

describe("chessSeriesGames", () => {
  it("lets the LIVE game win over the archived snapshot of the same one", () => {
    // The snapshot was read while this game was still going; the thread has since settled it.
    const archive = [game("a"), won("b")];
    const live = [won("a")];
    const merged = chessSeriesGames(archive, live);
    expect(merged).toHaveLength(2);
    expect(chessSeriesBetween(merged, ADA.mri)).toMatchObject({ played: 2, wins: 2 });
  });

  it("keeps a game only one side holds", () => {
    expect(chessSeriesGames([won("old")], [won("new")])).toHaveLength(2);
    expect(chessSeriesGames([], [won("new")])).toHaveLength(1);
    expect(chessSeriesGames([won("old")], [])).toHaveLength(1);
  });
});

describe("formatChessPoints", () => {
  it("writes a half the way chess writes one", () => {
    expect(formatChessPoints(0)).toBe("0");
    expect(formatChessPoints(0.5)).toBe("½");
    expect(formatChessPoints(1)).toBe("1");
    expect(formatChessPoints(2.5)).toBe("2½");
    expect(formatChessPoints(11)).toBe("11");
  });
});

describe("chessSeriesWords", () => {
  it("names the LEADER first, and says nothing at all before the first result", () => {
    expect(chessSeriesWords({ played: 0, wins: 0, losses: 0, draws: 0, us: 0, them: 0 }, "Ada")).toBeNull();
    expect(chessSeriesWords(chessSeriesBetween([won("a")], ADA.mri), "Ada")).toBe(
      "You lead 1–0 after 1 game",
    );
    expect(chessSeriesWords(chessSeriesBetween([lost("a"), lost("b")], ADA.mri), "Ada")).toBe(
      "Ada leads 2–0 after 2 games",
    );
    expect(chessSeriesWords(chessSeriesBetween([won("a"), lost("b")], ADA.mri), "Ada")).toBe(
      "Level 1–1 after 2 games",
    );
    expect(
      chessSeriesWords(chessSeriesBetween([won("a"), lost("b"), drawn("c")], ADA.mri), "Ada"),
    ).toBe("Level 1½–1½ after 3 games");
    expect(
      chessSeriesWords(chessSeriesBetween([won("a"), won("b"), drawn("c")], ADA.mri), "Ada"),
    ).toBe("You lead 2½–½ after 3 games");
  });
});
