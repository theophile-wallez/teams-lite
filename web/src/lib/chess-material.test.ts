import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import {
  chessCapturedGlyphs,
  chessCapturedWords,
  chessDeltaLabel,
  chessMaterial,
  chessMaterialFor,
} from "./chess-material";

const OPENING = new Chess().fen();

/** The FEN a line of play reaches, so every fixture below is a position that really happened. */
function after(...moves: string[]): string {
  const chess = new Chess();
  for (const san of moves) chess.move(san);
  return chess.fen();
}

describe("chessMaterial", () => {
  it("says nothing at the starting position", () => {
    const material = chessMaterial(OPENING);
    expect(material.captured).toEqual({ w: [], b: [] });
    expect(material.advantage).toBe(0);
    // Both sides hold the classical 39 points: a queen, two rooks, two bishops, two knights and
    // eight pawns. The king is in none of it — it cannot be captured.
    expect(material.points).toEqual({ w: 39, b: 39 });
  });

  it("attributes a capture to the side that MADE it", () => {
    // 1. e4 d5 2. exd5 — white has taken a black pawn and nothing else.
    const material = chessMaterial(after("e4", "d5", "exd5"));
    expect(material.captured.w).toEqual([{ type: "p", count: 1 }]);
    expect(material.captured.b).toEqual([]);
    expect(material.advantage).toBe(1);
  });

  it("counts a level exchange as level, with both hauls drawn", () => {
    const material = chessMaterial(after("e4", "d5", "exd5", "Qxd5"));
    expect(material.captured.w).toEqual([{ type: "p", count: 1 }]);
    expect(material.captured.b).toEqual([{ type: "p", count: 1 }]);
    expect(material.advantage).toBe(0);
  });

  it("orders a haul strongest first", () => {
    // A position with a queen, a rook and two pawns off the board for black.
    const fen = "rnb1kbnr/pppp1ppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(chessMaterial(fen).captured.w).toEqual([
      { type: "q", count: 1 },
      { type: "p", count: 1 },
    ]);
  });

  it("reads a PROMOTION as material rather than as a capture", () => {
    // The one place the haul is a convention and the score is exact. White's pawn becomes a queen:
    // nobody captured it, so the haul reads as though black had taken a pawn — which is what
    // lichess shows too — while the score correctly puts white eight points up.
    const promoted = "4k3/8/8/8/8/8/8/4K1Q1 b - - 0 1";
    const material = chessMaterial(promoted);
    expect(material.points).toEqual({ w: 9, b: 0 });
    expect(material.advantage).toBe(9);
    // And a piece nobody captured is never DRAWN: white holding two queens would make black's haul
    // of queens negative, which is not a thing a board can show.
    const twoQueens = "4k3/8/8/8/8/8/8/3QK1Q1 b - - 0 1";
    expect(chessMaterial(twoQueens).captured.b.some((c) => c.type === "q")).toBe(false);
    expect(chessMaterial(twoQueens).advantage).toBe(18);
  });

  it("answers NOTHING for a FEN it cannot read, rather than a guess", () => {
    expect(chessMaterial("not a fen").advantage).toBe(0);
    expect(chessMaterial("").captured).toEqual({ w: [], b: [] });
  });
});

describe("chessMaterialFor", () => {
  it("signs the delta from that side's OWN point of view", () => {
    const material = chessMaterial(after("e4", "d5", "exd5"));
    expect(chessMaterialFor(material, "w").delta).toBe(1);
    expect(chessMaterialFor(material, "b").delta).toBe(-1);
    // And each side is handed its own haul.
    expect(chessMaterialFor(material, "w").captured).toEqual([{ type: "p", count: 1 }]);
    expect(chessMaterialFor(material, "b").captured).toEqual([]);
  });
});

describe("chessCapturedGlyphs", () => {
  it("draws the OPPONENT's men, one glyph per piece", () => {
    // White's haul is black's pieces: solid glyphs. Three of them for three pawns.
    expect(chessCapturedGlyphs([{ type: "p", count: 3 }], "w")).toBe("♟♟♟");
    expect(chessCapturedGlyphs([{ type: "q", count: 1 }], "w")).toBe("♛");
    // Black's haul is white's, drawn hollow — the typographic convention, and the one thing that
    // reads in both themes.
    expect(chessCapturedGlyphs([{ type: "r", count: 2 }], "b")).toBe("♖♖");
    expect(chessCapturedGlyphs([], "w")).toBe("");
  });
});

describe("chessCapturedWords", () => {
  it("names the pieces, because a row of glyphs says nothing to a screen reader", () => {
    expect(chessCapturedWords([{ type: "p", count: 1 }])).toBe("1 pawn");
    expect(chessCapturedWords([{ type: "p", count: 3 }])).toBe("3 pawns");
    expect(
      chessCapturedWords([
        { type: "q", count: 1 },
        { type: "n", count: 1 },
        { type: "p", count: 2 },
      ]),
    ).toBe("1 queen, 1 knight and 2 pawns");
    // Empty, so the caller draws no label at all rather than an empty one.
    expect(chessCapturedWords([])).toBe("");
  });
});

describe("chessDeltaLabel", () => {
  it("writes a real minus sign, and says nothing at all when the sides are level", () => {
    expect(chessDeltaLabel(3)).toBe("+3");
    expect(chessDeltaLabel(-3)).toBe("−3");
    expect(chessDeltaLabel(0)).toBe("");
  });
});
