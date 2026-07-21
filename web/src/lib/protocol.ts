// Shared protocol types + pure message logic for the web UI.
//
// These mirror the Rust backend's WebSocket protocol (see src/bin/server.rs) and
// port the terminal UI's pure helpers (ui/src/message-content.ts,
// ui/src/message-history.ts) so the web and terminal clients behave identically.
// Nothing here touches the DOM, the network, or any runtime-specific API.

// Mirrors the Rust `ConversationKind` (src/store.rs).
export type ConversationKind = "one_on_one" | "group" | "notes" | "unknown";

export type Conversation = {
  id: string;
  name: string;
  last_message_time: number;
  kind: ConversationKind;
  last_message_preview: string;
  last_message_sender: string;
  last_message_from_me: boolean;
  is_read: boolean;
  is_muted: boolean;
  is_pinned: boolean;
  is_hidden: boolean;
  thread_type: string;
  draft: string;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  seq: number;
  compose_time: number;
  sender: string;
  sender_mri?: string;
  content: string;
  is_self?: boolean;
};

export type ReplyTo = {
  compose_time: number;
  sender: string;
  sender_mri: string;
  preview: string;
  before: string;
  after: string;
};

export type MessagePage = {
  messages: ChatMessage[];
  has_more: boolean;
};

export type UpdateInfo = {
  current: string;
  latest: string;
  url: string;
};

export type LiveStatus = "connecting" | "connected" | "disconnected";

// ---- message content parsing (ported from ui/src/message-content.ts) -------

export type MessageQuote = {
  sender: string;
  text: string;
};

export type ParsedMessage = {
  quote?: MessageQuote;
  body: string;
  beforeQuote?: string;
  afterQuote?: string;
};

/** Strip HTML tags and decode the handful of entities Teams emits. */
export function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

const REPLY_BLOCKQUOTE =
  /<blockquote\b[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[^>]*>([\s\S]*?)<\/blockquote>/i;
const QUOTED_AUTHOR = /<strong\b[^>]*itemprop="mri"[^>]*>([\s\S]*?)<\/strong>/i;
const QUOTED_PREVIEW = /<p\b[^>]*itemprop="preview"[^>]*>([\s\S]*?)<\/p>/i;

/** Split a raw Teams message HTML into an optional quote plus the body text. */
export function parseMessageContent(html: string): ParsedMessage {
  const match = html.match(REPLY_BLOCKQUOTE);
  const inner = match?.[1];
  if (inner === undefined) return { body: plain(html) };

  const sender = plain(inner.match(QUOTED_AUTHOR)?.[1] ?? "");
  const previewHtml = inner.match(QUOTED_PREVIEW)?.[1];
  const text = plain(previewHtml ?? inner.replace(QUOTED_AUTHOR, ""));

  const quoteIndex = match?.index ?? 0;
  const quoteEnd = quoteIndex + (match?.[0].length ?? 0);
  const beforeQuote = plain(html.slice(0, quoteIndex));
  const afterQuote = plain(html.slice(quoteEnd));
  const body = [beforeQuote, afterQuote].filter(Boolean).join("\n");

  if (!sender && !text) return { body };
  return { quote: { sender, text }, body, beforeQuote, afterQuote };
}

export type RichQuote = {
  sender: string;
  html: string;
};

export type ParsedRichMessage = {
  quote?: RichQuote;
  beforeHtml?: string;
  bodyHtml: string;
};

/**
 * Like {@link parseMessageContent}, but preserves the raw Teams HTML of each
 * part instead of flattening it to plain text, so the web UI can render inbound
 * formatting (bold, links, lists, code, mentions, images). The reply quote is
 * still split out so it can be shown in its recessed block.
 */
export function parseRichMessage(html: string): ParsedRichMessage {
  const match = html.match(REPLY_BLOCKQUOTE);
  const inner = match?.[1];
  if (inner === undefined) return { bodyHtml: html };

  const sender = plain(inner.match(QUOTED_AUTHOR)?.[1] ?? "");
  const previewHtml = inner.match(QUOTED_PREVIEW)?.[1];
  const quoteHtml = previewHtml ?? inner.replace(QUOTED_AUTHOR, "");

  const quoteIndex = match?.index ?? 0;
  const quoteEnd = quoteIndex + (match?.[0].length ?? 0);
  const beforeHtml = html.slice(0, quoteIndex);
  const afterHtml = html.slice(quoteEnd);

  if (!sender && plain(quoteHtml) === "") {
    return { bodyHtml: [beforeHtml, afterHtml].filter((s) => plain(s)).join("") };
  }
  return {
    quote: { sender, html: quoteHtml },
    beforeHtml,
    bodyHtml: afterHtml,
  };
}

/** The plain text a "Copy"/"Reply" action should use for a message. */
export function copyableMessageText(message: ChatMessage): string {
  const parsed = parseMessageContent(message.content);
  return parsed.body || parsed.quote?.text || "";
}

export function replyToPayload(message: ChatMessage, before: string, after: string): ReplyTo {
  return {
    compose_time: message.compose_time,
    sender: message.sender,
    sender_mri: message.sender_mri ?? "",
    preview: copyableMessageText(message),
    before,
    after,
  };
}

// ---- history merge logic (ported from ui/src/message-history.ts) -----------

export const HISTORY_PREFETCH_MESSAGES = 20;

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) => a.seq - b.seq || a.compose_time - b.compose_time || a.id.localeCompare(b.id),
  );
}

export function appendLiveMessage(
  current: MessagePage | undefined,
  message: ChatMessage,
): MessagePage {
  return {
    messages: mergeMessages(current?.messages ?? [], [message]),
    has_more: current?.has_more ?? true,
  };
}

export function mergeOlderHistoryPage(
  current: MessagePage | undefined,
  incoming: MessagePage,
): MessagePage {
  return {
    messages: mergeMessages(current?.messages ?? [], incoming.messages),
    has_more: incoming.has_more,
  };
}

export function mergeRefreshedHistoryPage(
  current: MessagePage | undefined,
  incoming: MessagePage,
): MessagePage {
  const currentOldest = current?.messages[0];
  const incomingOldest = incoming.messages[0];
  const currentExtendsFurtherBack =
    currentOldest !== undefined &&
    (incomingOldest === undefined || currentOldest.seq < incomingOldest.seq);
  return {
    messages: mergeMessages(current?.messages ?? [], incoming.messages),
    has_more: currentExtendsFurtherBack ? current!.has_more : incoming.has_more,
  };
}

// ---- conversation display helpers (ported from ui/src/app.tsx) -------------

export function convLabel(c: Conversation): string {
  if (c.name && c.name.length > 0) return c.name;
  if (c.kind === "notes") return "Notes";
  return "(untitled)";
}

function firstName(full: string): string {
  const head = full.trim().split(/\s+/)[0];
  return head || full;
}

/**
 * Sidebar preview line: "You:" when we sent it, "FirstName:" in a group, and the
 * bare snippet in a 1:1 / Notes where the sender is implicit.
 */
export function previewLine(c: Conversation): string {
  const body = c.last_message_preview ?? "";
  if (!body) return "";
  if (c.last_message_from_me) return `You: ${body}`;
  const isGroup = c.kind === "group" || c.kind === "unknown";
  if (isGroup && c.last_message_sender) return `${firstName(c.last_message_sender)}: ${body}`;
  return body;
}

/** Should an incoming message raise a notification? Pure, so it is testable. */
export function shouldNotify(
  msg: { conversation_id: string; is_self?: boolean },
  openConversationId: string | null,
): boolean {
  if (msg.is_self) return false;
  if (openConversationId !== null && msg.conversation_id === openConversationId) return false;
  return true;
}
