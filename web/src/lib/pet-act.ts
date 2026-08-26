/**
 * WHAT THE READER'S NEXT PRESS PUBLISHES — one pure function, for every control in the feature.
 *
 * A ledger is a STATE (see pet-wire.ts): the message is rewritten WHOLE on every act, so spawning a
 * creature, feeding one, playing with one, putting one down for a nap, changing its art and giving it
 * up are ONE operation with a different argument. Deciding that here rather than in the layer, the
 * menu, the settings pane and the bubble is what keeps four surfaces from disagreeing about what a
 * feed writes — the split chess-act.ts already draws, and every reason in its own header applies here
 * unchanged.
 *
 * **AN ACT APPENDS TO THE RECORD THE MESSAGE ALREADY STATES, and that is why this function is handed
 * the HISTORY as well as the pets.** The fold answers whose pet is whose and what has been done TO
 * each one, and in doing so it deliberately forgets WHO did it — `PetFoldAct` carries no actor — so a
 * `Pet` cannot say what its owner has done to their friends' creatures. Chess has no such gap
 * (`ChessGame.ledgers[color]` hands the raw ledger back), so this reads our own ledger out of its own
 * message instead. Without it every act would publish a record holding ONE act, and everything its
 * author had ever done would be dropped from the wire — for every reader, on the next feed.
 *
 * **A PAT IS NOT A PRESS HERE.** It is a Teams REACTION on the pet's own message (`PET_PAT_KEY` in
 * pet-thread.ts), which costs one gate less than an edit and TOGGLES, so it repeats without a new
 * record: the layer calls `react` directly and nothing about it reaches this module. It is also the
 * one way in for a reader who has no creature of their own — see the refusal that says so below.
 *
 * **WHICH PET IS OURS IS ANSWERED BY `owner.isSelf` AND BY NOTHING ELSE.** The page never learns the
 * user's own MRI — the backend resolves that question and hands the page the answer (§ Push
 * notifications) — which is exactly why `Pet.owner.isSelf` exists, off the ledger message's own
 * `is_self`, and why nothing here takes an identity as an argument. An MRI-keyed lookup would match
 * nobody: every act would be refused and every spawn would SEND a SECOND ledger, which the fold
 * absorbs and ignores whole. It is the reading chess makes for `ourColor`, for its reason.
 *
 * **RETURNING NULL IS A GUARD AGAINST A STALE PRESS, never how a surface decides what to draw.** A
 * control that cannot act must not be drawn at all; what this catches is the press that was legal
 * when the menu opened and is not by the time it lands — the pet's owner took it away, the reader
 * changed to the skin they already wear, a second press arrived behind the first. The DECIDING has
 * to live somewhere, so the one press whose control is not on a creature already drawn — the SPAWN,
 * which is offered by the conversation's own menu — has {@link petSpawnIsOffered} beside it here.
 */

import type { PetFoldAct } from "./pet-state";
import { petSkin } from "./pet-skin";
import type { Pet } from "./pet-thread";
import {
  newPetId,
  newPetLedger,
  petWireIn,
  withPetAct,
  PET_SKIN,
  type PetActKind,
  type PetLedger,
} from "./pet-wire";
import type { ChatMessage, Conversation } from "./protocol";

/**
 * Whether a reader may be OFFERED a creature here at all — the whole of what the SPAWN row in the
 * conversation's own menu is drawn under (components/conversation-menu.tsx).
 *
 * Every one of the four refusals is a rule some other surface in this app already holds, and none of
 * them is a refusal this row REPORTS: a control that cannot do the thing it names is worse than no
 * control, which is the argument the call row and the chess rows are both drawn under.
 *
 *   - **A CHANNEL is refused, and the signal is that it is not in the conversation list at all.** Its
 *     history is drawn as THREADS while the layer walks a chat's own, so where a creature paces one
 *     of those is a different surface's question — the limit § A SEALED chat states for a channel,
 *     for its reason. It is the surer signal too, and the one the call and chess rows already use.
 *   - **NOTES is OFFERED**, which is the deliberate opposite of the channel: a solo thread has
 *     nobody to play with, and a companion is the one thing there that needs nobody — the argument
 *     § Playing STOCKFISH makes for offering the computer in the chat with oneself.
 *   - **A reader whose own creature is HERE is offered none**, because `petPublishFor` refuses that
 *     press. A pet that has GONE is offered, and that is half the point of this row: Remove is
 *     otherwise a one-way door, and the spawn branch RE-SPAWNS the record it finds rather than
 *     minting a stranger in its skin.
 *   - **A window that would DRAW no creature offers none**, on either of the layer's own two
 *     refusals — Settings › Companions, and a reader who asked for less motion. A spawn posts a
 *     message everybody in the thread sees; one whose own presser cannot see what it bought is a
 *     message posted for nothing.
 */
export function petSpawnIsOffered(args: {
  /** The open conversation, or undefined — which is what a CHANNEL is on this surface. */
  conversation: Conversation | undefined;
  /** Every pet the thread holds, as this window drew them (`petsInThread`). */
  pets: Pet[];
  /** Settings › Companions: whether this window draws them at all. */
  shown: boolean;
  /** The reader asked for less motion, so the layer draws nothing whatever the switch says. */
  reduce: boolean;
}): boolean {
  if (!args.conversation || !args.shown || args.reduce) return false;
  // `owner.isSelf`, and NEVER an mri: the page is never handed the user's own (§ Push
  // notifications), which is exactly the reason a folded pet carries that flag.
  const mine = args.pets.find((pet) => pet.owner.isSelf);
  return !mine || mine.gone;
}

/**
 * WHAT A SPAWN PRESS LEFT BEHIND — the conversation it was made in, and the pet it was about.
 *
 * Both halves are load-bearing. The PET is the id a refusal is keyed by (`petSlotKey`), and for a
 * first spawn it is freshly minted, so nothing else on the page holds it. The CONVERSATION is what
 * makes it a receipt rather than a page-wide flag: `ConversationMenu` is mounted unkeyed, so walking
 * to another chat re-renders the SAME instance with a new `conversationId` — and a receipt with no
 * conversation on it then reads as "a spawn is travelling" in every other conversation the reader
 * opens, for the life of the page.
 */
export type PetSpawnReceipt = { conversation: string; pet: string } | null;

/**
 * Whether a spawn of ours has LEFT and its ledger has not reached this page yet — the second window
 * the spawn row must stay out for, on top of a publish in flight.
 *
 * **IT EXISTS BECAUSE A SPAWN IS THE ONE PUBLISH HERE THAT IS A `send`.** The backend's `edit` arm
 * writes the local row and emits `message` BEFORE it answers, so an act is on the page by the time
 * the promise resolves; the `send` arm does neither — it answers `{sent: true}` and the message
 * arrives only on the trouter echo. So between the answer and the echo the pending slot is already
 * released while `pets` still holds no creature of ours: the row would be drawn, enabled and saying
 * "Take a cat" for 150 ms against the mock, a round trip against the tenant, and unboundedly while
 * the live feed is reconnecting. A second press there is a second SEND, because `petPublishFor` finds
 * no `mine` and mints a fresh id — and the fold's one-ledger-per-author rule absorbs that record
 * WHOLE, so the thread keeps two visible arrival messages, one drawing no creature, with `despawn`
 * editing the first: nothing in this feature can ever reach the other again. Nothing visible happens
 * on the press either (a spawn carries no optimistic act), which is exactly the "press it again
 * because nothing happened" pattern every duplicate that ever reached a colleague came out of.
 *
 * **THE LANDING TEST IS `owner.isSelf` ALONE, and `gone` MUST NOT be part of it.** A self record
 * exists iff the next press would be an EDIT (`petPublishFor` passes `mine.messageId`), which is the
 * arm that needs no window at all — so "a ledger of ours is on this page" is exactly the right
 * disarm. Adding `&& !pet.gone` was measured to re-arm the gate for good on the Remove path: after
 * spawn → echo → Remove the row is drawn as "Bring your cat back", no error exists, and a landing
 * test that ignores a `gone` record never sees one — a permanently disabled row, with no sentence.
 *
 * **IT NEEDS NO RESET, and that is the whole point of the shape.** The receipt is retired by the
 * conversation it names and by any ledger of ours arriving; nothing has to remember to clear it, so
 * there is no path on which a stale one can outlive its window.
 *
 * What it deliberately does NOT cover, both stated rather than fixed: an echo that NEVER arrives
 * leaves the row disabled until a reload — the right trade against a duplicate nothing can delete,
 * and it carries no sentence, because `petError` is the only slot that produces words; and an answer
 * that was merely LOST (a timeout, a reset connection — `send` runs under `auth_only()` and
 * deliberately does not retry) reports a refusal, which enables the row, and the retry mints a fresh
 * id. That second one is not this gate's to close and never was: Teams publishes no idempotency key
 * on a send, so nothing in this feature can tell a lost answer from a refused one.
 */
export function petSpawnIsTravelling(args: {
  /** What the last spawn press left behind, in whichever conversation it was made. */
  receipt: PetSpawnReceipt;
  /** The conversation the row is being drawn in NOW. */
  conversation: string;
  /** Every pet the thread holds, as this window drew them (`petsInThread`). */
  pets: Pet[];
  /** A refusal has been reported for that press, which hands the reader their retry back. */
  refused: boolean;
}): boolean {
  if (!args.receipt || args.receipt.conversation !== args.conversation) return false;
  if (args.refused) return false;
  return !args.pets.some((pet) => pet.owner.isSelf);
}

/**
 * One thing a reader can press.
 *
 * The three acts are spelled `PetActKind` rather than as their own union, because a press and a wire
 * token are the same vocabulary and two spellings of it drift the moment one gains a fourth act.
 */
export type PetPress =
  /** Take a creature, in the art the picker offered. */
  | { kind: "spawn"; skin: string }
  /** Do something to a pet — ANY pet the thread holds, which is the whole promise of the feature. */
  | { kind: PetActKind; pet: string }
  /** Send our own creature home. */
  | { kind: "despawn" }
  /** Change our own creature's art. */
  | { kind: "skin"; skin: string };

/** What to publish: our own record whole, and the message it rewrites. */
export type PetPublish = {
  /**
   * WHICH PET THE PRESS WAS ABOUT — the one the reader pressed on, which is not always the one our
   * ledger names: feeding a colleague's creature edits OUR record and belongs, for the reader, to
   * THEIRS. It is the slot a pending act and a refusal are keyed by (`petSlotKey`), so the sentence
   * about a feed that did not leave is drawn under the pet it was aimed at and under no other.
   */
  pet: string;
  /** Our own whole record, as the message is about to state it. */
  ledger: PetLedger;
  /**
   * Our own ledger message, ABSENT the first time — which is what makes the first act a SEND and
   * every later one an EDIT. It comes from the DERIVATION and never from anything a store remembers,
   * so a page that reloaded, a second window and a phone all edit the same message.
   */
  messageId?: string;
  /** What the words above the line call the creature — its ART's own label, since a pet carries no
   *  name of its own on the wire (see `petMessageWords`). */
  label: string;
  /** The act this publish adds, when it adds one, for the layer to fold before the message comes
   *  back. */
  pending?: PetFoldAct;
};

/**
 * The publish one press asks for, or null when the thread does not admit it.
 *
 * It takes no identity: who the reader is comes from the pets themselves (`owner.isSelf`, see the
 * header), and nothing in a ledger names its author — Teams already says who wrote the message, and
 * the words above the line name the CREATURE rather than its owner.
 */
export function petPublishFor(args: {
  press: PetPress;
  /** Every pet the thread holds, as this window drew them (`petsInThread`). */
  pets: Pet[];
  /** The same history those pets were folded out of, read for the ONE thing the fold throws away:
   *  our own ledger's own list of acts. */
  messages: ChatMessage[];
  now: number;
}): PetPublish | null {
  const { press, pets } = args;
  const mine = pets.find((pet) => pet.owner.isSelf);
  const base = mine ? ourLedger(args.messages, mine.messageId) : null;

  if (press.kind === "spawn") {
    // A ledger is a STATE, so "have I got one already?" is asked of the RECORD rather than of what
    // the reader last pressed: their message still says it spawned a pet on their fortieth act.
    if (mine && !mine.gone) return null;
    // We hold a record we cannot read, so there is nothing to rewrite — and SENDING instead would
    // post a SECOND ledger, which the fold absorbs and ignores whole: a creature nobody can see,
    // for ever. It means the caller handed over two different histories, which is fail-closed here.
    if (mine && !base) return null;
    if (!skinCanTravel(press.skin)) return null;
    // A pet given up and taken back is THE SAME CREATURE: its id was minted once and is kept, and
    // its owner's acts stay, because what they did to their friends' pets did not un-happen.
    const ledger = base
      ? { ...base, skin: press.skin, gone: false }
      : newPetLedger(newPetId(), press.skin);
    return { pet: ledger.pet, ledger, messageId: mine?.messageId, label: labelOf(ledger) };
  }

  // Everything else REWRITES a record we already have. A reader with no creature of their own can
  // therefore feed nobody — and that is the wire's own consequence rather than a rule invented here:
  // an act is a line in its author's OWN ledger, and a ledger must name a pet (`— pet <6 hex>`), so
  // writing one for somebody who never spawned would either mint a creature they did not ask for or
  // announce the death of one that was never born. What such a reader HAS is the pat, which is a
  // reaction and needs no record at all.
  if (!mine || !base) return null;

  switch (press.kind) {
    case "feed":
    case "play":
    case "nap": {
      const target = pets.find((pet) => pet.id === press.pet);
      // A pet the thread does not hold, and one that has gone home, are the same stale press: the
      // menu was open while its owner took the creature away. An act aimed at nothing is a line in
      // the record about a pet no reader can find.
      if (!target || target.gone) return null;
      const ledger = withPetAct(base, { at: args.now, kind: press.kind, target: target.id });
      return {
        pet: target.id,
        ledger,
        messageId: mine.messageId,
        label: labelOf(ledger),
        pending: { at: args.now, kind: press.kind },
      };
    }
    case "despawn": {
      // Nothing to send home. Our own record says the creature has already gone.
      if (mine.gone) return null;
      const ledger: PetLedger = { ...base, gone: true };
      return { pet: ledger.pet, ledger, messageId: mine.messageId, label: labelOf(ledger) };
    }
    case "skin": {
      // There is no art to change on a creature that is not here.
      if (mine.gone) return null;
      if (!skinCanTravel(press.skin)) return null;
      // A press that would write the same bytes is a press that says nothing: `serializePetLedger`
      // is deterministic, so this edit would reach everybody in the thread and change no reader's
      // creature. An outward write that changes nothing is one not to make.
      if (base.skin === press.skin) return null;
      const ledger: PetLedger = { ...base, skin: press.skin };
      return { pet: ledger.pet, ledger, messageId: mine.messageId, label: labelOf(ledger) };
    }
  }
}

/** Our own record, as the message the derivation named currently states it — or null when that message
 *  is not among the ones handed over, which is the caller passing pets and a history that disagree. A
 *  message that is no longer a wire at all cannot reach here: the fold would have built no pet for it,
 *  so there would be nothing naming it. */
function ourLedger(messages: ChatMessage[], messageId: string): PetLedger | null {
  const message = messages.find((it) => it.id === messageId);
  return message ? petWireIn(message) : null;
}

/** What the words call the creature: its ART's own label, and the default art's label for a record
 *  naming a skin this build does not hold (`petSkin` never throws — see pet-skin.ts). */
function labelOf(ledger: PetLedger): string {
  return petSkin(ledger.skin).label;
}

/**
 * Whether a skin name can be a wire token at all, tested against the wire's OWN regex rather than a
 * copy of its charset — the reason `PET_SKIN` is exported, and the rule pet-skin.ts's validator holds.
 *
 * **WHAT IT REALLY GUARDS IS A COLON.** A skin name is a string a caller hands over, and a colon in it
 * reaches the ledger line as `s.a:b`. One colon is HALF of a code span, and the backend substitutes an
 * `<img>` for `:name:` on the way out (see pet-wire.ts): the day anything puts a second colon in the
 * same text — a token a later build adds, a word above the line — the pair breaks the signature and
 * takes every pet in the conversation with it, for everybody, for good, with nothing left to repair it
 * with. So the rule is that NO colon ever reaches the line, and not that a pair is refused. What the
 * regex also catches is quieter and worth naming: an upper-case letter, a space or an empty name makes
 * a token the parser reads as one it does not know and IGNORES, so the creature would draw in the
 * default art with nothing anywhere saying why.
 */
function skinCanTravel(skin: string): boolean {
  return PET_SKIN.test(`s.${skin}`);
}
