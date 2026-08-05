import type { RichNode } from "./rich-text";

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
