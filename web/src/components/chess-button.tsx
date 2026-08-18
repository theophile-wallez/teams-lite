/**
 * The chess control in a conversation's header, beside the call button and the agent menu.
 *
 * Two states, and each is the reader's next move: with no game in flight it opens a popover
 * that CHALLENGES; with a game going it takes them to the board and carries a dot when it is
 * their turn. In a conversation that cannot hold a game it is not drawn at all — the call
 * button's own discipline, that a control which cannot do the thing it names is worse than no
 * control.
 *
 * The press that challenges is an outward action: a message goes out under the user's name and
 * everybody in the conversation sees it. So the popover SAYS that before the press, and a
 * refusal is reported inside the popover rather than swallowed — the rule the approval menu
 * follows.
 */

import { ChessPawnIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { activeChessGame, chessTurnIsOurs, type ChessGame } from "~/lib/chess-thread";
import { newChessGameId, type ChessColor } from "~/lib/chess-wire";
import { convLabel, isGroupChat, type Conversation } from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** What the control is for, right now. Pure, so it is unit-tested without a DOM. */
export type ChessButtonState =
  | { kind: "challenge" }
  | { kind: "open"; game: ChessGame; ourTurn: boolean };

export function chessButtonState(games: ChessGame[]): ChessButtonState {
  const live = activeChessGame(games);
  if (!live) return { kind: "challenge" };
  return { kind: "open", game: live, ourTurn: chessTurnIsOurs(live) };
}

/** What the press reaches. In a group the challenge is OPEN, and the label says so, because
 *  who the opponent will be is the one thing the user cannot know before the press. */
export function chessChallengeLabel(label: string, group: boolean): string {
  return group ? `Challenge ${label} — first to accept plays` : `Challenge ${label}`;
}

/**
 * Whether this conversation can hold a game at all.
 *
 * Notes — the chat with oneself — has nobody to play. A team CHANNEL is excluded for a reason
 * of the pane's rather than of chess's: a channel's history is drawn as THREADS, and a board
 * inside one is a different surface. The sandbox thread is a group CHAT, so the one place a
 * send is pre-authorized is covered.
 */
export function conversationHoldsChess(conversation: Conversation | undefined): boolean {
  return !!conversation && conversation.kind !== "notes";
}

export function ChessButton(props: { conversationId: string; games: ChessGame[] }) {
  const controller = useController();
  const conversation = useAppState((s) =>
    s.conversations.find((c) => c.id === props.conversationId),
  );
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState<"w" | "b" | "random">("random");
  const [error, setError] = useState<string | null>(null);

  if (!conversationHoldsChess(conversation) || !conversation) return null;

  const state = chessButtonState(props.games);
  const group = isGroupChat(conversation);
  const label = conversation.name || convLabel(conversation);

  if (state.kind === "open") {
    return (
      <button
        type="button"
        data-testid="chess-button"
        // WHICH conversation and WHICH game, in the app's own state — the sentinel discipline
        // the call button and the composer both follow.
        data-conversation-id={props.conversationId}
        data-chess-game={state.game.id}
        data-your-turn={state.ourTurn ? "true" : undefined}
        aria-label={state.ourTurn ? "Your move — go to the chess board" : "Go to the chess board"}
        title={state.ourTurn ? "Your move" : "Chess"}
        onClick={() =>
          controller.requestScrollToMessage(props.conversationId, state.game.challengeMessageId)
        }
        className="relative grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={ChessPawnIcon} className="size-5" strokeWidth={1.6} />
        {/* It is the reader's move. The board may be a screen away, and this is the one place
            the header can say so. */}
        {state.ourTurn && (
          <span
            data-testid="chess-your-turn"
            aria-hidden
            className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </button>
    );
  }

  async function challenge(): Promise<void> {
    // Random is resolved HERE, into the colour the challenge really carries: the wire never
    // says "random", because a colour nothing decided is a game whose two clients could
    // disagree about who moves first.
    const mine: ChessColor = color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color;
    setError(null);
    const sent = await controller.sendChessMessage(props.conversationId, {
      game: newChessGameId(),
      body: { kind: "open", color: mine },
    });
    if (sent) setOpen(false);
    else setError("The challenge did not go out — nothing was posted. Try again.");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chess-button"
          data-conversation-id={props.conversationId}
          aria-label={chessChallengeLabel(label, group)}
          title="Chess"
          className="grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ChessPawnIcon} className="size-5" strokeWidth={1.6} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <p className="text-sm font-medium text-foreground">{chessChallengeLabel(label, group)}</p>
        <div className="mt-2 flex items-center gap-1">
          {(["random", "w", "b"] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`chess-color-${option}`}
              onClick={() => setColor(option)}
              aria-pressed={color === option}
              className={
                color === option
                  ? "rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
                  : "rounded-md border border-border-subtle px-2 py-1 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground"
              }
            >
              {option === "random" ? "Random" : option === "w" ? "White" : "Black"}
            </button>
          ))}
        </div>
        {/* What the press costs, before it is pressed: it is the one fact the user needs and
            the one thing they cannot take back after. */}
        <p className="mt-2 text-[11px] text-text-faint">
          This posts a message under your name, and everybody in this conversation sees it. They
          need teams-lite to play.
        </p>
        <button
          type="button"
          data-testid="chess-challenge"
          onClick={() => void challenge()}
          className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground"
        >
          Send the challenge
        </button>
        {error && (
          <p data-testid="chess-challenge-error" className="mt-1 text-[11px] text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
