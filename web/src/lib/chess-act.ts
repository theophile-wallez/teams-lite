/**
 * What the reader's next press PUBLISHES — one pure function, for every control in the feature.
 *
 * A ledger is a STATE (see lib/chess-wire.ts): the message is rewritten whole on every act, so
 * every button — challenge, accept, decline, move, offer a draw, accept one, resign, claim a
 * flag — is the same operation with a different argument. Deciding that here rather than in the
 * board, the page, the strip and the menu is what keeps the four of them from disagreeing about
 * what a resignation writes.
 *
 * It is also where the CLOCK is charged, which is the one part of a move a UI must not improvise:
 * the mover states what they have left, and a premove states a tenth of a second (see
 * lib/chess-clock.ts).
 */

import { chessRemainingAfterMove, chessStatedFor, chessThinkStartedAt } from "./chess-clock";
import { chessClockStateOf, type ChessGame } from "./chess-thread";
import {
  newChessLedger,
  type ChessColor,
  type ChessLedger,
  type ChessTimeControl,
} from "./chess-wire";

/** One thing a player can do to a game. */
export type ChessAct =
  | {
      kind: "open";
      color: ChessColor;
      time: ChessTimeControl | null;
      /** Open a game against the ENGINE at this strength, rather than against a colleague. */
      engineElo?: number | null;
    }
  | { kind: "join" }
  | { kind: "decline" }
  /** A move, already checked against the rules by the board that offers it. `premove` is what
   *  makes it cost a tenth of a second rather than the minutes the opponent spent thinking. */
  | {
      kind: "move";
      san: string;
      premove?: boolean;
      /** The ENGINE's own move, published by the reader's machine because the engine cannot post
       *  one. It is the only act that writes the other colour's ply, and it costs the engine the
       *  milliseconds it really searched for rather than the wall time. */
      engine?: { spentMs: number };
      /** How this move ENDED the game, when it did — the one thing only a board with the rules in
       *  it can see, said on the wire so the surfaces without them can read it. */
      ends?: "mate" | "draw" | null;
    }
  | { kind: "draw" }
  | { kind: "drawAccept" }
  | { kind: "resign" }
  /** Claim the win on time. The other machine re-checks the arithmetic before it believes it. */
  | { kind: "flag" };

/** What to publish: the whole ledger, and the message it rewrites (null the first time). */
export type ChessPublish = {
  game: string;
  ledger: ChessLedger;
  messageId: string | null;
  /** The move this publish adds, for the board to draw before it lands. */
  pending?: { ply: number; san: string; clockMs: number | null; at: number };
};

/**
 * The publish one act asks for, or null when the game does not admit it.
 *
 * Returning null is a guard rather than the way a UI decides what to offer — a control that
 * cannot act must not be drawn at all (§ the call button's own discipline). It is here so that a
 * stale press, arriving after the opponent moved, cannot post a move for a ply that has gone.
 */
export function chessPublishFor(args: {
  gameId: string;
  /** The game as the thread states it, or null for a challenge that has no game yet. */
  game: ChessGame | null;
  /** Which side the reader plays. For a decline it is the side they were offered. */
  color: ChessColor;
  act: ChessAct;
  nowMs: number;
}): ChessPublish | null {
  const { game, color, act } = args;

  if (act.kind === "open") {
    return {
      game: args.gameId,
      messageId: null,
      ledger: {
        ...newChessLedger(act.color),
        opened: true,
        time: act.time,
        // A game against the ENGINE is playable the moment it is posted: there is nobody to accept
        // it, and the token is what says so to every reader of the thread.
        engineElo: act.engineElo ?? null,
      },
    };
  }

  if (!game) return null;
  const ref = game.ledgers[color];
  const messageId = ref?.messageId ?? null;
  // Our own record so far. A player who joined a game with an older build has no ledger yet, so
  // the first one they write says how they got into the game.
  const base: ChessLedger = ref
    ? { ...ref.ledger, moves: [...ref.ledger.moves] }
    : {
        ...newChessLedger(color),
        opened: game.challenger.isSelf,
        joined: !game.challenger.isSelf && !!game.opponent?.isSelf,
        ...(game.challenger.isSelf ? { time: game.time } : {}),
      };

  switch (act.kind) {
    case "join": {
      // Only ever answered on somebody else's open challenge.
      if (game.opponent || game.challenger.isSelf) return null;
      return {
        game: game.id,
        messageId,
        ledger: { ...base, joined: true },
      };
    }
    case "decline": {
      if (game.opponent || game.challenger.isSelf) return null;
      return { game: game.id, messageId, ledger: { ...base, declined: true } };
    }
    case "move": {
      // The ENGINE's move is the reader's machine writing the other colour's ply — refused unless
      // the game really is against an engine and it really is the engine's turn, so a client cannot
      // move for a colleague by claiming one.
      const mover = act.engine ? other(color) : color;
      if (act.engine && !game.engine) return null;
      if (!game.opponent || game.turn !== mover) return null;
      const ply = game.moves.length + 1;
      const state = chessClockStateOf(game);
      const clockMs = chessRemainingAfterMove({
        time: game.time,
        stated: chessStatedFor(state, mover),
        thinkStartedAt: chessThinkStartedAt(state),
        nowMs: args.nowMs,
        premove: act.premove === true,
        ...(act.engine ? { spentMs: act.engine.spentMs } : {}),
      });
      return {
        game: game.id,
        messageId,
        ledger: {
          ...base,
          at: args.nowMs,
          moves: [...base.moves, { ply, san: act.san, clockMs }],
          // A move ANSWERS our own standing offer by leaving it behind: the offer was anchored
          // at the ply the game was at, and the game is past it now. The token is dropped
          // rather than left to age, so the line says only what is still true.
          drawOfferedAt: null,
          ended: act.ends ?? null,
        },
        pending: { ply, san: act.san, clockMs, at: args.nowMs },
      };
    }
    case "draw": {
      // An engine is not asked for a draw: there is nobody to ask.
      if (!game.opponent || game.engine) return null;
      return {
        game: game.id,
        messageId,
        ledger: { ...base, drawOfferedAt: game.moves.length },
      };
    }
    case "drawAccept": {
      // Only a standing offer from the OTHER player can be accepted.
      if (!game.drawOfferedBy || game.drawOfferedBy === color) return null;
      return {
        game: game.id,
        messageId,
        ledger: { ...base, drawAcceptedAt: game.moves.length },
      };
    }
    case "resign": {
      return { game: game.id, messageId, ledger: { ...base, resigned: true } };
    }
    case "flag": {
      // A flag is claimed against whoever is ON the clock, and never by them. An ENGINE's clock is
      // never counted down by the wall (see lib/chess-clock.ts), so there is no flag to claim
      // against one either.
      if (!game.opponent || game.engine || game.turn === color) return null;
      return {
        game: game.id,
        messageId,
        ledger: { ...base, flagged: { color: game.turn, at: args.nowMs } },
      };
    }
  }
}

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}
