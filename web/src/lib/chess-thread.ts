/**
 * Every game of chess a loaded message list holds, derived from the messages themselves.
 *
 * There is no store for a game and there is deliberately none: the position replays out of
 * the thread's own history, so a reload, a phone and a game played while this app was closed
 * all draw the same board, and there is nothing to reconcile when a frame is lost. It is the
 * property the agent's overlay has ("the row in the history IS the Teams message"), with no
 * overlay left at all.
 *
 * This module knows NO chess rules and carries no dependency beyond the wire and the clock
 * arithmetic, both of which are pure. It answers who is playing, whose turn it is, what the
 * moves were and what each clock read; whether a move is LEGAL is chess.js's answer, in the
 * lazy chunk (see components/chess-game-card.tsx). That split is what lets the pane decide a
 * board row exists, and the header draw its turn dot and its clock, without loading a rules
 * engine into the path of every chat.
 *
 * **IT READS BOTH SHAPES OF THE WIRE** (see lib/chess-wire.ts): the v1 stream, one message per
 * act, and the v2 LEDGER, one message per player that is edited as they move. A ply is
 * attributed to whoever AUTHORED the message it came in, in both — which is the property that
 * makes a merged game as trustworthy as a game of separate messages was.
 *
 * **THE WALK IS COLLECT-THEN-RESOLVE**, rather than the incremental mutation it used to be. A
 * ledger is edited in place, so its message keeps the `seq` it was first posted at — the
 * challenger's ledger has the LOWEST seq in the game and holds their fortieth move. Nothing
 * about the order of play can be read off message order any more, so the order of play is read
 * off the PLY, and the acts that end a game carry the ply they happened at.
 */

import { chessFlagIsFair, type ChessClockState } from "./chess-clock";
import { chessWireIn, type ChessColor, type ChessLedger, type ChessTimeControl } from "./chess-wire";
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
  /** A clock ran out and the other player CLAIMED it. Never taken by itself: see
   *  lib/chess-clock.ts on why nothing here ends a game on a timer. */
  | { kind: "timeout"; loser: ChessColor }
  /** Nobody took the challenge up: it was declined, or the challenger withdrew it. Either way
   *  the game never started, and the conversation is free for the next one. */
  | { kind: "declined"; withdrawn: boolean };

/** Where one player's own record lives, so a move EDITS it rather than posting again. */
export type ChessLedgerRef = { messageId: string; seq: number; ledger: ChessLedger };

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
  /** What the mover had left after each ply, in ms — `null` per ply in a game with no clock,
   *  and for a ply whose author's build did not state one. Indexed like {@link moves}. */
  moveClocks: (number | null)[];
  /** The clock the game is played with, from whoever opened it. */
  time: ChessTimeControl | null;
  /** The moment the challenge was ACCEPTED, which is when the clock starts. */
  startedAt: number | null;
  /** Each side's newest act, by their own clock. What the running clock counts from. */
  actedAt: Record<ChessColor, number | null>;
  /** Whose move it is, from the ply count. */
  turn: ChessColor;
  drawOfferedBy: ChessColor | null;
  outcome: ChessOutcome;
  /** The reader's own side, or null when they are watching. */
  ourColor: ChessColor | null;
  /** Each player's own ledger, when they keep one. A v1 game has neither. */
  ledgers: Record<ChessColor, ChessLedgerRef | null>;
  /** How the RULES ended it, when the mover said so on the wire (see `chessEndedByRules`). */
  endedByRules: "mate" | "draw" | null;
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

/**
 * Whether the RULES have ended it — as the WIRE states it, so a surface with no rules engine can
 * know too.
 *
 * Two readings, and both come off the move list this module already holds: a mating move's own SAN
 * ends in `#` (which is SAN's own notation, not an invention here), and a move that ended the game
 * any other way carries `end.draw` on the mover's ledger. Without this the strip under the header
 * and the conversation's menu — neither of which loads `chess.js`, on purpose — listed a game
 * somebody had WON as one waiting for a move, for ever.
 */
export function chessEndedByRules(game: ChessGame): "mate" | "draw" | null {
  if (game.moves.at(-1)?.endsWith("#")) return "mate";
  return game.endedByRules;
}

/** Whether this game is over for ANY reason — a message, or the rules. */
export function chessGameIsOver(game: ChessGame): boolean {
  return chessGameIsSettled(game) || chessEndedByRules(game) !== null;
}

/** The newest game still being played, or null. */
export function activeChessGame(games: ChessGame[]): ChessGame | null {
  return activeChessGames(games)[0] ?? null;
}

/**
 * Every game still being played, MOST URGENT FIRST — a game waiting for the reader before one
 * that is waiting for somebody else, and the newest before the older.
 *
 * A conversation may hold several at once (§ Chess in a conversation): a group chat holds a
 * game per pair of people, and two colleagues may want a second board while the first is still
 * going. The order is what the strip under the header draws in, so it is decided here rather
 * than in the component: what wants the reader's attention is what they should meet first.
 */
export function activeChessGames(games: ChessGame[]): ChessGame[] {
  return games
    .filter((game) => !chessGameIsOver(game))
    .sort((a, b) => {
      const wants = Number(chessWantsUs(b)) - Number(chessWantsUs(a));
      return wants !== 0 ? wants : b.challengeSeq - a.challengeSeq;
    });
}

/** One game by its id, or null — what the full-screen page resolves its URL with. */
export function chessGameById(games: ChessGame[], id: string | null | undefined): ChessGame | null {
  if (!id) return null;
  return games.find((game) => game.id === id) ?? null;
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

/** Whether the reader is playing this game at all, rather than watching it. */
export function chessWePlay(game: ChessGame): boolean {
  return !!game.ourColor;
}

/** The numbers the clocks are read from (see lib/chess-clock.ts). One place builds it, so the
 *  board, the strip and the page can never disagree about what the clocks say. */
export function chessClockStateOf(game: ChessGame): ChessClockState {
  const plies = { w: 0, b: 0 };
  for (let ply = 1; ply <= game.moves.length; ply += 1) plies[ply % 2 === 1 ? "w" : "b"] += 1;
  return {
    time: game.time,
    stated: { w: statedClock(game, "w"), b: statedClock(game, "b") },
    // What bounds a stated clock: a player gains the increment once per move they made, so
    // nothing above `base + increment × their own plies` is arithmetic anybody could reach.
    plies,
    actedAt: game.actedAt,
    startedAt: game.startedAt,
    turn: game.turn,
    settled: chessGameIsSettled(game),
    live: !!game.opponent,
  };
}

/** What a colour last stated it had left: the clock recorded against their newest ply. */
function statedClock(game: ChessGame, color: ChessColor): number | null {
  const wants = color === "w" ? 1 : 0;
  for (let ply = game.moves.length; ply >= 1; ply -= 1) {
    if (ply % 2 !== wants) continue;
    return game.moveClocks[ply - 1] ?? null;
  }
  return null;
}

/**
 * WHICH GAME a piece of this page's own state belongs to.
 *
 * A conversation holds several games at once, so the page's three chess slots — a move in flight,
 * a queued premove, and the sentence about a publish that failed — are keyed rather than single.
 * One slot for all of them drew the sentence about a refused move under EVERY board in the thread
 * and let a premove set in one game silently drop another's.
 */
export function chessSlotKey(conversationId: string, gameId: string): string {
  return `${conversationId}/${gameId}`;
}

/**
 * The game with a move this page has published but not yet seen come back — drawn as if it had
 * landed, because a board that waits for a round trip before the piece moves feels broken.
 *
 * It is here rather than in the board for two reasons: it is the same answer for the inline card
 * and for the full-screen page, and it is arithmetic on a game rather than anything about a
 * board — the clock has to move to the opponent at once too, or the reader watches their own
 * clock keep running after they have moved.
 */
export function chessGameWithPending(
  game: ChessGame,
  pending: { ply: number; san: string; clockMs: number | null; at: number } | undefined | null,
): ChessGame {
  if (!pending) return game;
  // Only the very next ply: anything else is a move the thread has already caught up with, or a
  // stale one from a board that has moved on.
  if (pending.ply !== game.moves.length + 1) return game;
  const mover = game.turn;
  return {
    ...game,
    moves: [...game.moves, pending.san],
    moveClocks: [...game.moveClocks, pending.clockMs],
    turn: other(mover),
    actedAt: { ...game.actedAt, [mover]: pending.at },
    // Our own move leaves our own offer behind, exactly as the published ledger does.
    drawOfferedBy: game.drawOfferedBy === mover ? null : game.drawOfferedBy,
  };
}

/** One claim a message makes about one ply. `seq` is the message's own, which is what settles a
 *  ply two messages both claim: the earlier one wins, exactly as it did when every move was a
 *  message of its own. */
type MoveClaim = {
  ply: number;
  san: string;
  mri: string;
  seq: number;
  clockMs: number | null;
  /** When it was played. A v1 move is timed by its own message; a ledger's moves are timed by
   *  the ledger's `at:`, which is why this is null for them. */
  at: number | null;
};

/** An act that ENDS a game, anchored at the ply the game stood at when it happened. The anchor
 *  is what replaces message order: a ledger's resignation sits in a message posted forty moves
 *  earlier, so "after the game was settled" can only be read off the ply. */
type Settlement = {
  kind: "resigned" | "drawAgreed" | "timeout" | "declined";
  /** Whose act it was. */
  by: ChessColor | null;
  /** The colour the outcome names — the loser of a resignation or a flag. */
  color: ChessColor | null;
  ply: number;
};

/** Everything one game's messages said, before any of it is resolved. */
type Draft = {
  id: string;
  order: number;
  absorbed: string[];
  open: { by: ChessPlayer; color: ChessColor; time: ChessTimeControl | null; messageId: string; seq: number } | null;
  join: { by: ChessPlayer; seq: number; at: number | null } | null;
  declines: { by: ChessPlayer; seq: number }[];
  /** v1 acts, which are ordered by their message. */
  v1: {
    resigns: { by: ChessPlayer; seq: number }[];
    draws: { by: ChessPlayer; seq: number }[];
    drawOks: { by: ChessPlayer; seq: number }[];
  };
  ledgers: { by: ChessPlayer; messageId: string; seq: number; ledger: ChessLedger }[];
  moves: MoveClaim[];
};

/** The games this message list holds, in the order they were opened. */
export function chessGamesInThread(messages: ChatMessage[]): ChessGame[] {
  const drafts = new Map<string, Draft>();

  for (const message of messages) {
    const wire = chessWireIn(message);
    if (!wire) continue;
    const who = playerOf(message);
    const draft = drafts.get(wire.game) ?? blankDraft(wire.game, drafts.size);
    drafts.set(wire.game, draft);
    draft.absorbed.push(message.id);

    if (wire.body.kind === "ledger") {
      const ledger = wire.body.ledger;
      // ONE ledger per person per game: the first they wrote. A second is absorbed and
      // ignored, for the reason a second `open` is — the first is the record every reader has
      // already started replaying, and two would double every move in it.
      if (draft.ledgers.some((l) => l.by.mri === who.mri)) continue;
      draft.ledgers.push({ by: who, messageId: message.id, seq: message.seq, ledger });
      if (ledger.opened && !draft.open) {
        draft.open = {
          by: who,
          color: ledger.color,
          time: ledger.time,
          messageId: message.id,
          seq: message.seq,
        };
      }
      if (ledger.joined && !draft.join) {
        // THE ACCEPT IS TIMED BY ITS OWN MESSAGE, never by the ledger's `at:`. A ledger is
        // edited in place but its `compose_time` is the moment it was first posted — which for
        // the accepting player IS the moment they accepted — and it is stamped by the service
        // rather than claimed by a client. Reading the accept off `at:` made the moment the
        // clock starts from move forward every time that player moved again.
        draft.join = { by: who, seq: message.seq, at: message.compose_time };
      }
      if (ledger.declined) draft.declines.push({ by: who, seq: message.seq });
      for (const move of ledger.moves) {
        draft.moves.push({
          ply: move.ply,
          san: move.san,
          mri: who.mri,
          seq: message.seq,
          clockMs: move.clockMs,
          at: null,
        });
      }
      continue;
    }

    switch (wire.body.kind) {
      case "open":
        if (!draft.open) {
          draft.open = {
            by: who,
            color: wire.body.color,
            time: wire.body.time ?? null,
            messageId: message.id,
            seq: message.seq,
          };
        }
        break;
      case "join":
        // The FIRST colleague to answer is the opponent.
        if (!draft.join) draft.join = { by: who, seq: message.seq, at: message.compose_time };
        break;
      case "decline":
        draft.declines.push({ by: who, seq: message.seq });
        break;
      case "move":
        draft.moves.push({
          ply: wire.body.ply,
          san: wire.body.san,
          mri: who.mri,
          seq: message.seq,
          // A v1 move states no clock, and its own moment is the message's: a game played
          // one message per move needs nothing on the wire to be timed.
          clockMs: null,
          at: message.compose_time,
        });
        break;
      case "draw":
        draft.v1.draws.push({ by: who, seq: message.seq });
        break;
      case "drawAccepted":
        draft.v1.drawOks.push({ by: who, seq: message.seq });
        break;
      case "resign":
        draft.v1.resigns.push({ by: who, seq: message.seq });
        break;
    }
  }

  return [...drafts.values()]
    .sort((a, b) => a.order - b.order)
    .map(resolve)
    .filter((game): game is ChessGame => !!game);
}

function blankDraft(id: string, order: number): Draft {
  return {
    id,
    order,
    absorbed: [],
    open: null,
    join: null,
    declines: [],
    v1: { resigns: [], draws: [], drawOks: [] },
    ledgers: [],
    moves: [],
  };
}

/**
 * One draft, turned into a game.
 *
 * A draft with no `open` is not a game this app can draw: the history pages older, so the
 * challenge may simply not be loaded yet, and a board built from the tail of a game would show
 * a position that never happened.
 */
function resolve(draft: Draft): ChessGame | null {
  const open = draft.open;
  if (!open) return null;

  const challenger = open.by;
  const challengerColor = open.color;
  const opponentColor = other(challengerColor);
  // A game needs two people: the challenger cannot answer their own challenge.
  const opponent = draft.join && draft.join.by.mri !== challenger.mri ? draft.join.by : null;

  const colorOf = (mri: string): ChessColor | null => {
    if (mri && mri === challenger.mri) return challengerColor;
    if (mri && opponent && mri === opponent.mri) return opponentColor;
    return null;
  };

  // ---- the moves ---------------------------------------------------------------
  //
  // One claim per ply, the earliest message winning, and only from the player whose colour that
  // ply belongs to. Then the longest run from ply 1: a gap means the message carrying the ply
  // before it is not loaded (or never arrived), and a board drawn past a gap is a position
  // nobody played.
  const claims = new Map<number, MoveClaim>();
  const refusedPlies: number[] = [];
  for (const claim of [...draft.moves].sort((a, b) => a.seq - b.seq || a.ply - b.ply)) {
    const color = colorOf(claim.mri);
    const wants = claim.ply % 2 === 1 ? "w" : "b";
    // Nobody outside the game may act on it, a ply belongs to one colour, and a move before
    // anybody accepted is a move in a game that had not started.
    if (!opponent || !color || color !== wants) {
      refusedPlies.push(claim.ply);
      continue;
    }
    if (claims.has(claim.ply)) {
      refusedPlies.push(claim.ply);
      continue;
    }
    claims.set(claim.ply, claim);
  }
  const applied: MoveClaim[] = [];
  for (let ply = 1; claims.has(ply); ply += 1) applied.push(claims.get(ply) as MoveClaim);

  /** How many plies had been played when a v1 message was posted. A v1 act is ordered by its
   *  own message, which is the one thing a stream of messages states better than a ledger. */
  const plyAtSeq = (seq: number): number => {
    let count = 0;
    for (const move of applied) {
      if (move.seq < seq) count += 1;
      else break;
    }
    return count;
  };

  // ---- what ENDED it ----------------------------------------------------------
  const settlements: Settlement[] = [];

  // A resignation — or, before anybody accepted, the challenger WITHDRAWING their own offer.
  // Resigning a game that never started is not a loss, and calling it one would put a defeat
  // in the thread for a game nobody played.
  for (const resign of draft.v1.resigns) {
    const color = colorOf(resign.by.mri);
    if (!color) continue;
    settlements.push(
      opponent
        ? { kind: "resigned", by: color, color, ply: plyAtSeq(resign.seq) }
        : { kind: "declined", by: color, color: null, ply: 0 },
    );
  }
  for (const entry of draft.ledgers) {
    const color = colorOf(entry.by.mri);
    if (!color || !entry.ledger.resigned) continue;
    settlements.push(
      opponent
        ? { kind: "resigned", by: color, color, ply: ledgerPly(entry.ledger) }
        : { kind: "declined", by: color, color: null, ply: 0 },
    );
  }

  // A challenge nobody took up. Only meaningful before somebody accepted, and only from
  // somebody who is NOT the challenger.
  for (const decline of draft.declines) {
    if (opponent || decline.by.mri === challenger.mri) continue;
    settlements.push({ kind: "declined", by: null, color: null, ply: 0 });
  }

  // A draw stands only while the game is still at the ply it was offered at, so a move answers
  // an offer by declining it — which is what a move means — with nothing to clear.
  const offeredAt = new Map<ChessColor, number>();
  for (const draw of draft.v1.draws) {
    const color = colorOf(draw.by.mri);
    if (color) offeredAt.set(color, plyAtSeq(draw.seq));
  }
  for (const entry of draft.ledgers) {
    const color = colorOf(entry.by.mri);
    if (color && entry.ledger.drawOfferedAt !== null) {
      offeredAt.set(color, entry.ledger.drawOfferedAt);
    }
  }
  const acceptDraw = (by: ChessColor, ply: number): void => {
    // Accepting one's own offer settles nothing, and neither does accepting an offer that no
    // longer stood at that ply.
    if (offeredAt.get(other(by)) !== ply) return;
    settlements.push({ kind: "drawAgreed", by, color: null, ply });
  };
  for (const ok of draft.v1.drawOks) {
    const color = colorOf(ok.by.mri);
    if (color) acceptDraw(color, plyAtSeq(ok.seq));
  }
  for (const entry of draft.ledgers) {
    const color = colorOf(entry.by.mri);
    if (color && entry.ledger.drawAcceptedAt !== null) {
      acceptDraw(color, entry.ledger.drawAcceptedAt);
    }
  }

  // ---- the clocks -------------------------------------------------------------
  const time = open.time;
  const actedAt: Record<ChessColor, number | null> = { w: null, b: null };
  // A v1 game states no moment on the wire and needs none: its acts ARE messages, so the
  // message's own compose time is when the move was played.
  for (const move of applied) {
    if (move.at === null) continue;
    const color = move.ply % 2 === 1 ? "w" : "b";
    actedAt[color] = Math.max(actedAt[color] ?? 0, move.at);
  }
  // A LEDGER states its own: `at:` is the moment of that author's newest act, which is the one
  // thing a message edited in place can no longer be timed by (its `compose_time` is the moment
  // the game started, forty moves ago).
  for (const entry of draft.ledgers) {
    const color = colorOf(entry.by.mri);
    if (color && entry.ledger.at !== null) actedAt[color] = entry.ledger.at;
  }
  const startedAt = draft.join?.at ?? null;

  // A flag is CHECKED before it is believed: the arithmetic both machines hold has to agree
  // that the clock really was out at the moment it was claimed (see chessFlagIsFair).
  const ply = applied.length;
  for (const entry of draft.ledgers) {
    const by = colorOf(entry.by.mri);
    const claim = entry.ledger.flagged;
    if (!by || !claim) continue;
    const state: ChessClockState = {
      time,
      stated: {
        w: statedOfApplied(applied, "w"),
        b: statedOfApplied(applied, "b"),
      },
      actedAt,
      startedAt,
      turn: ply % 2 === 0 ? "w" : "b",
      settled: false,
      live: !!opponent,
    };
    if (chessFlagIsFair(state, { by, color: claim.color, at: claim.at })) {
      settlements.push({ kind: "timeout", by, color: claim.color, ply });
    }
  }

  // The EARLIEST settlement is the one that ended the game, and it bounds the move list: a move
  // claimed after a resignation is absorbed and ignored, exactly as it was when the walk was
  // incremental.
  settlements.sort((a, b) => a.ply - b.ply);
  const settlement = settlements[0] ?? null;
  const moves = settlement ? applied.slice(0, settlement.ply) : applied;

  const outcome: ChessOutcome = !settlement
    ? { kind: "playing" }
    : settlement.kind === "resigned"
      ? { kind: "resigned", by: settlement.color as ChessColor }
      : settlement.kind === "timeout"
        ? { kind: "timeout", loser: settlement.color as ChessColor }
        : settlement.kind === "drawAgreed"
          ? { kind: "drawAgreed" }
          : { kind: "declined", withdrawn: settlement.by !== null };

  const turn: ChessColor = moves.length % 2 === 0 ? "w" : "b";
  // An offer stands only at the ply the game is really at now.
  let drawOfferedBy: ChessColor | null = null;
  for (const [color, at] of offeredAt) {
    if (at === moves.length && outcome.kind === "playing") drawOfferedBy = color;
  }

  const ledgers: Record<ChessColor, ChessLedgerRef | null> = { w: null, b: null };
  let endedByRules: "mate" | "draw" | null = null;
  for (const entry of draft.ledgers) {
    const color = colorOf(entry.by.mri);
    if (!color) continue;
    if (!ledgers[color]) {
      ledgers[color] = { messageId: entry.messageId, seq: entry.seq, ledger: entry.ledger };
    }
    // Only from a player IN the game, and only while the game really reached that ply: a claim
    // that the rules ended a game whose moves were truncated by a resignation says nothing.
    if (entry.ledger.ended && moves.length > 0) endedByRules = entry.ledger.ended;
  }

  const ourColor: ChessColor | null = challenger.isSelf
    ? challengerColor
    : opponent?.isSelf
      ? opponentColor
      : null;

  return {
    id: draft.id,
    challengeMessageId: open.messageId,
    challengeSeq: open.seq,
    challenger,
    challengerColor,
    opponent,
    moves: moves.map((m) => m.san),
    moveClocks: moves.map((m) => m.clockMs),
    time,
    startedAt,
    actedAt,
    turn,
    drawOfferedBy,
    outcome,
    ourColor,
    ledgers,
    endedByRules,
    absorbed: draft.absorbed,
    refusedPlies,
  };
}

/** The ply a ledger's own record reaches — what its terminal acts are anchored at when the
 *  ledger does not say (a build that wrote `resign` with no ply). */
function ledgerPly(ledger: ChessLedger): number {
  return ledger.moves.reduce((max, move) => Math.max(max, move.ply), 0);
}

/** What a colour last stated it had left, over a list of applied claims. */
function statedOfApplied(applied: MoveClaim[], color: ChessColor): number | null {
  const wants = color === "w" ? 1 : 0;
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const move = applied[i];
    if (!move || move.ply % 2 !== wants) continue;
    return move.clockMs;
  }
  return null;
}

function playerOf(message: ChatMessage): ChessPlayer {
  return {
    mri: message.sender_mri ?? "",
    name: message.sender,
    isSelf: message.is_self === true,
  };
}

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}
