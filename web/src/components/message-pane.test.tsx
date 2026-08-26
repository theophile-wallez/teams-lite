// Who a message's author IS, which is what decides whether the history draws two
// messages as one person talking twice — and, with that, whether the second one carries
// a sender name at all (a continuation never does).
//
// And what the history ABSORBS: which messages are machinery rather than something somebody said,
// and — for the one kind that draws no row of its own — where a deep link to it lands.
import { describe, it, expect } from "vitest";
import { sameAuthor, chatHistoryRows, petRowNeighbours, type HistoryRow } from "./message-pane";
import { petsInThread } from "~/lib/pet-thread";
import { newPetLedger, petMessageHtml, withPetAct, type PetLedger } from "~/lib/pet-wire";
import type { ChessGame } from "~/lib/chess-thread";
import type { CallRecording } from "~/lib/call-recording";
import type { ChatMessage } from "~/lib/protocol";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    conversation_id: "c1",
    seq: 1,
    compose_time: 1,
    sender: "Ada Lovelace",
    sender_mri: "8:orgid:ada",
    content: "<p>hi</p>",
    ...over,
  };
}

/** A message carrying somebody's pet record, exactly as `petPublish` writes one. */
function petMessage(over: Partial<ChatMessage> = {}, ledger: PetLedger = newPetLedger("7f3a1c", "cat")) {
  return message({ content: petMessageHtml(ledger, "Nori"), ...over });
}

describe("sameAuthor", () => {
  it("chains one person's own run and never two people's", () => {
    const first = message({ id: "m1" });
    expect(sameAuthor(first, message({ id: "m2" }))).toBe(true);
    expect(
      sameAuthor(first, message({ id: "m2", sender: "Grace Hopper", sender_mri: "8:orgid:grace" })),
    ).toBe(false);
    // Sides: ours and theirs are two runs even under one account (an agent's reply is
    // the case that really happens).
    expect(sameAuthor(first, message({ id: "m2", is_self: true }))).toBe(false);
  });

  it("reads the IDENTITY, so one display name shared by two people is still two", () => {
    // Two colleagues really do share a name, and a frame whose `imdisplayname` was empty
    // leaves the name blank for anybody — which chained two different people into one run
    // and suppressed the second one's own label as a repeat of the first's.
    const ada = message({ id: "m1", sender: "C. Martin", sender_mri: "8:orgid:ada" });
    const grace = message({ id: "m2", sender: "C. Martin", sender_mri: "8:orgid:grace" });
    expect(sameAuthor(ada, grace)).toBe(false);
    expect(sameAuthor(ada, message({ id: "m3", sender: "", sender_mri: "8:orgid:ada" }))).toBe(true);
  });

  it("falls back to the name when the store holds no identity", () => {
    const anon = (id: string, sender: string) => message({ id, sender, sender_mri: "" });
    expect(sameAuthor(anon("m1", "Ada Lovelace"), anon("m2", "Ada Lovelace"))).toBe(true);
    expect(sameAuthor(anon("m1", "Ada Lovelace"), anon("m2", "Grace Hopper"))).toBe(false);
  });

  it("never chains across a system line or an agent's reply", () => {
    const call = message({ id: "m2", system_event: { kind: "call" } as ChatMessage["system_event"] });
    expect(sameAuthor(message(), call)).toBe(false);
    // An agent's answer goes out through the user's own account, so only the signature
    // tells it from something they wrote themselves.
    const answer = message({
      id: "m2",
      content: "<p>done</p><p><em>— claude, via teams-lite</em></p>",
    });
    expect(sameAuthor(message(), answer)).toBe(false);
    expect(sameAuthor(answer, message({ id: "m3" }))).toBe(false);
  });

  it("has no run with nothing beside it", () => {
    expect(sameAuthor(undefined, message())).toBe(false);
    expect(sameAuthor(message(), undefined)).toBe(false);
  });
});

describe("chatHistoryRows", () => {
  it("draws one row per message and maps each id to its own row", () => {
    const messages = [message({ id: "a" }), message({ id: "b" })];
    const { rows, rowOfMessage } = chatHistoryRows(messages, []);
    expect(rows.map((row) => row.key)).toEqual(["a", "b"]);
    expect(rowOfMessage.get("a")).toBe(0);
    expect(rowOfMessage.get("b")).toBe(1);
  });

  // THE WHOLE POINT OF THIS TASK. A ledger's line is the machine-readable half and a bubble
  // carrying it is several hundred characters of wire in the middle of a conversation.
  it("ABSORBS a pet ledger message: no row at all, because the overlay draws the creature", () => {
    const messages = [message({ id: "a" }), petMessage({ id: "pet" }), message({ id: "b" })];
    const { rows, rowOfMessage } = chatHistoryRows(messages, []);
    expect(rows.map((row) => row.key)).toEqual(["a", "b"]);
    // Unmapped HERE: the id points at a neighbour, which `petRowNeighbours` resolves once the
    // rows around it are final.
    expect(rowOfMessage.has("pet")).toBe(false);
    // And the rows that remain are still mapped to their own index rather than to the message
    // index they used to share with it.
    expect(rowOfMessage.get("b")).toBe(1);
  });

  // BY WIRE PRESENCE, NEVER BY A PET THE DERIVATION RESOLVED — which is the one place this must
  // not copy chess, whose games are absorbed from `chessGamesInThread`. Both records below are
  // real ledgers that NOTHING ON SCREEN DRAWS, and each would render its raw line as a bubble if
  // absorption asked the derivation instead of the message.
  it("absorbs a ledger nothing on screen draws", () => {
    // A pet that has GONE HOME. The record stays — what its owner did to other pets still
    // counts — and `pet-layer` filters it out of everything it draws.
    const gone = petMessage({ id: "gone" }, { ...newPetLedger("7f3a1c", "cat"), gone: true });
    expect(petsInThread([gone])[0]?.gone).toBe(true);
    expect(chatHistoryRows([gone], []).rows).toEqual([]);

    // A SECOND ledger from the same author. `petsInThread` absorbs it whole into the draft their
    // first one landed in, so it names no creature of its own — and it must still not be drawn.
    const first = petMessage({ id: "one", compose_time: 1 });
    const second = petMessage({ id: "two", compose_time: 2 }, newPetLedger("a91e04", "dog"));
    expect(petsInThread([first, second]).length).toBe(1);
    expect(chatHistoryRows([first, second], []).rows).toEqual([]);
  });

  it("keeps a row for a record this build cannot read", () => {
    // The rule an unknown chess kind already follows: a line from a NEWER build draws the words
    // it carries and no creature, rather than a message with a hole in it.
    const newer = message({
      id: "v2",
      content: "<p>Nori is here.</p><p><em>— pet 7f3a1c v2 s.cat, via teams-lite</em></p>",
    });
    expect(chatHistoryRows([newer], []).rows.map((row) => row.key)).toEqual(["v2"]);
  });

  it("still absorbs a game into its own board row", () => {
    const game = {
      id: "7f3a1c",
      challengeMessageId: "open",
      absorbed: ["open", "move"],
    } as unknown as ChessGame;
    const messages = [
      message({ id: "open", compose_time: 1 }),
      message({ id: "move", compose_time: 2 }),
      message({ id: "said", compose_time: 3 }),
    ];
    const { rows, rowOfMessage } = chatHistoryRows(messages, [game]);
    expect(rows.map((row) => row.kind)).toEqual(["chess", "message"]);
    // Every message of the game points at the board, so a deep link to a move lands on it.
    expect(rowOfMessage.get("open")).toBe(0);
    expect(rowOfMessage.get("move")).toBe(0);
    expect(rowOfMessage.get("said")).toBe(1);
  });
});

describe("petRowNeighbours", () => {
  const rowFor = (id: string, compose_time: number): HistoryRow => ({
    kind: "message",
    key: id,
    message: message({ id, compose_time }),
  });

  it("points a pet ledger at the first row whose message is NEWER", () => {
    const rows = [rowFor("a", 10), rowFor("b", 30)];
    const at = petRowNeighbours(rows, [petMessage({ id: "pet", compose_time: 20 })]);
    expect(at.get("pet")).toBe(1);
  });

  it("points the newest pet ledger at the LAST row, whatever kind that row is", () => {
    // A recording is spliced in after the messages, which is exactly why this pass runs last.
    const rows: HistoryRow[] = [
      rowFor("a", 10),
      { kind: "recording", key: "rec:1", recording: { id: "1" } as unknown as CallRecording },
    ];
    const at = petRowNeighbours(rows, [petMessage({ id: "pet", compose_time: 99 })]);
    expect(at.get("pet")).toBe(1);
  });

  it("points at nothing when there is no row to point at", () => {
    // A thread holding nothing but ledgers. Scrolling to a row that is not there is worse than
    // a tap that stays where it is.
    expect(petRowNeighbours([], [petMessage({ id: "pet" })]).size).toBe(0);
  });

  it("answers for a PET LEDGER and for nothing else", () => {
    const rows = [rowFor("a", 10), rowFor("b", 30)];
    const acted = withPetAct(newPetLedger("7f3a1c", "cat"), {
      at: 1756060012345,
      kind: "feed",
      target: "7f3a1c",
    });
    const at = petRowNeighbours(rows, [
      message({ id: "said", compose_time: 20 }),
      message({
        id: "game",
        compose_time: 20,
        content: "<p>♟ 1. e4</p><p><em>— chess 7f3a1c 1 e4, via teams-lite</em></p>",
      }),
      // Prose that merely carries the words is nobody's ledger.
      message({ id: "prose", compose_time: 20, content: "<p>I told him — pet the cat</p>" }),
      petMessage({ id: "pet", compose_time: 20 }, acted),
    ]);
    expect([...at.keys()]).toEqual(["pet"]);
  });

  it("keeps every ledger of several, each at its own neighbour", () => {
    const rows = [rowFor("a", 10), rowFor("b", 30)];
    const at = petRowNeighbours(rows, [
      petMessage({ id: "mine", compose_time: 5 }),
      petMessage({ id: "theirs", compose_time: 20 }, newPetLedger("a91e04", "dog")),
    ]);
    expect(at.get("mine")).toBe(0);
    expect(at.get("theirs")).toBe(1);
  });
});
