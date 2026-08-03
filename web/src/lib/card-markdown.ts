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
// Only the subset a card can actually contain is supported — bold, italic,
// strikethrough, inline code, links, bullet and numbered lists — and nothing else is
// invented from the text: HTML is never parsed (the backend already stripped it, and
// what is left is the author's literal text), and a bare URL is recognised BEFORE any
// delimiter, so a query string full of underscores stays a URL instead of turning
// into emphasis.
//
// The parser is pure (no DOM, no network), so it runs identically under SSR and in
// node-environment unit tests.

import { trimUrlPunctuation, type RichAttrs, type RichNode, type RichTag } from "./rich-text";

/** How deep emphasis may nest before the rest of a line is taken literally. Real
 *  cards nest one or two levels ("**[label](url)**"); the cap keeps a pathological
 *  line of delimiters from recursing without bound. */
const MAX_DEPTH = 4;

/** The punctuation a backslash may escape, so a card can print a literal `*`. */
const ESCAPABLE = "\\`*_~[]()#-.!";

/** A bare URL, matched from the scanner's current position (sticky). Stops at
 *  whitespace and at the characters that delimit markdown around a link rather than
 *  belong to it. */
const BARE_URL_AT = /https?:\/\/[^\s<>"'`[\]]+/y;

/** A line made of nothing but separator punctuation — Adaptive Cards lay out
 *  "Rust • 12 Stars" as separate blocks, so flattening them to one line each leaves
 *  a lone "•" or "|" on its own line. It carried a horizontal rhythm we do not
 *  reproduce and no information, so it goes. */
const SEPARATOR_LINE = /^[\s•·|—–\-*]+$/;

/** A bullet-list item: `- text`, `* text` or `+ text`, indented at most a little. */
const BULLET_ITEM = /^ {0,6}[-*+] +(.*)$/;

/** A numbered-list item: `1. text` or `1) text`. */
const NUMBERED_ITEM = /^ {0,6}\d{1,3}[.)] +(.*)$/;

function element(tag: RichTag, children: RichNode[], attrs: RichAttrs = {}): RichNode {
  return { type: "element", tag, attrs, children };
}

/** Only display-safe schemes become links; anything else stays text (a card comes
 *  from a bot, and a `javascript:` "link" in one is not a link). */
function safeHref(url: string): string | undefined {
  return /^(https?:|mailto:|tel:)/i.test(url) ? url : undefined;
}

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
      nodes.push(element("p", parseInline(lines[i]!.trim(), 0)));
      i += 1;
      continue;
    }
    // A run of items of the same kind is one list, so two bullets do not become two
    // one-item lists with a paragraph's worth of air between them.
    const items: RichNode[] = [];
    while (i < lines.length) {
      const next = listItem(lines[i]!);
      if (next?.tag !== item.tag) break;
      items.push(element("li", parseInline(next.content, 0)));
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

/** What a delimiter opens, and how it is written. */
const EMPHASIS: readonly { delimiter: string; tag: RichTag }[] = [
  { delimiter: "**", tag: "strong" },
  { delimiter: "__", tag: "strong" },
  { delimiter: "~~", tag: "s" },
  { delimiter: "*", tag: "em" },
  { delimiter: "_", tag: "em" },
];

/** A match a scanner rule produced: the node, and where the scan resumes. */
type Match = { node: RichNode; end: number };

/**
 * Parse one line's inline markup. The scan walks the line once and, at each
 * position, tries the rules in the order that keeps the others honest:
 *
 *  1. a backslash escape, so a literal `*` can be written;
 *  2. a bare URL, taken whole — before emphasis, so `?matcher=__uid__%3D…` inside a
 *     link is never read as bold;
 *  3. inline code, whose content is verbatim;
 *  4. a `[label](url)` link;
 *  5. emphasis.
 *
 * Anything that does not match — an unclosed `**`, a `[` that opens nothing — stays
 * the literal character it is, which is also how a card host renders it.
 */
function parseInline(source: string, depth: number): RichNode[] {
  const nodes: RichNode[] = [];
  let text = "";
  const flush = () => {
    if (text.length > 0) nodes.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i]!;

    if (char === "\\" && i + 1 < source.length && ESCAPABLE.includes(source[i + 1]!)) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    const url = char === "h" ? matchBareUrl(source, i) : null;
    if (url) {
      flush();
      nodes.push(url.node);
      i = url.end;
      continue;
    }

    const code = char === "`" ? matchCode(source, i) : null;
    if (code) {
      flush();
      nodes.push(code.node);
      i = code.end;
      continue;
    }

    const link = char === "[" ? matchLink(source, i, depth) : null;
    if (link) {
      flush();
      nodes.push(link.node);
      i = link.end;
      continue;
    }

    const emphasis = matchEmphasis(source, i, depth);
    if (emphasis) {
      flush();
      nodes.push(emphasis.node);
      i = emphasis.end;
      continue;
    }

    text += char;
    i += 1;
  }
  flush();
  return nodes;
}

/** A URL written on its own, linked to itself — the shape a connector card leaves
 *  behind once its HTML anchor is flattened ("Filebeat error(s): https://…"). */
function matchBareUrl(source: string, at: number): Match | null {
  BARE_URL_AT.lastIndex = at;
  const match = BARE_URL_AT.exec(source);
  if (!match) return null;
  const href = trimUrlPunctuation(match[0]);
  // A "URL" that is nothing but a scheme is left as text.
  if (!/^https?:\/\/\S/i.test(href)) return null;
  return { node: element("a", [{ type: "text", text: href }], { href }), end: at + href.length };
}

/** `` `code` `` — its content is shown exactly as written, never re-parsed. */
function matchCode(source: string, at: number): Match | null {
  const close = source.indexOf("`", at + 1);
  if (close <= at + 1) return null;
  const code = source.slice(at + 1, close);
  return { node: element("code", [{ type: "text", text: code }]), end: close + 1 };
}

/**
 * `[label](url)` — the reason this parser exists: a card's links carry a two-word
 * label over a URL long enough to fill the bubble on its own.
 *
 * The label may hold markup of its own (a bolded link title), and the URL may hold
 * balanced parentheses, which Grafana's Explore links do. An unsafe or empty URL
 * makes the whole thing fall back to literal text rather than silently swallow the
 * label.
 */
function matchLink(source: string, at: number, depth: number): Match | null {
  const label = matchDelimited(source, at + 1, "[", "]");
  if (!label) return null;
  if (source[label.end] !== "(") return null;
  const target = matchDelimited(source, label.end + 1, "(", ")");
  if (!target) return null;
  // A markdown link may carry a title after the URL — `(url "title")` — which is a
  // tooltip we do not render.
  const href = safeHref(target.inner.trim().split(/\s+/)[0] ?? "");
  if (!href) return null;
  const children = depth < MAX_DEPTH ? parseInline(label.inner, depth + 1) : [{ type: "text" as const, text: label.inner }];
  return { node: element("a", children, { href }), end: target.end };
}

/** Scan from just after an opening delimiter to its match, honouring nesting and
 *  backslash escapes. `from` is the index of the first character INSIDE the opener. */
function matchDelimited(
  source: string,
  from: number,
  open: string,
  close: string,
): { inner: string; end: number } | null {
  let depth = 1;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { inner: source.slice(from, i), end: i + 1 };
    }
  }
  return null;
}

/** True when a character cannot be part of a word, so a `_` next to it opens or
 *  closes emphasis instead of sitting inside an identifier (`snake_case`). */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || !/[\p{L}\p{N}]/u.test(char);
}

/**
 * `**bold**`, `__bold__`, `~~struck~~`, `*italic*`, `_italic_`.
 *
 * The content may not begin or end with a space (so "5 * 3 = 15 * 1" is arithmetic,
 * not emphasis), and a `_` delimiter must sit at a word boundary — otherwise every
 * `snake_case_name` and `__alert_rule_uid__` in a card would come out italic.
 */
function matchEmphasis(source: string, at: number, depth: number): Match | null {
  for (const { delimiter, tag } of EMPHASIS) {
    if (!source.startsWith(delimiter, at)) continue;
    const from = at + delimiter.length;
    if (/\s/.test(source[from] ?? " ")) continue;
    if (delimiter.startsWith("_") && !isBoundary(source[at - 1])) continue;
    let close = source.indexOf(delimiter, from + 1);
    while (close > 0) {
      const before = source[close - 1]!;
      const after = source[close + delimiter.length];
      const boundaryOk = !delimiter.startsWith("_") || isBoundary(after);
      if (!/\s/.test(before) && before !== "\\" && boundaryOk) break;
      close = source.indexOf(delimiter, close + 1);
    }
    if (close < 0) continue;
    const inner = source.slice(from, close);
    const children =
      depth < MAX_DEPTH ? parseInline(inner, depth + 1) : [{ type: "text" as const, text: inner }];
    return { node: element(tag, children), end: close + delimiter.length };
  }
  return null;
}
