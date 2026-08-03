// @mentions in the composer: who can be mentioned, which of them a half-typed "@…"
// means, and how a mention's own text shrinks.
//
// Everything here is pure — no editor, no DOM, no network — so the rules that decide
// whether the suggestion list opens, who it offers and what Backspace does to a mention
// are unit-tested directly. The editor side (the node, the popup, the keys) lives in
// components/mention-extension.ts and components/mention-suggestions.tsx.

/** Somebody a message can @mention: their MRI, and the name to show. */
export type MentionCandidate = {
  /** The person's MRI (`8:orgid:<guid>`) — what makes Teams notify them. */
  mri: string;
  name: string;
};

/** A mention as it will be sent: the span index in the body, who it names, and the
 *  text that span shows (which the author may have shortened). Mirrors the Rust
 *  `teams_send::Mention`. */
export type OutboundMention = {
  itemid: number;
  mri: string;
  display_name: string;
};

/** How many suggestions the list shows at once. A menu, not a directory: past this
 *  the user is faster typing another letter than reading. */
export const MAX_MENTION_SUGGESTIONS = 8;

/** How long a half-typed query may get before "@" stops meaning a mention. Long
 *  enough for "Charlotte Dub", short enough that a sentence starting with an email
 *  address does not keep the list open. */
const MAX_QUERY_LENGTH = 32;

/** How many words a query may span. A name is two words far more often than three,
 *  and each extra word is another sentence the list would stay open over. */
const MAX_QUERY_WORDS = 2;

/** An active `@…` query in the text before the cursor. */
export type MentionQuery = {
  /** What was typed after the "@" (may be empty: "@" alone opens the list). */
  query: string;
  /** Offset of the "@" itself, so the editor knows what to replace. */
  at: number;
};

/**
 * The `@…` the cursor sits in, or `null` when it sits in ordinary text.
 *
 * `text` is the plain text of the current block up to the cursor. A mention starts at
 * the beginning of a block or after whitespace — never inside a word — so an email
 * address or a handle glued to a word ("a@b.com") is text, not a mention. The query
 * may hold one space, because "Charlotte Dub" is how a person is found by surname.
 */
export function mentionQueryBefore(text: string): MentionQuery | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  const before = text[at - 1];
  if (before !== undefined && !/\s/.test(before)) return null;
  const query = text.slice(at + 1);
  if (query.length > MAX_QUERY_LENGTH) return null;
  if (/[\n\r]/.test(query)) return null;
  // An "@" the author is done with: two words typed past it are a sentence, not a
  // name being looked up.
  if (query.trim().split(/\s+/).filter(Boolean).length > MAX_QUERY_WORDS) return null;
  // A query that ends in a space only stays a query while it holds a word, so "@ "
  // (a lone at-sign and a space) closes the list.
  if (query.length > 0 && query.trim().length === 0) return null;
  return { query, at };
}

/** Fold a name for comparison: no case, no diacritics, single spaces. So "Théo"
 *  matches a typed "theo", which is what somebody on a US keyboard types. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The people a query offers, best match first, capped at {@link MAX_MENTION_SUGGESTIONS}.
 *
 * Ranked by how the match reads, not by string distance: a name that STARTS with what
 * was typed comes before one whose surname does, which comes before a mere substring.
 * Ties keep the caller's order, which is the backend's own relevance (the people who
 * wrote most recently first). An empty query offers everybody, in that same order.
 */
export function matchMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit: number = MAX_MENTION_SUGGESTIONS,
): MentionCandidate[] {
  const needle = fold(query);
  const scored: { candidate: MentionCandidate; score: number; index: number }[] = [];
  candidates.forEach((candidate, index) => {
    if (!candidate.mri || !candidate.name) return;
    if (needle.length === 0) {
      scored.push({ candidate, score: 0, index });
      return;
    }
    const name = fold(candidate.name);
    let score: number;
    if (name.startsWith(needle)) score = 0;
    else if (name.split(" ").some((word) => word.startsWith(needle))) score = 1;
    else if (name.includes(needle)) score = 2;
    else return;
    scored.push({ candidate, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.candidate);
}

/**
 * What a mention's text becomes when Backspace lands on it, or `null` when there is
 * nothing left to drop and the mention itself goes.
 *
 * This is Teams' behaviour, and it is the reason a mention's label is editable at all:
 * mentioning "John De Doe" and pressing Backspace twice leaves "John" — still a
 * mention, still notifying John, just addressing him the way people in the thread
 * actually do. One word per keystroke, from the end.
 */
export function shortenMentionLabel(label: string): string | null {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return null;
  return words.slice(0, -1).join(" ");
}

/** De-duplicate candidates by MRI, keeping the first (most relevant) of each and the
 *  first non-empty name. Used where two sources of people meet. */
export function dedupeCandidates(candidates: readonly MentionCandidate[]): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.mri) continue;
    const known = out.find((person) => person.mri.toLowerCase() === candidate.mri.toLowerCase());
    if (!known) {
      out.push({ mri: candidate.mri, name: candidate.name });
      continue;
    }
    if (!known.name && candidate.name) known.name = candidate.name;
  }
  return out;
}
