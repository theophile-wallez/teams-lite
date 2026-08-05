import type { RichNode } from "./rich-text";

export type { CustomEmoji } from "./protocol";

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
