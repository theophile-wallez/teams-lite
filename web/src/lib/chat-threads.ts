// A CHAT HAS THREADS TOO, and they are read out of the QUOTES the history already carries.
//
// A channel's thread is an ADDRESS: Teams files a channel reply under the root post's own id
// and hands it back on every one of them (`thread_root_id`), so `groupThreads` only has to
// regroup a flat page it is already told the shape of. A CHAT has none of that — its history
// is flat on the service, and `teams_send::parse_thread_root` refuses a thread address there
// because the service publishes none. What a chat reply DOES carry is the message it answers,
// inside its own body: Teams composes a reply with the quoted message's id in the blockquote's
// `itemid` and again in its `itemprop="time"` span, and that id IS the quoted message's
// arrival time in epoch milliseconds (measured on this tenant's own history: the two agree on
// all 1174 replies, and no stored message has an id differing from its compose time — see
// § A quote is a POINTER to a message).
//
// So the quote graph IS the thread graph, and this module is the one place that reads it.
// Everything a channel thread already has then comes for free: the same {@link Thread} shape,
// the same `threadReplies` foot row, the same threads panel.
import { bodyFormat, parseRichMessage } from "./protocol";
import type { ChatMessage } from "./protocol";
import type { Thread } from "./threads";

/**
 * The COMPOSE TIME of the message this one replies to, or `null` when it replies to nothing.
 *
 * It goes through the app's own quote parser rather than a regex of its own, which is the
 * whole reason this is three lines: `parseRichMessage` is what every bubble in the app
 * already reads a quote with, so "what does this message reply to" has ONE answer here and
 * cannot drift from what the reader is shown.
 *
 * Two shapes are deliberately NOT replies:
 *
 *  - a FORWARD. Teams sends one with no author, no time and no id, because the message it
 *    holds was said somewhere else — so a forward is nobody's reply, and filing one under a
 *    thread would put a stranger's words in a conversation they were never part of. It is the
 *    same rule that stops a forward being offered as a jump target.
 *  - a PLAIN-TEXT body. A `Text` message is text, so a `<blockquote>` in it is characters
 *    somebody typed rather than markup (see {@link bodyFormat}).
 */
export function replyTargetTime(message: ChatMessage): number | null {
  if (!message.content || bodyFormat(message.message_type) === "text") return null;
  // The cheap gate first: this runs over the WHOLE loaded history on every pass, and the great
  // majority of messages carry no quote at all — so the parse is only paid for by a body that
  // really holds Teams' own reply marker. It is the same prefilter `strip_quoted_blocks` opens
  // with, and it can only ever refuse a body the parse would refuse too.
  if (!message.content.includes("schema.skype.com/Reply")) return null;
  const quote = parseRichMessage(message.content).quote;
  if (!quote || quote.kind !== "reply" || quote.time === undefined) return null;
  return quote.time;
}

/** What a chat's history is really made of once its replies are folded into their threads. */
export type ChatThreadModel = {
  /** Every thread the loaded history holds, in the order their roots appear. A message
   *  nobody has answered is NOT one: a thread is a root plus at least one reply, which is
   *  what `threadReplies` already refuses to draw a foot row without. */
  threads: Thread[];
  /** The root of the thread each message belongs to, for every root and every reply.
   *  Absent for a message that is in no thread, which is most of them. */
  threadOf: Map<string, string>;
  /** The messages the running history LEAVES OUT — the replies whose own author asked for
   *  them to be drawn in their thread alone. */
  folded: Set<string>;
};

/** How far a reply→reply→reply chain is followed before it is treated as a loop.
 *
 *  A thread here is ONE level deep by construction — every reply resolves to the root, and
 *  answering a reply joins that same thread, which is Slack's own shape — so this is a bound
 *  on a malformed history rather than on a real conversation. A quote graph is built out of
 *  ids somebody else's client wrote, and a cycle in it must cost a walk rather than the tab. */
const MAX_CHAIN = 64;

/**
 * Fold a chat's flat history into threads.
 *
 * Three rules decide everything, and each has a failure it exists to prevent:
 *
 *  - **A REPLY WHOSE PARENT IS NOT LOADED IS NOT A REPLY.** The history pages a screen at a
 *    time, so the message a reply answers is very often not here yet. Folding it against a
 *    parent that is nowhere would take it out of the running history and put it in no thread
 *    — a message the reader can no longer reach from anywhere, which is the defect
 *    `withPetArchive` exists to close one feature over. So it stays exactly where it was, and
 *    it joins its thread by itself the moment the older page lands.
 *  - **A REPLY TO A REPLY JOINS THE ROOT'S THREAD.** A thread is one conversation about one
 *    message, which is what Slack's is and what a channel's already is here (a post's
 *    `thread_root_id` is the root's id however deep the answer). A tree would draw a column
 *    of nested quotes that nobody can follow on a 390px screen.
 *  - **ONLY A `thread_only` REPLY IS FOLDED.** The reply is really in the conversation — a
 *    chat has no threads on the service, so every stock client draws it inline — and the flag
 *    says its author unticked "Also send to the chat". A reply with no flag is drawn in BOTH
 *    places, which is what every reply this app ever sent does and what a broadcast is (see
 *    § A CHAT HAS THREADS TOO).
 */
export function chatThreads(messages: readonly ChatMessage[]): ChatThreadModel {
  const byTime = new Map<number, ChatMessage>();
  for (const message of messages) byTime.set(message.compose_time, message);

  /** The direct parent of each reply, by id — resolved once, so the chain walk below and the
   *  grouping cannot disagree about who answers whom. */
  const parentOf = new Map<string, ChatMessage>();
  for (const message of messages) {
    const time = replyTargetTime(message);
    if (time === null) continue;
    const parent = byTime.get(time);
    // A parent that is not loaded, and a message that somehow quotes itself: neither is a
    // reply this can place, so the message stays where it is.
    if (!parent || parent.id === message.id) continue;
    parentOf.set(message.id, parent);
  }

  const rootOf = (message: ChatMessage): ChatMessage => {
    let at = message;
    for (let step = 0; step < MAX_CHAIN; step += 1) {
      const parent = parentOf.get(at.id);
      if (!parent) return at;
      at = parent;
    }
    return at;
  };

  const order: string[] = [];
  /** The root MESSAGE of each thread, kept as the buckets are filled — the walk already holds
   *  it, so looking it up again by id afterwards would be a second scan of the history per
   *  thread. */
  const roots = new Map<string, ChatMessage>();
  const replies = new Map<string, ChatMessage[]>();
  const threadOf = new Map<string, string>();
  const folded = new Set<string>();
  for (const message of messages) {
    if (!parentOf.has(message.id)) continue;
    const root = rootOf(message);
    if (root.id === message.id) continue; // a cycle bottomed out on itself
    let bucket = replies.get(root.id);
    if (!bucket) {
      bucket = [];
      replies.set(root.id, bucket);
      roots.set(root.id, root);
      order.push(root.id);
      threadOf.set(root.id, root.id);
    }
    bucket.push(message);
    threadOf.set(message.id, root.id);
    if (message.thread_only) folded.add(message.id);
  }

  const threads: Thread[] = order.flatMap((rootId) => {
    const lead = roots.get(rootId);
    if (!lead) return [];
    const bucket = replies.get(rootId) ?? [];
    return {
      rootId,
      /**
       * THE THREAD'S NAME, off the earliest REPLY that carries one.
       *
       * It is Teams' own `properties.subject` — the field a channel post is titled with, which
       * the read path already decodes into `thread_subject` on every message — so a chat
       * thread's name needs no property, no column and no wire field of its own
       * (`teams_send::parse_subject`).
       *
       * It cannot live on the ROOT: that is an ordinary message somebody wrote before the
       * thread existed, and this app never rewrites the record of a Teams frame. So the reply
       * that STARTS the thread is what names it, which is where Discord asks for one too.
       *
       * The EARLIEST wins, so a second person naming the same thread does not rename it under
       * everybody — and a thread nobody named keeps `""`, which is what makes
       * `threadPanelHeading` fall back to the root's own opening words.
       */
      subject: bucket.find((reply) => (reply.thread_subject ?? "").trim())?.thread_subject ?? "",
      lead,
      replies: bucket,
    };
  });
  return { threads, threadOf, folded };
}

/**
 * Whether a reply bar offers "Also send to the chat".
 *
 * **ONLY A THREAD'S OWN BAR, and only in a CHAT.** Two halves:
 *
 *  - The bar under the CONVERSATION never offers it, because a reply written there is an
 *    ordinary reply: it is in the running history, which is what the box would ask for. That is
 *    the whole shape of the feature after it became an OPTION — a reader who wants their answer
 *    in the chat presses Reply, and a reader who wants a thread presses "Reply in thread".
 *  - A CHANNEL's thread bar never offers it either. A channel reply is filed by ADDRESS, so it
 *    is out of the channel's own column whatever this app does (`teams_send::parse_thread_root`)
 *    — broadcasting one would mean posting a SECOND message to the channel root, which is a
 *    different act with a different cost, and this app does not offer it.
 *
 * So it is a chat thread's own bar: there the reply is genuinely in the conversation for every
 * client there is, and the box decides only whether teams-lite folds it out of the running
 * history. One message, one send, one property.
 */
export function broadcastOffered(opts: { inThread: boolean; isChannelThread: boolean }): boolean {
  return opts.inThread && !opts.isChannelThread;
}

/** What the checkbox says, and what unticking it costs — the words the reader decides on.
 *
 *  It names the CHAT rather than "the conversation", because that is the surface the reply
 *  either appears on or does not, and it is what Slack's own row names (§ A CHAT HAS THREADS
 *  TOO records why the feature has it at all: without it, replies vanishing from the running
 *  history is the one thing readers fear about threads). */
export const BROADCAST_LABEL = "Also send to the chat";

/** The hint under it, which says what the box really decides — and, deliberately, what it
 *  does NOT: the reply reaches the same people either way. A reader who thought unticking it
 *  kept their words from somebody would be wrong about the one thing that matters. */
export const BROADCAST_HINT =
  "Everybody in the chat receives it either way — this only keeps it in the running history as well as in the thread.";

/** The thread a reply to `message` belongs in: the one it is already part of, else the
 *  message itself — a message nobody has answered IS a root.
 *
 *  It is `threadRootOf`'s twin for a chat, and it is a different function for the reason the
 *  module is: there the root is a field Teams put on the row, here it is derived. */
export function chatThreadRootOf(model: ChatThreadModel, message: ChatMessage): string {
  return model.threadOf.get(message.id) ?? message.id;
}
