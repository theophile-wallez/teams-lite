// Safe rich-text rendering for Teams message HTML.
//
// Teams delivers message bodies as `RichText/Html` — a bounded, well-structured
// HTML subset (bold, italic, links, lists, code, mentions, images, line breaks).
// Rather than inject that HTML with `dangerouslySetInnerHTML` (an XSS surface
// that also needs a DOM and a sanitizer), we parse it into a small, serializable
// node tree with a strict allowlist. Only known tags/attributes ever survive;
// everything else is unwrapped or dropped, and all URLs are scheme-checked.
//
// The parser is pure (no DOM, no network, no runtime-specific API), so it runs
// identically under SSR and in node-environment unit tests.
//
// Not every body is HTML: a `messagetype: Text` message is plain text, and parsing
// it as HTML eats anything in angle brackets. `parseMessageBody` is the choke point
// that reads each body the way its `BodyFormat` says it must be read.

import type { BodyFormat } from "./protocol";

/** A semantic element tag we know how to render. */
export type RichTag =
  | "p"
  | "br"
  | "hr"
  | "h1"
  | "h2"
  | "h3"
  | "strong"
  | "em"
  | "u"
  | "s"
  | "small"
  | "code"
  | "pre"
  | "blockquote"
  | "ul"
  | "ol"
  | "li"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "td"
  | "th"
  | "a"
  | "img"
  | "mention"
  /** An app link-unfurl card (`span itemtype=".../InputExtension"`). */
  | "card";

export type RichAttrs = {
  href?: string;
  src?: string;
  alt?: string;
  /** Mentions and app cards only: the `itemid` the Teams span carries. For a
   *  mention it is an index into the message's `mentions` list, which is where
   *  the mentioned person's identity actually lives (the span itself only holds
   *  their display text) — kept so the renderer can look them up and offer their
   *  person card. For a card it is the card's own id. */
  itemid?: string;
  /** Mentions only, and only OUTBOUND ones: the MRI of the person the mention names.
   *  An inbound Teams mention never carries it (its span holds an index and nothing
   *  else — see `itemid`); the composer's own markup does, because a message being
   *  written has no `mentions` list beside it yet. It is what
   *  {@link serializeTeamsMessage} turns back into that list on send. */
  mri?: string;
  /** Table cells only: how many columns/rows the cell spans, when it spans more
   *  than one. Bounded (see {@link cellSpan}) so a hostile value can't ask the
   *  browser for a million columns. */
  colspan?: number;
  rowspan?: number;
};

export type RichNode =
  | { type: "text"; text: string }
  | { type: "element"; tag: RichTag; attrs: RichAttrs; children: RichNode[] };

// Raw HTML tag -> semantic tag. Tags absent from this map are "unwrapped": we
// drop the tag itself but keep and render its children (e.g. <span>, <font>).
const TAG_MAP: Record<string, RichTag> = {
  p: "p",
  div: "p",
  br: "br",
  hr: "hr",
  // Headings keep their level (h4-h6 collapse into the smallest one): a message
  // body is a bubble, not a document, so three sizes are all the hierarchy that
  // is worth rendering.
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h3",
  h5: "h3",
  h6: "h3",
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  u: "u",
  s: "s",
  strike: "s",
  del: "s",
  small: "small",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
  ul: "ul",
  ol: "ol",
  li: "li",
  table: "table",
  thead: "thead",
  tbody: "tbody",
  // A footer row group is rare in Teams tables and reads the same as a body one.
  tfoot: "tbody",
  tr: "tr",
  td: "td",
  th: "th",
  a: "a",
  img: "img",
};

// Tags whose entire subtree is discarded (never rendered). `colgroup` holds only
// `<col>` sizing hints, and we drop presentational attributes, so it can carry
// nothing renderable.
const DROP_SUBTREE = new Set([
  "script",
  "style",
  "head",
  "title",
  "iframe",
  "object",
  "embed",
  "colgroup",
]);

// Void elements never have children / a closing tag.
const VOID_TAGS = new Set(["br", "img", "hr", "wbr", "col", "area", "input"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Decode the handful of HTML entities Teams emits, plus numeric references. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Allow only safe, non-executable URL schemes for links. */
function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const url = decodeEntities(raw).trim();
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  // Protocol-relative and fragment/relative links are harmless for display.
  if (/^(\/\/|\/|#)/.test(url)) return url;
  return undefined;
}

/** Allow only safe image sources (remote http(s) or inline data:image). */
function safeSrc(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const url = decodeEntities(raw).trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^data:image\//i.test(url)) return url;
  return undefined;
}

type RawAttrs = Record<string, string>;

function parseAttributes(source: string): RawAttrs {
  const attrs: RawAttrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return attrs;
}

/** A Teams @mention is a span carrying the Skype Mention itemtype. */
function isMention(attrs: RawAttrs): boolean {
  const itemtype = attrs["itemtype"] ?? "";
  return /schema\.skype\.com\/Mention/i.test(itemtype);
}

/** The person an outbound mention names, when the markup says so and the value is a
 *  person MRI. Only the composer's own markup carries it, and only `8:…` identities are
 *  people — a `19:` thread or a `28:` app is not somebody a person-mention may name, and
 *  the backend refuses one anyway. */
function mentionMri(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const mri = decodeEntities(raw).trim();
  return /^8:[A-Za-z0-9:._@-]{1,120}$/.test(mri) ? mri : undefined;
}

/** An app link-unfurl card: a span carrying the Skype InputExtension itemtype. */
function isInputExtension(attrs: RawAttrs): boolean {
  return /schema\.skype\.com\/InputExtension/i.test(attrs["itemtype"] ?? "");
}

/**
 * A Teams inline emoji: not a picture but a glyph, sent as a 20 px `<img>` off
 * the "personal expressions" CDN and carrying the emoji itself in `alt`. Both
 * signals are accepted — the Skype `Emoji` itemtype, and the CDN path for the
 * (older) markup that omits it — because rendering one as an image breaks the
 * line, frames it like a photo, and makes it click-to-zoom.
 */
function isEmojiImage(attrs: RawAttrs): boolean {
  if (/schema\.skype\.com\/Emoji/i.test(attrs["itemtype"] ?? "")) return true;
  return /\/personal-expressions\//i.test(decodeEntities(attrs["src"] ?? ""));
}

/**
 * Was this element hidden by its author? Relayed HTML emails open with a
 * "preheader" — a `display:none` div holding the inbox teaser line ("New issue
 * from internal.") — and hide tracking pixels the same way. No mail client shows
 * those, so neither do we: the element's whole subtree is discarded.
 */
function isHidden(attrs: RawAttrs): boolean {
  if (attrs["hidden"] !== undefined && attrs["hidden"].toLowerCase() !== "false") return true;
  const style = decodeEntities(attrs["style"] ?? "");
  return /(^|[;\s])(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style);
}

/** A `colspan`/`rowspan` value, kept only when it is a sane multi-cell span. */
function cellSpan(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value < 2 || value > 64) return undefined;
  return value;
}

type OpenFrame = { tag: RichTag | null; children: RichNode[] };

/** The semantic tags a `<span>` can open, and that its `</span>` closes. */
const SPAN_FRAME_TAGS: readonly RichTag[] = ["mention", "card"];

/**
 * Parse a Teams HTML fragment into a safe rich-node tree.
 *
 * Unknown tags are unwrapped (children preserved); script/style-like subtrees are
 * dropped entirely; text is entity-decoded; hrefs and image sources are
 * scheme-checked. The result contains only allowlisted tags and attributes.
 */
export function parseRichHtml(html: string): RichNode[] {
  const root: OpenFrame = { tag: null, children: [] };
  const stack: OpenFrame[] = [root];
  // Open tags inside a discarded subtree (a <script>, or an element its author
  // hid — see isHidden). Non-empty means "skip everything": the region ends at
  // the close tag matching its first entry, so nested tags of the same name — an
  // email preheader is a hidden <div> full of <div>s — cannot end it early.
  const dropped: string[] = [];
  // Open <span> tags, and whether each opened a frame (a mention or an app card)
  // or was unwrapped. A </span> closes the innermost span that opened a frame,
  // and only that one: without this bookkeeping a plain <span> nested inside a
  // mention would, on its closing tag, close the mention around it — spilling
  // the rest of the message into the mention's accent color.
  const spans: ("frame" | "plain")[] = [];

  const top = (): OpenFrame => stack[stack.length - 1]!;
  const pushChild = (node: RichNode) => top().children.push(node);

  // Close the nearest open frame carrying one of `targets`, emitting any frame
  // left open inside it (malformed input) on the way out.
  const closeFrame = (targets: readonly RichTag[]) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (!targets.includes(stack[i]!.tag!)) continue;
      while (stack.length - 1 >= i) {
        const frame = stack.pop()!;
        top().children.push({
          type: "element",
          tag: frame.tag!,
          attrs: (frame as OpenFrame & { attrs?: RichAttrs }).attrs ?? {},
          children: frame.children,
        });
      }
      return;
    }
  };

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)\/?>|<!--[\s\S]*?-->/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  const emitText = (rawText: string) => {
    if (dropped.length > 0 || rawText.length === 0) return;
    const text = decodeEntities(rawText);
    if (text.length > 0) pushChild({ type: "text", text });
  };

  while ((m = tagRe.exec(html)) !== null) {
    emitText(html.slice(lastIndex, m.index));
    lastIndex = tagRe.lastIndex;

    const whole = m[0];
    if (whole.startsWith("<!--")) continue; // comment

    const rawName = m[1]?.toLowerCase();
    if (!rawName) continue;
    const isClose = whole[1] === "/";

    // ---- inside a discarded subtree: track nesting until it closes ----------
    if (dropped.length > 0) {
      if (isClose) {
        // Closing the tag that opened the region ends it; a close tag for
        // something never opened is ignored, and one that skips over tags the
        // subtree left open unwinds them too.
        const at = dropped.lastIndexOf(rawName);
        if (at >= 0) dropped.length = at;
      } else if (!VOID_TAGS.has(rawName) && !whole.endsWith("/>")) {
        dropped.push(rawName);
      }
      continue;
    }

    if (isClose) {
      // A mention or an app card is opened as a <span> but recorded under its own
      // semantic tag, so its closing </span> must target that frame — `spans`
      // says which span opened one. Unwrapped spans have no frame, so their
      // closing tag is harmlessly skipped.
      if (rawName === "span") {
        if (spans.pop() === "frame") closeFrame(SPAN_FRAME_TAGS);
        continue;
      }
      const mapped = TAG_MAP[rawName];
      if (!mapped || VOID_TAGS.has(rawName)) continue;
      closeFrame([mapped]);
      continue;
    }

    // ---- opening tag -------------------------------------------------------
    const attrs = parseAttributes(m[2] ?? "");
    const isSelfClosing = whole.endsWith("/>");

    // Never-rendered subtrees, and anything the author hid: both are skipped
    // whole, so hidden text (an email preheader) never reaches the reader.
    if (DROP_SUBTREE.has(rawName) || isHidden(attrs)) {
      if (!VOID_TAGS.has(rawName) && !isSelfClosing) dropped.push(rawName);
      continue;
    }

    if (rawName === "span") {
      const frameTag: RichTag | null = isMention(attrs)
        ? "mention"
        : isInputExtension(attrs)
        ? "card"
        : null;
      if (!isSelfClosing) spans.push(frameTag ? "frame" : "plain");
      if (frameTag) {
        const itemid = attrs["itemid"];
        const mri = frameTag === "mention" ? mentionMri(attrs["data-mri"]) : undefined;
        const frame: OpenFrame & { attrs: RichAttrs } = {
          tag: frameTag,
          attrs: {
            ...(itemid ? { itemid: decodeEntities(itemid).trim() } : {}),
            ...(mri ? { mri } : {}),
          },
          children: [],
        };
        if (!isSelfClosing) stack.push(frame);
        else pushChild({ type: "element", tag: frameTag, attrs: frame.attrs, children: [] });
      }
      continue;
    }

    const mapped = TAG_MAP[rawName];
    if (!mapped) continue; // unknown tag: unwrap (children handled inline)

    if (mapped === "br" || mapped === "hr") {
      pushChild({ type: "element", tag: mapped, attrs: {}, children: [] });
      continue;
    }

    if (mapped === "img") {
      // A Teams emoji is a glyph wearing an <img>'s clothes: emit the character
      // it carries as inline text instead of a picture (see isEmojiImage).
      if (isEmojiImage(attrs)) {
        const glyph = decodeEntities(attrs["alt"] ?? attrs["title"] ?? "").trim();
        if (glyph) pushChild({ type: "text", text: glyph });
        continue;
      }
      const src = safeSrc(attrs["src"]);
      if (src) {
        const alt = attrs["alt"] ? decodeEntities(attrs["alt"]) : undefined;
        pushChild({ type: "element", tag: "img", attrs: { src, alt }, children: [] });
      }
      continue;
    }

    const richAttrs: RichAttrs = {};
    if (mapped === "a") {
      const href = safeHref(attrs["href"]);
      if (href) richAttrs.href = href;
    }
    if (mapped === "td" || mapped === "th") {
      const colspan = cellSpan(attrs["colspan"]);
      const rowspan = cellSpan(attrs["rowspan"]);
      if (colspan) richAttrs.colspan = colspan;
      if (rowspan) richAttrs.rowspan = rowspan;
    }

    if (isSelfClosing) {
      pushChild({ type: "element", tag: mapped, attrs: richAttrs, children: [] });
      continue;
    }

    const frame: OpenFrame & { attrs: RichAttrs } = { tag: mapped, attrs: richAttrs, children: [] };
    stack.push(frame);
  }

  emitText(html.slice(lastIndex));

  // Close any tags left open by malformed input, innermost first.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    top().children.push({
      type: "element",
      tag: frame.tag!,
      attrs: (frame as OpenFrame & { attrs?: RichAttrs }).attrs ?? {},
      children: frame.children,
    });
  }

  return reshapeTables(normalize(root.children), "flow");
}

// ---- plain-text bodies ----------------------------------------------------

/** A bare URL inside plain text. Stops at whitespace and at the characters that
 *  are almost always punctuation around a link rather than part of it. */
const BARE_URL = /https?:\/\/[^\s<>"']+/g;

/** Trailing punctuation that belongs to the sentence, not to the URL — "see
 *  https://example.com." links to `example.com`, not to `example.com.`. A closing
 *  bracket is only trimmed when the URL has no matching opener.
 *
 *  Exported for the card-text parser, which linkifies bare URLs the same way (see
 *  `parseCardMarkdown`) — one rule for where a URL ends, not two that drift. */
export function trimUrlPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (".,;:!?".includes(ch)) end -= 1;
    else if (ch === ")" && !url.slice(0, end).includes("(")) end -= 1;
    else if (ch === "]" && !url.slice(0, end).includes("[")) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

/**
 * Parse a PLAIN-text message body (Teams `messagetype: Text`) into the same node
 * tree the HTML path produces, so everything downstream — rendering, emptiness
 * checks, link extraction — works on it unchanged.
 *
 * The text is taken verbatim: nothing is entity-decoded and nothing is treated as
 * markup, because it is not markup. That is the whole point — a body like
 * `pour moi c'est <yyyy>-<id>` or `Vec<String>` loses its angle-bracketed parts the
 * moment it goes through an HTML parser. Newlines survive as text (the renderer
 * wraps bodies in `whitespace-pre-wrap`), and a bare URL becomes a real link so a
 * pasted link stays clickable, the way it is in an HTML body.
 */
export function parsePlainText(text: string): RichNode[] {
  const nodes: RichNode[] = [];
  let at = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const raw = match[0];
    const href = trimUrlPunctuation(raw);
    // A "URL" that is nothing but scheme and punctuation is left as text.
    if (!/^https?:\/\/\S/i.test(href)) continue;
    const start = match.index ?? 0;
    if (start > at) nodes.push({ type: "text", text: text.slice(at, start) });
    nodes.push({ type: "element", tag: "a", attrs: { href }, children: [{ type: "text", text: href }] });
    at = start + href.length;
  }
  if (at < text.length) nodes.push({ type: "text", text: text.slice(at) });
  return nodes.filter((node) => node.type !== "text" || node.text.length > 0);
}

/** Parse a message body the way its {@link BodyFormat} says it must be read: the
 *  bounded Teams HTML subset, or verbatim plain text. The single choke point every
 *  caller goes through, so no path can accidentally read a `Text` body as HTML. */
export function parseMessageBody(body: string, format: BodyFormat): RichNode[] {
  return format === "text" ? parsePlainText(body) : parseRichHtml(body);
}

// Block-level tags: whitespace in the source HTML that merely separates these
// is insignificant (a browser collapses it). Whitespace between inline elements
// is significant and must be preserved.
const BLOCK_TAGS = new Set<RichTag>([
  "p",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "pre",
  "blockquote",
  "br",
  "hr",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "card",
]);

/** Tags that render as a heading — a block whose emptiness makes it droppable. */
const HEADING_TAGS = new Set<RichTag>(["h1", "h2", "h3"]);

function isBlockElement(node: RichNode): boolean {
  return node.type === "element" && BLOCK_TAGS.has(node.tag);
}

/**
 * Clean the parsed tree so it renders without spurious blank lines:
 *  - drop empty text nodes;
 *  - drop paragraphs with no visible content (Teams' `<p></p>` / `<p>&nbsp;</p>`
 *    reply spacers, which otherwise show as an empty line between a quote and
 *    its body);
 *  - drop whitespace-only text at a fragment edge or between block elements
 *    (insignificant in HTML, but our `whitespace-pre-wrap` rendering would
 *    otherwise surface it as a blank line — e.g. the newline a tenant may put
 *    between a reply's quote and its body).
 */
function normalize(nodes: RichNode[]): RichNode[] {
  const cleaned: RichNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.text.length === 0) continue;
      cleaned.push(node);
      continue;
    }
    node.children = normalize(node.children);
    // Empty paragraphs and headings are spacers, never content: Teams' `<p></p>`
    // reply spacer, or the `<p itemtype=".../CodeBlockEditor">&nbsp;</p>` marker
    // it puts in front of a code block, would otherwise show as a blank line.
    if ((node.tag === "p" || HEADING_TAGS.has(node.tag)) && !hasVisibleContent(node.children))
      continue;
    cleaned.push(node);
  }
  // Whitespace-only text is insignificant at a fragment edge and between block
  // elements. Neighbouring whitespace is looked *through*, so the newlines left
  // behind by the spacer paragraphs dropped above collapse with them instead of
  // surviving as a run of blank lines.
  const isSpace = (node: RichNode | undefined): boolean =>
    node !== undefined && node.type === "text" && node.text.trim().length === 0;
  const neighbour = (from: number, step: number): RichNode | undefined => {
    for (let i = from + step; i >= 0 && i < cleaned.length; i += step) {
      if (!isSpace(cleaned[i])) return cleaned[i];
    }
    return undefined;
  };
  return cleaned.filter((node, i) => {
    if (node.type !== "text" || node.text.trim().length > 0) return true;
    const prev = neighbour(i, -1);
    const next = neighbour(i, 1);
    if (prev === undefined || next === undefined) return false; // edge whitespace
    return !isBlockElement(prev) && !isBlockElement(next);
  });
}

// ---- tables ---------------------------------------------------------------

const TABLE_SECTION_TAGS = new Set<RichTag>(["thead", "tbody"]);
const TABLE_TAGS = new Set<RichTag>(["table", "thead", "tbody", "tr", "td", "th"]);

/** Which table slot a node sits in: table structure is only valid in its own. */
type TableSlot = "flow" | "table" | "section" | "row";

export type RichElement = Extract<RichNode, { type: "element" }>;

function element(tag: RichTag, children: RichNode[]): RichElement {
  return { type: "element", tag, attrs: {}, children };
}

/**
 * Make every table in the tree structurally valid, so the renderer can emit real
 * `<table>` DOM instead of flattening each cell onto its own line.
 *
 * Real-world table HTML — Teams' own editor, and the layout tables in relayed
 * emails — is only loosely nested, and our tolerant parser preserves whatever it
 * was given, so this pass restores the invariants a renderer needs:
 *  - a `table` holds only `thead`/`tbody`; bare rows get an implicit `tbody`;
 *  - a section holds only rows; bare cells get an implicit `tr`;
 *  - a row holds only cells; anything else in one is wrapped into a cell;
 *  - a stray row/cell/section *outside* a table is unwrapped, keeping its text;
 *  - an empty cell keeps its slot but not its `&nbsp;` filler, an all-empty row
 *    is dropped, and a table with nothing left in it disappears entirely.
 */
function reshapeTables(nodes: RichNode[], slot: TableSlot): RichNode[] {
  const out: RichNode[] = [];
  // Content that is not valid in this slot and must be wrapped to become valid
  // (text sitting directly in a row, a nested layout table in a section, …).
  let stray: RichNode[] = [];
  // Consecutive rows found straight inside a table, or cells straight inside a
  // section: each run shares one implicit wrapper.
  let implicit: RichNode[] = [];

  const flushStray = () => {
    if (stray.length === 0) return;
    const run = stray;
    stray = [];
    if (!hasVisibleContent(run)) return; // layout whitespace between rows/cells
    if (slot === "row") out.push(element("td", run));
    else if (slot === "section") out.push(element("tr", [element("td", run)]));
    else if (slot === "table") out.push(element("tbody", [element("tr", [element("td", run)])]));
  };
  const flushImplicit = () => {
    if (implicit.length === 0) return;
    const run = implicit;
    implicit = [];
    out.push(element(slot === "table" ? "tbody" : "tr", run));
  };
  const emit = (node: RichNode) => {
    flushStray();
    flushImplicit();
    out.push(node);
  };
  const addStray = (node: RichNode) => {
    flushImplicit();
    stray.push(node);
  };
  const addImplicit = (node: RichNode) => {
    flushStray();
    implicit.push(node);
  };

  for (const node of nodes) {
    if (node.type === "text") {
      if (slot === "flow") emit(node);
      else addStray(node);
      continue;
    }
    if (!TABLE_TAGS.has(node.tag)) {
      node.children = reshapeTables(node.children, "flow");
      if (slot === "flow") emit(node);
      else addStray(node);
      continue;
    }
    if (node.tag === "table") {
      const table = reshapeTable(node);
      if (!table) continue; // an empty layout table: nothing to render
      if (slot === "flow") emit(table);
      else addStray(table);
      continue;
    }
    if (TABLE_SECTION_TAGS.has(node.tag)) {
      if (slot === "table") {
        node.children = reshapeTables(node.children, "section");
        emit(node);
      } else {
        // A section outside a table: unwrap it into this slot, keeping content.
        for (const child of reshapeTables(node.children, slot)) emit(child);
      }
      continue;
    }
    if (node.tag === "tr") {
      if (slot === "section" || slot === "table") {
        node.children = reshapeTables(node.children, "row");
        if (slot === "section") emit(node);
        else addImplicit(node);
      } else {
        for (const child of reshapeTables(node.children, slot)) emit(child);
      }
      continue;
    }
    // A cell.
    if (slot === "row" || slot === "section") {
      node.children = reshapeTables(node.children, "flow");
      if (slot === "row") emit(node);
      else addImplicit(node);
    } else {
      for (const child of reshapeTables(node.children, slot)) emit(child);
    }
  }

  flushStray();
  flushImplicit();
  return out;
}

/** Reshape a table's contents and prune what is not worth rendering. */
function reshapeTable(table: RichElement): RichElement | null {
  const sections: RichNode[] = [];
  for (const section of reshapeTables(table.children, "table")) {
    if (section.type !== "element") continue;
    section.children = section.children.filter((row) => {
      if (row.type !== "element") return false;
      for (const cell of row.children) {
        // An empty cell keeps its slot — dropping it would shift every following
        // column — but not its `&nbsp;` filler, which would render a blank line.
        if (cell.type === "element" && !hasVisibleContent(cell.children)) cell.children = [];
      }
      return row.children.some((cell) => cell.type === "element" && cell.children.length > 0);
    });
    if (section.children.length > 0) sections.push(section);
  }
  if (sections.length === 0) return null;
  table.children = sections;
  return table;
}

/** Does this fragment contain any renderable content? (used to hide empties) */
export function hasVisibleContent(nodes: RichNode[]): boolean {
  return nodes.some((node) => {
    if (node.type === "text") return node.text.trim().length > 0;
    if (node.tag === "br" || node.tag === "hr") return false;
    if (node.tag === "img") return true;
    // An app card always renders something, even when the payload never made it
    // into the HTML (the renderer says so explicitly).
    if (node.tag === "card") return true;
    return hasVisibleContent(node.children);
  });
}

/**
 * Like {@link hasVisibleContent}, but images do NOT count as content. Used to
 * tell an image-only message (text-free, just a picture) apart from one that
 * also carries real text: the former drops its chat bubble.
 */
export function hasNonImageContent(nodes: RichNode[]): boolean {
  return nodes.some((node) => {
    if (node.type === "text") return node.text.trim().length > 0;
    if (node.tag === "br" || node.tag === "hr" || node.tag === "img") return false;
    if (node.tag === "card") return true;
    return hasNonImageContent(node.children);
  });
}

// ---- relayed HTML emails --------------------------------------------------

/**
 * A line pulled out of a relayed email: a heading's text, plus the link it wraps
 * when it has one (a Sentry digest makes every issue title a link).
 */
export type EmailHeadline = { text: string; href?: string };

/**
 * The gist of an HTML email relayed into a channel, enough to render a compact
 * summary instead of the email itself. See {@link parseRelayedEmail}.
 */
export type RelayedEmail = {
  /** The email's subject: its first heading with visible text (or, failing that,
   *  its first short paragraph). Empty only for an email with no text at all. */
  subject: string;
  /** The headings under the subject — a digest's issue titles, in order. */
  headlines: EmailHeadline[];
  /** The email's call to action ("View on Sentry", …), when it has one. */
  action?: { label: string; href: string };
};

// Markers that identify a relayed email rather than a Teams-composed message:
// the schema.org microdata Outlook attaches, and the `mso-hide` rule that hides
// an email's preheader. A message Teams' own composer produced has neither.
const RELAYED_EMAIL_MARKERS = [/schema\.org\/EmailMessage/i, /mso-hide\s*:\s*all/i];

/** An action link's label reads like an invitation to open the thing. */
const ACTION_LABEL = /^(view|open|see|read|go to|show|review)\b/i;

/** How many headlines a summary lists, and how long a single line may get. */
const MAX_HEADLINES = 6;
const MAX_LINE = 160;

/** Is this HTML body an email relayed into a channel rather than a chat message? */
export function isRelayedEmail(html: string): boolean {
  return RELAYED_EMAIL_MARKERS.some((marker) => marker.test(html));
}

/** The visible text of a fragment, with `<br>` counting as a space. */
export function nodeText(nodes: RichNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.text;
    else if (node.tag === "br") out += " ";
    else out += nodeText(node.children);
  }
  return out;
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LINE ? `${collapsed.slice(0, MAX_LINE - 1).trimEnd()}…` : collapsed;
}

/** The first `http(s)` link in a fragment, used to make a headline clickable. */
function firstHref(nodes: RichNode[]): string | undefined {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.tag === "a" && node.attrs.href && /^https?:\/\//i.test(node.attrs.href))
      return node.attrs.href;
    const nested = firstHref(node.children);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Summarize a relayed HTML email: its subject, the headings beneath it, and its
 * call-to-action link. Returns `null` for anything that is not a relayed email
 * (see {@link isRelayedEmail}), so an ordinary message renders normally.
 *
 * Full marketing-grade email HTML — nested layout tables, a logo, a tracking
 * pixel, a footer of unsubscribe links — is a wall of text inside a chat bubble.
 * The parts worth reading are the headings and the one link that goes back to the
 * source, so that is all a summary keeps: no images (so no logo or tracking pixel
 * becomes a zoomable picture card) and no layout tables. The hidden preheader
 * never even reaches here — {@link parseRichHtml} drops `display:none` subtrees.
 */
export function parseRelayedEmail(html: string): RelayedEmail | null {
  if (!isRelayedEmail(html)) return null;

  const headings: EmailHeadline[] = [];
  const actions: { label: string; href: string }[] = [];
  // Fallback subject for an email that has no headings at all: its first short
  // block of text. Long blocks are the layout wrappers around it, so they lose.
  let firstBlock = "";

  const walk = (nodes: RichNode[]): void => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (HEADING_TAGS.has(node.tag)) {
        const text = oneLine(nodeText([node]));
        const href = firstHref(node.children);
        // A logo-only heading has no text; there is nothing to show for it.
        if (text) headings.push(href ? { text, href } : { text });
        continue; // a heading's own links belong to it, not to the action
      }
      if (node.tag === "a") {
        const label = oneLine(nodeText(node.children));
        const href = node.attrs.href;
        if (label && href && /^https?:\/\//i.test(href) && ACTION_LABEL.test(label))
          actions.push({ label, href });
        continue;
      }
      if (node.tag === "p" && !firstBlock) {
        const text = oneLine(nodeText([node]));
        if (text.length >= 3 && text.length < MAX_LINE) firstBlock = text;
      }
      walk(node.children);
    }
  };
  walk(parseRichHtml(html));

  const [subject, ...rest] = headings;
  const seen = new Set<string>();
  const unique = rest.filter((line) => {
    if (seen.has(line.text) || line.text === subject?.text) return false;
    seen.add(line.text);
    return true;
  });
  // A digest links every item it lists, and its remaining headings are just
  // section labels ("Exception", "Tags") — so when any headline is a link, those
  // are the ones worth listing. An email whose headings link nowhere keeps them.
  const linked = unique.filter((line) => line.href !== undefined);
  const headlines = (linked.length > 0 ? linked : unique).slice(0, MAX_HEADLINES);
  const summary: RelayedEmail = {
    subject: subject?.text ?? firstBlock,
    headlines,
    ...(actions[0] ? { action: actions[0] } : {}),
  };
  // Nothing to summarize (an email of nothing but images, say): let the body
  // render the ordinary way rather than showing an empty summary card.
  if (!summary.subject && headlines.length === 0 && !summary.action) return null;
  return summary;
}

/** Whether the fragment contains at least one inline `<img>`. */
export function containsImage(nodes: RichNode[]): boolean {
  return nodes.some(
    (node) => node.type === "element" && (node.tag === "img" || containsImage(node.children)),
  );
}

/**
 * Collect every `http(s)` link in a message body, in document order and
 * de-duplicated. Reuses the same parser used to render, so an HTML body yields only
 * its real `<a href>` links (never a URL that merely appears in text) and a plain
 * body yields the bare URLs it does render as links. Used to detect link-preview
 * candidates (e.g. GitLab links) in a message.
 */
export function extractLinks(body: string, format: BodyFormat = "html"): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (nodes: RichNode[]): void => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (node.tag === "a") {
        const href = node.attrs.href;
        if (href && /^https?:\/\//i.test(href) && !seen.has(href)) {
          seen.add(href);
          out.push(href);
        }
      }
      walk(node.children);
    }
  };
  walk(parseMessageBody(body, format));
  return out;
}

/**
 * Remove anchor nodes whose href is in `hidden`, re-normalizing so no empty
 * blocks or stray blank lines remain. Used to drop a link from the rendered
 * message body when it is shown as a rich preview card instead — so the link is
 * never displayed twice (once as text, once as the card).
 */
export function dropLinks(nodes: RichNode[], hidden: Set<string>): RichNode[] {
  if (hidden.size === 0) return nodes;
  const prune = (list: RichNode[]): RichNode[] => {
    const out: RichNode[] = [];
    for (const node of list) {
      if (node.type === "element") {
        if (node.tag === "a" && node.attrs.href && hidden.has(node.attrs.href)) continue;
        node.children = prune(node.children);
      }
      out.push(node);
    }
    return out;
  };
  return normalize(prune(nodes));
}

/** Nothing but whitespace — the `&nbsp;` Teams writes between two spans included. */
function isBlankText(node: RichNode): boolean {
  return node.type === "text" && /^\s+$/.test(node.text);
}

/**
 * Join a run of adjacent mention spans that name the SAME person into one mention.
 *
 * Teams splits a mention across the WORDS of the name it shows: "Clément BOSLE"
 * arrives as two spans, with two `itemid`s, and two entries in the message's mention
 * list carrying one MRI. Its own client only tints the words, so the split never
 * shows there; a chip draws it as two mentions of two people. One person, one chip.
 *
 * `identityOf` says who a span names, and the merge happens only when it answers the
 * same identity for both — the whitespace between the words is kept inside the chip.
 * A span nobody can resolve stays on its own, because "@Alice @Bob" is also two
 * adjacent spans and joining those would draw a person nobody mentioned. A separator
 * that is not whitespace (a comma between two mentioned people) ends the run for the
 * same reason.
 */
export function mergeAdjacentMentions(
  nodes: RichNode[],
  identityOf: (mention: RichElement) => string | undefined,
): RichNode[] {
  const merge = (list: RichNode[]): RichNode[] => {
    const out: RichNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const node = list[i]!;
      if (node.type !== "element") {
        out.push(node);
        continue;
      }
      if (node.tag !== "mention") {
        out.push({ ...node, children: merge(node.children) });
        continue;
      }
      const identity = identityOf(node);
      const children = [...node.children];
      // The last index folded into this chip: `i` while the run is one span long.
      let end = i;
      while (identity !== undefined) {
        // Whitespace between the two spans belongs to the name, so it is only
        // carried over once the span after it turns out to be the same person.
        let next = end + 1;
        const gap: RichNode[] = [];
        while (next < list.length && isBlankText(list[next]!)) gap.push(list[next++]!);
        const candidate = list[next];
        if (
          !candidate ||
          candidate.type !== "element" ||
          candidate.tag !== "mention" ||
          identityOf(candidate) !== identity
        ) {
          break;
        }
        children.push(...gap, ...candidate.children);
        end = next;
      }
      out.push(end === i ? node : { type: "element", tag: "mention", attrs: node.attrs, children });
      i = end;
    }
    return out;
  };
  return merge(nodes);
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

// Tags emitted verbatim (their name is safe and self-contained).
const SIMPLE_TAGS: Partial<Record<RichTag, string>> = {
  p: "p",
  strong: "strong",
  em: "em",
  u: "u",
  s: "s",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
  ul: "ul",
  ol: "ol",
  li: "li",
};

/** The outbound form of one @mention: the Teams span the body carries, and the entry
 *  that says who its index names. See {@link serializeTeamsMessage}. */
export type SerializedMention = {
  itemid: number;
  mri: string;
  display_name: string;
};

/** Collects the mentions found while serializing, and hands out their indices. */
type MentionSink = { mentions: SerializedMention[] };

function serializeNodes(nodes: RichNode[], sink?: MentionSink): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += escapeText(node.text);
      continue;
    }
    if (node.tag === "br") {
      out += "<br>";
      continue;
    }
    if (node.tag === "img") {
      if (node.attrs.src) {
        const alt = node.attrs.alt ? ` alt="${escapeAttr(node.attrs.alt)}"` : "";
        out += `<img src="${escapeAttr(node.attrs.src)}"${alt}>`;
      }
      continue;
    }
    if (node.tag === "a") {
      const inner = serializeNodes(node.children, sink);
      out += node.attrs.href
        ? `<a href="${escapeAttr(node.attrs.href)}">${inner}</a>`
        : inner;
      continue;
    }
    if (node.tag === "mention") {
      const label = serializeNodes(node.children, sink);
      const mri = node.attrs.mri;
      // A mention we know the person behind goes out as a real Teams mention: an
      // indexed span here, and an entry in the `mentions` list the send carries
      // (which is what notifies them). One without an MRI — inbound markup that was
      // pasted back in, say — is just its text, exactly as before: a message must
      // never carry blue text that pings nobody.
      if (!mri || !sink) {
        out += label;
        continue;
      }
      const displayName = nodeText(node.children).trim();
      // Nothing left to show: the author deleted every word of the name. A span with no
      // text pings a person the message does not name, so this one goes out as text.
      if (!displayName) {
        out += label;
        continue;
      }
      const itemid = sink.mentions.length;
      sink.mentions.push({ itemid, mri, display_name: displayName });
      out +=
        `<span itemscope="" itemtype="http://schema.skype.com/Mention" ` +
        `itemid="${itemid}">${label}</span>`;
      continue;
    }
    const tag = SIMPLE_TAGS[node.tag];
    // Anything outside the Teams-safe *outbound* subset (a heading, a table cell,
    // an app card) is unwrapped rather than dropped: what we send loses the
    // structure Teams' composer can't express, never the words.
    out += tag
      ? `<${tag}>${serializeNodes(node.children, sink)}</${tag}>`
      : serializeNodes(node.children, sink);
  }
  return out;
}

/** Which edge of a message body a trim works on. */
type Edge = "start" | "end";

// Tags whose own whitespace is content, so an edge trim stops at them: a code
// block keeps the indentation of its first line, and an image or a card IS the
// edge of the message.
const UNTRIMMED_EDGE_TAGS = new Set<RichTag>(["pre", "code", "img", "card"]);

/**
 * Trim one edge of a message body, in place of the text `trim()` a plain send
 * gets: drop the whitespace and the hard breaks the editor leaves there, and
 * drop a block that holds nothing else.
 *
 * `normalize` already drops an empty paragraph and the whitespace between two
 * blocks, so what is left for this pass is the edge *inside* the first and the
 * last block — the `<br>` a Shift+Enter added on the last line, and the spaces
 * around the words.
 */
function trimEdge(nodes: RichNode[], edge: Edge): RichNode[] {
  const at = edge === "start" ? 0 : nodes.length - 1;
  const node = nodes[at];
  if (node === undefined) return nodes;
  const trimmed = trimEdgeNode(node, edge);
  const out = [...nodes];
  if (trimmed === null) {
    out.splice(at, 1);
    return trimEdge(out, edge); // the node behind it is the new edge
  }
  out[at] = trimmed;
  return out;
}

/** Trim one node standing at `edge`, or return null when nothing of it is left. */
function trimEdgeNode(node: RichNode, edge: Edge): RichNode | null {
  if (node.type === "text") {
    const text = edge === "start" ? node.text.trimStart() : node.text.trimEnd();
    return text.length === 0 ? null : { type: "text", text };
  }
  if (node.tag === "br") return null;
  if (UNTRIMMED_EDGE_TAGS.has(node.tag)) return node;
  const children = trimEdge(node.children, edge);
  return hasVisibleContent(children) ? { ...node, children } : null;
}

/**
 * Normalize arbitrary editor HTML (e.g. TipTap's `getHTML()`) into the bounded,
 * Teams-safe HTML subset by round-tripping it through the same allowlist used to
 * render inbound messages. Only allowlisted tags/attributes survive, so this is
 * the single choke point that guarantees what we send matches what we render.
 * Returns an empty string when there is no visible content.
 *
 * The body is also trimmed at both edges, because a leading or a trailing blank
 * line is not content: the reader gets nothing from it, and Teams keeps it for
 * as long as the message exists.
 */
export function serializeTeamsHtml(html: string): string {
  return serializeTeamsMessage(html).html;
}

/**
 * The whole outbound message: the Teams-safe HTML body (see {@link serializeTeamsHtml})
 * plus who its @mentions name.
 *
 * A Teams mention is a pair, and this is where the pair is made: the body gets a span
 * carrying only an index, and `mentions` says which person each index is. Indices are
 * assigned in document order, so the list matches the reading order of the message.
 * Verified end-to-end against the tenant — see examples/mention_send_probe.rs.
 */
export function serializeTeamsMessage(html: string): {
  html: string;
  mentions: SerializedMention[];
} {
  const nodes = parseRichHtml(html);
  if (!hasVisibleContent(nodes)) return { html: "", mentions: [] };
  const sink: MentionSink = { mentions: [] };
  const body = serializeNodes(trimEdge(trimEdge(nodes, "start"), "end"), sink);
  // A mention whose text was emptied (the author deleted every word of the name) shows
  // nothing, so it names nobody: the backend refuses a mention with no visible span,
  // and it is right to.
  return { html: body, mentions: sink.mentions };
}

