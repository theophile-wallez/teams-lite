/**
 * THE GAMES RUNNING IN THIS CONVERSATION, floating under its header.
 *
 * A conversation can hold several games at once, and a board is one row somewhere in a history
 * that may be a hundred messages long — so the reader needs to know, without scrolling, that a
 * game is going, whose move it is and how much time is left on it. That is this strip: one chip
 * per live game, most urgent first, each one a press away from its own page.
 *
 * Four rules hold it, and `web/e2e/chess.spec.ts` pins each:
 *
 *   - **it FLOATS rather than taking room.** It is an overlay at the top of the history, so
 *     nothing in the conversation moves when a game starts or ends — the failure the scheduled
 *     banner avoids by sitting above the composer rather than inside it. The container passes
 *     pointer events through; only the chips take them.
 *   - **the CLOCK ticks in the chip and nowhere else.** Each chip holds its own reading (see
 *     use-chess-clock.ts), so a running game redraws a 60px pill four times a second instead of
 *     re-rendering a virtualized history — which re-renders on every scroll that mounts a row.
 *   - **the order is the DERIVATION's** (`activeChessGames`): a game waiting for the reader comes
 *     before one waiting for somebody else, and the newest before the older. What wants their
 *     attention is what they meet first.
 *   - **it is bounded, and it says what it left out.** Three chips at a time, and a count for the
 *     rest — a row of eight pills is a second sidebar, and on a phone it would cover the first
 *     message of the conversation.
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { CpuIcon } from "@hugeicons/core-free-icons";
import { useNavigate } from "@tanstack/react-router";
import { formatChessClock } from "~/lib/chess-clock";
import { chessPagePath } from "~/lib/chess-menu";
import {
  activeChessGames,
  chessAwaitsOurAnswer,
  chessPlayerOf,
  chessWantsUs,
  type ChessGame,
} from "~/lib/chess-thread";
import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { useChessClock } from "./use-chess-clock";

/** How many chips are drawn before the rest become a count. */
export const CHESS_STRIP_CHIPS = 3;

export function ChessGamesStrip(props: { conversationId: string; games: ChessGame[] }) {
  const live = activeChessGames(props.games);
  if (live.length === 0) return null;
  const shown = live.slice(0, CHESS_STRIP_CHIPS);
  const rest = live.length - shown.length;

  return (
    <div
      data-testid="chess-games-strip"
      data-count={live.length}
      // Floating: the history keeps its own height, so nothing moves under the reader when a game
      // starts. The row scrolls sideways at a phone's width rather than wrapping into two.
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-1.5 overflow-x-auto px-2 py-1.5"
    >
      {shown.map((game) => (
        <ChessGameChip key={game.id} game={game} conversationId={props.conversationId} />
      ))}
      {rest > 0 && (
        <span
          data-testid="chess-games-more"
          className="pointer-events-auto shrink-0 rounded-full border border-border-subtle bg-panel px-2 py-1 text-[11px] text-text-dim shadow-card"
        >
          +{rest} more
        </span>
      )}
    </div>
  );
}

function ChessGameChip(props: { game: ChessGame; conversationId: string }) {
  const navigate = useNavigate();
  const game = props.game;
  const clock = useChessClock(game);
  const wants = chessWantsUs(game);
  const awaiting = chessAwaitsOurAnswer(game);
  // WHO the game is against, from the reader's own position: their opponent, or — while nobody has
  // accepted — whoever is being waited for. A spectator's chip names the challenger.
  const them = game.ourColor
    ? chessPlayerOf(game, other(game.ourColor))
    : (game.opponent ?? game.challenger);
  const ourClock = game.ourColor === "b" ? clock.black : clock.white;
  const theirClock = game.ourColor === "b" ? clock.white : clock.black;

  return (
    <a
      href={chessPagePath(props.conversationId, game.id)}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void navigate({ to: chessPagePath(props.conversationId, game.id) });
      }}
      data-testid="chess-game-chip"
      data-chess-game={game.id}
      data-wants-us={wants ? "true" : undefined}
      title={
        awaiting
          ? `${game.challenger.name} challenged you — open the board`
          : wants
            ? "Your move — open the board"
            : "Open the board"
      }
      className={cn(
        // 44px of height under a thumb, which every target this app draws for one clears.
        // OPAQUE, not translucent: it floats over the conversation, and a message showing through
        // its own words is a chip nobody can read.
        "pointer-events-auto flex h-11 shrink-0 items-center gap-2 rounded-full border bg-panel pl-1.5 pr-2.5 shadow-card transition-colors hover:bg-accent",
        wants ? "border-primary/60" : "border-border-subtle",
      )}
    >
      {game.engine ? (
        // THE ENGINE IS NOT A PERSON, and its MRI is empty. An avatar seeded from that is tinted
        // initials for a colleague who does not exist — this app never puts a face on something
        // that has none, which is the rule § Renaming a person states for a mail's own senders.
        <span
          data-testid="chess-chip-engine"
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full border border-border-subtle bg-accent text-text-dim"
        >
          <HugeiconsIcon icon={CpuIcon} className="size-4" strokeWidth={1.8} />
        </span>
      ) : them ? (
        <Avatar
          seed={them.mri}
          label={them.name}
          photo={{ kind: "user", id: them.mri }}
          className="size-8"
        />
      ) : (
        <span aria-hidden className="size-8 rounded-full border border-dashed border-border-subtle" />
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="max-w-28 truncate text-[11px] font-medium text-foreground">
          {them?.isSelf ? "You" : (them?.name ?? "Nobody yet")}
        </span>
        <span className="text-[10px] text-text-faint">
          {awaiting ? "challenged you" : wants ? "your move" : game.opponent ? "their move" : "waiting"}
        </span>
      </span>
      {/* BOTH clocks, theirs over ours, which is how a board is read — and it is the whole reason
          this strip exists rather than a dot: a game with two minutes left is not the same news as
          a game with twenty. */}
      {ourClock !== null && theirClock !== null && (
        <span className="ml-1 flex shrink-0 flex-col items-end font-mono text-[10px] leading-tight tabular-nums">
          <span
            data-testid="chess-chip-clock-theirs"
            className={cn(clock.running && clock.running !== game.ourColor ? "text-foreground" : "text-text-faint")}
          >
            {formatChessClock(theirClock)}
          </span>
          <span
            data-testid="chess-chip-clock-ours"
            className={cn(
              clock.running === game.ourColor
                ? ourClock < 30_000
                  ? "font-semibold text-destructive"
                  : "text-foreground"
                : "text-text-faint",
            )}
          >
            {formatChessClock(ourClock)}
          </span>
        </span>
      )}
      {wants && (
        <span
          data-testid="chess-chip-dot"
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-primary"
        />
      )}
    </a>
  );
}

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}
