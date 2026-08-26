// What the narrow chat column beside a call or a board SHOWS — and what it leaves out, which is
// every message that is machinery rather than something somebody said.
import { describe, it, expect } from "vitest";
import { transcriptMessages } from "./conversation-chat-panel";
import { newPetLedger, petMessageHtml, withPetAct } from "~/lib/pet-wire";
import type { ChatMessage } from "~/lib/protocol";

function message(content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    conversation_id: "c1",
    seq: 1,
    compose_time: 1,
    sender: "Ada Lovelace",
    sender_mri: "8:orgid:ada",
    content,
    ...over,
  };
}

const ids = (messages: ChatMessage[]) => messages.map((m) => m.id);

describe("transcriptMessages", () => {
  it("leaves out a game of chess and a companion", () => {
    // Each is drawn as its own thing — a board, and a creature the overlay walks over the
    // history — and this column has neither, so the raw signed line is what a reader saw. It
    // LEAVES THEM OUT rather than stripping the line: nobody typed those words.
    const acted = withPetAct(newPetLedger("7f3a1c", "cat"), {
      at: 1756060012345,
      kind: "feed",
      target: "7f3a1c",
    });
    const shown = transcriptMessages([
      message("<p>on my way</p>", { id: "said" }),
      message("<p>♟ 1. e4</p><p><em>— chess 7f3a1c 1 e4, via teams-lite</em></p>", { id: "game" }),
      message(petMessageHtml(acted, "Nori"), { id: "pet" }),
      message("<p>see you</p>", { id: "also" }),
    ]);
    expect(ids(shown)).toEqual(["said", "also"]);
  });

  it("keeps everything somebody really said", () => {
    const shown = transcriptMessages([
      // An agent's reply is words a reader wants: it is drawn under the CLI's mark with its own
      // signature stripped, never left out.
      message("<p>done</p><p><em>— claude, via teams-lite</em></p>", { id: "answer" }),
      // Prose that merely carries the words. Both readers re-validate the tail before believing
      // it, so neither is fooled by a colleague's sentence.
      message("<p>I told him — pet the cat, not the dog</p>", { id: "prose" }),
      // A record from a NEWER build reads as no record at all, so its words are shown rather
      // than the message silently vanishing from the column.
      message("<p>Nori is here.</p><p><em>— pet 7f3a1c v2 s.cat, via teams-lite</em></p>", {
        id: "newer",
      }),
      // A DELETED ledger, whose placeholder IS its body: a reader being shown a tombstone must
      // not have that row taken away instead.
      message(petMessageHtml(newPetLedger("7f3a1c", "cat"), "Nori"), {
        id: "tombstone",
        deleted: true,
      }),
    ]);
    expect(ids(shown)).toEqual(["answer", "prose", "newer", "tombstone"]);
  });

  it("keeps the NEWEST of a long thread, and bounded", () => {
    // A panel this narrow is read during a call rather than scrolled through, and what is above
    // the bound is in the conversation itself — so the end that survives is the end being read.
    const many = Array.from({ length: 200 }, (_, i) =>
      message("<p>line</p>", { id: `m${i}`, compose_time: i }),
    );
    const shown = transcriptMessages(many);
    expect(shown.length).toBe(60);
    expect(shown[shown.length - 1]?.id).toBe("m199");
  });
});
