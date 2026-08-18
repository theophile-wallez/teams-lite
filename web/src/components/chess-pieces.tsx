/**
 * One glyph per piece per colour, and the ONE place the choice of art lives.
 *
 * **The pieces are the Unicode chess glyphs, and hugeicons was tried first.** § Project shape
 * says every glyph comes from `@hugeicons/core-free-icons`, and that set does ship a complete
 * chess set — but it cannot do the one thing a board needs, which is to tell two armies apart:
 *
 *   - a hugeicons piece is several OPEN paths (a pawn is its base, two curves and a bare line),
 *     so `fill` cannot make a solid body out of one: each subpath fills to its own implied
 *     closure and the pawn comes out as a lens and a smear;
 *   - drawn instead as line art in two inks — a heavier halo behind, the piece's own colour on
 *     top — both sides came out looking identical at board size. That was captured, looked at,
 *     and rejected: a chessboard whose black and white pieces read the same is not a chessboard.
 *
 * So the pieces are `♚♛♜♝♞♟` — the SOLID glyphs, for both sides — coloured near-white or
 * near-black, with a thin outline in the opposite ink. Solid bodies in two inks are unambiguous
 * at any size, which is the whole job. The rule that matters is kept: no second icon PACKAGE is
 * installed, `icon-library.test.ts` still passes, and every glyph in the app's own chrome is
 * still hugeicons'. Board art is not a row of UI icons.
 *
 * The HOLLOW glyphs (`♔♕♖♗♘♙`) are deliberately not used for white: they are outlines, so they
 * disappear on a light square and reintroduce the very problem above.
 *
 * The two inks are FIXED rather than themed, and that is deliberate: "white piece" is a fact
 * about chess, not an appearance preference, and a set that swapped sides with the app's theme
 * would be a board whose armies change colour under the reader. The SQUARES follow the theme
 * (see chess-board.tsx); the pieces do not.
 *
 * Every piece names itself for a screen reader, because a board drawn in glyphs says nothing to
 * somebody who cannot see it.
 */

import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";

/** chess.js's own lowercase piece letters, so no translation is needed between the two. */
export type ChessPieceKind = "k" | "q" | "r" | "b" | "n" | "p";

/** The SOLID glyphs. Both colours use these; the ink is what says which side. */
const GLYPH: Record<ChessPieceKind, string> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

const NAME: Record<ChessPieceKind, string> = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};

/** The two inks, and the outline each is read against. Near-white and near-black rather than
 *  pure: pure white on a light square is a piece with no edge at all. */
const INK: Record<ChessColor, { piece: string; edge: string }> = {
  w: { piece: "#fbfbfa", edge: "#1c1917" },
  b: { piece: "#1c1917", edge: "#f5f5f4" },
};

/** A 1px outline all the way round, so either ink reads on either square colour. Four offsets
 *  rather than a filter: a shadow costs no compositing layer in a virtualized history. */
function outline(edge: string): string {
  return `-1px 0 0 ${edge}, 1px 0 0 ${edge}, 0 -1px 0 ${edge}, 0 1px 0 ${edge}`;
}

export function ChessPiece(props: {
  kind: ChessPieceKind;
  color: ChessColor;
  className?: string;
}) {
  const ink = INK[props.color];
  return (
    <span
      role="img"
      aria-label={`${props.color === "w" ? "White" : "Black"} ${NAME[props.kind]}`}
      data-piece={`${props.color}${props.kind}`}
      // `select-none` because a board is dragged and tapped, and a glyph that highlights under
      // a drag reads as text somebody is selecting. The size is a share of the square, so one
      // board scales from a phone to a desktop with no second number anywhere.
      className={cn(
        "pointer-events-none block select-none text-center leading-none",
        props.className,
      )}
      style={{
        color: ink.piece,
        textShadow: outline(ink.edge),
        fontSize: "min(7.6vw, 2.15rem)",
        // A text-presentation stack: some systems render these glyphs from an emoji font, which
        // would draw a colourful picture instead of a piece and lose the ink entirely.
        fontFamily:
          '"DejaVu Sans", "FreeSerif", "Noto Sans Symbols 2", "Segoe UI Symbol", serif',
        fontVariantEmoji: "text",
        // Grayscale antialiasing: subpixel rendering puts a red-and-blue fringe round a glyph
        // this large, which on a board reads as a piece drawn badly rather than as text.
        WebkitFontSmoothing: "antialiased",
        MozOsxFontSmoothing: "grayscale",
      }}
    >
      {GLYPH[props.kind]}
    </span>
  );
}
