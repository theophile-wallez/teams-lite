import { useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MoonStar, Search, Sun } from "lucide-react";
import { convLabel, previewLine, type Conversation } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { useAppState } from "./controller-context";
import { NotificationsBell } from "./notifications-bell";
import { StatusBar } from "./status-bar";

const ROW_HEIGHT = 64;

/** Compact relative time for the sidebar (compose_time is epoch milliseconds). */
function formatTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (now.getTime() - d.getTime() < 7 * dayMs) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The left sidebar: an account header, a ⌘K search field, and a virtualized,
 * keyboard- and mouse-navigable conversation list. The open conversation reads
 * as a subtly elevated card (shadow-as-border); others stay flat and calm.
 */
export function ConversationList(props: {
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const conversations = useAppState((s) => s.conversations);
  const openId = useAppState((s) => s.openId);
  const resolvedTheme = useAppState((s) => s.resolvedTheme);
  const navigate = useNavigate();

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <aside
      data-testid="sidebar"
      className="flex w-[320px] shrink-0 flex-col border-r border-border-subtle bg-background"
    >
      {/* Account / workspace header. */}
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
          <span className="text-base font-semibold tracking-tight">t</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">teams-lite</span>
          <span className="truncate text-[11px] text-text-faint">Messages</span>
        </div>
        <NotificationsBell />
        <button
          type="button"
          aria-label="Appearance"
          title="Appearance (Ctrl+P)"
          onClick={props.onOpenSettings}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          {resolvedTheme === "dark" ? (
            <MoonStar className="size-4" strokeWidth={1.4} />
          ) : (
            <Sun className="size-4" strokeWidth={1.4} />
          )}
        </button>
      </div>

      {/* Search field with a ⌘K hint — opens the command palette. */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={props.onOpenPalette}
          className="flex w-full items-center gap-2 rounded-lg bg-card px-3 py-2 text-left text-text-faint shadow-chip transition-colors hover:text-text-dim"
        >
          <Search className="size-4 shrink-0" strokeWidth={1.4} />
          <span className="flex-1 text-[13px]">Search conversations</span>
          <kbd className="rounded bg-element px-1.5 py-0.5 text-[10px] font-medium text-text-faint">
            ⌘K
          </kbd>
        </button>
      </div>

      <div className="flex items-center px-4 pb-1 pt-1">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
          Chats
        </span>
      </div>

      <div
        ref={parentRef}
        data-testid="sidebar-scroll"
        className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2"
      >
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((row) => {
            const c = conversations[row.index];
            if (!c) return null;
            return (
              <div
                key={c.id}
                className="absolute left-0 top-0 w-full"
                style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${row.start}px)` }}
              >
                <ConversationRow
                  conversation={c}
                  open={openId === c.id}
                  selected={props.selectedIndex === row.index}
                  onClick={() => {
                    props.onSelect(row.index);
                    void navigate({
                      to: "/c/$conversationId",
                      params: { conversationId: c.id },
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      <StatusBar />
    </aside>
  );
}

function ConversationRow(props: {
  conversation: Conversation;
  open: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const c = props.conversation;
  const unread = !c.is_read && !c.is_muted;
  const preview = previewLine(c);
  const label = convLabel(c);
  const time = useMemo(() => formatTime(c.last_message_time), [c.last_message_time]);

  const emphasizeTitle = props.open || unread;

  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid="conversation-row"
      data-conversation-id={c.id}
      data-open={props.open ? "true" : undefined}
      data-selected={props.selected ? "true" : undefined}
      data-unread={unread ? "true" : undefined}
      aria-current={props.open ? "true" : undefined}
      className={cn(
        "my-0.5 flex h-[60px] w-full items-center gap-3 rounded-xl px-2.5 text-left transition-all",
        props.open
          ? "bg-row-open shadow-card"
          : props.selected
            ? "bg-row-selected ring-1 ring-inset ring-border-subtle"
            : "hover:bg-row-hovered",
      )}
    >
      <Avatar seed={c.id} label={label} />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span
            data-testid="conversation-name"
            className={cn(
              "truncate text-[13px]",
              props.open
                ? "font-medium text-foreground"
                : c.is_muted
                  ? "text-text-faint"
                  : emphasizeTitle
                    ? "font-medium text-foreground"
                    : "text-text-dim",
            )}
          >
            {label}
          </span>
          {time && (
            <time className="ml-auto shrink-0 text-[11px] tabular-nums text-text-faint">
              {time}
            </time>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex-1 truncate text-xs",
              props.open ? "text-text-dim" : unread ? "text-text-dim" : "text-text-faint",
            )}
          >
            {preview || "\u00A0"}
          </span>
          {unread && (
            <span className="size-2 shrink-0 rounded-full bg-unread-dot" aria-hidden />
          )}
        </span>
      </span>
    </button>
  );
}
