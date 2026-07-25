import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { Avatar, type AvatarPhoto } from "./avatar";
import { MessageBubble } from "./message-bubble";
import { CallEventLine } from "./call-event-line";
import { ReadReceipts } from "./read-receipts";
import { PersonHoverCard } from "./person-card";
import { groupThreads, type Thread } from "~/lib/threads";
import { Composer } from "./composer";
import { TypingIndicator } from "./typing-indicator";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

// Start prefetching older history well before the user reaches the very top, so
// pages stream in off-screen and a gap in the backlog is rarely perceived. The
// look-ahead is expressed in viewport heights (with a px floor for short panes).
const PREPEND_TRIGGER_SCREENS = 2;
const PREPEND_TRIGGER_MIN_PX = 600;
const STICKY_BOTTOM_PX = 80;

/** How close to the top (in px) the viewport must get before older history is
 *  prefetched — a couple of screens ahead so loading stays invisible. */
function prependTriggerPx(el: HTMLElement): number {
  return Math.max(PREPEND_TRIGGER_MIN_PX, el.clientHeight * PREPEND_TRIGGER_SCREENS);
}
// Deep-link scroll: how many older pages to page through looking for the target
// message before giving up, and how long to keep it visually highlighted.
const MAX_SCROLL_PAGES = 20;
const HIGHLIGHT_MS = 1600;

/**
 * The right pane: conversation title, the scrolling message history (with
 * infinite upward loading + scroll anchoring + sticky-to-bottom), and the
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
  const readReceipts = useAppState((s) => s.readReceipts);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
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
  const atBottomRef = useRef(true);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const prevOpenIdRef = useRef<string | null>(null);
  // Track the oldest message id + count across renders so we can tell an actual
  // older-history prepend apart from intermediate re-renders (e.g. the loading
  // flag toggling) or a live append at the bottom.
  const prevOldestIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(0);
  // Bounded paging budget for the current deep-link target, reset per nonce.
  const scrollAttemptsRef = useRef(0);
  const scrollNonceRef = useRef(-1);

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
  // A 1:1 shows the other party's photo; a channel shows its team's group photo;
  // a group chat has no single face and keeps its tinted initials.
  const headerPhoto: AvatarPhoto | undefined = openConv?.avatar_mri
    ? { kind: "user", id: openConv.avatar_mri }
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

  const maybeFill = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 4 && hasMoreOlder && !loadingOlder) {
      prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      void controller.loadOlderMessages();
    }
  }, [controller, hasMoreOlder, loadingOlder]);

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distanceToBottom < STICKY_BOTTOM_PX;
    if (el.scrollTop < prependTriggerPx(el) && hasMoreOlder && !loadingOlder && !olderError) {
      prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      void controller.loadOlderMessages();
    }
  };

  // Keep the viewport anchored: a pending deep-link target wins (scroll to that
  // message, paging older until it loads); otherwise jump to bottom on open,
  // preserve position when older messages are prepended, and stick to bottom
  // when already at bottom.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const openChanged = prevOpenIdRef.current !== openId;
    prevOpenIdRef.current = openId;

    // A real older-history prepend is the only change that must re-anchor the
    // viewport: the list grew *and* its oldest message changed. Intermediate
    // re-renders (the loading flag flipping) and live appends at the bottom
    // leave the oldest id untouched, so they must not consume the anchor — doing
    // so before the prepended rows actually mount is what made the view jump to
    // the top of the freshly loaded page.
    const oldestId = messages[0]?.id ?? null;
    const prepended =
      !openChanged &&
      messages.length > prevMessageCountRef.current &&
      oldestId !== null &&
      oldestId !== prevOldestIdRef.current;
    prevOldestIdRef.current = oldestId;
    prevMessageCountRef.current = messages.length;

    const target = pendingScroll && pendingScroll.convId === openId ? pendingScroll : null;
    if (target) {
      // Fresh target -> reset the paging budget.
      if (scrollNonceRef.current !== target.nonce) {
        scrollNonceRef.current = target.nonce;
        scrollAttemptsRef.current = 0;
      }
      const node = findMessageNode(el, target.messageId);
      if (node) {
        node.scrollIntoView({ block: "center" });
        atBottomRef.current = false;
        prependAnchorRef.current = null;
        setHighlightId(target.messageId);
        controller.clearScrollTarget(target.nonce);
        return;
      }
      // The first page (or an older page) is still in flight — keep the target
      // pending and wait for the next render rather than giving up early.
      if (loadingMessages || loadingOlder) return;
      // Not loaded yet — page older toward it, bounded so a missing id (e.g. a
      // channel activity that doesn't map to a stored message) can't loop.
      if (hasMoreOlder && scrollAttemptsRef.current < MAX_SCROLL_PAGES) {
        scrollAttemptsRef.current += 1;
        prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
        void controller.loadOlderMessages();
        return;
      }
      // Give up: fall through to normal anchoring and drop the request.
      controller.clearScrollTarget(target.nonce);
    }

    if (openChanged) {
      el.scrollTop = el.scrollHeight;
      prependAnchorRef.current = null;
      atBottomRef.current = true;
      maybeFill();
      return;
    }

    const anchor = prependAnchorRef.current;
    if (prepended && anchor) {
      // Older history just mounted above the viewport. Restore the exact prior
      // offset plus the height added on top so the message the user was reading
      // stays put. An absolute offset (not `+=`) is deliberate: at the very top
      // the browser suppresses its own scroll anchoring, so this is the only
      // thing keeping the view from snapping to the top of the new page.
      el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
      prependAnchorRef.current = null;
      maybeFill();
      return;
    }

    // A backfill settled without prepending (empty page or error): drop the now
    // stale anchor so a later bottom append can't get wrongly repositioned.
    if (anchor && !loadingOlder) prependAnchorRef.current = null;

    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, openId, maybeFill, pendingScroll, hasMoreOlder, loadingOlder, loadingMessages, controller]);

  // Fade out the deep-link highlight after a short beat.
  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlightId]);

  const doReply = (m: ChatMessage) => {
    controller.startReply(m);
    setFocusToken((t) => t + 1);
  };

  const doCopy = async (m: ChatMessage) => {
    const text = copyableMessageText(m);
    try {
      await navigator.clipboard.writeText(text);
      controller.setStatus("Message copied to clipboard");
    } catch {
      controller.setStatus("Copy failed: clipboard unavailable");
    }
  };

  const doStartEdit = (m: ChatMessage) => {
    setEditingId(m.id);
  };

  const doSaveEdit = async (m: ChatMessage, text: string) => {
    setEditingId(null);
    await controller.editMessage(m.id, text);
  };

  const doReact = (m: ChatMessage, key: string) => {
    void controller.reactToMessage(m.id, key);
  };

  // One rendered row: a system-event line or a message bubble, with its optional
  // "seen by" receipts underneath. `prev`/`next` drive avatar/name chaining and
  // are the visually adjacent rows (within a thread for channels, else the flat
  // neighbours), not necessarily the raw array neighbours.
  const renderMsg = (m: ChatMessage, prev?: ChatMessage, next?: ChatMessage) => {
    const seenBy = readAnchors.get(m.id);
    return (
      <div key={m.id} className="contents">
        {m.system_event ? (
          <CallEventLine event={m.system_event} />
        ) : (
          <MessageBubble
            message={m}
            showSenderName={isGroup}
            continuesAbove={sameAuthor(prev, m)}
            continuesBelow={sameAuthor(m, next)}
            editing={editingId === m.id}
            highlighted={highlightId === m.id}
            onReply={doReply}
            onCopy={doCopy}
            onReact={doReact}
            onStartEdit={doStartEdit}
            onSaveEdit={doSaveEdit}
            onCancelEdit={() => setEditingId(null)}
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
            <kbd className="rounded bg-element px-1.5 py-0.5 text-[11px] font-medium text-text-dim">
              Ctrl
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

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          onScroll={onScroll}
          data-testid="message-scroll"
          className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 md:px-5"
        >
          {messages.length === 0 ? (
            <EmptyState
              loading={loadingMessages}
              error={messagesError}
              onRetry={() => void controller.openConversation(openId)}
            />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col">
              {hasMoreOlder && (
                <div className="flex h-8 items-center justify-center">
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
              {threads
                ? threads.map((t) => (
                    <ThreadGroup
                      key={t.rootId}
                      thread={t}
                      expanded={expandedThreads.has(t.rootId)}
                      onToggle={() => toggleThread(t.rootId)}
                      renderMsg={renderMsg}
                    />
                  ))
                : messages.map((m, i) => renderMsg(m, messages[i - 1], messages[i + 1]))}
            </div>
          )}
        </div>
        {/* A soft fade at the bottom of the history so messages dissolve into the
            page just above the composer instead of clipping against a hard edge.
            from-background matches the pane and the composer's own backdrop, so the
            transition into the text bar reads as seamless. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
        />
      </div>

      {messagesError && messages.length > 0 && (
        <div className="border-t border-border-subtle bg-destructive/10 px-5 py-2 text-center text-xs text-destructive">
          {messagesError}
        </div>
      )}

      <TypingIndicator />
      <Composer focusToken={focusToken} />
    </section>
  );
}

/** One channel thread: the root post, an optional subject heading, and a
 *  collapsible "N replies" block (collapsed by default). */
function ThreadGroup(props: {
  thread: Thread;
  expanded: boolean;
  onToggle: () => void;
  renderMsg: (m: ChatMessage, prev?: ChatMessage, next?: ChatMessage) => ReactNode;
}) {
  const { thread, expanded, onToggle, renderMsg } = props;
  const { subject, lead, replies } = thread;
  return (
    <div className="mb-3 rounded-2xl border border-border-subtle/60 bg-element/20 px-2 py-2">
      {subject && (
        <h3 className="px-1 pb-1 text-[13px] font-semibold text-foreground">{subject}</h3>
      )}
      {renderMsg(lead, undefined, undefined)}
      {replies.length > 0 && (
        <>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            data-testid="thread-toggle"
            className="mt-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
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
