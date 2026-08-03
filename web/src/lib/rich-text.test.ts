// Behavior tests for the safe rich-text parser (parseRichHtml) and entity
// decoding. The parser turns Teams RichText/Html into an allowlisted node tree
// with no DOM and no dangerouslySetInnerHTML, so these run in the node env.
import { describe, it, expect } from "vitest";
import {
  parseRichHtml,
  containsImage,
  decodeEntities,
  dropLinks,
  extractLinks,
  hasNonImageContent,
  hasVisibleContent,
  isRelayedEmail,
  parseMessageBody,
  parsePlainText,
  parseRelayedEmail,
  serializeTeamsHtml,
  type RichNode,
} from "./rich-text";

/** Flatten a node tree back to visible text, for concise assertions. */
function text(nodes: RichNode[]): string {
  return nodes
    .map((n) => (n.type === "text" ? n.text : n.tag === "br" ? "\n" : text(n.children)))
    .join("");
}

/** Collect the semantic tags present anywhere in the tree. */
function tags(nodes: RichNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "element") {
      out.push(n.tag);
      out.push(...tags(n.children));
    }
  }
  return out;
}

type RichElement = Extract<RichNode, { type: "element" }>;

/** Every element with `tag`, depth-first — for asserting on structure. */
function findAll(nodes: RichNode[], tag: string): RichElement[] {
  const out: RichElement[] = [];
  for (const n of nodes) {
    if (n.type !== "element") continue;
    if (n.tag === tag) out.push(n);
    out.push(...findAll(n.children, tag));
  }
  return out;
}

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;d&#39; &#x41;")).toBe("a & b <c> 'd' A");
  });
  it("leaves unknown entities untouched", () => {
    expect(decodeEntities("50&percnt; &unknownthing;")).toBe("50&percnt; &unknownthing;");
  });
});

describe("parseRichHtml — formatting", () => {
  it("keeps bold, italic, underline and strikethrough", () => {
    const nodes = parseRichHtml("<b>bold</b> <i>it</i> <u>u</u> <s>x</s>");
    expect(tags(nodes)).toEqual(["strong", "em", "u", "s"]);
    expect(text(nodes)).toBe("bold it u x");
  });

  it("maps <strong>/<em> aliases to the same tags", () => {
    expect(tags(parseRichHtml("<strong><em>hi</em></strong>"))).toEqual(["strong", "em"]);
  });

  it("preserves ordered and unordered lists", () => {
    const nodes = parseRichHtml("<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>");
    expect(tags(nodes)).toEqual(["ul", "li", "li", "ol", "li"]);
    expect(text(nodes)).toBe("abc");
  });

  it("keeps inline code and code blocks", () => {
    expect(tags(parseRichHtml("<code>x=1</code>"))).toEqual(["code"]);
    expect(tags(parseRichHtml("<pre>line</pre>"))).toEqual(["pre"]);
  });

  it("turns <br> into a br node", () => {
    const nodes = parseRichHtml("a<br>b");
    expect(text(nodes)).toBe("a\nb");
    expect(tags(nodes)).toEqual(["br"]);
  });
});

describe("parseRichHtml — whitespace & empty blocks", () => {
  it("drops empty spacer paragraphs (e.g. a Teams reply spacer)", () => {
    const nodes = parseRichHtml("<p>&nbsp;</p><p>reply</p>");
    expect(tags(nodes)).toEqual(["p"]);
    expect(text(nodes)).toBe("reply");
  });

  it("drops an empty paragraph between two paragraphs", () => {
    const nodes = parseRichHtml("<p>a</p><p></p><p>b</p>");
    expect(tags(nodes)).toEqual(["p", "p"]);
    expect(text(nodes)).toBe("ab");
  });

  it("collapses insignificant whitespace between block elements", () => {
    const nodes = parseRichHtml("<p>a</p>\n<p>b</p>");
    expect(tags(nodes)).toEqual(["p", "p"]);
    expect(text(nodes)).toBe("ab");
  });

  it("drops whitespace at fragment edges (e.g. after a reply quote)", () => {
    const nodes = parseRichHtml("\n<p>reply</p>\n");
    expect(tags(nodes)).toEqual(["p"]);
    expect(text(nodes)).toBe("reply");
  });

  it("keeps significant whitespace between inline elements", () => {
    expect(text(parseRichHtml("<strong>a</strong> <em>b</em>"))).toBe("a b");
  });
});

describe("parseRichHtml — links", () => {
  it("keeps http(s) links with their href", () => {
    const [a] = parseRichHtml('<a href="https://example.com">site</a>');
    expect(a).toMatchObject({ type: "element", tag: "a", attrs: { href: "https://example.com" } });
  });

  it("drops the href for javascript: URLs but keeps the text", () => {
    const nodes = parseRichHtml('<a href="javascript:alert(1)">click</a>');
    const a = nodes[0];
    expect(a?.type === "element" ? a.attrs.href : "unexpected").toBeUndefined();
    expect(text(nodes)).toBe("click");
  });
});

describe("extractLinks", () => {
  it("collects http(s) anchor hrefs in document order", () => {
    const html =
      '<p>see <a href="https://gitlab.com/a/b/-/merge_requests/1">MR</a> and ' +
      '<a href="https://example.com/x">x</a></p>';
    expect(extractLinks(html)).toEqual([
      "https://gitlab.com/a/b/-/merge_requests/1",
      "https://example.com/x",
    ]);
  });

  it("de-duplicates repeated links", () => {
    const html =
      '<a href="https://gitlab.com/a/b">one</a> <a href="https://gitlab.com/a/b">again</a>';
    expect(extractLinks(html)).toEqual(["https://gitlab.com/a/b"]);
  });

  it("ignores plain-text URLs and unsafe schemes", () => {
    // Not an anchor — must not be picked up.
    expect(extractLinks("visit https://gitlab.com/a/b for details")).toEqual([]);
    // Unsafe scheme: the parser drops the href, so there is nothing to collect.
    expect(extractLinks('<a href="javascript:alert(1)">x</a>')).toEqual([]);
  });

  it("returns an empty list for content without links", () => {
    expect(extractLinks("<p>just text</p>")).toEqual([]);
  });
});

describe("parsePlainText / parseMessageBody", () => {
  it("keeps angle-bracketed text a `Text` body carries, instead of parsing it away", () => {
    // The audit's repro (message 1775231521568): read as HTML this renders
    // "pour moi c'est -".
    const nodes = parsePlainText("pour moi c'est <yyyy>-<id>");
    expect(text(nodes)).toBe("pour moi c'est <yyyy>-<id>");
    expect(tags(nodes)).toEqual([]);
  });

  it("keeps generics and tag-looking text verbatim", () => {
    expect(text(parsePlainText("Vec<String> and <b>not bold</b>"))).toBe(
      "Vec<String> and <b>not bold</b>",
    );
  });

  it("never decodes entities — an ampersand is an ampersand", () => {
    expect(text(parsePlainText("a &amp; b &lt;c&gt;"))).toBe("a &amp; b &lt;c&gt;");
  });

  it("keeps newlines as text, since a plain body has no markup for them", () => {
    expect(text(parsePlainText("one\ntwo"))).toBe("one\ntwo");
  });

  it("links a bare URL so a pasted link stays clickable", () => {
    const nodes = parsePlainText("see https://example.com/docs for details");
    const links = findAll(nodes, "a");
    expect(links).toHaveLength(1);
    expect(links[0]!.attrs.href).toBe("https://example.com/docs");
    expect(text(nodes)).toBe("see https://example.com/docs for details");
  });

  it("leaves sentence punctuation out of the link", () => {
    expect(findAll(parsePlainText("see https://example.com/docs."), "a")[0]!.attrs.href).toBe(
      "https://example.com/docs",
    );
    expect(findAll(parsePlainText("(https://example.com/a)"), "a")[0]!.attrs.href).toBe(
      "https://example.com/a",
    );
    // A bracket the URL itself opened is part of it.
    expect(findAll(parsePlainText("https://example.com/a_(b)"), "a")[0]!.attrs.href).toBe(
      "https://example.com/a_(b)",
    );
  });

  it("counts as visible content, so a plain-text message is never an empty bubble", () => {
    expect(hasVisibleContent(parsePlainText("hi"))).toBe(true);
    expect(hasVisibleContent(parsePlainText("   "))).toBe(false);
  });

  it("routes each body to the parser its format calls for", () => {
    expect(text(parseMessageBody("<p>a<b>b</b></p>", "html"))).toBe("ab");
    expect(text(parseMessageBody("<p>a<b>b</b></p>", "text"))).toBe("<p>a<b>b</b></p>");
  });

  it("finds the links of a plain body, which are bare URLs rather than anchors", () => {
    expect(extractLinks("ping https://gitlab.com/a/b please", "text")).toEqual([
      "https://gitlab.com/a/b",
    ]);
    expect(extractLinks("ping https://gitlab.com/a/b please", "html")).toEqual([]);
  });
});

describe("dropLinks", () => {
  const HREF = "https://gitlab.com/a/b/-/merge_requests/1";

  it("removes a matching anchor but keeps surrounding text", () => {
    const nodes = dropLinks(
      parseRichHtml(`<p>see <a href="${HREF}">MR</a> now</p>`),
      new Set([HREF]),
    );
    expect(text(nodes)).toBe("see  now");
    // No anchor survives.
    expect(tags(nodes)).not.toContain("a");
  });

  it("leaves the fragment empty when the anchor was the only content", () => {
    const nodes = dropLinks(parseRichHtml(`<a href="${HREF}">${HREF}</a>`), new Set([HREF]));
    expect(hasVisibleContent(nodes)).toBe(false);
  });

  it("keeps anchors that are not in the hidden set", () => {
    const other = "https://example.com/x";
    const nodes = dropLinks(
      parseRichHtml(`<a href="${HREF}">MR</a> <a href="${other}">x</a>`),
      new Set([HREF]),
    );
    // Only the non-hidden anchor remains.
    expect(tags(nodes).filter((t) => t === "a")).toHaveLength(1);
    expect(text(nodes)).toContain("x");
    expect(text(nodes)).not.toContain("MR");
  });

  it("is a no-op for an empty hidden set", () => {
    const parsed = parseRichHtml(`<a href="${HREF}">MR</a>`);
    expect(dropLinks(parsed, new Set())).toBe(parsed);
  });
});

describe("parseRichHtml — images", () => {
  it("keeps remote and data:image sources", () => {
    expect(parseRichHtml('<img src="https://x/y.png" alt="pic">')[0]).toMatchObject({
      tag: "img",
      attrs: { src: "https://x/y.png", alt: "pic" },
    });
    expect(parseRichHtml('<img src="data:image/png;base64,AAAA">')[0]).toMatchObject({
      tag: "img",
    });
  });

  it("drops images with unsafe sources", () => {
    expect(parseRichHtml('<img src="javascript:alert(1)">')).toEqual([]);
  });
});

describe("parseRichHtml — mentions", () => {
  const mentionSpan = (name: string) =>
    `<span itemscope itemtype="http://schema.skype.com/Mention" itemid="0">${name}</span>`;

  it("renders a Skype mention span as a mention node", () => {
    const html = mentionSpan("Alice Smith");
    const [m] = parseRichHtml(html);
    expect(m).toMatchObject({ tag: "mention" });
    expect(text(parseRichHtml(html))).toBe("Alice Smith");
  });

  it("keeps the span's itemid, which is what identifies who was mentioned", () => {
    // The span carries only an index into the message's `mentions` list; without
    // it there is no way back from "@Alice" to Alice, so no person card.
    const [m] = parseRichHtml(
      `<span itemscope itemtype="http://schema.skype.com/Mention" itemid="3">Alice</span>`,
    );
    expect(m).toMatchObject({ tag: "mention", attrs: { itemid: "3" } });

    // A mention without one still renders, just unidentifiable.
    const [plain] = parseRichHtml(
      `<span itemscope itemtype="http://schema.skype.com/Mention">Alice</span>`,
    );
    expect(plain).toMatchObject({ tag: "mention", attrs: {} });
  });

  it("closes the mention at its </span> so trailing text is not swallowed", () => {
    // Regression: a mention's </span> was ignored (span isn't in TAG_MAP), so
    // the mention frame stayed open and every following sibling became its child
    // — tinting the rest of the message the mention's accent color.
    const nodes = parseRichHtml(`Hello ${mentionSpan("Apurva")}, it's clear.`);
    const mention = nodes.find((n) => n.type === "element" && n.tag === "mention");
    // The mention contains ONLY the name; the trailing text is a sibling.
    expect(mention).toMatchObject({ tag: "mention" });
    expect(text(mention ? [mention] : [])).toBe("Apurva");
    expect(nodes.filter((n) => n.type === "text").map((n) => n.type === "text" && n.text)).toEqual([
      "Hello ",
      ", it's clear.",
    ]);
    expect(text(nodes)).toBe("Hello Apurva, it's clear.");
  });

  it("keeps two mentions distinct with text between and after them", () => {
    const html = `${mentionSpan("Ann")} and ${mentionSpan("Bob")} both know.`;
    const nodes = parseRichHtml(html);
    expect(tags(nodes)).toEqual(["mention", "mention"]);
    const mentionText = nodes
      .filter((n) => n.type === "element" && n.tag === "mention")
      .map((n) => text([n]));
    expect(mentionText).toEqual(["Ann", "Bob"]);
    expect(text(nodes)).toBe("Ann and Bob both know.");
  });

  it("nests a mention inside formatting without leaking past it", () => {
    const html = `<strong>hi ${mentionSpan("Cy")}</strong> bye`;
    const nodes = parseRichHtml(html);
    // The mention stays inside the <strong>; " bye" is outside both.
    const strong = nodes.find((n) => n.type === "element" && n.tag === "strong");
    expect(strong && strong.type === "element" && tags([strong])).toEqual(["strong", "mention"]);
    expect(text(nodes)).toBe("hi Cy bye");
  });
});

describe("parseRichHtml — safety", () => {
  it("drops <script> content entirely", () => {
    const nodes = parseRichHtml("before<script>alert(1)</script>after");
    expect(text(nodes)).toBe("beforeafter");
    expect(tags(nodes)).toEqual([]);
  });

  it("drops <style> content entirely", () => {
    expect(text(parseRichHtml("<style>body{}</style>hi"))).toBe("hi");
  });

  it("unwraps unknown tags but keeps their text", () => {
    const nodes = parseRichHtml('<font color="red"><span>text</span></font>');
    expect(tags(nodes)).toEqual([]);
    expect(text(nodes)).toBe("text");
  });

  it("carries no on* handler or style attributes through", () => {
    const a = parseRichHtml('<a href="https://x" onclick="evil()" style="x">y</a>')[0];
    expect(a?.type === "element" ? Object.keys(a.attrs) : []).toEqual(["href"]);
  });

  it("closes tags left open by malformed input", () => {
    const nodes = parseRichHtml("<b>bold <i>both</b> italic");
    expect(text(nodes)).toBe("bold both italic");
    expect(tags(nodes)).toContain("strong");
    expect(tags(nodes)).toContain("em");
  });
});

describe("hasVisibleContent", () => {
  it("is false for empty or whitespace-only fragments", () => {
    expect(hasVisibleContent(parseRichHtml("<p>   </p>"))).toBe(false);
    expect(hasVisibleContent(parseRichHtml(""))).toBe(false);
  });
  it("is true when there is text or an image", () => {
    expect(hasVisibleContent(parseRichHtml("<p>hi</p>"))).toBe(true);
    expect(hasVisibleContent(parseRichHtml('<img src="https://x/y.png">'))).toBe(true);
  });
});

describe("hasNonImageContent", () => {
  it("is false when the fragment is empty, whitespace, or only images", () => {
    expect(hasNonImageContent(parseRichHtml(""))).toBe(false);
    expect(hasNonImageContent(parseRichHtml("<p>   </p>"))).toBe(false);
    expect(hasNonImageContent(parseRichHtml('<img src="https://x/y.png">'))).toBe(false);
    // Images wrapped in blocks / accompanied only by <br> still count as empty.
    expect(hasNonImageContent(parseRichHtml('<p><img src="https://x/y.png"></p><br>'))).toBe(false);
  });
  it("is true as soon as there is real text alongside an image", () => {
    expect(hasNonImageContent(parseRichHtml("<p>hi</p>"))).toBe(true);
    expect(hasNonImageContent(parseRichHtml('caption <img src="https://x/y.png">'))).toBe(true);
  });
});

describe("containsImage", () => {
  it("detects an inline image, however nested", () => {
    expect(containsImage(parseRichHtml('<img src="https://x/y.png">'))).toBe(true);
    expect(containsImage(parseRichHtml('<p>a <img src="https://x/y.png"> b</p>'))).toBe(true);
  });
  it("is false when there is no image", () => {
    expect(containsImage(parseRichHtml("<p>just text</p>"))).toBe(false);
    expect(containsImage(parseRichHtml(""))).toBe(false);
  });
});

// ---- Teams emoji ----------------------------------------------------------
//
// The HTML in these fixtures is the real thing, copied out of the local store
// (message ids in the comments). Teams sends an inline emoji as a 20 px <img> off
// its "personal expressions" CDN, wrapped in an animated-emoticon <span>.

/** Repro 1784645601649. */
const EMOJI_IMG =
  '<img itemscope="" itemtype="http://schema.skype.com/Emoji" itemid="1f4a1_electriclightbulb" ' +
  'src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/' +
  'emoticons/1f4a1_electriclightbulb/default/20_f.png" title="Ampoule" alt="💡" ' +
  'style="width:20px; height:20px">';
const EMOJI_MESSAGE =
  '<p>Il faut un espace <span title="Ampoule" type="(1f4a1_electriclightbulb)" ' +
  `class="animated-emoticon-20-1f4a1_electriclightbulb" itemscope="">${EMOJI_IMG}</span></p>`;

/** Repro 1781625043581: a message that is nothing but an emoji. */
const EMOJI_ONLY_MESSAGE =
  '<p><span title="Grimace" type="(squintingfacewithtongue)" ' +
  'class="animated-emoticon-20-squintingfacewithtongue" itemscope="">' +
  '<img itemscope="" itemtype="http://schema.skype.com/Emoji" itemid="squintingfacewithtongue" ' +
  'src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/' +
  'emoticons/squintingfacewithtongue/default/20_f.png" alt="😝" ' +
  'style="width:20px; height:20px"></span></p>';

describe("parseRichHtml — Teams emoji", () => {
  it("renders an emoji <img> as its character, inline in the text", () => {
    const nodes = parseRichHtml(EMOJI_MESSAGE);
    expect(text(nodes)).toBe("Il faut un espace 💡");
    // No image node: an emoji must not become a framed, click-to-zoom picture.
    expect(tags(nodes)).toEqual(["p"]);
    expect(containsImage(nodes)).toBe(false);
  });

  it("recognises the personal-expressions CDN path without the itemtype", () => {
    const nodes = parseRichHtml(
      '<img src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/' +
        'v2/assets/emoticons/smile/default/20_f.png" alt="🙂">',
    );
    expect(text(nodes)).toBe("🙂");
    expect(containsImage(nodes)).toBe(false);
  });

  it("falls back to the emoji's title when it carries no alt", () => {
    const nodes = parseRichHtml(
      '<img itemtype="http://schema.skype.com/Emoji" src="https://x/20_f.png" title="Smile">',
    );
    expect(text(nodes)).toBe("Smile");
  });

  it("drops an emoji with no text at all rather than showing the sprite", () => {
    const nodes = parseRichHtml(
      '<img itemtype="http://schema.skype.com/Emoji" src="https://x/20_f.png">',
    );
    expect(nodes).toEqual([]);
  });

  it("still renders a real inline image as an image", () => {
    // Repro 1784627239695: an AMS-hosted pasted screenshot in the same message.
    const nodes = parseRichHtml(
      '<p><img src="https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d3-9a7/views/imgo" ' +
        'itemtype="http://schema.skype.com/AMSImage" width="366" height="58" alt="image"></p>',
    );
    expect(containsImage(nodes)).toBe(true);
  });

  it("keeps an emoji as a character when the message is re-serialized to send", () => {
    expect(serializeTeamsHtml(EMOJI_MESSAGE)).toBe("<p>Il faut un espace 💡</p>");
  });
});

describe("emoji-only messages keep their bubble chrome", () => {
  // Regression for the "emoji-only message renders as a framed photo" bug: with
  // the emoji counted as an image, `hasNonImageContent` was false, which is what
  // makes `imageOnly` true in message-bubble.tsx and drops the bubble chrome in
  // favour of the picture mat. These three predicates are exactly the inputs to
  // that decision (`bodyHasText` / `bodyHasImage`).
  const nodes = parseRichHtml(EMOJI_ONLY_MESSAGE);

  it("reads as text, not as an image", () => {
    expect(text(nodes)).toBe("😝");
    expect(hasVisibleContent(nodes)).toBe(true);
    expect(hasNonImageContent(nodes)).toBe(true);
    expect(containsImage(nodes)).toBe(false);
  });
});

// ---- tables ---------------------------------------------------------------

/** Repro 1776787594282, trimmed to two rows (the third cell of the first is the
 *  `&nbsp;` spacer that used to render as a blank line). */
const TABLE_MESSAGE =
  "<table>\n<tbody>\n<tr>\n<td>Total</td>\n<td>61</td>\n<td>&nbsp;</td>\n</tr>\n" +
  "<tr>\n<td>Pass</td>\n<td>31</td>\n<td>51%</td>\n</tr>\n</tbody>\n</table>";

describe("parseRichHtml — tables", () => {
  it("keeps a real table's structure instead of flattening its cells", () => {
    const nodes = parseRichHtml(TABLE_MESSAGE);
    expect(tags(nodes)).toEqual([
      "table",
      "tbody",
      "tr",
      "td",
      "td",
      "td",
      "tr",
      "td",
      "td",
      "td",
    ]);
    expect(text(nodes)).toBe("Total61Pass3151%");
  });

  it("keeps an empty cell's slot but not its &nbsp; filler", () => {
    const rows = findAll(parseRichHtml(TABLE_MESSAGE), "tr");
    expect(rows).toHaveLength(2);
    const spacer = rows[0]?.children[2];
    // The cell stays (dropping it would shift every following column) and is
    // empty (the filler would otherwise render as a blank line in the cell).
    expect(spacer).toMatchObject({ tag: "td", children: [] });
  });

  it("keeps block content inside a cell", () => {
    // Repro 1776978121549 wraps each number in its own paragraph.
    const cell = findAll(parseRichHtml("<table><tbody><tr><td><p>62</p></td></tr></tbody></table>"), "td")[0];
    expect(cell && tags(cell.children)).toEqual(["p"]);
  });

  it("gives rows without a section an implicit tbody", () => {
    expect(tags(parseRichHtml("<table><tr><td>a</td></tr><tr><td>b</td></tr></table>"))).toEqual([
      "table",
      "tbody",
      "tr",
      "td",
      "tr",
      "td",
    ]);
  });

  it("gives cells without a row an implicit tr", () => {
    expect(tags(parseRichHtml("<table><tbody><td>a</td><td>b</td></tbody></table>"))).toEqual([
      "table",
      "tbody",
      "tr",
      "td",
      "td",
    ]);
  });

  it("wraps loose content inside a row into a cell", () => {
    const nodes = parseRichHtml("<table><tbody><tr>loose<td>a</td></tr></tbody></table>");
    const cells = findAll(nodes, "td");
    expect(cells).toHaveLength(2);
    expect(text(nodes)).toBe("loosea");
  });

  it("unwraps a stray cell or row that is outside any table", () => {
    expect(tags(parseRichHtml("<td>a</td><td>b</td>"))).toEqual([]);
    expect(text(parseRichHtml("<td>a</td><td>b</td>"))).toBe("ab");
    expect(text(parseRichHtml("<tr><td>a</td></tr>"))).toBe("a");
  });

  it("drops an all-empty row, and a table left with nothing", () => {
    const nodes = parseRichHtml(
      "<table><tbody><tr><td>&nbsp;</td><td> </td></tr><tr><td>x</td></tr></tbody></table>",
    );
    expect(findAll(nodes, "tr")).toHaveLength(1);
    expect(text(nodes)).toBe("x");

    // A pure layout table (an email spacer) leaves nothing to render.
    const empty = parseRichHtml("<table><tbody><tr><td>&nbsp;</td></tr></tbody></table>");
    expect(empty).toEqual([]);
    expect(hasVisibleContent(empty)).toBe(false);
  });

  it("keeps a sane colspan/rowspan and ignores anything else", () => {
    const cells = findAll(
      parseRichHtml(
        "<table><tbody><tr>" +
          '<td colspan="2">a</td><td colspan="1">b</td><td rowspan="9999">c</td>' +
          "</tr></tbody></table>",
      ),
      "td",
    );
    expect(cells.map((c) => c.attrs)).toEqual([{ colspan: 2 }, {}, {}]);
  });

  it("keeps a table nested inside a cell (email layout tables)", () => {
    const nodes = parseRichHtml(
      "<table><tbody><tr><td><table><tbody><tr><td>in</td></tr></tbody></table></td></tr></tbody></table>",
    );
    expect(findAll(nodes, "table")).toHaveLength(2);
    expect(text(nodes)).toBe("in");
  });

  it("drops colgroup/col sizing hints", () => {
    const nodes = parseRichHtml(
      '<table><colgroup><col width="120"><col></colgroup><tbody><tr><td>a</td></tr></tbody></table>',
    );
    expect(tags(nodes)).toEqual(["table", "tbody", "tr", "td"]);
  });
});

// ---- headings, separators, small print ------------------------------------

describe("parseRichHtml — headings", () => {
  it("keeps h1/h2/h3", () => {
    // Repro 1784797533519 / 1779292826769.
    expect(tags(parseRichHtml("<h1>#Pauvreté</h1>"))).toEqual(["h1"]);
    const nodes = parseRichHtml("<h3>Key Features &amp; Changes</h3><ul><li>x</li></ul>");
    expect(tags(nodes)).toEqual(["h3", "ul", "li"]);
    expect(text(nodes)).toBe("Key Features & Changesx");
  });

  it("collapses h4-h6 onto the smallest heading", () => {
    expect(tags(parseRichHtml("<h4>a</h4><h5>b</h5><h6>c</h6>"))).toEqual(["h3", "h3", "h3"]);
  });

  it("drops an empty heading, like an empty paragraph", () => {
    expect(tags(parseRichHtml("<h2>&nbsp;</h2><p>x</p>"))).toEqual(["p"]);
  });
});

describe("parseRichHtml — separators and small print", () => {
  it("keeps <hr> as a node between blocks", () => {
    // Repro 1774536291823.
    const nodes = parseRichHtml("<p>a</p>\n<hr>\n<h3>b</h3>");
    expect(tags(nodes)).toEqual(["p", "hr", "h3"]);
  });

  it("ignores a stray </hr>", () => {
    const nodes = parseRichHtml("<hr></hr>a");
    expect(tags(nodes)).toEqual(["hr"]);
    expect(text(nodes)).toBe("a");
  });

  it("keeps <small> as its own tag", () => {
    const nodes = parseRichHtml('<small style="font-size:14px">threshold reached.</small>');
    expect(tags(nodes)).toEqual(["small"]);
    expect(text(nodes)).toBe("threshold reached.");
  });
});

describe("parseRichHtml — Teams code blocks", () => {
  // Repro 1744216678372: the editor emits a marker paragraph holding only a
  // non-breaking space, then the block itself as <pre><code>.
  const CODE_BLOCK =
    "<p>test c'est une file avec&nbsp;</p>\n" +
    '<p itemtype="http://schema.skype.com/CodeBlockEditor" id="x_codeBlockEditor-bfb2">\n&nbsp;</p>\n' +
    '<pre class="language-plaintext" itemid="codeBlockEditor-bfb2"><code>test<br>test</code></pre>';

  it("drops the marker paragraph and keeps one code element inside the pre", () => {
    const nodes = parseRichHtml(CODE_BLOCK);
    expect(tags(nodes)).toEqual(["p", "pre", "code", "br"]);
    expect(text(nodes)).toBe("test c'est une file avec test\ntest");
    // The renderer paints the block surface on the `pre` only — a `code` nested
    // in a `pre` renders bare, so the two backgrounds never stack.
    const pre = findAll(nodes, "pre")[0];
    expect(pre && tags(pre.children)).toEqual(["code", "br"]);
  });
});

describe("parseRichHtml — app link-unfurl cards", () => {
  /** Repro 1728552713631. */
  const CARD_MESSAGE =
    '<p>Pour les nostalgiques des <a href="https://github.com/Swordfish90/cool-retro-term">écrans</a></p>' +
    '<span itemid="app-preview-carde5e5" itemscope="" itemtype="http://schema.skype.com/InputExtension">' +
    '<span itemprop="cardId"></span></span>';

  it("keeps the card as its own node instead of rendering nothing", () => {
    const nodes = parseRichHtml(CARD_MESSAGE);
    expect(tags(nodes)).toEqual(["p", "a", "card"]);
    expect(findAll(nodes, "card")[0]?.attrs).toEqual({ itemid: "app-preview-carde5e5" });
    // A card is content: the renderer always shows something for it, even when
    // Teams sent the payload out of band and the HTML carries only its id.
    expect(hasVisibleContent(parseRichHtml(CARD_MESSAGE.slice(CARD_MESSAGE.indexOf("<span"))))).toBe(
      true,
    );
    expect(hasNonImageContent(nodes)).toBe(true);
  });

  it("surfaces card content when the payload is inline", () => {
    const card = findAll(
      parseRichHtml(
        '<span itemscope="" itemtype="http://schema.skype.com/InputExtension" itemid="c1">' +
          "<p>Repo title</p><p>A description</p></span>",
      ),
      "card",
    )[0];
    expect(card && tags(card.children)).toEqual(["p", "p"]);
    expect(card && text(card.children)).toBe("Repo titleA description");
  });

  it("closes at its own </span>, not at a nested one", () => {
    const nodes = parseRichHtml(
      '<span itemscope="" itemtype="http://schema.skype.com/InputExtension" itemid="c1">' +
        "<span>inner</span></span> after",
    );
    expect(text(findAll(nodes, "card"))).toBe("inner");
    expect(text(nodes)).toBe("inner after");
  });

  it("keeps a plain span nested in a mention from closing the mention early", () => {
    const nodes = parseRichHtml(
      'Hello <span itemscope itemtype="http://schema.skype.com/Mention" itemid="0">' +
        'Ann <span class="x">B</span></span>, bye.',
    );
    expect(text(findAll(nodes, "mention"))).toBe("Ann B");
    expect(text(nodes)).toBe("Hello Ann B, bye.");
  });
});

// ---- hidden content -------------------------------------------------------

describe("parseRichHtml — hidden elements", () => {
  it("drops a display:none preheader, text and all", () => {
    // Repro 1755770894847: the inbox teaser line no mail client ever shows.
    const nodes = parseRichHtml(
      '<div style="font-weight:400; display:none; font-size:0; max-height:0; line-height:0;' +
        ' mso-hide:all; padding:0">\n  New issue from internal.\n</div>\n<p>body</p>',
    );
    expect(text(nodes)).toBe("body");
  });

  it("ends the hidden region at the matching close tag, not the first one", () => {
    const nodes = parseRichHtml(
      '<div style="display:none"><div>a</div><span>b</span></div><p>c</p>',
    );
    expect(text(nodes)).toBe("c");
  });

  it("honours visibility:hidden and the hidden attribute", () => {
    expect(text(parseRichHtml('<p style="visibility: hidden">a</p><p>b</p>'))).toBe("b");
    expect(text(parseRichHtml("<p hidden>a</p><p>b</p>"))).toBe("b");
  });

  it("drops a hidden tracking pixel", () => {
    expect(parseRichHtml('<img src="https://x/pixel.gif" style="display:none">')).toEqual([]);
  });

  it("keeps elements whose style merely mentions none elsewhere", () => {
    expect(text(parseRichHtml('<p style="text-decoration:none">a</p>'))).toBe("a");
  });
});

// ---- relayed HTML emails --------------------------------------------------

/** A faithful excerpt of repro 1755770894847 (a Sentry alert email relayed into
 *  a channel): hidden preheader, logo-only h1, subject h2, a linked issue title,
 *  a section heading, the "View on Sentry" action, and the schema.org marker. */
const RELAYED_EMAIL = [
  '<div style="font-weight:400; display:none; font-size:0; mso-hide:all; padding:0">',
  "  New issue from internal.",
  "</div>",
  '<table style="width:100%; border-collapse:separate"><tbody><tr><td>',
  '<h1 style="font-size:38px"><a href="https://sentry.sia.partners">',
  '<img src="https://eu-prod.asyncgw.teams.microsoft.com/urlp/v1/url/content?url=sentry_logo.png"',
  ' width="125px" alt="Sentry"></a></h1>',
  '<h2 style="font-size:22px">New issue </h2>',
  '<h3><a href="https://sentry.sia.partners/organizations/stratumn/issues/12093/">',
  "QueryExecutionError monitor_release_adoption</a></h3>",
  "<h4>Exception</h4>",
  '<a href="https://sentry.sia.partners/organizations/stratumn/issues/12093/">View',
  " on Sentry</a>",
  '<div itemscope="" itemtype="http://schema.org/EmailMessage">',
  '<div itemprop="action" itemscope="" itemtype="http://schema.org/ViewAction"></div></div>',
  "</td></tr></tbody></table>",
].join("\n");

describe("parseRelayedEmail", () => {
  it("recognises a relayed email by either of its markers", () => {
    expect(isRelayedEmail(RELAYED_EMAIL)).toBe(true);
    // Repro 1755770531556 carries no schema.org block, only the hidden preheader.
    expect(isRelayedEmail('<div style="mso-hide:all"></div><table></table>')).toBe(true);
  });

  it("is not a relayed email for an ordinary Teams message", () => {
    expect(isRelayedEmail("<p>hi</p>")).toBe(false);
    expect(parseRelayedEmail("<p>hi</p>")).toBeNull();
    expect(parseRelayedEmail(TABLE_MESSAGE)).toBeNull();
  });

  it("summarizes the email as subject, linked headlines and action", () => {
    const email = parseRelayedEmail(RELAYED_EMAIL);
    expect(email).toEqual({
      subject: "New issue",
      headlines: [
        {
          text: "QueryExecutionError monitor_release_adoption",
          href: "https://sentry.sia.partners/organizations/stratumn/issues/12093/",
        },
      ],
      action: {
        label: "View on Sentry",
        href: "https://sentry.sia.partners/organizations/stratumn/issues/12093/",
      },
    });
  });

  it("never surfaces the hidden preheader or an image", () => {
    const email = parseRelayedEmail(RELAYED_EMAIL);
    const rendered = JSON.stringify(email);
    expect(rendered).not.toContain("New issue from internal");
    // No logo, no tracking pixel: a summary has no images to turn into cards.
    expect(rendered).not.toContain("urlp/v1/url/content");
    // The body's hidden text is gone from the parsed tree too.
    expect(text(parseRichHtml(RELAYED_EMAIL))).not.toContain("New issue from internal");
  });

  it("falls back to the first short paragraph when the email has no headings", () => {
    const email = parseRelayedEmail(
      '<div style="mso-hide:all"></div><p>Your build finished successfully.</p>',
    );
    expect(email).toEqual({ subject: "Your build finished successfully.", headlines: [] });
  });

  it("gives up when there is nothing to summarize, so the body renders instead", () => {
    expect(
      parseRelayedEmail('<div style="mso-hide:all"></div><img src="https://x/logo.png">'),
    ).toBeNull();
  });

  it("keeps unlinked headings when nothing in the email is a link", () => {
    const email = parseRelayedEmail(
      '<div style="mso-hide:all"></div><h1>Weekly report</h1><h2>Highlights</h2>',
    );
    expect(email).toEqual({ subject: "Weekly report", headlines: [{ text: "Highlights" }] });
  });
});

describe("serializeTeamsHtml", () => {
  it("keeps the Teams-safe formatting tags from editor HTML", () => {
    const html = "<p>hi <strong>bold</strong> <em>it</em> <u>u</u> <s>x</s> <code>c</code></p>";
    expect(serializeTeamsHtml(html)).toBe(html);
  });

  it("keeps lists", () => {
    expect(serializeTeamsHtml("<ul><li>a</li><li>b</li></ul>")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("keeps links with only their href", () => {
    expect(
      serializeTeamsHtml('<p><a href="https://x" target="_blank" rel="noopener">y</a></p>'),
    ).toBe('<p><a href="https://x">y</a></p>');
  });

  it("strips tags outside the Teams-safe subset but keeps their text", () => {
    expect(serializeTeamsHtml('<p><span style="color:red">t</span></p><h1>H</h1>')).toBe(
      "<p>t</p>H",
    );
    // A structure the composer can't express (a table) unwraps to its words
    // rather than vanishing with them.
    expect(serializeTeamsHtml("<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>")).toBe(
      "ab",
    );
  });

  it("drops script content entirely", () => {
    expect(serializeTeamsHtml("<p>a<script>evil()</script>b</p>")).toBe("<p>ab</p>");
  });

  it("re-escapes text so it round-trips safely", () => {
    expect(serializeTeamsHtml("<p>a &lt; b &amp; c</p>")).toBe("<p>a &lt; b &amp; c</p>");
  });

  it("returns an empty string for empty editor content", () => {
    expect(serializeTeamsHtml("<p></p>")).toBe("");
    expect(serializeTeamsHtml("<p>   </p>")).toBe("");
  });

  it("trims the blank edges of the body", () => {
    // The empty paragraph a trailing Enter opened, at either edge.
    expect(serializeTeamsHtml("<p></p><p>hi</p><p></p>")).toBe("<p>hi</p>");
    // The hard break a Shift+Enter left on the last line, inside the block.
    expect(serializeTeamsHtml("<p>hi<br></p>")).toBe("<p>hi</p>");
    expect(serializeTeamsHtml("<p><br>hi<br><br></p>")).toBe("<p>hi</p>");
    // The spaces around the words, at the edges only.
    expect(serializeTeamsHtml("<p>  hi  there  </p>")).toBe("<p>hi  there</p>");
    // A break between two lines is content, not an edge.
    expect(serializeTeamsHtml("<p>one<br>two</p>")).toBe("<p>one<br>two</p>");
    // A block emptied by the trim goes with it, and the block behind becomes the
    // new edge.
    expect(serializeTeamsHtml("<p>hi</p><p><br></p><p> </p>")).toBe("<p>hi</p>");
    // The edge of a list, of a quote, and of a nested mark. Only the two edges of
    // the MESSAGE are trimmed, so the first item loses its leading space and the
    // last its trailing break — a space inside the list is left where it is, as
    // HTML collapses it anyway.
    expect(serializeTeamsHtml("<ul><li> a </li><li> b<br></li></ul>")).toBe(
      "<ul><li>a </li><li> b</li></ul>",
    );
    expect(serializeTeamsHtml("<blockquote><p> q<br></p></blockquote>")).toBe(
      "<blockquote><p>q</p></blockquote>",
    );
    expect(serializeTeamsHtml("<p><strong> bold </strong></p>")).toBe(
      "<p><strong>bold</strong></p>",
    );
  });

  it("keeps the whitespace a code block owns", () => {
    // Indentation is content in a code block, so the edge trim stops at one.
    expect(serializeTeamsHtml("<pre><code>  indented\n</code></pre>")).toBe(
      "<pre><code>  indented\n</code></pre>",
    );
    // The blank blocks around it still go.
    expect(serializeTeamsHtml("<p></p><pre><code> x </code></pre><p><br></p>")).toBe(
      "<pre><code> x </code></pre>",
    );
  });
});
