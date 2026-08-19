/**
 * The board: `react-chessboard`, wearing this app's own squares and highlights.
 *
 * It is the second surface in this app drawn by somebody else's renderer, after `@pierre/diffs`
 * for a merge request's patches, and the seam is where the care goes. What is THEIRS is
 * everything a chessboard is judged on and nothing this app has an opinion about: the piece
 * art (proper SVG pieces, which is what a hand-rolled board could not get right — see the note
 * at the foot of this comment), picking a piece up and dropping it, the animation between two
 * positions, and the coordinates down the edges. What stays OURS is the meaning: which square
 * is lit and why, whose turn it is, and whether a press means anything at all.
 *
 * The library holds NO game state. `position` is a FEN the card computes by replaying the
 * thread's own messages (see lib/chess-thread.ts), so the board is still a reading of the
 * history rather than a second copy of the game — which is the property this whole feature
 * rests on. A drop is answered synchronously with "is that legal", and the move travels as a
 * message like every other one.
 *
 * `squareRenderer` is what makes the pair work. It renders INSIDE their own `data-square`
 * element and replaces the styling hook they apply there, so this app draws its own selected
 * ring, legal-move dot, last-move tint and check wash — and carries the data attributes a spec
 * and a capture read. Their `squareStyles` option is deliberately unused: two places styling
 * one square is how the two would drift.
 *
 * The pieces were drawn by hand twice before this and both were wrong. Hugeicons' chess set is
 * several OPEN paths per piece, so `fill` cannot make a solid body out of one; drawn as line
 * art in two inks the two armies read identically at board size. The Unicode glyphs solved
 * that and still looked like text in a grid. A board is a thing people have opinions about,
 * and this one is now drawn by a library whose whole job it is.
 */

import { Chessboard, type PieceDropHandlerArgs, type SquareHandlerArgs } from "react-chessboard";
import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";

/** A square's name, `a1` … `h8`. */
export type ChessSquare = string;

/** Their own spelling of a side, which only this file has to know. */
function orientationOf(color: ChessColor): "white" | "black" {
  return color === "w" ? "white" : "black";
}

export function ChessBoard(props: {
  /** The position, as a FEN — computed from the thread's moves by the card. */
  fen: string;
  /** Which side is at the bottom: the reader's own, or white for somebody watching. */
  orientation: ChessColor;
  /** A board nobody may play — a spectator's, a settled game's — passes null. */
  playable: ChessColor | null;
  selected: ChessSquare | null;
  targets: ChessSquare[];
  lastMove: [ChessSquare, ChessSquare] | null;
  check: ChessSquare | null;
  /** A press on a square: the tap-tap a phone plays with. */
  onSquare?: (square: ChessSquare) => void;
  /** A piece dropped on a square. Answers whether the move was legal, which is what stops
   *  their snap-back animation on a move this app has accepted. */
  onDrop?: (from: ChessSquare, to: ChessSquare) => boolean;
  /** Unique per board on the page: a thread can hold several finished games, and their piece
   *  elements are keyed by it. */
  id: string;
  /** Whether a position change is animated. Off under `prefers-reduced-motion`. */
  animate?: boolean;
}) {
  const targets = new Set(props.targets);

  return (
    <div
      data-testid="chess-board"
      data-orientation={props.orientation}
      // Square whatever width the chat column gives it, and it never grows past the words
      // around it. Their grid is width/height 100% with aspect-ratio squares, so the box is
      // what decides the size.
      className="aspect-square w-full overflow-hidden rounded-lg border border-border-subtle"
    >
      <Chessboard
        options={{
          id: props.id,
          position: props.fen,
          boardOrientation: orientationOf(props.orientation),
          // The app's own board colours, which follow the theme (see styles/theme.css). The
          // pieces do not: "white piece" is a fact about chess.
          lightSquareStyle: { backgroundColor: "var(--chess-light)" },
          darkSquareStyle: { backgroundColor: "var(--chess-dark)" },
          showNotation: true,
          // Their own notation ink is a brown that belongs to their default board; over this
          // app's squares it reads as a third colour nobody chose. Each square's coordinate is
          // drawn in the OTHER square's colour, which is how a board keeps it legible on both.
          lightSquareNotationStyle: { color: "var(--chess-dark)" },
          darkSquareNotationStyle: { color: "var(--chess-light)" },
          alphaNotationStyle: { fontSize: "9px", opacity: 0.9 },
          numericNotationStyle: { fontSize: "9px", opacity: 0.9 },
          // Dragging is offered only to the player whose move it is, and only for their own
          // pieces — the same rule the press follows, so neither gesture can play the other
          // side's move.
          allowDragging: !!props.playable && !!props.onDrop,
          canDragPiece: ({ piece }) => pieceColor(piece.pieceType) === props.playable,
          allowDragOffBoard: false,
          // A board in a virtualized history must not scroll itself under the reader.
          allowAutoScroll: false,
          // Arrows are a feature nobody asked for here, and a right-click that draws one would
          // take the browser's own menu away.
          allowDrawingArrows: false,
          showAnimations: props.animate !== false,
          animationDurationInMs: props.animate === false ? 0 : 180,
          onSquareClick: ({ square }: SquareHandlerArgs) => props.onSquare?.(square),
          onPieceDrop: ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) =>
            !!targetSquare && !!props.onDrop && props.onDrop(sourceSquare, targetSquare),
          // Our own meaning, over their square. It replaces the element they would style from
          // `squareStyles`, so every highlight this app draws lives here and nowhere else.
          squareRenderer: ({ square, piece, children }) => {
            const selected = props.selected === square;
            const target = targets.has(square);
            const moved = props.lastMove?.includes(square) === true;
            return (
              <div
                data-square-state={square}
                data-selected={selected ? "true" : undefined}
                data-target={target ? "true" : undefined}
                data-last-move={moved ? "true" : undefined}
                data-check={props.check === square ? "true" : undefined}
                className={cn(
                  "relative grid size-full place-items-center",
                  // The square the reader picked, and the move that was just played. The pick
                  // is stronger: it is the one the next press acts on.
                  selected && "ring-2 ring-inset ring-primary",
                  moved && !selected && "bg-primary/15",
                  props.check === square && "bg-destructive/40",
                )}
              >
                {children}
                {/* A legal target: a dot on an empty square, a ring around a piece that can be
                    taken — the way every chess board says the difference. It sits ABOVE the
                    piece, because a ring drawn under one is a ring nobody can see. */}
                {target && (
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute",
                      piece
                        ? "inset-0 ring-[3px] ring-inset ring-primary/80"
                        : "size-[26%] rounded-full bg-primary/50",
                    )}
                  />
                )}
              </div>
            );
          },
        }}
      />
    </div>
  );
}

/** Which side a piece belongs to, from their `wP` / `bK` spelling. */
function pieceColor(pieceType: string): ChessColor | null {
  const side = pieceType[0]?.toLowerCase();
  return side === "w" || side === "b" ? side : null;
}
