import { describe, expect, it } from "vitest";
import { agentMarkdownToHtml } from "./agent-markdown";

// The Rust module's own tests (src/agent_markdown.rs), case for case.
//
// That is the point of this file: the backend converts the answer to HTML for Teams and
// this module converts the SAME answer for the live bubble, so any drift between them
// would show as a body that reformats itself the moment the run finishes. Change one and
// this suite tells you to change the other.

describe("agentMarkdownToHtml — the Rust module's cases", () => {
  it("keeps a paragraph's line breaks", () => {
    expect(agentMarkdownToHtml("one\ntwo")).toBe("<p>one<br>two</p>");
    expect(agentMarkdownToHtml("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  it("escapes text before adding any markup", () => {
    expect(agentMarkdownToHtml('a < b & "c"')).toBe("<p>a &lt; b &amp; &quot;c&quot;</p>");
    expect(agentMarkdownToHtml("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("renders a fenced block as pre/code with its content escaped", () => {
    expect(agentMarkdownToHtml("```rust\nlet x: Vec<u8> = vec![];\n```")).toBe(
      "<pre><code>let x: Vec&lt;u8&gt; = vec![];</code></pre>",
    );
  });

  it("renders an unterminated fence — the normal state mid-stream", () => {
    expect(agentMarkdownToHtml("```\nhalf a line")).toBe("<pre><code>half a line</code></pre>");
  });

  it("turns inline code and bold into markup, and nothing else", () => {
    expect(agentMarkdownToHtml("run `cargo test` now")).toBe(
      "<p>run <code>cargo test</code> now</p>",
    );
    expect(agentMarkdownToHtml("**yes** and no")).toBe("<p><strong>yes</strong> and no</p>");
    // An identifier is not emphasis.
    expect(agentMarkdownToHtml("call some_function_name")).toBe("<p>call some_function_name</p>");
  });

  it("leaves asterisks inside a code span alone", () => {
    expect(agentMarkdownToHtml("`a ** b`")).toBe("<p><code>a ** b</code></p>");
  });

  it("closes a span the answer opened and never closed", () => {
    expect(agentMarkdownToHtml("half a `span")).toBe("<p>half a <code>span</code></p>");
    expect(agentMarkdownToHtml("half a **span")).toBe("<p>half a <strong>span</strong></p>");
  });

  it("gathers a bullet list into one ul", () => {
    expect(agentMarkdownToHtml("- one\n- two\n\nafter")).toBe(
      "<ul><li>one</li><li>two</li></ul><p>after</p>",
    );
  });

  it("gathers a numbered list into one ol", () => {
    expect(agentMarkdownToHtml("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("does not merge a list into the paragraph above it", () => {
    expect(agentMarkdownToHtml("intro\n- one")).toBe("<p>intro</p><ul><li>one</li></ul>");
  });

  it("turns a heading into a bold paragraph", () => {
    expect(agentMarkdownToHtml("## The answer")).toBe("<p><strong>The answer</strong></p>");
  });

  it("turns a quote into a blockquote", () => {
    expect(agentMarkdownToHtml("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
  });

  it("renders an empty answer as nothing", () => {
    expect(agentMarkdownToHtml("")).toBe("");
    expect(agentMarkdownToHtml("\n\n  \n")).toBe("");
  });
});

describe("agentMarkdownToHtml — streaming a prefix at a time", () => {
  // Every prefix of an answer is rendered, because that is what the live bubble
  // renders: one character more, once a frame. None of them may throw, and none may
  // produce unbalanced markup — a stray `<code>` would swallow the rest of the bubble.
  it("renders every prefix of a real answer with balanced tags", () => {
    const answer =
      "The port is `19420`.\n\n" +
      "It lives in **src/bin/server.rs**:\n" +
      "- the send-capable backend\n" +
      "- the read-only one on 19430\n\n" +
      "```rust\nconst DEFAULT_PORT: u16 = 19420;\n```\n\n" +
      "> and the table in CLAUDE.md says so too";
    for (let i = 0; i <= answer.length; i += 1) {
      const html = agentMarkdownToHtml(answer.slice(0, i));
      for (const tag of ["p", "code", "strong", "li", "ul", "ol", "pre", "blockquote"]) {
        const open = html.match(new RegExp(`<${tag}>`, "g"))?.length ?? 0;
        const close = html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
        expect(open, `<${tag}> at prefix ${i}: ${html}`).toBe(close);
      }
    }
  });
});
