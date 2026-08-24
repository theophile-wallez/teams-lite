/**
 * The board: `react-chessboard`, wearing chess.com's own squares and this app's own meaning.
 *
 * It is the second surface in this app drawn by somebody else's renderer, after `@pierre/diffs`
 * for a merge request's patches, and the seam is where the care goes. What is THEIRS is
 * everything a chessboard is judged on and nothing this app has an opinion about: the piece
 * art (proper SVG pieces, which is what a hand-rolled board could not get right), picking a
 * piece up and dropping it, the animation between two positions, the coordinates down the edges,
 * and the right-drag that draws an arrow. What stays OURS is the meaning: which square is lit and
 * why, whose turn it is, what a premove looks like, and whether a press means anything at all.
 *
 * The library holds NO game state. `position` is a FEN the caller computes by replaying the
 * thread's own messages (see lib/chess-thread.ts), so the board is still a reading of the
 * history rather than a second copy of the game — which is the property this whole feature
 * rests on. A drop is answered synchronously with "is that legal", and the move travels as a
 * message like every other one.
 *
 * `squareRenderer` is what makes the pair work. It renders INSIDE their own `data-square`
 * element and replaces the styling hook they apply there, so this app draws its own selected
 * ring, legal-move dot, last-move tint, check glow and premove tint — and carries the data
 * attributes a spec and a capture read. Their `squareStyles` option is deliberately unused: two
 * places styling one square is how the two would drift.
 *
 * TWO THINGS ARE WORKED AROUND HERE, and both are the renderer's own DOM rather than its API:
 *
 *   - **Every piece carries `touch-action: none`** (their `Piece`, inline, not overridable
 *     through any option), which is right for a board that owns its screen and wrong for one
 *     sitting in a scrolling history: a finger landing on any of the 32 pieces could not scroll
 *     the conversation, which is most of the width of a phone. `scrollable` frees it (see the
 *     rule in styles/app.css) and turns touch dragging off with it, so the card is played by
 *     TAP-TAP on a phone and by dragging with a mouse, and the history scrolls either way.
 *   - **Every piece is a dnd-kit draggable**, which spreads `role="button" tabIndex={0}` onto
 *     its wrapper — 32 tab stops per board, each one a thing a browser can scroll INTO view.
 *     They are taken out of the tab order here, because the board is played by pressing squares
 *     and a piece is not a control.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  Chessboard,
  defaultArrowOptions,
  defaultPieces,
  type PieceDropHandlerArgs,
  type SquareHandlerArgs,
} from "react-chessboard";
import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";

/** A square's name, `a1` … `h8`. */
export type ChessSquare = string;

/** What a promotion is waiting on: the move, and whose pieces to offer. */
export type ChessPromotionPrompt = { from: ChessSquare; to: ChessSquare; color: ChessColor };

/** The four pieces a pawn may become, in the order every chess board offers them. */
export const PROMOTION_PIECES = ["q", "n", "r", "b"] as const;
export type ChessPromotionPiece = (typeof PROMOTION_PIECES)[number];

const PROMOTION_LABEL: Record<ChessPromotionPiece, string> = {
  q: "Queen",
  n: "Knight",
  r: "Rook",
  b: "Bishop",
};

/** Their own spelling of a side, which only this file has to know. */
function orientationOf(color: ChessColor): "white" | "black" {
  return color === "w" ? "white" : "black";
}

export function ChessBoard(props: {
  /** The position, as a FEN — computed from the thread's moves by the caller. */
  fen: string;
  /** Which side is at the bottom: the reader's own, or white for somebody watching. */
  orientation: ChessColor;
  /** A board nobody may play — a spectator's, a settled game's, one being read at an earlier
   *  ply — passes null. */
  playable: ChessColor | null;
  selected: ChessSquare | null;
  targets: ChessSquare[];
  lastMove: [ChessSquare, ChessSquare] | null;
  check: ChessSquare | null;
  /** The move the reader has queued for the moment their opponent's lands. Drawn in its own
   *  tint, because a premove is not a move that has happened. */
  premove: [ChessSquare, ChessSquare] | null;
  /** A press on a square: the tap-tap a phone plays with. */
  onSquare?: (square: ChessSquare) => void;
  /** A piece dropped on a square. Answers whether the move was legal, which is what stops
   *  their snap-back animation on a move this app has accepted. */
  onDrop?: (from: ChessSquare, to: ChessSquare) => boolean;
  /** A right press with no drag — how a premove and a selection are cancelled. */
  onRightClick?: (square: ChessSquare) => void;
  /** Unique per board on the page: a thread can hold several finished games, and their piece
   *  elements are keyed by it. */
  id: string;
  /** Whether a position change is animated. Off under `prefers-reduced-motion`. */
  animate?: boolean;
  /** Whether a right-drag draws an ARROW. Off in the history, where the browser's own menu is
   *  worth more than an annotation nobody asked for; on where a reader is thinking. */
  arrows?: boolean;
  /** Whether a TOUCH over this board scrolls the page instead of dragging a piece. True for a
   *  board inside the scrolling history — see the note at the top of this file. */
  scrollable?: boolean;
  /** A promotion waiting to be chosen, drawn over the square the pawn is landing on. */
  promotion?: ChessPromotionPrompt | null;
  onPromote?: (piece: ChessPromotionPiece) => void;
  onPromotionCancel?: () => void;
}) {
  const targets = new Set(props.targets);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // The renderer's pieces are dnd-kit draggables, and dnd-kit puts `tabIndex={0}` on each. The
  // wrappers are taken out of the tab order after every render: React only re-applies the
  // attribute when its own value changes (which happens while a drag starts), and the effect
  // runs again then.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    for (const piece of box.querySelectorAll<HTMLElement>("[data-piece]")) {
      const wrapper = piece.parentElement;
      if (wrapper?.getAttribute("tabindex") === "0") wrapper.setAttribute("tabindex", "-1");
    }
  });

  // Dragging is offered only to the player whose move it is, and never by TOUCH on a board that
  // has to let the history scroll under it.
  const dragging = !!props.playable && !!props.onDrop && !props.scrollable;

  // Their own defaults with this app's inks over them: the geometry of an arrow (its width, its
  // head, how much it is shortened) is theirs and this app has no opinion about it — only the
  // colour, which must not be the yellow the board's own highlights wear.
  const arrowOptions = useMemo(
    () => ({
      ...defaultArrowOptions,
      colors: {
        default: "var(--chess-arrow)",
        shift: "var(--chess-arrow-alt)",
        ctrl: "var(--chess-arrow-alt)",
        alt: "var(--chess-arrow-alt)",
        meta: "var(--chess-arrow-alt)",
      },
    }),
    [],
  );

  return (
    <div
      ref={boxRef}
      data-testid="chess-board"
      data-orientation={props.orientation}
      data-scrollable={props.scrollable ? "true" : undefined}
      // Square whatever width the box gives it, and it never grows past it. Their grid is
      // width/height 100% with aspect-ratio squares, so the box is what decides the size.
      className="relative aspect-square w-full overflow-hidden rounded-lg border border-chess-edge"
    >
      <Chessboard
        options={{
          id: props.id,
          position: props.fen,
          boardOrientation: orientationOf(props.orientation),
          // CHESS.COM'S OWN SQUARES, in both themes (see styles/theme.css). A board is a board
          // rather than a surface of this app, which is the one place this feature stops
          // following the appearance setting — the cost, and the reason, are stated there.
          lightSquareStyle: { backgroundColor: "var(--chess-light)" },
          darkSquareStyle: { backgroundColor: "var(--chess-dark)" },
          showNotation: true,
          // Their own notation ink is a brown that belongs to their default board. Each square's
          // coordinate is drawn in the OTHER square's colour, which is how a board keeps it
          // legible on both.
          lightSquareNotationStyle: { color: "var(--chess-dark)" },
          darkSquareNotationStyle: { color: "var(--chess-light)" },
          alphaNotationStyle: { fontSize: "9px", opacity: 0.9 },
          numericNotationStyle: { fontSize: "9px", opacity: 0.9 },
          allowDragging: dragging,
          canDragPiece: ({ piece }) => pieceColor(piece.pieceType) === props.playable,
          allowDragOffBoard: false,
          // A board inside a virtualized history must not scroll itself under the reader.
          allowAutoScroll: false,
          // The reader's own arrows, drawn by a right-drag — the renderer's own gesture, so
          // nothing here reimplements one. A left click clears them, exactly as it does on
          // chess.com and lichess, and a new position clears them too.
          allowDrawingArrows: props.arrows === true,
          clearArrowsOnClick: true,
          clearArrowsOnPositionChange: true,
          arrowOptions,
          showAnimations: props.animate !== false,
          animationDurationInMs: props.animate === false ? 0 : 180,
          onSquareClick: ({ square }: SquareHandlerArgs) => props.onSquare?.(square),
          onSquareRightClick: ({ square }: SquareHandlerArgs) => props.onRightClick?.(square),
          onPieceDrop: ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) =>
            !!targetSquare && !!props.onDrop && props.onDrop(sourceSquare, targetSquare),
          // Our own meaning, over their square. It replaces the element they would style from
          // `squareStyles`, so every highlight this app draws lives here and nowhere else.
          squareRenderer: ({ square, piece, children }) => {
            const selected = props.selected === square;
            const target = targets.has(square);
            const moved = props.lastMove?.includes(square) === true;
            const premoved = props.premove?.includes(square) === true;
            return (
              <div
                data-square-state={square}
                data-selected={selected ? "true" : undefined}
                data-target={target ? "true" : undefined}
                data-last-move={moved ? "true" : undefined}
                data-premove={premoved ? "true" : undefined}
                data-check={props.check === square ? "true" : undefined}
                className={cn(
                  "relative grid size-full place-items-center",
                  // The square the reader picked, and the move that was just played, in the
                  // yellow every board uses for both. A PREMOVE is its own colour, because a
                  // move the reader has only decided on is not a move that has happened.
                  (selected || moved) && "bg-chess-highlight",
                  premoved && !selected && "bg-chess-premove",
                  // Check is a glow out of the king's own square rather than a flat wash: flat,
                  // it reads as one more highlight in a board that already has two.
                  props.check === square && "chess-check",
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
                        ? "inset-0 rounded-[2px] ring-[4px] ring-inset ring-chess-target"
                        : "size-[28%] rounded-full bg-chess-target",
                    )}
                  />
                )}
              </div>
            );
          },
        }}
      />
      {props.promotion && (
        <PromotionPicker
          prompt={props.promotion}
          orientation={props.orientation}
          onPick={props.onPromote}
          onCancel={props.onPromotionCancel}
        />
      )}
    </div>
  );
}

/**
 * WHAT THE PAWN BECOMES, asked over the square it is landing on.
 *
 * It used to be four words in a row under the board, which is the one shape a chess player never
 * meets: a promotion is a choice between four PIECES, and reading "Knight" and mapping it back
 * onto the board is work nobody does at a real board. So it is chess.com's own shape — a column
 * of four pieces standing on the promotion square, the strongest at the top, drawn with the
 * renderer's own art so the queen in the picker is the queen that lands.
 *
 * Three rules, and each is pinned by a test:
 *   - it is drawn INSIDE the board, over the file the pawn is on, which is what makes it a choice
 *     about that pawn rather than a dialog about the game;
 *   - the picker is dismissed by pressing anywhere else, and by Escape, because a promotion the
 *     reader changed their mind about must not need a fifth control to abandon;
 *   - the old testids (`chess-promote-q` …) are kept, so what every existing assertion MEANS
 *     survives the change of shape.
 */
function PromotionPicker(props: {
  prompt: ChessPromotionPrompt;
  orientation: ChessColor;
  onPick?: (piece: ChessPromotionPiece) => void;
  onCancel?: () => void;
}) {
  const file = props.prompt.to.charCodeAt(0) - 97;
  const rank = Number(props.prompt.to[1]) - 1;
  // The column stands on the promotion square and grows DOWN the board from the reader's own
  // side, so it is never drawn off the top of an eight-square grid.
  const column = props.orientation === "w" ? 7 - file : file;
  const fromTop = props.orientation === "w" ? 7 - rank : rank;
  // Four pieces from that square, folded back when the square is too near the far edge.
  const grows = fromTop <= 4;
  const left = props.orientation === "w" ? file : 7 - file;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onCancel?.();
      }
    };
    // Capture, so the app shell's own Escape does not also close the conversation behind it —
    // one Escape does one thing (see lib/platform.ts).
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [props]);

  return (
    <div
      data-testid="chess-promotion"
      // Everything outside the column dismisses. It is a press the reader can really see, which
      // is what makes it a better exit than a Cancel button in a five-item column.
      className="absolute inset-0 z-10 bg-black/40"
      onClick={() => props.onCancel?.()}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onCancel?.();
      }}
    >
      <div
        className={cn(
          "absolute flex flex-col overflow-hidden rounded-md bg-panel shadow-lg ring-1 ring-chess-edge",
          grows ? "top-0" : "bottom-0",
        )}
        style={{
          left: `${left * 12.5}%`,
          width: "12.5%",
          [grows ? "top" : "bottom"]: `${(grows ? fromTop : 7 - fromTop) * 12.5}%`,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {(grows ? PROMOTION_PIECES : [...PROMOTION_PIECES].reverse()).map((piece) => {
          const Art = defaultPieces[`${props.prompt.color}${piece.toUpperCase()}`];
          return (
            <button
              key={piece}
              type="button"
              data-testid={`chess-promote-${piece}`}
              title={PROMOTION_LABEL[piece]}
              aria-label={`Promote to ${PROMOTION_LABEL[piece]}`}
              onClick={() => props.onPick?.(piece)}
              className="grid aspect-square w-full place-items-center bg-chess-light p-0.5 transition-colors hover:bg-chess-highlight"
            >
              {Art ? <Art /> : piece.toUpperCase()}
            </button>
          );
        })}
      </div>
      {/* The column is drawn over one file; nothing else about the board is dimmed away, so the
          reader can still see the position they are promoting into. */}
      <span aria-hidden className="hidden" data-chess-promotion-column={column} />
    </div>
  );
}

/** Which side a piece belongs to, from their `wP` / `bK` spelling. */
function pieceColor(pieceType: string): ChessColor | null {
  const side = pieceType[0]?.toLowerCase();
  return side === "w" || side === "b" ? side : null;
}
