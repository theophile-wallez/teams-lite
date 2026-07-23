import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, MessagesSquare, WifiOff } from "lucide-react";
import { convLabel, copyableMessageText, type ChatMessage, type Conversation } from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import { Avatar } from "./avatar";
import { MessageBubble } from "./message-bubble";
import { CallEventLine } from "./call-event-line";
import { Composer } from "./composer";
import { TypingIndicator } from "./typing-indicator";
import { Button } from "./ui/button";

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
export function MessagePane() {
  const controller = useController();
  const openId = useAppState((s) => s.openId);
  const messages = useAppState((s) => s.messages);
  const conversations = useAppState((s) => s.conversations);
  const loadingMessages = useAppState((s) => s.loadingMessages);
  const loadingOlder = useAppState((s) => s.loadingOlder);
  const hasMoreOlder = useAppState((s) => s.hasMoreOlder);
  const messagesError = useAppState((s) => s.messagesError);
  const olderError = useAppState((s) => s.olderError);
  const pendingScroll = useAppState((s) => s.pendingScroll);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);

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

  const openConv = conversations.find((c) => c.id === openId) ?? null;
  const isGroup = openConv?.kind === "group";

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
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border-subtle px-5">
        {openConv && <Avatar seed={openConv.id} label={convLabel(openConv)} className="size-9" />}
        <div className="flex min-w-0 flex-col">
          <h2 data-testid="conversation-title" className="truncate text-sm font-medium text-foreground">
            {openConv ? convLabel(openConv) : openId}
          </h2>
          {openConv && (
            <p className="truncate text-[11px] text-text-faint">{paneSubtitle(openConv)}</p>
          )}
        </div>
      </header>

      <div
        ref={viewportRef}
        onScroll={onScroll}
        data-testid="message-scroll"
        className="flex-1 overflow-y-auto overflow-x-hidden px-5 py-4"
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
            {messages.map((m, i) =>
              m.system_event ? (
                <CallEventLine key={m.id} event={m.system_event} />
              ) : (
                <MessageBubble
                  key={m.id}
                  message={m}
                  showSenderName={isGroup}
                  continuesAbove={sameAuthor(messages[i - 1], m)}
                  continuesBelow={sameAuthor(m, messages[i + 1])}
                  editing={editingId === m.id}
                  highlighted={highlightId === m.id}
                  onReply={doReply}
                  onCopy={doCopy}
                  onReact={doReact}
                  onStartEdit={doStartEdit}
                  onSaveEdit={doSaveEdit}
                  onCancelEdit={() => setEditingId(null)}
                />
              ),
            )}
          </div>
        )}
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
