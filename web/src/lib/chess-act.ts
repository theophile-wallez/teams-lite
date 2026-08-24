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
  | { kind: "open"; color: ChessColor; time: ChessTimeControl | null }
  | { kind: "join" }
  | { kind: "decline" }
  /** A move, already checked against the rules by the board that offers it. `premove` is what
   *  makes it cost a tenth of a second rather than the minutes the opponent spent thinking. */
  | {
      kind: "move";
      san: string;
      premove?: boolean;
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
      ledger: { ...newChessLedger(act.color), opened: true, time: act.time },
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
      if (!game.opponent || game.turn !== color) return null;
      const ply = game.moves.length + 1;
      const state = chessClockStateOf(game);
      const clockMs = chessRemainingAfterMove({
        time: game.time,
        stated: chessStatedFor(state, color),
        thinkStartedAt: chessThinkStartedAt(state),
        nowMs: args.nowMs,
        premove: act.premove === true,
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
      if (!game.opponent) return null;
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
      // A flag is claimed against whoever is ON the clock, and never by them.
      if (!game.opponent || game.turn === color) return null;
      return {
        game: game.id,
        messageId,
        ledger: { ...base, flagged: { color: game.turn, at: args.nowMs } },
      };
    }
  }
}
