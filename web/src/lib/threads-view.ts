// THE THREADS VIEW: every thread the reader is in, across every conversation.
//
// A thread is read where it happens — in its conversation, in the panel beside it — so this
// view is a WAY IN rather than a second place to read one: one row per thread, newest activity
// first, and a press that opens that thread where it lives. That is the whole of what it is
// for, and it is why nothing here draws a message the way a bubble does.
//
// It is built from `thread_digest` (§ A CHAT HAS THREADS TOO), which answers the replies the
// STORE holds across every conversation — the one question a page cannot answer for itself,
// since the history loads a page at a time and only for the conversation on screen.
import { chatThreads } from "./chat-threads";
import { convLabel, channelLabel, isChannelThreadId } from "./protocol";
import type { Channel, ChatMessage, Conversation } from "./protocol";
import { groupThreads, threadReplies, type Thread, type ThreadReplies } from "./threads";

/** One row of the threads view: a thread, where it lives, and what its foot row says. */
export type ThreadsViewRow = {
  conversationId: string;
  thread: Thread;
  replies: ThreadReplies;
  /** When the newest reply landed, in epoch ms — what the rows are ordered by. */
  lastReplyMs: number;
};

/**
 * Every thread the digest holds that the reader is IN, newest activity first.
 *
 * **"IN" MEANS THEY WROTE IN IT**, root or reply. That is Slack's own rule for its All Threads
 * — it lists the threads you are following, which is the ones you have taken part in — and it
 * is the only version of the question this app can answer honestly: a thread between two
 * colleagues in a group chat is not the reader's to be shown a list of, and `is_self` is a fact
 * the backend already resolves on every message (the page never learns the user's own MRI).
 *
 * Both derivations are used, per conversation, and WHICH one is the conversation's own id: a
 * channel is TOLD the shape of its threads (`thread_root_id` on every post), while a chat's are
 * read out of the quotes its history carries. Neither is guessed at — reading a chat as a
 * channel would group every message under itself and list a thread per message.
 *
 * A thread with no replies is not a thread and is left out, which is the rule `threadReplies`
 * already holds for the foot row: a root nobody answered has nothing to disclose.
 */
export function threadsAcross(digest: readonly ChatMessage[]): ThreadsViewRow[] {
  const byConversation = new Map<string, ChatMessage[]>();
  for (const message of digest) {
    const bucket = byConversation.get(message.conversation_id);
    if (bucket) bucket.push(message);
    else byConversation.set(message.conversation_id, [message]);
  }
  const rows: ThreadsViewRow[] = [];
  for (const [conversationId, messages] of byConversation) {
    // The digest answers newest first (it is `ORDER BY seq DESC`), and both derivations walk a
    // history in the order it was written — so it is put back in seq order first. Without it a
    // thread's replies would be listed backwards and its "last reply" would be its first.
    const ordered = [...messages].sort((a, b) => a.seq - b.seq);
    const threads = isChannelThreadId(conversationId)
      ? groupThreads(ordered).threads
      : chatThreads(ordered).threads;
    for (const thread of threads) {
      const replies = threadReplies(thread);
      if (!replies) continue;
      if (!thread.lead.is_self && !thread.replies.some((reply) => reply.is_self)) continue;
      rows.push({
        conversationId,
        thread,
        replies,
        lastReplyMs: thread.replies[thread.replies.length - 1]?.compose_time ?? 0,
      });
    }
  }
  return rows.sort((a, b) => b.lastReplyMs - a.lastReplyMs);
}

/** What a conversation is called, through the app's OWN two namers — `channelLabel` for a
 *  channel and `convLabel` for a chat, which is where the self-chat's name, a group with no
 *  title and the nickname the user gave a colleague are all already decided. A conversation
 *  neither list holds is named "Conversation" rather than by its id: a row reading
 *  `19:…@thread.v2` is a row nobody can read. */
export function threadsRowLabel(
  conversationId: string,
  conversations: readonly Conversation[],
  channels: readonly Channel[],
): string {
  const channel = channels.find((c) => c.id === conversationId);
  if (channel) return channelLabel(channel);
  const conversation = conversations.find((c) => c.id === conversationId);
  if (conversation) return convLabel(conversation);
  return "Conversation";
}

/** How much of a thread's opening message a row shows. A row is two lines: enough to
 *  recognise the thread by, and short enough that a list of them is still a list. */
export const THREADS_ROW_CHARS = 180;

/** Whether the digest was CUT — the store holds more replies than the bound it was read
 *  under, so the list is the newest threads rather than every one of them.
 *
 *  It counts the REPLIES the digest carried rather than the rows derived from them, because
 *  that is what the bound really counted (the roots beside them are looked up on top of it).
 *  A backend that named no bound claims nothing: a list that says it is complete when nobody
 *  told it so is worse than one that says nothing at all. */
export function threadDigestTruncated(
  digest: readonly ChatMessage[],
  limit: number | null,
): boolean {
  if (limit === null || limit <= 0) return false;
  return digest.length >= limit;
}
