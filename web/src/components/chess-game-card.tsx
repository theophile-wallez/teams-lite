/**
 * One game of chess, drawn as a row in the history where it was started.
 *
 * This is the LAZY chunk and the only place `chess.js` is imported: the move list the thread
 * states is replayed into a position here, and what is legal is ASKED of the rules rather than
 * worked out. The pure half — which games exist, who plays, whose turn it is — is
 * `lib/chess-thread.ts` and carries no dependency, which is what keeps a rules engine off the
 * path of every chat (the rule `@pierre/diffs` holds for the diff renderer).
 *
 * Four things this card owes the reader:
 *   - the board is oriented from THEIR side, and a spectator sees white at the bottom;
 *   - a move goes out on their press and is TAKEN BACK if the send fails, with the sentence
 *     here — the composer's rule, because a move that did not leave is otherwise invisible;
 *   - a move list the rules cannot replay is SAID, never drawn as a board that silently
 *     disagrees with the other player's;
 *   - a resignation and an agreed draw are facts about the THREAD, so they are stated before
 *     the position is consulted at all.
 */

import { Chess, type Move, type Square } from "chess.js";
import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import {
  chessAwaitsOurAnswer,
  chessAwaitsTheirAnswer,
  chessGameIsSettled,
  chessPlayerOf,
  chessTurnIsOurs,
  type ChessGame,
  type ChessPlayer,
} from "~/lib/chess-thread";
import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { ChessBoard } from "./chess-board";
import { useOptionalAppState, useOptionalController } from "./controller-context";

/** What the rules say about the move list the thread holds. */
type Replay = {
  chess: Chess;
  /** The ply the replay stopped at, when a move was not legal there. */
  brokeAt: number | null;
  lastMove: [string, string] | null;
};

function replay(moves: string[]): Replay {
  const chess = new Chess();
  let lastMove: [string, string] | null = null;
  for (let i = 0; i < moves.length; i += 1) {
    try {
      const made = chess.move(moves[i] as string);
      lastMove = [made.from, made.to];
    } catch {
      return { chess, brokeAt: i + 1, lastMove };
    }
  }
  return { chess, brokeAt: null, lastMove };
}

export default function ChessGameCard(props: {
  game: ChessGame;
  conversationId: string;
  className?: string;
}) {
  // The optional hooks are the seam `RichContent` already uses: this card renders in a
  // virtualized history and is server-rendered by its own tests, so it must draw a board with
  // no provider around it — read-only, which is exactly what a board with no controller is.
  const controller = useOptionalController();
  const chessError = useOptionalAppState((s) => s.chessError, null);
  const pending = useOptionalAppState((s) => s.chessPending, null);
  const [selected, setSelected] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [armedResign, setArmedResign] = useState(false);
  // A position change is animated by the renderer; a reader who asked for no motion gets none.
  const reduceMotion = useReducedMotion();

  const game = props.game;

  // A move this page has sent and not yet seen come back is drawn as if it had landed: a board
  // that waits for a round trip before the piece moves feels broken.
  const moves = useMemo(() => {
    if (
      pending &&
      pending.conversation === props.conversationId &&
      pending.game === game.id &&
      pending.ply === game.moves.length + 1
    ) {
      return [...game.moves, pending.san];
    }
    return game.moves;
  }, [game.id, game.moves, pending, props.conversationId]);

  // Once the thread really holds the move, the pending one is forgotten and the board is
  // drawing the history rather than a guess.
  useEffect(() => {
    controller?.settleChessMove(props.conversationId, game.id, game.moves.length);
  }, [controller, game.id, game.moves.length, props.conversationId]);

  const { chess, brokeAt, lastMove } = useMemo(() => replay(moves), [moves]);
  const orientation: ChessColor = game.ourColor ?? "w";
  const settled = chessGameIsSettled(game) || chess.isGameOver() || brokeAt !== null;
  // Ours to move only while nothing of ours is already in flight: a second press before the
  // first move's message comes back would claim a ply the thread has not reached.
  const ourMove =
    !settled && chessTurnIsOurs(game) && moves.length === game.moves.length && !!controller;

  /** Every legal move out of the selected square. */
  const fromSelected: Move[] = useMemo(() => {
    if (!ourMove || !selected) return [];
    return chess.moves({ square: selected as Square, verbose: true });
  }, [chess, ourMove, selected]);

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

  /** Play from one square to another, asking the rules what that move IS. Both gestures end
   *  here — the tap-tap a phone uses and a piece dropped by the pointer — so neither can play
   *  a move the other would refuse. Answers whether the move was legal. */
  function play(from: string, to: string): boolean {
    const onto = chess.moves({ square: from as Square, verbose: true }).filter((m) => m.to === to);
    if (onto.length === 0) return false;
    // A promotion is the one move two squares cannot say on their own.
    if (onto.some((m) => m.promotion)) setPromotion({ from, to });
    else void send(onto[0]?.san ?? "");
    return true;
  }

  function press(square: string): void {
    if (!ourMove) return;
    if (selected === square) {
      setSelected(null);
      return;
    }
    if (selected && play(selected, square)) {
      setSelected(null);
      return;
    }
    // Selecting one's own piece, and nothing else: a press on an empty square with nothing
    // selected means nothing.
    const piece = chess.get(square as Square);
    setSelected(piece && piece.color === game.ourColor ? square : null);
  }

  function drop(from: string, to: string): boolean {
    if (!ourMove) return false;
    setSelected(null);
    return play(from, to);
  }

  async function send(san: string): Promise<void> {
    if (!san || !controller) return;
    await controller.sendChessMessage(props.conversationId, {
      game: game.id,
      body: { kind: "move", ply: game.moves.length + 1, san },
    });
  }

  async function promote(piece: "q" | "r" | "b" | "n"): Promise<void> {
    if (!promotion) return;
    // The SAN is asked of the rules rather than spelled here: a promotion's own notation
    // carries the capture, the file and the check, and writing it by hand is a second parser.
    const probe = replay(game.moves).chess;
    const target = promotion;
    setPromotion(null);
    try {
      const made = probe.move({ from: target.from, to: target.to, promotion: piece });
      await send(made.san);
    } catch {
      /* The position moved under the reader; the board will redraw from the thread. */
    }
  }

  const canAct = !settled && !!game.ourColor && !!game.opponent && !!controller;
  // A challenge waiting for an answer, and WHOSE answer it is. These two are the whole of the
  // challenged player's experience: without them their side of a fresh challenge is a board with
  // nothing to press, which is what the mock's own auto-accept hid.
  const awaitingUs = !!controller && chessAwaitsOurAnswer(game);
  const awaitingThem = !!controller && chessAwaitsTheirAnswer(game);

  /** Answer a challenge, or take one back. */
  function answer(body: { kind: "join" } | { kind: "decline" } | { kind: "resign" }): void {
    void controller?.sendChessMessage(props.conversationId, { game: game.id, body });
  }

  return (
    <article
      data-testid="chess-game"
      data-chess-game={game.id}
      className={cn(
        "mx-auto w-full max-w-80 rounded-xl border border-border-subtle bg-panel p-3",
        props.className,
      )}
    >
      <ChessSide game={game} color={orientation === "w" ? "b" : "w"} />
      <ChessBoard
        id={`chess-${game.id}`}
        fen={chess.fen()}
        orientation={orientation}
        playable={ourMove ? game.ourColor : null}
        selected={selected}
        targets={targets}
        lastMove={lastMove}
        check={check}
        animate={!reduceMotion}
        {...(ourMove ? { onSquare: press, onDrop: drop } : {})}
      />
      <ChessSide game={game} color={orientation} />

      <p data-testid="chess-status" className="mt-1 text-xs text-text-dim">
        {statusOf(game, chess, brokeAt, ourMove)}
      </p>

      {moves.length > 0 && (
        <p
          data-testid="chess-moves"
          // One scrollable line of pairs, UNDER the board: this card sits in a chat column
          // that is a phone's width at its narrowest, and a second column beside the board
          // would take the board down to nothing.
          className="mt-1 overflow-x-auto whitespace-nowrap text-[11px] text-text-faint"
        >
          {scoreSheet(moves)}
        </p>
      )}

      {chessError && (
        <p data-testid="chess-error" className="mt-1 text-[11px] text-destructive">
          {chessError}
        </p>
      )}

      {promotion && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-text-dim">Promote to</span>
          {(["q", "r", "b", "n"] as const).map((piece) => (
            <button
              key={piece}
              type="button"
              data-testid={`chess-promote-${piece}`}
              onClick={() => void promote(piece)}
              className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground"
            >
              {PROMOTION_LABEL[piece]}
            </button>
          ))}
        </div>
      )}

      {/* Somebody challenged the reader. This is the one state where the card asks for an answer
          rather than a move, so it says WHO asked and offers both answers — a challenge nobody
          can decline would sit in the conversation for ever, and one game is in flight at a
          time, so it would block the next one too. */}
      {awaitingUs && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="chess-accept"
            onClick={() => answer({ kind: "join" })}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
          >
            Accept — play {game.challengerColor === "w" ? "black" : "white"}
          </button>
          <button
            type="button"
            data-testid="chess-decline"
            onClick={() => answer({ kind: "decline" })}
            className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            Not now
          </button>
        </div>
      )}

      {/* The challenger's own side of that wait: they can take the offer back, which is what
          frees the conversation for another game. */}
      {awaitingThem && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="chess-withdraw"
            onClick={() => answer({ kind: "resign" })}
            className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            Withdraw the challenge
          </button>
        </div>
      )}

      {canAct && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="chess-resign"
            // The user asks twice: a resignation ends the game and no later message takes it
            // back. Delete's own arming pattern.
            onClick={() => {
              if (!armedResign) {
                setArmedResign(true);
                return;
              }
              setArmedResign(false);
              void controller?.sendChessMessage(props.conversationId, {
                game: game.id,
                body: { kind: "resign" },
              });
            }}
            className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            {armedResign ? "Resign — nothing takes it back" : "Resign"}
          </button>
          {game.drawOfferedBy && game.drawOfferedBy !== game.ourColor ? (
            <button
              type="button"
              data-testid="chess-draw-accept"
              onClick={() =>
                void controller?.sendChessMessage(props.conversationId, {
                  game: game.id,
                  body: { kind: "drawAccepted" },
                })
              }
              className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground"
            >
              Accept the draw
            </button>
          ) : (
            <button
              type="button"
              data-testid="chess-draw"
              disabled={game.drawOfferedBy === game.ourColor}
              onClick={() =>
                void controller?.sendChessMessage(props.conversationId, {
                  game: game.id,
                  body: { kind: "draw" },
                })
              }
              className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              {game.drawOfferedBy === game.ourColor ? "Draw offered" : "Offer a draw"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

const PROMOTION_LABEL = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" } as const;

/**
 * One side of the board, named. Drawn above and below the board the way a board is read, and the
 * face and the name are the app's own — so a colleague the user renamed is named here exactly as
 * they are above their own bubbles.
 *
 * A seat NOBODY holds is drawn as an empty seat rather than as a person: no initials, because
 * tinted initials are how this app draws a colleague it has no photo for and "Nobody yet" reduced
 * to `NY` is ink that names nothing. And it says WHOSE it is from the reader's own position — the
 * seat opposite a challenger is the reader's to take, so telling them somebody else is being
 * waited for is the same mistake the status line made before it read from two sides.
 */
function ChessSide(props: { game: ChessGame; color: ChessColor }) {
  const player: ChessPlayer | null = chessPlayerOf(props.game, props.color);
  // Not the controller's question: whether a press would WORK is the card's, and whether the seat
  // is the reader's is a fact about the game. A settled challenge is nobody's to take.
  const oursToTake =
    !player && !props.game.challenger.isSelf && !chessGameIsSettled(props.game);
  return (
    <header className="flex items-center gap-2 py-1.5">
      {player ? (
        <Avatar
          seed={player.mri}
          label={player.name}
          photo={{ kind: "user", id: player.mri }}
          className="size-6"
        />
      ) : (
        <span
          aria-hidden
          className="size-6 shrink-0 rounded-full border border-dashed border-border-subtle"
        />
      )}
      <span
        className={cn(
          "truncate text-xs font-medium",
          player ? "text-foreground" : "text-text-dim",
        )}
      >
        {player
          ? player.isSelf
            ? "You"
            : player.name
          : oursToTake
            ? "You, if you accept"
            : "Waiting for somebody"}
      </span>
      <span className="ml-auto shrink-0 text-[11px] text-text-faint">
        {props.color === "w" ? "White" : "Black"}
      </span>
    </header>
  );
}

/**
 * What the reader needs to know, in one line.
 *
 * The MESSAGE-decided outcomes come first: a resignation and an agreed draw are facts about the
 * thread rather than about the position, and asking the rules about a game somebody resigned
 * would answer "your move".
 */
function statusOf(game: ChessGame, chess: Chess, brokeAt: number | null, ourMove: boolean): string {
  if (brokeAt !== null) {
    return `This game cannot be replayed — move ${brokeAt} is not legal in the position before it.`;
  }
  if (game.outcome.kind === "resigned") {
    const who = chessPlayerOf(game, game.outcome.by);
    return who?.isSelf ? "You resigned." : `${who?.name ?? "They"} resigned.`;
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
  if (ourMove) return chess.inCheck() ? "Your move — you are in check." : "Your move.";
  const them = chessPlayerOf(game, chess.turn());
  return `Waiting for ${them?.isSelf ? "you" : (them?.name ?? "them")}.`;
}

/** `1. e4 e5  2. Nf3` — the way a score sheet reads. */
function scoreSheet(moves: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const black = moves[i + 1];
    out.push(`${i / 2 + 1}. ${moves[i]}${black ? ` ${black}` : ""}`);
  }
  return out.join("  ");
}
