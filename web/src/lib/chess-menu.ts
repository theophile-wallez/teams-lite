/**
 * What a conversation's own menu offers about chess, and what its trigger says.
 *
 * Pure, so it is unit-tested without a DOM — and a module of its own rather than part of the menu,
 * for the reason the menu itself states: which state the control is in, and what a challenge
 * reaches, are decisions with tests of their own, and two spellings of them would drift at the
 * first group chat. It was `components/chess-button.tsx` while a button drew it; the button became
 * one row of the header's single menu (§ ONE MENU in a conversation's header) and the helpers
 * stayed, so the file moved to where the helpers live rather than keeping the name of a control
 * that no longer exists.
 */

import { activeChessGames, chessAwaitsOurAnswer, chessTurnIsOurs, chessWantsUs, type ChessGame } from "./chess-thread";
import { convLabel, isGroupChat, type Conversation } from "./protocol";

/** One live game, as a row of the menu and a fact about the trigger. */
export type ChessMenuGame = {
  game: ChessGame;
  /** It is the reader's move. */
  ourTurn: boolean;
  /** Somebody challenged the reader and is waiting for an answer. */
  awaitingUs: boolean;
  /** Either of the two: the game wants something from the reader, which is what the dot says. One
   *  dot for one question — a reader does not need to learn two marks. */
  wantsUs: boolean;
};

/**
 * What the menu is for, right now.
 *
 * SEVERAL GAMES AT ONCE is the shape, and it used to be one: `activeChessGame` answered with the
 * newest unfinished game and a challenge was refused while it ran. A conversation really holds
 * several — a group chat holds a game per pair of people, and two colleagues wanting a second
 * board while the first is still going is the commonest ask this feature had — so the menu names
 * every live game AND still offers a challenge. Nothing is refused for being the second game.
 */
export type ChessMenuState = {
  /** Every live game, most urgent first (see `activeChessGames`). */
  games: ChessMenuGame[];
  /** Whether ANY of them wants the reader — what the closed trigger's dot is drawn from. */
  wantsUs: boolean;
};

export function chessMenuState(games: ChessGame[]): ChessMenuState {
  const live = activeChessGames(games).map((game) => ({
    game,
    ourTurn: chessTurnIsOurs(game),
    awaitingUs: chessAwaitsOurAnswer(game),
    wantsUs: chessWantsUs(game),
  }));
  return { games: live, wantsUs: live.some((entry) => entry.wantsUs) };
}

/** What one row says about one game. */
export function chessGameRowLabel(entry: ChessMenuGame): string {
  if (entry.awaitingUs) return `${entry.game.challenger.name} challenged you`;
  const them = entry.game.ourColor
    ? entry.game.challenger.isSelf
      ? entry.game.opponent?.name
      : entry.game.challenger.name
    : entry.game.opponent?.name ?? entry.game.challenger.name;
  const who = them ?? "somebody";
  if (!entry.game.opponent) return "Waiting for somebody to accept";
  return entry.ourTurn ? `Your move — ${who}` : `${who}'s move`;
}

/**
 * The ADDRESS of one game's own page — `/c/<conversation>/chess/<game>`.
 *
 * One spelling, here, because four surfaces link to it: the card in the history, the strip under
 * the header, the conversation's menu and the page's own Back. It is a real `href` on a real
 * anchor everywhere, which is the rule a tracker reference already holds — the status bar says
 * where it goes, a middle click opens a window, "copy link" copies something that resolves — and
 * a plain left press is intercepted so it stays inside the app.
 */
export function chessPagePath(conversationId: string, gameId: string): string {
  return `/c/${encodeURIComponent(conversationId)}/chess/${gameId}`;
}

/** What the press reaches. In a group the challenge is OPEN, and the label says so, because
 *  who the opponent will be is the one thing the user cannot know before the press. */
export function chessChallengeLabel(label: string, group: boolean): string {
  return group ? `Challenge ${label} — first to accept plays` : `Challenge ${label}`;
}

/** The name a conversation is challenged by. */
export function chessConversationName(conversation: Conversation): string {
  return conversation.name || convLabel(conversation);
}

/** Whether the challenge in this conversation is an OPEN one. */
export function chessChallengeIsOpen(conversation: Conversation): boolean {
  return isGroupChat(conversation);
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

/**
 * Whether this conversation can hold a game against the ENGINE.
 *
 * NOTES can. It is the one place `conversationHoldsChess` refuses because "there is nobody to play"
 * — and the computer is somebody, so the chat with oneself is exactly where a solo game belongs.
 * Everything a human game is refused for still refuses this one: a CHANNEL's history is drawn as
 * threads, and a board inside one is a different surface.
 */
export function conversationHoldsEngineChess(conversation: Conversation | undefined): boolean {
  if (!conversation) return false;
  return conversationHoldsChess(conversation) || conversation.kind === "notes";
}
