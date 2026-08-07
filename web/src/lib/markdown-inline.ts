// The INLINE half of every markdown this app renders: what happens inside one line.
//
// Two surfaces write markdown at this app rather than HTML — an Adaptive/connector card's
// `TextBlock` (see `card-markdown.ts`) and a GitLab merge request's description and comments
// (see `gitlab-markdown.ts`) — and they differ only in how a line becomes a BLOCK. A card
// arrives pre-flattened, one block per line; a GitLab body is real GFM, with fences,
// headings and tables. What `**bold**`, `` `code` `` and `[label](url)` mean is the same in
// both, so it is written once here: two copies of an emphasis scanner drift apart at the
// first `snake_case` somebody reports.
//
// Everything here is pure (no DOM, no network), so it runs identically under SSR and in
// node-environment unit tests. Nothing is invented from the text either:
//
//   * HTML is never parsed — a card's was already stripped by the backend, and a GitLab
//     author's `<details>` is their own literal text (measured: not one of this instance's
//     open merge requests writes raw HTML in a description, see
//     `examples/merge_request_markdown_recon.rs`);
//   * a bare URL is recognised BEFORE any delimiter, so a query string full of underscores
//     stays a URL instead of turning into emphasis;
//   * an IMAGE never makes the BROWSER fetch anything. `![alt](url)` renders as the link its
//     alt text names — a remote image is a read receipt for whoever hosts it — unless the
//     caller can name a picture whose bytes come through the backend instead. That is what
//     `options.image` is for: the GitLab page passes a resolver that recognises an UPLOAD (a
//     screenshot somebody pasted) and turns it into a node the renderer loads over the
//     socket, with the token the browser does not hold (see `gitlab-upload.ts`). A card
//     passes none, so a connector card's images are links exactly as before.

import { trimUrlPunctuation, type RichAttrs, type RichNode, type RichTag } from "./rich-text";

/** How deep emphasis may nest before the rest of a line is taken literally. Real bodies nest
 *  one or two levels ("**[label](url)**"); the cap keeps a pathological line of delimiters
 *  from recursing without bound. */
const MAX_DEPTH = 4;

/** The punctuation a backslash may escape, so an author can print a literal `*`. */
const ESCAPABLE = "\\`*_~[]()#-.!|>";

/** A bare URL, matched from the scanner's current position (sticky). Stops at whitespace and
 *  at the characters that delimit markdown around a link rather than belong to it. */
const BARE_URL_AT = /https?:\/\/[^\s<>"'`[\]]+/y;

/** An autolink: a URL in angle brackets, which is how markdown writes one that must not be
 *  broken by the punctuation around it. */
const AUTOLINK_AT = /<(https?:\/\/[^\s<>]+)>/y;

/** Build an element node. Exported because the block parsers assemble their own blocks out of
 *  the same shape. */
export function element(tag: RichTag, children: RichNode[], attrs: RichAttrs = {}): RichNode {
  return { type: "element", tag, attrs, children };
}

/** Only display-safe schemes become links; anything else stays text (a card comes from a bot,
 *  and a `javascript:` "link" in one is not a link). A GitLab upload's `/uploads/…` is
 *  relative, so it is not a safe href either — which is honest, since a browser asking for it
 *  is answered 404 (measured). On the GitLab page that address is a PICTURE instead, through
 *  the resolver above; anywhere else it stays the literal text the author typed. */
export function safeHref(url: string): string | undefined {
  return /^(https?:|mailto:|tel:)/i.test(url) ? url : undefined;
}

/** A match a scanner rule produced: the node, and where the scan resumes. */
type Match = { node: RichNode; end: number };

/** One `![alt](url){width=… height=…}` as the scanner read it. `width` / `height` are absent
 *  unless the author wrote GitLab's own attribute block, and are already numbers. */
export type InlineImage = {
  url: string;
  alt: string;
  width?: number;
  height?: number;
};

/** What one caller may decide for itself. Today that is images and only images: everything
 *  else about an inline is the same wherever it is written (see the module header). */
export type InlineOptions = {
  /** What an image becomes, when this caller can draw one without the browser fetching it.
   *  Return `null` — or pass no resolver at all — and the image stays the LINK its alt text
   *  names, which is what every surface did before the GitLab page could show a picture. */
  image?: (image: InlineImage) => RichNode | null;
};

/** GitLab's own attribute block after an image: `{width=777 height=312}`. Read for the size
 *  and CONSUMED either way, because a block left in the text would be printed beside the
 *  picture as if the author had typed it. */
const IMAGE_ATTRIBUTES_AT = /\{([^{}\n]*)\}/y;

/** What a delimiter opens, and how it is written. */
const EMPHASIS: readonly { delimiter: string; tag: RichTag }[] = [
  { delimiter: "**", tag: "strong" },
  { delimiter: "__", tag: "strong" },
  { delimiter: "~~", tag: "s" },
  { delimiter: "*", tag: "em" },
  { delimiter: "_", tag: "em" },
];

/**
 * Parse one line's inline markup. The scan walks the line once and, at each position, tries
 * the rules in the order that keeps the others honest:
 *
 *  1. a backslash escape, so a literal `*` can be written;
 *  2. a bare URL, taken whole — before emphasis, so `?matcher=__uid__%3D…` inside a link is
 *     never read as bold;
 *  3. an autolink, `<https://…>`;
 *  4. inline code, whose content is verbatim;
 *  5. an image, `![alt](url)`, which becomes whatever `options.image` says — the link above
 *     when it says nothing;
 *  6. a `[label](url)` link;
 *  7. emphasis.
 *
 * Anything that does not match — an unclosed `**`, a `[` that opens nothing — stays the
 * literal character it is, which is also how every markdown host renders it.
 */
export function parseMarkdownInline(
  source: string,
  options: InlineOptions = {},
  depth = 0,
): RichNode[] {
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

    const match =
      (char === "h" ? matchBareUrl(source, i) : null) ??
      (char === "<" ? matchAutolink(source, i) : null) ??
      (char === "`" ? matchCode(source, i) : null) ??
      (char === "!" ? matchImage(source, i, options, depth) : null) ??
      (char === "[" ? matchLink(source, i, options, depth) : null) ??
      matchEmphasis(source, i, options, depth);
    if (match) {
      flush();
      nodes.push(match.node);
      i = match.end;
      continue;
    }

    text += char;
    i += 1;
  }
  flush();
  return nodes;
}

/** A URL written on its own, linked to itself — the shape a connector card leaves behind once
 *  its HTML anchor is flattened ("Filebeat error(s): https://…"). */
function matchBareUrl(source: string, at: number): Match | null {
  BARE_URL_AT.lastIndex = at;
  const match = BARE_URL_AT.exec(source);
  if (!match) return null;
  const href = trimUrlPunctuation(match[0]);
  // A "URL" that is nothing but a scheme is left as text.
  if (!/^https?:\/\/\S/i.test(href)) return null;
  return { node: element("a", [{ type: "text", text: href }], { href }), end: at + href.length };
}

/** `<https://…>` — the brackets are markup and never part of the address. */
function matchAutolink(source: string, at: number): Match | null {
  AUTOLINK_AT.lastIndex = at;
  const match = AUTOLINK_AT.exec(source);
  const href = match ? safeHref(match[1] ?? "") : undefined;
  if (!match || !href) return null;
  return { node: element("a", [{ type: "text", text: href }], { href }), end: at + match[0].length };
}

/** `` `code` `` — its content is shown exactly as written, never re-parsed. */
function matchCode(source: string, at: number): Match | null {
  const close = source.indexOf("`", at + 1);
  if (close <= at + 1) return null;
  const code = source.slice(at + 1, close);
  return { node: element("code", [{ type: "text", text: code }]), end: close + 1 };
}

/**
 * `![alt](url)`, with GitLab's `{width=… height=…}` block when the author wrote one.
 *
 * What it becomes is the CALLER's decision, in one of three answers:
 *
 *  1. whatever `options.image` returns — a picture whose bytes this app can fetch itself;
 *  2. otherwise the LINK its alt text names, when the address is one a browser could follow
 *     (an image on somebody else's host stays a link on purpose: fetching it would tell that
 *     host the user read this page);
 *  3. otherwise nothing at all, so the characters stay the literal text the author typed —
 *     which is what a RELATIVE address does here, since it names nothing outside GitLab.
 *
 * An image with no alt text is named by its address, so a link is never one nobody can see.
 */
function matchImage(
  source: string,
  at: number,
  options: InlineOptions,
  depth: number,
): Match | null {
  if (source[at + 1] !== "[") return null;
  const label = matchDelimited(source, at + 2, "[", "]");
  if (!label) return null;
  if (source[label.end] !== "(") return null;
  const target = matchDelimited(source, label.end + 1, "(", ")");
  if (!target) return null;
  // A markdown image may carry a title after the URL — `(url "title")` — which is a tooltip we
  // do not render.
  const url = target.inner.trim().split(/\s+/)[0] ?? "";
  if (!url) return null;

  // The attribute block is consumed whether or not it is understood, because it is markup:
  // printed, it reads as something the author typed beside their picture.
  const attributes = matchImageAttributes(source, target.end);
  const end = attributes?.end ?? target.end;

  const picture = options.image?.({
    url,
    alt: label.inner,
    width: attributes?.width,
    height: attributes?.height,
  });
  if (picture) return { node: picture, end };

  const href = safeHref(url);
  if (!href) return null;
  const children =
    label.inner.length > 0
      ? depth < MAX_DEPTH
        ? parseMarkdownInline(label.inner, options, depth + 1)
        : [{ type: "text" as const, text: label.inner }]
      : [{ type: "text" as const, text: href }];
  return { node: element("a", children, { href }), end };
}

/** GitLab's `{width=777 height=312}` at `at`, if one is there: the size it names, and where
 *  the scan resumes past it. An attribute naming anything else is consumed and ignored — the
 *  block is markup either way. */
function matchImageAttributes(
  source: string,
  at: number,
): { width?: number; height?: number; end: number } | null {
  IMAGE_ATTRIBUTES_AT.lastIndex = at;
  const match = IMAGE_ATTRIBUTES_AT.exec(source);
  if (!match) return null;
  return {
    width: imageAttribute(match[1]!, "width"),
    height: imageAttribute(match[1]!, "height"),
    end: at + match[0].length,
  };
}

/** One `name=<pixels>` out of an attribute block. A percentage, a unit or anything that is not
 *  a plain positive number is dropped: the value is used to hold a box on the page, so a value
 *  this app cannot turn into pixels is no value at all. It is capped, because the number comes
 *  from a body somebody else wrote. */
function imageAttribute(attributes: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*"?(\\d{1,5})"?(?![\\d.%a-z])`, "i").exec(
    attributes,
  );
  const value = match ? Number(match[1]) : 0;
  return value > 0 ? value : undefined;
}

/**
 * `[label](url)` — the reason these parsers exist: a link carries a two-word label over a URL
 * long enough to fill the bubble on its own.
 *
 * The label may hold markup of its own (a bolded link title), and the URL may hold balanced
 * parentheses, which Grafana's Explore links do. An unsafe or empty URL makes the whole thing
 * fall back to literal text rather than silently swallow the label.
 */
function matchLink(
  source: string,
  at: number,
  options: InlineOptions,
  depth: number,
): Match | null {
  const label = matchDelimited(source, at + 1, "[", "]");
  if (!label) return null;
  if (source[label.end] !== "(") return null;
  const target = matchDelimited(source, label.end + 1, "(", ")");
  if (!target) return null;
  // A markdown link may carry a title after the URL — `(url "title")` — which is a tooltip we
  // do not render.
  const href = safeHref(target.inner.trim().split(/\s+/)[0] ?? "");
  if (!href) return null;
  const children =
    depth < MAX_DEPTH
      ? parseMarkdownInline(label.inner, options, depth + 1)
      : [{ type: "text" as const, text: label.inner }];
  return { node: element("a", children, { href }), end: target.end };
}

/** Scan from just after an opening delimiter to its match, honouring nesting and backslash
 *  escapes. `from` is the index of the first character INSIDE the opener. */
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

/** True when a character cannot be part of a word, so a `_` next to it opens or closes
 *  emphasis instead of sitting inside an identifier (`snake_case`). */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || !/[\p{L}\p{N}]/u.test(char);
}

/**
 * `**bold**`, `__bold__`, `~~struck~~`, `*italic*`, `_italic_`.
 *
 * The content may not begin or end with a space (so "5 * 3 = 15 * 1" is arithmetic, not
 * emphasis), and a `_` delimiter must sit at a word boundary — otherwise every
 * `snake_case_name` and `__alert_rule_uid__` in a body would come out italic.
 */
function matchEmphasis(
  source: string,
  at: number,
  options: InlineOptions,
  depth: number,
): Match | null {
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
      depth < MAX_DEPTH
        ? parseMarkdownInline(inner, options, depth + 1)
        : [{ type: "text" as const, text: inner }];
    return { node: element(tag, children), end: close + delimiter.length };
  }
  return null;
}
