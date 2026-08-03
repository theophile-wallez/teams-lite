// The card-text markdown parser. The cases are taken from the cards the tenant
// actually posts — Grafana alerts relayed by Workflows, GitHub unfurls, polls —
// because the whole point of the module is that those read correctly.
import { describe, it, expect } from "vitest";
import { parseCardMarkdown } from "./card-markdown";
import type { RichNode } from "./rich-text";

/** The plain text of a tree, so an assertion can say what a block READS as. */
function text(nodes: RichNode[]): string {
  return nodes
    .map((node) => (node.type === "text" ? node.text : text(node.children)))
    .join("");
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

describe("parseCardMarkdown — blocks", () => {
  it("makes each line its own block", () => {
    const nodes = parseCardMarkdown("✅ RESOLVED · release-us\nmetabase restarted 12 times.");
    expect(nodes.map((n) => (n.type === "element" ? n.tag : "text"))).toEqual(["p", "p"]);
    expect(text([nodes[0]!])).toBe("✅ RESOLVED · release-us");
  });

  it("drops blank lines and separator-only lines", () => {
    // How a GitHub unfurl flattens: "Rust", "•", "12 Stars" as three blocks.
    const nodes = parseCardMarkdown("Rust\n•\n\n12 Stars\n|\n   ");
    expect(nodes.map((n) => text([n]))).toEqual(["Rust", "12 Stars"]);
  });

  it("gathers consecutive bullet items into one list", () => {
    const nodes = parseCardMarkdown("Impacted:\n- metabase\n- trace-api\nSee the runbook.");
    expect(nodes.map((n) => (n.type === "element" ? n.tag : "text"))).toEqual(["p", "ul", "p"]);
    expect(find(nodes, "li").map((li) => text([li]))).toEqual(["metabase", "trace-api"]);
  });

  it("tells a numbered list from a bulleted one", () => {
    const nodes = parseCardMarkdown("1. stop the pod\n2. read the events");
    expect(find(nodes, "ol")).toHaveLength(1);
    expect(find(nodes, "li")).toHaveLength(2);
  });

  it("returns nothing for text that holds nothing", () => {
    expect(parseCardMarkdown("")).toEqual([]);
    expect(parseCardMarkdown("•\n—\n  ")).toEqual([]);
  });
});

describe("parseCardMarkdown — inline markup", () => {
  it("reads bold, italic, strikethrough and inline code", () => {
    const nodes = parseCardMarkdown("**critical** _release-us_ ~~stale~~ `kubectl get pods`");
    expect(find(nodes, "strong").map((n) => text([n]))).toEqual(["critical"]);
    expect(find(nodes, "em").map((n) => text([n]))).toEqual(["release-us"]);
    expect(find(nodes, "s").map((n) => text([n]))).toEqual(["stale"]);
    expect(find(nodes, "code").map((n) => text([n]))).toEqual(["kubectl get pods"]);
    expect(text(nodes)).toBe("critical release-us stale kubectl get pods");
  });

  it("gives a link its label as text and its URL as the target", () => {
    const url = "https://grafana.example/explore?left=%7B%22datasource%22%3A%22loki%22%7D";
    const [link] = find(parseCardMarkdown(`[🪵 Logs](${url}) · [🔕 Silence](${url}&x=1)`), "a");
    expect(link?.attrs.href).toBe(url);
    expect(text([link!])).toBe("🪵 Logs");
  });

  it("keeps a link URL's own balanced parentheses", () => {
    const url = "https://kibana.example/app/discover#/?_g=(time:(from:now-1h,to:now))";
    const [link] = find(parseCardMarkdown(`[Open](${url})`), "a");
    expect(link?.attrs.href).toBe(url);
  });

  it("reads markup inside a link's label", () => {
    const nodes = parseCardMarkdown("[**acme/webapp**](https://github.com/acme/webapp)");
    expect(find(nodes, "a")).toHaveLength(1);
    expect(find(nodes, "strong").map((n) => text([n]))).toEqual(["acme/webapp"]);
  });

  it("links a bare URL the way a message body does", () => {
    const nodes = parseCardMarkdown("Filebeat error(s): https://kibana.example/app/discover.");
    const [link] = find(nodes, "a");
    // The sentence's full stop belongs to the sentence, not to the URL.
    expect(link?.attrs.href).toBe("https://kibana.example/app/discover");
    expect(text(nodes)).toBe("Filebeat error(s): https://kibana.example/app/discover.");
  });

  it("never reads a URL's own query string as markup", () => {
    // A Grafana silence link carries `__alert_rule_uid__`, which would otherwise come
    // out as bold and leave a broken URL behind.
    const url = "https://grafana.example/alerting/silence/new?matcher=__alert_rule_uid__%3Dcfto40";
    for (const source of [url, `[🔕 Silence](${url})`]) {
      const nodes = parseCardMarkdown(source);
      expect(find(nodes, "a")[0]?.attrs.href).toBe(url);
      expect(find(nodes, "strong")).toHaveLength(0);
    }
  });

  it("leaves an identifier's underscores alone", () => {
    const nodes = parseCardMarkdown("pod topic_listener_send_emails restarted");
    expect(find(nodes, "em")).toHaveLength(0);
    expect(text(nodes)).toBe("pod topic_listener_send_emails restarted");
  });

  it("leaves arithmetic and lone delimiters as text", () => {
    for (const source of ["restarted 11 times (budget: 5/h) * 2", "an unclosed **bold", "a [link that never opens"]) {
      expect(text(parseCardMarkdown(source))).toBe(source);
    }
  });

  it("prints an escaped delimiter as itself", () => {
    expect(text(parseCardMarkdown("literal \\*stars\\* here"))).toBe("literal *stars* here");
  });

  it("does not parse HTML — the backend already stripped it", () => {
    expect(text(parseCardMarkdown("<b>level</b>: error"))).toBe("<b>level</b>: error");
  });

  it("refuses a link whose target is not a displayable scheme", () => {
    // A card comes from a bot; a `javascript:` "link" in one is not a link.
    const nodes = parseCardMarkdown("[Click](javascript:alert(1))");
    expect(find(nodes, "a")).toHaveLength(0);
    expect(text(nodes)).toContain("Click");
  });
});
