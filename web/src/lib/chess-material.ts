/**
 * WHAT EACH SIDE HAS TAKEN, and who is ahead on material — read off the position on screen.
 *
 * A player reads a board and then reads two other things: the men they have won, and whether the
 * exchange left them up or down. Both are drawn beside the seat they belong to, so the reader
 * learns their own standing without counting pieces (see `ChessSeat` in chess-game-card.tsx).
 *
 * It is PURE and carries no dependency, like every other `lib/chess-*.ts`: it reads the placement
 * out of a FEN through `chessPlacementOf` — the ONE FEN reader in this app, which a premove already
 * needed — rather than taking a `Chess`. That is what keeps a rules engine off the path of every
 * chat, and it is what makes every rule below testable without one.
 *
 * **THE HAUL IS "WHAT IS MISSING", AND THE SCORE IS "WHAT IS LEFT".** They are two readings of one
 * count, and it matters which is which:
 *
 *   - a side's HAUL is the opponent's men that are no longer on the board, against the sixteen a
 *     game starts with. That is lichess's own convention and it is what a player expects to see.
 *   - the SCORE is the material each side still HAS. It is exact where the haul is a convention: a
 *     PROMOTION makes one of white's pawns disappear without anybody capturing it, so a haul reads
 *     as though black had taken a pawn, while the remaining-material score correctly shows white
 *     eight points UP. A promoted piece also makes a count go the other way (white now holds two
 *     queens), and a negative haul is not a thing a board can show — so it is clamped to nothing
 *     rather than drawn as a piece somebody un-captured.
 *
 * The KING is not in any of it: it cannot be captured, and a value for it would be a number that
 * never changes.
 */

import { chessPlacementOf } from "./chess-premove";
import type { ChessColor } from "./chess-wire";

/** A piece that can be taken — the six of FEN minus the king, strongest first, which is the order
 *  a haul is drawn in. */
export const CHESS_CAPTURABLE = ["q", "r", "b", "n", "p"] as const;

/** What each capturable piece is worth. The classical values, which is what every board a player
 *  has ever read uses — nothing here is a chess engine's own evaluation. */
export const CHESS_PIECE_VALUES: Record<(typeof CHESS_CAPTURABLE)[number], number> = {
  q: 9,
  r: 5,
  b: 3,
  n: 3,
  p: 1,
};

/** How many of each a side starts with. */
const CHESS_START_COUNTS: Record<(typeof CHESS_CAPTURABLE)[number], number> = {
  q: 1,
  r: 2,
  b: 2,
  n: 2,
  p: 8,
};

/** The glyphs a haul is drawn with — Unicode's own chess pieces, hollow for white and solid for
 *  black, which is the typographic convention and the one thing that reads in both themes.
 *
 *  They are TEXT rather than icons, so § Project shape's one-icon-library rule is untouched: no
 *  second glyph set is installed, and a piece scales with the type around it. */
const CHESS_GLYPHS: Record<ChessColor, Record<(typeof CHESS_CAPTURABLE)[number], string>> = {
  w: { q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

/** What each piece is CALLED, for the words a screen reader and a tooltip are handed: a row of
 *  glyphs says nothing to either. */
const CHESS_PIECE_NAMES: Record<(typeof CHESS_CAPTURABLE)[number], [string, string]> = {
  q: ["queen", "queens"],
  r: ["rook", "rooks"],
  b: ["bishop", "bishops"],
  n: ["knight", "knights"],
  p: ["pawn", "pawns"],
};

/** One kind of piece a side has taken, and how many of them. */
export type ChessCapture = { type: (typeof CHESS_CAPTURABLE)[number]; count: number };

/** What a position says about material. */
export type ChessMaterial = {
  /** The men each side has TAKEN, strongest first — so `captured.w` holds BLACK's missing men.
   *  Empty for a side that has taken nothing. */
  captured: Record<ChessColor, ChessCapture[]>;
  /** The material each side still holds, in points. */
  points: Record<ChessColor, number>;
  /** White's points minus black's — positive when white is ahead. */
  advantage: number;
};

const NOTHING: ChessMaterial = {
  captured: { w: [], b: [] },
  points: { w: 0, b: 0 },
  advantage: 0,
};

/**
 * Read a position's material.
 *
 * A FEN this app cannot parse answers NOTHING rather than a guess — the reading `chessPlacementOf`
 * already takes, and for its reason: the only FENs that reach here are ones `chess.js` itself wrote,
 * so a refusal is a bug in the caller. Nothing is drawn from an empty answer, which is also what a
 * board at the starting position gets, and that is right: there is nothing to say yet.
 */
export function chessMaterial(fen: string): ChessMaterial {
  const placement = chessPlacementOf(fen);
  if (!placement) return NOTHING;

  const held: Record<ChessColor, Record<string, number>> = { w: {}, b: {} };
  for (const piece of placement.pieces.values()) {
    if (piece.type === "k") continue;
    held[piece.color][piece.type] = (held[piece.color][piece.type] ?? 0) + 1;
  }

  const captured: Record<ChessColor, ChessCapture[]> = { w: [], b: [] };
  const points: Record<ChessColor, number> = { w: 0, b: 0 };
  for (const color of ["w", "b"] as const) {
    const them = color === "w" ? "b" : "w";
    for (const type of CHESS_CAPTURABLE) {
      const remaining = held[color][type] ?? 0;
      points[color] += remaining * CHESS_PIECE_VALUES[type];
      // What the OTHER side has taken of this piece: the men missing from this one's own set. A
      // promotion can make that negative (white holds two queens), and a piece nobody captured is
      // not something a haul can draw — so it is dropped rather than shown.
      const missing = CHESS_START_COUNTS[type] - remaining;
      if (missing > 0) captured[them].push({ type, count: missing });
    }
  }

  return { captured, points, advantage: points.w - points.b };
}

/** What one side's own seat says: the men they took, and how far up or DOWN they are.
 *
 *  Signed from that side's own point of view, which is why both seats draw a number: `+3` above the
 *  board and `−3` below it is the same fact twice only for somebody reading both at once — and a
 *  player reading their own seat on a phone is not. */
export function chessMaterialFor(
  material: ChessMaterial,
  color: ChessColor,
): { captured: ChessCapture[]; delta: number } {
  return {
    captured: material.captured[color],
    delta: color === "w" ? material.advantage : -material.advantage,
  };
}

/** A haul as the glyphs it is drawn with: one per piece, so three pawns are three glyphs.
 *
 *  `captor` is who TOOK them, so the glyphs wear the other side's colour — the men really are the
 *  opponent's, and drawing a white haul in white's own pieces would say the reader had captured
 *  their own men. */
export function chessCapturedGlyphs(captured: ChessCapture[], captor: ChessColor): string {
  const them: ChessColor = captor === "w" ? "b" : "w";
  return captured.map((entry) => CHESS_GLYPHS[them][entry.type].repeat(entry.count)).join("");
}

/** The same haul in words, for a tooltip and for a screen reader: a row of glyphs says nothing to
 *  either. Empty for a side that has taken nothing, so the caller draws no label at all. */
export function chessCapturedWords(captured: ChessCapture[]): string {
  const parts = captured.map((entry) => {
    const [one, many] = CHESS_PIECE_NAMES[entry.type];
    return `${entry.count} ${entry.count === 1 ? one : many}`;
  });
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) as string}`;
}

/** A material delta as it is drawn: `+3`, `−3` (a real minus sign, not a hyphen), and nothing at
 *  all when the two sides are level — a `0` is a number the reader has to read to learn nothing. */
export function chessDeltaLabel(delta: number): string {
  if (delta === 0) return "";
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
}
