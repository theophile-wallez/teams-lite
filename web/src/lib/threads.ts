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
