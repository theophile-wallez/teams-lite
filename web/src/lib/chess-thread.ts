/**
 * Every game of chess a loaded message list holds, derived from the messages themselves.
 *
 * There is no store for a game and there is deliberately none: the position replays out of
 * the thread's own history, so a reload, a phone and a game played while this app was closed
 * all draw the same board, and there is nothing to reconcile when a frame is lost. It is the
 * property the agent's overlay has ("the row in the history IS the Teams message"), with no
 * overlay left at all.
 *
 * This module knows NO chess rules and carries no dependency. It answers who is playing,
 * whose turn it is and what the moves were; whether a move is LEGAL is chess.js's answer,
 * in the lazy chunk (see components/chess-game-card.tsx). That split is what lets the pane
 * decide a board row exists, and the header draw its turn dot, without loading a rules
 * engine into the path of every chat.
 */

import { chessWireIn, type ChessColor } from "./chess-wire";
import type { ChatMessage } from "./protocol";

/** One side's player. Named by MRI and never by display name — two colleagues may share
 *  one (§ WHO said it) — with the name kept for what the card draws. */
export type ChessPlayer = { mri: string; name: string; isSelf: boolean };

/** How the game ended, when a MESSAGE ended it. Mate, stalemate and the draws the rules
 *  decide are the board's own answer and are not in here: only chess.js can see those. */
export type ChessOutcome =
  | { kind: "playing" }
  | { kind: "resigned"; by: ChessColor }
  | { kind: "drawAgreed" }
  /** Nobody took the challenge up: it was declined, or the challenger withdrew it. Either way
   *  the game never started, and the conversation is free for the next one. */
  | { kind: "declined"; withdrawn: boolean };

/** One game, as the thread states it. */
export type ChessGame = {
  id: string;
  /** The message the board row is placed at. */
  challengeMessageId: string;
  challengeSeq: number;
  challenger: ChessPlayer;
  challengerColor: ChessColor;
  /** Whoever accepted, or null while the challenge is still open. */
  opponent: ChessPlayer | null;
  /** SAN in ply order; index 0 is ply 1. */
  moves: string[];
  /** Whose move it is, from the ply count. */
  turn: ChessColor;
  drawOfferedBy: ChessColor | null;
  outcome: ChessOutcome;
  /** The reader's own side, or null when they are watching. */
  ourColor: ChessColor | null;
  /** Every message of this game, the challenge included — what the pane absorbs. */
  absorbed: string[];
  /** Plies a message claimed and the game refused: a move out of turn, a duplicate, a
   *  move before the accept. Kept so the card can SAY so rather than drawing a board that
   *  silently disagrees with the other player's. */
  refusedPlies: number[];
};

/** Who plays a colour. */
export function chessPlayerOf(game: ChessGame, color: ChessColor): ChessPlayer | null {
  if (color === game.challengerColor) return game.challenger;
  return game.opponent;
}

/** Whether a MESSAGE has ended this game. The board decides the rest. */
export function chessGameIsSettled(game: ChessGame): boolean {
  return game.outcome.kind !== "playing";
}

/** The newest game still being played, or null. One game in flight per conversation, so
 *  this is what a challenge is refused against and what the header points at. */
export function activeChessGame(games: ChessGame[]): ChessGame | null {
  for (let i = games.length - 1; i >= 0; i -= 1) {
    const game = games[i];
    if (game && !chessGameIsSettled(game)) return game;
  }
  return null;
}

/** Whether the reader may move: they are a player, somebody accepted, and it is their turn. */
export function chessTurnIsOurs(game: ChessGame): boolean {
  return !!game.ourColor && !!game.opponent && game.turn === game.ourColor;
}

/**
 * Whether this game is waiting for the READER to answer a challenge — somebody else opened it
 * and nobody has accepted yet.
 *
 * It is what the challenged player's whole experience rests on: their side of a fresh challenge
 * is a board with no controls until they accept, so the card has to offer that and the header
 * has to say something is waiting for them. The mock used to accept on its own, which is exactly
 * how a UI with no Accept button passed every test.
 */
export function chessAwaitsOurAnswer(game: ChessGame): boolean {
  return !chessGameIsSettled(game) && !game.opponent && !game.challenger.isSelf;
}

/** Whether the reader is the one who opened this game and is still waiting for an answer. */
export function chessAwaitsTheirAnswer(game: ChessGame): boolean {
  return !chessGameIsSettled(game) && !game.opponent && game.challenger.isSelf;
}

/** Whether this game wants something from the reader right now: their move, or their answer to
 *  a challenge. One question, so the header asks it once. */
export function chessWantsUs(game: ChessGame): boolean {
  return chessTurnIsOurs(game) || chessAwaitsOurAnswer(game);
}

/** The games this message list holds, in the order they were opened. */
export function chessGamesInThread(messages: ChatMessage[]): ChessGame[] {
  const byId = new Map<string, ChessGame>();
  const order: string[] = [];

  for (const message of messages) {
    const wire = chessWireIn(message);
    if (!wire) continue;
    const who = playerOf(message);

    if (wire.body.kind === "open") {
      // A game is opened once. A second `open` for the same id is absorbed and ignored,
      // because the first one is the game every reader has already started replaying.
      const existing = byId.get(wire.game);
      if (existing) {
        existing.absorbed.push(message.id);
        continue;
      }
      byId.set(wire.game, {
        id: wire.game,
        challengeMessageId: message.id,
        challengeSeq: message.seq,
        challenger: who,
        challengerColor: wire.body.color,
        opponent: null,
        moves: [],
        turn: "w",
        drawOfferedBy: null,
        outcome: { kind: "playing" },
        ourColor: message.is_self === true ? wire.body.color : null,
        absorbed: [message.id],
        refusedPlies: [],
      });
      order.push(wire.game);
      continue;
    }

    const game = byId.get(wire.game);
    // A message for a game whose challenge is not loaded says nothing this app can draw:
    // the history pages older, and a board built from the tail of a game would show a
    // position that never happened.
    if (!game) continue;
    game.absorbed.push(message.id);
    // Everything after a resignation or an agreed draw is absorbed and ignored.
    if (chessGameIsSettled(game)) continue;

    if (wire.body.kind === "join") {
      // The FIRST colleague to answer is the opponent, and it can never be the challenger:
      // a game needs two people.
      if (game.opponent || who.mri === game.challenger.mri) continue;
      game.opponent = who;
      if (message.is_self === true) game.ourColor = other(game.challengerColor);
      continue;
    }

    if (wire.body.kind === "decline") {
      // A challenge nobody took up. It is only meaningful before somebody accepted, and only
      // from somebody who is NOT the challenger — a challenger who changed their mind resigns
      // their own open game instead, which is the withdrawal below.
      if (game.opponent || who.mri === game.challenger.mri) continue;
      game.outcome = { kind: "declined", withdrawn: false };
      continue;
    }

    const color = colorOf(game, who.mri);
    // Nobody outside the game may act on it. That is the derivation rather than a rule the
    // UI applies, which is what keeps a third person in a group chat out of it.
    if (!color) continue;

    if (wire.body.kind === "move") {
      // A move is accepted only from the player whose turn it is, only once the game has an
      // opponent, and only as the NEXT ply. Two messages claiming one ply is a real state —
      // two clients, one racing reconnect — and the earlier one wins because this walk is in
      // order; the later is refused rather than applied on top.
      if (!game.opponent || color !== game.turn || wire.body.ply !== game.moves.length + 1) {
        game.refusedPlies.push(wire.body.ply);
        continue;
      }
      game.moves.push(wire.body.san);
      game.turn = other(game.turn);
      // A move answers an open draw offer by declining it, which is what a move means.
      game.drawOfferedBy = null;
      continue;
    }

    if (wire.body.kind === "draw") {
      game.drawOfferedBy = color;
      continue;
    }

    if (wire.body.kind === "drawAccepted") {
      // Accepting one's own offer settles nothing.
      if (!game.drawOfferedBy || game.drawOfferedBy === color) continue;
      game.outcome = { kind: "drawAgreed" };
      game.drawOfferedBy = null;
      continue;
    }

    // A resignation — or, before anybody accepted, the challenger WITHDRAWING their own offer.
    // Resigning a game that never started is not a loss, and calling it one would put a defeat
    // in the thread for a game nobody played.
    game.outcome = game.opponent
      ? { kind: "resigned", by: color }
      : { kind: "declined", withdrawn: true };
    game.drawOfferedBy = null;
  }

  return order.map((id) => byId.get(id)).filter((game): game is ChessGame => !!game);
}

function playerOf(message: ChatMessage): ChessPlayer {
  return {
    mri: message.sender_mri ?? "",
    name: message.sender,
    isSelf: message.is_self === true,
  };
}

function colorOf(game: ChessGame, mri: string): ChessColor | null {
  if (mri && mri === game.challenger.mri) return game.challengerColor;
  if (mri && game.opponent && mri === game.opponent.mri) return other(game.challengerColor);
  return null;
}

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}
