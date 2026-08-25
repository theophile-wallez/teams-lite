/**
 * Everything a BOARD does, in one place — used by the card in the history and by the full-screen
 * page, so the two can never disagree about what a press means.
 *
 * This is the LAZY half of the feature and one of the two places `chess.js` is imported (the
 * other is the score sheet's own replay): the move list the thread states is replayed into a
 * position here, and what is legal is ASKED of the rules rather than worked out. The pure halves
 * — which games exist, whose turn it is, what the clocks read, what a press publishes — are
 * lib/chess-thread.ts, lib/chess-clock.ts and lib/chess-act.ts, and none of them carries a
 * dependency. That split is what keeps a rules engine off the path of every chat.
 *
 * Six behaviours live here, and each one is a decision rather than a mechanism:
 *
 *   - **A move is drawn before it lands and taken back if it does not leave** — the composer's
 *     own rule, because a move that did not go out is otherwise invisible.
 *   - **The reader can walk BACK through the game**, and a move arriving while they are in the
 *     past leaves them there — unless it becomes their turn, when the board snaps to the live
 *     position. Their clock is running; leaving them reviewing an old position would cost them
 *     the game, which is the one thing a review must not do.
 *   - **A PREMOVE is a private intention**: nothing is published until it is legal, and the
 *     moment their opponent's move lands it plays itself for a tenth of a second.
 *   - **A promotion is asked over the board**, and answered by the rules rather than by spelling
 *     a SAN here.
 *   - **The sounds follow the MOVES, not the presses**: the board makes a noise when the position
 *     changes, so a move that arrives from the other machine sounds exactly like one played here.
 *   - **Nothing is playable except at the live position, on the reader's own turn, with nothing
 *     of theirs already in flight.**
 */

import { Chess, type Move, type Square } from "chess.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chessPublishFor, type ChessAct } from "~/lib/chess-act";
import { type ChessClockReading } from "~/lib/chess-clock";
import { NO_CHESS_ENGINE } from "~/lib/chess-engine";
import { chessOutcomeSound, chessSoundFor, playChessSound } from "~/lib/chess-sound";
import {
  chessGameIsSettled,
  chessGameWithPending,
  chessPlayerOf,
  chessSlotKey,
  chessTurnIsOurs,
  type ChessGame,
} from "~/lib/chess-thread";
import type { ChessColor } from "~/lib/chess-wire";
import type { ChessPromotionPiece, ChessPromotionPrompt } from "./chess-board";
import { useAppState, useOptionalAppState, useOptionalController } from "./controller-context";
import { useChessClock } from "./use-chess-clock";
import { useChessEngine } from "./use-chess-engine";

/** What the rules say about a move list. */
export type ChessReplay = {
  chess: Chess;
  /** The ply the replay stopped at, when a move was not legal there. */
  brokeAt: number | null;
  /** The position after every ply, as a FEN. Index 0 is the starting position. */
  positions: string[];
  /** The squares each ply moved between, for the board's own highlight. */
  moved: [string, string][];
  /** Whether the position after each ply is a check — what the sound reads. */
  checks: boolean[];
  /** chess.js's own flags per ply, which is how a capture is told from a castle. */
  flags: string[];
};

/**
 * Replay a move list into every position it passed through.
 *
 * Every position is kept rather than just the last one, because walking back through a game is
 * then an index rather than a re-replay per press — a forty-move game is forty FENs, and the
 * alternative re-runs the rules on every arrow key.
 */
export function chessReplay(moves: string[]): ChessReplay {
  const chess = new Chess();
  const positions: string[] = [chess.fen()];
  const moved: [string, string][] = [];
  const checks: boolean[] = [];
  const flags: string[] = [];
  for (let i = 0; i < moves.length; i += 1) {
    try {
      const made = chess.move(moves[i] as string);
      positions.push(chess.fen());
      moved.push([made.from, made.to]);
      checks.push(chess.inCheck());
      flags.push(made.flags);
    } catch {
      return { chess, brokeAt: i + 1, positions, moved, checks, flags };
    }
  }
  return { chess, brokeAt: null, positions, moved, checks, flags };
}

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}

/** How a finished game finished, from the reader's own side. Null while it is still going. */
export type ChessResult = "win" | "lose" | "draw" | null;

export type ChessBoardApi = {
  /** The game with anything this page has published but not yet seen come back. */
  game: ChessGame;
  /** The position ON SCREEN, which is the live one unless the reader walked back. */
  fen: string;
  orientation: ChessColor;
  lastMove: [string, string] | null;
  check: string | null;
  selected: string | null;
  targets: string[];
  premove: [string, string] | null;
  promotion: ChessPromotionPrompt | null;
  /** Whether the reader may move right now. */
  ourMove: boolean;
  /** A move list the rules could not replay stops here, and the board SAYS so. */
  brokeAt: number | null;
  /** Which ply is drawn, and whether that is the newest one. */
  viewPly: number;
  atLive: boolean;
  plies: number;
  clock: ChessClockReading;
  /** Whose clock ran out, when somebody's has and nobody has claimed it yet. */
  flagClaimable: ChessColor | null;
  result: ChessResult;
  /** What the reader is owed in one line. */
  status: string;
  /** The moves as SAN, with the clock each was played on — what a score sheet draws. */
  moves: { ply: number; san: string; clockMs: number | null }[];
  press: (square: string) => void;
  drop: (from: string, to: string) => boolean;
  rightClick: (square: string) => void;
  promote: (piece: ChessPromotionPiece) => void;
  cancelPromotion: () => void;
  goTo: (ply: number) => void;
  step: (delta: number) => void;
  /** Take an act — accept, decline, offer or accept a draw, resign, claim a flag. */
  act: (act: ChessAct) => void;
  /** Whether the reader is a player in this game with a controller to act through. */
  canAct: boolean;
  error: string | null;
  /** Whether this game is against the ENGINE, and whether it is searching right now — which is what
   *  the board draws in place of "waiting for them". */
  engine: { elo: number } | null;
  engineThinking: boolean;
};

export function useChessGame(args: {
  game: ChessGame;
  conversationId: string;
  /** Whether this board makes a noise. The inline card in the history does not: a conversation
   *  that clicked at every move of every game in it would be a conversation nobody could read
   *  in an open-plan office. */
  sounds: boolean;
}): ChessBoardApi {
  // The optional hooks are the seam `RichContent` already uses: a board renders inside a
  // virtualized history and is server-rendered by its own tests, so it must draw with no provider
  // around it — read-only, which is exactly what a board with no controller is.
  const controller = useOptionalController();
  // Every slot is keyed by conversation AND game, because a conversation holds several games at
  // once: read by game rather than as one, so a refused move in one board's game cannot draw its
  // sentence under another's.
  const slot = chessSlotKey(args.conversationId, args.game.id);
  const error = useOptionalAppState((s) => s.chessError[slot] ?? null, null);
  const pending = useOptionalAppState((s) => s.chessPending[slot] ?? null, null);
  const storedPremove = useOptionalAppState((s) => s.chessPremove[slot] ?? null, null);
  const soundsEnabled = useOptionalAppState((s) => s.soundsEnabled, false);
  // What this machine holds of the ENGINE. A board with no controller (a server-rendered test) reads
  // "absent", which is what makes an engine game render as a board rather than throw.
  const engineState = useOptionalAppState((s) => s.chessEngine, NO_CHESS_ENGINE);

  const [selected, setSelected] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<ChessPromotionPrompt | null>(null);
  // Which ply is on screen. `null` means the newest one, which is not the same as "the last ply I
  // saw": a game that gains a move while the reader is at the live position must stay live.
  const [viewing, setViewing] = useState<number | null>(null);

  // A move this page has published and not yet seen come back is drawn as if it had landed.
  const game = useMemo(() => chessGameWithPending(args.game, pending), [args.game, pending]);
  const ourColor = game.ourColor;
  const settledByMessage = chessGameIsSettled(game);

  const replay = useMemo(() => chessReplay(game.moves), [game.moves]);
  const plies = replay.positions.length - 1;
  const viewPly = viewing === null ? plies : Math.max(0, Math.min(viewing, plies));
  const atLive = viewPly === plies;

  const chess = useMemo(() => {
    // The live position is the one the replay already holds; an earlier one is read out of the
    // FEN list, which is why every position is kept.
    if (atLive) return replay.chess;
    try {
      return new Chess(replay.positions[viewPly]);
    } catch {
      return replay.chess;
    }
  }, [atLive, replay, viewPly]);

  const settled = settledByMessage || replay.chess.isGameOver() || replay.brokeAt !== null;
  const clock = useChessClock(game, settled);

  // Ours to move only at the LIVE position, on our own turn, and while nothing of ours is already
  // in flight: a second press before the first move's message comes back would claim a ply the
  // thread has not reached.
  const ourMove =
    !settled &&
    atLive &&
    chessTurnIsOurs(game) &&
    game.moves.length === args.game.moves.length &&
    !!controller;

  // A premove is only OURS, only in this game, and only while the game is still going.
  const premove =
    storedPremove && !settled
      ? ([storedPremove.from, storedPremove.to] as [string, string])
      : null;

  /** Whether a premove may be SET right now: the game is live, we play it, and it is the other
   *  side's turn — which is the only moment a premove means anything. */
  const canPremove =
    !settled && atLive && !!ourColor && !!game.opponent && !!controller && game.turn !== ourColor;

  /** The position a premove is chosen in: the live one, with the turn handed to us. chess.js is
   *  asked what is legal there, so a premove is a real move rather than any two squares — and a
   *  position that cannot be spelled that way (the opponent's king would be in check) simply
   *  offers none. */
  const premoveChess = useMemo(() => {
    if (!canPremove || !ourColor) return null;
    const parts = replay.chess.fen().split(" ");
    parts[1] = ourColor;
    // A flipped turn makes any en-passant target nonsense, and a stale one is what chess.js
    // would refuse the FEN for.
    parts[3] = "-";
    try {
      return new Chess(parts.join(" "));
    } catch {
      return null;
    }
  }, [canPremove, ourColor, replay.chess]);

  /** Which rules answer "what can this square do": the real position on our turn, the flipped one
   *  while we are setting a premove, and nothing at all otherwise. */
  const asking = ourMove ? chess : premoveChess;

  const fromSelected: Move[] = useMemo(() => {
    if (!asking || !selected) return [];
    try {
      return asking.moves({ square: selected as Square, verbose: true });
    } catch {
      return [];
    }
  }, [asking, selected]);

  const targets = useMemo(() => [...new Set(fromSelected.map((m) => m.to))], [fromSelected]);

  /** The king in check, which is the one square the renderer cannot work out for itself. */
  const check = useMemo(() => {
    if (!chess.inCheck()) return null;
    for (const rank of chess.board()) {
      for (const cell of rank) {
        if (cell?.type === "k" && cell.color === chess.turn()) return cell.square;
      }
    }
    return null;
  }, [chess]);

  // ---- publishing -------------------------------------------------------------------

  // THE SEAT the reader acts from. It is their own colour once they are in the game — and, while
  // nobody has accepted somebody else's challenge, the colour they WOULD take. Without that second
  // half the reader who was challenged has no colour at all, so Accept and Decline published
  // nothing and pressed nothing: the two controls that are the whole of being challenged.
  const seatColor: ChessColor | null =
    ourColor ?? (game.opponent ? null : other(game.challengerColor));

  const publish = useCallback(
    (act: ChessAct): void => {
      if (!controller || !seatColor) return;
      const publishArgs = chessPublishFor({
        gameId: game.id,
        game: args.game,
        color: seatColor,
        act,
        nowMs: Date.now(),
      });
      if (!publishArgs) return;
      void controller.publishChessLedger(args.conversationId, publishArgs);
    },
    [args.conversationId, args.game, controller, game.id, seatColor],
  );

  const playMove = useCallback(
    (san: string, opts?: { premove?: boolean }): void => {
      // WHAT THIS MOVE DOES TO THE GAME, asked of the rules here because this is the only layer
      // that has them: the strip under the header and the conversation's menu draw from the pure
      // derivation, and without this a game won by mate stayed in both for ever.
      let ends: "mate" | "draw" | null = null;
      try {
        const probe = new Chess(replay.chess.fen());
        probe.move(san);
        if (probe.isCheckmate()) ends = "mate";
        else if (probe.isGameOver()) ends = "draw";
      } catch {
        /* The position moved under the reader; the publish below is refused by the derivation. */
      }
      publish({ kind: "move", san, premove: opts?.premove === true, ends });
    },
    [publish, replay.chess],
  );

  /** What a move from one square to another IS, asked of the rules. Answers the SAN, or null when
   *  the move is not legal — and names a promotion, which is the one move two squares cannot say
   *  on their own. */
  const resolve = useCallback(
    (rules: Chess, from: string, to: string, promote?: ChessPromotionPiece): Move | "promotion" | null => {
      let onto: Move[] = [];
      try {
        onto = rules.moves({ square: from as Square, verbose: true }).filter((m) => m.to === to);
      } catch {
        return null;
      }
      if (onto.length === 0) return null;
      if (onto.some((m) => m.promotion)) {
        if (!promote) return "promotion";
        return onto.find((m) => m.promotion === promote) ?? null;
      }
      return onto[0] ?? null;
    },
    [],
  );

  /** Play — or QUEUE — a move between two squares. Both gestures end here, so neither can do
   *  what the other would refuse. */
  const attempt = useCallback(
    (from: string, to: string): boolean => {
      if (ourMove) {
        const move = resolve(chess, from, to);
        if (!move) return false;
        if (move === "promotion") {
          setPromotion({ from, to, color: ourColor as ChessColor });
          return true;
        }
        playMove(move.san);
        return true;
      }
      if (premoveChess && controller) {
        const move = resolve(premoveChess, from, to);
        if (!move) return false;
        if (move === "promotion") {
          // A premoved promotion asks now and keeps the answer: asking the moment it fires would
          // be a dialog appearing while the reader is looking somewhere else.
          setPromotion({ from, to, color: ourColor as ChessColor });
          return true;
        }
        controller.setChessPremove(args.conversationId, game.id, { from, to });
        playChessSound("premove", args.sounds && soundsEnabled);
        return true;
      }
      return false;
    },
    [
      args.conversationId,
      args.sounds,
      chess,
      controller,
      game.id,
      ourColor,
      ourMove,
      premoveChess,
      playMove,
      resolve,
      soundsEnabled,
    ],
  );

  const press = useCallback(
    (square: string): void => {
      // A press while the reader is reviewing an older position brings the board back to the live
      // one and plays nothing. Doing nothing at all was the other option and it is worse: a board
      // that swallows a press says nothing about why, and the reader presses again.
      if (!atLive) {
        setViewing(null);
        setSelected(null);
        return;
      }
      if (!asking) return;
      if (selected === square) {
        setSelected(null);
        return;
      }
      if (selected && attempt(selected, square)) {
        setSelected(null);
        return;
      }
      // Selecting one's own piece, and nothing else: a press on an empty square with nothing
      // selected means nothing — and it takes a queued premove back, which is what a click on
      // the board means once one is set.
      const piece = asking.get(square as Square);
      const mine = piece && piece.color === ourColor;
      if (!mine && premove && controller) controller.setChessPremove(args.conversationId, game.id, null);
      setSelected(mine ? square : null);
    },
    [args.conversationId, asking, atLive, attempt, controller, game.id, ourColor, premove, selected],
  );

  const drop = useCallback(
    (from: string, to: string): boolean => {
      setSelected(null);
      return attempt(from, to);
    },
    [attempt],
  );

  const rightClick = useCallback((): void => {
    // A right press is how a premove and a selection are taken back — the gesture every board
    // uses for it, and the reason the arrows are drawn with a right DRAG rather than a click.
    setSelected(null);
    if (premove && controller) controller.setChessPremove(args.conversationId, game.id, null);
  }, [args.conversationId, controller, game.id, premove]);

  const promote = useCallback(
    (piece: ChessPromotionPiece): void => {
      const target = promotion;
      setPromotion(null);
      if (!target) return;
      if (ourMove) {
        const move = resolve(chess, target.from, target.to, piece);
        if (move && move !== "promotion") playMove(move.san);
        return;
      }
      if (premoveChess && controller) {
        controller.setChessPremove(args.conversationId, game.id, {
          from: target.from,
          to: target.to,
          promotion: piece,
        });
        playChessSound("premove", args.sounds && soundsEnabled);
      }
    },
    [
      args.conversationId,
      args.sounds,
      chess,
      controller,
      game.id,
      ourMove,
      premoveChess,
      playMove,
      promotion,
      resolve,
      soundsEnabled,
    ],
  );

  // ---- the premove FIRES ------------------------------------------------------------
  //
  // The moment the opponent's move lands and it is our turn again, the queued move is played —
  // for a tenth of a second, whatever the wall clock says. It is checked against the position
  // that really arrived: a premove that is not legal there is dropped rather than posted, because
  // a premove is a guess about a position nobody had yet.
  const firing = useRef(false);
  useEffect(() => {
    if (!ourMove || !premove || !controller || firing.current) return;
    const [from, to] = premove;
    const queued = storedPremove?.promotion;
    const move = resolve(chess, from, to, queued);
    controller.setChessPremove(args.conversationId, game.id, null);
    if (!move || move === "promotion") return;
    firing.current = true;
    playMove(move.san, { premove: true });
    // One frame is enough: the publish sets the pending move, which takes `ourMove` false.
    window.setTimeout(() => {
      firing.current = false;
    }, 0);
  }, [
    args.conversationId,
    chess,
    controller,
    game.id,
    ourMove,
    playMove,
    premove,
    resolve,
    storedPremove?.promotion,
  ]);

  // ---- the sounds -------------------------------------------------------------------
  //
  // They follow the POSITION rather than the press, so a move that arrives from the other machine
  // sounds exactly like one played here — which is what a reader who is looking at their chat
  // rather than at the board needs.
  const heard = useRef<{ game: string; plies: number } | null>(null);
  const enabled = args.sounds && soundsEnabled;
  useEffect(() => {
    const last = heard.current;
    heard.current = { game: game.id, plies };
    if (!last || last.game !== game.id) return;
    if (plies <= last.plies) return;
    if (!enabled) return;
    const index = plies - 1;
    playChessSound(
      chessSoundFor({
        flags: replay.flags[index],
        check: replay.checks[index] === true,
      }),
    );
  }, [enabled, game.id, plies, replay.checks, replay.flags]);

  // A game STARTING is worth one sound of its own: it is the moment the reader's own clock begins
  // and, for whoever was challenged, the moment a board they were offered becomes a game.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!game.opponent) return;
    if (started.current === game.id) return;
    const first = started.current === null;
    started.current = game.id;
    // Not on the first pass over a game that was already under way: a reload is not a start.
    if (first && plies > 0) return;
    if (enabled && plies === 0) playChessSound("start");
  }, [enabled, game.id, game.opponent, plies]);

  const result = useMemo<ChessResult>(
    () => resultFor(game, replay.chess),
    [game, replay.chess],
  );

  const ended = useRef<string | null>(null);
  useEffect(() => {
    if (!result) return;
    if (ended.current === game.id) return;
    const first = ended.current === null;
    ended.current = game.id;
    // A game that was already over when this board mounted did not just end.
    if (first && !heard.current) return;
    if (enabled) playChessSound(chessOutcomeSound(result));
  }, [enabled, game.id, result]);

  // ---- walking back through the game ------------------------------------------------

  const goTo = useCallback(
    (ply: number): void => {
      setSelected(null);
      setPromotion(null);
      setViewing(ply >= plies ? null : Math.max(0, ply));
    },
    [plies],
  );

  const step = useCallback(
    (delta: number): void => {
      goTo(viewPly + delta);
    },
    [goTo, viewPly],
  );

  // A move arriving while the reader is reviewing an older position LEAVES them there — they are
  // reading, and yanking the board out from under them is what a review must not do. The one
  // exception is their own turn ARRIVING: their clock is running, so the board comes back to the
  // live position rather than costing them the game while they read.
  //
  // It is the TRANSITION and never the state, which is a bug this held for one draft: with
  // `atLive === false` in the condition, pressing Back on one's own turn made the condition
  // become true, and the effect took the reader straight back to the live position — so the game
  // could not be walked through at all on the one turn a player most wants to.
  const ourTurnNow = !settled && chessTurnIsOurs(game) && !!controller;
  const wasOurTurn = useRef(ourTurnNow);
  useEffect(() => {
    if (ourTurnNow && !wasOurTurn.current) setViewing(null);
    wasOurTurn.current = ourTurnNow;
  }, [ourTurnNow]);

  // Once the thread really holds our move, the pending one is forgotten and the board is drawing
  // the history rather than a guess.
  useEffect(() => {
    controller?.settleChessMove(args.conversationId, game.id, args.game.moves.length);
  }, [args.conversationId, args.game.moves.length, controller, game.id]);

  // ---- THE ENGINE ------------------------------------------------------------------
  //
  // A game against Stockfish is one ledger the READER's machine writes both sides of (see
  // lib/chess-wire.ts), so the engine's move is published from here — by the board that is mounted,
  // which is the only surface that can hold a Worker. Three things follow and each is deliberate:
  //
  //   - the worker is started by the first ASK, so a conversation full of finished engine games
  //     costs nothing until a board really needs a move;
  //   - the engine moves while the reader is AT the board. A game left with the engine to move waits
  //     — which is honest, and it is why an engine's clock is never drained by the wall (see
  //     `engineSide` in lib/chess-clock.ts);
  //   - a ply is asked for ONCE. The effect re-runs on every frame of a clock, so the ply it last
  //     asked about is remembered rather than guessed at.
  const engineOn = !!game.engine && !settled && atLive && !!controller && !!engineState.present;
  const engine = useChessEngine({ workerPath: engineState.worker_path, enabled: engineOn });
  // THE SEARCH IS IN FLIGHT ACROSS RENDERS, so nothing this effect uses may be a dependency that a
  // render replaces. `engine` is a fresh object every render (its own `thinking` flips the moment a
  // search starts) and `publish` follows the game — so with either in the array the effect was torn
  // down and re-run a frame after it asked, and its cleanup CANCELLED the very search it had just
  // started: the engine answered into a discarded promise and the board waited for ever. They are
  // read through refs instead, and what really re-runs this is the POSITION.
  const askRef = useRef(engine.ask);
  askRef.current = engine.ask;
  const publishRef = useRef(publish);
  publishRef.current = publish;
  /** The position the board is really at, as of the last run — what an answer is checked against. */
  const positionRef = useRef("");
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    const elo = game.engine?.elo;
    if (!engineOn || elo === undefined || !ourColor) return;
    // Only when it is the ENGINE's turn, and only at the live position with nothing of ours in
    // flight — the same three conditions a move of the reader's own needs.
    if (game.turn === ourColor || game.moves.length !== args.game.moves.length) return;
    const key = `${game.id}/${game.moves.length}`;
    positionRef.current = key;
    // A ply is asked for ONCE: this runs again whenever the clock or a frame re-renders the board.
    if (askedRef.current === key) return;
    askedRef.current = key;
    const fen = replay.chess.fen();
    void (async () => {
      const answer = await askRef.current({ fen, elo });
      // The game moved on while the engine thought — the reader walked back, or another frame
      // arrived — so the move is about a position that is no longer there.
      if (!answer || positionRef.current !== key) return;
      // The engine answers in UCI; the SAN — and whether the move ends the game — is asked of the
      // rules here, exactly as it is for a move the reader plays.
      try {
        const probe = new Chess(fen);
        const made = probe.move({
          from: answer.move.from,
          to: answer.move.to,
          ...(answer.move.promotion ? { promotion: answer.move.promotion } : {}),
        });
        let ends: "mate" | "draw" | null = null;
        if (probe.isCheckmate()) ends = "mate";
        else if (probe.isGameOver()) ends = "draw";
        publishRef.current({
          kind: "move",
          san: made.san,
          ends,
          // What the SEARCH cost, which is what its clock is charged.
          engine: { spentMs: answer.spentMs },
        });
      } catch {
        // A move the rules refuse in the position the board is really at. Nothing is posted — a
        // ledger with an illegal ply in it is a game neither machine can replay — and it is not
        // asked again either: the same position would earn the same answer, so the board is left
        // saying it is the engine's turn rather than looping on a move that cannot be played.
      }
    })();
    // The position and whose turn it is are what re-run this; `askRef` and `publishRef` are why
    // nothing else may.
  }, [
    args.game.moves.length,
    engineOn,
    game.engine?.elo,
    game.id,
    game.moves.length,
    game.turn,
    ourColor,
    replay.chess,
  ]);

  const flagClaimable =
    !settled && clock.flagged && game.opponent && ourColor && clock.flagged !== ourColor
      ? clock.flagged
      : null;

  const moves = useMemo(
    () =>
      game.moves.map((san, index) => ({
        ply: index + 1,
        san,
        clockMs: game.moveClocks[index] ?? null,
      })),
    [game.moveClocks, game.moves],
  );

  return {
    game,
    fen: replay.positions[viewPly] ?? replay.chess.fen(),
    orientation: ourColor ?? "w",
    lastMove: viewPly > 0 ? (replay.moved[viewPly - 1] ?? null) : null,
    check,
    selected,
    targets,
    premove,
    promotion,
    ourMove,
    brokeAt: replay.brokeAt,
    viewPly,
    atLive,
    plies,
    clock,
    flagClaimable,
    result,
    status: chessStatus({ game, chess: replay.chess, brokeAt: replay.brokeAt, ourMove, clock }),
    moves,
    press,
    drop,
    rightClick,
    promote,
    cancelPromotion: () => setPromotion(null),
    goTo,
    step,
    act: publish,
    canAct: !settled && !!ourColor && !!game.opponent && !!controller,
    // The engine's own failure is the board's to say, and it stands beside a refused publish rather
    // than replacing it: one is "your move did not go out", the other is "your opponent cannot
    // move", and a reader needs to know which.
    error: error ?? engine.error,
    engine: game.engine,
    engineThinking: engine.thinking,
  };
}

/** How the game ended, from the reader's own side. Null while it is still going, and null for a
 *  spectator — a game the reader is not in is not one they won. */
function resultFor(game: ChessGame, chess: Chess): ChessResult {
  const ours = game.ourColor;
  if (!ours) return null;
  const outcome = game.outcome;
  if (outcome.kind === "resigned") return outcome.by === ours ? "lose" : "win";
  if (outcome.kind === "timeout") return outcome.loser === ours ? "lose" : "win";
  if (outcome.kind === "drawAgreed") return "draw";
  if (outcome.kind === "declined") return null;
  if (chess.isCheckmate()) return chess.turn() === ours ? "lose" : "win";
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDraw()) return "draw";
  return null;
}

/**
 * What the reader needs to know, in one line.
 *
 * The MESSAGE-decided outcomes come first: a resignation, an agreed draw and a claimed flag are
 * facts about the thread rather than about the position, and asking the rules about a game
 * somebody resigned would answer "your move".
 */
export function chessStatus(args: {
  game: ChessGame;
  chess: Chess;
  brokeAt: number | null;
  ourMove: boolean;
  clock: ChessClockReading;
}): string {
  const { game, chess, brokeAt, ourMove } = args;
  if (brokeAt !== null) {
    return `This game cannot be replayed — move ${brokeAt} is not legal in the position before it.`;
  }
  if (game.outcome.kind === "resigned") {
    const who = chessPlayerOf(game, game.outcome.by);
    return who?.isSelf ? "You resigned." : `${who?.name ?? "They"} resigned.`;
  }
  if (game.outcome.kind === "timeout") {
    const who = chessPlayerOf(game, game.outcome.loser);
    return who?.isSelf ? "You ran out of time." : `${who?.name ?? "They"} ran out of time.`;
  }
  if (game.outcome.kind === "drawAgreed") return "Draw agreed.";
  if (game.outcome.kind === "declined") {
    return game.outcome.withdrawn
      ? `${game.challenger.isSelf ? "You" : game.challenger.name} withdrew the challenge.`
      : "Challenge declined.";
  }
  if (chess.isCheckmate()) {
    const loser = chessPlayerOf(game, chess.turn());
    return loser?.isSelf ? "Checkmate — you lost." : `Checkmate — ${loser?.name ?? "they"} lost.`;
  }
  if (chess.isStalemate()) return "Stalemate — a draw.";
  if (chess.isInsufficientMaterial()) return "A draw: neither side can mate.";
  if (chess.isDraw()) return "A draw.";
  // A challenge waiting for an answer reads from OPPOSITE sides, and one sentence for both was
  // the bug: the challenged player was told somebody else was being waited on.
  if (!game.opponent) {
    if (game.challenger.isSelf) return "Waiting for somebody to accept.";
    return `${game.challenger.name} challenged you to a game — you would play ${
      game.challengerColor === "w" ? "black" : "white"
    }.`;
  }
  // A clock that has run out is the sharpest thing this line can say, and it says WHOSE — the
  // claim is the reader's own press, so the sentence has to tell them there is one to make.
  if (args.clock.flagged) {
    const who = chessPlayerOf(game, args.clock.flagged);
    // A MACHINE CLAIMS NOTHING, so the sentence must not promise that one will. Against the computer
    // the reader is the only author, so their own flag is theirs to settle: they play on with a
    // clock at zero, or they resign. Saying "they can claim the win" would leave them waiting for a
    // press nobody is ever going to make.
    if (game.engine) {
      return who?.isSelf
        ? "Your clock ran out. The computer will not claim it — play on, or resign."
        : `${who?.name ?? "The computer"} ran out of time.`;
    }
    return who?.isSelf
      ? "Your clock has run out — they can claim the win."
      : `${who?.name ?? "They"} ran out of time — claim the win.`;
  }
  if (ourMove) return chess.inCheck() ? "Your move — you are in check." : "Your move.";
  const them = chessPlayerOf(game, chess.turn());
  return `Waiting for ${them?.isSelf ? "you" : (them?.name ?? "them")}.`;
}

/** The reader's own sound preference, for a surface that has no board of its own. */
export function useChessSoundsEnabled(): boolean {
  return useAppState((s) => s.soundsEnabled);
}
