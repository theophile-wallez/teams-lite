import { describe, expect, it } from "vitest";
import { PET_PAT_KEY, petOf, petSlotKey, petsInThread, withPetArchive } from "./pet-thread";
import { newPetLedger, petMessageHtml, withPetAct, type PetLedger } from "./pet-wire";
import type { ChatMessage, Reaction } from "./protocol";

const BIRTH = 1_756_000_000_000;
const ME = { mri: "8:orgid:me", name: "Clement" };
const ADA = { mri: "8:orgid:ada", name: "Ada Lovelace" };
const GRACE = { mri: "8:orgid:grace", name: "Grace Hopper" };

let seq = 0;

/** A ledger message as the thread really holds one: the body its author's own app wrote, and the
 *  `compose_time` of the moment it was FIRST posted — which is what an edit keeps.
 *
 *  Every assertion about an id reads it back off the message rather than guessing `m3`, so a test
 *  added above cannot renumber the one below it. */
function ledgerMessage(
  ledger: PetLedger,
  who: { mri: string; name: string },
  over: Partial<ChatMessage> = {},
): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation_id: "19:room@thread.v2",
    seq,
    compose_time: BIRTH,
    sender: who.name,
    sender_mri: who.mri,
    content: petMessageHtml(ledger, "Pixel"),
    ...(who === ME ? { is_self: true } : {}),
    ...over,
  };
}

/** An ordinary message somebody wrote, which no pet may claim. */
function plainMessage(text: string): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation_id: "19:room@thread.v2",
    seq,
    compose_time: BIRTH,
    sender: ADA.name,
    sender_mri: ADA.mri,
    content: `<p>${text}</p>`,
  };
}

function pats(count: number): Reaction[] {
  return [{ key: PET_PAT_KEY, count, mine: false }];
}

/** A ledger carrying one act, which is what most of these fixtures need. */
function acted(
  pet: string,
  skin: string,
  act: { at: number; kind: "feed" | "play" | "nap"; target: string },
): PetLedger {
  return withPetAct(newPetLedger(pet, skin), act);
}

describe("the walk is one pass, collect then resolve", () => {
  it("holds one pet per person, in the order their ledgers first appeared", () => {
    const pets = petsInThread([
      ledgerMessage(newPetLedger("aaa111", "cat"), ADA),
      plainMessage("nice cat"),
      ledgerMessage(newPetLedger("bbb222", "dog"), GRACE),
    ]);
    expect(pets.map((pet) => pet.id)).toEqual(["aaa111", "bbb222"]);
    expect(pets.map((pet) => pet.owner.name)).toEqual([ADA.name, GRACE.name]);
    expect(pets.map((pet) => pet.skin)).toEqual(["cat", "dog"]);
  });

  it("draws nothing at all from a thread with no ledger in it", () => {
    expect(petsInThread([plainMessage("morning"), plainMessage("— pet, sort of")])).toEqual([]);
  });

  it("is not a pet when its message was DELETED, whatever the body still says", () => {
    const message = ledgerMessage(newPetLedger("aaa111", "cat"), ADA);
    expect(petsInThread([{ ...message, deleted: true }])).toEqual([]);
  });
});

describe("one ledger per AUTHOR, first wins", () => {
  it("absorbs and ignores a second ledger from the same person", () => {
    const first = ledgerMessage(newPetLedger("aaa111", "cat"), ADA);
    const second = ledgerMessage({ ...newPetLedger("aaa111", "dog"), gone: true }, ADA);
    const pets = petsInThread([first, second]);
    expect(pets).toHaveLength(1);
    // The FIRST record stands: neither the skin nor the `gone` of the second reaches the creature.
    expect(pets[0]?.skin).toBe("cat");
    expect(pets[0]?.gone).toBe(false);
    expect(pets[0]?.messageId).toBe(first.id);
    // …and the ignored one is still absorbed, or the reader is shown its raw line.
    expect(pets[0]?.absorbed).toEqual([first.id, second.id]);
  });

  it("counts a second ledger's acts NOWHERE, so nothing is folded twice", () => {
    const one = acted("aaa111", "cat", { at: BIRTH + 1, kind: "feed", target: "aaa111" });
    const again = withPetAct(one, { at: BIRTH + 2, kind: "feed", target: "aaa111" });
    const pets = petsInThread([ledgerMessage(one, ADA), ledgerMessage(again, ADA)]);
    expect(pets[0]?.acts).toEqual([{ at: BIRTH + 1, kind: "feed" }]);
  });

  it("absorbs a second ledger naming a NEW pet id onto the pet its author already owns", () => {
    // The one path that used to leave a raw wire line in the history: nothing owns the second id,
    // so a draft made for it would resolve to nothing and take its message id down with it.
    const first = ledgerMessage(newPetLedger("aaa111", "cat"), ADA);
    const second = ledgerMessage(newPetLedger("bbb222", "dog"), ADA);
    const pets = petsInThread([first, second]);
    expect(pets.map((pet) => pet.id)).toEqual(["aaa111"]);
    expect(pets[0]?.absorbed).toEqual([first.id, second.id]);
  });

  it("keeps the FIRST claim on a pet id two people name, and still counts the loser's acts", () => {
    const mine = ledgerMessage(newPetLedger("aaa111", "cat"), ADA);
    const theirs = ledgerMessage(
      acted("aaa111", "dog", { at: BIRTH + 7, kind: "feed", target: "aaa111" }),
      GRACE,
    );
    const pets = petsInThread([mine, theirs]);
    expect(pets).toHaveLength(1);
    expect(pets[0]?.owner.mri).toBe(ADA.mri);
    // Grace owns no creature here, but this IS her own first ledger: she really fed Ada's pet.
    expect(pets[0]?.acts).toEqual([{ at: BIRTH + 7, kind: "feed" }]);
    expect(pets[0]?.absorbed).toEqual([mine.id, theirs.id]);
  });
});

describe("owner.isSelf is how anything answers WHOSE pet this is", () => {
  it("reads the message's own is_self, since the page never holds the user's MRI", () => {
    // Ada's fixture states nothing, which is what a colleague's message really carries — so an
    // ABSENT flag reads as somebody else's rather than hopefully as the reader's own.
    const pets = petsInThread([
      ledgerMessage(newPetLedger("aaa111", "cat"), ME),
      ledgerMessage(newPetLedger("bbb222", "dog"), ADA),
    ]);
    expect(pets.map((pet) => pet.owner.isSelf)).toEqual([true, false]);
  });
});

describe("BIRTH is the ledger message's own compose_time", () => {
  it("takes the moment the service stamped, never a value from the payload", () => {
    const message = ledgerMessage(newPetLedger("aaa111", "cat"), ADA, {
      compose_time: 1_700_000_000_000,
    });
    expect(petsInThread([message])[0]?.birth).toBe(1_700_000_000_000);
  });

  it("keeps the FIRST post's moment when the ledger is EDITED, which is what an act does", () => {
    // A real edit: Teams keeps the message's id and its `compose_time` and replaces the body. So
    // the birth stays at the spawn however many acts the payload has grown since — an author
    // cannot move their own pet's birth forward under the acts dated against it.
    const spawned = ledgerMessage(newPetLedger("aaa111", "cat"), ADA, { compose_time: BIRTH });
    const grown = acted("aaa111", "cat", { at: BIRTH + 90_000, kind: "feed", target: "aaa111" });
    const edited = { ...spawned, content: petMessageHtml(grown, "Pixel") };
    expect(edited.id).toBe(spawned.id);
    expect(edited.compose_time).toBe(spawned.compose_time);

    const pet = petsInThread([edited])[0];
    expect(pet?.birth).toBe(BIRTH);
    expect(pet?.acts).toEqual([{ at: BIRTH + 90_000, kind: "feed" }]);
  });
});

describe("a pet's acts come from EVERY ledger in the thread", () => {
  it("gathers what a colleague did to somebody else's pet", () => {
    const theirs = acted("bbb222", "dog", { at: BIRTH + 10, kind: "feed", target: "aaa111" });
    const pets = petsInThread([
      ledgerMessage(newPetLedger("aaa111", "cat"), ADA),
      ledgerMessage(theirs, GRACE),
    ]);
    expect(petOf(pets, ADA.mri)?.acts).toEqual([{ at: BIRTH + 10, kind: "feed" }]);
    expect(petOf(pets, GRACE.mri)?.acts).toEqual([]);
  });

  it("hands each act only to the pet it TARGETS", () => {
    let ledger = acted("aaa111", "cat", { at: BIRTH + 1, kind: "feed", target: "aaa111" });
    ledger = withPetAct(ledger, { at: BIRTH + 2, kind: "play", target: "bbb222" });
    const pets = petsInThread([
      ledgerMessage(ledger, ADA),
      ledgerMessage(newPetLedger("bbb222", "dog"), GRACE),
    ]);
    expect(petOf(pets, ADA.mri)?.acts).toEqual([{ at: BIRTH + 1, kind: "feed" }]);
    expect(petOf(pets, GRACE.mri)?.acts).toEqual([{ at: BIRTH + 2, kind: "play" }]);
  });

  it("drops an act naming a pet the thread does not hold", () => {
    const ledger = acted("aaa111", "cat", { at: BIRTH + 5, kind: "nap", target: "cccc33" });
    const pets = petsInThread([ledgerMessage(ledger, ADA)]);
    // No pet is minted to hold it: one with no owner, no birth and no message to edit is not a pet.
    expect(pets.map((pet) => pet.id)).toEqual(["aaa111"]);
    expect(pets[0]?.acts).toEqual([]);
  });

  it("LEAVES an act dated outside the pet's life in, because petSnapshot refuses it", () => {
    let ledger = acted("aaa111", "cat", { at: BIRTH - 60_000, kind: "feed", target: "aaa111" });
    ledger = withPetAct(ledger, { at: BIRTH + 86_400_000, kind: "feed", target: "aaa111" });
    const pet = petsInThread([ledgerMessage(ledger, ADA)])[0];
    // One refusal site, not two: the fold is where a moment is judged against the birth and now.
    expect(pet?.acts).toEqual([
      { at: BIRTH - 60_000, kind: "feed" },
      { at: BIRTH + 86_400_000, kind: "feed" },
    ]);
  });
});

describe("a PAT is the reaction's count and nothing else", () => {
  it("reads the agreed key off the ledger message", () => {
    const message = ledgerMessage(newPetLedger("aaa111", "cat"), ADA, { reactions: pats(3) });
    expect(petsInThread([message])[0]?.pats).toBe(3);
  });

  it("counts no pat for another reaction, or for none at all", () => {
    const other = ledgerMessage(newPetLedger("aaa111", "cat"), ADA, {
      reactions: [{ key: "laugh", count: 4, mine: true }],
    });
    expect(petsInThread([other])[0]?.pats).toBe(0);
    expect(petsInThread([ledgerMessage(newPetLedger("bbb222", "dog"), GRACE)])[0]?.pats).toBe(0);
  });
});

describe("a pet that has GONE keeps its record", () => {
  it("is still a pet, so its owner's acts on other pets still count", () => {
    const ledger = withPetAct({ ...newPetLedger("aaa111", "cat"), gone: true }, {
      at: BIRTH + 3,
      kind: "play",
      target: "bbb222",
    });
    const pets = petsInThread([
      ledgerMessage(ledger, ADA),
      ledgerMessage(newPetLedger("bbb222", "dog"), GRACE),
    ]);
    expect(petOf(pets, ADA.mri)?.gone).toBe(true);
    expect(petOf(pets, GRACE.mri)?.acts).toEqual([{ at: BIRTH + 3, kind: "play" }]);
  });
});

describe("absorbed lists every message of the record", () => {
  it("names the ledger, so the pane can take its raw line off the history", () => {
    const chatter = plainMessage("morning");
    const message = ledgerMessage(newPetLedger("aaa111", "cat"), ADA);
    const pet = petsInThread([chatter, message])[0];
    expect(pet?.absorbed).toEqual([message.id]);
    expect(pet?.absorbed).not.toContain(chatter.id);
  });
});

describe("petSlotKey", () => {
  it("keys a page's own state by conversation AND pet, since a thread holds several", () => {
    expect(petSlotKey("19:room@thread.v2", "aaa111")).toBe("19:room@thread.v2/aaa111");
    expect(petSlotKey("19:room@thread.v2", "aaa111")).not.toBe(
      petSlotKey("19:room@thread.v2", "bbb222"),
    );
  });
});

describe("petOf", () => {
  it("finds somebody's own pet by their MRI", () => {
    const pets = petsInThread([
      ledgerMessage(newPetLedger("aaa111", "cat"), ADA),
      ledgerMessage(newPetLedger("bbb222", "dog"), GRACE),
    ]);
    expect(petOf(pets, GRACE.mri)?.id).toBe("bbb222");
    expect(petOf(pets, "8:orgid:nobody")).toBeUndefined();
  });

  it("names NOBODY for an empty MRI, rather than the first authorless record", () => {
    const nobody = ledgerMessage(newPetLedger("aaa111", "cat"), { mri: "", name: "" });
    const pets = petsInThread([nobody]);
    expect(pets).toHaveLength(1);
    expect(petOf(pets, "")).toBeUndefined();
  });
});

describe("withPetArchive", () => {
  // THE FOLD IS COMPLETE OR IT IS DESTRUCTIVE, and this is the merge that makes it complete.
  //
  // A pet IS its messages, and the history loads a page at a time (40) while every act EDITS its
  // author's one ledger — so that message keeps the `seq` it was first posted at and pages out while
  // the creature is alive. The loaded page alone then said "you have no companion here": none drawn,
  // no menu to reach it with, and the conversation's own menu offering a SPAWN, whose press SENDS a
  // second arrival message everybody in the thread reads and which `petsInThread`'s one-ledger-per-
  // author rule absorbs and ignores WHOLE — so the creature vanished and nothing could reach it again.
  it("folds a creature whose ledger has PAGED OUT of the loaded history", () => {
    const mine = ledgerMessage(newPetLedger("aaa111", "cat"), ME, { seq: 1, id: "ledger" });
    const loaded = [plainMessage("much later"), plainMessage("later still")];

    // What shipped: the loaded page alone knows nothing about the reader's own creature.
    expect(petsInThread(loaded).some((pet) => pet.owner.isSelf)).toBe(false);

    const whole = withPetArchive(loaded, [mine]);
    const pets = petsInThread(whole);
    const own = pets.find((pet) => pet.owner.isSelf);
    expect(own?.id).toBe("aaa111");
    // And the message every later act EDITS comes back with it, or the fold would have a creature
    // with nowhere to write to.
    expect(own?.messageId).toBe("ledger");
  });

  it("puts an archived ledger back in `seq` order, which is what names the FIRST one", () => {
    // `petsInThread` reads "the first ledger this author wrote" off the order, and a second is absorbed
    // and ignored whole — so an archived record dropped in at the wrong end would hand the record, and
    // with it the message every act edits, to the wrong message.
    const first = ledgerMessage(newPetLedger("aaa111", "cat"), ME, { seq: 1, id: "first" });
    const second = ledgerMessage(newPetLedger("bbb222", "dog"), ME, { seq: 9, id: "second" });
    const merged = withPetArchive([second], [first]);
    expect(merged.map((m) => m.id)).toEqual(["first", "second"]);
    expect(petsInThread(merged)[0]?.messageId).toBe("first");
  });

  it("lets the LOADED copy win, because the archive is a snapshot", () => {
    // The live feed writes into the loaded history, so an act that landed a moment ago is fresh there
    // and stale in here. Matched by id, exactly as `chessSeriesGames` merges the same pair.
    const stale = ledgerMessage(newPetLedger("aaa111", "cat"), ME, { seq: 1, id: "ledger" });
    const fed = withPetAct(newPetLedger("aaa111", "cat"), { at: BIRTH + 1, kind: "feed", target: "aaa111" });
    const fresh = ledgerMessage(fed, ME, { seq: 1, id: "ledger" });
    const merged = withPetArchive([fresh], [stale]);
    expect(merged).toHaveLength(1);
    expect(petsInThread(merged)[0]?.acts).toHaveLength(1);
  });

  // THE SAME ARRAY, and that is not tidiness: this feeds the memo that feeds the fold, the layer and
  // every publish, so a fresh array per render would re-fold the whole history on every scroll that
  // mounts a row.
  it("returns the loaded history UNCHANGED when there is nothing to add", () => {
    const mine = ledgerMessage(newPetLedger("aaa111", "cat"), ME, { seq: 1, id: "ledger" });
    const loaded = [mine, plainMessage("said")];
    expect(withPetArchive(loaded, undefined)).toBe(loaded);
    expect(withPetArchive(loaded, [])).toBe(loaded);
    expect(withPetArchive(loaded, [mine])).toBe(loaded);
  });
});
