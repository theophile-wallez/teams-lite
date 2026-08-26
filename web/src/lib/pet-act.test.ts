import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  petPublishFor,
  petSpawnIsOffered,
  petSpawnIsTravelling,
  type PetPress,
} from "./pet-act";
import { petSkin, PET_SKINS } from "./pet-skin";
import { petsInThread, type Pet } from "./pet-thread";
import { newPetLedger, petMessageHtml, withPetAct, type PetLedger } from "./pet-wire";
import type { ChatMessage, Conversation, ConversationKind } from "./protocol";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const ME = { mri: "8:orgid:me", name: "Clement" };
const ADA = { mri: "8:orgid:ada", name: "Ada" };

/** The two skins the picker really offers, so a test that changes art names art this build holds. */
const [FIRST_SKIN, SECOND_SKIN] = PET_SKINS;

/**
 * A ledger message, written through the WIRE rather than by hand.
 *
 * The body is what `petMessageHtml` produces, so every test here reads its fixture back through
 * `petWireIn` exactly as the app does — a hand-written body could state a record the wire cannot
 * carry, and this module's whole job is to append to a record it read.
 */
function ledgerMessage(args: {
  id: string;
  seq: number;
  who: { mri: string; name: string };
  isSelf: boolean;
  ledger: PetLedger;
  at?: number;
}): ChatMessage {
  return {
    id: args.id,
    conversation_id: "19:thread@thread.v2",
    seq: args.seq,
    compose_time: args.at ?? T0,
    sender: args.who.name,
    sender_mri: args.who.mri,
    content: petMessageHtml(args.ledger, petSkin(args.ledger.skin).label),
    is_self: args.isSelf,
  } as ChatMessage;
}

/** A thread, and the pets it folds into — the pair `petPublishFor` is always handed. */
function thread(messages: ChatMessage[]): { messages: ChatMessage[]; pets: Pet[] } {
  return { messages, pets: petsInThread(messages) };
}

function press(pressed: PetPress, over: Partial<Parameters<typeof petPublishFor>[0]> = {}) {
  return petPublishFor({ press: pressed, pets: [], messages: [], now: T0, ...over });
}

/** Our own record, with `count` acts on our own pet already in it. */
function ours(pet: string, count = 0, over: Partial<PetLedger> = {}): PetLedger {
  let ledger: PetLedger = { ...newPetLedger(pet, FIRST_SKIN?.name ?? ""), ...over };
  for (let i = 0; i < count; i++) {
    ledger = withPetAct(ledger, { at: T0 - (count - i) * HOUR, kind: "feed", target: pet });
  }
  return ledger;
}

describe("petPublishFor", () => {
  it("SENDS the first act, and every act after it EDITS the message the DERIVATION names", () => {
    // The whole point of a ledger: the first act is a message, and nothing after it is.
    const spawn = press({ kind: "spawn", skin: FIRST_SKIN?.name ?? "" });
    expect(spawn?.messageId).toBeUndefined();
    expect(spawn?.ledger.gone).toBe(false);
    expect(spawn?.ledger.acts).toEqual([]);

    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    const feed = press({ kind: "feed", pet: "aaa111" }, { pets, messages });
    // The id is the ledger message's own, off the pet the fold built — never a value remembered
    // between presses, which is what makes a reloaded page edit the right message.
    expect(feed?.messageId).toBe("m1");
  });

  it("finds OUR record by `owner.isSelf`, and never edits a colleague's message", () => {
    // The page holds no MRI of its own, so `isSelf` is the only answer to "which pet is mine" — and
    // an act that read a colleague's ledger as ours would rewrite THEIR message.
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ADA, isSelf: false, ledger: ours("bbb222") }),
    ]);
    const spawn = press({ kind: "spawn", skin: FIRST_SKIN?.name ?? "" }, { pets, messages });
    expect(spawn?.messageId).toBeUndefined();
    expect(spawn?.ledger.pet).not.toBe("bbb222");
  });

  it("mints a pet id of six lowercase hex, and never an identity", () => {
    const spawn = press({ kind: "spawn", skin: FIRST_SKIN?.name ?? "" });
    expect(spawn?.ledger.pet).toMatch(/^[0-9a-f]{6}$/);
    expect(spawn?.pet).toBe(spawn?.ledger.pet);
  });

  it("APPENDS an act to the record the message already states", () => {
    // The failure this pins: rebuilding the ledger from the pets alone publishes a record holding
    // ONE act, so everything its author ever did is dropped from the wire on the next feed.
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111", 2) }),
    ]);
    const feed = press({ kind: "feed", pet: "aaa111" }, { pets, messages, now: T0 + HOUR });
    expect(feed?.ledger.acts).toHaveLength(3);
    expect(feed?.ledger.acts.at(-1)).toEqual({ at: T0 + HOUR, kind: "feed", target: "aaa111" });
  });

  it("writes each of the three acts under its own kind — and a PAT is none of them", () => {
    // A pat is a Teams reaction on the pet's own message, so it is not a press at all: there is no
    // `{kind:"pat"}` for a caller to pass, and this module never mentions one.
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    for (const kind of ["feed", "play", "nap"] as const) {
      const publish = press({ kind, pet: "aaa111" }, { pets, messages });
      expect(publish?.ledger.acts.at(-1)?.kind).toBe(kind);
      expect(publish?.pending).toEqual({ at: T0, kind });
    }
  });

  it("names the pet the press was ABOUT, which for an act is the TARGET", () => {
    // The slot a refusal and a pending act are keyed by: feeding a colleague's creature edits OUR
    // record and belongs, for the reader, to THEIRS.
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
      ledgerMessage({ id: "m2", seq: 2, who: ADA, isSelf: false, ledger: ours("bbb222") }),
    ]);
    const feed = press({ kind: "feed", pet: "bbb222" }, { pets, messages });
    expect(feed?.pet).toBe("bbb222");
    expect(feed?.messageId).toBe("m1");
    expect(feed?.ledger.pet).toBe("aaa111");
    expect(feed?.ledger.acts.at(-1)?.target).toBe("bbb222");

    const despawn = press({ kind: "despawn" }, { pets, messages });
    expect(despawn?.pet).toBe("aaa111");
  });

  it("carries only an ACT's own pending, because nothing else changes a stat", () => {
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    expect(press({ kind: "despawn" }, { pets, messages })?.pending).toBeUndefined();
    expect(
      press({ kind: "skin", skin: SECOND_SKIN?.name ?? "" }, { pets, messages })?.pending,
    ).toBeUndefined();
    expect(press({ kind: "spawn", skin: FIRST_SKIN?.name ?? "" })?.pending).toBeUndefined();
  });

  it("refuses a press on a pet the thread does not hold", () => {
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    expect(press({ kind: "feed", pet: "ffffff" }, { pets, messages })).toBeNull();
  });

  it("refuses a press on a pet that has gone home", () => {
    // A stale press: the menu was open while its owner sent the creature away.
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
      ledgerMessage({
        id: "m2",
        seq: 2,
        who: ADA,
        isSelf: false,
        ledger: { ...ours("bbb222"), gone: true },
      }),
    ]);
    expect(press({ kind: "play", pet: "bbb222" }, { pets, messages })).toBeNull();
  });

  it("refuses a spawn while the presser already owns a pet that is not gone", () => {
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    expect(press({ kind: "spawn", skin: SECOND_SKIN?.name ?? "" }, { pets, messages })).toBeNull();
  });

  it("spawning after a despawn keeps THE SAME creature, its id and its acts", () => {
    const { messages, pets } = thread([
      ledgerMessage({
        id: "m1",
        seq: 1,
        who: ME,
        isSelf: true,
        ledger: { ...ours("aaa111", 2), gone: true },
      }),
    ]);
    const again = press({ kind: "spawn", skin: SECOND_SKIN?.name ?? "" }, { pets, messages });
    expect(again?.ledger.pet).toBe("aaa111");
    expect(again?.ledger.gone).toBe(false);
    expect(again?.ledger.skin).toBe(SECOND_SKIN?.name);
    // What its owner did to their friends' pets did not un-happen.
    expect(again?.ledger.acts).toHaveLength(2);
    // And it rewrites the record rather than posting a second one, which the fold would ignore.
    expect(again?.messageId).toBe("m1");
  });

  it("refuses a despawn when there is nothing to send home", () => {
    expect(press({ kind: "despawn" })).toBeNull();
    const { messages, pets } = thread([
      ledgerMessage({
        id: "m1",
        seq: 1,
        who: ME,
        isSelf: true,
        ledger: { ...ours("aaa111"), gone: true },
      }),
    ]);
    expect(press({ kind: "despawn" }, { pets, messages })).toBeNull();
    expect(press({ kind: "skin", skin: SECOND_SKIN?.name ?? "" }, { pets, messages })).toBeNull();
  });

  it("refuses an act from a reader with no record of their own, who has the PAT instead", () => {
    // The wire's own consequence: an act is a line in its author's own ledger, and a ledger must name
    // a pet — so writing one for somebody who never spawned would mint a creature they did not ask
    // for. A pat is a reaction and needs no record at all.
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ADA, isSelf: false, ledger: ours("bbb222") }),
    ]);
    expect(press({ kind: "feed", pet: "bbb222" }, { pets, messages })).toBeNull();
  });

  it("lets a reader whose OWN pet has gone home still feed a friend's", () => {
    // The record stays after a despawn precisely so its acts still count.
    const { messages, pets } = thread([
      ledgerMessage({
        id: "m1",
        seq: 1,
        who: ME,
        isSelf: true,
        ledger: { ...ours("aaa111"), gone: true },
      }),
      ledgerMessage({ id: "m2", seq: 2, who: ADA, isSelf: false, ledger: ours("bbb222") }),
    ]);
    const feed = press({ kind: "feed", pet: "bbb222" }, { pets, messages });
    expect(feed?.pet).toBe("bbb222");
    expect(feed?.ledger.gone).toBe(true);
    expect(feed?.ledger.acts.at(-1)?.target).toBe("bbb222");
  });

  it("publishes nothing when our own ledger message is not among the messages given", () => {
    // Fail-closed: sending instead would post a SECOND record, which the fold absorbs and ignores
    // whole — an act nobody can ever see.
    const { pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    expect(press({ kind: "feed", pet: "aaa111" }, { pets, messages: [] })).toBeNull();
    expect(press({ kind: "despawn" }, { pets, messages: [] })).toBeNull();
    // The SPAWN branch has its own guard, and reaching it needs a pet that has GONE — otherwise
    // "you already own one" refuses first and this would pass for another reason. It is the case
    // that matters: a respawn is where sending instead would post a second, ignored record.
    const { pets: gone } = thread([
      ledgerMessage({
        id: "m1",
        seq: 1,
        who: ME,
        isSelf: true,
        ledger: { ...ours("aaa111"), gone: true },
      }),
    ]);
    expect(
      press({ kind: "spawn", skin: FIRST_SKIN?.name ?? "" }, { pets: gone, messages: [] }),
    ).toBeNull();
  });

  it("refuses a skin press that would write the same bytes", () => {
    // A deterministic serializer means this edit reaches everybody in the thread and changes no
    // reader's creature: an outward write that says nothing.
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111", 2) }),
    ]);
    expect(press({ kind: "skin", skin: FIRST_SKIN?.name ?? "" }, { pets, messages })).toBeNull();
    const changed = press({ kind: "skin", skin: SECOND_SKIN?.name ?? "" }, { pets, messages });
    expect(changed?.ledger.skin).toBe(SECOND_SKIN?.name);
    // New art, and the same record: changing a coat is not a fresh creature.
    expect(changed?.ledger.acts).toHaveLength(2);
  });

  it("refuses a skin name the WIRE cannot carry, and a colon most of all", () => {
    // A colon in the line is the one mistake that destroys every pet in the conversation for
    // everybody, for good (see pet-wire.ts): the backend substitutes an `<img>` for `:name:`.
    for (const skin of ["a:b", "Cat", "my skin", "", "-cat", "x".repeat(25)]) {
      expect(press({ kind: "spawn", skin })).toBeNull();
    }
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    expect(press({ kind: "skin", skin: "a:b" }, { pets, messages })).toBeNull();
  });

  it("publishes a body with no colon in it", () => {
    // WHERE a colon would land decides what it costs, and only one half is fatal: a skin's LABEL is
    // drawn in the words block (and `validatePetSkin` deliberately does not check a label), so a
    // colon there could at worst substitute an emoji into the words — while one in the trailing
    // `<em>` LINE breaks `SIGNATURE` and takes every pet in the conversation with it. The line's own
    // rule is pinned by the refusal test above, over six hostile names; this covers the pair.
    const spawn = press({ kind: "spawn", skin: SECOND_SKIN?.name ?? "" });
    expect(spawn).not.toBeNull();
    if (spawn) expect(petMessageHtml(spawn.ledger, spawn.label)).not.toContain(":");
  });

  it("labels the creature with the ART it wears, and a skin change with the NEW art", () => {
    const { messages, pets } = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ME, isSelf: true, ledger: ours("aaa111") }),
    ]);
    expect(press({ kind: "feed", pet: "aaa111" }, { pets, messages })?.label).toBe(FIRST_SKIN?.label);
    expect(press({ kind: "skin", skin: SECOND_SKIN?.name ?? "" }, { pets, messages })?.label).toBe(
      SECOND_SKIN?.label,
    );
  });
});

describe("petSpawnIsOffered", () => {
  /**
   * A conversation shaped only as far as this function reads it — which is that it EXISTS, plus its
   * kind. Cast rather than built in full: the rest of a `Conversation` is a fixture about the
   * sidebar in a test about one menu row.
   */
  const conversation = (kind: ConversationKind = "one_on_one") =>
    ({ id: "19:thread@thread.v2", kind }) as Conversation;

  /** The four arguments, with the two window flags at the state a reader who changed nothing is in. */
  const offered = (over: Partial<Parameters<typeof petSpawnIsOffered>[0]> = {}) =>
    petSpawnIsOffered({
      conversation: conversation(),
      pets: [],
      shown: true,
      reduce: false,
      ...over,
    });

  /** A thread holding our own creature, gone or not. */
  const mine = (gone: boolean) =>
    thread([
      ledgerMessage({
        id: "m1",
        seq: 1,
        who: ME,
        isSelf: true,
        ledger: { ...ours("aaa111", 2), gone },
      }),
    ]).pets;

  it("is offered in a chat where the reader has no creature", () => {
    expect(offered()).toBe(true);
    expect(offered({ conversation: conversation("group") })).toBe(true);
  });

  it("is offered in NOTES, which is the one thread a companion needs nobody for", () => {
    expect(offered({ conversation: conversation("notes") })).toBe(true);
  });

  it("is NOT offered in a CHANNEL, which is not in the conversation list at all", () => {
    // The signal the call and chess rows are already drawn under: a channel opened in this pane is
    // simply not among `s.conversations`, so the lookup answers undefined.
    expect(offered({ conversation: undefined })).toBe(false);
  });

  it("is NOT offered while the reader's own creature is here", () => {
    expect(offered({ pets: mine(false) })).toBe(false);
  });

  it("IS offered once their own creature has gone home — Remove is not a one-way door", () => {
    expect(offered({ pets: mine(true) })).toBe(true);
  });

  it("ignores a COLLEAGUE's creature, however many of them there are", () => {
    const pets = thread([
      ledgerMessage({ id: "m1", seq: 1, who: ADA, isSelf: false, ledger: ours("bbb222") }),
    ]).pets;
    expect(pets).toHaveLength(1);
    expect(offered({ pets })).toBe(true);
  });

  it("is NOT offered while this window draws no companions at all", () => {
    // Settings › Companions, and a reader who asked for less motion: both are refusals the LAYER
    // makes, so a spawn under either would post a message its own presser never sees.
    expect(offered({ shown: false })).toBe(false);
    expect(offered({ reduce: true })).toBe(false);
    // And neither is rescued by the other.
    expect(offered({ shown: false, reduce: true })).toBe(false);
  });
});

describe("petSpawnIsTravelling", () => {
  const CHAT_A = "19:a@thread.v2";
  const CHAT_B = "19:b@thread.v2";
  /** The receipt a spawn press in chat A leaves: its conversation, and the id it minted. */
  const RECEIPT = { conversation: CHAT_A, pet: "aaa111" };

  const travelling = (over: Partial<Parameters<typeof petSpawnIsTravelling>[0]> = {}) =>
    petSpawnIsTravelling({
      receipt: RECEIPT,
      conversation: CHAT_A,
      pets: [],
      refused: false,
      ...over,
    });

  /** The thread once our own ledger has come back, live or sent home. */
  const ourLedgerBack = (gone: boolean) =>
    thread([
      ledgerMessage({
        id: "m1",
        seq: 1,
        who: ME,
        isSelf: true,
        ledger: { ...ours("aaa111"), gone },
      }),
    ]).pets;

  it("is travelling between the send answering and the ledger arriving", () => {
    // The window `petBusy` cannot cover: a spawn is a `send`, and the backend's send arm neither
    // writes the local row nor emits — so the pending slot is released while `pets` still holds no
    // creature of ours. A second press there is a second SEND, and the fold absorbs the second
    // ledger whole: two arrival messages, one drawing no creature, unreachable for ever.
    expect(travelling()).toBe(true);
  });

  it("is NOT travelling with no press behind it", () => {
    expect(travelling({ receipt: null })).toBe(false);
  });

  it("hands the row back the moment the spawn is REFUSED, so the reader retries at once", () => {
    expect(travelling({ refused: true })).toBe(false);
  });

  it("is retired by our own ledger ARRIVING", () => {
    expect(travelling({ pets: ourLedgerBack(false) })).toBe(false);
  });

  it("is retired by a ledger of ours that has GONE — a re-spawn is an EDIT, not this window", () => {
    // `petPublishFor` passes `mine.messageId` for a re-spawn, so the press is an edit — the arm
    // that emits before it answers, and the one that never needed a window. Reading `gone` as
    // "not landed" left the "Bring your cat back" row permanently disabled after a despawn, with
    // no sentence anywhere.
    expect(travelling({ pets: ourLedgerBack(true) })).toBe(false);
  });

  it("is retired by a DESPAWN after a spawn, so nothing lingers on the row that brings it back", () => {
    // The same shape from the other end: spawn, echo, Remove. The receipt still names that pet and
    // there is no error, so only the landing test keeps this honest.
    const pets = ourLedgerBack(true);
    expect(pets.some((pet) => pet.owner.isSelf && pet.gone)).toBe(true);
    expect(travelling({ pets })).toBe(false);
  });

  it("belongs to the conversation the press was made IN, and to no other", () => {
    // `ConversationMenu` is mounted unkeyed, so walking to another chat re-renders the same
    // instance with a new `conversationId`: without this the row was disabled in every other
    // conversation the reader opened, with no sentence, for the life of the page.
    expect(travelling({ conversation: CHAT_B })).toBe(false);
    // And the other chat's own pets cannot rescue or condemn it either way.
    expect(travelling({ conversation: CHAT_B, pets: ourLedgerBack(false) })).toBe(false);
  });

  it("stays travelling while an echo never arrives, which is the stated trade", () => {
    // A row disabled until a reload, against a duplicate arrival message nothing can delete. It
    // carries no sentence — `petError` is the only slot that produces words — and that is noted
    // rather than papered over.
    expect(travelling({ pets: [], refused: false })).toBe(true);
  });
});

describe("publishPetLedger", () => {
  /**
   * A SOURCE SCAN, and the split is stated so nobody mistakes it for the whole assertion.
   *
   * What it pins is that the serialization rail EXISTS: a reader's ledger is one message for the
   * whole conversation, so two publishes in flight both build from the record this page holds and
   * the later edit silently drops the earlier act. The RACE itself needs two presses inside one
   * round trip, which is Task 9's e2e (the store has no unit harness — it owns a live socket, which
   * is why `publishChessLedger` has no unit test either). This is the shape three other rails in
   * this repo are pinned with (`engine-file.test.ts`, `icon-library.test.ts`, `update.test.ts`): it
   * fails loudly if the guard is deleted, renamed or keyed by anything but the conversation.
   */
  const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "store.ts"), "utf8");

  /**
   * ONE METHOD'S SOURCE, bounded by a marker the text inside it cannot itself contain.
   *
   * Every assertion below is a `toContain` or a `not.toContain` over a window, so the window IS the
   * assertion: one that overruns is satisfied by whatever follows. That has bitten this feature
   * three times — a slice running to the end of the file, an identical line in the next method
   * satisfying it, and a 400-character window in `pet-layer.test.tsx` reaching the next row's own
   * guard — so a CHARACTER COUNT is never a bound here, and neither is a marker the body could hold
   * (`this.petPendingWithout(` appears at both call sites; `private petPendingWithout(` appears once).
   *
   * A marker that has GONE is the fourth way to lose a bound and the quietest: `indexOf` answers -1
   * and `slice(start, -1)` silently runs to the end of the file. So both ends are asserted, which
   * turns a rename into a named failure.
   *
   * And the COMMENTS ARE STRIPPED AFTER SLICING, which is the fifth way and the one a correct bound
   * cannot close: every window here ends at the NEXT declaration, so it always carries that member's
   * own docstring — and this repo's house style quotes code inline in prose (`patPet`'s already names
   * `petError` and `petSlotKey`). Measured: deleting `publishPetLedger`'s `petError` write and letting
   * `patPet`'s docstring quote the line left all 25 tests green. The bound is computed on the RAW
   * source and the strip runs on the slice alone, so stripping can never shift the region.
   *
   * The line-comment regex MIRRORS `src/vendor/desksprite.test.ts`'s own `code()` — `/\/\/.*$/gm`,
   * unanchored, whose docstring states this same rule, "so no assertion can be met by prose". It was
   * `/^\s*\/\/.*$/gm` for one round, which is a THIRD and weaker spelling: anchored, it strips a
   * comment on a line of its OWN and leaves a TRAILING one, so the very mutation above re-passed with
   * the deleted write quoted after a semicolon instead of in a docstring (measured, 25 green). If the
   * two ever disagree again, the unanchored one is the answer.
   */
  function method(from: string, to: string): string {
    const start = SOURCE.indexOf(from);
    const end = SOURCE.indexOf(to, start + from.length);
    expect(start, `store.ts still declares ${from}`).toBeGreaterThan(-1);
    expect(end, `store.ts still declares ${to} after ${from}`).toBeGreaterThan(start);
    return SOURCE.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }

  const BODY = method("async publishPetLedger(", "async patPet(");

  it("refuses a second publish while one is in flight in that CONVERSATION", () => {
    expect(BODY).toContain("if (this.get().petPending[conversationId]) return false;");
  });

  it("takes the in-flight slot for every publish, act or not", () => {
    // A removal carries no act, and one racing a feed on a colleague's pet is the sharpest loss of
    // the two — so the slot must be taken whether or not there is something to draw.
    expect(BODY).toContain("[conversationId]: { pet: publish.pet, act: publish.pending ?? null }");
  });

  it("releases the slot on success as well as on failure", () => {
    const releases = BODY.split("this.petPendingWithout(conversationId)").length - 1;
    expect(releases).toBe(2);
  });

  it("reports a refused publish under the PET the press was about", () => {
    // Unpinned until the bound above existed: a feed that did not leave is invisible otherwise —
    // the act is rolled back, so the creature simply never reacted — and the sentence the reader
    // acts on is this slot's (the composer's own rule, § Sending messages).
    expect(BODY).toContain("petError: { ...this.get().petError, [key]: sendFailureMessage(e) }");
    expect(BODY).toContain("const key = petSlotKey(conversationId, publish.pet);");
  });

  /**
   * A PAT's own two rails, scanned in the same discipline and for a sharper reason.
   *
   * A pat is the ONE thing a reader with no creature of their own can do, and `reactToMessage`
   * reports a failure only into `status` and a cue — eleven pixels at the foot of a sidebar. So a
   * pat that writes no `petError` fails SILENTLY, and the surface that would have said so (the pet's
   * own trigger, which turns, and the menu, which draws the words) reads one slot: delete the write
   * and both go quiet with every other test in this repo still green.
   */
  // Bounded at the next member, and the `private` is load-bearing: both call sites spell
  // `this.petPendingWithout(`, so the bare name would have ended this window inside the method
  // above rather than after it. What is asserted below is partly an ABSENCE, which a window that
  // overran would satisfy from the neighbouring method's own words.
  const PAT = method("async patPet(", "private petPendingWithout(");

  it("reports a refused pat under the PET it was about", () => {
    expect(PAT).toContain("petError: { ...this.get().petError, [key]: sendFailureMessage(e) }");
    // Keyed by the pet the press was aimed at, which for a colleague's creature is theirs and not
    // ours — one slot per pet is the whole reason `petSlotKey` exists.
    expect(PAT).toContain("const key = petSlotKey(conversationId, pet.id);");
  });

  it("clears that pet's old sentence BEFORE it asks, and takes no in-flight slot", () => {
    // The error is dropped first, or a pat that worked would leave the previous refusal on the
    // trigger for ever. And a reaction writes no record, so it cannot lose an act to a race: taking
    // the pending slot would only make the pat refuse itself while a feed travelled.
    const asks = PAT.indexOf("this.backend.react");
    expect(asks, "patPet still asks the backend").toBeGreaterThan(-1);
    expect(PAT.slice(0, asks)).toContain("this.set({ petError: otherErrors });");
    expect(PAT).not.toContain("petPending");
  });
});
