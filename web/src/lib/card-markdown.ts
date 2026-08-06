// The markdown an adaptive / connector card writes its text in.
//
// A card's text is NOT plain prose: an Adaptive Card `TextBlock` is markdown by
// specification, and every card host renders it as such. The tenant's cards prove
// it — 119 of the 176 cards in the local store carry `**bold**` and 117 carry
// `[label](https://…)` links. Printed verbatim, a monitoring alert reads:
//
//   **critical** — metabase restarted 12 times. [🪵 Logs](https://grafana…3A%22now%22%7D%7D)
//
// — asterisks in the middle of the sentence and a 500-character URL where a two-word
// link should be. So the card text is parsed here into the SAME {@link RichNode} tree
// the message renderer already speaks (see `rich-content.tsx`), and the card surface
// renders it with the same bold, links and lists as a message body.
//
// This module is the BLOCK half only — how a card's lines become blocks, which is the
// one thing a card does differently from every other markdown in this app: it arrives
// pre-flattened, one block per line. What happens INSIDE a line is
// `markdown-inline.ts`, shared with the GitLab bodies of `gitlab-markdown.ts`, because
// two copies of an emphasis scanner drift apart at the first `snake_case` somebody
// reports.
//
// Only the subset a card can actually contain is supported — bold, italic,
// strikethrough, inline code, links, bullet and numbered lists — and nothing else is
// invented from the text.
//
// The parser is pure (no DOM, no network), so it runs identically under SSR and in
// node-environment unit tests.

import { element, parseMarkdownInline } from "./markdown-inline";
import type { RichNode } from "./rich-text";

/** A line made of nothing but separator punctuation — Adaptive Cards lay out
 *  "Rust • 12 Stars" as separate blocks, so flattening them to one line each leaves
 *  a lone "•" or "|" on its own line. It carried a horizontal rhythm we do not
 *  reproduce and no information, so it goes. */
const SEPARATOR_LINE = /^[\s•·|—–\-*]+$/;

/** A bullet-list item: `- text`, `* text` or `+ text`, indented at most a little. */
const BULLET_ITEM = /^ {0,6}[-*+] +(.*)$/;

/** A numbered-list item: `1. text` or `1) text`. */
const NUMBERED_ITEM = /^ {0,6}\d{1,3}[.)] +(.*)$/;

/**
 * Parse a card's text into renderable nodes.
 *
 * Each line is one block, because that is what it is: the backend joins the card's
 * visible blocks with `\n` (see `Card::text` in src/teams_cards.rs), so a line break
 * in the text marks a block boundary rather than a soft wrap. Consecutive list items
 * gather into one list, blank lines are dropped, and a line that is only separator
 * punctuation is dropped with them.
 */
export function parseCardMarkdown(text: string): RichNode[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "" && !SEPARATOR_LINE.test(line));

  const nodes: RichNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const item = listItem(lines[i]!);
    if (!item) {
      nodes.push(element("p", parseMarkdownInline(lines[i]!.trim())));
      i += 1;
      continue;
    }
    // A run of items of the same kind is one list, so two bullets do not become two
    // one-item lists with a paragraph's worth of air between them.
    const items: RichNode[] = [];
    while (i < lines.length) {
      const next = listItem(lines[i]!);
      if (next?.tag !== item.tag) break;
      items.push(element("li", parseMarkdownInline(next.content)));
      i += 1;
    }
    nodes.push(element(item.tag, items));
  }
  return nodes;
}

/** The kind and content of a list item, or `null` for an ordinary line. */
function listItem(line: string): { tag: "ul" | "ol"; content: string } | null {
  const bullet = BULLET_ITEM.exec(line);
  if (bullet) return { tag: "ul", content: bullet[1] ?? "" };
  const numbered = NUMBERED_ITEM.exec(line);
  if (numbered) return { tag: "ol", content: numbered[1] ?? "" };
  return null;
}
