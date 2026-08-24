// DOM-level tests for the message bubble: how a body is READ (a `Text` body is not
// HTML), what a forwarded block says, what a message with nothing in it renders as,
// how a card message drops the bubble chrome, and what a SEALED message draws — the
// withheld row for one this machine could not read, and the quiet padlock for one it did.
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
  over: { onPanel?: boolean; onQuoteJump?: () => void; showSenderName?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <ControllerProvider url={OFFLINE_URL}>
      <MessageBubble
        message={msg}
        showSenderName={over.showSenderName ?? false}
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

// A SEALED chat: the backend is the encryption boundary, so a message arrives here either as
// words with `seal: "opened"` on it or as one of the three states whose body is EMPTY (see
// lib/seal.ts and § A SEALED chat). Nothing below hands the bubble a ciphertext, because
// nothing ever does.
describe("MessageBubble — a message this machine could not read", () => {
  const locked = { seal: "locked" as const, seal_key_id: "9f2c", content: "" };

  it("draws the withheld row instead of words, never an empty coloured bubble", () => {
    const out = render(message(locked));
    expect(out).toContain('data-seal="locked"');
    expect(out).toContain('data-testid="sealed-message"');
    expect(out).toContain("Encrypted with a passphrase this app does not have.");
    // The ghost chrome a deletion gets, not the accent fill of a real message.
    expect(out).toContain("border-dashed");
    expect(out).not.toContain("bg-bubble-incoming");
  });

  it("is not read as a payload this client cannot show, which its empty body looks like", () => {
    // The trap this rule exists for: a locked body is empty on the wire, so every clause of
    // `isUnsupported` matches — and the row would blame this client for a passphrase it does
    // not hold.
    const out = render(message(locked));
    expect(out).not.toContain("Unsupported message");
    expect(out).not.toContain('data-unsupported="true"');
  });

  it("offers the one action that helps where a passphrase is what is missing", () => {
    const out = render(message(locked));
    expect(out).toContain('data-testid="sealed-add-passphrase"');
    expect(out).toContain("Add the passphrase");
  });

  it("offers nothing on the two states no passphrase would mend", () => {
    const newer = render(message({ seal: "newer", content: "" }));
    expect(newer).toContain("Encrypted by a newer version of this app.");
    expect(newer).not.toContain('data-testid="sealed-add-passphrase"');

    const damaged = render(message({ seal: "damaged", content: "" }));
    expect(damaged).toContain("Encrypted, and these bytes could not be read.");
    expect(damaged).not.toContain('data-testid="sealed-add-passphrase"');
  });

  it("offers none of the actions that need a body", () => {
    const out = render(
      message({
        ...locked,
        reactions: [{ key: "like", count: 2, mine: false }],
      }),
    );
    // No menu at all, so no reaction row, no edit, no copy, no "answer with".
    expect(out).not.toContain('data-testid="message-actions"');
    // No chips either, unlike an unsupported message: a chip is a control that toggles a
    // reaction on the message under it, and this row is a statement about a body that is
    // not here. It follows the deleted row.
    expect(out).not.toContain('data-testid="message-reactions"');
    // And no swipe-to-reply, which is the gesture half of the same rule.
    expect(out).not.toContain('data-testid="swipe-reply-indicator"');
  });

  it("draws nothing of a body that somehow arrived with it — not even a quote", () => {
    // Defensive: the backend empties a locked body (`msg_reader`), and this pins that the
    // page does not fall back to drawing one if a build ever stopped.
    const reply =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
      `<strong itemprop="mri" itemid="8:orgid:abc">Clement BOSLE</strong>` +
      `<p itemprop="preview">the original line</p></blockquote><p>my reply</p>`;
    const out = render(message({ ...locked, content: reply }));
    expect(out).toContain('data-testid="sealed-message"');
    expect(out).not.toContain('data-testid="message-quote"');
    expect(out).not.toContain("my reply");
    expect(out).not.toContain("the original line");
  });

  it("still says WHO said it, because the metadata was never sealed", () => {
    const out = render(message(locked), { showSenderName: true });
    expect(out).toContain('data-testid="sender-name"');
    expect(out).toContain("Ada Lovelace");
  });

  it("keeps the frameless treatments away, so one sentence is never left with no bubble", () => {
    // A picture's BYTES are never sealed, so a sealed message can arrive with a readable
    // attachment beside a body this machine cannot open — and `imageOnly` would otherwise
    // drop the chrome around a row whose whole content is that sentence.
    const picture: Attachment = {
      name: "screenshot.png",
      content_type: "image/png",
      url: "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo",
      kind: "image",
    };
    const out = render(message({ ...locked, attachments: [picture] }));
    expect(out).toContain('data-testid="sealed-message"');
    expect(out).toContain("border-dashed");
    expect(out).not.toContain('data-testid="image-mat"');
  });
});

describe("MessageBubble — a message this machine opened", () => {
  it("DRAWS NOTHING, and answers on hover", () => {
    // A padlock per bubble was the first shape and it was too loud: a sealed conversation is
    // sealed, and a mark on every row repeats one fact as many times as there are messages.
    // What stays is the answer for whoever asks — a plain `title` on the message itself.
    const out = render(message({ seal: "opened", content: "<p>the invoice numbers</p>" }));
    expect(out).toContain('data-seal="opened"');
    expect(out).not.toContain('data-testid="seal-mark"');
    expect(out).toContain('title="Encrypted before it reached Teams"');
    expect(out).toContain("the invoice numbers");
    // Words the reader CAN read: an ordinary bubble, no withheld row.
    expect(out).toContain("bg-bubble-incoming");
    expect(out).not.toContain('data-testid="sealed-message"');
  });

  it("changes nothing else about it — every action is still there", () => {
    const out = render(message({ seal: "opened", content: "<p>the invoice numbers</p>" }));
    expect(out).toContain('data-testid="message-actions"');
  });

  it("answers on a picture-only message too, which has no bubble to draw a mark in", () => {
    // The title rides the MESSAGE rather than its content, so the shapes that drop the bubble
    // chrome — a picture, a card, a link — still answer.
    const out = render(
      message({
        seal: "opened",
        content:
          `<p><img src="https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/a/views/imgo" alt=""></p>`,
      }),
    );
    expect(out).toContain('data-image-only="true"');
    expect(out).toContain('title="Encrypted before it reached Teams"');
  });

  it("says nothing at all on a message that was never sealed", () => {
    const out = render(message({ content: "<p>ordinary</p>" }));
    expect(out).not.toContain("data-seal=");
    expect(out).not.toContain("Encrypted before it reached Teams");
  });

  it("says nothing on a deleted message that had been sealed", () => {
    // The deletion is what the reader needs to know, and a padlock on a body that is gone
    // is a fact about nothing.
    const out = render(message({ seal: "opened", content: "<p>gone</p>", deleted: true }));
    expect(out).toContain('data-testid="deleted-message"');
    expect(out).not.toContain('data-testid="seal-mark"');
  });
});

describe("MessageBubble — a chat that is not sealed", () => {
  it("says nothing about sealing at all", () => {
    const out = render(message({ content: "<p>hi</p>" }));
    expect(out).not.toContain("data-seal");
    expect(out).not.toContain('data-testid="seal-mark"');
    expect(out).not.toContain('data-testid="sealed-message"');
  });

  it("draws an ordinary bubble for a backend too old to say anything about a seal", () => {
    // `seal` absent is what every build before this feature sent, and the message it
    // described was an ordinary one.
    const out = render(message({ content: "<p>hi</p>", seal: null }));
    expect(out).toContain("bg-bubble-incoming");
    expect(out).not.toContain('data-testid="seal-mark"');
    expect(out).toContain('data-testid="message-actions"');
  });
});
