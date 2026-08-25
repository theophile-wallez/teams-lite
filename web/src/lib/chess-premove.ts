/**
 * WHERE A PREMOVE MAY GO — the one question about a game of chess the RULES cannot answer.
 *
 * Everywhere else in this feature the rules decide: a move is offered because `chess.js` says it
 * is legal in the position on screen. A premove is the opposite kind of question. It is played
 * into a position **nobody has yet** — the one that exists after the opponent has moved — so
 * "what is legal now" is the wrong test, and using it made the commonest premove in chess
 * impossible to set: a pawn RECAPTURE, whose destination is an empty square until their move
 * puts a piece on it.
 *
 * So this module answers a different question, and it is lichess's own: **where could this piece
 * go, by its own geometry, if the board were arranged for it.** Blockers are ignored, check is
 * ignored, pins are ignored, and a pawn may go diagonally onto nothing. The reasoning is the
 * asymmetry between the two ways of being wrong:
 *
 *   - too PERMISSIVE costs a premove that is dropped when it fires. The reader loses the tempo
 *     they would have lost anyway, and `use-chess-game.ts` re-asks the real rules about the real
 *     position before anything is posted — so an impossible premove can never become an illegal
 *     move in the ledger.
 *   - too STRICT costs a premove that cannot be made AT ALL, in a position where it is the only
 *     move worth making. Nothing recovers that.
 *
 * Two bounds are kept, because each one removes a square that no move of the opponent's could
 * ever make legal — so they cost the reader nothing:
 *
 *   - a destination holding the reader's OWN KING. Every other occupied square can come free
 *     (they may move their piece off it, or capture ours on it); a king cannot be captured, and
 *     the piece being premoved is not the king when the king is the thing standing there.
 *   - a CASTLE whose right the position has already lost. A castling right never comes back, so
 *     offering it is offering a move that can never be played — where a castle merely blocked, or
 *     through an attacked square, is one their move may well free.
 *
 * It is PURE and carries no dependency, like every other `lib/chess-*.ts`: it reads the two
 * fields of a FEN it needs — the piece placement and the castling rights — rather than taking a
 * `Chess`. That is what keeps a rules engine off the path of every chat (the board's own lazy
 * chunk is where `chess.js` lives), and it is what makes every rule below testable without one.
 */

import type { ChessColor } from "./chess-wire";

/** The six pieces, in FEN's own lowercase spelling. */
export type ChessPieceType = "p" | "n" | "b" | "r" | "q" | "k";

/** A piece on a square: whose it is, and what it is. */
export type ChessPiece = { color: ChessColor; type: ChessPieceType };

/** The two halves of a FEN a premove is decided from. Nothing else about the position matters:
 *  whose turn it is says nothing about a move meant for the NEXT one. */
export type ChessPlacement = {
  /** Square (`a1` … `h8`) to the piece standing on it. Squares with nothing on them are absent. */
  pieces: Map<string, ChessPiece>;
  /** FEN's own castling field — `KQkq`, or `-` for a position that has lost every right. */
  castling: string;
};

const FILES = "abcdefgh";

/** A square's name from its file and rank, both 0-based from `a1`. */
function squareAt(file: number, rank: number): string {
  return `${FILES[file] as string}${rank + 1}`;
}

/** A square's file and rank, both 0-based from `a1`. Null for anything that is not a square. */
function indexOf(square: string): [number, number] | null {
  if (square.length !== 2) return null;
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return [file, rank];
}

/**
 * Read a FEN's piece placement and castling rights.
 *
 * Strict about the placement — eight ranks, eight files each — because a FEN this app could not
 * read is one it must offer no premove in rather than one it guesses at. It is only ever handed a
 * FEN `chess.js` itself wrote, so a refusal here is a bug in the caller and not in the input.
 */
export function chessPlacementOf(fen: string): ChessPlacement | null {
  const fields = fen.trim().split(/\s+/);
  const placement = fields[0];
  if (!placement) return null;
  const rows = placement.split("/");
  if (rows.length !== 8) return null;
  const pieces = new Map<string, ChessPiece>();
  for (let row = 0; row < 8; row += 1) {
    // FEN states rank 8 first.
    const rank = 7 - row;
    let file = 0;
    for (const glyph of rows[row] as string) {
      if (glyph >= "1" && glyph <= "8") {
        file += Number(glyph);
        continue;
      }
      const type = glyph.toLowerCase();
      if (!"pnbrqk".includes(type) || file > 7) return null;
      pieces.set(squareAt(file, rank), {
        // FEN spells white in capitals, so a glyph that is already lowercase is black's.
        color: glyph === type ? "b" : "w",
        type: type as ChessPieceType,
      });
      file += 1;
    }
    if (file !== 8) return null;
  }
  return { pieces, castling: fields[2] ?? "-" };
}

/**
 * Every square the piece on `from` might be able to reach once the opponent has moved.
 *
 * `color` is the reader's own side, and the piece has to be theirs: a premove is a move of one's
 * own piece, and the caller asking about somebody else's is a caller with a bug.
 */
export function chessPremoveTargets(fen: string, from: string, color: ChessColor): string[] {
  const placement = chessPlacementOf(fen);
  const origin = indexOf(from);
  if (!placement || !origin) return [];
  const piece = placement.pieces.get(from);
  if (!piece || piece.color !== color) return [];
  const [file, rank] = origin;
  const targets: string[] = [];
  // All 64, the way chessground does it: a mobility test per square is obviously total, where a
  // per-piece walk has a direction to forget. Sixty-four comparisons is nothing at all.
  for (let f = 0; f < 8; f += 1) {
    for (let r = 0; r < 8; r += 1) {
      if (f === file && r === rank) continue;
      const square = squareAt(f, r);
      const sitting = placement.pieces.get(square);
      // The one occupied square no move of theirs can free (see the header).
      if (sitting && sitting.color === color && sitting.type === "k") continue;
      if (reaches(piece, placement, file, rank, f, r)) targets.push(square);
    }
  }
  return targets;
}

/** Whether a premove would land a pawn on the last rank — the one move two squares cannot state
 *  on their own, so the board has to ask which piece before it queues anything. Geometry answers
 *  it, because the rules are not the ones that will judge this move. */
export function chessPremoveIsPromotion(
  fen: string,
  from: string,
  to: string,
  color: ChessColor,
): boolean {
  const placement = chessPlacementOf(fen);
  const piece = placement?.pieces.get(from);
  if (!piece || piece.type !== "p" || piece.color !== color) return false;
  const target = indexOf(to);
  return !!target && target[1] === (color === "w" ? 7 : 0);
}

/** Whether a piece's own movement could take it from one square to another, on an empty board —
 *  plus the one move that is not a movement, which is a castle. */
function reaches(
  piece: ChessPiece,
  placement: ChessPlacement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  switch (piece.type) {
    case "p": {
      const forward = piece.color === "w" ? 1 : -1;
      const home = piece.color === "w" ? 1 : 6;
      // One rank forward on this file OR either diagonal: a diagonal onto an empty square is the
      // recapture — and the en-passant capture — this whole module exists for.
      if (y2 === y1 + forward && dx <= 1) return true;
      // The double step, from the pawn's own starting rank. Blockers are ignored like everywhere
      // else here: a piece in the way may be captured or may move.
      return y1 === home && x2 === x1 && y2 === y1 + 2 * forward;
    }
    case "n":
      return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
    case "b":
      return dx === dy;
    case "r":
      return dx === 0 || dy === 0;
    case "q":
      return dx === dy || dx === 0 || dy === 0;
    case "k":
      return (dx <= 1 && dy <= 1) || castles(piece.color, placement, x1, y1, x2, y2);
  }
}

/** Whether a king's two-square step is a castle this position still holds the right to. The
 *  squares between may be occupied and may be attacked — their move can change both — but a
 *  right that is spent is spent for good. */
function castles(
  color: ChessColor,
  placement: ChessPlacement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const home = color === "w" ? 0 : 7;
  if (y1 !== home || y2 !== home || x1 !== 4) return false;
  const side = x2 === 6 ? "k" : x2 === 2 ? "q" : null;
  if (!side) return false;
  if (!placement.castling.includes(color === "w" ? side.toUpperCase() : side)) return false;
  // And a rook really standing in the corner. A legal FEN always spells those two together, so
  // this is the module refusing to trust a field over the board rather than a rule of its own.
  const rook = placement.pieces.get(squareAt(side === "k" ? 7 : 0, home));
  return rook?.color === color && rook.type === "r";
}
