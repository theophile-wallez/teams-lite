import { describe, expect, it } from "vitest";
import { chessButtonState, chessChallengeLabel, conversationHoldsChess } from "./chess-button";
import type { ChessGame } from "~/lib/chess-thread";
import type { Conversation } from "~/lib/protocol";

function game(over: Partial<ChessGame> = {}): ChessGame {
  return {
    id: "aaa111",
    challengeMessageId: "m1",
    challengeSeq: 1,
    challenger: { mri: "8:orgid:me", name: "Clement", isSelf: true },
    challengerColor: "w",
    opponent: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
    moves: [],
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
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

describe("chessButtonState", () => {
  it("offers a challenge when no game is in flight", () => {
    expect(chessButtonState([])).toEqual({ kind: "challenge" });
    // A game somebody resigned is not in flight: the next challenge may go out.
    expect(chessButtonState([game({ outcome: { kind: "resigned", by: "b" } })])).toEqual({
      kind: "challenge",
    });
    expect(chessButtonState([game({ outcome: { kind: "drawAgreed" } })])).toEqual({
      kind: "challenge",
    });
  });

  it("points at the live game, and says when it is the reader's move", () => {
    expect(chessButtonState([game()])).toMatchObject({ kind: "open", ourTurn: true, wantsUs: true });
    expect(chessButtonState([game({ turn: "b" })])).toMatchObject({
      kind: "open",
      ourTurn: false,
      wantsUs: false,
    });
  });

  it("is never the reader's turn in a game they are only watching", () => {
    const watched = game({
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
    });
    expect(chessButtonState([watched])).toMatchObject({
      kind: "open",
      ourTurn: false,
      awaitingUs: false,
      wantsUs: false,
    });
  });

  it("says a CHALLENGE is waiting for the reader, which is not their move", () => {
    // Somebody else opened it and nobody has accepted: the reader owes an answer, not a move.
    const challenged = game({
      opponent: null,
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
    });
    expect(chessButtonState([challenged])).toMatchObject({
      kind: "open",
      ourTurn: false,
      awaitingUs: true,
      // One dot for one question: the game wants something from the reader either way.
      wantsUs: true,
    });
  });

  it("wants nothing from the reader while THEY are the one being waited on", () => {
    const ours = game({ opponent: null });
    expect(chessButtonState([ours])).toMatchObject({ awaitingUs: false, wantsUs: false });
  });

  it("points at the NEWEST live game when an older one is settled", () => {
    const settled = game({ id: "aaa111", outcome: { kind: "drawAgreed" } });
    const live = game({ id: "bbb222" });
    expect(chessButtonState([settled, live])).toMatchObject({ kind: "open", game: { id: "bbb222" } });
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
