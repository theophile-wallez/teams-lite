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

  it("prints the text verbatim, with its block breaks preserved", () => {
    const out = render(card({ text: "3 fatal log lines.\nCluster: eu-central-1" }));
    expect(out).toContain("3 fatal log lines.\nCluster: eu-central-1");
    // The breaks come from the wrapping, not from markup injected into the body.
    expect(out).toContain("whitespace-pre-wrap");
  });

  it("escapes the card text instead of treating it as markup", () => {
    // `card.text` is PLAIN text from the backend, even when it reads like HTML.
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
});
