import { useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Hash, MoonStar, Search, Settings as SettingsIcon, Sun } from "lucide-react";
import {
  channelLabel,
  channelPreviewLine,
  convLabel,
  groupChannelsByTeam,
  previewLine,
  typingLabel,
  type Channel,
  type Conversation,
} from "~/lib/protocol";
import type { SidebarTab } from "~/lib/store";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { useAppState, useController } from "./controller-context";
import { NotificationsBell } from "./notifications-bell";
import { StatusBar } from "./status-bar";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "./ui/tabs";

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
 * The left sidebar: an account header, a ⌘K search field, a Chats/Channels tab
 * switch, and — depending on the tab — a virtualized conversation list or the
 * team → channel tree. Channel messages live entirely under the Channels tab and
 * never appear in the chat list, matching the Microsoft Teams separation.
 */
export function ConversationList(props: {
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onOpenSettingsPage: () => void;
  settingsActive: boolean;
  chatOpen: boolean;
}) {
  const controller = useController();
  const sidebarTab = useAppState((s) => s.sidebarTab);
  const resolvedTheme = useAppState((s) => s.resolvedTheme);

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        // Mobile: the full-screen home list. Desktop (md+): a fixed 320px column.
        // When a conversation slides in over the list on mobile, the list drifts
        // slightly left for an iOS-style parallax; this is a no-op on desktop.
        "flex w-full shrink-0 flex-col border-r border-border-subtle bg-background",
        "transition-transform duration-300 ease-out will-change-transform",
        "md:w-[320px] md:translate-x-0 md:transition-none md:will-change-auto",
        props.chatOpen && "max-md:-translate-x-[12%]",
      )}
    >
      {/* Account / workspace header. */}
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-[calc(1rem+env(safe-area-inset-top))]">
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
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          data-testid="open-settings"
          aria-current={props.settingsActive ? "page" : undefined}
          onClick={props.onOpenSettingsPage}
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg transition-colors",
            props.settingsActive
              ? "bg-accent text-foreground"
              : "text-text-dim hover:bg-accent hover:text-foreground",
          )}
        >
          <SettingsIcon className="size-4" strokeWidth={1.4} />
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

      <Tabs
        value={sidebarTab}
        onValueChange={(v) => controller.setSidebarTab(v as SidebarTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="px-3 pb-1.5">
          <TabsList aria-label="Sidebar sections" className="w-full">
            <TabsTrigger value="chats" data-testid="tab-chats">
              Chats
            </TabsTrigger>
            <TabsTrigger value="channels" data-testid="tab-channels">
              Channels
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsPanel value="chats" className="flex min-h-0 flex-1 flex-col">
          <ChatList selectedIndex={props.selectedIndex} onSelect={props.onSelect} />
        </TabsPanel>
        <TabsPanel value="channels" className="flex min-h-0 flex-1 flex-col">
          <ChannelTree />
        </TabsPanel>
      </Tabs>

      <StatusBar />
    </aside>
  );
}

/** The virtualized chat list (the Chats tab). Keyboard selection is driven from
 *  the app shell via `selectedIndex`/`onSelect`. */
function ChatList(props: { selectedIndex: number; onSelect: (index: number) => void }) {
  const conversations = useAppState((s) => s.conversations);
  const openId = useAppState((s) => s.openId);
  const navigate = useNavigate();

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
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
  );
}

/** The team → channel tree (the Channels tab): each team is a titled section, its
 *  channels listed beneath (General first, courtesy of the backend sort). */
function ChannelTree() {
  const channels = useAppState((s) => s.channels);
  const openId = useAppState((s) => s.openId);
  const navigate = useNavigate();
  const teams = useMemo(() => groupChannelsByTeam(channels), [channels]);

  if (teams.length === 0) {
    return (
      <div
        data-testid="channels-empty"
        className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-text-faint"
      >
        No channels yet.
      </div>
    );
  }

  return (
    <div
      data-testid="channels-scroll"
      className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2"
    >
      {teams.map((team) => (
        <section key={team.team_id} data-testid="team-group" data-team-id={team.team_id}>
          <h3 className="truncate px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
            {team.team_name || "Team"}
          </h3>
          {team.channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              open={openId === c.id}
              onClick={() =>
                void navigate({ to: "/c/$conversationId", params: { conversationId: c.id } })
              }
            />
          ))}
        </section>
      ))}
    </div>
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
  // Live typing wins over the last-message preview, exactly like Teams' sidebar.
  const typers = useAppState((s) => s.typingByConversation[c.id]);
  const typingText = typers && typers.length > 0 ? typingLabel(typers.map((t) => t.name)) : "";

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
          {typingText ? (
            <span
              data-testid="conversation-typing"
              className="flex flex-1 items-center gap-1.5 truncate text-xs text-primary"
            >
              <span className="typing-dots" aria-hidden="true">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
              <span className="truncate">{typingText}</span>
            </span>
          ) : (
            <span
              className={cn(
                "flex-1 truncate text-xs",
                props.open ? "text-text-dim" : unread ? "text-text-dim" : "text-text-faint",
              )}
            >
              {preview || " "}
            </span>
          )}
          {unread && (
            <span className="size-2 shrink-0 rounded-full bg-unread-dot" aria-hidden />
          )}
        </span>
      </span>
    </button>
  );
}

/** One channel row under its team. A leading `#` mirrors Teams' channel glyph;
 *  the preview line and unread dot match the chat rows for a consistent read. */
function ChannelRow(props: { channel: Channel; open: boolean; onClick: () => void }) {
  const c = props.channel;
  const unread = !c.is_read;
  const preview = channelPreviewLine(c);
  const label = channelLabel(c);
  const time = useMemo(() => formatTime(c.last_message_time), [c.last_message_time]);
  const typers = useAppState((s) => s.typingByConversation[c.id]);
  const typingText = typers && typers.length > 0 ? typingLabel(typers.map((t) => t.name)) : "";
  const emphasizeTitle = props.open || unread;

  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid="channel-row"
      data-channel-id={c.id}
      data-team-id={c.team_id}
      data-open={props.open ? "true" : undefined}
      data-unread={unread ? "true" : undefined}
      aria-current={props.open ? "true" : undefined}
      className={cn(
        "my-0.5 flex h-[54px] w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-all",
        props.open ? "bg-row-open shadow-card" : "hover:bg-row-hovered",
      )}
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg text-text-dim",
          props.open ? "bg-primary/15 text-primary" : "bg-element",
        )}
        aria-hidden
      >
        <Hash className="size-3.5" strokeWidth={1.8} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span
            data-testid="channel-name"
            className={cn(
              "truncate text-[13px]",
              emphasizeTitle ? "font-medium text-foreground" : "text-text-dim",
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
          {typingText ? (
            <span className="flex flex-1 items-center gap-1.5 truncate text-xs text-primary">
              <span className="typing-dots" aria-hidden="true">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
              <span className="truncate">{typingText}</span>
            </span>
          ) : (
            <span
              className={cn(
                "flex-1 truncate text-xs",
                unread ? "text-text-dim" : "text-text-faint",
              )}
            >
              {preview || " "}
            </span>
          )}
          {unread && <span className="size-2 shrink-0 rounded-full bg-unread-dot" aria-hidden />}
        </span>
      </span>
    </button>
  );
}
