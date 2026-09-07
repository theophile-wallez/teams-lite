// THE THREADS PAGE: every thread the reader is in, across every conversation (`/threads`).
//
// It is a WAY IN and never a second place to read a thread. A thread is read where it happens —
// in the panel beside its own conversation, with that conversation's own composer under it —
// so a row here answers the three questions a reader has before deciding to open one (who
// answered, how many, when the last one landed) and then takes them there. Drawing the messages
// again would be a second message renderer, a second composer and a second answer to "where
// does the next Enter land", which is exactly what the panel's own header refuses.
//
// The data is `thread_digest`, read on every open (see `loadThreadDigest`) and derived by
// `threadsAcross` — the same two derivations the message pane uses, so a thread is one thing in
// this app and not two.
import { useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChevronLeftIcon, HashIcon, Message01Icon } from "@hugeicons/core-free-icons";
import { copyableMessageText, isChannelThreadId, withoutWireLine } from "~/lib/protocol";
import {
  THREADS_ROW_CHARS,
  threadDigestTruncated,
  threadsAcross,
  threadsRowLabel,
  type ThreadsViewRow,
} from "~/lib/threads-view";
import { useAppState, useController } from "./controller-context";
import { Avatar } from "./avatar";
import { Button } from "./ui/button";
import { FadeArc } from "./loading-ui/fade-arc";
import { cn } from "~/lib/utils";

export function ThreadsPane(props: { onBack?: () => void }) {
  const controller = useController();
  const navigate = useNavigate();
  const digest = useAppState((s) => s.threadDigest);
  const limit = useAppState((s) => s.threadDigestLimit);
  const loading = useAppState((s) => s.threadDigestLoading);
  const error = useAppState((s) => s.threadDigestError);
  const conversations = useAppState((s) => s.conversations);
  const channels = useAppState((s) => s.channels);
  const ready = useAppState((s) => s.ready);

  // Read on every open rather than once: a thread the reader was in a minute ago has moved,
  // and this list is what they opened the page to see. It costs no network request — the
  // replies are already in the store (§ A CHAT HAS THREADS TOO).
  useEffect(() => {
    if (ready) void controller.loadThreadDigest();
  }, [ready, controller]);

  const rows = useMemo(() => threadsAcross(digest), [digest]);
  const truncated = threadDigestTruncated(digest, limit);

  const open = (row: ThreadsViewRow) => {
    // The thread is named BEFORE the navigation, for the reason the diff page's own file is:
    // the conversation reads which thread to open out of this state, so navigating first would
    // land the reader in the conversation with no panel and nothing saying why.
    controller.openThread(row.conversationId, row.thread.rootId);
    void navigate({ to: "/c/$conversationId", params: { conversationId: row.conversationId } });
  };

  return (
    <section
      data-testid="threads-pane"
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-background"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:px-5">
        {/* Below `md` this page took the screen from the list, so it needs the way back every
            other detail surface has. */}
        <button
          type="button"
          aria-label="Back"
          onClick={props.onBack}
          className="-ml-1 grid size-11 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground md:hidden"
        >
          <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-sm font-medium text-foreground">Threads</h1>
          <p className="truncate text-[11px] text-text-faint">
            {/* What the list IS, because "threads" alone does not say whose. A reader who has
                replied nowhere is owed the reason the page is empty rather than an empty page. */}
            Conversations you have replied in
          </p>
        </div>
      </header>

      <div
        data-testid="threads-scroll"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-8 pt-3 md:px-5"
      >
        <div className="mx-auto flex w-full max-w-chat flex-col gap-2">
          {error ? (
            // SAID rather than drawn as an empty list: "you are in no threads" is a claim about
            // the reader's own conversations, and a read that failed is not one.
            <div
              data-testid="threads-error"
              className="flex flex-col items-start gap-3 rounded-xl bg-card px-4 py-3 shadow-card"
            >
              <p className="text-[13px] text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void controller.loadThreadDigest()}
              >
                Try again
              </Button>
            </div>
          ) : loading && rows.length === 0 ? (
            <p className="flex items-center gap-2 px-1 py-6 text-[13px] text-text-faint">
              <FadeArc className="size-3" /> Reading your threads…
            </p>
          ) : rows.length === 0 ? (
            <p data-testid="threads-empty" className="px-1 py-6 text-[13px] text-text-faint">
              You have not replied in any thread yet. Reply to a message and the thread it starts
              shows up here.
            </p>
          ) : (
            <>
              {rows.map((row) => (
                <ThreadRow
                  key={`${row.conversationId}:${row.thread.rootId}`}
                  row={row}
                  label={threadsRowLabel(row.conversationId, conversations, channels)}
                  onOpen={() => open(row)}
                />
              ))}
              {/* WHAT THE LIST LEFT OUT, counted rather than silent: a list that stops without
                  saying so reads as a complete one (the rule the update panel's own count
                  holds). It says nothing at all where the backend named no bound. */}
              {truncated && (
                <p data-testid="threads-truncated" className="px-1 pt-2 text-[11px] text-text-faint">
                  These are your most recent threads. An older one is still in its own
                  conversation.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * ONE THREAD, as a row: where it is, who opened it, what they said, and what has happened
 * since.
 *
 * The whole row is one press, because there is one thing to do with a thread from here. It is a
 * button rather than a link: the thread it opens is not an address of its own — it is a
 * conversation plus a panel, and naming which panel is state the URL does not carry.
 */
function ThreadRow(props: { row: ThreadsViewRow; label: string; onOpen: () => void }) {
  const { row, label, onOpen } = props;
  const lead = row.thread.lead;
  // The root's own words, with any WIRE line taken off them: a colleague running teams-lite can
  // post a game or a companion into a conversation, and the machine-readable line those carry
  // must never be what a row shows (§ THE SIX SURFACES THE WIRE MUST NEVER REACH — this is one
  // more, and it takes the same one function).
  const words = withoutWireLine(copyableMessageText(lead)).replace(/\s+/g, " ").trim();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="threads-row"
      data-conversation-id={row.conversationId}
      data-thread-root={row.thread.rootId}
      className={cn(
        "flex w-full flex-col gap-2 rounded-xl bg-card px-3 py-3 text-left shadow-card transition-colors",
        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      {/* WHERE it is, first: a thread out of its conversation is a thread about nothing, and
          this list crosses every conversation the reader has. */}
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-text-dim">
        <HugeiconsIcon
          icon={isChannelThreadId(row.conversationId) ? HashIcon : Message01Icon}
          className="size-3.5 shrink-0"
          strokeWidth={1.8}
        />
        <span className="truncate">{label}</span>
      </span>

      {/* WHO opened it and WHAT they said. The author is always named — this is a list of
          other people's conversations as much as the reader's own — and the words are clamped
          to two lines: a row is a way in, not the message. */}
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
          in the same order and the same words, so a thread reads the same in both places. */}
      <span className="flex min-w-0 items-center gap-2 pl-8 text-xs">
        <span className="flex shrink-0 items-center">
          {row.replies.repliers.map((reply, i) => (
            <Avatar
              key={reply.id}
              seed={reply.sender_mri || reply.sender}
              label={reply.sender}
              photo={reply.sender_mri ? { kind: "user", id: reply.sender_mri } : undefined}
              fallback="person"
              // 9px ink for a 20px face, the reason the foot row's own stack states in full:
              // `Avatar`'s 13px is sized for its 36px default and spills out of this one.
              className={cn("size-5 shrink-0 text-[9px] ring-2 ring-card", i > 0 && "-ml-1.5")}
            />
          ))}
        </span>
        <span className="shrink-0 font-medium text-primary">{row.replies.label}</span>
        <span className="hidden min-w-0 truncate text-text-faint sm:inline">
          Last reply {row.replies.lastReply}
        </span>
      </span>
    </button>
  );
}
