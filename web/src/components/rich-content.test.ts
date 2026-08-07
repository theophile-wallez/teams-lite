// DOM-level tests for the message-body renderer. `parseRichHtml` decides *what*
// a message contains (see lib/rich-text.test.ts); these assert what it turns
// into: real tables, headings that stay bubble-sized, one background on a code
// block, a separator, and a summary card for a relayed email.
//
// The renderer is pure given its props, so server-rendering it to a string is
// enough — no DOM, no jsdom, which keeps these in the same node environment as
// the rest of the suite. Written with `createElement` rather than JSX so the file
// stays a `.test.ts` the suite already picks up.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichContent } from "./rich-content";

/** Server-render a message body the way the message pane would. */
function render(html: string): string {
  return renderToStaticMarkup(createElement(RichContent, { html }));
}

const EMOJI_IMG =
  '<img itemscope="" itemtype="http://schema.skype.com/Emoji" itemid="smile" ' +
  'src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/' +
  'emoticons/smile/default/20_f.png" alt="🙂" style="width:20px; height:20px">';

describe("RichContent — Teams emoji", () => {
  it("renders an emoji as text, never as a picture card", () => {
    const out = render(`<p>hi ${EMOJI_IMG}</p>`);
    expect(out).toContain("hi 🙂");
    expect(out).not.toContain("<img");
  });
});

describe("RichContent — tables", () => {
  const out = render(
    "<table><thead><tr><th>Metric</th><th>Count</th></tr></thead>" +
      "<tbody><tr><td>Total</td><td>61</td><td>&nbsp;</td></tr></tbody></table>",
  );

  it("renders a real table with header and body rows", () => {
    expect(out).toContain("<table");
    expect(out).toContain("<thead>");
    expect(out).toContain("<th");
    expect(out).toContain(">Metric</th>");
    expect(out).toContain(">Total</td>");
  });

  it("scrolls a wide table inside the bubble instead of stretching it", () => {
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("max-w-full");
  });

  it("renders an empty cell as an empty cell, not a blank line", () => {
    expect(out).toMatch(/<td[^>]*><\/td>/);
  });

  it("passes a sane colspan through to the cell", () => {
    // Attribute names are case-insensitive in HTML; React writes it `colSpan`.
    const cells = render('<table><tbody><tr><td colspan="2">a</td></tr></tbody></table>');
    expect(cells.toLowerCase()).toContain('colspan="2"');
  });
});

describe("RichContent — headings", () => {
  it("keeps heading levels, at bubble scale", () => {
    const out = render("<h1>One</h1><h2>Two</h2><h3>Three</h3>");
    expect(out).toContain("<h1");
    expect(out).toContain("<h2");
    expect(out).toContain("<h3");
    // Bolder and only slightly bigger — nowhere near page-heading scale.
    expect(out).toContain("font-semibold");
    expect(out).toContain("text-[1.15em]");
    expect(out).not.toContain("text-2xl");
  });
});

describe("RichContent — small stuff", () => {
  it("renders <hr> as a separator", () => {
    expect(render("<p>a</p><hr><p>b</p>")).toContain("<hr");
  });

  it("renders <small> smaller than the body", () => {
    expect(render("<small>fine print</small>")).toMatch(/<small class="[^"]*text-\[0\.85em\]/);
  });

  it("paints one background on a code block, not two", () => {
    // Teams sends `<pre><code>`; the `pre` owns the surface, so the nested
    // `code` must not add its own (stacked slabs with doubled padding).
    const out = render("<pre><code>cargo test</code></pre>");
    expect(out).toContain("<pre");
    expect(out).toContain('<code class="font-mono">');
    expect(out.match(/bg-black\/10/g) ?? []).toHaveLength(1);
  });

  it("keeps inline code's own background outside a pre", () => {
    expect(render("<p>run <code>cargo test</code></p>")).toContain("bg-black/10");
  });

  it("surfaces an app link-unfurl card whose payload never arrived", () => {
    const out = render(
      '<span itemscope="" itemtype="http://schema.skype.com/InputExtension" itemid="c1">' +
        '<span itemprop="cardId"></span></span>',
    );
    expect(out).toContain("Link preview unavailable");
  });

  it("renders an app card's inline content when it has some", () => {
    const out = render(
      '<span itemscope="" itemtype="http://schema.skype.com/InputExtension" itemid="c1">' +
        "<p>Repo title</p></span>",
    );
    expect(out).toContain("Repo title");
    expect(out).not.toContain("Link preview unavailable");
  });

  it("drops the placeholder when the decoded card is rendered beside the body", () => {
    // The backend now recovers the payload from `properties.cards` and sends it as a
    // card attachment, so saying "unavailable" would contradict the card next to it.
    const body =
      '<p><a href="https://github.com/acme/webapp">acme/webapp</a>' +
      '<span itemscope="" itemtype="http://schema.skype.com/InputExtension" itemid="c1">' +
      '<span itemprop="cardId"></span></span></p>';
    const out = renderToStaticMarkup(
      createElement(RichContent, { html: body, cardShownSeparately: true }),
    );
    expect(out).not.toContain("Link preview unavailable");
    // The link the unfurl is about still renders.
    expect(out).toContain("acme/webapp");
  });

  it("still surfaces the placeholder when no card arrived to show instead", () => {
    const body =
      '<span itemscope="" itemtype="http://schema.skype.com/InputExtension" itemid="c1">' +
      '<span itemprop="cardId"></span></span>';
    const out = renderToStaticMarkup(
      createElement(RichContent, { html: body, cardShownSeparately: false }),
    );
    expect(out).toContain("Link preview unavailable");
  });
});

describe("RichContent — relayed HTML emails", () => {
  const EMAIL =
    '<div style="display:none; mso-hide:all">New issue from internal.</div>' +
    '<table style="width:100%"><tbody><tr><td>' +
    '<h1><a href="https://sentry.example.com"><img src="https://cdn.example.com/logo.png" alt="Sentry"></a></h1>' +
    "<h2>New issue</h2>" +
    '<h3><a href="https://sentry.example.com/issues/1/">QueryExecutionError</a></h3>' +
    '<img src="https://cdn.example.com/pixel.gif" width="1" height="1">' +
    '<a href="https://sentry.example.com/issues/1/">View on Sentry</a>' +
    "</td></tr></tbody></table>";
  const out = render(EMAIL);

  it("renders a compact summary instead of the email body", () => {
    expect(out).toContain('data-testid="email-summary"');
    expect(out).toContain("New issue");
    expect(out).toContain("QueryExecutionError");
    expect(out).toContain("View on Sentry");
    // Not the email's layout tables.
    expect(out).not.toContain("<table");
  });

  it("shows neither the hidden preheader nor the logo and tracking pixel", () => {
    expect(out).not.toContain("New issue from internal");
    expect(out).not.toContain("logo.png");
    expect(out).not.toContain("pixel.gif");
  });
});

// An agent tag in a body: the message carries the plain `@claude` prefix and nothing else
// (that is the whole design — see lib/agent-tag.ts), so the chip is recognised from the
// words and drawn with the composer's own component.
describe("RichContent — agent tags", () => {
  const CLAUDE = { backend: "claude", name: "Claude", prefix: "@claude" };
  const withAgents = (html: string, agents = [CLAUDE]) =>
    renderToStaticMarkup(createElement(RichContent, { html, agentTags: agents }));

  it("draws the prefix as the vendor's chip, and keeps the prompt", () => {
    const out = withAgents("<p>@claude which port does the backend listen on?</p>");
    expect(out).toContain('data-testid="agent-tag"');
    expect(out).toContain('data-agent="claude"');
    // The chip says the CLI's name in the vendor's own casing, and wears its mark.
    expect(out).toContain("Claude");
    expect(out).toContain('data-testid="claude-logo"');
    expect(out).toContain("which port does the backend listen on?");
    // The prefix itself is replaced by the chip — never both.
    expect(out).not.toContain("@claude");
  });

  it("leaves the prefix as words when no agent is offered", () => {
    // What the caller passes IS the gate: a colleague's message, or a thread nobody opted
    // in, offers none — see the memo in message-bubble.tsx.
    const out = withAgents("<p>@claude which port?</p>", []);
    expect(out).toContain("@claude which port?");
    expect(out).not.toContain('data-testid="agent-tag"');
  });

  it("draws an address that stands mid-sentence, because the backend reads one there", () => {
    const out = withAgents("<p>which port does the backend listen on, @claude?</p>");
    expect(out).toContain('data-testid="agent-tag"');
    // The author's own comma stays their text; only the prefix wears the chip.
    expect(out).toContain("which port does the backend listen on,");
    expect(out).not.toContain("@claude");
  });

  it("leaves a prefix that summons nothing as words", () => {
    // An address of another kind: glued to a word, so it is not a word of its own.
    const out = withAgents("<p>write to ping@claude.example</p>");
    expect(out).toContain("ping@claude.example");
    expect(out).not.toContain('data-testid="agent-tag"');
  });
});

describe("RichContent — markup validity", () => {
  it("never nests a block inside a paragraph", () => {
    // `<div>` maps to a paragraph, so message HTML routinely puts a list or a
    // table "inside" one. `<p><ul>` / `<p><div>` is invalid markup that the
    // browser re-parents, which breaks hydration — such a block renders as a
    // `<div>` instead.
    const out = render(
      "<div>lead<table><tbody><tr><td>a</td></tr></tbody></table></div>" +
        "<div><ul><li>x</li></ul></div><div><p>nested</p></div>",
    );
    expect(out).not.toMatch(/<p[^>]*>\s*<(div|ul|ol|table|pre|blockquote|p|h[1-3]|hr)\b/);
    // The content itself all survives.
    expect(out).toContain(">a</td>");
    expect(out).toContain("<li>x</li>");
    expect(out).toContain("nested");
  });
});
