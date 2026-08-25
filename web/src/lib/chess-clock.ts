/**
 * The two clocks, derived — like everything else about a game of chess here.
 *
 * Nothing about a game is stored (see lib/chess-thread.ts), so a clock cannot be a countdown
 * some page started: a reload, a phone picked up ten minutes later and an app that was closed
 * for an hour all have to draw the SAME two numbers. So the wire carries two facts per player
 * and this module does arithmetic on them:
 *
 *   - what they had LEFT after their own last move (`clockMs` on a ledger's move), and
 *   - WHEN that move was played, by their own clock (`at:` on their ledger).
 *
 * Everything else follows. The side to move is counting down from the moment their opponent
 * moved; the other side's clock is frozen at what they stated. Two machines replaying the same
 * thread reach the same numbers, and a machine that was asleep reaches them too.
 *
 * **WHOSE CLOCK IS AUTHORITATIVE: each player's own, and nothing here pretends otherwise.**
 * There is no server in this feature — a move is a message — so the mover states their own
 * remaining time and the opponent can only compare it against the moment the message says it
 * was played. A player who wanted to could state a number they had not earned. That is the
 * honest limit of a clock played over a chat, it is written here rather than hidden, and it is
 * the same trust a friendly game already extends: a colleague who would rather cheat a clock
 * can also take a move back by hand.
 *
 * **NOTHING ENDS A GAME BY ITSELF.** A clock reaching zero makes a win CLAIMABLE by the player
 * who is not on the clock (`flag:` on their ledger, checked by {@link chessFlagIsFair} before
 * it is believed). A laptop that went to sleep therefore never loses a game on its own, and a
 * flag nobody claims leaves the game where it was — which is what lichess does with no server
 * in the middle, and the only shape that does not need one.
 */

import type { ChessColor, ChessTimeControl } from "./chess-wire";

/** The default: ten minutes each, no increment. The one the challenge form opens on, because a
 *  ten-minute game is what somebody who says "fancy a game?" in a chat means. */
export const CHESS_DEFAULT_TIME: ChessTimeControl = { base: 600, increment: 0 };

/** What a premove COSTS the player who set it: a tenth of a second, whatever the wall clock
 *  says. A premove is a move that was already decided, so charging the seconds the opponent
 *  spent thinking would punish the reader for the opponent's time — and charging nothing at all
 *  would make a premoved game free. It is chess.com's own bargain, at chess.com's own price. */
export const PREMOVE_SPEND_MS = 100;

/** Below this the clock is read as URGENT and drawn as such. */
export const CHESS_LOW_TIME_MS = 30_000;
/** Below this it counts tenths, because whole seconds are useless at this end. */
export const CHESS_TENTHS_BELOW_MS = 20_000;

/** The clocks a challenge may be set to. `null` is a game with no clock at all, which is what
 *  every game played before this feature existed has. */
export const CHESS_TIME_CONTROLS: { label: string; time: ChessTimeControl | null }[] = [
  { label: "1 min", time: { base: 60, increment: 0 } },
  { label: "3 min", time: { base: 180, increment: 0 } },
  { label: "3 | 2", time: { base: 180, increment: 2 } },
  { label: "5 min", time: { base: 300, increment: 0 } },
  { label: "10 min", time: CHESS_DEFAULT_TIME },
  { label: "10 | 5", time: { base: 600, increment: 5 } },
  { label: "15 | 10", time: { base: 900, increment: 10 } },
  { label: "30 min", time: { base: 1800, increment: 0 } },
  { label: "No clock", time: null },
];

/** Everything the arithmetic needs, and no more — primitives, so this module never depends on
 *  the shape of a game and can be tested with three numbers. */
export type ChessClockState = {
  time: ChessTimeControl | null;
  /** What each side had left after their own last move, or null when they have not moved. */
  stated: Record<ChessColor, number | null>;
  /** How many plies each side has PLAYED. It is what bounds a stated clock (see
   *  {@link chessClockCeilingMs}), and it is derived from the same move list the clocks are. */
  plies?: Record<ChessColor, number>;
  /**
   * The side an ENGINE plays, when one does.
   *
   * Its clock is drawn as STATED rather than counted down, and that is a fact about what an engine
   * is: it thinks in bursts of a second while the reader is at the board, and it cannot think at
   * all while the app is closed. Counting wall time against it would drain a ten-minute clock over
   * a lunch break and hand the reader a win on time they did not play for — which is exactly the
   * fake ending the flag rules exist to prevent. What it costs is stated: an engine's clock only
   * moves when it really searched (see `chessRemainingAfterMove` and the `spentMs` a caller passes
   * for an engine move).
   */
  engineSide?: ChessColor | null;
  /** The moment of each side's newest act, by their own clock. */
  actedAt: Record<ChessColor, number | null>;
  /** When the clock STARTED: the moment the challenge was accepted. Before that a game has
   *  two full clocks and neither is running — nobody is on the clock in a game nobody joined. */
  startedAt: number | null;
  turn: ChessColor;
  /** Whether a MESSAGE has ended the game. Both clocks then freeze at what was stated. */
  settled: boolean;
  /** Whether the game is playable at all — somebody accepted it. */
  live: boolean;
};

/** What the two clocks read right now. */
export type ChessClockReading = {
  /** ms left, or null in a game with no clock. */
  white: number | null;
  black: number | null;
  /** Whose clock is counting down, or null when neither is. */
  running: ChessColor | null;
  /** Whose clock is OUT. A win is then claimable by the other side — never taken by itself. */
  flagged: ChessColor | null;
};

const NO_CLOCK: ChessClockReading = { white: null, black: null, running: null, flagged: null };

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}

/**
 * THE MOST A SIDE COULD POSSIBLY HAVE, from the ledger alone.
 *
 * The mover states their own remaining time and nothing here can prove it (above). What CAN be
 * proved is the ceiling: a player begins with the base and gains the increment once per move they
 * have made, so no honest clock is ever above `base + increment × their own plies`. A stated
 * number over that is arithmetic nobody could have reached, so it is clamped rather than believed
 * — and the clamp uses only what both machines already hold, so both reach the same answer.
 *
 * It is a CEILING and not a check: it catches a build with a bug and a clock nudged by hand, and
 * it cannot catch a player who states a little less than the ceiling. That limit is stated where
 * the trust is (see the head of this file) rather than papered over.
 */
export function chessClockCeilingMs(time: ChessTimeControl | null, ownPlies: number): number {
  if (!time) return 0;
  return (time.base + time.increment * Math.max(0, ownPlies)) * 1000;
}

/** What a side has on their clock before their current turn: their own last statement, or the
 *  whole base for a side that has not moved yet. */
function statedOf(state: ChessClockState, color: ChessColor): number {
  const stated = state.stated[color];
  if (stated !== null && stated !== undefined) {
    return Math.min(
      Math.max(0, stated),
      chessClockCeilingMs(state.time, state.plies?.[color] ?? 0),
    );
  }
  return (state.time?.base ?? 0) * 1000;
}

/**
 * The moment the side to move started thinking: when their opponent last acted, and failing
 * that when the game was accepted.
 *
 * It is the opponent's act rather than one's own for the reason a chess clock is one clock with
 * two faces: the moment my move lands, your time starts. Falling back to the accept is what
 * makes the FIRST move of a game cost white something rather than being free.
 */
export function chessThinkStartedAt(state: ChessClockState): number | null {
  return state.actedAt[other(state.turn)] ?? state.startedAt;
}

/** The two clocks, at `nowMs`. */
export function chessClockReading(state: ChessClockState, nowMs: number): ChessClockReading {
  if (!state.time) return NO_CLOCK;
  const mine = statedOf(state, "w");
  const theirs = statedOf(state, "b");
  const byColor = { w: mine, b: theirs };

  // A game nobody has joined, and a game a message has ended, both hold two still clocks. The
  // second is what makes a resignation readable a week later: the numbers say where the game
  // stopped rather than counting down for ever behind a finished board.
  if (!state.live || state.settled) {
    return { white: mine, black: theirs, running: null, flagged: outOf(byColor) };
  }

  // An ENGINE's clock is never counted down by the wall: it is drawn where its own searches left
  // it, and nothing else is running while it is the engine's turn.
  if (state.engineSide && state.turn === state.engineSide) {
    return { white: mine, black: theirs, running: null, flagged: outOf(byColor) };
  }

  const from = chessThinkStartedAt(state);
  // No moment to count from — a game whose ledgers carry no `at:` at all. The clocks are drawn
  // as stated rather than guessed at, because a countdown from "now" would restart on every
  // reload and every reader would see a different number.
  if (from === null) {
    return { white: mine, black: theirs, running: null, flagged: outOf(byColor) };
  }

  const elapsed = Math.max(0, nowMs - from);
  const left = Math.max(0, byColor[state.turn] - elapsed);
  const reading: ChessClockReading = {
    white: state.turn === "w" ? left : mine,
    black: state.turn === "b" ? left : theirs,
    running: left > 0 ? state.turn : null,
    flagged: null,
  };
  reading.flagged = outOf({ w: reading.white ?? 0, b: reading.black ?? 0 });
  return reading;
}

/** Whose clock is out. The side to move is asked about first: in a game where both numbers
 *  reached zero, the one on the clock is the one who ran out of time. */
function outOf(byColor: Record<ChessColor, number>): ChessColor | null {
  if (byColor.w <= 0) return "w";
  if (byColor.b <= 0) return "b";
  return null;
}

/**
 * What the mover has left after playing — the number their ledger states.
 *
 * The increment is added only to a clock that survived the move: a player whose time ran out
 * while they were thinking has flagged, and handing them two seconds for the move that took
 * them past zero would undo it.
 */
export function chessRemainingAfterMove(args: {
  time: ChessTimeControl | null;
  /** What they had before this move. */
  stated: number;
  /** When their turn started — {@link chessThinkStartedAt}. */
  thinkStartedAt: number | null;
  nowMs: number;
  /** A premove costs {@link PREMOVE_SPEND_MS} rather than the time that really passed. */
  premove?: boolean;
  /** What the mover really SPENT, when the caller knows better than the wall clock does. It is the
   *  ENGINE's own case: it spent the milliseconds it searched for, and the minutes the app was
   *  closed are not its thinking time. */
  spentMs?: number;
}): number | null {
  if (!args.time) return null;
  const spent = args.premove
    ? PREMOVE_SPEND_MS
    : args.spentMs !== undefined
      ? Math.max(0, args.spentMs)
      : args.thinkStartedAt === null
        ? 0
        : Math.max(0, args.nowMs - args.thinkStartedAt);
  const left = args.stated - spent;
  if (left <= 0) return 0;
  return left + args.time.increment * 1000;
}

/** What the mover has on their clock right now, which is what {@link chessRemainingAfterMove}
 *  starts from. */
export function chessStatedFor(state: ChessClockState, color: ChessColor): number {
  return statedOf(state, color);
}

/**
 * Whether a claimed flag is FAIR — checked before the derivation believes it.
 *
 * A claim is one player saying "at this moment, your clock was out". Both machines hold the
 * same numbers, so both can check it: the claim must name the side on the clock, it must come
 * from the other player, and the arithmetic at the claim's own moment must agree. A claim that
 * does not is refused rather than applied, which is what stops a game being ended by a machine
 * whose clock is wrong — or by a player who would rather not lose it.
 */
export function chessFlagIsFair(
  state: ChessClockState,
  claim: { by: ChessColor; color: ChessColor; at: number | null },
): boolean {
  if (!state.time || !state.live || claim.at === null) return false;
  // Only the player who is NOT on the clock may claim, and only against the side that is.
  if (claim.color !== state.turn || claim.by === claim.color) return false;
  const reading = chessClockReading({ ...state, settled: false }, claim.at);
  return reading.flagged === claim.color;
}

/**
 * A clock, as a reader reads one: `10:00`, `1:05`, and tenths below twenty seconds, where whole
 * seconds tell somebody nothing about whether they can still make a move.
 */
export function formatChessClock(ms: number | null): string {
  if (ms === null) return "—";
  const clamped = Math.max(0, ms);
  if (clamped < CHESS_TENTHS_BELOW_MS) {
    return `${Math.floor(clamped / 1000)}.${Math.floor((clamped % 1000) / 100)}`;
  }
  const total = Math.ceil(clamped / 1000);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** How often a running clock is redrawn. Ten times a second below twenty seconds, where the
 *  tenths move; four times a second above it, which is enough for a second to look honest and
 *  cheap enough to leave a virtualized history alone. */
export function chessClockTickMs(reading: ChessClockReading): number {
  if (!reading.running) return 0;
  const live = reading.running === "w" ? reading.white : reading.black;
  return live !== null && live < CHESS_TENTHS_BELOW_MS ? 100 : 250;
}
