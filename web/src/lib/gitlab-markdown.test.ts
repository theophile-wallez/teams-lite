// The GitLab markdown parser. Every case below is a construct
// `examples/merge_request_markdown_recon.rs` measured in the descriptions of this instance's
// own open merge requests — including the three it measured ZERO of, which are here to pin
// what must NOT happen to them.
import { describe, it, expect } from "vitest";
import { parseGitLabMarkdown } from "./gitlab-markdown";
import type { RichNode } from "./rich-text";

/** The plain text of a tree, so an assertion can say what a block READS as. */
function text(nodes: RichNode[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : text(node.children))).join("");
}

/** Every element with a given tag, depth-first. */
function find(nodes: RichNode[], tag: string): Extract<RichNode, { type: "element" }>[] {
  const found: Extract<RichNode, { type: "element" }>[] = [];
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.tag === tag) found.push(node);
    found.push(...find(node.children, tag));
  }
  return found;
}

/** The tags of a tree's top-level blocks. */
function tags(nodes: RichNode[]): string[] {
  return nodes.map((node) => (node.type === "element" ? node.tag : "text"));
}

describe("parseGitLabMarkdown — headings", () => {
  it("reads an ATX heading rather than printing its hashes", () => {
    const nodes = parseGitLabMarkdown("## What changed\nTwo replicas.");
    expect(tags(nodes)).toEqual(["h2", "p"]);
    expect(text([nodes[0]!])).toBe("What changed");
  });

  it("collapses the levels the renderer does not draw", () => {
    expect(tags(parseGitLabMarkdown("#### Deep"))).toEqual(["h3"]);
    expect(tags(parseGitLabMarkdown("###### Deeper"))).toEqual(["h3"]);
  });

  it("drops the closing hashes some authors balance a heading with", () => {
    expect(text(parseGitLabMarkdown("## Summary ##"))).toBe("Summary");
  });

  it("reads a setext underline as the heading it is, not as a rule under a stub", () => {
    const nodes = parseGitLabMarkdown("Rollout plan\n---\nOne cluster at a time.");
    expect(tags(nodes)).toEqual(["h2", "p"]);
    expect(text([nodes[0]!])).toBe("Rollout plan");
  });

  it("keeps a hash that opens no heading as the words it is", () => {
    expect(tags(parseGitLabMarkdown("#42 is the ticket"))).toEqual(["p"]);
    expect(text(parseGitLabMarkdown("#42 is the ticket"))).toBe("#42 is the ticket");
  });
});

describe("parseGitLabMarkdown — fenced code", () => {
  it("keeps a fenced block verbatim, markdown characters and all", () => {
    const nodes = parseGitLabMarkdown("Run it:\n```sh\nhelmfile apply --set a=*b*\n# not a heading\n```\nDone.");
    expect(tags(nodes)).toEqual(["p", "pre", "p"]);
    const [pre] = find(nodes, "pre");
    expect(text([pre!])).toBe("helmfile apply --set a=*b*\n# not a heading");
    // Nothing inside it was parsed: no emphasis, no heading.
    expect(find([pre!], "em")).toHaveLength(0);
    expect(find([pre!], "h1")).toHaveLength(0);
  });

  it("wraps the code in a `code` element, which is what the renderer paints", () => {
    const [pre] = find(parseGitLabMarkdown("```\nx\n```"), "pre");
    expect(tags(pre!.children)).toEqual(["code"]);
  });

  it("runs an unclosed fence to the end, the way a half-written draft reads", () => {
    const nodes = parseGitLabMarkdown("```\nstill typing\nand typing");
    expect(tags(nodes)).toEqual(["pre"]);
    expect(text(nodes)).toBe("still typing\nand typing");
  });

  it("takes tildes as a fence too, and only a fence of its own mark closes it", () => {
    const nodes = parseGitLabMarkdown("~~~\n```\n~~~");
    expect(tags(nodes)).toEqual(["pre"]);
    expect(text(nodes)).toBe("```");
  });
});

describe("parseGitLabMarkdown — tables", () => {
  const source = [
    "| Service | Replicas |",
    "| ------- | -------: |",
    "| `web`   | 2        |",
    "| api     | 2        |",
  ].join("\n");

  it("builds a real table out of a pipe table, header apart from body", () => {
    const nodes = parseGitLabMarkdown(source);
    expect(tags(nodes)).toEqual(["table"]);
    expect(find(nodes, "th").map((cell) => text([cell]))).toEqual(["Service", "Replicas"]);
    expect(find(nodes, "tr")).toHaveLength(3);
    expect(find(nodes, "td")).toHaveLength(4);
    // A cell is inline markdown of its own.
    expect(find(nodes, "code").map((cell) => text([cell]))).toEqual(["web"]);
  });

  it("squares a ragged row off to the header, so no row is drawn with holes in it", () => {
    const nodes = parseGitLabMarkdown("| a | b | c |\n|---|---|---|\n| 1 |\n");
    const [row] = find(nodes, "tbody");
    expect(find([row!], "td")).toHaveLength(3);
  });

  it("needs the delimiter row: a paragraph holding pipes stays a paragraph", () => {
    const nodes = parseGitLabMarkdown("use a | b to pipe it\nand nothing else");
    expect(tags(nodes)).toEqual(["p"]);
    expect(find(nodes, "table")).toHaveLength(0);
  });

  it("keeps a pipe the author escaped inside the cell that holds it", () => {
    const nodes = parseGitLabMarkdown("| cmd |\n|---|\n| a \\| b |");
    expect(find(nodes, "td").map((cell) => text([cell]))).toEqual(["a | b"]);
  });
});

describe("parseGitLabMarkdown — lists", () => {
  it("gathers a run of items into one list", () => {
    const nodes = parseGitLabMarkdown("- web\n- api\n- worker");
    expect(tags(nodes)).toEqual(["ul"]);
    expect(find(nodes, "li")).toHaveLength(3);
  });

  it("nests a sub-list inside the item it hangs under", () => {
    const nodes = parseGitLabMarkdown("- clusters\n  - eu\n  - us\n- done");
    const [outer] = find(nodes, "ul");
    expect(outer!.children).toHaveLength(2);
    const nested = find([outer!.children[0]!], "ul");
    expect(nested).toHaveLength(1);
    expect(find(nested, "li").map((item) => text([item]))).toEqual(["eu", "us"]);
  });

  it("keeps a numbered list numbered, and starts a new list when the kind changes", () => {
    const nodes = parseGitLabMarkdown("1. stop the pod\n2. read the events\n- unrelated");
    expect(tags(nodes)).toEqual(["ol", "ul"]);
  });

  it("draws a task list's own state, since a description is read and never ticked", () => {
    const nodes = parseGitLabMarkdown("- [x] migration written\n- [ ] rollout scheduled");
    const items = find(nodes, "li").map((item) => text([item]));
    expect(items).toEqual(["☑ migration written", "☐ rollout scheduled"]);
  });

  it("holds a fenced block that sits inside an item", () => {
    const nodes = parseGitLabMarkdown("- run this:\n\n  ```\n  helmfile apply\n  ```\n- then wait");
    const [outer] = find(nodes, "ul");
    expect(outer!.children).toHaveLength(2);
    expect(text(find([outer!.children[0]!], "pre"))).toBe("helmfile apply");
  });

  it("reads a line the author wrapped as part of the item it continues", () => {
    const nodes = parseGitLabMarkdown("- a reason long enough to wrap\nover to the next line\n- another");
    expect(tags(nodes)).toEqual(["ul"]);
    expect(find(nodes, "li")).toHaveLength(2);
    expect(text([find(nodes, "li")[0]!])).toContain("over to the next line");
  });

  it("leads a tight item with its own words, not with a paragraph's worth of air", () => {
    const [item] = find(parseGitLabMarkdown("- plain"), "li");
    expect(tags(item!.children)).toEqual(["text"]);
  });
});

describe("parseGitLabMarkdown — the rest of the blocks", () => {
  it("joins a paragraph the author hard-wrapped instead of making each line a block", () => {
    const nodes = parseGitLabMarkdown("This adds two replicas\nand a disruption budget.");
    expect(tags(nodes)).toEqual(["p"]);
    expect(text(nodes)).toBe("This adds two replicas\nand a disruption budget.");
  });

  it("honours the break a line asks for with two trailing spaces", () => {
    const nodes = parseGitLabMarkdown("first  \nsecond");
    expect(tags(nodes)).toEqual(["p"]);
    expect(tags((nodes[0] as Extract<RichNode, { type: "element" }>).children)).toEqual([
      "text",
      "br",
      "text",
    ]);
  });

  it("reads a thematic break as a rule, where a card parser dropped the line entirely", () => {
    expect(tags(parseGitLabMarkdown("above\n\n---\n\nbelow"))).toEqual(["p", "hr", "p"]);
    expect(tags(parseGitLabMarkdown("***"))).toEqual(["hr"]);
  });

  it("quotes a blockquote, and parses what is inside it", () => {
    const nodes = parseGitLabMarkdown("> the reviewer asked:\n> - why two?\n\nBecause of the budget.");
    expect(tags(nodes)).toEqual(["blockquote", "p"]);
    expect(find(nodes, "li")).toHaveLength(1);
  });

  it("renders nothing for a description that holds nothing", () => {
    expect(parseGitLabMarkdown("")).toEqual([]);
    expect(parseGitLabMarkdown("\n\n   \n")).toEqual([]);
  });
});

describe("parseGitLabMarkdown — what it deliberately does NOT do", () => {
  // Measured: not one of the 40 newest open merge requests has an indented code block, and
  // all 260 of the sample's four-space lines were a list item's continuation or fence
  // content. Reading them as code would draw sub-bullets as grey slabs.
  it("never reads four spaces as a code block", () => {
    const nodes = parseGitLabMarkdown("- item\n    still the item");
    expect(find(nodes, "pre")).toHaveLength(0);
    const indented = parseGitLabMarkdown("plain text\n\n    four spaces here");
    expect(find(indented, "pre")).toHaveLength(0);
    expect(tags(indented)).toEqual(["p", "p"]);
  });

  it("leaves raw HTML the author's own literal text", () => {
    const nodes = parseGitLabMarkdown("<details><summary>Logs</summary>\nhidden\n</details>");
    expect(find(nodes, "card")).toHaveLength(0);
    expect(text(nodes)).toContain("<details>");
    expect(text(nodes)).toContain("Logs");
  });

  it("never turns an image into something the browser would fetch", () => {
    const nodes = parseGitLabMarkdown("![the graph](https://example.test/a.png)");
    expect(find(nodes, "img")).toHaveLength(0);
    const [link] = find(nodes, "a");
    expect(link!.attrs.href).toBe("https://example.test/a.png");
    expect(text([link!])).toBe("the graph");
  });

  it("leaves a GitLab upload's relative address as text, since it would answer 401", () => {
    const nodes = parseGitLabMarkdown("![shot](/uploads/abc/shot.png)");
    expect(find(nodes, "a")).toHaveLength(0);
    expect(find(nodes, "img")).toHaveLength(0);
  });

  it("refuses a scheme that is not a link", () => {
    expect(find(parseGitLabMarkdown("[click](javascript:alert(1))"), "a")).toHaveLength(0);
  });
});

describe("parseGitLabMarkdown — inline markup inside a block", () => {
  it("marks up a heading and a table cell the same way it marks up a paragraph", () => {
    expect(find(parseGitLabMarkdown("## a **bold** heading"), "strong")).toHaveLength(1);
    expect(find(parseGitLabMarkdown("| **a** |\n|---|\n| `b` |"), "strong")).toHaveLength(1);
  });

  it("keeps a snake_case identifier out of italics", () => {
    expect(find(parseGitLabMarkdown("the topic_listener_send_emails pod"), "em")).toHaveLength(0);
  });

  it("links a bare URL and an autolink alike, without the brackets", () => {
    const bare = find(parseGitLabMarkdown("see https://example.test/x for it"), "a");
    expect(bare[0]!.attrs.href).toBe("https://example.test/x");
    const auto = find(parseGitLabMarkdown("see <https://example.test/y>"), "a");
    expect(auto[0]!.attrs.href).toBe("https://example.test/y");
    expect(text(parseGitLabMarkdown("see <https://example.test/y>"))).toBe("see https://example.test/y");
  });
});
