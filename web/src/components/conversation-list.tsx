import { useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BellOff,
  ChevronRight,
  MoonStar,
  Search,
  Settings as SettingsIcon,
  Star,
  Sun,
} from "lucide-react";
import {
  channelIsFavorite,
  channelIsMuted,
  channelLabel,
  convLabel,
  mailUnreadBadge,
  organizeChannels,
  previewLine,
  typingLabel,
  type Channel,
  type Conversation,
} from "~/lib/protocol";
import type { SidebarTab } from "~/lib/store";
import { cn } from "~/lib/utils";
import { Avatar, conversationPhoto } from "./avatar";
import { BrokerBanner } from "./broker-banner";
import { CalendarSidebar } from "./calendar-sidebar";
import { useAppState, useController } from "./controller-context";
import { MailList } from "./mail-list";
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
 * The left sidebar: an account header, a ⌘K search field, a section switch, and —
 * depending on the section — a virtualized conversation list, the team → channel
 * tree, the mailbox, or the calendar's own rail. Channel messages live entirely
 * under the Channels tab and never appear in the chat list, matching the Microsoft
 * Teams separation.
 *
 * The four labels are abbreviated in the tab strip (a 320px column will not carry
 * "Channels" and "Calendar" in full) with the full name on the accessible label, so
 * the strip stays legible without lying about what the sections are.
 */
export function ConversationList(props: {
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onOpenSettingsPage: () => void;
  settingsActive: boolean;
}) {
  const controller = useController();
  const sidebarTab = useAppState((s) => s.sidebarTab);
  const resolvedTheme = useAppState((s) => s.resolvedTheme);

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        // Mobile: the full-screen home list. Desktop (md+): a fixed 320px column.
        // The list never moves: on mobile the detail pane covers it outright, with
        // no transition and no parallax drift behind it.
        "flex w-full shrink-0 flex-col border-r border-border-subtle bg-background",
        "md:w-[320px]",
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
          data-cuelume-press=""
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
          data-cuelume-press=""
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
          data-cuelume-press=""
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
            <TabsTrigger value="chats" data-testid="tab-chats" className="px-2">
              Chats
            </TabsTrigger>
            <TabsTrigger value="channels" data-testid="tab-channels" className="px-2">
              <span aria-hidden>Chans</span>
              <span className="sr-only">Channels</span>
            </TabsTrigger>
            <TabsTrigger value="mail" data-testid="tab-mail" className="px-2">
              <span className="flex items-center justify-center gap-1.5">
                Mail
                <MailUnreadBadge />
              </span>
            </TabsTrigger>
            <TabsTrigger value="calendar" data-testid="tab-calendar" className="px-2">
              <span aria-hidden>Cal</span>
              <span className="sr-only">Calendar</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsPanel value="chats" className="flex min-h-0 flex-1 flex-col">
          <ChatList selectedIndex={props.selectedIndex} onSelect={props.onSelect} />
        </TabsPanel>
        <TabsPanel value="channels" className="flex min-h-0 flex-1 flex-col">
          <ChannelTree />
        </TabsPanel>
        <TabsPanel value="mail" className="flex min-h-0 flex-1 flex-col">
          <MailList />
        </TabsPanel>
        <TabsPanel value="calendar" className="flex min-h-0 flex-1 flex-col">
          <CalendarSidebar />
        </TabsPanel>
      </Tabs>

      {/* Above the status bar and below every list, so it shows on all four tabs and
          is impossible to miss — unlike the status line, which truncates at eleven
          pixels and which a pending-update notice replaces outright. */}
      <BrokerBanner />
      <StatusBar />
    </aside>
  );
}

/** Unread count on the Mail tab. Counts the INBOX only: it is the folder whose
 *  unread state a person acts on, whereas Junk and Deleted are noise (this mailbox
 *  carries 1558 unread messages in Deleted alone). Renders nothing at zero, and
 *  nothing at all until Mail has been opened once — mail loads lazily. */
function MailUnreadBadge() {
  const folders = useAppState((s) => s.mailFolders);
  const unread = mailUnreadBadge(folders);
  if (unread <= 0) return null;
  return (
    <span
      data-testid="mail-unread-badge"
      className="rounded-full bg-primary/12 px-1.5 text-[10px] font-semibold tabular-nums text-primary"
    >
      {unread > 99 ? "99+" : unread}
    </span>
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

  // Say something when there is nothing, the way the channel tree and the mail list
  // already do. A blank scroll box was the whole of the app's answer to "where did my
  // chats go" during a sign-in outage — the banner below explains the usual cause, and
  // this makes sure the list itself is never silently empty.
  if (conversations.length === 0) {
    return (
      <div
        data-testid="chats-empty"
        className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-text-faint"
      >
        No chats to show.
      </div>
    );
  }

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

/** The channel surface (the Channels tab): a pinned Favorites section on top, then
 *  the team → channel tree. Teams and channels render in the user's own Microsoft
 *  Teams order — the backend preserves the CSA array order and `organizeChannels`
 *  keeps it, with General first within each team. Favorited channels are lifted
 *  out of their team into the Favorites section.
 *
 *  The tree follows Microsoft Teams' own shape: each team is a collapsible section
 *  whose header carries the team's picture and its name at full size, and the
 *  channels below it are plain indented names — no per-channel glyph, because Teams
 *  has none and the indent alone already says "inside this team". */
function ChannelTree() {
  const channels = useAppState((s) => s.channels);
  const openId = useAppState((s) => s.openId);
  const favorites = useAppState((s) => s.channelFavorites);
  const controller = useController();
  const navigate = useNavigate();
  const { favorites: pinned, teams } = useMemo(
    () => organizeChannels(channels, favorites),
    [channels, favorites],
  );

  if (channels.length === 0) {
    return (
      <div
        data-testid="channels-empty"
        className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-text-faint"
      >
        No channels yet.
      </div>
    );
  }

  const renderRow = (c: Channel) => (
    <ChannelRow
      key={c.id}
      channel={c}
      open={openId === c.id}
      favorite={channelIsFavorite(c, favorites)}
      onToggleFavorite={() => controller.toggleChannelFavorite(c.id)}
      onClick={() =>
        void navigate({ to: "/c/$conversationId", params: { conversationId: c.id } })
      }
    />
  );

  return (
    <div
      data-testid="channels-scroll"
      className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2"
    >
      {pinned.length > 0 && (
        <ChannelSection
          sectionId="favorites"
          testId="favorites-group"
          label="Favorites"
          glyph={
            <Star
              className="size-4 shrink-0 fill-amber-400 text-amber-400"
              strokeWidth={1.6}
              aria-hidden
            />
          }
          channels={pinned}
          openId={openId}
          renderRow={renderRow}
        />
      )}
      {teams.map((team) => (
        <ChannelSection
          key={team.team_id}
          sectionId={team.team_id}
          testId="team-group"
          teamId={team.team_id}
          label={team.team_name || "Team"}
          glyph={
            <Avatar
              seed={team.team_id}
              label={team.team_name || "Team"}
              photo={team.group_id ? { kind: "team", id: team.group_id } : undefined}
              className="size-5 rounded-md text-[9px]"
            />
          }
          channels={team.channels}
          openId={openId}
          renderRow={renderRow}
        />
      ))}
    </div>
  );
}

/**
 * One collapsible section of the channel tree — a team, or the pinned Favorites.
 * The whole header is the toggle, as in Microsoft Teams, where clicking a team
 * folds it away; the state is persisted per section, so a user who works out of
 * two of their fifteen teams keeps the rest folded across reloads.
 *
 * A collapsed section still reports what it hides: the team name turns bold when
 * one of its channels is unread, and a dot marks the section holding the open
 * channel. Otherwise folding a team would look like losing it.
 */
function ChannelSection(props: {
  sectionId: string;
  testId: string;
  teamId?: string;
  label: string;
  glyph: ReactNode;
  channels: Channel[];
  openId: string | null;
  renderRow: (c: Channel) => ReactNode;
}) {
  const controller = useController();
  const collapsed = useAppState((s) => s.collapsedTeams[props.sectionId] === true);
  // A muted channel is not something a folded team should shout about, exactly as
  // it raises no unread marker of its own.
  const hidesUnread =
    collapsed && props.channels.some((c) => !c.is_read && !channelIsMuted(c));
  const hidesOpen = collapsed && props.channels.some((c) => c.id === props.openId);

  return (
    <section
      data-testid={props.testId}
      data-team-id={props.teamId}
      data-collapsed={collapsed ? "true" : undefined}
    >
      <h3 className="pt-2">
        <button
          type="button"
          data-testid="team-header"
          data-cuelume-press=""
          aria-expanded={!collapsed}
          onClick={() => controller.toggleTeamCollapsed(props.sectionId)}
          className="flex w-full items-center gap-1.5 rounded-lg py-1 pl-1 pr-2 text-left transition-colors hover:bg-row-hovered"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-text-faint transition-transform duration-150",
              !collapsed && "rotate-90",
            )}
            strokeWidth={2}
            aria-hidden
          />
          {props.glyph}
          <span
            data-testid="team-name"
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] text-foreground",
              hidesUnread ? "font-semibold" : "font-medium",
            )}
          >
            {props.label}
          </span>
          {hidesOpen && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
        </button>
      </h3>
      {!collapsed && props.channels.map(props.renderRow)}
    </section>
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
      <Avatar
        seed={c.id}
        label={label}
        photo={conversationPhoto(c)}
        fallback={c.kind === "one_on_one" ? "person" : "initials"}
      />

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

/** One channel row: the channel name and a date on a single line, indented under
 *  its team header — the Microsoft Teams shape, which gives a channel no glyph of
 *  its own and states membership through the indent. Unread is a bold name
 *  (Teams-style) and the open channel carries a coloured rail on its leading edge.
 *  A star toggles the channel's favorite state: revealed on hover, and shown filled
 *  at all times once favorited. A channel the user muted in Teams reads as muted:
 *  the name is faint, a crossed bell states why, and no unread marker appears. */
function ChannelRow(props: {
  channel: Channel;
  open: boolean;
  favorite: boolean;
  onToggleFavorite: () => void;
  onClick: () => void;
}) {
  const c = props.channel;
  const muted = channelIsMuted(c);
  const unread = !c.is_read && !muted;
  const label = channelLabel(c);
  const time = useMemo(() => formatTime(c.last_message_time), [c.last_message_time]);

  return (
    <div className="group/chan relative">
      <button
        type="button"
        onClick={props.onClick}
        data-testid="channel-row"
        data-channel-id={c.id}
        data-team-id={c.team_id}
        data-open={props.open ? "true" : undefined}
        data-unread={unread ? "true" : undefined}
        data-favorite={props.favorite ? "true" : undefined}
        data-muted={muted ? "true" : undefined}
        aria-current={props.open ? "true" : undefined}
        className={cn(
          // The leading padding lands the name just past the header's team picture,
          // so every channel reads as one indent level under its team.
          "flex h-9 w-full items-center gap-2 rounded-lg pl-11 pr-2.5 text-left transition-colors",
          props.open ? "bg-row-open shadow-card" : "hover:bg-row-hovered",
        )}
      >
        {props.open && (
          <span
            className="absolute left-1 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary"
            aria-hidden
          />
        )}

        <span
          data-testid="channel-name"
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            unread
              ? "font-semibold text-foreground"
              : props.open
                ? "text-foreground"
                : muted
                  ? "text-text-faint"
                  : "text-text-dim",
          )}
        >
          {label}
        </span>
        {/* The reason the row is quiet, stated rather than implied — a dim name
            alone reads as "read", not as "muted". */}
        {muted && (
          <span
            data-testid="channel-muted-glyph"
            role="img"
            aria-label="Muted"
            title="Muted in Microsoft Teams"
            className="grid shrink-0 place-items-center text-text-faint"
          >
            <BellOff className="size-3" aria-hidden />
          </span>
        )}
        {/* Date, hidden on hover and once favorited so the star can take its place. */}
        {time && (
          <time
            className={cn(
              "shrink-0 text-[11px] tabular-nums text-text-faint transition-opacity",
              "group-hover/chan:opacity-0",
              props.favorite && "opacity-0",
            )}
          >
            {time}
          </time>
        )}
      </button>

      {/* Favorite toggle in the trailing corner: revealed on hover/focus and shown
          filled at all times once the channel is favorited. */}
      <button
        type="button"
        data-testid="channel-favorite"
        aria-label={props.favorite ? "Unfavorite channel" : "Favorite channel"}
        aria-pressed={props.favorite}
        data-cuelume-toggle=""
        onClick={props.onToggleFavorite}
        className={cn(
          "absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md",
          "text-text-faint transition-opacity hover:text-foreground focus-visible:opacity-100",
          "opacity-0 group-hover/chan:opacity-100",
          props.favorite && "opacity-100",
        )}
      >
        <Star
          className={cn("size-3.5", props.favorite && "fill-amber-400 text-amber-400")}
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}
