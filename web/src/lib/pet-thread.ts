/**
 * Every pet a loaded message list holds, derived from the messages themselves.
 *
 * There is no store for a pet and there is deliberately none: the creature folds out of the
 * thread's own history, so a reload, a phone and a colleague's install all draw the same one, and
 * there is nothing to reconcile when a frame is lost. It is the property chess already has (see
 * chess-thread.ts, which this module is modelled on) with the same consequence — nothing here can
 * go stale, because there is nothing here to keep.
 *
 * **THIS MODULE KNOWS NO PET RULES.** No stat, no decay, no mood, no level: it answers whose pet is
 * whose, when each was born, and what has been done to it. What that adds up to is `petSnapshot`'s
 * answer (pet-state.ts), and the only thing imported from there is the shape of an act. That split
 * is what lets a sidebar row, a menu and a preview say a pet exists without folding fifty acts of
 * arithmetic — and it is the split chess draws between this walk and chess.js.
 *
 * **THE WALK IS COLLECT-THEN-RESOLVE**, for the reason chess's is: a ledger is EDITED in place, so
 * its message keeps the `seq` and the `compose_time` it was first posted at while its payload holds
 * everything its author has done since. Nothing about what happened can be read off message order,
 * so the acts are gathered from every ledger first and handed to the pets they NAME afterwards.
 *
 * **AN ACT REACHES ACROSS PEOPLE, and that is what makes the shape work.** Anybody may feed
 * anybody's pet, so an act names a target and lands in a ledger its own author wrote — the one
 * message Teams lets nobody else edit. So "what I did to your pet" is unforgeable without a server,
 * exactly as a chess ply is signed by whoever authored the message carrying it.
 */

import type { PetFoldAct } from "./pet-state";
import { petWireIn, type PetAct } from "./pet-wire";
import type { ChatMessage, Reaction } from "./protocol";

/**
 * The Teams reaction that IS a pat.
 *
 * One of Microsoft's own six canonical keys (see `REACTION_PICKER`), so it is a single tap in every
 * client the reader or their colleagues might be holding, and a colleague on stock Teams pats the
 * creature without knowing this app exists. A custom emoji would have been prettier and would have
 * made a pat impossible for everybody but a teams-lite reader.
 */
export const PET_PAT_KEY = "heart";

/** One pet, as the thread states it. */
export type Pet = {
  /** Six lowercase hex, minted once by its owner and kept — never an MRI (see pet-wire.ts on the
   *  colon that would destroy every pet in the conversation). */
  id: string;
  /**
   * Whose creature it is. Named by MRI, with the name kept for what a surface draws — and with
   * **`isSelf`, WITHOUT WHICH NOTHING CAN ANSWER "IS THIS MINE"**.
   *
   * The page never learns the user's own MRI (§ Push notifications: the backend resolves that
   * question and the page is told the answer), so `owner.mri` alone cannot decide who may spawn,
   * whose menu row this is, or whether a `gone` pet is drawn at all. `message.is_self` is the
   * backend's answer and it lives on the ledger message, so THIS WALK is the only place that can
   * keep it — `ChessPlayer.isSelf` exists for exactly this reason.
   */
  owner: { mri: string; name: string; isSelf: boolean };
  /** Which art it wears — a key into the bundled skins. */
  skin: string;
  /**
   * When it was born: the ledger message's OWN `compose_time`.
   *
   * **NEVER A VALUE OUT OF THE PAYLOAD, and that is load-bearing.** An edited Teams message keeps
   * the moment it was FIRST posted, so this is stamped by the service rather than claimed by a
   * client — which is what makes every act's own moment checkable against something nobody can
   * move. It is the rule the chess ACCEPT already holds, for its reason.
   */
  birth: number;
  /** Their pet has been taken away. Its record stays: acts its owner performed on OTHER pets still
   *  count, so a person who gives their creature up has not un-fed anybody else's. */
  gone: boolean;
  /** The ledger message, which is what the next act EDITS. */
  messageId: string;
  /** Every act anybody has performed on this pet, from every ledger in the thread. */
  acts: PetFoldAct[];
  /** How many people have patted it — the `count` of {@link PET_PAT_KEY} on the ledger message, and
   *  nothing else. A reaction carries no timestamp and no MRI to the page (§ WHO reacted), so this
   *  is the whole of what a pat can be: a standing term, identical on every machine. */
  pats: number;
  /**
   * Every message id this pet's record occupies — the ledger, and any later one from the same author
   * that was ignored.
   *
   * **NOTHING IN THE APP READS IT, and saying so is the point.** It is `ChessGame.absorbed`'s field,
   * and for chess it really is what the pane takes a game's messages out of the history with — but a
   * pet is absorbed by WIRE PRESENCE instead (`petWireIn` per message in `chatHistoryRows`), on purpose
   * and for a stated reason: asked of the derivation, a ledger whose record paged out is absorbed by
   * nothing and renders its raw line as a bubble. So this is what the FOLD decided, kept because five
   * tests hold the fold to it — a second ledger landing on its author's first draft whatever pet id it
   * names, and the loser of two people claiming one id — and not a list any surface consumes. An
   * earlier version of this line credited it with the pane's absorption, which is the one thing it is
   * deliberately not.
   */
  absorbed: string[];
};

/**
 * WHICH PET a piece of a page's own state belongs to.
 *
 * A conversation holds a pet per person, so a surface's slots — an act in flight, the sentence
 * about one that failed — are keyed rather than single. Chess's own `chessSlotKey`, for the reason
 * it exists: one slot for all of them drew the failure under every creature in the thread.
 */
export function petSlotKey(conversationId: string, petId: string): string {
  return `${conversationId}/${petId}`;
}

/**
 * Somebody's own pet, or undefined.
 *
 * An EMPTY mri names nobody rather than the first authorless record: a message with no author at
 * all is a recording or a thread activity, and `"" === ""` would hand a reader somebody else's
 * creature. It is the guard chess's `colorOf` carries, for its reason.
 *
 * A pet that has GONE is still returned — its record exists, and whether to draw it is the caller's
 * question.
 */
export function petOf(pets: Pet[], mri: string): Pet | undefined {
  if (!mri) return undefined;
  return pets.find((pet) => pet.owner.mri === mri);
}

/** A pet with the acts aimed at it still to come — which is the only thing the second half of the
 *  walk adds. Spelled off {@link Pet} so the two cannot drift apart, and NEVER nullable: a draft is
 *  only ever created from a ledger, and a ledger always states its author's own pet. */
type Draft = Omit<Pet, "acts">;

/**
 * The loaded history with any pet ledger the backend holds and this page has NOT loaded merged in.
 *
 * **THE DERIVATION IS COMPLETE OR IT IS DANGEROUS, and this is what makes it complete.** A pet IS its
 * messages, which is the property the whole feature rests on — but the history loads a page at a time
 * (`teams_read::DEFAULT_PAGE_SIZE`, 40) and every act EDITS its author's one ledger message, so that
 * message keeps the `seq` and the `compose_time` it was FIRST posted at. Forty messages later — a
 * couple of days in a real chat — the record has paged out while the creature is very much alive, and
 * the page then folded no pet of the reader's own: none drawn, no menu to reach it with, Feed/Play/Nap
 * replaced by "Feeding and playing take a companion of your own", and the conversation's own menu
 * OFFERING A SPAWN. That press SENDS: a second arrival message everybody in the thread reads, whose
 * record `petsInThread`'s one-ledger-per-author rule absorbs and ignores WHOLE — so the creature they
 * had just taken vanished and nothing in the feature could ever reach it again.
 *
 * Chess has the same paging exposure and it is COSMETIC there (a board whose root paged out renders as
 * a bubble — see message-pane.tsx), which is why its own whole-history read exists for a SCORE. Here it
 * is the rail, so it feeds the derivation itself.
 *
 * **IT IS A MERGE AND NOT A REPLACEMENT**, because the archive is a snapshot: the live feed writes into
 * `messages`, so an act that landed a moment ago is in the loaded history and stale in here. Anything
 * already loaded therefore wins by id, and only what is missing is added — the reading
 * `chessSeriesGames` takes of the same pair.
 *
 * **THE COMMON CASE RETURNS THE SAME ARRAY**, which is not tidiness: this feeds a `useMemo` that feeds
 * the pet fold, the layer and every publish, and a fresh array on every render would re-fold the whole
 * history on every scroll that mounts a row.
 */
export function withPetArchive(
  messages: ChatMessage[],
  archive: readonly ChatMessage[] | undefined,
): ChatMessage[] {
  if (!archive || archive.length === 0) return messages;
  const loaded = new Set(messages.map((message) => message.id));
  const missing = archive.filter((message) => !loaded.has(message.id));
  if (missing.length === 0) return messages;
  // Sorted rather than prepended, even though what paged out is older by construction: the order is
  // what `petsInThread` reads "the first ledger this author wrote" off, and a wrong one would hand the
  // record — and with it the message every later act EDITS — to the wrong message.
  return [...missing, ...messages].sort((a, b) => a.seq - b.seq);
}

/**
 * The pets this message list holds, in the order their ledgers first appeared.
 *
 * ONE PASS: every ledger is collected into a draft keyed by the pet it names, and every act into
 * one list, because an act may name a pet whose own message comes later in the thread (or never).
 * The order is the Map's own insertion order, so a pet that has been in the conversation for weeks
 * stays above one somebody spawned this morning however often either message is edited.
 */
export function petsInThread(messages: ChatMessage[]): Pet[] {
  const drafts = new Map<string, Draft>();
  /** The draft each author's FIRST ledger landed in — which is where a second one is absorbed. */
  const landedIn = new Map<string, Draft>();
  const acts: PetAct[] = [];

  for (const message of messages) {
    const ledger = petWireIn(message);
    if (!ledger) continue;

    // ONE LEDGER PER AUTHOR, the first they wrote. A second is absorbed and ignored WHOLE, acts
    // included — the record is what every reader has already started folding, and counting a second
    // one's acts would double everything both of them state. It is absorbed onto the draft their
    // FIRST one landed in, whatever pet id this one names: every pet message must belong to some
    // pet's record, or the reader is shown the raw wire line in their history.
    const mri = message.sender_mri ?? "";
    const landed = landedIn.get(mri);
    if (landed) {
      landed.absorbed.push(message.id);
      continue;
    }

    const existing = drafts.get(ledger.pet);
    if (existing) {
      // Somebody ELSE already claimed this pet id. The first claim keeps the record, this message
      // is absorbed onto it, and this author's own acts still count — they are a person in the
      // conversation with a first ledger of their own, whoever owns the creature it names.
      existing.absorbed.push(message.id);
      landedIn.set(mri, existing);
    } else {
      const draft: Draft = {
        id: ledger.pet,
        owner: { mri, name: message.sender, isSelf: message.is_self === true },
        skin: ledger.skin,
        gone: ledger.gone,
        // THE MESSAGE's own moment, never the payload's — see `Pet.birth`.
        birth: message.compose_time,
        messageId: message.id,
        pats: patsOn(message.reactions),
        absorbed: [message.id],
      };
      drafts.set(ledger.pet, draft);
      landedIn.set(mri, draft);
    }

    acts.push(...ledger.acts);
  }

  return [...drafts.values()].map((draft) => ({
    ...draft,
    // Every ledger's acts, filtered to this pet — and an act naming a pet no ledger in the thread
    // declared is dropped with the draft that never existed for it. An act dated before the birth
    // or after now is LEFT IN: `petSnapshot` is the one place that refuses one, and two refusal
    // sites are two chances to disagree about which acts count.
    acts: acts
      .filter((act) => act.target === draft.id)
      .map(({ at, kind }): PetFoldAct => ({ at, kind })),
  }));
}

/** How many people have patted the creature. A key nobody has used is no pats, and a backend too
 *  old to carry reactions at all is the same answer rather than a guess. */
function patsOn(reactions: Reaction[] | undefined): number {
  return reactions?.find((reaction) => reaction.key === PET_PAT_KEY)?.count ?? 0;
}
