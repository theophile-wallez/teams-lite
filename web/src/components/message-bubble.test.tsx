// DOM-level tests for the message bubble: how a body is READ (a `Text` body is not
// HTML), what a forwarded block says, what a message with nothing in it renders as,
// and how a card message drops the bubble chrome.
//
// The bubble reads app state and the controller, so it is rendered inside a real
// `ControllerProvider` pointed at an unreachable URL: server-rendering runs no
// effects, so nothing connects, fetches, or enriches — the markup below is exactly
// what the pane paints on first paint.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "./message-bubble";
import { ControllerProvider } from "./controller-context";
import type { Attachment, ChatMessage } from "~/lib/protocol";

/** A backend URL nothing listens on: the provider only constructs a client here. */
const OFFLINE_URL = "ws://127.0.0.1:1";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    conversation_id: "c1",
    seq: 1,
    compose_time: 1,
    sender: "Ada Lovelace",
    sender_mri: "8:orgid:ada",
    content: "",
    ...over,
  };
}

function render(
  msg: ChatMessage,
  over: { onPanel?: boolean; onQuoteJump?: () => void } = {},
): string {
  return renderToStaticMarkup(
    <ControllerProvider url={OFFLINE_URL}>
      <MessageBubble
        message={msg}
        showSenderName={false}
        editing={false}
        continuesAbove={false}
        continuesBelow={false}
        onPanel={over.onPanel}
        onQuoteJump={over.onQuoteJump}
        onReply={() => {}}
        onCopy={() => {}}
        onReact={() => {}}
        onStartEdit={() => {}}
        onSaveEdit={() => {}}
        onCancelEdit={() => {}}
        onDelete={() => {}}
      />
    </ControllerProvider>,
  );
}

describe("MessageBubble — plain-text bodies", () => {
  it("keeps angle-bracketed text a `Text` body carries (repro 1775231521568)", () => {
    const out = render(message({ message_type: "Text", content: "pour moi c'est <yyyy>-<id>" }));
    expect(out).toContain("pour moi c&#x27;est &lt;yyyy&gt;-&lt;id&gt;");
  });

  it("shows a tag-looking body as text rather than applying it", () => {
    const out = render(message({ message_type: "Text", content: "Vec<String> <b>x</b>" }));
    expect(out).toContain("Vec&lt;String&gt; &lt;b&gt;x&lt;/b&gt;");
    expect(out).not.toContain("<b>x</b>");
  });

  it("links a bare URL in a plain body", () => {
    const out = render(message({ message_type: "Text", content: "see https://example.com/a" }));
    expect(out).toContain('href="https://example.com/a"');
  });

  it("still reads an untyped (legacy) body as HTML", () => {
    const out = render(message({ content: "<p>hello <b>world</b></p>" }));
    expect(out).toContain('<strong class="font-semibold">world</strong>');
  });
});

describe("MessageBubble — nothing to show", () => {
  it("never renders an empty coloured bubble for a message with no payload", () => {
    const out = render(message({ content: "" }));
    expect(out).toContain('data-unsupported="true"');
    expect(out).toContain("Unsupported message");
    // The ghost chrome, not the accent fill a real message gets.
    expect(out).toContain("border-dashed");
    expect(out).not.toContain("bg-bubble-incoming");
  });

  it("offers no actions on it — there is nothing to reply to, copy or react to", () => {
    const out = render(message({ content: "" }));
    expect(out).not.toContain('data-testid="message-actions"');
  });

  it("says nothing of the sort for a message that does have content", () => {
    expect(render(message({ content: "<p>hi</p>" }))).not.toContain("Unsupported message");
  });

  it("leaves a deleted message to its own placeholder", () => {
    const out = render(message({ content: "", deleted: true }));
    expect(out).toContain('data-testid="deleted-message"');
    expect(out).not.toContain("Unsupported message");
  });
});

describe("MessageBubble — forwarded quotes", () => {
  const FORWARD =
    `<p>ouh lala</p>` +
    `<blockquote itemtype="http://schema.skype.com/Forward">` +
    `<p>For clarification our current issue is they're being logged out.</p>` +
    `</blockquote>`;

  it("labels a forwarded block, which Teams sends with no author at all", () => {
    const out = render(message({ content: FORWARD }));
    expect(out).toContain('data-testid="quote-forwarded"');
    expect(out).toContain("Forwarded");
    expect(out).toContain("logged out");
  });

  it("does not label an ordinary reply as forwarded", () => {
    const reply =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
      `<strong itemprop="mri" itemid="8:orgid:abc">Clement BOSLE</strong>` +
      `<p itemprop="preview">the original line</p></blockquote><p>my reply</p>`;
    const out = render(message({ content: reply }));
    expect(out).not.toContain("Forwarded");
    expect(out).toContain("Clement BOSLE");
  });

  it("keeps an image-only forward inside the quote block, not on the picture mat", () => {
    // A forward now sets a quote, so the frameless image-only treatment no longer
    // applies — the picture belongs to the quoted block.
    const imageForward =
      `<blockquote itemtype="http://schema.skype.com/Forward">` +
      `<p><img src="https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo" alt=""></p>` +
      `</blockquote>`;
    const out = render(message({ content: imageForward }));
    expect(out).toContain("Forwarded");
    expect(out).not.toContain('data-testid="image-mat"');
    expect(out).not.toContain('data-image-only="true"');
  });
});

describe("MessageBubble — a quote goes to what it quotes", () => {
  /** A reply as Teams composes one: the quoted message's id is its ms-epoch compose
   *  time, and the blockquote repeats it in `itemprop="time"`. */
  const REPLY =
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1786092366140">` +
    `<strong itemprop="mri" itemid="8:orgid:abc">Clement BOSLE</strong>` +
    `<span itemprop="time" itemid="1786092366140"></span>` +
    `<p itemprop="preview">the original line</p></blockquote><p>my reply</p>`;

  it("offers a reply's quote as a control, because the quote names its target", () => {
    const out = render(message({ content: REPLY }), { onQuoteJump: () => {} });
    expect(out).toContain('data-quote-jumpable="true"');
    expect(out).toContain('aria-label="Go to the quoted message"');
  });

  it("does not offer a FORWARD, whose payload names nothing to go to", () => {
    // Teams sends a forward with no author, no time and no id: the message it holds was
    // said somewhere else, and this app cannot know where.
    const forward =
      `<blockquote itemtype="http://schema.skype.com/Forward">` +
      `<p>For clarification our current issue is they're being logged out.</p>` +
      `</blockquote>`;
    const out = render(message({ content: forward }), { onQuoteJump: () => {} });
    expect(out).toContain('data-testid="message-quote"');
    expect(out).not.toContain("data-quote-jumpable");
  });

  it("draws the quote as a plain block on a surface with no history to move", () => {
    const out = render(message({ content: REPLY }));
    expect(out).toContain('data-testid="message-quote"');
    expect(out).not.toContain("data-quote-jumpable");
  });

  it("clamps a quoted body to three lines, so a wall of text cannot bury the reply", () => {
    const out = render(message({ content: REPLY }));
    expect(out).toContain("line-clamp-3");
    expect(out).toContain("my reply");
  });

  it("does not clamp a quote that is a picture, which cropping would cut rather than shorten", () => {
    const imageReply =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
      `<strong itemprop="mri" itemid="8:orgid:abc">Clement BOSLE</strong>` +
      `<p itemprop="preview">` +
      `<img src="https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo" alt="">` +
      `</p></blockquote><p>my reply</p>`;
    expect(render(message({ content: imageReply }))).not.toContain("line-clamp-3");
  });
});

describe("MessageBubble — card attachments", () => {
  const cardAttachment: Attachment = {
    name: "n-Alerts",
    content_type: "application/vnd.microsoft.teams.card.o365connector",
    url: "",
    kind: "card",
    card: {
      title: "Filebeat error(s)",
      text: "3 fatal log lines.",
      facts: [{ title: "level", value: "error" }],
      actions: [{ title: "View in Kibana", url: "https://kibana.example.com/x" }],
    },
  };

  it("renders a card message as a card, never as an empty bubble", () => {
    const out = render(message({ content: "", attachments: [cardAttachment] }));
    expect(out).toContain('data-testid="card-attachment"');
    expect(out).toContain("Filebeat error(s)");
    expect(out).not.toContain("Unsupported message");
  });

  it("drops the bubble chrome when the card IS the message", () => {
    const out = render(message({ content: "", attachments: [cardAttachment] }));
    expect(out).toContain('data-card-only="true"');
    expect(out).not.toContain("bg-bubble-incoming");
  });

  it("keeps the bubble when the card comes with text of its own", () => {
    const out = render(message({ content: "<p>look at this</p>", attachments: [cardAttachment] }));
    expect(out).toContain('data-testid="card-attachment"');
    expect(out).not.toContain('data-card-only="true"');
    expect(out).toContain("bg-bubble-incoming");
  });

  it("renders the card flush when the message already sits on a panel", () => {
    // The root post of a channel thread: the thread's card IS the post's surface,
    // so the card inside it draws no second one.
    const out = render(message({ content: "", attachments: [cardAttachment] }), {
      onPanel: true,
    });
    expect(out).toContain('data-on-panel="true"');
    expect(out).toContain("Filebeat error(s)");
  });

  it("keeps the card's own panel elsewhere", () => {
    const out = render(message({ content: "", attachments: [cardAttachment] }));
    expect(out).not.toContain('data-on-panel="true"');
  });
});
