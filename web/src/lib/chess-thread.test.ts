import { describe, expect, it } from "vitest";
import {
  activeChessGame,
  activeChessGames,
  chessClockStateOf,
  chessEndedByRules,
  chessGameById,
  chessGameIsOver,
  chessAwaitsOurAnswer,
  chessAwaitsTheirAnswer,
  chessGameIsSettled,
  chessGamesInThread,
  chessPlayerOf,
  chessTurnIsOurs,
  chessWantsUs,
} from "./chess-thread";
import {
  chessMessageHtml,
  newChessLedger,
  type ChessColor,
  type ChessLedger,
  type ChessWire,
} from "./chess-wire";
import type { ChatMessage } from "./protocol";

const ME = { mri: "8:orgid:me", name: "Clement" };
const ADA = { mri: "8:orgid:ada", name: "Ada Lovelace" };
const GRACE = { mri: "8:orgid:grace", name: "Grace Hopper" };

let seq = 0;

/** One chess message from somebody. `who === ME` is the reader's own. */
function chess(who: { mri: string; name: string }, wire: ChessWire): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation_id: "19:c@thread.v2",
    seq,
    compose_time: 1_700_000_000_000 + seq * 1000,
    sender: who.name,
    sender_mri: who.mri,
    content: chessMessageHtml(wire),
    ...(who === ME ? { is_self: true } : {}),
  };
}

/** An ordinary message, which a game must leave alone. */
function chat(who: { mri: string; name: string }, text: string): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation_id: "19:c@thread.v2",
    seq,
    compose_time: 1_700_000_000_000 + seq * 1000,
    sender: who.name,
    sender_mri: who.mri,
    content: `<p>${text}</p>`,
    ...(who === ME ? { is_self: true } : {}),
  };
}

describe("chessGamesInThread", () => {
  it("finds a game from its challenge alone, with nobody opposite yet", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
    ]);
    expect(game?.id).toBe("aaa111");
    expect(game?.challenger).toEqual({ mri: ME.mri, name: ME.name, isSelf: true });
    expect(game?.challengerColor).toBe("w");
    expect(game?.opponent).toBeNull();
    expect(game?.ourColor).toBe("w");
    expect(game?.turn).toBe("w");
    expect(game?.moves).toEqual([]);
  });

  it("names the other player from the ACCEPT, and gives them the other colour", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "b" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game?.opponent).toEqual({ mri: ADA.mri, name: ADA.name, isSelf: false });
    expect(game && chessPlayerOf(game, "b")?.mri).toBe(ME.mri);
    expect(game && chessPlayerOf(game, "w")?.mri).toBe(ADA.mri);
    expect(game?.ourColor).toBe("b");
  });

  it("keeps the moves in ply order and follows the turn", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
      chat(ADA, "nice"),
      chess(ADA, { game: "aaa111", body: { kind: "move", ply: 2, san: "e5" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 3, san: "Nf3" } }),
    ]);
    expect(game?.moves).toEqual(["e4", "e5", "Nf3"]);
    expect(game?.turn).toBe("b");
    expect(game && chessTurnIsOurs(game)).toBe(false);
  });

  it("absorbs every message of the game and nothing else", () => {
    const messages = [
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chat(ADA, "your move"),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ];
    const [game] = chessGamesInThread(messages);
    expect(game?.absorbed).toEqual([messages[0]?.id, messages[1]?.id, messages[3]?.id]);
    expect(game?.challengeMessageId).toBe(messages[0]?.id);
  });

  it("REFUSES a move from the player whose turn it is not", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      // Ada is black and it is white's move.
      chess(ADA, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ]);
    expect(game?.moves).toEqual([]);
    expect(game?.refusedPlies).toEqual([1]);
  });

  it("REFUSES a move from somebody who is not in the game at all", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(GRACE, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ]);
    expect(game?.moves).toEqual([]);
  });

  it("REFUSES a move before the game was accepted", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ]);
    expect(game?.moves).toEqual([]);
  });

  it("keeps the FIRST of two messages claiming one ply, and refuses the later", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "d4" } }),
    ]);
    expect(game?.moves).toEqual(["e4"]);
    expect(game?.refusedPlies).toEqual([1]);
  });

  it("refuses a SECOND accept — the first colleague to answer is the opponent", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(GRACE, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game?.opponent?.mri).toBe(ADA.mri);
  });

  it("refuses an accept from the CHALLENGER: a game needs two people", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game?.opponent).toBeNull();
  });

  it("carries a draw offer, and settles the game when the OTHER player accepts it", () => {
    const offered = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ME, { game: "aaa111", body: { kind: "draw" } }),
    ])[0];
    expect(offered?.drawOfferedBy).toBe("w");
    expect(offered && chessGameIsSettled(offered)).toBe(false);

    const agreed = chessGamesInThread([
      chess(ME, { game: "bbb222", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "bbb222", body: { kind: "join" } }),
      chess(ME, { game: "bbb222", body: { kind: "draw" } }),
      chess(ADA, { game: "bbb222", body: { kind: "drawAccepted" } }),
    ])[0];
    expect(agreed?.outcome).toEqual({ kind: "drawAgreed" });
    expect(agreed && chessGameIsSettled(agreed)).toBe(true);

    // Accepting one's OWN offer settles nothing.
    const alone = chessGamesInThread([
      chess(ME, { game: "ccc333", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "ccc333", body: { kind: "join" } }),
      chess(ME, { game: "ccc333", body: { kind: "draw" } }),
      chess(ME, { game: "ccc333", body: { kind: "drawAccepted" } }),
    ])[0];
    expect(alone?.outcome).toEqual({ kind: "playing" });
  });

  it("lets a MOVE decline an open draw offer, which is what a move means", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "draw" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ]);
    expect(game?.drawOfferedBy).toBeNull();
    expect(game?.moves).toEqual(["e4"]);
  });

  it("settles the game on a resignation, naming who resigned", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
    ]);
    expect(game?.outcome).toEqual({ kind: "resigned", by: "b" });
    expect(game && chessGameIsSettled(game)).toBe(true);
  });

  it("ignores anything after the game is settled, but still absorbs it", () => {
    const messages = [
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ];
    const [game] = chessGamesInThread(messages);
    expect(game?.moves).toEqual([]);
    expect(game?.absorbed).toContain(messages[3]?.id);
  });

  it("holds several games apart, in the order they were opened", () => {
    const games = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
      chess(ADA, { game: "bbb222", body: { kind: "open", color: "w" } }),
    ]);
    expect(games.map((g) => g.id)).toEqual(["aaa111", "bbb222"]);
  });

  it("ignores a message for a game whose challenge it never saw", () => {
    // The history pages older, so the challenge may simply not be loaded yet. A board
    // built from the tail of a game would show a position that never happened.
    expect(
      chessGamesInThread([chess(ME, { game: "zzz999", body: { kind: "move", ply: 5, san: "e4" } })]),
    ).toEqual([]);
  });

  it("finds nothing in a thread of ordinary messages", () => {
    expect(chessGamesInThread([chat(ADA, "hello"), chat(ME, "hi")])).toEqual([]);
  });
});

describe("activeChessGame", () => {
  it("is the newest unfinished game, and null when every one is settled", () => {
    const settled = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
    ]);
    expect(activeChessGame(settled)).toBeNull();

    const live = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
      chess(ADA, { game: "bbb222", body: { kind: "open", color: "w" } }),
    ]);
    expect(activeChessGame(live)?.id).toBe("bbb222");
  });

  it("is null in a thread with no game at all", () => {
    expect(activeChessGame([])).toBeNull();
  });
});

describe("a challenge waiting for an answer", () => {
  it("awaits OUR answer when somebody else opened it and nobody accepted", () => {
    const [theirs] = chessGamesInThread([
      chess(ADA, { game: "aaa111", body: { kind: "open", color: "w" } }),
    ]);
    expect(theirs && chessAwaitsOurAnswer(theirs)).toBe(true);
    expect(theirs && chessAwaitsTheirAnswer(theirs)).toBe(false);
    // And the header asks one question: this game wants something from the reader.
    expect(theirs && chessWantsUs(theirs)).toBe(true);
  });

  it("awaits THEIR answer when the reader opened it", () => {
    const [ours] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
    ]);
    expect(ours && chessAwaitsTheirAnswer(ours)).toBe(true);
    expect(ours && chessAwaitsOurAnswer(ours)).toBe(false);
    // Nothing is wanted from the reader: they are the one being waited on.
    expect(ours && chessWantsUs(ours)).toBe(false);
  });

  it("awaits nobody once the game is accepted", () => {
    const [game] = chessGamesInThread([
      chess(ADA, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game?.ourColor).toBe("b");
    expect(game && chessAwaitsOurAnswer(game)).toBe(false);
    expect(game && chessAwaitsTheirAnswer(game)).toBe(false);
    // It is white's move and we are black, so nothing is wanted yet.
    expect(game && chessWantsUs(game)).toBe(false);
  });

  it("is DECLINED by anybody who is not the challenger, which frees the conversation", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "decline" } }),
    ]);
    expect(game?.outcome).toEqual({ kind: "declined", withdrawn: false });
    expect(game && chessGameIsSettled(game)).toBe(true);
    // Settled, so the next challenge may go out.
    expect(activeChessGame([game!])).toBeNull();
  });

  it("cannot be declined by the CHALLENGER, and never once somebody accepted", () => {
    const own = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "aaa111", body: { kind: "decline" } }),
    ])[0];
    expect(own?.outcome).toEqual({ kind: "playing" });

    const started = chessGamesInThread([
      chess(ME, { game: "bbb222", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "bbb222", body: { kind: "join" } }),
      chess(ADA, { game: "bbb222", body: { kind: "decline" } }),
    ])[0];
    expect(started?.outcome).toEqual({ kind: "playing" });
  });

  it("is WITHDRAWN when the challenger resigns a game nobody accepted — never a loss", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "aaa111", body: { kind: "resign" } }),
    ]);
    // A game that never started cannot be lost, so this is not `resigned`.
    expect(game?.outcome).toEqual({ kind: "declined", withdrawn: true });
    expect(activeChessGame([game!])).toBeNull();
  });

  it("still resigns normally once the game is under way", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ME, { game: "aaa111", body: { kind: "resign" } }),
    ]);
    expect(game?.outcome).toEqual({ kind: "resigned", by: "w" });
  });
});

describe("chessTurnIsOurs", () => {
  it("is false for a spectator and while the game waits for an opponent", () => {
    const [waiting] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
    ]);
    expect(waiting && chessTurnIsOurs(waiting)).toBe(false);

    const [theirs] = chessGamesInThread([
      chess(ADA, { game: "bbb222", body: { kind: "open", color: "w" } }),
      chess(GRACE, { game: "bbb222", body: { kind: "join" } }),
    ]);
    expect(theirs?.ourColor).toBeNull();
    expect(theirs && chessTurnIsOurs(theirs)).toBe(false);
  });

  it("is true when the game is accepted and it is the reader's move", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game && chessTurnIsOurs(game)).toBe(true);
  });
});

// ---- v2, the LEDGER ---------------------------------------------------------------
//
// One message per player, edited as they move, and the game is the MERGE of the two by ply. The
// tests below are about the three things that merge has to get right: a ply is attributed to
// whoever authored the message it came in, the order of play is read off the PLY rather than off
// message order, and the acts that end a game are anchored at the ply they happened at.
describe("a game kept as two LEDGERS", () => {
  const T0 = 1_800_000_000_000;

  /** One player's ledger, as the message that carries it. */
  function ledger(
    who: { mri: string; name: string },
    game: string,
    over: Partial<ChessLedger> & { color: ChessColor },
    /** When the MESSAGE was posted. It is what times the accept, so the tests state it. */
    composeTime = T0,
  ): ChatMessage {
    return {
      ...chess(who, {
        game,
        body: { kind: "ledger", ledger: { ...newChessLedger(over.color), ...over } },
      }),
      compose_time: composeTime,
    };
  }

  /** The commonest shape: white opened a ten-minute game, black accepted, three moves played. */
  function played(): ChatMessage[] {
    return [
      ledger(ME, "aaa111", {
        color: "w",
        opened: true,
        time: { base: 600, increment: 0 },
        at: T0 + 20_000,
        moves: [
          { ply: 1, san: "e4", clockMs: 595_000 },
          { ply: 3, san: "Nf3", clockMs: 590_000 },
        ],
      }),
      ledger(ADA, "aaa111", {
        color: "b",
        joined: true,
        at: T0 + 15_000,
        moves: [{ ply: 2, san: "e5", clockMs: 597_000 }],
      }),
    ];
  }

  it("merges the two records into ONE move list, in ply order", () => {
    const [game] = chessGamesInThread(played());
    expect(game?.moves).toEqual(["e4", "e5", "Nf3"]);
    // Three plies played, so it is black to move — read off the ply count and nothing else.
    expect(game?.turn).toBe("b");
    expect(game?.challengerColor).toBe("w");
    expect(game?.opponent?.mri).toBe(ADA.mri);
    expect(game?.ourColor).toBe("w");
  });

  it("is ONE row in the history: both messages are absorbed", () => {
    const messages = played();
    const [game] = chessGamesInThread(messages);
    expect(game?.absorbed).toEqual([messages[0]?.id, messages[1]?.id]);
    // A sixty-move game is these same two messages, which is the whole point of the ledger.
    expect(game?.absorbed).toHaveLength(2);
  });

  it("says WHICH message each player edits, so a move rewrites it rather than posting again", () => {
    const messages = played();
    const [game] = chessGamesInThread(messages);
    expect(game?.ledgers.w?.messageId).toBe(messages[0]?.id);
    expect(game?.ledgers.b?.messageId).toBe(messages[1]?.id);
    expect(game?.ledgers.w?.ledger.moves).toHaveLength(2);
  });

  it("carries the clock the OPENER set, and ignores an echo of it from the other side", () => {
    const [game] = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, time: { base: 600, increment: 0 } }),
      ledger(ADA, "aaa111", { color: "b", joined: true, time: { base: 60, increment: 0 } }),
    ]);
    // One clock per game, stated by whoever proposed it: two would leave the two boards
    // counting down at different speeds.
    expect(game?.time).toEqual({ base: 600, increment: 0 });
  });

  it("carries what each side had left, and hands the clocks their numbers", () => {
    const [game] = chessGamesInThread(played());
    expect(game?.moveClocks).toEqual([595_000, 597_000, 590_000]);
    const state = game && chessClockStateOf(game);
    // Each side's own newest statement, and the moment they last acted.
    expect(state?.stated).toEqual({ w: 590_000, b: 597_000 });
    expect(state?.actedAt).toEqual({ w: T0 + 20_000, b: T0 + 15_000 });
    // The clock starts at the ACCEPT, and the accept is timed by its own message rather than by
    // anything the ledger claims: an edit cannot move it.
    expect(state?.startedAt).toBe(T0);
    expect(state?.turn).toBe("b");
    expect(state?.live).toBe(true);
    expect(state?.settled).toBe(false);
  });

  it("stops at a GAP, because a board drawn past one is a position nobody played", () => {
    // White's ledger holds plies 1 and 3; black's move has not arrived (or its message is not
    // loaded). Ply 3 is real and unplayable, so the game is one move long.
    const [game] = chessGamesInThread([
      ledger(ME, "aaa111", {
        color: "w",
        opened: true,
        moves: [
          { ply: 1, san: "e4", clockMs: null },
          { ply: 3, san: "Nf3", clockMs: null },
        ],
      }),
      ledger(ADA, "aaa111", { color: "b", joined: true }),
    ]);
    expect(game?.moves).toEqual(["e4"]);
    expect(game?.turn).toBe("b");
  });

  it("REFUSES every move in a game nobody accepted", () => {
    const [game] = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, moves: [{ ply: 1, san: "e4", clockMs: null }] }),
    ]);
    expect(game?.moves).toEqual([]);
    expect(game?.refusedPlies).toEqual([1]);
  });

  it("ignores a SECOND ledger from the same player, which would double every move in it", () => {
    const first = played();
    const [game] = chessGamesInThread([
      ...first,
      ledger(ME, "aaa111", { color: "w", moves: [{ ply: 5, san: "Bb5", clockMs: null }] }),
    ]);
    expect(game?.moves).toEqual(["e4", "e5", "Nf3"]);
    expect(game?.ledgers.w?.messageId).toBe(first[0]?.id);
  });

  it("anchors a RESIGNATION at the ply it happened, and refuses the moves after it", () => {
    // White resigned when the game stood at one move. Black's ledger holds a second ply — they
    // moved before the resignation reached them — and it is absorbed and ignored.
    const [game] = chessGamesInThread([
      ledger(ME, "aaa111", {
        color: "w",
        opened: true,
        moves: [{ ply: 1, san: "e4", clockMs: null }],
        resigned: true,
      }),
      ledger(ADA, "aaa111", {
        color: "b",
        joined: true,
        moves: [{ ply: 2, san: "e5", clockMs: null }],
      }),
    ]);
    expect(game?.outcome).toEqual({ kind: "resigned", by: "w" });
    expect(game?.moves).toEqual(["e4"]);
  });

  it("is WITHDRAWN when the challenger resigns a ledger nobody accepted", () => {
    const [game] = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, resigned: true }),
    ]);
    expect(game?.outcome).toEqual({ kind: "declined", withdrawn: true });
  });

  it("stands a draw offer only at the ply it was made at", () => {
    const standing = chessGamesInThread([
      ledger(ME, "aaa111", {
        color: "w",
        opened: true,
        moves: [{ ply: 1, san: "e4", clockMs: null }],
        drawOfferedAt: 1,
      }),
      ledger(ADA, "aaa111", { color: "b", joined: true }),
    ]);
    expect(standing[0]?.drawOfferedBy).toBe("w");

    // Black answered with a move, which is what a move MEANS: the offer no longer stands, and
    // nothing had to clear it.
    const answered = chessGamesInThread([
      ledger(ME, "aaa111", {
        color: "w",
        opened: true,
        moves: [{ ply: 1, san: "e4", clockMs: null }],
        drawOfferedAt: 1,
      }),
      ledger(ADA, "aaa111", {
        color: "b",
        joined: true,
        moves: [{ ply: 2, san: "e5", clockMs: null }],
      }),
    ]);
    expect(answered[0]?.drawOfferedBy).toBeNull();
  });

  it("settles a draw only when the OTHER side accepts the offer that stood", () => {
    const agreed = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, drawOfferedAt: 0 }),
      ledger(ADA, "aaa111", { color: "b", joined: true, drawAcceptedAt: 0 }),
    ]);
    expect(agreed[0]?.outcome).toEqual({ kind: "drawAgreed" });

    // Accepting one's own offer settles nothing, and neither does accepting one at a ply the
    // offer did not stand at.
    const alone = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, drawOfferedAt: 0, drawAcceptedAt: 0 }),
      ledger(ADA, "aaa111", { color: "b", joined: true }),
    ]);
    expect(alone[0]?.outcome).toEqual({ kind: "playing" });

    const stale = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, drawOfferedAt: 0 }),
      ledger(ADA, "aaa111", { color: "b", joined: true, drawAcceptedAt: 4 }),
    ]);
    expect(stale[0]?.outcome).toEqual({ kind: "playing" });
  });

  it("believes a FLAG only when the arithmetic both machines hold agrees", () => {
    // A one-minute game: white accepted at T0, has not moved, and black claims the flag two
    // minutes later. Both machines can check that, so both reach the same answer.
    const fair = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, time: { base: 60, increment: 0 } }),
      ledger(ADA, "aaa111", {
        color: "b",
        joined: true,
        // A claim made one second in: white's minute has not run out, so nothing settles.
        flagged: { color: "w", at: T0 + 1_000 },
      }),
    ]);
    expect(fair[0]?.outcome).toEqual({ kind: "playing" });

    const claimed = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, time: { base: 60, increment: 0 } }),
      // The accept is what starts the clock, and the claim carries its OWN moment: 61 seconds
      // later, by which time white's minute is gone. The claim must not move the moment it is
      // checked against, which is why it is not `at:`.
      ledger(ADA, "aaa111", { color: "b", joined: true, flagged: { color: "w", at: T0 + 61_000 } }),
    ]);
    expect(claimed[0]?.outcome).toEqual({ kind: "timeout", loser: "w" });

    // A claim against the player who is NOT on the clock is refused outright.
    const wrong = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true, time: { base: 60, increment: 0 } }),
      ledger(ADA, "aaa111", { color: "b", joined: true, flagged: { color: "b", at: T0 + 61_000 } }),
    ]);
    expect(wrong[0]?.outcome).toEqual({ kind: "playing" });
  });

  it("never believes a flag in a game with NO clock", () => {
    const [game] = chessGamesInThread([
      ledger(ME, "aaa111", { color: "w", opened: true }),
      ledger(ADA, "aaa111", {
        color: "b",
        joined: true,
        flagged: { color: "w", at: T0 + 10_000_000 },
      }),
    ]);
    expect(game?.outcome).toEqual({ kind: "playing" });
  });
});

describe("several games at once", () => {
  it("holds every unfinished game, the one that WANTS the reader first", () => {
    const games = chessGamesInThread([
      // Ours to move: we opened as white and Ada accepted.
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      // Waiting for them: we opened as black, so white is theirs to play.
      chess(ME, { game: "bbb222", body: { kind: "open", color: "b" } }),
      chess(GRACE, { game: "bbb222", body: { kind: "join" } }),
      // Settled, so it is not in the list at all.
      chess(ADA, { game: "ccc333", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "ccc333", body: { kind: "join" } }),
      chess(ME, { game: "ccc333", body: { kind: "resign" } }),
    ]);
    expect(activeChessGames(games).map((g) => g.id)).toEqual(["aaa111", "bbb222"]);
    // And the one the header points at is the first of those.
    expect(activeChessGame(games)?.id).toBe("aaa111");
  });

  it("puts the NEWEST first when neither is waiting for the reader", () => {
    const games = chessGamesInThread([
      chess(ADA, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(GRACE, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "bbb222", body: { kind: "open", color: "w" } }),
      chess(GRACE, { game: "bbb222", body: { kind: "join" } }),
    ]);
    expect(activeChessGames(games).map((g) => g.id)).toEqual(["bbb222", "aaa111"]);
  });

  it("finds one by its id, which is how a page reads its own URL", () => {
    const games = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
    ]);
    expect(chessGameById(games, "aaa111")?.id).toBe("aaa111");
    expect(chessGameById(games, "nope00")).toBeNull();
    expect(chessGameById(games, null)).toBeNull();
  });
});

describe("a game the RULES ended", () => {
  it("leaves the live list, so a game somebody WON stops asking for a move", () => {
    // The pure layer holds no rules engine, on purpose — the strip under the header and the
    // conversation's menu draw from it. So a mating move says so twice over: SAN's own `#`, and
    // the `end.` token the mover writes.
    const mate = chessGamesInThread([
      chess(ME, {
        game: "aaa111",
        body: {
          kind: "ledger",
          ledger: {
            ...newChessLedger("w"),
            opened: true,
            moves: [
              { ply: 1, san: "e4", clockMs: null },
              { ply: 3, san: "Qh5", clockMs: null },
              { ply: 5, san: "Qxf7#", clockMs: null },
            ],
            ended: "mate",
          },
        },
      }),
      chess(ADA, {
        game: "aaa111",
        body: {
          kind: "ledger",
          ledger: {
            ...newChessLedger("b"),
            joined: true,
            moves: [
              { ply: 2, san: "e5", clockMs: null },
              { ply: 4, san: "Nc6", clockMs: null },
            ],
          },
        },
      }),
    ]);
    expect(mate[0]?.moves).toHaveLength(5);
    expect(mate[0] && chessEndedByRules(mate[0])).toBe("mate");
    expect(mate[0] && chessGameIsOver(mate[0])).toBe(true);
    // The OUTCOME is still "playing": no message ended it, and that distinction is what the
    // card's own sentence reads (it asks the rules).
    expect(mate[0]?.outcome).toEqual({ kind: "playing" });
    expect(activeChessGames(mate)).toEqual([]);
  });

  it("reads a mating SAN even from a build that wrote no token", () => {
    const mate = chessGamesInThread([
      chess(ME, { game: "bbb222", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "bbb222", body: { kind: "join" } }),
      chess(ME, { game: "bbb222", body: { kind: "move", ply: 1, san: "Qxf7#" } }),
    ]);
    expect(mate[0] && chessEndedByRules(mate[0])).toBe("mate");
  });
});
