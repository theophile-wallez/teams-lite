// The Teams reaction vocabulary: emotion keys <-> emoji <-> Apple emoji images.
//
// A reaction on the wire is not an emoji, it is one of Microsoft's "emotion"
// keys — `like`, `fire`, `rofl`, `1f389_partypopper`, `yes-tone2` — and only
// their catalog says which key means which emoji. That catalog lives in
// `teams-emoji-catalog.ts`, generated from Microsoft's published reference (see
// scripts/generate-teams-emoji.ts); everything here is the pure logic around it,
// so it is testable without a DOM and shared by every reaction surface.
//
// Two directions matter:
//   - inbound: a key arrives on a message and must be shown (`reactionEmoji`);
//   - outbound: the user picks an emoji and we must name it the way Teams does
//     (`teamsReactionKey`), or the reaction would be meaningless to every other
//     Teams client.

import { TEAMS_EMOJI_CATALOG } from "./teams-emoji-catalog";

/** Shown for a key no catalog entry, tone rule, or code point can explain — a
 *  reaction Teams added after our catalog was generated and whose id carries no
 *  code point. Neutral on purpose: a reaction is there, we just can't name it. */
const FALLBACK_EMOJI = "👍";

/** Emoji presentation selector: absent from some catalog entries and from image
 *  file names for toned emoji, so lookups normalize it away. */
const VARIATION_SELECTOR = "\u{FE0F}";

/** Fitzpatrick modifiers, in the order Teams numbers them: `-tone1` … `-tone5`
 *  appended to a base reaction id (the rule Microsoft documents rather than
 *  listing 5 extra ids per hand, so we apply it here too). */
const TONE_MODIFIERS = ["\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"];

const TONE_SUFFIX = /-tone([1-5])$/;

/** A `<code points>_<name>` key, e.g. `1f389_partypopper` or
 *  `1f1eb-1f1f7_flagfrance` — the form Teams uses for emoji it has no custom
 *  animation for. The code points are the emoji, which lets us render a key
 *  minted after our catalog snapshot. */
const CODE_POINT_KEY = /^([0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*)_/;

type Catalog = {
  /** reaction id -> emoji */
  byId: Map<string, string>;
  /** normalized emoji -> canonical reaction id (the first the catalog lists) */
  byEmoji: Map<string, string>;
  /** normalized emoji -> canonical id among those that accept a tone suffix.
   *  Not the same id as `byEmoji`: 👍 is `like` plain but `yes` when toned, which
   *  is exactly what a real tenant sends (`yes-tone2`). */
  byTonedEmoji: Map<string, string>;
};

let catalog: Catalog | null = null;

/** Parse the packed catalog once, on first use. Each line is `<id> <emoji>`,
 *  plus a trailing ` +` when the id accepts a skin tone suffix. */
function loadCatalog(): Catalog {
  if (catalog) return catalog;
  const byId = new Map<string, string>();
  const byEmoji = new Map<string, string>();
  const byTonedEmoji = new Map<string, string>();
  for (const line of TEAMS_EMOJI_CATALOG.split("\n")) {
    const [id, emoji, toneable] = line.split(" ");
    if (!id || !emoji) continue;
    byId.set(id, emoji);
    // Several ids share one emoji (👍 is both `like` and `yes`; 🙁 is `sad`,
    // `saddog`, `shake`, …). The catalog is in Microsoft's documented order,
    // which leads with the canonical reaction — so the first id wins.
    const key = normalizeEmoji(emoji);
    if (!byEmoji.has(key)) byEmoji.set(key, id);
    if (toneable === "+" && !byTonedEmoji.has(key)) byTonedEmoji.set(key, id);
  }
  catalog = { byId, byEmoji, byTonedEmoji };
  return catalog;
}

/** Compare emoji by their meaning, not their byte sequence: the presentation
 *  selector is optional in practice (`❤` vs `❤️`) and must not decide a match. */
function normalizeEmoji(emoji: string): string {
  return emoji.replaceAll(VARIATION_SELECTOR, "");
}

/** Split an emoji into its code points with the presentation selector and any
 *  skin-tone modifier removed — the "bare" emoji, plus the tone if there was one. */
function splitTone(emoji: string): { base: string[]; tone: number | null } {
  let tone: number | null = null;
  const base: string[] = [];
  for (const char of emoji) {
    const index = TONE_MODIFIERS.indexOf(char);
    if (index !== -1) {
      tone ??= index + 1;
      continue;
    }
    if (char === VARIATION_SELECTOR) continue;
    base.push(char);
  }
  return { base, tone };
}

/**
 * Apply a skin tone to an emoji: the modifier goes right after the base
 * character (👍 + tone2 -> 👍🏼). Sequences that aren't a single toneable
 * character are left alone — Teams' tone suffix only applies to the hand and
 * people reactions, all of which are single characters.
 */
function applyTone(emoji: string, tone: number): string {
  const { base } = splitTone(emoji);
  const modifier = TONE_MODIFIERS[tone - 1];
  if (!modifier || base.length !== 1) return emoji;
  return `${base[0]}${modifier}`;
}

/**
 * The emoji to show for a Teams emotion key, in order of authority: the
 * catalog, the same key with a skin tone applied, the code points the key
 * itself carries, and finally a neutral fallback so an unknown reaction never
 * renders blank. Case-insensitive, the way keys arrive.
 */
export function reactionEmoji(key: string): string {
  const id = key.trim().toLowerCase();
  if (!id) return FALLBACK_EMOJI;
  const { byId } = loadCatalog();

  const exact = byId.get(id);
  if (exact) return exact;

  const toned = TONE_SUFFIX.exec(id);
  if (toned) {
    const base = byId.get(id.slice(0, toned.index));
    if (base) return applyTone(base, Number(toned[1]));
  }

  const codePoints = CODE_POINT_KEY.exec(id);
  if (codePoints) {
    try {
      return String.fromCodePoint(...codePoints[1]!.split("-").map((cp) => parseInt(cp, 16)));
    } catch {
      /* not a valid scalar sequence — fall through */
    }
  }

  return FALLBACK_EMOJI;
}

/**
 * The Teams emotion key for an emoji, or `null` when Teams has no reaction for
 * it (a handful of emoji-mart entries, mostly newer sequences, have none — the
 * picker hides those rather than sending a key no Teams client can render).
 *
 * A skin tone resolves through the base emoji and Teams' documented `-tone{n}`
 * suffix, but only via an id Microsoft documents as toneable: 👍🏼 is `yes-tone2`
 * (the hand gesture), not `like-tone2` (the reaction), which is also what a real
 * tenant sends.
 */
export function teamsReactionKey(emoji: string): string | null {
  const { byEmoji, byTonedEmoji } = loadCatalog();

  const exact = byEmoji.get(normalizeEmoji(emoji));
  if (exact) return exact;

  const { base, tone } = splitTone(emoji);
  if (tone === null) return null;
  const bare = base.join("");
  const toneable = byTonedEmoji.get(bare);
  if (toneable) return `${toneable}-tone${tone}`;
  // A toned emoji Teams only knows untoned (its tone tables cover the hands and
  // people, not every emoji with a modifier): react with the plain one rather
  // than inventing a suffix no client would understand.
  return byEmoji.get(bare) ?? null;
}

/** Whether this emoji can be sent as a Teams reaction at all. */
export function canReactWith(emoji: string): boolean {
  return teamsReactionKey(emoji) !== null;
}

/** `🔥` -> `1f525`, `#️⃣` -> `0023-fe0f-20e3`: the emoji's code points as both the
 *  Apple image files and emoji-mart's `unified` name them (lowercase hex padded
 *  to four digits, joined by `-`). */
export function emojiUnified(emoji: string): string {
  return [...emoji].map((c) => c.codePointAt(0)!.toString(16).padStart(4, "0")).join("-");
}

/** The URL of an Apple emoji image on our own origin. The images are synced out
 *  of `emoji-datasource-apple` into `public/emoji/` at install time (see
 *  scripts/sync-emoji-assets.ts) — never fetched from a CDN, so emoji work with
 *  no network the way the rest of this local-first app does. */
export function appleEmojiUrl(emoji: string): string {
  return `/emoji/apple/64/${emojiUnified(emoji)}.png`;
}

/** Same, from emoji-mart's already-computed `unified` string. */
export function appleEmojiUrlFromUnified(unified: string): string {
  return `/emoji/apple/64/${unified.toLowerCase()}.png`;
}

/** The emojis offered in the quick reaction row, in Teams' canonical order —
 *  the six classic reactions, with the emoji Microsoft's catalog gives them
 *  (their "laugh" is 😆, their "sad" is 🙁). Anything beyond these six is a
 *  search away in the full picker. */
export const REACTION_PICKER: ReadonlyArray<{ key: string; emoji: string }> = [
  "like",
  "heart",
  "laugh",
  "surprised",
  "sad",
  "angry",
].map((key) => ({ key, emoji: reactionEmoji(key) }));

/** What marks a reaction key as one of the user's own emoji rather than one of
 *  Microsoft's. A port of `custom_emoji::CUSTOM_REACTION_PREFIX`. */
const CUSTOM_REACTION_PREFIX = "tlcustom-";

/**
 * The art a custom reaction key names — a full URL for the media proxy — or `null`
 * when the key is not one of ours, which is how Microsoft's own keys stay untouched.
 * A port of `custom_emoji::custom_reaction_art_url`.
 *
 * The key is `tlcustom-<objectUrl>` and carries no NAME: a name may hold digits and
 * hyphens, an AMS id starts with one, and nothing in the name charset could separate
 * them (see the Rust side for the whole argument). So a reader gets the ART, which is
 * the half that must never be resolved locally — two people's `:shipit:` are two
 * different pictures. The label a reader shows is theirs to resolve: the quick row
 * knows the name it offered, and a chip says so neutrally.
 *
 * There is no key MINTED here on purpose. The URL names an AMS object that does not
 * exist until the backend has uploaded the art, so the page names the emoji and the
 * backend mints the key (`react` takes `emoji` for that).
 */
export function customReactionArt(key: string): { src: string } | null {
  if (!key.startsWith(CUSTOM_REACTION_PREFIX)) return null;
  const src = key.slice(CUSTOM_REACTION_PREFIX.length);
  return src.startsWith("https://") ? { src } : null;
}
