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
import { useEffect, useMemo, useState } from "react";
import { chessPublishFor, chessRematchFor, chessRematchLabel } from "~/lib/chess-act";
import { formatChessClock } from "~/lib/chess-clock";
import {
  chessCapturedGlyphs,
  chessCapturedWords,
  chessDeltaLabel,
  chessMaterialFor,
  type ChessMaterial,
} from "~/lib/chess-material";
import { chessPagePath } from "~/lib/chess-menu";
import {
  chessOpponentMri,
  chessSeriesBetween,
  chessSeriesGames,
  chessSeriesWords,
  type ChessSeries,
} from "~/lib/chess-series";
import {
  chessAwaitsOurAnswer,
  chessAwaitsTheirAnswer,
  chessGameIsOver,
  chessGameIsSettled,
  chessPlayerOf,
  type ChessGame,
  type ChessPlayer,
} from "~/lib/chess-thread";
import { clockWords, newChessGameId, type ChessColor } from "~/lib/chess-wire";
import { isGroupChat } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { ChessBoard } from "./chess-board";
import { useOptionalAppState, useOptionalController } from "./controller-context";
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
  // HOW THE TWO OF THEM STAND. The card holds one game, so the LIVE half is that game and the
  // backend's snapshot is the rest of the conversation's history. Held rather than built inline: a
  // fresh array every render would re-derive the score on every frame of a running clock.
  const live = useMemo(() => [game], [game]);
  const series = useChessSeries(props.conversationId, game, live);
  const themName = (game.challenger.isSelf ? game.opponent?.name : game.challenger.name) ?? "They";

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
        material={board.material}
        engine={!!board.engine}
        thinking={board.engineThinking}
      />
      <ChessBoard
        id={`chess-${game.id}`}
        fen={board.fen}
        orientation={board.orientation}
        movable={board.movable}
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
      <ChessSeat game={game} color={board.orientation} clock={board.clock} material={board.material} />

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

      {/* HOW THE TWO OF THEM STAND, and ANOTHER GAME. Both are here as well as on the page, because
          the history is where a finished game is met first — and they stand with the way IN rather
          than up beside the status, because all three are what to do NEXT: the sentences above them
          are about the game that has just ended. */}
      {series && (
        <p
          data-testid="chess-series"
          data-series-played={series.played}
          className="mt-1 text-[11px] text-text-faint"
        >
          {chessSeriesWords(series, themName)}
        </p>
      )}
      <ChessRematchButton game={game} conversationId={props.conversationId} className="mt-2" />

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
 * One side of the board: who is playing it, what their clock reads, and WHAT THEY HAVE TAKEN.
 *
 * Drawn above and below the board the way a board is read, and the face and the name are the
 * app's own — so a colleague the user renamed is named here exactly as they are above their own
 * bubbles.
 *
 * A seat NOBODY holds is drawn as an empty seat rather than as a person: no initials, because
 * tinted initials are how this app draws a colleague it has no photo for and "Nobody yet" reduced
 * to `NY` is ink that names nothing. And it says WHOSE it is from the reader's own position — the
 * seat opposite a challenger is the reader's to take.
 *
 * **THE HAUL IS A SECOND LINE, and it is drawn only where there is one.** A seat is already a face,
 * a name, a side and a clock in one row that has to fit a phone, so a row of glyphs pushed into it
 * would be the thing that wraps. Under the name it is a line the reader's eye can skip until they
 * want it — and the room it takes is measured rather than reserved, because the page sizes the board
 * to whatever is left (see `useBoardFit`).
 */
export function ChessSeat(props: {
  game: ChessGame;
  color: ChessColor;
  clock: { white: number | null; black: number | null; running: ChessColor | null; flagged: ChessColor | null };
  /** What the position on screen says about material. Absent on a board that does not read one —
   *  and a seat with nothing taken draws nothing either way. */
  material?: ChessMaterial;
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
    <div className={cn(props.big && "space-y-0.5")}>
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
      {props.material && <ChessCaptured material={props.material} color={props.color} big={props.big} />}
    </div>
  );
}

/**
 * WHAT ONE SIDE HAS TAKEN, and how far up or down it leaves them.
 *
 * The men are Unicode's own chess glyphs in the OPPONENT's colour, because the pieces really are the
 * opponent's — hollow for white and solid for black, which is the typographic convention and the one
 * spelling that reads in both themes. They are text rather than icons, so no second icon set is
 * installed (§ Project shape) and the row scales with the type around it.
 *
 * **BOTH SEATS SHOW A NUMBER, and it is signed from that seat's own side.** `+3` above the board and
 * `−3` below it is one fact twice only for somebody reading both at once — and a player looking at
 * their own seat on a phone is not. A level position shows no number at all: a `0` is a number the
 * reader has to read in order to learn nothing.
 *
 * **THE GLYPHS ARE NOT THE WHOLE MESSAGE.** A row of `♟♟♞` says nothing to a screen reader and
 * nothing to anybody who does not read chess glyphs, so the words ride on the element's own `title`
 * and `aria-label` — the rule a reaction chip already holds for who reacted.
 */
function ChessCaptured(props: { material: ChessMaterial; color: ChessColor; big?: boolean }) {
  const { captured, delta } = chessMaterialFor(props.material, props.color);
  const glyphs = chessCapturedGlyphs(captured, props.color);
  const label = chessDeltaLabel(delta);
  // Nothing taken and nothing between them: a line that says neither is a line worth not drawing.
  if (!glyphs && !label) return null;
  const words = chessCapturedWords(captured);
  return (
    <p
      data-testid={`chess-captured-${props.color}`}
      data-delta={delta === 0 ? undefined : delta}
      title={words ? `Taken: ${words}` : undefined}
      aria-label={
        words ? `Taken: ${words}${label ? ` — ${label} on material` : ""}` : `${label} on material`
      }
      className={cn(
        // THE INK IS `text-dim` RATHER THAN `text-faint`, and that is what makes the pieces legible
        // at all: a SOLID glyph drawn in the faintest ink is a grey blob, and beside it a HOLLOW one
        // is the same blob — so the one thing the two spellings carry, whose men these are, was lost
        // in the first capture of this row.
        "flex items-center gap-1 leading-none text-text-dim",
        props.big ? "text-lg" : "text-base",
      )}
    >
      <span aria-hidden className="truncate">
        {glyphs}
      </span>
      {label && (
        <span
          aria-hidden
          className={cn("shrink-0 font-mono tabular-nums", props.big ? "text-xs" : "text-[11px]")}
        >
          {label}
        </span>
      )}
    </p>
  );
}

/** Nothing, held still: a new array every render would re-derive the series on every frame of a
 *  running clock. */
const NO_GAMES: ChessGame[] = [];

/**
 * THE HEAD-TO-HEAD SCORE between the reader and whoever they are playing, over every game this
 * conversation holds — a draw counting a half (see lib/chess-series.ts).
 *
 * Two halves, and both are needed. The backend answers the chess-carrying messages of the WHOLE
 * stored history (`chess_messages`, an ordinary read that makes no network request), because the
 * history loads a page at a time and a score counted off the loaded page would grow as the reader
 * scrolled back. The thread's own LIVE games then win per game id, because a game that finished a
 * moment ago is settled in the thread and still running in that snapshot.
 *
 * ONE spelling for both surfaces — the card and the page — through the OPTIONAL hooks, because a
 * card is server-rendered by its own tests with no provider around it (the seam `RichContent`
 * already uses). The read itself is asked by whichever board is drawn rather than on connect, and
 * the store answers it once per conversation: a reader who plays no chess never pays for it, and a
 * history holding six boards does not ask six times.
 *
 * Null where there is no score to state — a board with no backend, an ENGINE game (a machine keeps
 * no score with anybody), a game the reader is only watching, and a pair who have not finished one.
 */
export function useChessSeries(
  conversationId: string,
  game: ChessGame,
  live: ChessGame[],
): ChessSeries | null {
  const controller = useOptionalController();
  const archive = useOptionalAppState((s) => s.chessArchive[conversationId] ?? NO_GAMES, NO_GAMES);
  useEffect(() => {
    void controller?.loadChessArchive(conversationId);
  }, [controller, conversationId]);
  const them = chessOpponentMri(game);
  const series = useMemo(
    () => (them ? chessSeriesBetween(chessSeriesGames(archive, live), them) : null),
    [archive, live, them],
  );
  return series && series.played > 0 ? series : null;
}

/**
 * THE REMATCH a finished game earns: the same opponent, the same clock, the colours the other way
 * round (see `chessRematchFor`).
 *
 * One component for both surfaces — the card in the history and the page — so the press means the
 * same thing wherever it is made. It draws nothing at all where there is no rematch to offer: a game
 * still going, a game the reader watched, a challenge nobody took up, and a board with no controller.
 *
 * Three things about it:
 *   - **it is an ordinary CHALLENGE**, published through the one path every chess press goes down
 *     (`chessPublishFor`), with a NEW game id. So the wire gains nothing and a colleague on an older
 *     build reads it as what it is.
 *   - **the outcome is reported AT the press.** A challenge that did not leave must never be left
 *     looking like it did, which is the composer's own rule.
 *   - **it goes quiet once it has been sent**, because the challenge is now a board of its own in the
 *     conversation and pressing again would open a second game nobody asked for. A reload offers it
 *     again — the button is one press and this app keeps no state about it, which is the honest cost
 *     of not writing anything down.
 */
export function ChessRematchButton(props: {
  game: ChessGame;
  conversationId: string;
  className?: string;
}) {
  const controller = useOptionalController();
  const conversation = useOptionalAppState(
    (s) => s.conversations.find((c) => c.id === props.conversationId),
    undefined,
  );
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rematch = chessRematchFor(props.game);
  if (!rematch || !controller) return null;

  const them = props.game.challenger.isSelf
    ? props.game.opponent?.name
    : props.game.challenger.name;
  const label = chessRematchLabel(rematch, {
    them: them ?? "them",
    group: !!conversation && isGroupChat(conversation),
    engine: !!props.game.engine,
  });

  const press = async () => {
    setError(null);
    const gameId = newChessGameId();
    const publish = chessPublishFor({
      gameId,
      game: null,
      color: rematch.color,
      act: rematch,
      nowMs: Date.now(),
    });
    if (!publish) return;
    setSent(true);
    const ok = await controller.publishChessLedger(props.conversationId, publish);
    if (!ok) {
      setSent(false);
      setError("The rematch did not go out — nothing was posted. Try again.");
    }
  };

  return (
    <div className={cn("flex flex-col items-center gap-1", props.className)}>
      <button
        type="button"
        data-testid="chess-rematch"
        data-rematch-color={rematch.color}
        disabled={sent}
        onClick={() => void press()}
        className={cn(
          "rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground",
          "disabled:pointer-events-none disabled:opacity-60",
        )}
      >
        {sent ? "Rematch sent" : label}
      </button>
      {error && (
        <p data-testid="chess-rematch-error" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
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
