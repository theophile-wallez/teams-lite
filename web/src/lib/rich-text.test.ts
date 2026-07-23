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
  it("renders a Skype mention span as a mention node", () => {
    const html =
      '<span itemtype="http://schema.skype.com/Mention" itemid="0">Alice Smith</span>';
    const [m] = parseRichHtml(html);
    expect(m).toMatchObject({ tag: "mention" });
    expect(text(parseRichHtml(html))).toBe("Alice Smith");
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
});
