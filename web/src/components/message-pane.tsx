import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { convLabel, copyableMessageText, type ChatMessage } from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import { MessageBubble } from "./message-bubble";
import { Composer } from "./composer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

const PREPEND_TRIGGER_PX = 160;
const STICKY_BOTTOM_PX = 80;

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

  const [menuMessage, setMenuMessage] = useState<ChatMessage | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const prevOpenIdRef = useRef<string | null>(null);

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
    if (el.scrollTop < PREPEND_TRIGGER_PX && hasMoreOlder && !loadingOlder && !olderError) {
      prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      void controller.loadOlderMessages();
    }
  };

  // Keep the viewport anchored: jump to bottom on open, preserve position when
  // older messages are prepended, and stick to bottom when already at bottom.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const openChanged = prevOpenIdRef.current !== openId;
    prevOpenIdRef.current = openId;

    if (openChanged) {
      el.scrollTop = el.scrollHeight;
      prependAnchorRef.current = null;
      atBottomRef.current = true;
      maybeFill();
      return;
    }

    const anchor = prependAnchorRef.current;
    if (anchor) {
      el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
      prependAnchorRef.current = null;
      maybeFill();
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, openId, maybeFill]);

  const openActions = (m: ChatMessage) => setMenuMessage(m);

  const doReply = (m: ChatMessage) => {
    controller.startReply(m);
    setMenuMessage(null);
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
    setMenuMessage(null);
  };

  if (!openId) {
    return (
      <section className="flex flex-1 items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">
          Select a conversation, or press{" "}
          <kbd className="rounded border border-border bg-panel px-1.5 py-0.5 text-xs">Ctrl</kbd>+
          <kbd className="rounded border border-border bg-panel px-1.5 py-0.5 text-xs">K</kbd>.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="message-pane" className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <h2 data-testid="conversation-title" className="truncate text-sm font-semibold">
          {openConv ? convLabel(openConv) : openId}
        </h2>
      </header>

      <div
        ref={viewportRef}
        onScroll={onScroll}
        data-testid="message-scroll"
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"
      >
        {messages.length === 0 ? (
          <EmptyState
            loading={loadingMessages}
            error={messagesError}
            onRetry={() => void controller.openConversation(openId)}
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
            {hasMoreOlder && (
              <div className="flex h-6 items-center justify-center">
                {loadingOlder ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" /> loading earlier messages…
                  </span>
                ) : olderError ? (
                  <span className="text-xs text-destructive">
                    Couldn't load earlier messages — scroll up to retry.
                  </span>
                ) : null}
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                showSenderName={isGroup}
                onOpenActions={openActions}
              />
            ))}
          </div>
        )}
      </div>

      {messagesError && messages.length > 0 && (
        <div className="border-t border-border bg-destructive/10 px-4 py-2 text-center text-xs text-destructive">
          {messagesError}
        </div>
      )}

      <Composer focusToken={focusToken} />

      <Dialog open={menuMessage !== null} onOpenChange={(o) => !o && setMenuMessage(null)}>
        <DialogContent className="max-w-xs" showClose={false}>
          <DialogHeader>
            <DialogTitle>Message actions</DialogTitle>
            <DialogDescription className="truncate">
              {menuMessage ? copyableMessageText(menuMessage) : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="action-reply"
              onClick={() => menuMessage && doReply(menuMessage)}
            >
              Reply
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              data-testid="action-copy"
              onClick={() => menuMessage && void doCopy(menuMessage)}
            >
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function EmptyState(props: { loading: boolean; error: string | null; onRetry: () => void }) {
  if (props.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <WifiOff className="size-8 text-text-faint" />
        <p className="text-sm text-destructive">Couldn't load messages</p>
        <p className="max-w-sm text-xs text-muted-foreground">{props.error}</p>
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (props.loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> loading messages…
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      No messages yet.
    </div>
  );
}
