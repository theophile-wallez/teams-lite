/**
 * The score sheet, and the four controls that walk through it.
 *
 * It is the right column of the chess page and it is a real score sheet: one row per MOVE with
 * white's and black's plies beside each other, the clock each was played on, and the ply the
 * reader is looking at marked. Pressing one goes there, which is the same thing the arrow keys do
 * — one machine (`use-chess-game.ts`) behind both, so the list and the board can never disagree
 * about which position is on screen.
 *
 * Two things it owes the reader beyond the list:
 *   - **it FOLLOWS the game** while they are at the live position, and stops following the moment
 *     they walk back — a list that scrolled itself while somebody was reading move 4 of 40 would
 *     take the thing they are reading away;
 *   - **the four controls are labelled by what they DO**, at the touch floor, because this page is
 *     read on a phone too and a 16px chevron four pixels from another is a mis-tap.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeftDoubleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowRightDoubleIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useRef } from "react";
import { formatChessClock } from "~/lib/chess-clock";
import { cn } from "~/lib/utils";

export type ChessScoreMove = { ply: number; san: string; clockMs: number | null };

/** One row of the sheet: the move number, and the ply each side played. */
type Row = { number: number; white: ChessScoreMove | null; black: ChessScoreMove | null };

export function chessScoreRows(moves: ChessScoreMove[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({
      number: i / 2 + 1,
      white: moves[i] ?? null,
      black: moves[i + 1] ?? null,
    });
  }
  return rows;
}

export function ChessScoreSheet(props: {
  moves: ChessScoreMove[];
  /** Which ply is on screen — 0 is the starting position. */
  viewPly: number;
  atLive: boolean;
  onGoTo: (ply: number) => void;
  className?: string;
}) {
  const rows = useMemo(() => chessScoreRows(props.moves), [props.moves]);
  const scroller = useRef<HTMLDivElement | null>(null);

  // It follows the newest move only while the reader has not walked back — the rule the agent's
  // transcript panel already holds, and for its reason.
  useEffect(() => {
    if (!props.atLive) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [props.atLive, props.moves.length]);

  return (
    <section
      data-testid="chess-score-sheet"
      className={cn("flex min-h-0 flex-col border-b border-border-subtle", props.className)}
    >
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-xs text-text-faint">No moves yet.</p>
        ) : (
          <table className="w-full border-collapse text-xs tabular-nums">
            <tbody>
              {rows.map((row) => (
                <tr key={row.number} className="border-b border-border-subtle/50 last:border-0">
                  <td className="w-8 select-none py-1 pl-3 pr-1 text-right text-[11px] text-text-faint">
                    {row.number}.
                  </td>
                  <PlyCell move={row.white} viewPly={props.viewPly} onGoTo={props.onGoTo} />
                  <PlyCell move={row.black} viewPly={props.viewPly} onGoTo={props.onGoTo} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function PlyCell(props: {
  move: ChessScoreMove | null;
  viewPly: number;
  onGoTo: (ply: number) => void;
}) {
  const move = props.move;
  if (!move) return <td className="py-1" />;
  const current = props.viewPly === move.ply;
  return (
    <td className="py-0.5">
      <button
        type="button"
        data-testid={`chess-ply-${move.ply}`}
        data-current={current ? "true" : undefined}
        onClick={() => props.onGoTo(move.ply)}
        className={cn(
          "flex w-full items-baseline justify-between gap-1 rounded px-1.5 py-1 text-left transition-colors",
          current ? "bg-primary/15 font-semibold text-foreground" : "text-text-dim hover:bg-accent",
        )}
      >
        <span className="truncate">{move.san}</span>
        {/* What the mover had left when they played it — the half of a score sheet an online game
            has that a paper one does not, and the one that says where the time went. */}
        {move.clockMs !== null && (
          <span className="shrink-0 font-mono text-[10px] text-text-faint">
            {formatChessClock(move.clockMs)}
          </span>
        )}
      </button>
    </td>
  );
}

/** First, back, forward, live. Four presses that are also four keys (see the page). */
export function ChessMoveNav(props: {
  viewPly: number;
  plies: number;
  atLive: boolean;
  onGoTo: (ply: number) => void;
  onStep: (delta: number) => void;
  className?: string;
}) {
  const atStart = props.viewPly === 0;
  return (
    <div
      data-testid="chess-move-nav"
      className={cn("flex items-center justify-center gap-1", props.className)}
    >
      <NavButton
        testId="chess-nav-first"
        label="The starting position"
        icon={ArrowLeftDoubleIcon}
        disabled={atStart}
        onClick={() => props.onGoTo(0)}
      />
      <NavButton
        testId="chess-nav-prev"
        label="The move before"
        icon={ArrowLeft01Icon}
        disabled={atStart}
        onClick={() => props.onStep(-1)}
      />
      <NavButton
        testId="chess-nav-next"
        label="The move after"
        icon={ArrowRight01Icon}
        disabled={props.atLive}
        onClick={() => props.onStep(1)}
      />
      <NavButton
        testId="chess-nav-live"
        label="The position now"
        icon={ArrowRightDoubleIcon}
        disabled={props.atLive}
        onClick={() => props.onGoTo(props.plies)}
      />
    </div>
  );
}

function NavButton(props: {
  testId: string;
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      // The touch floor, which every control this app draws for a thumb clears.
      className="grid size-11 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
    >
      <HugeiconsIcon icon={props.icon} className="size-5" strokeWidth={1.8} />
    </button>
  );
}
