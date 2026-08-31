// A channel's history: how it is SHAPED, and which of Teams' two layouts draws it.
//
// Teams returns a channel's posts as a single flat, seq-ordered page in which posts from
// different threads interleave; each post carries its thread's `thread_root_id`. Regrouping
// by that id restores the "root post + its replies" structure both layouts are built on
// (chats stay flat and never call this).
//
// The LAYOUT is the channel's own and never this app's guess — see `channelLayoutOf`, and
// AGENTS.md § A CHANNEL IS DRAWN THE WAY TEAMS DRAWS IT.
import { formatMessageTime } from "./message-time";
import type { ChatMessage } from "./protocol";

/** A reconstructed channel thread: its root post (the `lead`) followed by its
 *  replies, in seq order. `lead` is the post whose id is the thread root; if
 *  that root isn't on the loaded page, the earliest loaded post stands in. */
export type Thread = {
  rootId: string;
  subject: string;
  lead: ChatMessage;
  replies: ChatMessage[];
};

/** Regroup a flat, seq-ordered channel page into threads. Buckets keep their
 *  first-seen order, so threads sort by the earliest loaded post in each.
 *  `replyRootOf` maps a reply's id back to its thread root, so a deep-link into
 *  a collapsed thread can locate and expand it. */
export function groupThreads(messages: ChatMessage[]): {
  threads: Thread[];
  replyRootOf: Map<string, string>;
} {
  const order: string[] = [];
  const buckets = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const key = m.thread_root_id || m.id;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(m);
  }
  const replyRootOf = new Map<string, string>();
  const threads = order.map((key) => {
    const all = buckets.get(key)!;
    // The bucket always has at least one post (it was created on first push).
    const lead = all.find((m) => m.id === key) ?? all[0]!;
    const replies = all.filter((m) => m !== lead);
    for (const r of replies) replyRootOf.set(r.id, key);
    return { rootId: key, subject: lead.thread_subject ?? "", lead, replies };
  });
  return { threads, replyRootOf };
}

/**
 * The CHANNEL THREAD a reply to `message` belongs in: the thread it is already part of,
 * else the message itself — a post that carries no root IS one.
 *
 * This is what a reply in a channel has to carry, because Teams files a channel reply by
 * ADDRESS rather than by a quote in its body (`teams_send::parse_thread_root`): without it a
 * reply to an announcement POSTed to the channel itself, which opened a second, untitled
 * thread at the foot of the history — the reply the reader wrote sitting on its own, beside
 * the announcement instead of under it.
 */
export function threadRootOf(message: ChatMessage): string {
  return message.thread_root_id || message.id;
}

/**
 * Whether a reply into a channel thread also QUOTES the message it answers.
 *
 * A reply to the thread's ROOT does not: the thread is the context, and a quote of the
 * announcement above the first reply in the announcement's own thread states one thing
 * twice — Teams draws none there either. A reply to another REPLY does, because a long
 * thread holds several conversations and the quote is the only thing that says which one is
 * being answered.
 */
export function threadReplyQuotes(message: ChatMessage): boolean {
  return threadRootOf(message) !== message.id;
}

/**
 * What the composer's banner says a reply IS, which is not the same sentence in a chat and
 * in a channel.
 *
 * There is ONE composer in this app, so a channel reply is written a screen away from the
 * thread it lands in — and the banner is the only thing that says which. In a titled thread
 * it names the title, because that is what the reader recognises the announcement by; a reply
 * inside an untitled thread, a reply to another reply, and every chat reply name the PERSON,
 * which is what a quote is about.
 */
export function replyHeading(message: ChatMessage, threadRoot: string | null): string {
  const subject = message.thread_subject?.trim();
  if (threadRoot && subject) return `Replying in “${subject}”`;
  return `Replying to ${message.sender}`;
}

/** How many replies a thread holds, in words — so nothing says "1 replies". */
export function replyCountLabel(count: number): string {
  return `${count} ${count === 1 ? "reply" : "replies"}`;
}

/** Which of Teams' two channel layouts a channel is drawn in. */
export type ChannelLayout = "posts" | "conversation";

/**
 * Read a layout off the wire.
 *
 * **Anything this build does not recognise is POSTS**, which is the same rule the backend's
 * own `channel_layout::from_thread` holds and for its reason: posts is the surface this app
 * already drew for every channel, it is what 54 of this tenant's 70 channels carry (the
 * modality is simply absent on a classic channel), and a page too old to have been told
 * takes exactly that answer. Only the one word opts a channel into the other surface —
 * drawing a running conversation on the strength of a value nobody measured is what
 * `mergeVerdict` refuses for an unknown merge status.
 */
export function channelLayoutOf(value: string | null | undefined): ChannelLayout {
  return value === "conversation" ? "conversation" : "posts";
}

/** What the foot row under a CONVERSATION-layout post says about its thread. */
export type ThreadReplies = {
  /** How many replies the thread holds. */
  count: number;
  /** Those replies in words (`replyCountLabel`). */
  label: string;
  /** Who replied, one message per person, in the order they first answered — the faces
   *  the row stacks. Bounded by [`REPLIER_FACES`]. */
  repliers: ChatMessage[];
  /** When the newest reply landed, in the reader's own locale and zone. */
  lastReply: string;
};

/**
 * How many repliers' faces the foot row stacks.
 *
 * Three, because they OVERLAP: a fourth 20px disc pushes the count and "Last reply …" of a
 * long thread off a 390px row, and the faces are a glance at who is in the thread rather
 * than its roster — the reader opens the panel for that. It is the bound the chess strip and
 * the pet layer already take, for the same reason.
 */
export const REPLIER_FACES = 3;

/**
 * The foot row's facts, or `null` for a post nobody has answered.
 *
 * `null` rather than a row reading "0 replies": a post with no thread under it has nothing
 * to disclose, and a control that opens an empty panel is the "a control that changes
 * nothing reads as a bug" rule.
 *
 * **A REPLIER IS AN IDENTITY, never a name.** The faces are keyed on the sender's own MRI
 * and only on the name where the store holds no identity — measured on this tenant, 273 of
 * one group chat's 899 messages arrive with a blank sender, so keying on the name alone
 * would stack two DIFFERENT colleagues as one person (§ WHO said it). An authorless post —
 * a recording, a thread activity — is nobody and is not stacked at all.
 */
export function threadReplies(thread: Thread, now?: number): ThreadReplies | null {
  const { replies } = thread;
  if (replies.length === 0) return null;
  const repliers: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const reply of replies) {
    const identity = reply.sender_mri?.trim() || reply.sender?.trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    if (repliers.length < REPLIER_FACES) repliers.push(reply);
  }
  // The replies are in seq order, so the newest is the last — read off the message rather
  // than by sorting, because the group that built this thread already ordered them.
  const newest = replies[replies.length - 1]!;
  return {
    count: replies.length,
    label: replyCountLabel(replies.length),
    repliers,
    lastReply: formatMessageTime(newest.compose_time, now),
  };
}

/**
 * What the threads panel's header names the thread it is showing.
 *
 * A titled announcement is named by its TITLE, which is what the reader recognises it by —
 * the rule `replyHeading` already holds for the composer's banner. An untitled post has only
 * its words, so the panel takes their opening, bounded: a header is one line, and a post in a
 * conversational channel is ordinary prose of any length.
 */
export function threadPanelHeading(thread: Thread, plainBody: string): string {
  const subject = thread.subject.trim();
  if (subject) return subject;
  const words = plainBody.replace(/\s+/g, " ").trim();
  if (!words) return thread.lead.sender.trim() || "Thread";
  return words.length > PANEL_HEADING_CHARS
    ? `${words.slice(0, PANEL_HEADING_CHARS).trimEnd()}…`
    : words;
}

/** How much of an untitled post's own words the panel header carries. Wide enough to
 *  recognise the post by and short enough to stay one line beside the panel's close. */
export const PANEL_HEADING_CHARS = 40;
