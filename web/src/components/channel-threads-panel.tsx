// THE THREADS PANEL: one thread of a CONVERSATIONAL channel, beside the conversation it was
// opened from (see AGENTS.md § A CHANNEL IS DRAWN THE WAY TEAMS DRAWS IT).
//
// It is Teams' own shape for that layout — a channel whose main column is a running
// conversation of top-level posts keeps each post's answers one press away rather than under
// it, because a wall of inline replies is what the POSTS layout is for. The panel therefore
// draws the root post, a centred line counting the replies, and the replies themselves.
//
// **IT BRINGS ITS OWN REPLY BAR, at its foot, and that REVERSES what shipped first.** The panel
// used to bring no composer: opening it aimed the app's own — the one under the conversation —
// on the argument that there is ONE composer here and a second would give the live driver's
// sentinel two answers. Read on screen, that was wrong, and the reference is right: a thread
// stands open on the RIGHT while the only bar sits under the conversation in the MIDDLE, so the
// box the reader is about to type their reply into belongs to neither column. It was reported
// exactly that way.
//
// So the panel ends in a bar of its own, and the conversation keeps its own — Slack's two bars.
// The sentinel is untouched: `composer-shell` still resolves to exactly ONE element (a thread's
// bar is `thread-composer-shell`), and what a keystroke can reach is unchanged either way,
// because a thread's bar posts a reply into a thread OF THIS CONVERSATION. Both bars name the
// same conversation, so the proof means what it always meant.
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { copyableMessageText, withoutWireLine } from "~/lib/protocol";
import type { ChatMessage } from "~/lib/protocol";
import { threadPanelHeading, type Thread, type ThreadReplies } from "~/lib/threads";
import type { ThreadTarget } from "~/lib/store";
import { Composer } from "./composer";

export function ChannelThreadsPanel(props: {
  thread: Thread;
  /** What the post's own foot row says about this thread, for the divider's count. Null
   *  where nobody has answered yet — a thread the reader opened to START. */
  replies: ThreadReplies | null;
  onClose: () => void;
  /** Whether a reply answers THIS thread's ROOT rather than another reply — which is what
   *  decides that its quote is not drawn (see the call site below). Absent on a CHANNEL, where
   *  a reply to the root carries no quote at all because the thread travels as an address. */
  repliesToRoot?: (reply: ChatMessage) => boolean;
  /** What this panel's own reply bar posts into. Absent only where nothing may be posted at
   *  all — a live call holds the app's composers, so the panel draws no second one under it. */
  composerTarget?: ThreadTarget | null;
  /** Bumped to put the caret in this bar's field: the press that opened the panel asked to
   *  write, so the field takes the caret in the same task as that click. */
  focusToken?: unknown;
  /** The pane's own row renderer, exactly as `ThreadGroup` takes it: one message drawn with
   *  this app's bubble, its receipts and its whole "…" menu. The panel renders nothing about
   *  a message itself, so a reaction, an edit and a deletion work here as they do anywhere. */
  renderMsg: (
    m: ChatMessage,
    prev?: ChatMessage,
    next?: ChatMessage,
    opts?: { onPanel?: boolean; threadPost?: boolean; showQuote?: boolean },
  ) => ReactNode;
}) {
  const { thread, replies, onClose, renderMsg, repliesToRoot, composerTarget } = props;
  // The post's own words for the heading, with any WIRE line taken off them: a colleague
  // running teams-lite can post a game or a companion into a channel, and the machine-readable
  // line those carry must never be what a header shows (§ THE SIX SURFACES THE WIRE MUST NEVER
  // REACH — this is a seventh, and it takes the same one function).
  const heading = threadPanelHeading(thread, withoutWireLine(copyableMessageText(thread.lead)));
  return (
    <section
      data-testid="threads-panel"
      // WHICH thread it is showing, for the reason the thread card carries its own root: the
      // history is virtualized and a panel opened from a row that has since scrolled away is
      // still this thread's.
      data-thread-root={thread.rootId}
      aria-label={`Thread — ${heading}`}
      // Full width below `md` (it REPLACES the history there), a column of its own beside it.
      // `min-w-0` because a heading is somebody's own words and a post's body may hold one
      // unbreakable token — a URL, a branch name — which without it widens the whole pane and
      // takes the app's own controls off the right of the screen (the lesson the merge
      // request's long title already taught this app).
      className="flex min-h-0 w-full min-w-0 shrink-0 flex-col border-border-subtle bg-background md:w-[22rem] md:border-l lg:w-[26rem]"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-3 md:px-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
            Thread
          </span>
          {/* The thread's TITLE where it has one and its opening words where it does not —
              which is most posts in a conversational channel, since a title is what the other
              layout is about. One line either way: a header is a place, not a document. */}
          <span
            data-testid="threads-panel-heading"
            title={heading}
            className="truncate text-sm font-medium text-foreground"
          >
            {heading}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          data-testid="threads-panel-close"
          // 44px under a thumb, which every target this app draws for one clears.
          className="-mr-1 grid size-11 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.6} />
        </button>
      </header>

      {/* Its own scroller: the panel keeps its place while the conversation beside it is read,
          and a thread of forty replies never scrolls the channel. */}
      <div
        data-testid="threads-panel-scroll"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-6 pt-3 md:px-4"
      >
        {/* The root post, drawn as a POST rather than as a bubble: one column whoever wrote
            it, the author always named, the moment beside the name. Its own words are the
            subject of this panel, so drawing the reader's own on the right in the accent fill
            would read as two sides of an argument — the argument `threadPost` already makes
            for the other layout. */}
        {renderMsg(thread.lead, undefined, undefined, { onPanel: true, threadPost: true })}

        {/* WHAT SEPARATES THE POST FROM ITS ANSWERS, and it is a line rather than a gap: the
            two are different things — one announcement, then a conversation about it — and a
            reader scrolling a long thread needs the boundary to still be findable. It states
            the count, which is the one fact the post's own foot row carried into this panel. */}
        <div className="my-3 flex items-center gap-3" data-testid="threads-panel-divider">
          <span className="h-px flex-1 bg-border-subtle" />
          <span className="text-[11px] font-medium text-text-faint">
            {replies ? replies.label : "No replies yet"}
          </span>
          <span className="h-px flex-1 bg-border-subtle" />
        </div>

        {thread.replies.length === 0 ? (
          // A thread the reader opened to START. It says what the next Enter does rather than
          // being empty, because the composer that answers it is a column away — under the
          // conversation, where there is one of it.
          <p data-testid="threads-panel-empty" className="text-[13px] text-text-faint">
            Nobody has answered this yet. What you write below lands in this thread.
          </p>
        ) : (
          thread.replies.map((reply, i) =>
            // `prev`/`next` are the neighbours INSIDE this thread, which is what they mean
            // here: a run of two answers by one person is one run, and the reply above a
            // reply is the reply above it rather than whatever the flat page held.
            renderMsg(reply, thread.replies[i - 1], thread.replies[i + 1], {
              onPanel: true,
              threadPost: true,
              // A reply that answers THE ROOT draws no quote of it in the root's own panel: the
              // post is right there, so a quote above every answer states one thing as many
              // times as there are replies. In a CHANNEL the quote was never posted at all
              // (`threadReplyQuotes`); in a CHAT it has to be in the body, because it is how the
              // reply says which thread it is in — so it is the DRAWING that is dropped here.
              //
              // A reply to another REPLY keeps its quote: a long thread holds several
              // conversations, and the quote is the only thing that says which is being
              // answered.
              showQuote: repliesToRoot ? !repliesToRoot(reply) : undefined,
            }),
          )
        )}
      </div>

      {/* THE THREAD'S OWN REPLY BAR, at the foot of the panel and outside its scroller — so it
          stays put while the thread is read, exactly as the conversation's own bar does under
          the history. It is the SAME composer component, so the pictures, the mentions, the
          emoji and the seal are the ones the reader already has; what it does not carry is a
          post title (a thread's title belongs to its first post) or any banner, because the
          panel above it is the banner. */}
      {composerTarget && (
        // `shrink-0` so the bar keeps its height while the thread above it scrolls: the scroller
        // is the `flex-1 min-h-0` element, which is what makes the panel one column with a fixed
        // head and a fixed foot — and what puts this bar on the SAME BASELINE as the
        // conversation's own, since both columns now reach the bottom of the pane.
        <div className="shrink-0 pt-2">
          <Composer thread={composerTarget} focusToken={props.focusToken} />
        </div>
      )}
    </section>
  );
}
