// Word effects — a small easter egg in the message renderer.
//
// A handful of words are dressed up instead of rendered as plain text: the
// affectionate nicknames sparkle as candy text, and the football words bounce in
// pitch colors between two spinning balls. This module owns only the
// *detection*: splitting a run of text into plain and decorated segments. It is
// pure (no DOM, no React), so it unit-tests in the node environment alongside
// the other rich-text logic. The looks themselves live in app.css.

/** The kinds of decoration a word can get. */
export type WordEffect = "sparkle" | "football";

/**
 * The words that light up, in folded form: lowercase, without diacritics and
 * without hyphens (see {@link fold}). Matching is therefore case-, accent- and
 * hyphen-insensitive, so "Bébou", "BEBOU" and "bebou" all sparkle, and "baby",
 * "babyfoot" and "baby-foot" all kick the football effect off.
 */
const WORD_EFFECTS = new Map<string, WordEffect>([
  ["bebou", "sparkle"],
  ["bibou", "sparkle"],
  ["baby", "football"],
  ["babyfoot", "football"],
]);

/** A run of message text, tagged with the effect it should be rendered with. */
export type TextSegment = { text: string; effect: WordEffect | null };

// A maximal run of letters (plus their combining marks) with optional internal
// hyphens, i.e. one word or one hyphenated compound. Matching whole tokens only
// keeps the egg from firing inside a longer word.
const TOKEN_RE = /[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu;
// The letter runs inside a token, used to look inside a compound that is not
// itself a listed word.
const WORD_RE = /[\p{L}\p{M}]+/gu;

/** Lowercase, strip diacritics and hyphens, so "Baby-Foot" folds to "babyfoot". */
function fold(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replaceAll("-", "")
    .toLowerCase();
}

/**
 * The effect this word gets, or `null` when it is an ordinary word. Plurals
 * ("bébous", "baby-foots") count as the word they pluralize.
 */
export function wordEffect(word: string): WordEffect | null {
  const folded = fold(word);
  const listed = WORD_EFFECTS.get(folded);
  if (listed) return listed;
  if (!folded.endsWith("s")) return null;
  return WORD_EFFECTS.get(folded.slice(0, -1)) ?? null;
}

/** One decorated word found in a run of text, at its offset in that run. */
type Hit = { start: number; text: string; effect: WordEffect };

/**
 * The decorated words inside one token, in order. A listed token lights up whole
 * ("baby-foot"); otherwise its letter runs are considered on their own, so a
 * compound that merely contains a listed word still lights that word up
 * ("bibou-chou").
 */
function hitsInToken(token: string, offset: number): Hit[] {
  const effect = wordEffect(token);
  if (effect) return [{ start: offset, text: token, effect }];
  if (!token.includes("-")) return [];
  const hits: Hit[] = [];
  for (const part of token.matchAll(WORD_RE)) {
    const partEffect = wordEffect(part[0]);
    if (partEffect) hits.push({ start: offset + part.index, text: part[0], effect: partEffect });
  }
  return hits;
}

/**
 * Split `text` into alternating plain and decorated segments, preserving the
 * original characters (accents, hyphens and casing included) so the rendered
 * message still reads exactly as it was written.
 *
 * Returns a single plain segment when the text holds no decorated word — the
 * overwhelmingly common case — which lets the renderer keep emitting a bare
 * string instead of wrapping every message in extra elements.
 */
export function splitWordEffects(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    for (const hit of hitsInToken(match[0], match.index)) {
      if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start), effect: null });
      segments.push({ text: hit.text, effect: hit.effect });
      cursor = hit.start + hit.text.length;
    }
  }
  if (segments.length === 0) return [{ text, effect: null }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), effect: null });
  return segments;
}
