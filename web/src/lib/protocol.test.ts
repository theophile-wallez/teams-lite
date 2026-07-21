// Behavior tests for the pure protocol helpers (message content parsing, history
// merge semantics, and sidebar/notification display logic). Mirrors the terminal
// UI's original tests (ui/src/message-content.test.ts, ui/src/message-history.test.ts)
// so the web and terminal clients stay observably identical.
import { describe, it, expect } from "vitest";
import {
  parseMessageContent,
  mergeMessages,
  appendLiveMessage,
  mergeOlderHistoryPage,
  mergeRefreshedHistoryPage,
  previewLine,
  convLabel,
  shouldNotify,
  replyToPayload,
  copyableMessageText,
} from "./protocol";
import type { ChatMessage, Conversation, MessagePage } from "./protocol";

function message(
  seq: number,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `m${seq}`,
    conversation_id: "c1",
    seq,
    compose_time: seq,
    sender: "Alice",
    content: `message ${seq}`,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    name: "General",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "",
    draft: "",
    ...overrides,
  };
}

// A real Teams reply captured from the tenant: quote first, reply body after.
const REPLY_AFTER_ONLY =
  `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">` +
  `<strong itemprop="mri" itemid="8:orgid:abc">Clement BOSLE</strong>` +
  `<span itemprop="time" itemid="1"></span>` +
  `<p itemprop="preview">the original line</p>` +
  `</blockquote>` +
  `<p>my actual reply</p>`;

// A reply with body text on BOTH sides of the quoted block.
const REPLY_BEFORE_AND_AFTER =
  `<p>before the quote</p>` +
  `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="2">` +
  `<strong itemprop="mri">Bob</strong>` +
  `<p itemprop="preview">original</p>` +
  `</blockquote>` +
  `<p>after the quote</p>`;

describe("parseMessageContent", () => {
  it("returns a bare body with HTML stripped and entities decoded when there is no quote", () => {
    const html = `<p>&quot;A&quot; &amp; &#39;B&#39; &lt;c&gt;&nbsp;end</p>`;
    const parsed = parseMessageContent(html);

    expect(parsed.quote).toBeUndefined();
    expect(parsed.beforeQuote).toBeUndefined();
    expect(parsed.afterQuote).toBeUndefined();
    expect(parsed.body).toBe(`"A" & 'B' <c> end`);
  });

  it("splits a Teams reply into quote (author + preview) and the body after it", () => {
    const parsed = parseMessageContent(REPLY_AFTER_ONLY);

    expect(parsed.quote).toBeDefined();
    expect(parsed.quote?.sender).toBe("Clement BOSLE");
    expect(parsed.quote?.text).toBe("the original line");
    expect(parsed.beforeQuote).toBe("");
    expect(parsed.afterQuote).toBe("my actual reply");
    expect(parsed.body).toBe("my actual reply");
    // The body must never leak the quoted preview text.
    expect(parsed.body).not.toContain("the original line");
  });

  it("keeps body text before AND after the quote, joined by a newline", () => {
    const parsed = parseMessageContent(REPLY_BEFORE_AND_AFTER);

    expect(parsed.quote?.sender).toBe("Bob");
    expect(parsed.quote?.text).toBe("original");
    expect(parsed.beforeQuote).toBe("before the quote");
    expect(parsed.afterQuote).toBe("after the quote");
    expect(parsed.body).toBe("before the quote\nafter the quote");
  });
});

describe("mergeMessages", () => {
  it("dedups by id with the incoming copy winning", () => {
    const current = [message(2, { content: "old" })];
    const incoming = [message(2, { content: "new" })];

    const merged = mergeMessages(current, incoming);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("new");
  });

  it("sorts by seq, then compose_time, then id — from out-of-order input", () => {
    const current = [message(2, { id: "m2", compose_time: 20 }), message(1, { id: "m1" })];
    const incoming = [message(2, { id: "m3", compose_time: 15 })];

    const merged = mergeMessages(current, incoming);

    // seq 1 first; within seq 2, the earlier compose_time (m3=15) precedes m2=20.
    expect(merged.map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
  });

  it("breaks a full seq/compose_time tie deterministically by id", () => {
    const current = [
      message(3, { id: "beta", compose_time: 3 }),
      message(3, { id: "alpha", compose_time: 3 }),
    ];

    expect(mergeMessages(current, []).map((m) => m.id)).toEqual(["alpha", "beta"]);
  });
});

describe("appendLiveMessage", () => {
  it("initializes history with has_more=true when there is no current page", () => {
    const page = appendLiveMessage(undefined, message(41));

    expect(page.messages.map((m) => m.seq)).toEqual([41]);
    expect(page.has_more).toBe(true);
  });

  it("appends and preserves the current has_more flag", () => {
    const current: MessagePage = { messages: [message(1)], has_more: false };

    const page = appendLiveMessage(current, message(2));

    expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(page.has_more).toBe(false);
  });

  it("replaces a message with the same id instead of duplicating it", () => {
    const current: MessagePage = {
      messages: [message(1, { content: "old" })],
      has_more: true,
    };

    const page = appendLiveMessage(current, message(1, { content: "edited" }));

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.content).toBe("edited");
  });
});

describe("mergeOlderHistoryPage", () => {
  it("prepends the older page and adopts its has_more", () => {
    const current: MessagePage = { messages: [message(41), message(42)], has_more: true };
    const older: MessagePage = { messages: [message(39), message(40)], has_more: false };

    const merged = mergeOlderHistoryPage(current, older);

    expect(merged.messages.map((m) => m.seq)).toEqual([39, 40, 41, 42]);
    expect(merged.has_more).toBe(false);
  });

  it("marks history complete when an empty older page arrives", () => {
    const current: MessagePage = { messages: [message(1), message(2)], has_more: true };

    const merged = mergeOlderHistoryPage(current, { messages: [], has_more: false });

    expect(merged.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(merged.has_more).toBe(false);
  });

  it("seeds from the incoming page when there is no current page", () => {
    const merged = mergeOlderHistoryPage(undefined, { messages: [message(1)], has_more: true });

    expect(merged.messages.map((m) => m.seq)).toEqual([1]);
    expect(merged.has_more).toBe(true);
  });
});

describe("mergeRefreshedHistoryPage", () => {
  it("preserves a deeper cache and its completed state on a newest-page refresh", () => {
    // The key semantic: the cache reaches further back (seq 1) than the refresh
    // (seq 41), so the refresh must NOT resurrect has_more.
    const current: MessagePage = {
      messages: Array.from({ length: 80 }, (_, i) => message(i + 1)),
      has_more: false,
    };
    const refresh: MessagePage = {
      messages: Array.from({ length: 40 }, (_, i) => message(i + 41)),
      has_more: true,
    };

    const merged = mergeRefreshedHistoryPage(current, refresh);

    expect(merged.messages).toHaveLength(80);
    expect(merged.has_more).toBe(false);
  });

  it("adopts the incoming has_more when oldest seqs are equal (not deeper)", () => {
    const current: MessagePage = {
      messages: Array.from({ length: 20 }, (_, i) => message(i + 41)),
      has_more: true,
    };
    const refresh: MessagePage = {
      messages: Array.from({ length: 40 }, (_, i) => message(i + 41)),
      has_more: false,
    };

    const merged = mergeRefreshedHistoryPage(current, refresh);

    expect(merged.messages).toHaveLength(40);
    expect(merged.has_more).toBe(false);
  });

  it("adopts the incoming has_more when the incoming page extends further back", () => {
    const current: MessagePage = { messages: [message(50), message(51)], has_more: false };
    const refresh: MessagePage = { messages: [message(40), message(50), message(51)], has_more: true };

    const merged = mergeRefreshedHistoryPage(current, refresh);

    expect(merged.messages.map((m) => m.seq)).toEqual([40, 50, 51]);
    expect(merged.has_more).toBe(true);
  });

  it("lets a refresh complete history that a live message initialized", () => {
    const live = appendLiveMessage(undefined, message(41));

    const opened = mergeRefreshedHistoryPage(live, {
      messages: [message(39), message(40)],
      has_more: false,
    });

    expect(opened.messages.map((m) => m.seq)).toEqual([39, 40, 41]);
    expect(opened.has_more).toBe(false);
  });

  it("seeds from the incoming page when there is no current page", () => {
    const merged = mergeRefreshedHistoryPage(undefined, { messages: [message(9)], has_more: true });

    expect(merged.messages.map((m) => m.seq)).toEqual([9]);
    expect(merged.has_more).toBe(true);
  });
});

describe("previewLine", () => {
  it("prefixes 'You:' when the last message was from me", () => {
    const c = conversation({ last_message_preview: "on my way", last_message_from_me: true });
    expect(previewLine(c)).toBe("You: on my way");
  });

  it("prefixes only the sender's first name in a group", () => {
    const c = conversation({
      kind: "group",
      last_message_preview: "hi team",
      last_message_sender: "Alice Wonderland",
    });
    expect(previewLine(c)).toBe("Alice: hi team");
  });

  it("treats an unknown-kind conversation as a group for the sender prefix", () => {
    const c = conversation({
      kind: "unknown",
      last_message_preview: "ping",
      last_message_sender: "Bob Builder",
    });
    expect(previewLine(c)).toBe("Bob: ping");
  });

  it("shows the bare body in a one-on-one where the sender is implicit", () => {
    const c = conversation({
      kind: "one_on_one",
      last_message_preview: "see you soon",
      last_message_sender: "Carol",
    });
    expect(previewLine(c)).toBe("see you soon");
  });

  it("returns an empty string when there is no preview", () => {
    expect(previewLine(conversation({ last_message_preview: "" }))).toBe("");
  });
});

describe("convLabel", () => {
  it("uses the name when present", () => {
    expect(convLabel(conversation({ name: "Design" }))).toBe("Design");
  });

  it("falls back to 'Notes' for a nameless notes conversation", () => {
    expect(convLabel(conversation({ name: "", kind: "notes" }))).toBe("Notes");
  });

  it("falls back to '(untitled)' otherwise", () => {
    expect(convLabel(conversation({ name: "", kind: "group" }))).toBe("(untitled)");
  });
});

describe("shouldNotify", () => {
  it("never notifies for our own messages", () => {
    expect(shouldNotify({ conversation_id: "c1", is_self: true }, null)).toBe(false);
  });

  it("does not notify for the conversation that is currently open", () => {
    expect(shouldNotify({ conversation_id: "c1", is_self: false }, "c1")).toBe(false);
  });

  it("notifies for another conversation or when nothing is open", () => {
    expect(shouldNotify({ conversation_id: "c2", is_self: false }, "c1")).toBe(true);
    expect(shouldNotify({ conversation_id: "c1", is_self: false }, null)).toBe(true);
  });
});

describe("copyableMessageText / replyToPayload", () => {
  it("uses the parsed body as the copyable text", () => {
    expect(copyableMessageText(message(1, { content: "<p>hello there</p>" }))).toBe("hello there");
  });

  it("falls back to the quote text when the reply has no body", () => {
    const quoteOnly =
      `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="9">` +
      `<strong itemprop="mri">Dana</strong>` +
      `<p itemprop="preview">quoted only</p>` +
      `</blockquote>`;
    expect(copyableMessageText(message(1, { content: quoteOnly }))).toBe("quoted only");
  });

  it("builds a reply payload with body-derived preview and passthrough before/after", () => {
    const msg = message(7, {
      content: "<p>reply body</p>",
      sender: "Eve",
      sender_mri: "8:orgid:eve",
      compose_time: 1234,
    });

    const payload = replyToPayload(msg, "quoted before", "quoted after");

    expect(payload).toEqual({
      compose_time: 1234,
      sender: "Eve",
      sender_mri: "8:orgid:eve",
      preview: "reply body",
      before: "quoted before",
      after: "quoted after",
    });
  });

  it("defaults sender_mri to an empty string when the message has none", () => {
    const msg = message(8, { content: "<p>x</p>", sender_mri: undefined });
    expect(replyToPayload(msg, "", "").sender_mri).toBe("");
  });
});
