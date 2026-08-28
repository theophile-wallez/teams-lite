// Channel thread reconstruction. Teams returns a channel's posts as a single
// flat, seq-ordered page in which posts from different threads interleave; each
// post carries its thread's `thread_root_id`. Regrouping by that id restores the
// "root post + its replies" structure the UI renders (chats stay flat and never
// call this).
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
