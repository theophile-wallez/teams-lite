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

/** A semantic element tag we know how to render. */
export type RichTag =
  | "p"
  | "br"
  | "strong"
  | "em"
  | "u"
  | "s"
  | "code"
  | "pre"
  | "blockquote"
  | "ul"
  | "ol"
  | "li"
  | "a"
  | "img"
  | "mention";

export type RichAttrs = {
  href?: string;
  src?: string;
  alt?: string;
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
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  u: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
  ul: "ul",
  ol: "ol",
  li: "li",
  a: "a",
  img: "img",
};

// Tags whose entire subtree is discarded (never rendered).
const DROP_SUBTREE = new Set(["script", "style", "head", "title", "iframe", "object", "embed"]);

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

type OpenFrame = { tag: RichTag | null; children: RichNode[] };

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
  // Depth of an open drop-subtree tag (e.g. <script>); >0 means skip everything.
  let dropDepth = 0;
  const dropStack: string[] = [];

  const top = (): OpenFrame => stack[stack.length - 1]!;
  const pushChild = (node: RichNode) => top().children.push(node);

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)\/?>|<!--[\s\S]*?-->/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  const emitText = (rawText: string) => {
    if (dropDepth > 0 || rawText.length === 0) return;
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

    // ---- inside a dropped subtree: only track matching open/close ----------
    if (dropDepth > 0) {
      if (!isClose && DROP_SUBTREE.has(rawName) && !VOID_TAGS.has(rawName)) {
        dropStack.push(rawName);
        dropDepth++;
      } else if (isClose && dropStack[dropStack.length - 1] === rawName) {
        dropStack.pop();
        dropDepth--;
      }
      continue;
    }

    if (isClose) {
      const mapped = TAG_MAP[rawName];
      if (!mapped || VOID_TAGS.has(rawName)) continue;
      // Close the nearest matching open frame, unwinding any that stayed open.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === mapped) {
          while (stack.length - 1 >= i) {
            const frame = stack.pop()!;
            top().children.push({
              type: "element",
              tag: frame.tag!,
              attrs: (frame as OpenFrame & { attrs?: RichAttrs }).attrs ?? {},
              children: frame.children,
            });
          }
          break;
        }
      }
      continue;
    }

    // ---- opening tag -------------------------------------------------------
    if (DROP_SUBTREE.has(rawName)) {
      if (!VOID_TAGS.has(rawName)) {
        dropStack.push(rawName);
        dropDepth++;
      }
      continue;
    }

    const attrs = parseAttributes(m[2] ?? "");

    if (rawName === "span" && isMention(attrs)) {
      const frame: OpenFrame & { attrs: RichAttrs } = { tag: "mention", attrs: {}, children: [] };
      stack.push(frame);
      continue;
    }

    const mapped = TAG_MAP[rawName];
    if (!mapped) continue; // unknown tag: unwrap (children handled inline)

    if (mapped === "br") {
      pushChild({ type: "element", tag: "br", attrs: {}, children: [] });
      continue;
    }

    if (mapped === "img") {
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

    const isSelfClosing = whole.endsWith("/>");
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

  return normalize(root.children);
}

// Block-level tags: whitespace in the source HTML that merely separates these
// is insignificant (a browser collapses it). Whitespace between inline elements
// is significant and must be preserved.
const BLOCK_TAGS = new Set<RichTag>(["p", "ul", "ol", "li", "pre", "blockquote", "br", "img"]);

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
    if (node.tag === "p" && !hasVisibleContent(node.children)) continue;
    cleaned.push(node);
  }
  return cleaned.filter((node, i) => {
    if (node.type !== "text" || node.text.trim().length > 0) return true;
    const prev = cleaned[i - 1];
    const next = cleaned[i + 1];
    if (prev === undefined || next === undefined) return false; // edge whitespace
    return !isBlockElement(prev) && !isBlockElement(next);
  });
}

/** Does this fragment contain any renderable content? (used to hide empties) */
export function hasVisibleContent(nodes: RichNode[]): boolean {
  return nodes.some((node) => {
    if (node.type === "text") return node.text.trim().length > 0;
    if (node.tag === "br") return false;
    if (node.tag === "img") return true;
    return hasVisibleContent(node.children);
  });
}

/**
 * Collect every `http(s)` anchor href in a Teams HTML fragment, in document
 * order and de-duplicated. Reuses the same safe allowlist parser used to render,
 * so only real `<a href>` links are returned (never a URL that merely appears in
 * text). Used to detect link-preview candidates (e.g. GitLab links) in a message.
 */
export function extractLinks(html: string): string[] {
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
  walk(parseRichHtml(html));
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

function serializeNodes(nodes: RichNode[]): string {
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
      const inner = serializeNodes(node.children);
      out += node.attrs.href
        ? `<a href="${escapeAttr(node.attrs.href)}">${inner}</a>`
        : inner;
      continue;
    }
    if (node.tag === "mention") {
      out += serializeNodes(node.children); // send mentions as plain text
      continue;
    }
    const tag = SIMPLE_TAGS[node.tag];
    if (tag) out += `<${tag}>${serializeNodes(node.children)}</${tag}>`;
  }
  return out;
}

/**
 * Normalize arbitrary editor HTML (e.g. TipTap's `getHTML()`) into the bounded,
 * Teams-safe HTML subset by round-tripping it through the same allowlist used to
 * render inbound messages. Only allowlisted tags/attributes survive, so this is
 * the single choke point that guarantees what we send matches what we render.
 * Returns an empty string when there is no visible content.
 */
export function serializeTeamsHtml(html: string): string {
  const nodes = parseRichHtml(html);
  if (!hasVisibleContent(nodes)) return "";
  return serializeNodes(nodes);
}

