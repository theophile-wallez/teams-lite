/**
 * One game of chess, drawn as a row in the history where it was started.
 *
 * This is the card in the CONVERSATION, and everything about it is bounded by that: it sits in a
 * virtualized history a phone's column wide, between things people said, so it is a board the
 * reader can play a move on and read a clock off — and nothing more. The whole experience is one
 * press away, on the game's own page (§ The chess PAGE), and this card is what points there.
 *
 * What it deliberately does NOT do, and why:
 *   - **no sound.** A conversation that clicked at every move of every game in it is one nobody
 *     can read in an open-plan office. The page has the sounds, because that is where a reader is
 *     playing rather than reading.
 *   - **no arrows.** A right-drag here would take the browser's own menu away from a message
 *     thread, which is a worse trade than an annotation nobody asked for.
 *   - **no touch dragging.** A finger over this board scrolls the CONVERSATION (see
 *     `scrollable` in chess-board.tsx): the history is what the reader is holding, and a board
 *     that ate the scroll made half the width of a phone unscrollable. Moves are played by
 *     tap-tap there, and by dragging with a mouse.
 *
 * The logic is `use-chess-game.ts`, shared with the page, so the two can never disagree about what
 * a press means.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpand01Icon, CpuIcon } from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import { useReducedMotion } from "motion/react";
import { useState } from "react";
import { formatChessClock } from "~/lib/chess-clock";
import { chessPagePath } from "~/lib/chess-menu";
import {
  chessAwaitsOurAnswer,
  chessAwaitsTheirAnswer,
  chessGameIsOver,
  chessGameIsSettled,
  chessPlayerOf,
  type ChessGame,
  type ChessPlayer,
} from "~/lib/chess-thread";
import { clockWords, type ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { ChessBoard } from "./chess-board";
import { useOptionalController } from "./controller-context";
import { useChessGame } from "./use-chess-game";

export default function ChessGameCard(props: {
  game: ChessGame;
  conversationId: string;
  className?: string;
}) {
  const controller = useOptionalController();
  // Safe with no router around it: the hook reads a context that is simply absent in a
  // server-rendered test, and only the callback would need one (see tracker-ref-chip.tsx).
  const navigate = useNavigate();
  const [armedResign, setArmedResign] = useState(false);
  // A position change is animated by the renderer; a reader who asked for no motion gets none.
  const reduceMotion = useReducedMotion();
  const board = useChessGame({
    game: props.game,
    conversationId: props.conversationId,
    sounds: false,
  });
  const game = board.game;

  // A challenge waiting for an answer, and WHOSE answer it is. These two are the whole of the
  // challenged player's experience: without them their side of a fresh challenge is a board with
  // nothing to press, which is what the mock's own auto-accept once hid.
  const awaitingUs = !!controller && chessAwaitsOurAnswer(game);
  const awaitingThem = !!controller && chessAwaitsTheirAnswer(game);

  return (
    <article
      data-testid="chess-game"
      data-chess-game={game.id}
      className={cn(
        "mx-auto w-full max-w-80 rounded-xl border border-border-subtle bg-panel p-3",
        props.className,
      )}
    >
      <ChessSeat
        game={game}
        color={other(board.orientation)}
        clock={board.clock}
        engine={!!board.engine}
        thinking={board.engineThinking}
      />
      <ChessBoard
        id={`chess-${game.id}`}
        fen={board.fen}
        orientation={board.orientation}
        playable={board.ourMove ? game.ourColor : null}
        selected={board.selected}
        targets={board.targets}
        lastMove={board.lastMove}
        check={board.check}
        premove={board.premove}
        promotion={board.promotion}
        onPromote={board.promote}
        onPromotionCancel={board.cancelPromotion}
        animate={!reduceMotion}
        // The history is what the reader is holding: a touch here scrolls the conversation.
        scrollable
        arrows={false}
        {...(controller ? { onSquare: board.press, onDrop: board.drop, onRightClick: board.rightClick } : {})}
      />
      <ChessSeat game={game} color={board.orientation} clock={board.clock} />

      <p data-testid="chess-status" className="mt-1 text-xs text-text-dim">
        {board.status}
      </p>

      {board.moves.length > 0 && (
        <p
          data-testid="chess-moves"
          // One scrollable line of pairs, UNDER the board: this card sits in a chat column that is
          // a phone's width at its narrowest, and a second column beside the board would take the
          // board down to nothing. The PAGE is where the score sheet has room to be a column.
          className="mt-1 overflow-x-auto whitespace-nowrap text-[11px] text-text-faint"
        >
          {scoreSheetLine(board.moves.map((m) => m.san))}
        </p>
      )}

      {board.error && (
        <p data-testid="chess-error" className="mt-1 text-[11px] text-destructive">
          {board.error}
        </p>
      )}

      {/* Somebody challenged the reader. This is the one state where the card asks for an answer
          rather than a move, so it says WHO asked and offers both answers — a challenge nobody can
          decline would sit in the conversation for ever. */}
      {awaitingUs && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="chess-accept"
            onClick={() => board.act({ kind: "join" })}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
          >
            Accept — play {game.challengerColor === "w" ? "black" : "white"}
          </button>
          <button
            type="button"
            data-testid="chess-decline"
            onClick={() => board.act({ kind: "decline" })}
            className={SECONDARY}
          >
            Not now
          </button>
          {game.time && (
            <span data-testid="chess-time-control" className="text-[11px] text-text-faint">
              {clockWords(game.time)}
            </span>
          )}
        </div>
      )}

      {/* The challenger's own side of that wait: they can take the offer back, which is what frees
          the board for another game. */}
      {awaitingThem && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="chess-withdraw"
            onClick={() => board.act({ kind: "resign" })}
            className={SECONDARY}
          >
            Withdraw the challenge
          </button>
          {game.time && (
            <span data-testid="chess-time-control" className="text-[11px] text-text-faint">
              {clockWords(game.time)}
            </span>
          )}
        </div>
      )}

      {board.canAct && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* A clock that has run out is claimed rather than taken: nothing here ends a game on a
              timer, because no machine's clock can be trusted over another's. */}
          {board.flagClaimable && !board.engine && (
            <button
              type="button"
              data-testid="chess-claim-flag"
              onClick={() => board.act({ kind: "flag" })}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
            >
              Claim the win on time
            </button>
          )}
          <button
            type="button"
            data-testid="chess-resign"
            // The user asks twice: a resignation ends the game and no later message takes it
            // back. Delete's own arming pattern.
            onClick={() => {
              if (!armedResign) {
                setArmedResign(true);
                return;
              }
              setArmedResign(false);
              board.act({ kind: "resign" });
            }}
            className={SECONDARY}
          >
            {armedResign ? "Resign — nothing takes it back" : "Resign"}
          </button>
          {board.engine ? null : game.drawOfferedBy && game.drawOfferedBy !== game.ourColor ? (
            <button
              type="button"
              data-testid="chess-draw-accept"
              onClick={() => board.act({ kind: "drawAccept" })}
              className={SECONDARY}
            >
              Accept the draw
            </button>
          ) : (
            <button
              type="button"
              data-testid="chess-draw"
              disabled={game.drawOfferedBy === game.ourColor}
              onClick={() => board.act({ kind: "draw" })}
              className={cn(SECONDARY, "disabled:pointer-events-none disabled:opacity-50")}
            >
              {game.drawOfferedBy === game.ourColor ? "Draw offered" : "Offer a draw"}
            </button>
          )}
        </div>
      )}

      {/* THE WAY IN. Everything this card leaves out — the score sheet as a column, the moves
          walked back through, the arrows, the sounds, the chat beside the board — is one press
          away, and the press is a LINK rather than a button: the browser's own affordances
          (the status bar, a middle click, "copy link") are worth keeping on the one control that
          changes the address. */}
      <a
        href={chessPagePath(props.conversationId, game.id)}
        data-testid="chess-open-page"
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-border-subtle px-2 py-1 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        onClick={(event) => {
          // Every modified click is the browser's: a new tab, a new window. Only a plain left
          // press is ours to keep inside the app — the rule a tracker reference already holds.
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          void navigate({ to: chessPagePath(props.conversationId, game.id) });
        }}
      >
        <HugeiconsIcon icon={ArrowExpand01Icon} className="size-3.5" strokeWidth={1.8} />
        {chessGameIsOver(game) ? "Review the game" : "Open the board"}
      </a>
    </article>
  );
}

const SECONDARY =
  "rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground";

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}

/**
 * One side of the board: who is playing it, and what their clock reads.
 *
 * Drawn above and below the board the way a board is read, and the face and the name are the
 * app's own — so a colleague the user renamed is named here exactly as they are above their own
 * bubbles.
 *
 * A seat NOBODY holds is drawn as an empty seat rather than as a person: no initials, because
 * tinted initials are how this app draws a colleague it has no photo for and "Nobody yet" reduced
 * to `NY` is ink that names nothing. And it says WHOSE it is from the reader's own position — the
 * seat opposite a challenger is the reader's to take.
 */
export function ChessSeat(props: {
  game: ChessGame;
  color: ChessColor;
  clock: { white: number | null; black: number | null; running: ChessColor | null; flagged: ChessColor | null };
  /** A page draws the same seat larger, because it has the room for it. */
  big?: boolean;
  /** Whether THIS seat is the engine's. */
  engine?: boolean;
  /** Whether it is searching right now — the one thing a seat says that a clock cannot. */
  thinking?: boolean;
}) {
  const player: ChessPlayer | null = chessPlayerOf(props.game, props.color);
  // Not the controller's question: whether a press would WORK is the board's, and whether the seat
  // is the reader's is a fact about the game. A settled challenge is nobody's to take.
  const oursToTake = !player && !props.game.challenger.isSelf && !chessGameIsSettled(props.game);
  const ms = props.color === "w" ? props.clock.white : props.clock.black;
  const running = props.clock.running === props.color;
  const flagged = props.clock.flagged === props.color;
  return (
    <header className={cn("flex items-center gap-2 py-1.5", props.big && "gap-3 py-2")}>
      {props.engine && player ? (
        // THE ENGINE IS NOT A PERSON, so it is not drawn as one: an avatar seeded from an empty MRI
        // would be tinted initials for a colleague who does not exist, and this app never puts a
        // face on something that has none.
        <span
          data-testid="chess-engine-seat"
          aria-hidden
          className={cn(
            "grid shrink-0 place-items-center rounded-md border border-border-subtle bg-accent text-text-dim",
            props.big ? "size-8" : "size-6",
          )}
        >
          <HugeiconsIcon icon={CpuIcon} className={props.big ? "size-5" : "size-4"} strokeWidth={1.8} />
        </span>
      ) : player ? (
        <Avatar
          seed={player.mri}
          label={player.name}
          photo={{ kind: "user", id: player.mri }}
          className={props.big ? "size-8" : "size-6"}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "shrink-0 rounded-full border border-dashed border-border-subtle",
            props.big ? "size-8" : "size-6",
          )}
        />
      )}
      <span
        className={cn(
          "truncate font-medium",
          props.big ? "text-sm" : "text-xs",
          player ? "text-foreground" : "text-text-dim",
        )}
      >
        {player ? (player.isSelf ? "You" : player.name) : oursToTake ? "You, if you accept" : "Waiting for somebody"}
      </span>
      {props.thinking && (
        <span data-testid="chess-engine-thinking" className="shrink-0 text-[11px] text-text-dim">
          thinking…
        </span>
      )}
      <span className={cn("shrink-0 text-text-faint", props.big ? "text-xs" : "text-[11px]")}>
        {props.color === "w" ? "White" : "Black"}
      </span>
      {/* THE CLOCK, on the side it belongs to — both of them on screen at once, which is how a
          player reads a game. It is drawn only where there is one: a game with no time control
          shows nothing rather than a dash nobody can act on. */}
      {ms !== null && (
        <span
          data-testid={`chess-clock-${props.color}`}
          data-running={running ? "true" : undefined}
          data-flagged={flagged ? "true" : undefined}
          className={cn(
            "ml-auto shrink-0 rounded-md px-1.5 font-mono tabular-nums",
            props.big ? "py-1 text-lg" : "text-xs",
            // A running clock is the one the reader is watching, so it is the one with ink behind
            // it; the other is quiet. Under thirty seconds it turns, because that is the moment
            // the number starts to matter more than the position.
            flagged
              ? "bg-destructive/15 text-destructive"
              : running
                ? ms < 30_000
                  ? "bg-destructive/15 text-destructive"
                  : "bg-accent text-foreground"
                : "text-text-dim",
          )}
        >
          {formatChessClock(ms)}
        </span>
      )}
    </header>
  );
}

/** `1. e4 e5  2. Nf3` — the way a score sheet reads, on one line. */
export function scoreSheetLine(moves: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const black = moves[i + 1];
    out.push(`${i / 2 + 1}. ${moves[i]}${black ? ` ${black}` : ""}`);
  }
  return out.join("  ");
}
