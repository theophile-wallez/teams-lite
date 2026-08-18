/**
 * The board: eight by eight, presentational and controlled.
 *
 * It holds no chess knowledge and no state — what is legal, what is selected and what a
 * press means are the card's answers (see chess-game-card.tsx), which is what keeps chess.js
 * out of this file and out of the path of a chat. It draws what it is handed, in the
 * orientation it is given.
 *
 * A square is a BUTTON only where there is something to press: a spectator's board, and a
 * board whose game is over, are a grid of squares rather than a grid of controls — the rule
 * every other control in this app follows, that one which cannot do the thing it names is
 * worse than none.
 */

import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";
import { ChessPiece, type ChessPieceKind } from "./chess-pieces";

/** A square's name, `a1` … `h8`. */
export type ChessSquare = string;

export type ChessBoardSquare = {
  square: ChessSquare;
  piece: { kind: ChessPieceKind; color: ChessColor } | null;
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Every square in a1…h8 order, so a caller can build a full board from a sparse position. */
export function emptyChessSquares(): ChessBoardSquare[] {
  const out: ChessBoardSquare[] = [];
  for (const rank of RANKS) {
    for (const file of FILES) out.push({ square: `${file}${rank}`, piece: null });
  }
  return out;
}

export function ChessBoard(props: {
  /** a1…h8, rank-major. Squares the caller omits are drawn empty. */
  squares: ChessBoardSquare[];
  orientation: ChessColor;
  selected: ChessSquare | null;
  targets: ChessSquare[];
  lastMove: [ChessSquare, ChessSquare] | null;
  check: ChessSquare | null;
  onSquare?: (square: ChessSquare) => void;
}) {
  const bySquare = new Map(props.squares.map((s) => [s.square, s]));
  // The reader's own side at the bottom, which is the one thing every chess board does.
  const ranks = props.orientation === "w" ? [...RANKS].reverse() : [...RANKS];
  const files = props.orientation === "w" ? [...FILES] : [...FILES].reverse();
  const targets = new Set(props.targets);

  return (
    <div
      data-testid="chess-board"
      data-orientation={props.orientation}
      // The board is square whatever width the chat column gives it, and it never grows past
      // the words around it.
      className="grid aspect-square w-full grid-cols-8 overflow-hidden rounded-lg border border-border-subtle"
    >
      {ranks.map((rank) =>
        files.map((file) => {
          const name = `${file}${rank}`;
          const cell = bySquare.get(name);
          const light = (FILES.indexOf(file) + rank) % 2 === 1;
          const selected = props.selected === name;
          const target = targets.has(name);
          const moved = props.lastMove?.includes(name) === true;
          const label = cell?.piece
            ? `${name}, ${cell.piece.color === "w" ? "white" : "black"} ${cell.piece.kind}`
            : name;
          const shared = {
            "data-square": name,
            "data-selected": selected ? "true" : undefined,
            "data-target": target ? "true" : undefined,
            "data-last-move": moved ? "true" : undefined,
            "aria-label": label,
            className: cn(
              "relative grid place-items-center",
              light ? "bg-chess-light" : "bg-chess-dark",
              // The square the reader picked, and the move that was just played. The pick is
              // stronger: it is the one the next press acts on.
              selected && "ring-2 ring-inset ring-primary",
              moved && !selected && "ring-1 ring-inset ring-primary/40",
              props.check === name && "bg-destructive/40",
            ),
          };
          const contents = (
            <>
              {cell?.piece && <ChessPiece kind={cell.piece.kind} color={cell.piece.color} />}
              {/* A legal target: a dot on an empty square, a ring around a piece that can be
                  taken — the way every chess board says the difference. */}
              {target && (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute",
                    cell?.piece
                      ? "inset-0 ring-[3px] ring-inset ring-primary/70"
                      : "size-[24%] rounded-full bg-primary/60",
                  )}
                />
              )}
            </>
          );
          return props.onSquare ? (
            <button key={name} type="button" onClick={() => props.onSquare?.(name)} {...shared}>
              {contents}
            </button>
          ) : (
            <div key={name} {...shared}>
              {contents}
            </div>
          );
        }),
      )}
    </div>
  );
}
