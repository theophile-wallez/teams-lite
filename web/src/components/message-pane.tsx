import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Loader2, MessagesSquare, WifiOff } from "lucide-react";
import {
  channelLabel,
  computeReadReceiptAnchors,
  convLabel,
  copyableMessageText,
  type Channel,
  type ChatMessage,
  type Conversation,
} from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import { Avatar, conversationPhoto, type AvatarPhoto } from "./avatar";
import { MessageBubble } from "./message-bubble";
import { SystemEventLine } from "./system-event-line";
import { ReadReceipts } from "./read-receipts";
import { ModifierKey } from "./shortcut";
import { PersonHoverCard } from "./person-card";
import { useModifierLabel } from "~/lib/platform";
import { groupThreads, type Thread } from "~/lib/threads";
import { Composer } from "./composer";
import { JumpToLatest } from "./jump-to-latest";
import { TypingIndicator } from "./typing-indicator";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

// Start prefetching older history well before the user reaches the very top, so
// pages stream in off-screen and a gap in the backlog is rarely perceived. The
// look-ahead is expressed in viewport heights (with a px floor for short panes).
const PREPEND_TRIGGER_SCREENS = 2;
const PREPEND_TRIGGER_MIN_PX = 600;

// The history is virtualized: only the rows near the viewport are mounted, so a
// deep backlog costs a bounded number of bubbles (and, with them, a bounded
// amount of DOM, Radix menus and document listeners) instead of growing without
// limit as older pages stream in. `ROW_ESTIMATE_PX` is only the pre-measurement
// guess — every row reports its real height through `measureElement` — but a
// sane value keeps the scrollbar honest while off-screen rows are still
// estimated. `OVERSCAN_ROWS` renders a little beyond the viewport so ordinary
// scrolling never shows a blank band.
const ROW_ESTIMATE_PX = 64;
const OVERSCAN_ROWS = 8;
// Height reserved at the top of the list for the "loading earlier messages"
// row, so reserving (and releasing) it doesn't shift the rows below.
const HISTORY_LOADER_PX = 32;
// How far from the bottom (in px) still counts as "at the bottom", which is what
// hides the jump-to-latest button. It is well above a stray pixel of layout
// rounding, so a row that measures slightly taller than its estimate never pops
// the button up on its own — and small enough that a deliberate scroll of even
// one short message shows it.
const AT_BOTTOM_PX = 120;

/** How close to the top (in px) the viewport must get before older history is
 *  prefetched — a couple of screens ahead so loading stays invisible. */
function prependTriggerPx(el: HTMLElement): number {
  return Math.max(PREPEND_TRIGGER_MIN_PX, el.clientHeight * PREPEND_TRIGGER_SCREENS);
}
// Deep-link scroll: how many older pages to page through looking for the target
// message before giving up, and how long to keep it visually highlighted.
const MAX_SCROLL_PAGES = 20;
const HIGHLIGHT_MS = 1600;

/** One row of the virtualized history: a single chat message, or a whole channel
 *  thread (its root post plus its collapsible replies). */
type HistoryRow =
  | { kind: "message"; key: string; message: ChatMessage; prev?: ChatMessage; next?: ChatMessage }
  | { kind: "thread"; key: string; thread: Thread };

/**
 * The right pane: conversation title, the scrolling message history (virtualized,
 * with infinite upward loading + scroll anchoring + sticky-to-bottom), and the
 * composer. Mirrors the TUI's MessagePane (ui/src/app.tsx).
 */
export function MessagePane(props: { onBack?: () => void }) {
  const controller = useController();
  const openId = useAppState((s) => s.openId);
  const messages = useAppState((s) => s.messages);
  const conversations = useAppState((s) => s.conversations);
  const channels = useAppState((s) => s.channels);
  const loadingMessages = useAppState((s) => s.loadingMessages);
  const loadingOlder = useAppState((s) => s.loadingOlder);
  const hasMoreOlder = useAppState((s) => s.hasMoreOlder);
  const messagesError = useAppState((s) => s.messagesError);
  const olderError = useAppState((s) => s.olderError);
  const pendingScroll = useAppState((s) => s.pendingScroll);
  const scrollToBottomNonce = useAppState((s) => s.scrollToBottomNonce);
  const readReceipts = useAppState((s) => s.readReceipts);
  const modifier = useModifierLabel();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Whether the history is parked at its newest message. It drives the
  // jump-to-latest button only, so it starts true: a pane that just opened is at
  // the bottom, and a conversation short enough to fit can never leave it.
  const [atBottom, setAtBottom] = useState(true);
  // Which channel threads are expanded (keyed by root message id). Threads are
  // collapsed by default — a thread shows its root post plus an "N replies" chip.
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const toggleThread = useCallback((rootId: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }, []);

  const viewportRef = useRef<HTMLDivElement>(null);
  const prevOpenIdRef = useRef<string | null>(null);
  // Bounded paging budget for the current deep-link target, reset per nonce.
  const scrollAttemptsRef = useRef(0);
  const scrollNonceRef = useRef(-1);
  // Last consumed "jump to the newest message" request (see the store's
  // `scrollToBottomNonce`), so the jump happens once per send and never on the
  // unrelated re-renders that share this effect's dependencies.
  const bottomNonceRef = useRef(0);

  // Which message each other member has read up to → their "seen by" avatar row.
  // Recomputed only when the messages or receipts change (cheap, but this is the
  // hot render path under a live message stream).
  const readAnchors = useMemo(
    () => computeReadReceiptAnchors(messages, readReceipts),
    [messages, readReceipts],
  );

  const openConv = conversations.find((c) => c.id === openId) ?? null;
  // A thread the pane opens is either a chat (in `conversations`) or a channel
  // (in `channels`). The header, subtitle and sender-name display key off which.
  const openChannel = !openConv ? (channels.find((c) => c.id === openId) ?? null) : null;
  // Show sender names in any multi-party thread: every channel, and group chats.
  const isGroup = openChannel !== null || openConv?.kind === "group";
  const headerLabel = openConv
    ? convLabel(openConv)
    : openChannel
      ? channelLabel(openChannel)
      : (openId ?? "");
  // A 1:1 shows the other party's photo; a group chat the picture its members gave
  // it; a channel its team's group photo. A subject with none keeps tinted initials.
  const headerPhoto: AvatarPhoto | undefined = openConv
    ? conversationPhoto(openConv)
    : openChannel?.team_group_id
      ? { kind: "team", id: openChannel.team_group_id }
      : undefined;

  // Channels render as threads: the flat, seq-ordered page is regrouped by
  // `thread_root_id` so a thread's root post and its replies sit together even
  // though the API interleaves posts from different threads. Chats stay flat
  // (`threads` is null). `replyRootOf` maps a reply's id back to its thread so a
  // deep-link into a collapsed thread can auto-expand it.
  const isChannel = openChannel !== null;
  const { threads, replyRootOf } = useMemo(() => {
    if (!isChannel) return { threads: null, replyRootOf: null };
    return groupThreads(messages);
  }, [isChannel, messages]);

  // Deep-linking to a reply inside a collapsed thread: expand that thread so the
  // scroll effect can find and center the target node.
  useEffect(() => {
    if (!replyRootOf || !pendingScroll || pendingScroll.convId !== openId) return;
    const rootId = replyRootOf.get(pendingScroll.messageId);
    if (rootId) {
      setExpandedThreads((prev) => (prev.has(rootId) ? prev : new Set(prev).add(rootId)));
    }
  }, [replyRootOf, pendingScroll, openId]);

  // The rows the virtualizer works in: one per message for a chat, one per whole
  // thread for a channel (a thread's root post and its replies are measured and
  // scrolled as a single block, so expanding one just makes its row taller).
  // `rowOfMessage` maps a message id to the row that renders it, for deep links.
  const { rows, rowOfMessage } = useMemo(() => {
    const rowOfMessage = new Map<string, number>();
    if (threads) {
      const rows: HistoryRow[] = threads.map((thread, i) => {
        rowOfMessage.set(thread.lead.id, i);
        for (const reply of thread.replies) rowOfMessage.set(reply.id, i);
        return { kind: "thread", key: thread.rootId, thread };
      });
      return { rows, rowOfMessage };
    }
    const rows: HistoryRow[] = messages.map((message, i) => {
      rowOfMessage.set(message.id, i);
      return {
        kind: "message",
        key: message.id,
        message,
        prev: messages[i - 1],
        next: messages[i + 1],
      };
    });
    return { rows, rowOfMessage };
  }, [threads, messages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: OVERSCAN_ROWS,
    // Chat semantics, straight from the virtualizer: `anchorTo: "end"` keeps the
    // row the user is reading pinned when older pages are prepended above it (it
    // re-anchors on the item at the current offset, which is what the old manual
    // scrollHeight arithmetic did by hand), and `followOnAppend` sticks to the
    // bottom on a live message only when we were already at the bottom.
    anchorTo: "end",
    followOnAppend: true,
    paddingStart: hasMoreOlder ? HISTORY_LOADER_PX : 0,
    // Why the rows are positioned by the virtualizer instead of by React (see
    // `containerRef` and the absence of a `transform` style below): a row's real
    // height only becomes known when it is mounted and measured, and a row that
    // measures differently from `ROW_ESTIMATE_PX` shifts every row after it. The
    // virtualizer compensates by writing `scrollTop`, and it does so
    // *synchronously*, inside the measurement — but the new row positions are a
    // React re-render, which paints a frame later. For that one frame the
    // viewport is corrected while the rows are still where they were: the history
    // visibly twitches, once per newly measured row, which is constant while
    // scrolling up through freshly prefetched pages. `directDomUpdates` closes the
    // gap by writing the row transforms and the container height in the same
    // synchronous block as the scroll correction, so the two can never paint out
    // of step.
    directDomUpdates: true,
  });
  const virtualRows = virtualizer.getVirtualItems();

  const maybeFill = useCallback(() => {
    const el = viewportRef.current;
    // A pane that hasn't been laid out yet reports no height, which would look
    // like "the history doesn't fill the viewport" and pull a page nobody needs.
    if (!el || el.clientHeight === 0) return;
    if (virtualizer.getTotalSize() <= el.clientHeight + 4 && hasMoreOlder && !loadingOlder) {
      void controller.loadOlderMessages();
    }
  }, [controller, hasMoreOlder, loadingOlder, virtualizer]);

  // A deep-link scroll in flight for the open conversation. While one is pending
  // the effect below owns paging, and the prefetch must stay out of its way.
  const deepLinkPending = pendingScroll !== null && pendingScroll.convId === openId;

  // Re-read the scroll geometry into `atBottom`. Called from the scroll handler
  // and from every place that moves the viewport itself, so the button answers a
  // programmatic jump as fast as it answers a wheel.
  const syncAtBottom = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX);
  }, []);

  // The button's job: park the reader back on the newest message. The jump is
  // immediate, like the one a send performs — a smooth scroll over a virtualized
  // backlog animates through rows whose heights are still estimates, so it lands
  // short and then corrects, which reads as a stumble.
  const jumpToLatest = useCallback(() => {
    if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    syncAtBottom();
  }, [rows.length, virtualizer, syncAtBottom]);

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    syncAtBottom();
    // Never prefetch while a deep link is settling. Centering an off-screen row
    // scrolls through a list whose off-window rows are still estimated, so the
    // viewport can pass through the trigger zone on its way to the target —
    // prepending a page there shifts every row index under the scroll, which
    // re-targets the effect, which scrolls again: the jump can end up parked at
    // the top of the history with the target never reached. The deep-link effect
    // pages older itself, deliberately and with a budget, when it has to.
    if (deepLinkPending) return;
    if (el.scrollTop < prependTriggerPx(el) && hasMoreOlder && !loadingOlder && !olderError) {
      void controller.loadOlderMessages();
    }
  };

  // Opening a conversation starts at its newest message. Every other anchoring
  // case (prepends, live appends) is the virtualizer's job — see its options.
  useLayoutEffect(() => {
    if (prevOpenIdRef.current === openId) return;
    prevOpenIdRef.current = openId;
    if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    syncAtBottom();
  }, [openId, rows.length, virtualizer, syncAtBottom]);

  // Sending takes the sender to their own message: jump to the newest row, which
  // also leaves the view at the bottom so the send's echo is followed in.
  useLayoutEffect(() => {
    if (bottomNonceRef.current === scrollToBottomNonce) return;
    bottomNonceRef.current = scrollToBottomNonce;
    if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    syncAtBottom();
  }, [scrollToBottomNonce, rows.length, virtualizer, syncAtBottom]);

  // A conversation whose loaded history doesn't fill the viewport can't be
  // scrolled, so nothing would ever trigger a backfill: pull the next page until
  // there is something to scroll (or history runs out).
  useLayoutEffect(() => {
    maybeFill();
    // A row that arrives, grows or is measured moves the bottom without the user
    // scrolling, and no scroll event reports that.
    syncAtBottom();
  }, [maybeFill, rows.length, syncAtBottom]);

  // A pending deep-link target: center that message, paging older until it
  // loads. The node is only in the DOM once its row is inside the virtual
  // window, so an off-screen target is first scrolled to by row index and
  // centered exactly on the next render.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const target = pendingScroll && pendingScroll.convId === openId ? pendingScroll : null;
    if (!target) return;

    // Fresh target -> reset the paging budget.
    if (scrollNonceRef.current !== target.nonce) {
      scrollNonceRef.current = target.nonce;
      scrollAttemptsRef.current = 0;
    }

    const node = findMessageNode(el, target.messageId);
    if (node) {
      node.scrollIntoView({ block: "center" });
      setHighlightId(target.messageId);
      controller.clearScrollTarget(target.nonce);
      return;
    }
    // Loaded, but its row is outside the rendered window — bring the row into
    // view; the next render mounts the node and the branch above centers it.
    const row = rowOfMessage.get(target.messageId);
    if (row !== undefined) {
      virtualizer.scrollToIndex(row, { align: "center" });
      return;
    }
    // The first page (or an older page) is still in flight — keep the target
    // pending and wait for the next render rather than giving up early.
    if (loadingMessages || loadingOlder) return;
    // Not loaded yet — page older toward it, bounded so a missing id (e.g. a
    // channel activity that doesn't map to a stored message) can't loop.
    if (hasMoreOlder && scrollAttemptsRef.current < MAX_SCROLL_PAGES) {
      scrollAttemptsRef.current += 1;
      void controller.loadOlderMessages();
      return;
    }
    // Give up and drop the request; the view stays where it is.
    controller.clearScrollTarget(target.nonce);
  }, [
    pendingScroll,
    openId,
    rowOfMessage,
    virtualRows,
    virtualizer,
    hasMoreOlder,
    loadingOlder,
    loadingMessages,
    controller,
  ]);

  // Fade out the deep-link highlight after a short beat.
  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightId]);

  const doReply = useCallback((m: ChatMessage) => {
    controller.startReply(m);
    setFocusToken((t) => t + 1);
  }, [controller]);

  const doCopy = useCallback(async (m: ChatMessage) => {
    const text = copyableMessageText(m);
    try {
      await navigator.clipboard.writeText(text);
      controller.setStatus("Message copied to clipboard");
    } catch {
      controller.setStatus("Copy failed: clipboard unavailable");
    }
  }, [controller]);

  const doStartEdit = useCallback((m: ChatMessage) => {
    setEditingId(m.id);
  }, []);

  const doSaveEdit = useCallback(async (m: ChatMessage, text: string) => {
    setEditingId(null);
    await controller.editMessage(m.id, text);
  }, [controller]);

  const doReact = useCallback((m: ChatMessage, key: string) => {
    void controller.reactToMessage(m.id, key);
  }, [controller]);

  const doCancelEdit = useCallback(() => setEditingId(null), []);

  // One rendered row: a system-event line or a message bubble, with its optional
  // "seen by" receipts underneath. `prev`/`next` drive avatar/name chaining and
  // are the visually adjacent rows (within a thread for channels, else the flat
  // neighbours), not necessarily the raw array neighbours. `onPanel` marks a
  // message the caller already framed — the root post of a channel thread.
  const renderMsg = (
    m: ChatMessage,
    prev?: ChatMessage,
    next?: ChatMessage,
    opts?: { onPanel?: boolean },
  ) => {
    const seenBy = readAnchors.get(m.id);
    return (
      <div key={m.id} className="contents">
        {m.system_event ? (
          <SystemEventLine event={m.system_event} />
        ) : (
          <MessageBubble
            message={m}
            showSenderName={isGroup}
            continuesAbove={sameAuthor(prev, m)}
            continuesBelow={sameAuthor(m, next)}
            onPanel={opts?.onPanel}
            editing={editingId === m.id}
            highlighted={highlightId === m.id}
            onReply={doReply}
            onCopy={doCopy}
            onReact={doReact}
            onStartEdit={doStartEdit}
            onSaveEdit={doSaveEdit}
            onCancelEdit={doCancelEdit}
          />
        )}
        {seenBy && <ReadReceipts receipts={seenBy} />}
      </div>
    );
  };

  if (!openId) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-4 bg-background">
        <div className="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary shadow-chip">
          <MessagesSquare className="size-6" strokeWidth={1.4} />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm font-medium text-foreground">No conversation open</p>
          <p className="text-[13px] text-text-faint">
            Pick a chat on the left, or press{" "}
            <kbd className="inline-flex items-baseline rounded bg-element px-1.5 py-0.5 text-[11px] font-medium text-text-dim">
              <ModifierKey modifier={modifier} />
            </kbd>{" "}
            <kbd className="rounded bg-element px-1.5 py-0.5 text-[11px] font-medium text-text-dim">
              K
            </kbd>{" "}
            to search.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="message-pane" className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-5">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back to conversations"
            data-testid="back-to-list"
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <ChevronLeft className="size-5" strokeWidth={1.6} />
          </button>
        )}
        {(openConv || openChannel) && (
          <Avatar
            seed={openId}
            label={headerLabel}
            photo={headerPhoto}
            fallback={openConv?.kind === "one_on_one" ? "person" : "initials"}
            className="size-9"
          />
        )}
        <div className="flex min-w-0 flex-col">
          {/* In a 1:1 the title IS a person, so it offers their card on hover —
              like every other name in the app. A group/channel title names no
              single human, so it stays plain text (no MRI, no trigger). */}
          <PersonHoverCard
            mri={openConv?.kind === "one_on_one" ? openConv.avatar_mri : undefined}
            name={headerLabel}
            className="min-w-0"
          >
            <h2 data-testid="conversation-title" className="truncate text-sm font-medium text-foreground">
              {headerLabel}
            </h2>
          </PersonHoverCard>
          {openConv ? (
            <p className="truncate text-[11px] text-text-faint">{paneSubtitle(openConv)}</p>
          ) : openChannel ? (
            <p data-testid="channel-subtitle" className="truncate text-[11px] text-text-faint">
              {channelSubtitle(openChannel)}
            </p>
          ) : null}
        </div>
      </header>

      {/* The history and the control that floats over it. The wrapper is what the
          jump-to-latest button positions against, so the button sits at the bottom
          of the viewport (just above the composer) instead of scrolling away with
          the messages. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          onScroll={onScroll}
          data-testid="message-scroll"
          // How much history is loaded, which the rendered row count no longer
          // reveals now that the list is virtualized (used by the E2E suite).
          data-loaded-count={messages.length}
          // The bottom padding clears the composer's fade overlay (`h-14`, 56px):
          // at 40px the gradient is down to ~9% of the background, so the last
          // message reads at full contrast instead of sitting under the fade.
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-10 pt-4 md:px-5"
        >
          {messages.length === 0 ? (
            <EmptyState
              loading={loadingMessages}
              error={messagesError}
              onRetry={() => void controller.openConversation(openId)}
            />
          ) : (
            <div
              // The virtualizer positions the rows itself (see `directDomUpdates`),
              // so they carry no `transform` from React. The *height* stays here on
              // purpose: prepending a page re-anchors the reader by writing
              // `scrollTop`, and that write happens in the virtualizer's own layout
              // effect — which runs before it would set this height itself. A
              // scroller that hasn't grown yet clamps the write, and the reader ends
              // up thrown back into the page that just loaded. Sizing this element
              // during React's own DOM mutation keeps the growth ahead of the
              // re-anchor; `containerRef` then keeps it in sync when a measurement
              // changes the total without a re-render.
              ref={virtualizer.containerRef}
              className="relative mx-auto w-full max-w-chat"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {hasMoreOlder && (
                <div
                  className="absolute inset-x-0 top-0 flex items-center justify-center"
                  style={{ height: `${HISTORY_LOADER_PX}px` }}
                >
                  {loadingOlder ? (
                    <span className="flex items-center gap-2 text-xs text-text-faint">
                      <Loader2 className="size-3 animate-spin" strokeWidth={1.6} /> Loading earlier
                      messages…
                    </span>
                  ) : olderError ? (
                    <span className="text-xs text-destructive">
                      Couldn't load earlier messages — scroll up to retry.
                    </span>
                  ) : null}
                </div>
              )}
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    // `flex flex-col` is load-bearing: the rows inside carry
                    // vertical margins, and a flex container keeps them inside its
                    // own box (no margin collapsing) so `measureElement` reports a
                    // height that includes the spacing.
                    className="absolute inset-x-0 top-0 flex flex-col"
                  >
                    {row.kind === "thread" ? (
                      <ThreadGroup
                        thread={row.thread}
                        expanded={expandedThreads.has(row.thread.rootId)}
                        onToggle={() => toggleThread(row.thread.rootId)}
                        renderMsg={renderMsg}
                      />
                    ) : (
                      renderMsg(row.message, row.prev, row.next)
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <JumpToLatest visible={!atBottom} onClick={jumpToLatest} />
      </div>

      {/* The composer's fade overlay reaches up over this row and the typing line,
          so both stack above it (z-10) to stay fully legible. */}
      {messagesError && messages.length > 0 && (
        <div className="relative z-10 border-t border-border-subtle bg-destructive/10 px-5 py-2 text-center text-xs text-destructive">
          {messagesError}
        </div>
      )}

      <TypingIndicator />
      <Composer focusToken={focusToken} />
    </section>
  );
}

/** One channel thread: the root post, an optional subject heading, and a
 *  collapsible "N replies" block (collapsed by default).
 *
 *  This card is the root post's own surface, so the post renders on it (`onPanel`)
 *  rather than bringing a second one of its own — a whole notifications channel is
 *  made of app cards, and a card inside a card frames the same words twice. */
function ThreadGroup(props: {
  thread: Thread;
  expanded: boolean;
  onToggle: () => void;
  renderMsg: (
    m: ChatMessage,
    prev?: ChatMessage,
    next?: ChatMessage,
    opts?: { onPanel?: boolean },
  ) => ReactNode;
}) {
  const { thread, expanded, onToggle, renderMsg } = props;
  const { subject, lead, replies } = thread;
  return (
    // The horizontal padding is the post's own margin: the subject, the root post
    // and the replies all start at this edge, so a flush card lines up with the
    // heading above it.
    <div
      data-testid="thread-group"
      className="mb-3 rounded-2xl border border-border-subtle/60 bg-element/20 px-3 py-2.5"
    >
      {subject && <h3 className="pb-1 text-[13px] font-semibold text-foreground">{subject}</h3>}
      {renderMsg(lead, undefined, undefined, { onPanel: true })}
      {replies.length > 0 && (
        <>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            data-testid="thread-toggle"
            // The negative margin pulls the label back to the post's edge while the
            // padding stays a hit area for the hover background.
            className="-ml-1.5 mt-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform duration-200 ease-out", expanded && "rotate-90")}
              strokeWidth={1.8}
            />
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </button>
          {expanded && (
            <div className="mt-1 border-l-2 border-border-subtle/60 pl-2 animate-in fade-in slide-in-from-top-1 duration-200 ease-out">
              {replies.map((r, i) => renderMsg(r, replies[i - 1], replies[i + 1]))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Two adjacent messages chain when they share the same author and side. A
 *  system event (e.g. a call line) is never part of a run, so it breaks chaining
 *  for its neighbours. */
function sameAuthor(a: ChatMessage | undefined, b: ChatMessage | undefined): boolean {
  return (
    !!a &&
    !!b &&
    !a.system_event &&
    !b.system_event &&
    a.is_self === b.is_self &&
    a.sender === b.sender
  );
}

/** Find a rendered message bubble by id without CSS-selector escaping (message
 *  ids contain `:`, `@`, `#`), by scanning the data attribute directly. */
function findMessageNode(viewport: HTMLElement, messageId: string): HTMLElement | null {
  const nodes = viewport.querySelectorAll<HTMLElement>("[data-message-id]");
  for (const node of nodes) {
    if (node.dataset.messageId === messageId) return node;
  }
  return null;
}

/** Subtitle for an open channel: its team, as a Teams-style breadcrumb (team ›
 *  channel), so the header reads "General" over "Engineering · Channel". */
function channelSubtitle(channel: Channel): string {
  const team = channel.team_name || "Team";
  return `${team} · Channel`;
}

/** A short, calm subtitle describing the open conversation. */
function paneSubtitle(conv: Conversation): string {
  switch (conv.kind) {
    case "group":
    case "unknown":
      return "Group chat";
    case "notes":
      return "Your notes";
    default:
      return "Direct message";
  }
}

function EmptyState(props: { loading: boolean; error: string | null; onRetry: () => void }) {
  if (props.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="grid size-12 place-items-center rounded-2xl bg-destructive/10 text-destructive shadow-chip">
          <WifiOff className="size-5" strokeWidth={1.4} />
        </div>
        <p className="text-sm font-medium text-foreground">Couldn't load messages</p>
        <p className="max-w-sm text-xs text-text-faint">{props.error}</p>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (props.loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-faint">
        <Loader2 className="size-4 animate-spin" strokeWidth={1.6} /> Loading messages…
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center text-sm text-text-faint">
      No messages yet.
    </div>
  );
}
