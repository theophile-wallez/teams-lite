import { useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BellOffIcon,
  CalendarDaysIcon,
  ChevronRightIcon,
  EyeOffIcon,
  GhostIcon,
  HashIcon,
  Mail01Icon,
  MessageMultiple01Icon,
  Moon02Icon,
  PinIcon,
  Search01Icon,
  Settings02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import {
  channelIsMuted,
  channelIsPinned,
  channelIsShown,
  channelLabel,
  convLabel,
  mailUnreadBadge,
  organizeChannels,
  previewLine,
  typingLabel,
  type Channel,
  type Conversation,
} from "~/lib/protocol";
import { formatShortcut, useModifierLabel } from "~/lib/platform";
import type { SidebarTab } from "~/lib/store";
import { cn } from "~/lib/utils";
import { Avatar, conversationFallback, conversationPhoto } from "./avatar";
import { BrokerBanner } from "./broker-banner";
import { CalendarSidebar } from "./calendar-sidebar";
import { useAppState, useController } from "./controller-context";
import { MailList } from "./mail-list";
import { NotificationsBell } from "./notifications-bell";
import { ShortcutChord } from "./shortcut";
import { StatusBar } from "./status-bar";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "./ui/tabs";

const ROW_HEIGHT = 64;

/** One icon-only tab in the sidebar strip: a taller target than a text tab needs,
 *  the glyph centred in it, and the active section tinted the accent colour. */
const TAB_ICON =
  "grid place-items-center py-2 text-text-dim data-[state=active]:text-primary";

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
 * The four sections show as icons in the tab strip, not as words: a 320px column
 * will not carry "Channels" and "Calendar" in full, and an abbreviation ("Chans",
 * "Cal") reads worse than the symbol it stands for. Each trigger therefore carries
 * the full name on `aria-label` and on the tooltip, so nothing is lost to a screen
 * reader or to a person who does not know the icon yet.
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
  const modifier = useModifierLabel();

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
          title={`Appearance (${formatShortcut("P", modifier)})`}
          data-cuelume-press=""
          onClick={props.onOpenSettings}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          {resolvedTheme === "dark" ? (
            <HugeiconsIcon icon={Moon02Icon} className="size-4" strokeWidth={1.4} />
          ) : (
            <HugeiconsIcon icon={Sun03Icon} className="size-4" strokeWidth={1.4} />
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
          <HugeiconsIcon icon={Settings02Icon} className="size-4" strokeWidth={1.4} />
        </button>
      </div>

      {/* Search field with a ⌘K / Ctrl+K hint — opens the command palette. */}
      <div className="px-3 pb-2">
        <button
          type="button"
          data-cuelume-press=""
          onClick={props.onOpenPalette}
          className="flex w-full items-center gap-2 rounded-lg bg-card px-3 py-2 text-left text-text-faint shadow-chip transition-colors hover:text-text-dim"
        >
          <HugeiconsIcon icon={Search01Icon} className="size-4 shrink-0" strokeWidth={1.4} />
          <span className="flex-1 text-[13px]">Search conversations</span>
          <kbd
            data-testid="search-shortcut"
            className="inline-flex items-baseline gap-px rounded bg-element px-1.5 py-0.5 text-[10px] font-medium text-text-faint"
          >
            <ShortcutChord keyName="K" modifier={modifier} />
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
            <TabsTrigger
              value="chats"
              data-testid="tab-chats"
              aria-label="Chats"
              title="Chats"
              className={TAB_ICON}
            >
              <HugeiconsIcon
                icon={MessageMultiple01Icon}
                className="size-[19px]"
                strokeWidth={1.6}
              />
            </TabsTrigger>
            <TabsTrigger
              value="channels"
              data-testid="tab-channels"
              aria-label="Channels"
              title="Channels"
              className={TAB_ICON}
            >
              <HugeiconsIcon icon={HashIcon} className="size-[19px]" strokeWidth={1.8} />
            </TabsTrigger>
            <TabsTrigger
              value="mail"
              data-testid="tab-mail"
              aria-label="Mail"
              title="Mail"
              className={cn(TAB_ICON, "relative")}
            >
              <HugeiconsIcon icon={Mail01Icon} className="size-[19px]" strokeWidth={1.6} />
              <MailUnreadBadge />
            </TabsTrigger>
            <TabsTrigger
              value="calendar"
              data-testid="tab-calendar"
              aria-label="Calendar"
              title="Calendar"
              className={TAB_ICON}
            >
              <HugeiconsIcon icon={CalendarDaysIcon} className="size-[19px]" strokeWidth={1.6} />
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
 *  nothing at all until Mail has been opened once — mail loads lazily.
 *
 *  The tab holds an icon, so the count sits in the tab's top-right corner. It is
 *  clear of the glyph, which keeps both readable without a cut-out ring. */
function MailUnreadBadge() {
  const folders = useAppState((s) => s.mailFolders);
  const unread = mailUnreadBadge(folders);
  if (unread <= 0) return null;
  return (
    <span
      data-testid="mail-unread-badge"
      className="absolute right-1 top-0.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] tabular-nums text-primary-foreground"
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

/** The channel surface (the Channels tab): the Pinned section on top, then the team →
 *  channel tree. Teams render in the user's own Microsoft Teams order, verified against
 *  the real client: CSA states no rank, but its v1 array order reproduces the client's
 *  and moves when the user re-arranges (see examples/team_order_recon.rs). The backend
 *  preserves that array order and `organizeChannels` keeps it, with General first
 *  within each team, which the backend puts there because CSA does not.
 *
 *  The tree follows Microsoft Teams' own shape: each team is a collapsible section
 *  whose header carries the team's picture and its name at full size, and the
 *  channels below it are plain indented names — no per-channel glyph, because Teams
 *  has none and the indent alone already says "inside this team".
 *
 *  Teams gives a channel exactly two placements beyond its team, and this renders
 *  both: a PINNED channel is lifted to the top section, and a HIDDEN one drops to its
 *  team's own "Hidden channels" entry. Nothing else groups — in particular there is no
 *  Favorites section, because Teams has none: `isFavorite` is its Show/Hide switch
 *  (true on most channels), which is what `is_shown` now carries. */
function ChannelTree() {
  const channels = useAppState((s) => s.channels);
  const openId = useAppState((s) => s.openId);
  const pins = useAppState((s) => s.channelPins);
  const controller = useController();
  const navigate = useNavigate();
  const { pinned, teams } = useMemo(
    () => organizeChannels(channels, pins),
    [channels, pins],
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
      pinned={channelIsPinned(c, pins)}
      onTogglePin={() => controller.toggleChannelPin(c.id)}
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
          sectionId="pinned"
          testId="pinned-group"
          label="Pinned"
          glyph={
            <HugeiconsIcon
              icon={PinIcon}
              className="size-4 shrink-0 text-text-dim"
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
          hidden={team.hidden}
          collapsedByDefault={team.collapsed}
          openId={openId}
          renderRow={renderRow}
        />
      ))}
    </div>
  );
}

/**
 * One collapsible section of the channel tree — a team, the Pinned list, or a team's
 * hidden channels. The whole header is the toggle, as in Microsoft Teams, where
 * clicking a team folds it away; the state is persisted per section, so a user who
 * works out of two of their fifteen teams keeps the rest folded across reloads.
 *
 * A collapsed section still reports what it hides: the team name turns bold when
 * one of its channels is unread, and a dot marks the section holding the open
 * channel. Otherwise folding a team would look like losing it.
 *
 * `collapsedByDefault` decides how a section OPENS, before the user has folded it here.
 * Two things set it, and both come from a decision the user already made:
 *
 *   - a TEAM opens the way it stands in their own Teams client (`isCollapsed`, which the
 *     backend reads on every sync), so a sidebar of fifteen teams arrives arranged
 *     rather than fully unrolled;
 *   - the HIDDEN-channels entry opens folded, because they hid those channels there.
 *
 * A fold made here wins from then on, and stays here: writing it back would change a
 * setting on the user's account, which this app does not do without a consent gate.
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
  /** Prefix of the header's own test ids (`<prefix>-header` / `<prefix>-name`), so a
   *  nested section is addressable apart from the team header that contains it. */
  headerPrefix?: string;
  /** Start folded rather than open. */
  collapsedByDefault?: boolean;
  /** Sit one level deeper, as a sub-entry of a team rather than a top-level group. */
  indented?: boolean;
  /** The channels Teams hides in this team. They render as a nested, folded
   *  sub-section after the rows, and they still count towards what a folded team
   *  reports — a hidden channel is out of the way, not gone. */
  hidden?: Channel[];
}) {
  const controller = useController();
  const stored = useAppState((s) => s.collapsedTeams[props.sectionId]);
  const collapsed = stored === undefined ? props.collapsedByDefault === true : stored;
  const hidden = props.hidden ?? [];
  const headerPrefix = props.headerPrefix ?? "team";
  const folded = collapsed ? [...props.channels, ...hidden] : [];
  // A muted channel is not something a folded team should shout about, exactly as
  // it raises no unread marker of its own.
  const hidesUnread = folded.some((c) => !c.is_read && !channelIsMuted(c));
  const hidesOpen = folded.some((c) => c.id === props.openId);

  return (
    <section
      data-testid={props.testId}
      data-team-id={props.teamId}
      data-collapsed={collapsed ? "true" : undefined}
    >
      <h3 className={props.indented ? "pt-1" : "pt-2"}>
        <button
          type="button"
          data-testid={`${headerPrefix}-header`}
          data-cuelume-press=""
          aria-expanded={!collapsed}
          onClick={() => controller.setTeamCollapsed(props.sectionId, !collapsed)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left transition-colors hover:bg-row-hovered",
            props.indented ? "pl-6" : "pl-1",
          )}
        >
          <HugeiconsIcon
            icon={ChevronRightIcon}
            className={cn(
              "size-3.5 shrink-0 text-text-faint transition-transform duration-150",
              !collapsed && "rotate-90",
            )}
            strokeWidth={2}
            aria-hidden
          />
          {props.glyph}
          <span
            data-testid={`${headerPrefix}-name`}
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              props.indented ? "text-text-dim" : "text-foreground",
              hidesUnread ? "font-semibold" : "font-medium",
            )}
          >
            {props.label}
          </span>
          {hidesOpen && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
        </button>
      </h3>
      {!collapsed && props.channels.map(props.renderRow)}
      {!collapsed && hidden.length > 0 && (
        <ChannelSection
          sectionId={`hidden:${props.sectionId}`}
          testId="hidden-group"
          teamId={props.teamId}
          label={`Hidden channels (${hidden.length})`}
          headerPrefix="hidden"
          collapsedByDefault
          indented
          glyph={
            <HugeiconsIcon
              icon={EyeOffIcon}
              className="size-3.5 shrink-0 text-text-faint"
              strokeWidth={1.6}
              aria-hidden
            />
          }
          channels={hidden}
          openId={props.openId}
          renderRow={props.renderRow}
        />
      )}
    </section>
  );
}

/** The Ghost-mode read mark: this thread is read HERE, and Teams was never told, so
 *  the sender still sees it as unread. It stands where the unread dot stood, because it
 *  answers the question that dot's absence raises — "did they see that I read it?".
 *  Renders nothing at all when the thread was read normally, which is the default. */
function GhostReadMark(props: { on?: boolean }) {
  if (!props.on) return null;
  return (
    <span
      data-testid="ghost-read-mark"
      title="Read in Ghost mode — Teams still shows this as unread, and the sender saw no read receipt."
      className="shrink-0 text-text-faint"
    >
      <HugeiconsIcon
        icon={GhostIcon}
        className="size-3.5"
        strokeWidth={1.6}
        aria-label="Read in Ghost mode"
      />
    </span>
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
        fallback={conversationFallback(c)}
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
          {unread ? (
            <span className="size-2 shrink-0 rounded-full bg-unread-dot" aria-hidden />
          ) : (
            <GhostReadMark on={c.is_ghost_read} />
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
 *  A pin toggles the channel into the sidebar's top Pinned section: revealed on
 *  hover, and shown filled at all times once pinned. A channel the user muted in
 *  Teams reads as muted: the name is faint, a crossed bell states why, and no unread
 *  marker appears. */
function ChannelRow(props: {
  channel: Channel;
  open: boolean;
  pinned: boolean;
  onTogglePin: () => void;
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
        data-pinned={props.pinned ? "true" : undefined}
        data-hidden={channelIsShown(c) ? undefined : "true"}
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
            <HugeiconsIcon icon={BellOffIcon} className="size-3" aria-hidden />
          </span>
        )}
        <GhostReadMark on={c.is_ghost_read} />
        {/* Date, hidden on hover and once pinned so the pin can take its place. */}
        {time && (
          <time
            className={cn(
              "shrink-0 text-[11px] tabular-nums text-text-faint transition-opacity",
              "group-hover/chan:opacity-0",
              props.pinned && "opacity-0",
            )}
          >
            {time}
          </time>
        )}
      </button>

      {/* Pin toggle in the trailing corner: revealed on hover/focus and shown filled
          at all times once the channel is pinned. */}
      <button
        type="button"
        data-testid="channel-pin"
        aria-label={props.pinned ? "Unpin channel" : "Pin channel"}
        aria-pressed={props.pinned}
        data-cuelume-toggle=""
        onClick={props.onTogglePin}
        className={cn(
          "absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md",
          "text-text-faint transition-opacity hover:text-foreground focus-visible:opacity-100",
          "opacity-0 group-hover/chan:opacity-100",
          props.pinned && "opacity-100",
        )}
      >
        {/* A pinned row states its state without shouting it: the glyph fills, and
            stays in the dim tone the section header uses, so the channel's own name
            keeps the row's attention. */}
        <HugeiconsIcon
          icon={PinIcon}
          className={cn("size-3.5", props.pinned && "fill-current text-text-dim")}
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}
