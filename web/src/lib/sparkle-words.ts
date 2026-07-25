// Sparkle words — a small easter egg in the message renderer.
//
// A handful of affectionate nicknames are dressed up as candy text (one color
// per letter, a bobbing shimmer, twinkling sparkles) instead of plain text. This
// module owns only the *detection*: splitting a run of text into plain and
// sparkling segments. It is pure (no DOM, no React), so it unit-tests in the
// node environment alongside the other rich-text logic.

/**
 * The nicknames that sparkle, in folded form: lowercase and without diacritics
 * (see {@link fold}). Matching is therefore case- and accent-insensitive, so
 * "Bébou", "BEBOU" and "bebou" all light up.
 */
const SPARKLE_WORDS = new Set(["bebou", "bibou"]);

/** A run of message text, flagged when it is a nickname that should sparkle. */
export type TextSegment = { text: string; sparkle: boolean };

// A maximal run of letters (plus their combining marks), i.e. one word. Matching
// whole words only keeps the egg from firing inside a longer word.
const WORD_RE = /[\p{L}\p{M}]+/gu;

/** Lowercase and strip diacritics, so "Bébou" folds to "bebou". */
function fold(word: string): string {
  return word.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Is this word one of the sparkling nicknames? Plurals ("bébous") count too. */
export function isSparkleWord(word: string): boolean {
  const folded = fold(word);
  if (SPARKLE_WORDS.has(folded)) return true;
  return folded.endsWith("s") && SPARKLE_WORDS.has(folded.slice(0, -1));
}

/**
 * Split `text` into alternating plain and sparkling segments, preserving the
 * original characters (accents and casing included) so the rendered message
 * still reads exactly as it was written.
 *
 * Returns a single non-sparkling segment when the text holds no nickname — the
 * overwhelmingly common case — which lets the renderer keep emitting a bare
 * string instead of wrapping every message in extra elements.
 */
export function splitSparkleWords(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0];
    if (!isSparkleWord(word)) continue;
    const start = match.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), sparkle: false });
    segments.push({ text: word, sparkle: true });
    cursor = start + word.length;
  }
  if (segments.length === 0) return [{ text, sparkle: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), sparkle: false });
  return segments;
}
