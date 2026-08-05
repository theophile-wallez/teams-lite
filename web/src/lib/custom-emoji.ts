import type { RichNode } from "./rich-text";

export type { CustomEmoji } from "./protocol";
import type { CustomEmoji } from "./protocol";

export type EmojiSuggestion =
  | { kind: "custom"; name: string }
  | { kind: "unicode"; name: string; native: string };

/** An active `:…` query in the text before the cursor. */
export type EmojiQuery = {
  /** What was typed after the ":" (may be empty for lone ":"). */
  query: string;
  /** Offset of the ":" itself, so the editor knows what to replace. */
  at: number;
};

/** How long a half-typed emoji code may get before ":" stops meaning an emoji. */
const MAX_EMOJI_QUERY_LENGTH = 64;

/**
 * The `:…` the cursor sits in, or `null` when it sits in ordinary text.
 *
 * `text` is the plain text of the current block up to the cursor. An emoji code starts
 * at the beginning of a block or after whitespace — never inside a word — so "note: this"
 * does not trigger. An empty query (lone ":") returns null, so a lone colon opens no menu.
 */
export function emojiQueryBefore(text: string): EmojiQuery | null {
  const at = text.lastIndexOf(":");
  if (at < 0) return null;
  const before = text[at - 1];
  if (before !== undefined && !/\s/.test(before)) return null;
  const query = text.slice(at + 1);
  if (query.length > MAX_EMOJI_QUERY_LENGTH) return null;
  if (/[\n\r\s]/.test(query)) return null;
  if (query.trim() === "") return null;
  return { query, at };
}

/**
 * Port of `custom_emoji::is_valid_name` from the Rust backend. Must move with the
 * original. Slack's emoji name rule: first character must be a lowercase letter or
 * digit, then lowercase letters, digits, dashes, underscores, and plus signs. 1..64
 * characters.
 */
function isValidCustomEmojiName(name: string): boolean {
  const len = name.length;
  if (len === 0 || len > 64) return false;
  const first = name.charCodeAt(0);
  const isLowercase = (c: number) => c >= 97 && c <= 122;
  const isDigit = (c: number) => c >= 48 && c <= 57;
  const isAllowed = (c: number) =>
    isLowercase(c) || isDigit(c) || c === 45 || c === 95 || c === 43;
  if (!isLowercase(first) && !isDigit(first)) return false;
  for (let i = 0; i < len; i++) {
    if (!isAllowed(name.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * Return Slack's sentence for a taken emoji name, or a message about the name rule,
 * or `null` when the name is valid and available.
 */
export function customEmojiNameError(name: string, taken: string[]): string | null {
  if (taken.includes(name)) {
    return "If your emoji name is taken, choose another.";
  }
  if (!isValidCustomEmojiName(name)) {
    return "an emoji name may hold lowercase letters, numbers, dashes and underscores";
  }
  return null;
}

/**
 * A body whose content is only custom emoji and whitespace draws them jumbo
 * (2.5em), following Slack's behavior for emoji-only messages.
 */
export function bodyIsOnlyEmoji(nodes: RichNode[]): boolean {
  if (nodes.length === 0) return false;
  if (!hasAtLeastOneEmoji(nodes)) return false;

  for (const node of nodes) {
    if (node.type === "text") {
      if (node.text.trim().length > 0) return false;
    } else if (node.tag === "customEmoji") {
      continue;
    } else if (node.tag === "br") {
      continue;
    } else {
      if (!bodyIsOnlyEmoji(node.children)) return false;
    }
  }

  return true;
}

function hasAtLeastOneEmoji(nodes: RichNode[]): boolean {
  for (const node of nodes) {
    if (node.type === "element") {
      if (node.tag === "customEmoji") return true;
      if (hasAtLeastOneEmoji(node.children)) return true;
    }
  }
  return false;
}

/**
 * Rank emoji suggestions for a typeahead query. Custom emoji come first,
 * then Unicode shortcodes, prefix matches before substring matches within each band.
 * An empty query returns nothing, so a lone ":" opens no menu.
 */
export function emojiSuggestions(
  query: string,
  pack: readonly CustomEmoji[],
  unicode: ReadonlyArray<readonly [string, string]>,
  limit = 10,
): EmojiSuggestion[] {
  if (query.trim() === "") return [];

  const lower = query.toLowerCase();
  const customPrefix: EmojiSuggestion[] = [];
  const customSubstring: EmojiSuggestion[] = [];
  const unicodePrefix: EmojiSuggestion[] = [];
  const unicodeSubstring: EmojiSuggestion[] = [];

  for (const emoji of pack) {
    const name = emoji.name.toLowerCase();
    if (name.startsWith(lower)) {
      customPrefix.push({ kind: "custom", name: emoji.name });
    } else if (name.includes(lower)) {
      customSubstring.push({ kind: "custom", name: emoji.name });
    }
  }

  for (const [name, native] of unicode) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith(lower)) {
      unicodePrefix.push({ kind: "unicode", name, native });
    } else if (lowerName.includes(lower)) {
      unicodeSubstring.push({ kind: "unicode", name, native });
    }
  }

  return [
    ...customPrefix,
    ...customSubstring,
    ...unicodePrefix,
    ...unicodeSubstring,
  ].slice(0, limit);
}
