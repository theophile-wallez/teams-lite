/**
 * THE CHESS PAGE: one game, the whole screen — `/c/<conversation>/chess/<game>`.
 *
 * The board in the middle, the score sheet down the right, and the conversation's own chat under
 * it. It is chess.com's shape, and it is the surface the feature was missing: the card in the
 * history is a board in a column a phone's width wide, between things people said, which is the
 * right place to play A MOVE and the wrong place to play a GAME.
 *
 * **A ROUTE, never a piece of state** — the rule the merge request's diff, its pipeline graph and
 * a job's log all hold. Three things come with the URL and none is available to a `useState`: it
 * survives a reload, it can be sent to whoever you are playing, and the browser's own Back leaves
 * it. It is a CHILD of the conversation's own route, so the shell opens the thread exactly as it
 * always did and the page never loads a history of its own.
 *
 * **The shell draws it INSTEAD of the sidebar and the pane** (see components/app.tsx), rather than
 * over them: there is no overlay to dismiss, and the one composer in this app is this page's while
 * it is up — the pane that usually holds it is not mounted at all, so the sentinel a sanctioned
 * driver proves its target with still has exactly one answer.
 *
 * Five rules hold the surface, and `web/e2e/chess.spec.ts` pins each:
 *   - **each column scrolls ITSELF and the page never scrolls.** The board stays where it is while
 *     the chat is read, and a move played after ten minutes of reading does not put the reader
 *     back at the top of anything.
 *   - **a narrow screen is ONE column**: the board, then the score sheet as a single line, then
 *     the chat — the shape a phone gets from chess.com, and the reason the score sheet is a
 *     component that can be either.
 *   - **the board is bounded by the SHORTER of the room it has**, so it is never a board wider
 *     than the window is tall.
 *   - **the keys are the score sheet's four controls**, and they are ignored while the reader is
 *     typing: this page holds the composer, so a left arrow inside a half-written message must
 *     move the caret rather than the board.
 *   - **a game the URL names and the thread does not hold SAYS so**, rather than drawing an empty
 *     board: the history pages older, so a game may simply not be loaded yet.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { ChevronLeftIcon, Loading02Icon } from "@hugeicons/core-free-icons";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { chessGameById, chessGamesInThread, chessGameIsSettled } from "~/lib/chess-thread";
import { clockWords } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";
import { ChessBoard } from "./chess-board";
import { ChessSeat, scoreSheetLine } from "./chess-game-card";
import { ChessMoveNav, ChessScoreSheet } from "./chess-score-sheet";
import { ConversationChatPanel } from "./conversation-chat-panel";
import { useCallOwnsComposer } from "./call-stage-context";
import { useAppState } from "./controller-context";
import { useChessGame } from "./use-chess-game";

export function ChessPage(props: {
  conversationId: string;
  gameId: string;
  onBack: () => void;
}) {
  const openId = useAppState((s) => s.openId);
  const messages = useAppState((s) => s.messages);
  const loading = useAppState((s) => s.loadingMessages);
  const ready = openId === props.conversationId;

  // The games are derived from the thread's own messages, exactly as the pane derives them: one
  // reading of the history, and no second loader anywhere in this feature.
  const games = useMemo(() => (ready ? chessGamesInThread(messages) : []), [ready, messages]);
  const game = chessGameById(games, props.gameId);

  if (!ready || (loading && !game)) {
    return (
      <ChessPageShell onBack={props.onBack} title="Chess">
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-faint">
          <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.8} />
          Opening the conversation…
        </div>
      </ChessPageShell>
    );
  }

  if (!game) {
    return (
      <ChessPageShell onBack={props.onBack} title="Chess">
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p data-testid="chess-page-missing" className="text-sm text-text-dim">
            This conversation does not hold a game with that address.
          </p>
          <p className="max-w-sm text-xs text-text-faint">
            A game is its messages, and the history loads a page at a time — if it is an old game,
            scrolling the conversation back far enough will bring it here.
          </p>
        </div>
      </ChessPageShell>
    );
  }

  return <ChessPageBoard conversationId={props.conversationId} gameId={game.id} games={games} onBack={props.onBack} />;
}

/** The header and the frame. Split out so the three states above draw the same page. */
function ChessPageShell(props: {
  onBack: () => void;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-testid="chess-page" className="flex h-full min-h-0 w-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-2 sm:px-3">
        <button
          type="button"
          data-testid="chess-page-back"
          aria-label="Back to the conversation"
          onClick={props.onBack}
          className="grid size-11 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.8} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-foreground">{props.title}</h1>
          {props.subtitle && (
            <p data-testid="chess-page-subtitle" className="truncate text-xs text-text-faint">
              {props.subtitle}
            </p>
          )}
        </div>
        {props.right}
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">{props.children}</div>
    </div>
  );
}

function ChessPageBoard(props: {
  conversationId: string;
  gameId: string;
  games: ReturnType<typeof chessGamesInThread>;
  onBack: () => void;
}) {
  const stated = chessGameById(props.games, props.gameId);
  const callOwnsComposer = useCallOwnsComposer();
  const reduceMotion = useReducedMotion();
  const [armedResign, setArmedResign] = useState(false);
  // The page is where a reader is PLAYING rather than reading a chat, so this is the board that
  // makes a noise (see lib/chess-sound.ts).
  const board = useChessGame({
    game: stated!,
    conversationId: props.conversationId,
    sounds: true,
  });
  const game = board.game;
  const settled = chessGameIsSettled(game);

  // THE FOUR KEYS. They are the score sheet's own controls, and they are ignored the moment the
  // reader is typing — this page holds the app's one composer, so a left arrow inside a
  // half-written message belongs to the caret and never to the board.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest("[contenteditable='true']"))
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        board.step(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        board.step(1);
      } else if (event.key === "Home") {
        event.preventDefault();
        board.goTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        board.goTo(board.plies);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [board]);

  const white = game.challengerColor === "w" ? game.challenger : game.opponent;
  const black = game.challengerColor === "b" ? game.challenger : game.opponent;
  const title = `${white?.isSelf ? "You" : (white?.name ?? "White")} vs ${
    black?.isSelf ? "You" : (black?.name ?? "Black")
  }`;

  return (
    <ChessPageShell
      onBack={props.onBack}
      title={title}
      subtitle={`${clockWords(game.time)} · ${board.status}`}
      right={
        <div className="flex shrink-0 items-center gap-1">
          {/* The two decisions a player opens a board to make stand in the header, where they do
              not scroll away — the shape the merge request's own page settled on. The WORDS that
              explain them stay below, with the board. */}
          {board.flagClaimable && (
            <button
              type="button"
              data-testid="chess-claim-flag"
              onClick={() => board.act({ kind: "flag" })}
              className="rounded-lg bg-primary px-2.5 py-2 text-xs font-medium text-primary-foreground"
            >
              Claim the win on time
            </button>
          )}
          {board.canAct && (
            <>
              {game.drawOfferedBy && game.drawOfferedBy !== game.ourColor ? (
                <button
                  type="button"
                  data-testid="chess-draw-accept"
                  onClick={() => board.act({ kind: "drawAccept" })}
                  className={HEADER_BUTTON}
                >
                  Accept the draw
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="chess-draw"
                  disabled={game.drawOfferedBy === game.ourColor}
                  onClick={() => board.act({ kind: "draw" })}
                  className={cn(HEADER_BUTTON, "disabled:pointer-events-none disabled:opacity-50")}
                >
                  {game.drawOfferedBy === game.ourColor ? "Draw offered" : "Draw"}
                </button>
              )}
              <button
                type="button"
                data-testid="chess-resign"
                onClick={() => {
                  if (!armedResign) {
                    setArmedResign(true);
                    return;
                  }
                  setArmedResign(false);
                  board.act({ kind: "resign" });
                }}
                className={HEADER_BUTTON}
              >
                {armedResign ? "Resign — for good" : "Resign"}
              </button>
            </>
          )}
        </div>
      }
    >
      {/* THE BOARD COLUMN. It scrolls itself on a phone, where the seats, the board, the nav and
          the sentence do not fit in one screen at 390px. */}
      {/* `shrink-0` below `md` is load-bearing: two flex children with no basis share the height,
          so the board column was squeezed and its own overflow hid the four move controls — the
          one way to review a game on a phone. It keeps its content's height there and the chat
          takes what is left; on a wide screen it is the flexible one instead. */}
      <div className="flex min-h-0 shrink-0 flex-col items-center gap-1 overflow-y-auto p-3 md:flex-1 md:shrink">
        {/* The board is bounded by the SHORTER of what it has: a board as wide as a desktop
            column would be taller than the window, and a page that scrolls to show a board is
            not a board. */}
        <div className="flex w-full max-w-[min(100%,calc(100vh-15rem))] flex-col">
          <ChessSeat game={game} color={board.orientation === "w" ? "b" : "w"} clock={board.clock} big />
          <ChessBoard
            id={`chess-page-${game.id}`}
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
            onSquare={board.press}
            onDrop={board.drop}
            onRightClick={board.rightClick}
            animate={!reduceMotion}
            // THE ARROWS live here and nowhere else: a right-drag draws one, which is worth the
            // browser's own menu on a page a reader is thinking on, and is not worth it in a
            // conversation.
            arrows
          />
          <ChessSeat game={game} color={board.orientation} clock={board.clock} big />
          <ChessMoveNav
            viewPly={board.viewPly}
            plies={board.plies}
            atLive={board.atLive}
            onGoTo={board.goTo}
            onStep={board.step}
            className="mt-1"
          />
          {/* The sentence, under the board where the press was made. A game being REVIEWED says so
              here rather than in the header: it is a fact about what the board is showing. */}
          <p data-testid="chess-page-status" className="mt-1 text-center text-xs text-text-dim">
            {board.atLive ? board.status : `Move ${board.viewPly} of ${board.plies} — the board is not live.`}
          </p>
          {board.premove && (
            <p data-testid="chess-premove-hint" className="mt-0.5 text-center text-[11px] text-text-faint">
              Premove set: {board.premove[0]}–{board.premove[1]}. It plays itself when they move,
              for a tenth of a second. Right-click to take it back.
            </p>
          )}
          {board.error && (
            <p data-testid="chess-error" className="mt-1 text-center text-[11px] text-destructive">
              {board.error}
            </p>
          )}
          {/* A challenge the reader was offered is answered HERE too, so a page opened from a
              notification is not a board they can do nothing with. */}
          {!game.opponent && !game.challenger.isSelf && !settled && (
            <div className="mt-2 flex items-center justify-center gap-2">
              <button
                type="button"
                data-testid="chess-accept"
                onClick={() => board.act({ kind: "join" })}
                className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
              >
                Accept — play {game.challengerColor === "w" ? "black" : "white"}
              </button>
              <button
                type="button"
                data-testid="chess-decline"
                onClick={() => board.act({ kind: "decline" })}
                className={HEADER_BUTTON}
              >
                Not now
              </button>
            </div>
          )}
        </div>
      </div>

      {/* THE RIGHT COLUMN: the score sheet, then the conversation. Below `md` it is under the
          board, with the sheet reduced to the one line the card draws — a table of pairs and a
          chat cannot both have room on a 390px screen, and the chat is what a game in a
          conversation is for. */}
      <aside className="flex min-h-0 flex-1 flex-col border-t border-border-subtle md:w-80 md:flex-none md:shrink-0 md:border-l md:border-t-0 lg:w-96">
        <div className="hidden min-h-0 md:flex md:max-h-[45%] md:flex-col">
          <ChessScoreSheet
            moves={board.moves}
            viewPly={board.viewPly}
            atLive={board.atLive}
            onGoTo={board.goTo}
          />
        </div>
        {board.moves.length > 0 && (
          <p
            data-testid="chess-moves"
            className="shrink-0 overflow-x-auto whitespace-nowrap border-b border-border-subtle px-3 py-2 text-[11px] text-text-faint md:hidden"
          >
            {scoreSheetLine(board.moves.map((m) => m.san))}
          </p>
        )}
        {/* The conversation itself, under the moves — the game is being played IN a chat, and what
            is being said while people play is the other half of it. It is the app's own thread and
            the app's own composer: no second history loader, and one composer in the page. */}
        <ConversationChatPanel
          conversation={props.conversationId}
          testId="chess-page-chat"
          transcriptTestId="chess-page-transcript"
          className="min-h-0 flex-1"
          // ONE composer in the app. A live call whose own chat panel is open is already holding
          // it, and this page sits behind that stage — so the panel here draws the transcript and
          // leaves the field where the reader can see it.
          composer={!callOwnsComposer}
        />
      </aside>
    </ChessPageShell>
  );
}

const HEADER_BUTTON =
  "rounded-lg border border-border-subtle px-2.5 py-2 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground";
