// Who a message's author IS, which is what decides whether the history draws two
// messages as one person talking twice — and, with that, whether the second one carries
// a sender name at all (a continuation never does).
import { describe, it, expect } from "vitest";
import { sameAuthor } from "./message-pane";
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
