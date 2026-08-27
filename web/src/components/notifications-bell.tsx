import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { AtSignIcon, BellIcon, MessageMultiple01Icon } from "@hugeicons/core-free-icons";
import { cn } from "~/lib/utils";
import {
  NOTIFICATION_TABS,
  type Notification,
  type NotificationTab,
} from "~/lib/protocol";
import {
  actorLabel,
  activityVerb,
  formatRelativeTime,
  leadingEmoji,
  sourceContext,
} from "~/lib/notifications";
import { Avatar } from "./avatar";
import { Emoji } from "./emoji";
import { useAppState, useController } from "./controller-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** Per-tab labels, empty-state copy, and glyphs. Kept together so the tab bar
 *  and each panel stay in sync from one source. */
const TAB_META: Record<
  NotificationTab,
  { label: string; icon: IconSvgElement; emptyTitle: string; emptyHint: string }
> = {
  activity: {
    label: "Activity",
    icon: BellIcon,
    emptyTitle: "You're all caught up",
    emptyHint: "Reactions, mentions and replies show up here.",
  },
  mentions: {
    label: "Mentions",
    icon: AtSignIcon,
    emptyTitle: "No mentions yet",
    emptyHint: "When someone @mentions you, it shows up here.",
  },
  following: {
    label: "Following",
    icon: MessageMultiple01Icon,
    emptyTitle: "Nothing new to follow",
    emptyHint: "Replies in threads you follow show up here.",
  },
};

/**
 * The activity-feed bell in the sidebar header. Badges the unread count and
 * opens a portaled panel with three horizontal tabs — Activity
 * (`48:notifications`), Mentions (`48:mentions`) and Following (`48:threads`) —
 * each listing entries directed at (or followed by) the user. Selecting an entry
 * opens the chat it happened in and scrolls to the source message. This surface
 * exists precisely so those Teams activity streams are never shown as junk
 * conversations — they are feeds, not chats.
 */
export function NotificationsBell() {
  const feeds = useAppState((s) => s.notifications);
  const unread = useAppState((s) => s.notificationsUnread);
  const controller = useController();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotificationTab>("activity");

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      controller.markNotificationsSeen();
      controller.reloadNotifications();
    }
  };

  const openThread = (n: Notification) => {
    if (!n.source_thread_id) return;
    // Land on the reacted-to/replied-to/mentioning message, not the bottom of
    // the chat. The pane consumes this once the conversation is open (paging
    // older if needed); an empty/unlocatable id just opens it normally.
    controller.requestScrollToMessage(n.source_thread_id, n.source_message_id);
    void navigate({ to: "/c/$conversationId", params: { conversationId: n.source_thread_id } });
  };

  const badge = unread > 0 ? (unread > 9 ? "9+" : String(unread)) : null;
  const items = feeds[tab];
  const meta = TAB_META[tab];

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={badge ? `Notifications, ${unread} unread` : "Notifications"}
          title="Notifications"
          data-testid="notifications-bell"
          data-unread={badge ? "true" : undefined}
          className="relative grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <HugeiconsIcon icon={BellIcon} className="size-4" strokeWidth={1.4} />
          {badge && (
            <span
              data-testid="notifications-badge"
              className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground"
            >
              {badge}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        data-testid="notifications-panel"
        // No `max-w` of its own. Keeping a menu inside the window is the shared
        // `DropdownMenuContent`'s rule now, and this panel is where it was first written by hand.
        className="flex max-h-[70vh] w-[22rem] flex-col p-0"
      >
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          {unread > 0 && (
            <span className="text-[11px] font-medium text-text-faint">{unread} new</span>
          )}
        </div>

        {/* Horizontal tabs. Plain role="tab" buttons (not menu items) so clicking
            switches the panel without closing the dropdown. */}
        <div role="tablist" aria-label="Notification streams" className="flex gap-1 px-2 pb-2">
          {NOTIFICATION_TABS.map((key) => {
            const t = TAB_META[key];
            const active = key === tab;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`notifications-tab-${key}`}
                data-state={active ? "active" : "inactive"}
                onClick={() => setTab(key)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-text-dim hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <HugeiconsIcon icon={t.icon} className="size-3.5" strokeWidth={1.6} />
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="h-px bg-border-subtle" />

        {items.length === 0 ? (
          <div
            data-testid="notifications-empty"
            className="flex flex-col items-center gap-1 px-6 py-10 text-center"
          >
            <HugeiconsIcon icon={meta.icon} className="size-6 text-text-faint" strokeWidth={1.3} />
            <p className="text-sm font-medium text-text-dim">{meta.emptyTitle}</p>
            <p className="text-xs text-text-faint">{meta.emptyHint}</p>
          </div>
        ) : (
          <div role="tabpanel" className="overflow-y-auto p-1">
            {items.map((n) => (
              <NotificationRow key={n.id} notification={n} onOpen={() => openThread(n)} />
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NotificationRow(props: { notification: Notification; onOpen: () => void }) {
  const n = props.notification;
  const emoji = leadingEmoji(n);
  const time = formatRelativeTime(n.timestamp);
  const context = sourceContext(n);

  return (
    <DropdownMenuItem
      onSelect={props.onOpen}
      data-testid="notification-item"
      data-unread={!n.is_read ? "true" : undefined}
      className={cn(
        "items-start gap-3 rounded-lg px-2.5 py-2",
        !n.is_read && "bg-accent/40",
      )}
    >
      <span className="relative shrink-0">
        <Avatar
          seed={n.actor_mri || n.actor_name}
          label={actorLabel(n)}
          photo={n.actor_mri ? { kind: "user", id: n.actor_mri } : undefined}
          fallback="person"
          className="size-9"
        />
        {emoji && (
          <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full bg-card shadow-chip">
            <Emoji emoji={emoji} className="size-3" />
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
            <span className="font-medium">{actorLabel(n)}</span>{" "}
            <span className="text-text-dim">{activityVerb(n)}</span>
          </span>
          {time && (
            <time className="shrink-0 text-[11px] tabular-nums text-text-faint">{time}</time>
          )}
        </span>
        {context && (
          <span className="truncate text-[11px] font-medium text-text-dim">in {context}</span>
        )}
        {n.preview && (
          <span className="line-clamp-2 whitespace-normal text-xs text-text-faint">
            {n.preview}
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}
