import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { chessPlacementOf, chessPremoveIsPromotion, chessPremoveTargets } from "./chess-premove";

const OPENING = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** 1. e4 e5 2. Nf3 — black to move, so anything white plays is a premove. */
const AFTER_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

/** What the RULES would allow, for the comparisons that are the whole point of this module. */
function legalNow(fen: string, from: string): string[] {
  const chess = new Chess(fen);
  return chess.moves({ square: from as never, verbose: true }).map((m) => m.to);
}

describe("chessPlacementOf", () => {
  it("reads the pieces and the castling rights out of a FEN", () => {
    const placement = chessPlacementOf(OPENING);
    expect(placement?.pieces.get("e1")).toEqual({ color: "w", type: "k" });
    expect(placement?.pieces.get("d8")).toEqual({ color: "b", type: "q" });
    expect(placement?.pieces.get("a2")).toEqual({ color: "w", type: "p" });
    // An empty square is ABSENT rather than null, which is what makes every lookup below a
    // truthiness test.
    expect(placement?.pieces.has("e4")).toBe(false);
    expect(placement?.pieces.size).toBe(32);
    expect(placement?.castling).toBe("KQkq");
  });

  it("refuses a placement it cannot read, rather than guessing at one", () => {
    // A board this app could not parse must offer NO premove: a guess would draw dots on squares
    // nothing stands on.
    expect(chessPlacementOf("")).toBeNull();
    expect(chessPlacementOf("8/8/8/8 w - - 0 1")).toBeNull();
    expect(chessPlacementOf("9/8/8/8/8/8/8/8 w - - 0 1")).toBeNull();
    expect(chessPlacementOf("xxxxxxxx/8/8/8/8/8/8/8 w - - 0 1")).toBeNull();
    // A position with no castling field at all still reads: only the placement is mandatory.
    expect(chessPlacementOf("8/8/8/8/8/8/8/K6k")?.castling).toBe("-");
  });
});

describe("chessPremoveTargets", () => {
  it("offers a pawn its DIAGONALS onto empty squares — the recapture the rules refuse", () => {
    // THE headline case. The rules allow that pawn NOTHING — e5 is blocked by their own pawn and
    // both diagonals are empty — so a premove of exd5, the commonest premove in chess, could not
    // be set at all while the rules were the judge of one.
    expect(legalNow(AFTER_NF3.replace(" b ", " w "), "e4")).toEqual([]);
    const targets = chessPremoveTargets(AFTER_NF3, "e4", "w");
    expect(targets).toContain("d5");
    expect(targets).toContain("f5");
    // Straight forward onto their pawn, too: they may move it, and then the step is a step.
    expect(targets).toContain("e5");
    // And never backwards or two squares from a rank that is not its own.
    expect(targets).not.toContain("e3");
    expect(targets).not.toContain("e6");
  });

  it("offers a pawn its DOUBLE step from home, and only from home", () => {
    expect(chessPremoveTargets(OPENING, "e2", "w")).toContain("e4");
    expect(chessPremoveTargets(AFTER_NF3, "e4", "w")).not.toContain("e6");
    // Black's runs the other way.
    const black = chessPremoveTargets(AFTER_NF3, "d7", "b");
    expect(black).toEqual(expect.arrayContaining(["d5", "d6", "c6", "e6"]));
    expect(black).not.toContain("d8");
  });

  it("ignores BLOCKERS, because their move can clear them", () => {
    // The rook on a1 is walled in by its own pawn and its own knight; every square it could ever
    // reach is offered, since either piece may move or be captured.
    expect(legalNow(AFTER_NF3.replace(" b ", " w "), "a1")).toEqual([]);
    const rook = chessPremoveTargets(AFTER_NF3, "a1", "w");
    expect(rook).toEqual(expect.arrayContaining(["a8", "a4", "d1", "h1"]));
    // A rook still moves like a rook: a diagonal is not a blocked move, it is not a move.
    expect(rook).not.toContain("b2");
  });

  it("ignores CHECK and PINS, because their move can answer both", () => {
    // A rook that cannot move at all — it is the only thing between its king and a rook.
    const pinned = "4k3/8/8/8/8/8/4R3/4K2r w - - 0 1";
    expect(legalNow(pinned, "e2")).toEqual([]);
    expect(chessPremoveTargets(pinned, "e2", "w")).toEqual(
      expect.arrayContaining(["e7", "a2", "h2", "e3"]),
    );
  });

  it("offers a CASTLE the rights still allow, whatever stands in the way", () => {
    // g1 is attacked, so the rules refuse O-O — and the opponent's next move may well stop
    // attacking it.
    const attacked = "r3k2r/8/8/8/8/8/6q1/R3K2R w KQkq - 0 1";
    expect(legalNow(attacked, "e1")).not.toContain("g1");
    expect(chessPremoveTargets(attacked, "e1", "w")).toContain("g1");
    expect(chessPremoveTargets(attacked, "e1", "w")).toContain("c1");
  });

  it("refuses a CASTLE whose right is spent, because nothing can bring one back", () => {
    // The rooks are home and the king is home, and the rights are gone: the one bound where
    // being permissive would offer a move that can never be played.
    const spent = "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1";
    const king = chessPremoveTargets(spent, "e1", "w");
    expect(king).not.toContain("g1");
    expect(king).not.toContain("c1");
    // The ordinary king steps are untouched.
    expect(king).toEqual(expect.arrayContaining(["d1", "f1", "e2", "d2", "f2"]));
    // One side of the rights, one side of the offer.
    expect(chessPremoveTargets("r3k2r/8/8/8/8/8/8/R3K2R w K - 0 1", "e1", "w")).toContain("g1");
    expect(chessPremoveTargets("r3k2r/8/8/8/8/8/8/R3K2R w K - 0 1", "e1", "w")).not.toContain("c1");
    // And a right the board does not back with a rook is not offered either.
    expect(chessPremoveTargets("r3k2r/8/8/8/8/8/8/4K2R w KQkq - 0 1", "e1", "w")).not.toContain("c1");
  });

  it("never offers the square the reader's OWN KING is standing on", () => {
    // Every other occupied square can come free — they may move their piece off it, or take ours
    // on it. A king can be neither, so this is the one square no move of theirs makes legal.
    const targets = chessPremoveTargets(OPENING, "d1", "w");
    expect(targets).not.toContain("e1");
    // Our own queen, though, may well be captured there.
    expect(chessPremoveTargets(OPENING, "d1", "b")).toEqual([]);
    expect(chessPremoveTargets(OPENING, "a1", "w")).toContain("a2");
  });

  it("answers nothing for a square that is not ours, or not a square", () => {
    // A premove is a move of one's own piece: the caller asking about anything else has a bug,
    // and an empty answer is what stops it becoming a move.
    expect(chessPremoveTargets(OPENING, "e7", "w")).toEqual([]);
    expect(chessPremoveTargets(OPENING, "e4", "w")).toEqual([]);
    expect(chessPremoveTargets(OPENING, "z9", "w")).toEqual([]);
    expect(chessPremoveTargets(OPENING, "e", "w")).toEqual([]);
    expect(chessPremoveTargets("nonsense", "e2", "w")).toEqual([]);
  });

  it("moves every piece the way that piece moves", () => {
    const empty = "4k3/8/8/3Q4/8/8/8/4K3 w - - 0 1";
    const queen = chessPremoveTargets(empty, "d5", "w");
    // A queen reaches its rank, its file and both diagonals, and nothing else.
    expect(queen).toEqual(expect.arrayContaining(["d1", "d8", "a5", "h5", "a2", "g8", "a8", "h1"]));
    expect(queen).not.toContain("e7");
    // Seven down the file, seven along the rank, thirteen on the diagonals from d5.
    expect(queen.length).toBe(7 + 7 + 13);
    const knight = chessPremoveTargets("4k3/8/8/3N4/8/8/8/4K3 w - - 0 1", "d5", "w");
    expect(knight.sort()).toEqual(["b4", "b6", "c3", "c7", "e3", "e7", "f4", "f6"]);
    const bishop = chessPremoveTargets("4k3/8/8/3B4/8/8/8/4K3 w - - 0 1", "d5", "w");
    expect(bishop).toEqual(expect.arrayContaining(["a2", "a8", "h1", "g8"]));
    expect(bishop).not.toContain("d1");
  });

  it("keeps every move the RULES allow, so a premove is never narrower than a move", () => {
    // THE BOUND THAT MATTERS MOST: whatever is legal right now must be premovable, or the reader
    // loses a move they could have made. Checked over every white piece of four positions, and the
    // last three are the moves two squares cannot state on their own — a castle, an en-passant
    // capture and a capture-promotion. Each of those really fires: `resolve` in use-chess-game.ts
    // asks the rules by square and gets `O-O`, `exf6` and `bxa8=N` back.
    for (const fen of [
      "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 1",
      "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
      "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 1",
      "r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1",
    ]) {
      const placement = chessPlacementOf(fen);
      expect(placement, fen).not.toBeNull();
      for (const [square, piece] of (placement as NonNullable<typeof placement>).pieces) {
        if (piece.color !== "w") continue;
        const targets = chessPremoveTargets(fen, square, "w");
        for (const legal of legalNow(fen, square)) {
          expect(targets, `${fen}: ${square} → ${legal}`).toContain(legal);
        }
      }
    }
  });
});

describe("chessPremoveIsPromotion", () => {
  it("is a pawn reaching the last rank, from either side", () => {
    const white = "4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1";
    expect(chessPremoveIsPromotion(white, "b7", "b8", "w")).toBe(true);
    // A capture-promotion onto an empty square: the premove this module exists for, and it still
    // has to ask which piece.
    expect(chessPremoveIsPromotion(white, "b7", "a8", "w")).toBe(true);
    expect(chessPremoveIsPromotion(white, "g2", "g1", "b")).toBe(true);
  });

  it("is not a pawn short of the rank, and not another piece reaching it", () => {
    const fen = "4k3/1P6/8/8/8/8/6p1/R3K3 w - - 0 1";
    expect(chessPremoveIsPromotion(fen, "a1", "a8", "w")).toBe(false);
    expect(chessPremoveIsPromotion("4k3/8/1P6/8/8/8/8/4K3 w - - 0 1", "b6", "b7", "w")).toBe(false);
    // A pawn of the other colour is not the reader's to promote.
    expect(chessPremoveIsPromotion(fen, "g2", "g1", "w")).toBe(false);
    expect(chessPremoveIsPromotion(fen, "e4", "e8", "w")).toBe(false);
  });
});
