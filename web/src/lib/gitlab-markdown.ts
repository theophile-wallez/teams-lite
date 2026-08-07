// The markdown a GitLab merge request is written in — its description, and every comment on
// it.
//
// GitLab hands this app the RAW markdown the author typed (`MergeRequestDetail::description`,
// `Note::body`) and the page renders it here rather than asking GitLab for its own HTML: that
// HTML would arrive with remote references in it, and § The GitLab page promises that drawing
// the page fetches nothing. So the subset has to be real GFM, because that is what the authors
// write — and WHICH constructs they write is measured rather than guessed
// (`examples/merge_request_markdown_recon.rs`, over the 40 newest open merge requests of
// `git.sia.partners`, 2026-08-06; 36 of them have words in their description):
//
//   heading (#…)        32    fenced code    19    numbered item      16    inline link   7
//   inline code         32    task list      18    thematic break     14    hard break    2
//   emphasis            29    table          24    nested bullet      10    raw HTML      0
//   bullet item         28                                                  indented code 0
//
// Every construct above with a count is parsed here. The three that measured ZERO decide as
// much as the others do:
//
//   * **indented code is NOT a block.** All 260 four-space lines in that sample were a list
//     item's own continuation or the inside of a fence, so reading four spaces as code would
//     turn sub-bullets into grey slabs — a rule with no author behind it and a visible cost.
//   * **raw HTML stays literal text**, and so does an HTML comment. Not one description writes
//     either, and parsing HTML here would be a second renderer with a second set of remote
//     references. What an author typed is what they see.
//   * an IMAGE is a PICTURE when it is one this app can fetch itself — a project upload, which
//     is what a pasted screenshot is — and a link otherwise. The rail is unchanged and it is
//     the reason the two answers differ: the browser never asks GitLab, or anybody else, for
//     anything. Which one a body gets is the caller's, through `gitLabMarkdownOptions` (see
//     `gitlab-upload.ts`); a caller that passes nothing gets links, as before.
//
// The result is the same {@link RichNode} tree a Teams message body becomes, so
// `rich-content.tsx` draws a description's headings, tables and code with the styles the rest
// of the app already uses (see `RichNodes`). The parser is pure — no DOM, no network — so it
// runs identically under SSR and in node-environment unit tests.

import { element, parseMarkdownInline, type InlineOptions } from "./markdown-inline";
import type { RichNode, RichTag } from "./rich-text";

/** An ATX heading: `## Summary`, with the closing hashes GitLab also accepts. */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** A fence, opening or closing: three or more backticks or tildes, with an info string that
 *  names the language. The language is read and dropped — the renderer has one code style, and
 *  a highlighter would be a second markdown implementation. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** `---`, `***`, `___` — three or more of one mark, spaces allowed between them. */
const THEMATIC_BREAK = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** A setext underline, which turns the paragraph ABOVE it into a heading. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** `> quoted`, with the one space after the mark that is part of the mark. */
const BLOCKQUOTE = /^ {0,3}>[ \t]?(.*)$/;

/** A bullet item, split into what indents it, its marker, and its content. */
const BULLET_ITEM = /^([ \t]*)([-*+])([ \t]+)(.*)$/;

/** A numbered item — `1. text` or `1) text`. */
const NUMBERED_ITEM = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/;

/** The checkbox a task list opens its item with. */
const TASK_MARKER = /^\[([ xX])\][ \t]+(.*)$/;

/** A table's delimiter row: the `|---|:--:|` line under the header, which is the ONE thing
 *  that tells a table from a paragraph holding pipe characters. */
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** A line ending in two spaces or a backslash: markdown's hard line break. */
const HARD_BREAK = /( {2,}|\\)$/;

/** What a checked and an unchecked task item are drawn with. The renderer has no checkbox tag
 *  and a description is read, never ticked, so the state is a glyph in the item's own words —
 *  which is also what it reads as when it is copied out. */
const TASK_DONE = "☑ ";
const TASK_OPEN = "☐ ";

/**
 * Parse a merge request's markdown into renderable nodes.
 *
 * Blocks are recognised in the order that keeps each other honest: a fence first (so a `#` or
 * a `|` inside code is code), then the constructs a single line states outright, then lists —
 * whose content is parsed by this same function, which is what makes a sub-list, or a fence
 * inside a bullet, work without a rule of its own — and a paragraph last, gathering the lines
 * that opened nothing.
 */
export function parseGitLabMarkdown(text: string, options: InlineOptions = {}): RichNode[] {
  return parseBlocks(text.replace(/\r\n?/g, "\n").split("\n"), options);
}

function parseBlocks(lines: string[], options: InlineOptions): RichNode[] {
  const nodes: RichNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const block = fencedCode(lines, i, fence[1]!);
      nodes.push(block.node);
      i = block.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push(element(headingTag(heading[1]!.length), parseMarkdownInline(heading[2]!, options)));
      i += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      nodes.push(element("hr", []));
      i += 1;
      continue;
    }

    const quote = BLOCKQUOTE.exec(line);
    if (quote) {
      const block = blockquote(lines, i, options);
      nodes.push(block.node);
      i = block.next;
      continue;
    }

    // A table is the one block whose opening line looks like ordinary prose: what declares it
    // is the delimiter row UNDER the header, so both are read together or neither is.
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1]!)) {
      const block = table(lines, i, options);
      nodes.push(block.node);
      i = block.next;
      continue;
    }

    if (itemAt(line)) {
      const block = list(lines, i, options);
      nodes.push(block.node);
      i = block.next;
      continue;
    }

    const block = paragraph(lines, i, options);
    if (block.node) nodes.push(block.node);
    i = block.next;
  }
  return nodes;
}

/** `h4`–`h6` collapse into the smallest heading the renderer draws: a merge request is read in
 *  a 320px column, and three sizes are all the hierarchy that survives there. */
function headingTag(level: number): RichTag {
  return level === 1 ? "h1" : level === 2 ? "h2" : "h3";
}

/**
 * A fenced block, from its opening fence to the first fence that CLOSES it — one of the same
 * mark, at least as long. Its content is verbatim: never re-parsed, never trimmed of the
 * indentation that is part of the code.
 *
 * An unclosed fence runs to the end of the body rather than falling back to prose, because
 * that is what every markdown host does with one, and a half-written description is the
 * common case for a draft.
 */
function fencedCode(lines: string[], start: number, fence: string): { node: RichNode; next: number } {
  const mark = fence[0]!;
  const content: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const closing = FENCE.exec(lines[i]!);
    if (closing && closing[1]![0] === mark && closing[1]!.length >= fence.length && closing[2]!.trim() === "") {
      i += 1;
      break;
    }
    content.push(lines[i]!);
    i += 1;
  }
  const code = element("code", [{ type: "text", text: content.join("\n") }]);
  return { node: element("pre", [code]), next: i };
}

/** Consecutive `>` lines, stripped of one level of mark and parsed as blocks of their own — so
 *  a quote holding a list or a fence keeps it. */
function blockquote(
  lines: string[],
  start: number,
  options: InlineOptions,
): { node: RichNode; next: number } {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length) {
    const quote = BLOCKQUOTE.exec(lines[i]!);
    if (!quote) break;
    inner.push(quote[1]!);
    i += 1;
  }
  return { node: element("blockquote", parseBlocks(inner, options)), next: i };
}

/** True for the `|---|---|` row, which is what declares the line above it a table header. */
function isTableDelimiter(line: string): boolean {
  return line.includes("-") && TABLE_DELIMITER.test(line);
}

/**
 * A pipe table: a header row, the delimiter row that declared it, and every row under it.
 *
 * Alignment is read and dropped — the renderer has one cell style — and every row is squared
 * off to the header's width, because GFM drops the cells past it and fills the ones missing:
 * a ragged table is one the renderer would draw with holes in it.
 */
function table(
  lines: string[],
  start: number,
  options: InlineOptions,
): { node: RichNode; next: number } {
  const headers = tableCells(lines[start]!);
  const head = element("thead", [
    element(
      "tr",
      headers.map((cell) => element("th", parseMarkdownInline(cell, options))),
    ),
  ]);

  const rows: RichNode[] = [];
  let i = start + 2;
  while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
    const cells = tableCells(lines[i]!);
    rows.push(
      element(
        "tr",
        headers.map((_, column) => element("td", parseMarkdownInline(cells[column] ?? "", options))),
      ),
    );
    i += 1;
  }

  const children = rows.length > 0 ? [head, element("tbody", rows)] : [head];
  return { node: element("table", children), next: i };
}

/** One row's cells. The outer pipes are the table's frame rather than empty cells, and a `\|`
 *  is a pipe the author wrote — it stays in the cell and the inline scanner unescapes it. */
function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** What a line opens, when it opens a list item. */
type Item = { tag: "ul" | "ol"; indent: number; contentIndent: number; content: string };

function itemAt(line: string): Item | null {
  const bullet = BULLET_ITEM.exec(line);
  if (bullet) {
    const [, indent, marker, gap, content] = bullet as unknown as string[];
    // `* * *` is a thematic break, not a one-item list holding a bullet.
    if (THEMATIC_BREAK.test(line)) return null;
    return {
      tag: "ul",
      indent: indent!.length,
      contentIndent: indent!.length + marker!.length + gap!.length,
      content: content!,
    };
  }
  const numbered = NUMBERED_ITEM.exec(line);
  if (numbered) {
    const [, indent, digits, delimiter, gap, content] = numbered as unknown as string[];
    return {
      tag: "ol",
      indent: indent!.length,
      contentIndent: indent!.length + digits!.length + delimiter!.length + gap!.length,
      content: content!,
    };
  }
  return null;
}

/**
 * A list, and everything nested inside it.
 *
 * Each item's own lines — its first, plus every following line indented past its marker — are
 * dedented and parsed as blocks by {@link parseBlocks}. That recursion is the whole of the
 * nesting: a sub-list, a fence, a second paragraph inside a bullet all arrive as blocks
 * without a rule apiece. The item's leading paragraph is then UNWRAPPED, so a tight list reads
 * as one line per item instead of a paragraph's worth of air around each.
 */
function list(
  lines: string[],
  start: number,
  options: InlineOptions,
): { node: RichNode; next: number } {
  const first = itemAt(lines[start]!)!;
  const items: RichNode[] = [];
  let i = start;

  while (i < lines.length) {
    const item = itemAt(lines[i]!);
    // A line of another kind, or one indented back out of this list, ends it. A deeper item is
    // never reached here: it was gathered into the item above as that item's own content.
    if (!item || item.tag !== first.tag || item.indent > first.indent + 1) break;

    const own = [item.content];
    i += 1;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "") {
        // A blank line ends the item unless the list continues under it.
        const next = lines[i + 1];
        if (next === undefined || (next.trim() !== "" && indentOf(next) < item.contentIndent && !itemAt(next))) break;
        own.push("");
        i += 1;
        continue;
      }
      if (indentOf(line) < item.contentIndent) {
        // A line the author simply wrapped, indented back to the margin, still belongs to the
        // item it continues — but only while the item's own text is still being written: after
        // a blank line an unindented line has left the list.
        if (itemAt(line) || opensAnotherBlock(lines, i) || own.at(-1) === "") break;
        own.push(line.trim());
        i += 1;
        continue;
      }
      own.push(line.slice(item.contentIndent));
      i += 1;
    }

    items.push(element("li", itemContent(own, options)));
  }

  return { node: element(first.tag, items), next: i };
}

/** How far a line is indented, counting a tab as one character — the same way the item
 *  patterns above measure it, so the two can be compared at all. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * What goes inside one `<li>`: the item's blocks, with a leading paragraph unwrapped into the
 * item itself, and a task list's checkbox drawn as the first thing in it.
 */
function itemContent(lines: string[], options: InlineOptions): RichNode[] {
  const task = TASK_MARKER.exec(lines[0] ?? "");
  const own = task ? [task[2]!, ...lines.slice(1)] : lines;
  const blocks = parseBlocks(own, options);
  const unwrapped =
    blocks[0]?.type === "element" && blocks[0].tag === "p"
      ? [...blocks[0].children, ...blocks.slice(1)]
      : blocks;
  if (!task) return unwrapped;
  const box = task[1] === " " ? TASK_OPEN : TASK_DONE;
  return [{ type: "text", text: box }, ...unwrapped];
}

/**
 * A paragraph: every following line that opens no other block, joined.
 *
 * The join is a newline, exactly as HTML's own soft break is — so the surrounding style decides
 * whether the author's hard wrap is honoured or read as a space. A line ending in two spaces
 * or a backslash asks for a real break, and gets a `<br>`.
 *
 * A setext underline (`===` or `---`) directly under the first line makes the whole thing a
 * heading instead, which is what GitLab does with it.
 */
function paragraph(
  lines: string[],
  start: number,
  options: InlineOptions,
): { node: RichNode | null; next: number } {
  const own: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    if (own.length > 0 && opensAnotherBlock(lines, i)) break;
    own.push(line);
    i += 1;
    if (i < lines.length && SETEXT_UNDERLINE.test(lines[i]!)) {
      const level = lines[i]!.trim().startsWith("=") ? 1 : 2;
      return { node: element(headingTag(level), inlineWithBreaks(own, options)), next: i + 1 };
    }
  }
  const children = inlineWithBreaks(own, options);
  return { node: children.length > 0 ? element("p", children) : null, next: Math.max(i, start + 1) };
}

/** Whether the line at `at` starts a block, so a paragraph gathering lines must stop before
 *  it. A table's header is deliberately NOT one: it is prose until its delimiter row says
 *  otherwise, and that pair is read where a block begins. */
function opensAnotherBlock(lines: string[], at: number): boolean {
  const line = lines[at]!;
  if (FENCE.test(line) || HEADING.test(line) || THEMATIC_BREAK.test(line)) return true;
  if (BLOCKQUOTE.test(line) || itemAt(line)) return true;
  return line.includes("|") && at + 1 < lines.length && isTableDelimiter(lines[at + 1]!);
}

/** One paragraph's lines as inline nodes, with a `<br>` where a line asked for a break and a
 *  newline where it did not. */
function inlineWithBreaks(lines: string[], options: InlineOptions): RichNode[] {
  const nodes: RichNode[] = [];
  lines.forEach((line, index) => {
    const hard = HARD_BREAK.test(line);
    nodes.push(...parseMarkdownInline(line.replace(HARD_BREAK, "").trim(), options));
    if (index === lines.length - 1) return;
    if (hard) nodes.push(element("br", []));
    else nodes.push({ type: "text", text: "\n" });
  });
  return nodes;
}
