import { describe, expect, it } from "vitest";
import {
  chessChallengeLabel,
  chessGameRowLabel,
  chessMenuState,
  conversationHoldsChess,
} from "./chess-menu";
import type { ChessGame } from "./chess-thread";
import type { Conversation } from "./protocol";

function game(over: Partial<ChessGame> = {}): ChessGame {
  return {
    id: "aaa111",
    challengeMessageId: "m1",
    challengeSeq: 1,
    challenger: { mri: "8:orgid:me", name: "Clement", isSelf: true },
    challengerColor: "w",
    opponent: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
    moves: [],
    moveClocks: [],
    time: null,
    startedAt: null,
    actedAt: { w: null, b: null },
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
    ledgers: { w: null, b: null },
    endedByRules: null,
    absorbed: ["m1"],
    refusedPlies: [],
    ...over,
  };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "19:c@thread.v2",
    name: "Ada Lovelace",
    last_message_time: 0,
    kind: "one_on_one",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
    ...over,
  };
}

describe("chessMenuState", () => {
  it("holds no game when none is in flight, and the menu then only challenges", () => {
    expect(chessMenuState([])).toEqual({ games: [], wantsUs: false });
    // A game somebody resigned is not in flight.
    expect(chessMenuState([game({ outcome: { kind: "resigned", by: "b" } })]).games).toEqual([]);
    expect(chessMenuState([game({ outcome: { kind: "drawAgreed" } })]).games).toEqual([]);
    expect(chessMenuState([game({ outcome: { kind: "timeout", loser: "w" } })]).games).toEqual([]);
  });

  it("names the live game, and says when it is the reader's move", () => {
    expect(chessMenuState([game()]).games[0]).toMatchObject({ ourTurn: true, wantsUs: true });
    expect(chessMenuState([game({ turn: "b" })]).games[0]).toMatchObject({
      ourTurn: false,
      wantsUs: false,
    });
  });

  it("HOLDS SEVERAL GAMES AT ONCE, the one that wants the reader first", () => {
    // The rule this replaced was "one game in flight per conversation". A group chat holds a game
    // per pair of people, and two colleagues may want a second board while the first is going.
    const theirs = game({ id: "aaa111", turn: "b", challengeSeq: 1 });
    const ours = game({ id: "bbb222", turn: "w", challengeSeq: 2 });
    const state = chessMenuState([theirs, ours]);
    expect(state.games.map((entry) => entry.game.id)).toEqual(["bbb222", "aaa111"]);
    // The dot on the closed trigger is drawn from ANY of them wanting something.
    expect(state.wantsUs).toBe(true);
  });

  it("is never the reader's turn in a game they are only watching", () => {
    const watched = game({
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
    });
    expect(chessMenuState([watched]).games[0]).toMatchObject({
      ourTurn: false,
      awaitingUs: false,
      wantsUs: false,
    });
  });

  it("says a CHALLENGE is waiting for the reader, which is not their move", () => {
    const challenged = game({
      opponent: null,
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
    });
    expect(chessMenuState([challenged]).games[0]).toMatchObject({
      ourTurn: false,
      awaitingUs: true,
      // One dot for one question: the game wants something from the reader either way.
      wantsUs: true,
    });
  });

  it("wants nothing from the reader while THEY are the one being waited on", () => {
    expect(chessMenuState([game({ opponent: null })]).games[0]).toMatchObject({
      awaitingUs: false,
      wantsUs: false,
    });
  });
});

describe("chessGameRowLabel", () => {
  it("says what each live game is waiting for, and whom it is against", () => {
    const [ours] = chessMenuState([game()]).games;
    expect(ours && chessGameRowLabel(ours)).toBe("Your move — Ada");
    const [theirs] = chessMenuState([game({ turn: "b" })]).games;
    expect(theirs && chessGameRowLabel(theirs)).toBe("Ada's move");
    const [challenged] = chessMenuState([
      game({
        opponent: null,
        ourColor: null,
        challenger: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
      }),
    ]).games;
    expect(challenged && chessGameRowLabel(challenged)).toBe("Ada challenged you");
    const [waiting] = chessMenuState([game({ opponent: null })]).games;
    expect(waiting && chessGameRowLabel(waiting)).toBe("Waiting for somebody to accept");
  });
});

describe("chessChallengeLabel", () => {
  it("names the person in a 1:1", () => {
    expect(chessChallengeLabel("Ada Lovelace", false)).toBe("Challenge Ada Lovelace");
  });

  it("says the challenge is OPEN in a group, which the user cannot know otherwise", () => {
    expect(chessChallengeLabel("Design crew", true)).toBe(
      "Challenge Design crew — first to accept plays",
    );
  });
});

describe("conversationHoldsChess", () => {
  it("holds a game in a 1:1 and in a group chat", () => {
    expect(conversationHoldsChess(conversation())).toBe(true);
    expect(conversationHoldsChess(conversation({ kind: "group" }))).toBe(true);
    // A thread the backend synced an id for and nothing else is multi-party too.
    expect(conversationHoldsChess(conversation({ kind: "unknown" }))).toBe(true);
  });

  it("holds none in Notes, where there is nobody to play", () => {
    expect(conversationHoldsChess(conversation({ kind: "notes", id: "48:notes" }))).toBe(false);
  });

  it("holds none for a conversation this app does not have", () => {
    expect(conversationHoldsChess(undefined)).toBe(false);
  });
});
