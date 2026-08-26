import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./protocol";
import {
  PET_ACTS_KEPT,
  newPetLedger,
  parsePetLedger,
  petLedgerLine,
  petMessageHtml,
  petMessageText,
  petMessageWords,
  petWireIn,
  serializePetLedger,
  stripPetLine,
  withPetAct,
  type PetAct,
  type PetLedger,
} from "./pet-wire";

const MINE = "7f3a1c";
const THEIRS = "a91e04";

function act(at: number, kind: PetAct["kind"], target = MINE): PetAct {
  return { at, kind, target };
}

function ledger(over: Partial<PetLedger> = {}): PetLedger {
  return { ...newPetLedger(MINE, "cat"), ...over };
}

function message(content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { content, ...over } as ChatMessage;
}

function bodyOf(l: PetLedger, label = "Nori"): ChatMessage {
  return message(petMessageHtml(l, label));
}

describe("the line", () => {
  it("round-trips a whole ledger", () => {
    const l = ledger({
      acts: [act(1756060012345, "feed"), act(1756060099000, "play", THEIRS), act(1756060420000, "nap")],
    });
    const read = parsePetLedger(MINE, serializePetLedger(l));
    expect(read).toEqual(l);
  });

  it("is read back out of a real message body", () => {
    const l = ledger({ acts: [act(1756060012345, "feed")] });
    expect(petWireIn(bodyOf(l))).toEqual(l);
  });

  it("spells the line the way the reader parses it", () => {
    const l = ledger({ acts: [act(1756060012345, "feed", THEIRS)] });
    expect(petLedgerLine(l)).toBe(
      `— pet ${MINE} v1 s.cat 1756060012345.f.${THEIRS}, via teams-lite`,
    );
  });

  /**
   * THE assertion of this module. A colon in the line becomes a custom-emoji code span, the backend
   * substitutes an `<img>` for it on the very next edit, `SIGNATURE`'s own `[^<]*?` stops matching,
   * and every pet in the conversation is unreadable for everybody for good.
   */
  it("serializes no colon with everything set", () => {
    const l = ledger({
      gone: true,
      acts: [act(1756060012345, "feed"), act(1756060099000, "play", THEIRS), act(1756060420000, "nap")],
    });
    const line = petLedgerLine(l);
    expect(line).not.toContain(":");
    expect(petMessageText(l, "Nori")).not.toContain(":");
    // The HTML carries tags, so only its LINE is checked — which is the part the emoji pass eats.
    expect(petMessageHtml(l, "Nori")).toContain(line);
  });

  it("is deterministic under a shuffled act list", () => {
    const acts = [act(3, "nap"), act(1, "feed"), act(2, "play", THEIRS)];
    const forwards = serializePetLedger(ledger({ acts }));
    const backwards = serializePetLedger(ledger({ acts: [...acts].reverse() }));
    expect(forwards).toBe(backwards);
  });

  it("orders two acts in the same millisecond the same way on both machines", () => {
    const a = serializePetLedger(ledger({ acts: [act(7, "play"), act(7, "feed")] }));
    const b = serializePetLedger(ledger({ acts: [act(7, "feed"), act(7, "play")] }));
    expect(a).toBe(b);
  });
});

describe("what it refuses, and what it forgives", () => {
  it("IGNORES a named token from a newer build", () => {
    const read = parsePetLedger(MINE, "v1 s.cat mood.smug 1756060012345.f.7f3a1c");
    expect(read?.skin).toBe("cat");
    expect(read?.acts).toHaveLength(1);
  });

  it("REFUSES the whole record for a malformed digit-led token", () => {
    expect(parsePetLedger(MINE, "v1 s.cat 1756060012345.f.7f3a1c 99999.x")).toBeNull();
  });

  it("REFUSES an act whose kind this build does not know", () => {
    expect(parsePetLedger(MINE, "v1 1756060012345.q.7f3a1c")).toBeNull();
  });

  it("REFUSES an unbounded epoch rather than reading a number nothing can reason about", () => {
    expect(parsePetLedger(MINE, `v1 ${"9".repeat(16)}.f.7f3a1c`)).toBeNull();
  });

  it("REFUSES a target that is not six hex", () => {
    expect(parsePetLedger(MINE, "v1 1756060012345.f.zzzzzz")).toBeNull();
    expect(parsePetLedger(MINE, "v1 1756060012345.f.7f3a1")).toBeNull();
  });

  it("leaves a newer VERSION an ordinary message", () => {
    expect(parsePetLedger(MINE, "v2 s.cat")).toBeNull();
    expect(petWireIn(message(`<p>hi</p><p><em>— pet ${MINE} v2 s.cat, via teams-lite</em></p>`))).toBeNull();
  });

  it("is not a wire on a DELETED message", () => {
    const l = ledger();
    expect(petWireIn(message(petMessageHtml(l, "Nori"), { deleted: true }))).toBeNull();
  });

  it("is not a wire on a message that merely ends in italics", () => {
    expect(petWireIn(message("<p>ok</p><p><em>see you</em></p>"))).toBeNull();
  });

  it("is not confused by the agent's own signature in the same slot", () => {
    expect(petWireIn(message("<p>done</p><p><em>— claude, via teams-lite</em></p>"))).toBeNull();
  });

  it("is not confused by a chess ledger in the same slot", () => {
    expect(petWireIn(message(`<p>1. e4</p><p><em>— chess ${MINE} v2 w open, via teams-lite</em></p>`))).toBeNull();
  });

  it("reads an empty payload as a pet with nothing done to it yet", () => {
    expect(parsePetLedger(MINE, "v1")).toEqual({ pet: MINE, skin: "", gone: false, acts: [] });
  });
});

describe("the bound", () => {
  it("keeps the newest acts and drops the oldest", () => {
    let l = ledger({ acts: [] });
    for (let i = 1; i <= PET_ACTS_KEPT + 5; i++) l = withPetAct(l, act(i, "feed"));
    expect(l.acts).toHaveLength(PET_ACTS_KEPT);
    expect(l.acts[0]?.at).toBe(6);
    expect(l.acts.at(-1)?.at).toBe(PET_ACTS_KEPT + 5);
  });

  it("keeps a bounded ledger inside a Teams message", () => {
    let l = ledger({ acts: [] });
    for (let i = 1; i <= PET_ACTS_KEPT; i++) l = withPetAct(l, act(1756060012345 + i, "play", THEIRS));
    // The service refuses a whole message over 102 400 bytes; this must not be near it.
    expect(petMessageText(l, "Nori").length).toBeLessThan(1024);
  });
});

describe("the words above the line", () => {
  it("state the state rather than the event", () => {
    const l = ledger({ acts: [act(1, "feed"), act(2, "feed"), act(3, "play", THEIRS)] });
    expect(petMessageWords(l, "Nori")).toBe("Nori · fed 2 · played 1");
  });

  it("say a pet is here when nothing has been done to it", () => {
    expect(petMessageWords(ledger(), "Nori")).toBe("Nori is here.");
  });

  it("say a pet has gone", () => {
    expect(petMessageWords(ledger({ gone: true }), "Nori")).toBe("Nori has gone home.");
  });
});

describe("the strip", () => {
  it("takes the line off a preview", () => {
    const l = ledger({ acts: [act(1756060012345, "feed")] });
    expect(stripPetLine(petMessageText(l, "Nori"))).toBe("Nori · fed 1");
  });

  it("RE-VALIDATES the tail rather than cutting at the marker", () => {
    // A real message that happens to contain the words. A naive split would truncate it.
    const prose = "I told him — pet the cat, not the dog";
    expect(stripPetLine(prose)).toBe(prose);
  });

  it("leaves an agent's own signature alone", () => {
    const answer = "shipped it\n— claude, via teams-lite";
    expect(stripPetLine(answer)).toBe(answer);
  });

  it("leaves a message with no line at all alone", () => {
    expect(stripPetLine("just a message")).toBe("just a message");
  });
});
