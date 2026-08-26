/**
 * THE LINE A PET MESSAGE SIGNS ITSELF WITH.
 *
 * A companion in a conversation is carried by ordinary Teams messages, exactly as a game of chess
 * is (see chess-wire.ts, which this module is modelled on line for line): ONE MESSAGE PER PERSON,
 * edited in place, whose last block is a versioned line read from the WORDS rather than from
 * markup. Nothing is stored on this machine, so a reload, a phone and a colleague's install all
 * fold the same creature out of the same history.
 *
 * A ledger says two things about its author: WHICH PET IS THEIRS, and WHAT THEY HAVE DONE to pets
 * in this conversation — their own and their friends'. Those two jobs live in one message because
 * of who is allowed to write: Teams lets a person edit only their own message, so a record of
 * "what I did" cannot be forged by anybody else. That is the same reason chess keeps a ledger per
 * PLAYER rather than one shared record per game, and it is what makes "anybody may play with
 * anybody's pet" safe with no server in the middle.
 *
 * **A PET IS NAMED BY A 6-HEX ID, NEVER BY AN MRI, AND THAT IS NOT A STYLE CHOICE.** An act
 * reaches across people, so it has to name whose pet it touched — and an MRI is
 * `8:orgid:bea5de00-…`. See the colon rule on `PET_ACT` below: an identity in this line would
 * destroy every pet in the conversation the first time somebody's emoji pack held the right name.
 *
 * **WHAT IS NOT HERE, deliberately.** No stat, no mood, no level, no position. Decay is a pure
 * function of elapsed time (pet-state.ts), so two machines holding the same acts hold the same
 * creature and a number sent over the wire would only be a second answer to a question both sides
 * can already answer. Position is each window's own business, because two readers have two window
 * sizes. What travels is an ACT, at human cadence — a few an hour rather than one a frame.
 */

import type { ChatMessage } from "./protocol";
import { withoutSignedLine } from "./wire-line";

/** What somebody can do to a pet through its ledger. A PAT is deliberately not here: it is a Teams
 *  REACTION on the pet's own message, which costs one gate less than an edit (a reaction frame
 *  carries an empty `content`, so `insert_message` returns false and the push path is never
 *  reached at all) and which TOGGLES, so it repeats without a new record. */
export type PetActKind = "feed" | "play" | "nap";

/** One act: when, what, and whose pet. The moment is the ACTOR's own clock, which is why
 *  `petSnapshot` (pet-state.ts) refuses one dated before the pet was born or in the future — and
 *  it is the ONE place that does: `pet-thread.ts` deliberately keeps such an act in the pet's list,
 *  because two refusal sites are two chances to disagree about which acts count. */
export type PetAct = { at: number; kind: PetActKind; target: string };

/** One person's whole record, as their message currently states it. */
export type PetLedger = {
  /** The author's own pet. Minted once and kept, so a pet removed and spawned again is the same
   *  creature rather than a stranger with the same skin. */
  pet: string;
  /** Which art it wears (a key into the bundled skins — see pet-skin.ts). */
  skin: string;
  /** Their pet has been taken away. The acts stay: what they did to other pets still counts. */
  gone: boolean;
  /** Everything they have done, oldest first. Bounded — see `PET_ACTS_KEPT`. */
  acts: PetAct[];
};

/** The words a pet line opens with — the parameter `withoutSignedLine` finds it by. */
const PET_MARKER = "— pet ";

/** One trailing `<p><em>…</em></p>`, allowing the whitespace Teams stores.
 *
 *  **DELIBERATELY THE SAME CONSTANT chess-wire.ts AND agent-message.ts USE.** Three features now
 *  sign a body this way, and a fourth spelling of "the last italic block" would drift from the
 *  other three at the first message Teams happened to store differently. */
const SIGNATURE = /<p>\s*<em>\s*([^<]*?)\s*<\/em>\s*<\/p>\s*$/i;

/**
 * The signature a pet message carries.
 *
 * `pet` is a literal keyword followed by a fixed-shape id, and that shape is what keeps three
 * features apart inside ONE envelope: the agent's own signer is a single name token with no space
 * in it, and a chess line spells `chess` where this spells `pet`. A colleague's prose ending in
 * italics can match none of the three.
 */
const PET_LINE = /^—\s*pet\s+([0-9a-f]{6})\s+(.+?),\s*via teams-lite$/i;

/** The version the payload opens with, checked as a LITERAL prefix. A line this build cannot read
 *  leaves the message an ordinary message rather than a pet with a hole in it — the rule an
 *  unknown chess kind already follows, so a ledger from a NEWER build draws the words it carries
 *  and no creature. */
const LEDGER_VERSION = "v1";

/**
 * An ACT token: `<epoch ms>.<kind>.<target pet>` — `1756060012345.f.7f3a1c`.
 *
 * **THE SEPARATOR IS A FULL STOP AND MAY NEVER BE A COLON.** The backend substitutes custom emoji
 * into every outbound body, on a send and on an edit alike, and `custom_emoji::code_spans_in_text`
 * matches `:name:` ANYWHERE in the text — no whitespace needed in front of it — for any lowercase
 * name in the user's own pack. An act written `1756060012345:f:7f3a1c` therefore holds the code
 * span `:f:`, and a pack with an emoji of that name (packs grow on their own: a colleague's
 * reaction imports one) would replace it with an `<img …>`. That breaks `SIGNATURE`'s own
 * `[^<]*?`, and every pet in the conversation becomes unreadable — for everybody, for good, with
 * nothing left to repair it with, because the app can no longer see a ledger to edit.
 * `serializes_no_colon_with_everything_set` pins exactly that.
 *
 * **IT OPENS WITH A DIGIT, and that is what chooses the failure mode.** A NAMED token this build
 * does not know is ignored, so a newer build's ledger still folds; a token starting with a digit
 * that does not parse refuses the WHOLE record, so a corrupt act is never half-applied. The two
 * classes have to be syntactically unmistakable for that to work, which is why the moment leads
 * rather than the kind.
 *
 * Every field is bounded: an epoch is 1–15 digits, a target is exactly six hex. An unbounded
 * `\d+` is how four hundred characters of garbage becomes a number nothing can reason about.
 *
 * **EXPORTED for the reason `PET_SKIN` is.** `web/mock/server.ts` re-spells this wire on purpose —
 * it stands for another machine — and the one thing that must not drift is the PATTERN itself:
 * accepting the tokens this build writes is not the same as agreeing on their shape, so a mock
 * regex loosened to `\d+` would pass a test that only fed it real bytes. `mock-pet-wire.test.ts`
 * asserts the mock holds this source, which makes a divergence fail rather than be invisible.
 */
export const PET_ACT = /^(\d{1,15})\.([fpz])\.([0-9a-f]{6})$/;

/** The skin token, `s.<id>`. The charset is a skin key's own, and it holds no full stop, so the
 *  token cannot be mistaken for an act.
 *
 *  **EXPORTED because a skin's NAME is a wire token and nothing else.** `validatePetSkin`
 *  (pet-skin.ts) refuses a skin this cannot carry, so that a name is caught where it is authored
 *  rather than discovered as a ledger that will not parse — and it tests THIS regex rather than a
 *  copy of the charset, because two spellings of one charset drift the moment one is loosened. */
export const PET_SKIN = /^s\.([a-z0-9][a-z0-9-]{0,23})$/;

/** The wire spelling of each act, and the only place the two vocabularies meet. One letter,
 *  because a sixty-act line is one message and `feed` costs three characters more each time. */
const ACT_TO_WIRE: Record<PetActKind, string> = { feed: "f", play: "p", nap: "z" };
const WIRE_TO_ACT: Record<string, PetActKind> = { f: "feed", p: "play", z: "nap" };

/**
 * How many of an author's own acts a ledger keeps.
 *
 * **THE BOUND IS SAFE RATHER THAN SLOPPY**, and the reason is the stats' own arithmetic: every one
 * is clamped to 0…100 and decays to its floor in 33–50 hours from full, or 100 for affection at its
 * single point an hour (pet-state.ts) — all of them inside a week's 168, so an act a week
 * old moves the fold by nothing a reader could see. Without a bound, a message edited for months
 * grows without limit — and a Teams message has a real ceiling (102 400 bytes, measured by
 * `examples/sealed_message_probe.rs`).
 */
export const PET_ACTS_KEPT = 30;

/** How many of the author's own acts the WORDS count. The line below them holds every one, so this
 *  is only what a stock Teams client and a sidebar preview show. */
const WORDS_ACTS = 3;

/** A pet id: six lowercase hex characters. Short enough to read inside a sentence, wide enough
 *  (16.7M) that two pets in one conversation cannot collide in practice. Chess's own id, and for
 *  its reasons. */
export function newPetId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An empty ledger — what a spawn starts from. */
export function newPetLedger(pet: string, skin: string): PetLedger {
  return { pet, skin, gone: false, acts: [] };
}

/**
 * The payload a ledger becomes, after the version token.
 *
 * **IT IS DETERMINISTIC BY CONSTRUCTION**: one fixed token order, and the acts sorted HERE rather
 * than trusted from the caller. For a record that is rewritten on every act that is not tidiness —
 * it is what makes two builds holding the same state emit the same bytes, what makes a no-op edit
 * really a no-op, and what lets a test assert the exact line.
 */
export function serializePetLedger(ledger: PetLedger): string {
  const parts: string[] = [LEDGER_VERSION];
  if (ledger.skin) parts.push(`s.${ledger.skin}`);
  if (ledger.gone) parts.push("gone");
  for (const act of sortedActs(ledger.acts)) {
    parts.push(`${act.at}.${ACT_TO_WIRE[act.kind]}.${act.target}`);
  }
  return parts.join(" ");
}

/** Oldest first, and stable on the kind then the target so two acts in the same millisecond order
 *  the same way on both machines. */
function sortedActs(acts: PetAct[]): PetAct[] {
  return [...acts].sort(
    (a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target),
  );
}

/** Keep the newest `PET_ACTS_KEPT`, oldest first — what an act appends through. */
export function withPetAct(ledger: PetLedger, act: PetAct): PetLedger {
  const acts = sortedActs([...ledger.acts, act]);
  return { ...ledger, acts: acts.slice(Math.max(0, acts.length - PET_ACTS_KEPT)) };
}

/**
 * Read a payload back, or null for a record this build refuses.
 *
 * The two refusal rules are deliberately OPPOSITE, and the digit prefix is what tells the classes
 * apart (see `PET_ACT`): an unknown NAMED token is skipped, an unparseable DIGIT-led token refuses
 * the whole ledger.
 */
export function parsePetLedger(pet: string, payload: string): PetLedger | null {
  const rest = payload === LEDGER_VERSION ? "" : payload.slice(LEDGER_VERSION.length + 1);
  if (payload !== LEDGER_VERSION && !payload.startsWith(`${LEDGER_VERSION} `)) return null;

  const ledger: PetLedger = { pet, skin: "", gone: false, acts: [] };
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    if (/^\d/.test(token)) {
      const act = PET_ACT.exec(token);
      // Fail-closed: an ordered token this build cannot read means the record is not the record
      // this build thinks it is, and half a creature is worse than none.
      if (!act) return null;
      const kind = WIRE_TO_ACT[(act[2] ?? "").toLowerCase()];
      if (!kind) return null;
      ledger.acts.push({ at: Number(act[1]), kind, target: (act[3] ?? "").toLowerCase() });
      continue;
    }
    if (token === "gone") {
      ledger.gone = true;
      continue;
    }
    const skin = PET_SKIN.exec(token);
    if (skin) {
      ledger.skin = skin[1] ?? "";
      continue;
    }
    // Anything else is a token from a build that knows more than this one. Ignored on purpose, so
    // a newer build's ledger still folds into a creature here.
  }
  ledger.acts = sortedActs(ledger.acts);
  return ledger;
}

/** The ledger one message carries, or null when it is not a pet message at all. */
export function petWireIn(message: ChatMessage): PetLedger | null {
  // A deleted message's placeholder IS its body: a pet must not absorb a row the reader is being
  // shown a tombstone for. The first line of `agentAuthorship` and of `chessWireIn`, for one reason.
  if (message.deleted === true) return null;
  const signature = SIGNATURE.exec(message.content ?? "");
  if (!signature) return null;
  const line = PET_LINE.exec(signature[1] ?? "");
  if (!line) return null;
  return parsePetLedger((line[1] ?? "").toLowerCase(), (line[2] ?? "").trim());
}

/** The line itself — the one place it is spelled for a client. */
export function petLedgerLine(ledger: PetLedger): string {
  return `— pet ${ledger.pet} ${serializePetLedger(ledger)}, via teams-lite`;
}

/**
 * The words above the line.
 *
 * **THEY STATE THE STATE, never the event**, and they are regenerated from the same ledger on every
 * act. A message whose words said "I fed the cat" while its line held forty acts would lie to every
 * client but this one — and a colleague on stock Teams sees exactly these words, rewritten, so they
 * are the most useful thing this message can say.
 */
export function petMessageWords(ledger: PetLedger, label: string): string {
  if (ledger.gone) return `${label} has gone home.`;
  const counts: string[] = [];
  for (const kind of ["feed", "play", "nap"] as PetActKind[]) {
    const n = ledger.acts.filter((a) => a.kind === kind).length;
    if (n > 0) counts.push(`${{ feed: "fed", play: "played", nap: "napped" }[kind]} ${n}`);
  }
  const shown = counts.slice(0, WORDS_ACTS);
  return shown.length > 0 ? `${label} · ${shown.join(" · ")}` : `${label} is here.`;
}

/** The body a send or an edit carries. Two blocks rather than one styled span, because every strip
 *  site works over FLATTENED text (`plain_text_from_html` keeps one newline per block) and the
 *  marker has to be findable with the tags gone. */
export function petMessageHtml(ledger: PetLedger, label: string): string {
  return `<p>${escapeHtml(petMessageWords(ledger, label))}</p><p><em>${escapeHtml(petLedgerLine(ledger))}</em></p>`;
}

/** The plain-text twin, for a client that shows no HTML — and what the edit RPC sends beside the
 *  markup, since an edit that carried only text would have the line ESCAPED and the record lost. */
export function petMessageText(ledger: PetLedger, label: string): string {
  return `${petMessageWords(ledger, label)}\n${petLedgerLine(ledger)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


/**
 * Take the line off a preview.
 *
 * **IT RE-VALIDATES THE TAIL BEFORE CUTTING**, never just cuts at the marker: a naive
 * `split(marker)[0]` truncates a real message that happens to contain the words "— pet". So the
 * LAST occurrence is found and then the whole line is re-matched, which is what keeps an agent's
 * own `— claude, via teams-lite` and a colleague's prose intact — or, where the preview CUT the
 * line short, re-matches what survived of it.
 *
 * **The rule itself lives in `wire-line.ts`, in ONE spelling for both features that sign a body
 * this way**, and this function is that rule pointed at this feature's own marker and grammar. It
 * was a near-copy of chess's per-feature regexes, and the copies had already drifted: the cut rules
 * were fixed in Rust and on one of the two pages, leaving the other showing a wire dump. Its Rust
 * twin is `push_policy::without_wire_line`, parameterised the same way and for the same reason.
 *
 * **WHERE a pet's own body crosses the preview's 120-character ceiling** — the arithmetic that makes
 * the cut branch necessary — is measured on {@link PET_ACTS_KEPT}'s own doc and in AGENTS.md: three
 * acts of MIXED kind for every shipped skin, and three FEEDS for one of the three.
 */
export function stripPetLine(text: string): string {
  return withoutSignedLine(text, PET_MARKER, PET_LINE);
}
