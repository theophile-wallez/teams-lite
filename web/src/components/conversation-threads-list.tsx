// EVERY THREAD OF *THIS* CONVERSATION, listed in the panel column beside it.
//
// It replaced a GLOBAL `/threads` page — every thread the reader was in, across every
// conversation, reached from the sidebar. That page was wrong about where a thread belongs: a
// thread is part of one conversation, and a list that crossed all of them needed a row saying
// WHICH conversation each one was in, a navigation to get there, and a piece of cross-route state
// to open the panel once it arrived (`openThread` / `pendingThreadRoot`, all three now gone).
// Every conversation keeping its own list needs none of that — the reader is already in the
// conversation, so a press is a panel opening beside them.
//
// **IT IS THE SAME `Thread[]` THE PANEL AND THE FOOT ROWS ARE DRAWN FROM** (`panelThreads` in
// message-pane.tsx), so a thread is one thing in this app and not two: what a row says about a
// thread here is what its post's own foot row says, in the same words and the same order.
//
// **WHAT IT COSTS is stated rather than hidden: the list is as complete as the LOADED history.**
// A conversation pages a screen at a time, so a thread whose root has scrolled out of the loaded
// window is not in it — and that is the honest answer rather than a defect, because it is exactly
// what the conversation beside it is showing. It is not the `withPetArchive` case: nothing here
// is destructive when the answer is short (a spawn press posts a message for a creature the
// reader already owns; a short list draws fewer rows and grows as they scroll back).
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { copyableMessageText, withoutWireLine } from "~/lib/protocol";
import { threadReplies, type Thread } from "~/lib/threads";
import { Avatar } from "./avatar";
import { cn } from "~/lib/utils";

/** How much of a root's words a row shows before it is cut. A row is a way IN, not the
 *  message — and the words are clamped to two lines on top of this, so the bound is only
 *  there to keep an enormous paste out of the DOM of every row. */
export const THREADS_ROW_CHARS = 240;

export function ConversationThreadsList(props: {
  /** Every thread this conversation holds, newest activity LAST — the pane's own order, which
   *  is the history's. This component reverses nothing: a reader scanning a list of threads is
   *  looking for the one that just moved, so the newest goes first (below). */
  threads: readonly Thread[];
  onOpen: (thread: Thread) => void;
  onClose: () => void;
}) {
  // NEWEST FIRST, which is the opposite of the history's own order and right for a list: a
  // reader opens this to find the thread something just happened in. A thread with no replies
  // yet is dated by its root, so both are compared on the newest message they hold.
  const rows = [...props.threads]
    .map((thread) => ({ thread, replies: threadReplies(thread) }))
    .sort((a, b) => newest(b.thread) - newest(a.thread));

  return (
    <section
      data-testid="conversation-threads-list"
      aria-label="Threads in this conversation"
      // The panel column's own box, spelled exactly as `ChannelThreadsPanel`'s is: this stands
      // in the same slot, so a list and a thread must not be two widths. Full width below `md`
      // (it REPLACES the history there), a column of its own beside it.
      className="flex min-h-0 w-full min-w-0 shrink-0 flex-col border-border-subtle bg-background md:w-[22rem] md:border-l lg:w-[26rem]"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-3 md:px-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
            Threads
          </span>
          {/* WHAT THE LIST IS, because "threads" alone does not say whose or where. A reader
              who meets an empty one is owed the reason rather than an empty column. */}
          <span className="truncate text-sm font-medium text-foreground">
            {rows.length === 0
              ? "None in this conversation"
              : rows.length === 1
                ? "1 in this conversation"
                : `${rows.length} in this conversation`}
          </span>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close threads"
          data-testid="conversation-threads-close"
          // 44px under a thumb, which every target this app draws for one clears.
          className="-mr-1 grid size-11 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.6} />
        </button>
      </header>

      {/* Its own scroller, exactly as the thread panel has one: the list keeps its place while
          the conversation beside it is read. */}
      <div
        data-testid="conversation-threads-scroll"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-6 pt-3 md:px-4"
      >
        {rows.length === 0 ? (
          <p data-testid="conversation-threads-empty" className="text-[13px] text-text-faint">
            No thread here yet. Answer a message with &ldquo;Reply in thread&rdquo; and it shows
            up in this list.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map(({ thread, replies }) => (
              <ThreadRow
                key={thread.rootId}
                thread={thread}
                replies={replies}
                onOpen={() => props.onOpen(thread)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** When a thread last moved: its newest reply, or its root where nobody has answered. */
function newest(thread: Thread): number {
  const last = thread.replies[thread.replies.length - 1] ?? thread.lead;
  return last.compose_time;
}

/**
 * ONE THREAD, as a row: who opened it, what they said, and what has happened since.
 *
 * The whole row is one press, because there is one thing to do with a thread from here. It is a
 * button rather than a link: the thread it opens is not an address of its own — it is this
 * conversation plus a panel, and naming which panel is state the URL does not carry.
 *
 * It names no CONVERSATION, which the global page's own row had to: this list is one
 * conversation's, so the answer is the header above the history beside it.
 */
function ThreadRow(props: {
  thread: Thread;
  replies: ReturnType<typeof threadReplies>;
  onOpen: () => void;
}) {
  const { thread, replies, onOpen } = props;
  const lead = thread.lead;
  // The root's own words, with any WIRE line taken off them: a colleague running teams-lite can
  // post a game or a companion into a conversation, and the machine-readable line those carry
  // must never be what a row shows (§ THE SIX SURFACES THE WIRE MUST NEVER REACH — this takes
  // the same one function).
  const words = withoutWireLine(copyableMessageText(lead)).replace(/\s+/g, " ").trim();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="threads-row"
      data-thread-root={thread.rootId}
      className={cn(
        "flex w-full flex-col gap-2 rounded-xl bg-card px-3 py-3 text-left shadow-card transition-colors",
        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      {/* THE THREAD'S OWN NAME, where somebody gave it one — a chat's thread is named by the
          reply that STARTS it and a channel post carries a title, and `Thread.subject` is
          already both. It stands ABOVE the author rather than in place of them: who opened a
          thread is the other half of what a reader recognises it by, and it is drawn nowhere at
          all when there is no name rather than repeating the words below it. */}
      {thread.subject.trim() && (
        <span
          data-testid="threads-row-name"
          className="truncate text-[13px] font-medium text-foreground"
        >
          {thread.subject.trim()}
        </span>
      )}

      {/* WHO opened it and WHAT they said. The author is always named — a thread in a group
          chat or a channel is as often somebody else's as the reader's own — and the words are
          clamped to two lines: a row is a way in, not the message. */}
      <span className="flex min-w-0 items-start gap-2">
        <Avatar
          seed={lead.sender_mri || lead.sender}
          label={lead.sender}
          photo={lead.sender_mri ? { kind: "user", id: lead.sender_mri } : undefined}
          fallback="person"
          className="mt-0.5 size-6 shrink-0 text-[10px]"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">
            {lead.sender.trim() || "Somebody"}
          </span>
          <span className="line-clamp-2 text-[13px] text-text-dim">
            {words.length > THREADS_ROW_CHARS
              ? `${words.slice(0, THREADS_ROW_CHARS).trimEnd()}…`
              : words || "No words in this message"}
          </span>
        </span>
      </span>

      {/* AND WHAT HAS HAPPENED SINCE — the same three facts the foot row under a post carries,
          in the same order and the same words, so a thread reads the same in both places. A
          thread nobody has answered says so instead: this list holds one the moment the reader
          starts it, where the foot row draws nothing at all. */}
      <span className="flex min-w-0 items-center gap-2 pl-8 text-xs">
        {replies ? (
          <>
            <span className="flex shrink-0 items-center">
              {replies.repliers.map((reply, i) => (
                <Avatar
                  key={reply.id}
                  seed={reply.sender_mri || reply.sender}
                  label={reply.sender}
                  photo={reply.sender_mri ? { kind: "user", id: reply.sender_mri } : undefined}
                  fallback="person"
                  // 9px ink for a 20px face, the reason the foot row's own stack states in
                  // full: `Avatar`'s 13px is sized for its 36px default and spills out of this.
                  className={cn("size-5 shrink-0 text-[9px] ring-2 ring-card", i > 0 && "-ml-1.5")}
                />
              ))}
            </span>
            <span className="shrink-0 font-medium text-primary">{replies.label}</span>
            <span className="hidden min-w-0 truncate text-text-faint sm:inline">
              Last reply {replies.lastReply}
            </span>
          </>
        ) : (
          <span className="truncate text-text-faint">No replies yet</span>
        )}
      </span>
    </button>
  );
}
