// DOM-level tests for the adaptive/connector card surface. The backend flattens a
// `SWIFT.1` body into `{ title, text, facts, actions }` (see src/teams_cards.rs);
// these assert what that turns into — and, above all, that a non-link action never
// looks like something you can click, since acting on one would post as the user.
//
// The component is pure given its props, so server-rendering it to a string is
// enough: no DOM, no jsdom, same node environment as the rest of the suite.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardAttachment } from "./card-attachment";
import type { Attachment, CardPayload } from "~/lib/protocol";

function card(over: Partial<CardPayload> = {}): Attachment {
  return {
    name: "n-Alerts",
    content_type: "application/vnd.microsoft.card.adaptive",
    url: "",
    kind: "card",
    card: { title: "Filebeat error(s)", text: "", facts: [], actions: [], ...over },
  };
}

function render(attachment: Attachment): string {
  return renderToStaticMarkup(<CardAttachment attachment={attachment} />);
}

describe("CardAttachment", () => {
  it("shows the card's title", () => {
    expect(render(card())).toContain("Filebeat error(s)");
  });

  it("falls back to the attachment's own name when the card has no title", () => {
    expect(render(card({ title: "" }))).toContain("n-Alerts");
  });

  it("renders each of the text's blocks as its own paragraph", () => {
    const out = render(card({ text: "3 fatal log lines.\nCluster: eu-central-1" }));
    expect(out).toContain("<p");
    expect(out).toContain("3 fatal log lines.");
    expect(out).toContain("Cluster: eu-central-1");
  });

  it("escapes HTML in the card text instead of treating it as markup", () => {
    // The backend already stripped a card's HTML: what is left is literal text, and
    // it is React that escapes it — no `dangerouslySetInnerHTML` anywhere near a card.
    const out = render(card({ text: "<b>level</b>: error" }));
    expect(out).toContain("&lt;b&gt;level&lt;/b&gt;: error");
    expect(out).not.toContain("<b>level</b>");
  });

  it("lists facts as a compact label/value list", () => {
    const out = render(
      card({
        facts: [
          { title: "level", value: "error" },
          { title: "count", value: "3" },
        ],
      }),
    );
    expect(out).toContain("<dl");
    expect(out).toContain(">level</dt>");
    expect(out).toContain(">error</dd>");
    expect(out).toContain(">count</dt>");
  });

  it("renders a link action as an anchor that opens the target safely", () => {
    const out = render(
      card({ actions: [{ title: "View in Kibana", url: "https://kibana.example.com/x" }] }),
    );
    expect(out).toContain('href="https://kibana.example.com/x"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("View in Kibana");
  });

  it("renders a non-link action as inert text — never as something clickable", () => {
    // A poll vote / bot submit has no URL: performing it would post as the user.
    const out = render(card({ actions: [{ title: "Submit vote", url: "" }] }));
    expect(out).toContain("Submit vote");
    expect(out).toContain('data-testid="card-action-inert"');
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("<button");
    expect(out).not.toContain("hover:bg-accent");
  });

  it("still names itself when the payload never came through", () => {
    const bare: Attachment = { ...card(), card: undefined };
    expect(render(bare)).toContain("n-Alerts");
  });

  it("carries the card's content type, so adaptive and connector cards stay told apart", () => {
    expect(render(card())).toContain(
      'data-content-type="application/vnd.microsoft.card.adaptive"',
    );
  });
});

describe("CardAttachment — link unfurls", () => {
  // A card the backend recovered from `properties.cards` (see src/teams_unfurl.rs)
  // also knows which app produced the preview, which Teams shows as a source chip.
  const unfurl = (over: Partial<CardPayload> = {}) =>
    card({
      title: "theophile-wallez/teams-lite",
      app_name: "GitHub Notifications",
      app_icon: "https://cdn.example/github_largeimage.png",
      ...over,
    });

  it("names the app above the card title", () => {
    const out = render(unfurl());
    expect(out).toContain('data-testid="card-app-name"');
    expect(out).toContain("GitHub Notifications");
    expect(out).toContain("theophile-wallez/teams-lite");
  });

  it("shows the app's own icon in place of the generic card glyph", () => {
    const out = render(unfurl());
    expect(out).toContain('data-testid="card-app-icon"');
    expect(out).toContain("https://cdn.example/github_largeimage.png");
  });

  it("does not repeat the app name when it is already the title", () => {
    const out = render(unfurl({ title: "Figma", app_name: "Figma" }));
    expect(out).not.toContain('data-testid="card-app-name"');
    expect(out).toContain("Figma");
  });

  it("falls back to the generic glyph for a card posted by a bot (no app)", () => {
    const out = render(card());
    expect(out).not.toContain('data-testid="card-app-icon"');
    expect(out).not.toContain('data-testid="card-app-name"');
  });
});

describe("CardAttachment — card text", () => {
  it("drops a line that is only a separator, keeping the content around it", () => {
    // How a real GitHub unfurl flattens: "Rust", "•", "12 Stars" as three blocks.
    const out = render(card({ text: "Repository | acme/webapp\nRust\n•\n12 Stars" }));
    expect(out).toContain("Repository | acme/webapp");
    expect(out).toContain("Rust");
    expect(out).toContain("12 Stars");
    expect(out).not.toMatch(/>\s*•\s*</);
  });

  it("keeps a line whose bullet introduces real content", () => {
    expect(render(card({ text: "• 3 fatal errors" }))).toContain("• 3 fatal errors");
  });

  it("renders no text paragraph at all when nothing survives", () => {
    expect(render(card({ text: "•\n|\n   " }))).not.toContain('data-testid="card-text"');
  });

  it("renders the card's markdown — bold labels and short link text", () => {
    // The shape a Grafana alert relayed by Workflows arrives in: a bold severity and
    // a two-word link over a URL long enough to fill the bubble on its own.
    const out = render(
      card({
        text: "**critical** — metabase restarted 12 times.\n[🪵 Logs](https://grafana.example/explore?left=%7B%22datasource%22%3A%22loki%22%7D)",
      }),
    );
    expect(out).toContain("<strong");
    expect(out).toContain("critical");
    expect(out).not.toContain("**critical**");
    expect(out).toContain('href="https://grafana.example/explore?left=%7B%22datasource%22%3A%22loki%22%7D"');
    expect(out).toContain("Logs");
    // The URL is the link's target, not its text.
    expect(out).not.toContain(">https://grafana.example");
  });

  it("renders a bullet list as a list", () => {
    const out = render(card({ text: "Impacted:\n- metabase\n- trace-api" }));
    expect(out).toContain("<ul");
    expect(out).toContain("<li");
    expect(out).toContain("metabase");
  });

  it("drops the generic 'Card' name once the card has content of its own", () => {
    // A bot's card often has no title: Teams shows its first block as the headline,
    // and printing the word "Card" above it says nothing the glyph does not.
    const bot: Attachment = { ...card(), name: "Card", card: { title: "", text: "✅ RESOLVED · release-us", facts: [], actions: [] } };
    const out = render(bot);
    expect(out).not.toContain('data-testid="card-title"');
    expect(out).toContain("✅ RESOLVED · release-us");
  });

  it("keeps the generic name when the card has nothing else to show", () => {
    // Losing the fact that a card was posted would be worse than a generic label.
    const empty: Attachment = { ...card(), name: "Card", card: undefined };
    expect(render(empty)).toContain("Card");
  });

  it("drops its own panel when it already sits on one", () => {
    // A channel thread draws the card around the whole post, so the card inside it
    // brings no fill, padding or shadow of its own — see `onPanel`.
    const out = renderToStaticMarkup(<CardAttachment attachment={card()} onPanel />);
    expect(out).toContain('data-on-panel="true"');
    expect(out).not.toContain("bg-card");
    expect(out).not.toContain("shadow-chip");
    // The content is untouched: only the frame goes.
    expect(out).toContain("Filebeat error(s)");
  });

  it("keeps its panel when it stands on its own", () => {
    const out = render(card());
    expect(out).toContain("bg-card");
    expect(out).toContain("shadow-chip");
  });
});
