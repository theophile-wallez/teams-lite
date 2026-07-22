import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { cn } from "~/lib/utils";
import type { Notification } from "~/lib/protocol";
import {
  actorLabel,
  activityVerb,
  formatRelativeTime,
  leadingEmoji,
} from "~/lib/notifications";
import { Avatar } from "./avatar";
import { useAppState, useController } from "./controller-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * The activity-feed bell in the sidebar header. Badges the unread count and
 * opens a portaled panel listing reactions / mentions / replies directed at the
 * user (the Teams `48:notifications` feed). Selecting an entry opens the chat it
 * happened in. This surface exists precisely so `48:notifications` is never
 * shown as a junk conversation — it is a feed, not a chat.
 */
export function NotificationsBell() {
  const items = useAppState((s) => s.notifications);
  const unread = useAppState((s) => s.notificationsUnread);
  const controller = useController();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      controller.markNotificationsSeen();
      controller.reloadNotifications();
    }
  };

  const openThread = (n: Notification) => {
    if (!n.source_thread_id) return;
    void navigate({ to: "/c/$conversationId", params: { conversationId: n.source_thread_id } });
  };

  const badge = unread > 0 ? (unread > 9 ? "9+" : String(unread)) : null;

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
          <Bell className="size-4" strokeWidth={1.4} />
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
        className="flex max-h-[70vh] w-[22rem] flex-col p-0"
      >
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          {unread > 0 && (
            <span className="text-[11px] font-medium text-text-faint">{unread} new</span>
          )}
        </div>
        <div className="h-px bg-border-subtle" />

        {items.length === 0 ? (
          <div
            data-testid="notifications-empty"
            className="flex flex-col items-center gap-1 px-6 py-10 text-center"
          >
            <Bell className="size-6 text-text-faint" strokeWidth={1.3} />
            <p className="text-sm font-medium text-text-dim">You're all caught up</p>
            <p className="text-xs text-text-faint">Reactions and mentions show up here.</p>
          </div>
        ) : (
          <div className="overflow-y-auto p-1">
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
        <Avatar seed={n.actor_mri || n.actor_name} label={actorLabel(n)} className="size-9" />
        {emoji && (
          <span className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full bg-card text-[11px] shadow-chip">
            {emoji}
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
        {n.preview && (
          <span className="line-clamp-2 whitespace-normal text-xs text-text-faint">
            {n.preview}
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}
