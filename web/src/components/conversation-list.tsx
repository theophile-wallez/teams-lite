import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { convLabel, previewLine, type Conversation } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";

const ROW_HEIGHT = 60;

/**
 * The left sidebar: a virtualized, keyboard- and mouse-navigable conversation
 * list. Mirrors the TUI's ConversationList (ui/src/app.tsx): unread dot, muted
 * dimming, "You:/Name:" preview line, and open/selected/hover row states.
 */
export function ConversationList(props: { selectedIndex: number; onSelect: (index: number) => void }) {
  const conversations = useAppState((s) => s.conversations);
  const openId = useAppState((s) => s.openId);
  const controller = useController();

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
      className="flex w-[300px] shrink-0 flex-col border-r border-border bg-panel"
    >
      <div ref={parentRef} className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((row) => {
            const c = conversations[row.index];
            if (!c) return null;
            return (
              <div
                key={c.id}
                className="absolute left-0 top-0 w-full px-1.5"
                style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${row.start}px)` }}
              >
                <ConversationRow
                  conversation={c}
                  open={openId === c.id}
                  selected={props.selectedIndex === row.index}
                  onClick={() => {
                    props.onSelect(row.index);
                    void controller.openConversation(c.id);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
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
        "flex h-full w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        props.open
          ? "bg-row-open"
          : props.selected
            ? "bg-row-selected ring-1 ring-inset ring-border-subtle"
            : "hover:bg-row-hovered",
      )}
    >
      <span
        className={cn(
          "mt-0.5 size-2 shrink-0 self-start rounded-full",
          unread ? "bg-unread-dot" : "bg-transparent",
        )}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-sm",
            props.open
              ? "font-medium text-foreground"
              : c.is_muted
                ? "text-text-faint"
                : unread
                  ? "font-medium text-foreground"
                  : "text-text-dim",
          )}
        >
          {convLabel(c)}
        </span>
        <span
          className={cn(
            "truncate text-xs",
            props.open ? "text-text-dim" : unread ? "text-muted-foreground" : "text-text-faint",
          )}
        >
          {preview || "\u00A0"}
        </span>
      </span>
    </button>
  );
}
