// teams-lite web — application store + controller.
//
// The controller owns the backend WebSocket client and all of the business logic:
// local-first opens with a per-session message cache, coalesced conversation
// refreshes, durable drafts, live-message fan-in, and infinite history. React
// components stay dumb: they read fine-grained slices from the TanStack Store and
// call controller methods.
//
// State lives in a TanStack Store so components subscribe to just the slice they
// use (selector-based), which keeps re-renders cheap under a stream of live
// messages. Non-reactive caches (per-conversation messages, drafts, timers) are
// plain fields — they must not trigger renders on their own.

import { Store } from "@tanstack/store";
import { Backend, defaultWsUrl } from "./ws-client";
import type { SendImage } from "./composer-image";
import { dedupeCandidates, type MentionCandidate, type OutboundMention } from "./mentions";
import {
  appendLiveMessage,
  channelIsMuted,
  chatIsMuted,
  chatIsPinned,
  copyableMessageText,
  mergeOlderHistoryPage,
  mergeOlderMailPage,
  mergeRefreshedHistoryPage,
  mergeRefreshedMailPage,
  replyToPayload,
  shouldNotify,
  trimHistoryPage,
  mergeCalendarWindow,
  mailAddressSpellsAPerson,
  mailDomain,
  registrableMailDomain,
  type AddressPerson,
  type AvatarPicture,
  type AppSettings,
  type BrokerStatus,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarViewResult,
  type CallSignal,
  type CallSignalFrame,
  type Channel,
  type ChatMessage,
  type ChatPrefs,
  type Conversation,
  type IncomingCall,
  type LinkMetadata,
  type LiveStatus,
  type MailBody,
  type MailFolder,
  type MailHeader,
  type MailPage,
  type MessagePage,
  type Notification,
  type NotificationTab,
  type PersonPresence,
  type PersonOverride,
  type PersonProfile,
  type ReadReceipt,
  type ReadReceiptSignal,
  type ReplyTo,
  type SettingsPatch,
  type TypingName,
  type TypingSignal,
  type UpdateInfo,
  type UpdateProgress,
} from "./protocol";
import type { AgentMode, AgentProviderPatch, AgentStatus } from "./agent";
import {
  AGENT_RUN_STALE_MS,
  agentRunIsLive,
  parseAgentFrame,
  withAgentFrame,
  withoutAgentRun,
  type AgentRun,
} from "./agent-run";
import {
  UNKNOWN_CALL_STATUS,
  callEndLabel,
  holdsMicrophone,
  isLive,
  type CallMediaSignal,
  type CallStatus,
} from "./call";
import {
  MicrophoneUnavailableError,
  simulatedCallMedia,
  startCallMedia,
  type CallMedia,
} from "./call-media";
import { coalesce } from "./singleflight";
import {
  requestRange,
  shiftAnchor,
  startOfDay,
  visibleRange,
  type CalendarViewMode,
} from "./calendar";
import { ensureNotificationPermission, notifyCall, notifyMessage } from "./notify";
import {
  INITIAL_PUSH_STATE,
  currentSubscription,
  deviceLabel,
  pushBlocker,
  readPushEnvironment,
  subscribeThisDevice,
  subscriptionPayload,
  unsubscribeThisDevice,
  type PushState,
} from "./push";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  THEME_COLORS,
  coerceAppearance,
  resolveTheme,
  type Appearance,
  type ResolvedTheme,
} from "./appearance";
import { sendFailureMessage } from "./send-failure";
import {
  DEFAULT_SOUNDS_ENABLED,
  SOUNDS_STORAGE_KEY,
  bindCues,
  coerceSoundsEnabled,
  playCue,
  setCuesEnabled,
} from "./sounds";

export type PendingReply = { message: ChatMessage; marker: string | null };

/** Which sidebar list is showing: normal chats, the team/channel tree, or the
 *  mailbox. Each is a distinct source — a channel never appears in the chat list,
 *  and mail is a different backend surface entirely — so this is a hard switch. */
export type SidebarTab = "chats" | "channels" | "mail" | "calendar";

/** The cache key a mail attachment's proxied bytes are stored under. Namespaced so
 *  it can never collide with a Teams hosted-content URL in the shared media cache. */
function mailAttachmentKey(messageId: string, attachmentId: string): string {
  return `mail-attachment:${messageId}:${attachmentId}`;
}

/** Read an id → boolean map out of localStorage, or null when there is nothing
 *  usable there. Best-effort and SSR-safe on purpose: these maps hold sidebar
 *  preferences (favorited channels, collapsed sections), so a missing store, a
 *  malformed value or a non-boolean entry must degrade to the default rather than
 *  fail a render. */
function readFlagMap(key: string): Record<string, boolean> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const flags: Record<string, boolean> = {};
    for (const [id, flag] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof flag === "boolean") flags[id] = flag;
    }
    return flags;
  } catch {
    return null;
  }
}

/** Persist an id → boolean map. A failure just means it doesn't survive a reload. */
function writeFlagMap(key: string, flags: Record<string, boolean>): void {
  try {
    localStorage.setItem(key, JSON.stringify(flags));
  } catch {
    /* ignore — the preference stays in memory for this session */
  }
}

/** Read an id → number map out of localStorage (the chat hide watermarks), with the
 *  same best-effort contract as `readFlagMap`: anything unusable degrades to the
 *  default rather than failing a render. A non-finite entry is dropped, because a
 *  `NaN` watermark would compare false against every message time and so hide a
 *  chat the user could no longer bring back. */
function readTimeMap(key: string): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const times: Record<string, number> = {};
    for (const [id, time] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof time === "number" && Number.isFinite(time)) times[id] = time;
    }
    return times;
  } catch {
    return null;
  }
}

/** Persist an id → number map. Same best-effort contract as `writeFlagMap`. */
function writeTimeMap(key: string, times: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(times));
  } catch {
    /* ignore — the preference stays in memory for this session */
  }
}

export type AppState = {
  conversations: Conversation[];
  /** The team/channel tree (flat, pre-sorted; grouped for display by
   *  `groupChannelsByTeam`). Distinct from `conversations` — a channel never
   *  appears in the chat list. */
  channels: Channel[];
  /** The active sidebar tab (chats vs. channels). */
  sidebarTab: SidebarTab;
  /** Local per-channel pin overrides (channel id → pinned), persisted to
   *  localStorage. Overrides the backend's Teams-sourced `is_pinned`; a channel
   *  absent here falls back to that value. Drives the sidebar's top Pinned
   *  section (see `channelIsPinned`/`organizeChannels`). */
  channelPins: Record<string, boolean>;
  /** The user's own local placement of the chat list — which chats they pinned, muted
   *  or hid HERE, persisted to localStorage. Each map overrides the Teams-sourced
   *  value on the conversation row; a chat absent from a map keeps it. Drives the
   *  chat list's Pinned / Recent / Hidden sections (see `organizeChats`). */
  chatPrefs: ChatPrefs;
  /** Which sidebar sections the user has collapsed, keyed by team id (and
   *  `"pinned"` for the channel tree's top section, `"hidden:<team id>"` for a team's
   *  hidden channels, `"chats:<section>"` for a chat-list group), persisted to
   *  localStorage. A section absent here is expanded, so a fresh install shows the
   *  whole tree; the two hidden-things sections are the exception and default to
   *  collapsed, exactly as in Microsoft Teams. */
  collapsedSections: Record<string, boolean>;
  openId: string | null;
  messages: ChatMessage[];
  loadingMessages: boolean;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  olderError: string | null;
  messagesError: string | null;
  status: string;
  live: LiveStatus;
  /** Whether the connected backend identified itself as `web/mock/server.ts`
   *  (its `backend_info` sentinel). False until proven otherwise — including
   *  while disconnected — so nothing ever treats the real backend as the mock.
   *  Surfaced by the dev-only badge in the status bar. */
  backendIsMock: boolean;
  /** The backend's view of the identity broker, from its `broker_status` event, or
   *  null until it says something. Null must stay silent: the mock and any older
   *  backend never emit it, and a banner that appears by default would be worse than
   *  the empty sidebar it replaces. Disjoint from `fatal`: that one means the socket
   *  is gone, this one means the socket works and the credentials do not. */
  brokerStatus: BrokerStatus | null;
  ready: boolean;
  splashMessage: string;
  fatal: string | null;
  update: UpdateInfo | null;
  /** How far the update has got (the backend's `update_progress` event), or null while
   *  nothing has been asked of it. Held apart from `update` because they answer two
   *  different questions and arrive at two different times — and because the backend
   *  replays this one on every connection, so it is what a page opened mid-download
   *  draws its bar from. See {@link updateView}. */
  updateProgress: UpdateProgress | null;
  draft: string;
  /** Why the last send in the OPEN conversation did not leave, in one sentence for the
   *  person who pressed the button (see {@link sendFailureMessage}), or null while
   *  nothing has failed.
   *
   *  It is drawn in the composer, above the field, because that is where the user is
   *  looking. It used to be reported by the status line alone — eleven truncated pixels
   *  at the foot of the sidebar, which is not on screen at all on a phone — so a refused
   *  send read as a button that chimed and did nothing. */
  sendError: string | null;
  replyingTo: PendingReply | null;
  /** The notifications panel's three activity streams (newest-first each), one
   *  per tab: Activity, Mentions, Following. */
  notifications: Record<NotificationTab, Notification[]>;
  /** Count the bell badges: unread in the Activity stream, cleared locally when
   *  the panel is seen. Activity is the superset (a mention also appears there),
   *  so it is the single source for the badge — Mentions/Following never
   *  double-count it. */
  notificationsUnread: number;
  /** A pending request to scroll the open conversation to a specific message
   *  (set when a notification is opened). The pane consumes it, paging older if
   *  needed, then clears it. `nonce` lets the same target retrigger. */
  pendingScroll: { convId: string; messageId: string; nonce: number } | null;
  /** Bumped whenever the user sends something, asking the pane to jump to the
   *  newest message. Sending while reading further up would otherwise drop the
   *  message off-screen — you'd have no idea it went out. The jump also puts the
   *  view at the bottom, so the send's own echo then follows naturally. */
  scrollToBottomNonce: number;
  /** People currently typing, per conversation id (a key is present only while
   *  someone is typing there). Drives both the message-pane hint and the sidebar
   *  row preview. Keyed by MRI under the hood so repeats coalesce; each entry
   *  auto-expires. */
  typingByConversation: Record<string, TypingName[]>;
  /** Calls currently ringing, one per conversation (a `started` call the backend
   *  surfaced; cleared by its `ended`/`missed`, a manual dismiss, or a safety
   *  timeout). AWARENESS only — teams-lite has no media stack, so the banner these
   *  drive can point the user at the chat but never answer or place a call. */
  incomingCalls: IncomingCall[];
  /** What this machine can do about audio calls, and the one call it is in (see
   *  lib/call.ts). Both flags are false until the backend answers `call_status`: a
   *  hopeful `enabled` would tell the user their calls ring here while nothing is
   *  registered. */
  callStatus: CallStatus;
  /** Why the last call attempt failed, in words for the user — a refused microphone,
   *  a conversation that cannot be called. Cleared when the next one starts. */
  callError: string | null;
  /** Why the last call ended, when it is worth saying — a call the user did not end
   *  themselves. Its own field rather than a read of the ended call, because the call is
   *  dropped the moment that frame is delivered: the backend hands out ONE frame with the
   *  ending in it and then frees the slot. Cleared on its own after a few seconds. */
  callNotice: string | null;
  /** Read receipts ("seen by") for the OPEN conversation: every other member's
   *  read position, used to anchor their avatar to the last message they read.
   *  Refreshed on open and kept live by the `read_receipt` event. Empty for the
   *  no-open / channel / receipts-disabled cases. */
  readReceipts: ReadReceipt[];
  /** The people the OPEN conversation's composer can @mention, most relevant first.
   *  Empty until the user types the first "@" there: the list costs a roster read and a
   *  directory lookup, so it is fetched on demand and then cached per conversation (see
   *  `ensureMentionCandidates`). */
  mentionCandidates: MentionCandidate[];
  /** User appearance preference (System follows the OS). */
  appearance: Appearance;
  /** Concrete theme currently applied to <html> (what CSS keys off). */
  resolvedTheme: ResolvedTheme;
  /** Whether curated interaction sounds play (client-only preference). Gates the
   *  cuelume engine globally — imperative cues and `data-cuelume-*` alike. */
  soundsEnabled: boolean;
  /** Non-secret app settings (the GitLab host + whether each integration's token
   *  is stored + Ghost mode), loaded from the backend on start. Drives which links
   *  get rich previews, and whether reading a chat is declared to Teams. */
  settings: AppSettings;
  /** Push notifications for THIS device: what the browser supports, what stands in
   *  the way, and which devices the backend notifies. The only path that reaches a
   *  phone whose app is closed — see lib/push.ts. */
  push: PushState;
  /** What the local agent can do on the backend's machine, and which conversations
   *  are opted in — null until the backend answers. See lib/agent.ts. */
  agent: AgentStatus | null;
  /** The agent run in flight (or the one that just finished) per conversation id, from
   *  the backend's `agent_stream` event. A transient overlay on the message the run is
   *  writing into — the Teams message stays the record. See lib/agent-run.ts. */
  agentRuns: Record<string, AgentRun>;

  // ---- mail (read-only Outlook surface) ------------------------------------

  /** The mailbox's folders, in sidebar order. Empty until the Mail tab is first
   *  opened — mail is loaded lazily, so a user who never opens it pays nothing. */
  mailFolders: MailFolder[];
  /** The selected folder's id, or null before one is chosen (the inbox is selected
   *  automatically once folders load). */
  mailFolderId: string | null;
  /** The selected folder's mail, newest first. */
  mailMessages: MailHeader[];
  mailLoading: boolean;
  mailLoadingOlder: boolean;
  mailHasMoreOlder: boolean;
  /** Why the mail list could not be loaded, or null. Mail failing must never break
   *  the chat surfaces, so this is scoped to the mail pane. */
  mailError: string | null;
  /** The open mail's id (mirrors the `/m/<id>` route), or null. */
  openMailId: string | null;
  /** The open mail's header. Held separately from the list so a deep link to a mail
   *  that is not in the loaded page still renders its metadata. */
  openMail: MailHeader | null;
  /** The open mail's rendered body, or null while it loads. */
  mailBody: MailBody | null;
  mailBodyLoading: boolean;
  mailBodyError: string | null;

  // ---- calendar (read-only Teams/Outlook surface) ---------------------------

  /** The mailbox's calendars, default first. Empty until the Calendar tab is first
   *  opened — like mail, the calendar is loaded lazily. */
  calendars: CalendarInfo[];
  /** Which calendars are drawn. Persisted locally, and seeded with the default
   *  calendar alone: a mailbox here carries six (birthdays, holidays, a shared
   *  team one…), and syncing all of them on first paint would cost six round-trips
   *  to show what the user came for. */
  visibleCalendarIds: string[];
  /** Which view the calendar shows. */
  calendarMode: CalendarViewMode;
  /** How the views are drawn, from the view menu. Persisted locally: these are
   *  preferences about this screen, not anything the mailbox knows about. */
  calendarSettings: CalendarSettings;
  /** The date the view is centred on, as epoch milliseconds (a `Date` in reactive
   *  state would re-render on every identity change even when the day is the same). */
  calendarAnchorMs: number;
  /** Every event held for the window on screen (and whatever else is still cached
   *  from a window visited earlier), earliest first. */
  calendarEvents: CalendarEvent[];
  calendarLoading: boolean;
  /** Why the calendar could not be loaded, or null. Scoped to the calendar pane:
   *  the calendar failing must never break the chat surfaces. */
  calendarError: string | null;
  /** The event whose details panel is open, or null. */
  openEventId: string | null;
};

const DRAFT_SAVE_DELAY_MS = 150;
// How long a "typing" signal lives without a refresh before we assume the person
// stopped. Teams re-sends `Control/Typing` every few seconds while someone keeps
// typing, so this is a safety net for a missed `Control/ClearTyping`.
const TYPING_TIMEOUT_MS = 8000;
// How long a ringing-call banner survives without an explicit `ended`/`missed`
// before we drop it on our own. A safety net only: the backend normally sends a
// terminal call event, but a missed close (or a client that reconnected mid-call)
// must not leave a banner ringing forever. Comfortably past Teams' own ring window.
const CALL_RING_TIMEOUT_MS = 45_000;

/** How long the line about a call that ended stays on screen. Long enough to read a
 *  sentence, short enough that nobody has to dismiss it. */
const CALL_NOTICE_MS = 6_000;

/** How long a fetched presence is trusted before the next person card refetches
 *  it. Short enough that a colleague who just joined a meeting reads as busy on
 *  the next hover, long enough that re-hovering the same name (or several
 *  mentions of the same person in one thread) costs a single round-trip. */
const PRESENCE_TTL_MS = 30_000;

/** How long an address lookup waits for company before it goes out. One frame: long
 *  enough for a whole mail row, header card or virtualized page to join the same
 *  request, short enough that no face waits visibly for its batch. */
const ADDRESS_BATCH_MS = 16;

/** How many addresses one lookup may carry — the backend's own batch limit
 *  (`teams_profiles::MAX_BATCH`). The surplus goes out in the next batch. */
const ADDRESS_BATCH_MAX = 100;

// Where local channel-pin overrides are persisted (client-only). The key is new: the
// map it replaces held the misread `is_favorite` flag (Teams' Show/Hide switch, see
// `channelIsShown`), so an old entry would pin channels the user never pinned.
const CHANNEL_PINS_KEY = "teams-lite:channel-pins";
// And which sidebar team sections the user has collapsed. Client-only, and that is a
// choice rather than a limit: CSA does report a team's own fold state (`isCollapsed`,
// false on all 12 teams here — see examples/team_order_recon.rs), so wiring it is
// possible. Folding a team is a per-screen decision, and a 320px column is not the
// window their desktop client has.
// The key keeps its old name so a fold the user already made survives: it now holds
// the chat-list groups as well, which is why the state it feeds is `collapsedSections`.
const COLLAPSED_SECTIONS_KEY = "teams-lite:collapsed-teams";
// Where the local chat pin and hide are persisted (client-only, like the channel
// pins). Two maps rather than one blob, so a malformed value can only ever cost the
// one setting it belongs to. The MUTE has no key here: it is published to Teams and
// read back from it, so the conversation row is its only home.
const CHAT_PINS_KEY = "teams-lite:chat-pins";
const CHAT_HIDES_KEY = "teams-lite:chat-hides";
// How many conversations keep a cached message page at all. Re-opening one of
// these is instant; beyond that the least-recently-opened page is dropped, so a
// long session spent hopping between dozens of chats doesn't accumulate their
// whole backlogs. The open conversation is never evicted.
const RETAINED_CONVERSATIONS = 8;
// Ceiling on the decoded image/file bytes held as blob object URLs. Proxied media
// is cached so re-mounts and re-opens are instant, but scrolling back through a
// long thread can pull in hundreds of pictures — past this budget the
// least-recently-used blob that nothing is displaying is revoked and dropped (a
// later render simply re-fetches it).
const MEDIA_CACHE_BYTES = 48 * 1024 * 1024;
// How many rendered mail bodies stay in the session cache. A body is up to ~135 KB
// of sanitized HTML (plus any embedded inline images), so reading through an inbox
// would otherwise accumulate megabytes of markup. The backend caches every body
// durably in SQLite, so re-opening an evicted mail is a local round-trip.
const RETAINED_MAIL_BODIES = 12;
// Where the locally-chosen visible calendars are persisted (client-only, like the
// channel-pin overrides).
const VISIBLE_CALENDARS_KEY = "teams-lite:visible-calendars";
// And the view menu's display preferences.
const CALENDAR_SETTINGS_KEY = "teams-lite:calendar-settings";

/**
 * The calendar's display preferences — the three toggles the view menu offers.
 *
 * Each one changes what is DRAWN, never what is fetched: hiding weekends or declined
 * invitations must not make the app read a different window, or stepping through
 * months would re-sync every time a toggle moved.
 */
export type CalendarSettings = {
  /** Draw Saturday and Sunday. Off gives the five-column working week. */
  showWeekends: boolean;
  /** Draw invitations the user declined (and meetings the organizer cancelled),
   *  struck through. Off hides them everywhere. */
  showDeclined: boolean;
  /** Show ISO week numbers down the left of the month grid and the mini month. */
  showWeekNumbers: boolean;
};

const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  // Off by default: this is a work calendar, so the five-column working week is what
  // the user came to look at, and two empty columns cost a third of the grid's width.
  showWeekends: false,
  // Off by default too: a meeting the user declined is not on their day. Turning it on
  // draws it struck through, which is what explains a quiet hour when they want that.
  showDeclined: false,
  showWeekNumbers: false,
};

function initialState(): AppState {
  return {
    conversations: [],
    channels: [],
    sidebarTab: "chats",
    channelPins: {},
    // A fresh set of maps per store, not the shared `NO_CHAT_PREFS` constant: two
    // controllers (a test spawns several) must never share one object.
    chatPrefs: { pins: {}, hides: {} },
    collapsedSections: {},
    openId: null,
    messages: [],
    loadingMessages: false,
    loadingOlder: false,
    hasMoreOlder: false,
    olderError: null,
    messagesError: null,
    status: "connecting…",
    live: "connecting",
    backendIsMock: false,
    brokerStatus: null,
    ready: false,
    splashMessage: "connecting",
    fatal: null,
    update: null,
    updateProgress: null,
    draft: "",
    sendError: null,
    replyingTo: null,
    notifications: { activity: [], mentions: [], following: [] },
    notificationsUnread: 0,
    pendingScroll: null,
    scrollToBottomNonce: 0,
    typingByConversation: {},
    incomingCalls: [],
    callStatus: UNKNOWN_CALL_STATUS,
    callError: null,
    callNotice: null,
    readReceipts: [],
    mentionCandidates: [],
    appearance: DEFAULT_APPEARANCE,
    resolvedTheme: "light",
    soundsEnabled: DEFAULT_SOUNDS_ENABLED,
    settings: {
      gitlab_host: "gitlab.com",
      gitlab_token_set: false,
      linear_token_set: false,
      ghost_mode: false,
      always_available: false,
      // On, like the backend's own default (see `sender_icons_enabled`): the switch
      // must not read "off" for the moment before the settings land, or the user would
      // be told no icon is fetched while one is.
      sender_icons: true,
    },
    push: INITIAL_PUSH_STATE,
    agent: null,
    agentRuns: {},
    mailFolders: [],
    mailFolderId: null,
    mailMessages: [],
    mailLoading: false,
    mailLoadingOlder: false,
    mailHasMoreOlder: false,
    mailError: null,
    openMailId: null,
    openMail: null,
    mailBody: null,
    mailBodyLoading: false,
    mailBodyError: null,
    calendars: [],
    visibleCalendarIds: [],
    // The working week, which is the question a work calendar answers: what is on my
    // plate now. The month grid is one keystroke away (M) for the wider look.
    calendarMode: "week",
    calendarSettings: DEFAULT_CALENDAR_SETTINGS,
    // Midnight today: the anchor is a DAY, and carrying a wall-clock time in it
    // would make "is this the anchor's month" depend on when the app was opened.
    calendarAnchorMs: startOfDay(new Date()).getTime(),
    calendarEvents: [],
    calendarLoading: false,
    calendarError: null,
    openEventId: null,
  };
}

export class TeamsController {
  readonly store = new Store<AppState>(initialState());
  private backend: Backend;
  private started = false;
  private disposers: Array<() => void> = [];

  // Per-conversation message cache: re-opening a conversation is instant and
  // stays current as live/refresh events reconcile into it. Bounded on both axes
  // (see `cacheMessages` / `trimCachedHistory`): at most RETAINED_CONVERSATIONS
  // pages, each at most RETAINED_MESSAGES long once the user has moved on.
  // Insertion order doubles as the LRU order — `cacheMessages` re-inserts.
  private messageCache = new Map<string, MessagePage>();
  // Warm draft cache keyed by conversation (SQLite remains the durable source).
  private draftCache = new Map<string, string>();
  private draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Live typing presence per conversation: convId -> (senderMri -> {name, timer}).
  // Non-reactive; the reactive `typing` slice is derived for the open conversation
  // whenever this changes. Each entry self-expires via its timer.
  private typingByConv = new Map<
    string,
    Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>
  >();

  // Safety-timeout handles for ringing calls: convId -> timer. Non-reactive; the
  // reactive list is `incomingCalls`. Each timer drops a stuck banner if no
  // terminal `call` event ever arrives (see CALL_RING_TIMEOUT_MS).
  private callTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // The same idea for agent runs: convId -> timer, dropping a run whose backend never
  // sent its terminal frame (it was killed, or the socket dropped mid-answer). Without
  // it a bubble would claim to be writing forever, since only a frame re-renders it.
  private agentRunTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Read receipts per conversation: convId -> (memberMri -> read position).
  // Non-reactive; the reactive `readReceipts` slice is derived for the open
  // conversation whenever this changes. Seeded by the `read_receipts` fetch on
  // open and updated in place by live `read_receipt` events.
  private receiptsByConv = new Map<string, Map<string, ReadReceipt>>();

  // Mention candidates per conversation: convId -> the people it can @mention.
  // Non-reactive; the reactive `mentionCandidates` slice is the open conversation's.
  // A conversation is fetched once per session (`mentionLoads` holds the in-flight
  // request, so a burst of keystrokes cannot fan out into several roster reads).
  private mentionsByConv = new Map<string, MentionCandidate[]>();
  private mentionLoads = new Map<string, Promise<void>>();

  // Media proxy cache: hosted-content URL -> a promise of a blob object URL.
  // Deduplicates concurrent loads of the same image and makes re-mounts/re-opens
  // instant. Insertion order is the LRU order (`loadMedia` re-inserts on a hit)
  // and the resolved blobs are held to MEDIA_CACHE_BYTES; everything still alive
  // is revoked on dispose.
  private mediaCache = new Map<string, Promise<string>>();
  // Resolved blobs, for the byte budget: URL -> its object URL + decoded size.
  private mediaBlobs = new Map<string, { objectUrl: string; bytes: number }>();
  // How many mounted views are currently displaying each URL. A blob that is on
  // screen is never revoked out from under it (that would break the picture);
  // only idle entries are evicted. See `retainMedia` / `releaseMedia`.
  private mediaRetained = new Map<string, number>();
  private mediaBytes = 0;

  // Avatar cache: "user:<mri>" / "team:<groupId>" / "picture:<url>" (a group
  // chat's own picture) -> a promise of a blob object URL, or null when the
  // subject has NO photo. The null is a deliberate negative cache — it is kept so
  // a subject without a photo is asked for only once — whereas a transient failure
  // is evicted so a later render can retry (mirrors the media cache). Object URLs
  // are revoked on dispose.
  private avatarCache = new Map<string, Promise<string | null>>();
  private avatarObjectUrls: string[] = [];

  // Link-enrichment cache: URL -> a promise of its metadata (or null when no
  // integration recognizes it). Deduplicates concurrent/repeat lookups of the same
  // link across message re-renders and scrolling. A failed (transient) lookup is
  // evicted so a later render can retry, matching the media cache.
  private linkCache = new Map<string, Promise<LinkMetadata | null>>();

  // The same answers, already resolved, for the readers that cannot await one.
  //
  // A promise — even an already-settled one — only hands its value back a microtask
  // later, which is one React render too late: the message bubble renders once
  // without the card, the VIRTUALIZED history measures that row at its short
  // height, and the card then arrives and grows it. Scrolling past a thread of
  // tracker links did that on every single pass. So a link this session has already
  // resolved is answered synchronously here, and the row is measured at its real
  // height the first time. Cleared wherever `linkCache` is: the two are one cache
  // with two shapes, never two caches.
  private linkResolved = new Map<string, LinkMetadata | null>();

  // Person-card caches, both keyed by MRI. A directory card barely changes, so it
  // is cached for the whole session (a "not found" too — asking again would answer
  // the same). Presence is the opposite: it is only trusted for PRESENCE_TTL_MS,
  // after which the next card open refetches it, so a hovered name never shows a
  // stale "Available". Transient failures are evicted from both so a later hover
  // retries.
  private profileCache = new Map<string, Promise<PersonProfile | null>>();
  private presenceCache = new Map<string, { at: number; value: Promise<PersonPresence | null> }>();

  // Mail-address -> person cache, keyed by the LOWERCASED address, and the batch
  // that fills it. A mail names its people by address while a photo is addressed by
  // MRI, so this is the lookup between the two (see `loadAddressPerson`). One screen
  // of mail asks for dozens of addresses at once, so a request is never sent per
  // address: askers queue for a few milliseconds and leave with one batched answer.
  // A "nobody" is cached like a found person — the directory will answer the same
  // next time — while a failed batch is evicted so a later render retries.
  private addressPeopleCache = new Map<string, Promise<AddressPerson | null>>();
  private addressQueue = new Map<string, (person: AddressPerson | null) => void>();
  private addressBatchTimer: ReturnType<typeof setTimeout> | null = null;

  // What the USER decided to call people, and who they gave a face to, keyed by MRI.
  // Not a source of truth for any rendered name — the backend already resolves those
  // (see `person_overrides` in src/store.rs) — but the surface that OFFERS a rename
  // has to know the current state to show it, and re-asking on every card open would
  // put a round trip in front of a hover. Dropped per person when one changes.
  private overrideCache = new Map<string, Promise<PersonOverride | null>>();

  // Surfaces that LIST the overrides rather than read one, so they can re-read when
  // any of them changes. A set rather than a state slice: the list is not part of what
  // the app renders on every frame, and only Settings asks for it.
  private overrideListeners = new Set<() => void>();

  // Live OS dark-mode query, watched only while appearance === "system".
  private darkQuery: MediaQueryList | null = null;
  private darkListener: ((e: MediaQueryListEvent) => void) | null = null;

  private refreshConversations = coalesce(() => this.loadConversations());
  private refreshChannels = coalesce(() => this.loadChannels());
  private refreshNotifications = coalesce(() => this.loadNotifications());

  // Whether the connection has dropped since the last successful reconcile. Set
  // when either the live feed (trouter) or the backend socket reports a drop,
  // and consulted when we reconnect: a genuine recovery re-syncs, but the very
  // first connect (no prior drop) does not. See `handleLiveRecovery`.
  private connectionDropped = false;

  constructor(url: string = defaultWsUrl()) {
    this.backend = new Backend(url);
  }

  private set(patch: Partial<AppState>): void {
    this.store.setState((s) => ({ ...s, ...patch }));
  }
  private get(): AppState {
    return this.store.state;
  }

  // ---- message cache (bounded) ---------------------------------------------

  /** Store a conversation's page, marking it most-recently-used, then drop the
   *  least-recently-used pages beyond RETAINED_CONVERSATIONS. The open
   *  conversation is never evicted — its page backs what is on screen. */
  private cacheMessages(id: string, page: MessagePage): void {
    this.messageCache.delete(id); // re-insert so Map order stays the LRU order
    this.messageCache.set(id, page);
    if (this.messageCache.size <= RETAINED_CONVERSATIONS) return;
    const openId = this.get().openId;
    for (const key of this.messageCache.keys()) {
      if (this.messageCache.size <= RETAINED_CONVERSATIONS) break;
      if (key === openId) continue;
      this.messageCache.delete(key);
    }
  }

  /** Cut a conversation we are leaving back to the newest RETAINED_MESSAGES, so
   *  the pages someone scrolled far back through aren't held for the whole
   *  session. Keeps its LRU position (this is not a fresh use). */
  private trimCachedHistory(id: string): void {
    const cached = this.messageCache.get(id);
    if (!cached) return;
    const trimmed = trimHistoryPage(cached);
    if (trimmed !== cached) this.messageCache.set(id, trimmed);
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.applyPersistedAppearance();
    this.applyPersistedSounds();
    this.applyPersistedChannelPins();
    this.applyPersistedChatPrefs();
    this.applyPersistedCollapsedSections();
    this.applyPersistedVisibleCalendars();
    this.applyPersistedCalendarSettings();
    this.wireEvents();
    this.watchWakeups();

    // Pick up the backend's write token from our own server before connecting, so
    // the first send of the session already carries it. Reads never need it; a
    // failure here just leaves this client read-only (see loadWriteToken).
    //
    // The client keeps the way back to it, because a backend that restarts mints a new
    // one and a page cannot see that happen: reads keep answering, and every write comes
    // back refused until something re-reads the file. This is what lets the refusal
    // itself heal it (see `retryWithAFreshToken` in lib/ws-client.ts).
    this.backend.setWriteTokenSource(() => this.loadWriteToken());
    await this.loadWriteToken();

    try {
      this.set({ splashMessage: "connecting" });
      await this.backend.connect();
      this.set({ live: "connected" });
      // Chats and channels come from the same backend and share a background CSA
      // sync; load both before revealing the UI so switching tabs is instant.
      await Promise.all([this.refreshConversations(), this.refreshChannels()]);
      this.set({ ready: true });
      // The activity feed is best-effort and must never block startup.
      void this.refreshNotifications();
      // App settings (the GitLab host, and which integration tokens are stored)
      // are best-effort too — a failure just leaves the defaults, which enrich
      // nothing but public gitlab.com links.
      void this.loadSettings();
      // Which conversations answer an `@claude` message, and whether this machine
      // holds an agent CLI at all. Best-effort: a failure leaves the menu saying the
      // backend has not answered, never a switch that pretends to work.
      void this.loadAgentStatus();
      // Whether this machine takes calls, and whether it is in one. Best-effort for
      // the same reason: an unanswered status reads as "off", which is what the
      // backend defaults to.
      void this.refreshCallStatus();
      // Where this device stands on push notifications, and a re-registration if it
      // is already subscribed (a browser may have rotated the subscription while the
      // app was closed — see syncPush).
      void this.syncPush();
    } catch (e) {
      const msg = errText(e);
      this.set({
        status: `backend unreachable — ${msg}`,
        splashMessage: `failed: ${msg}`,
        live: "disconnected",
      });
      // Reveal the (empty) UI anyway after a beat so the error is visible.
      setTimeout(() => this.set({ ready: true }), 2500);
    }
    // Best-effort: ask for notification permission after connect (a user
    // gesture may be required; the browser handles that).
    void ensureNotificationPermission();
  }

  /**
   * Fetch the backend's write-lock token from the server that served this app
   * (`/__write-token`, see `web/write-token.ts`) and hand it to the client.
   *
   * The backend refuses `send`/`edit`/`react` without it: reading is open to any
   * local client, writing posts to real people as the user. Only the app's own
   * server can read the token file, so this hop is how the browser gets it. When
   * there is none — the mock backend, or a server that cannot read the file — we
   * stay read-only and let the backend's own refusal surface if a send is tried.
   *
   * Called three times over a session's life, for three different reasons: once at
   * startup, again on every reconnect (a restarted backend minted a new one), and once
   * more by the client itself when a write is REFUSED — which is the only proof that
   * what this page holds went stale without the socket ever dropping. Returns the token
   * so that third caller can tell a fresh one from the value it just presented (see
   * `retryWithAFreshToken` in lib/ws-client.ts).
   */
  private async loadWriteToken(): Promise<string | null> {
    if (typeof window === "undefined") return null; // SSR: no writes happen there
    try {
      const res = await fetch("/__write-token", { cache: "no-store" });
      if (!res.ok) return null;
      const body = (await res.json()) as { token?: string };
      if (!body.token) return null;
      this.backend.setWriteToken(body.token);
      return body.token;
    } catch {
      /* offline or no endpoint: leave the client read-only */
      return null;
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.detachDarkQuery();
    for (const t of this.draftSaveTimers.values()) clearTimeout(t);
    this.draftSaveTimers.clear();
    for (const byMri of this.typingByConv.values()) {
      for (const entry of byMri.values()) clearTimeout(entry.timer);
    }
    this.typingByConv.clear();
    for (const t of this.callTimers.values()) clearTimeout(t);
    this.callTimers.clear();
    for (const t of this.agentRunTimers.values()) clearTimeout(t);
    this.agentRunTimers.clear();
    this.receiptsByConv.clear();
    for (const blob of this.mediaBlobs.values()) URL.revokeObjectURL(blob.objectUrl);
    this.mediaBlobs.clear();
    this.mediaRetained.clear();
    this.mediaBytes = 0;
    this.mediaCache.clear();
    for (const url of this.avatarObjectUrls) URL.revokeObjectURL(url);
    this.avatarObjectUrls = [];
    this.avatarCache.clear();
    this.linkCache.clear();
    this.linkResolved.clear();
    this.profileCache.clear();
    this.presenceCache.clear();
    if (this.addressBatchTimer) clearTimeout(this.addressBatchTimer);
    this.addressBatchTimer = null;
    for (const resolve of this.addressQueue.values()) resolve(null);
    this.addressQueue.clear();
    this.addressPeopleCache.clear();
    this.mailPageCache.clear();
    this.mailBodyCache.clear();
    this.backend.close();
    this.started = false;
  }

  /**
   * Reconnect the moment this tab is in use again.
   *
   * A phone freezes a backgrounded tab: the socket dies when the OS suspends it
   * and no retry timer runs, so the reconnect backoff wakes up already past its
   * give-up deadline and reports the backend lost to someone who only switched
   * apps for a minute (see `retryNow` in ws-client.ts). Becoming visible again —
   * and regaining the network — are the two moments worth an immediate attempt.
   */
  private watchWakeups(): void {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      this.backend.retryNow();
      // Messages that arrived while the tab was hidden were deliberately NOT marked
      // read (see the `message` handler). Coming back to a thread on screen reads it.
      const openId = this.get().openId;
      if (openId) this.markThreadRead(openId);
    };
    const onOnline = () => this.backend.retryNow();
    // A third wake-up, specific to iOS Safari: a page restored from the back/forward
    // cache fires `pageshow` with `persisted: true` and does NOT always fire
    // `visibilitychange`. Without this, coming back to the app with the back gesture
    // can leave the socket closed until the user switches tabs and returns.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) this.backend.retryNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    this.disposers.push(() => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    });
  }

  private wireEvents(): void {
    const on = (event: string, handler: (data: unknown) => void) => {
      this.disposers.push(this.backend.on(event, handler));
    };

    on("message", (raw) => {
      const m = raw as ChatMessage;
      const cached = this.messageCache.get(m.conversation_id);
      this.cacheMessages(m.conversation_id, appendLiveMessage(cached, m));
      // A message from a sender means they stopped typing — clear their hint.
      if (m.sender_mri) {
        this.clearTyping(m.conversation_id, m.sender_mri);
        this.publishTyping(m.conversation_id);
      }
      if (m.conversation_id === this.get().openId) {
        this.set({
          messages: this.messageCache.get(m.conversation_id)!.messages,
        });
        // A message that arrives in the thread on screen is read as it lands — but
        // only if the user is actually looking: a background tab reads nothing, and
        // claiming otherwise would tell the sender the user saw a message they did not.
        if (document.visibilityState === "visible") this.markThreadRead(m.conversation_id);
      } else if (shouldNotify(m, this.get().openId, this.threadIsMuted(m.conversation_id))) {
        // The message's own text, read the way its type says it must be (a `Text`
        // body is plain, not HTML) — so a notification never eats what it quotes.
        notifyMessage(m.sender, copyableMessageText(m));
        // Subtle inbound cue, riding the same gate as the desktop notification —
        // so the conversation you're looking at never chimes at you.
        playCue("droplet");
      }
      // Refresh the list the message belongs to so its preview/order updates
      // immediately. A channel post bumps the Channels tab, never the chat list;
      // an unknown id (a chat, or a channel not yet synced) refreshes chats, and
      // a brand-new channel is picked up by the backend's `channels_changed`.
      if (this.get().channels.some((c) => c.id === m.conversation_id)) {
        void this.refreshChannels();
      } else {
        void this.refreshConversations();
      }
    });

    // Backend identity. `web/mock/server.ts` announces itself on every fresh
    // connection; the real Rust backend never does. So a missing sentinel means
    // LIVE — the safe reading, since the risk we are guarding against is
    // mistaking the real account for the mock, never the reverse. Drives the
    // dev-only MOCK/LIVE badge and the assertion automation makes before typing.
    on("backend_info", (raw) => {
      const info = raw as { mock?: boolean } | null;
      this.set({ backendIsMock: info?.mock === true });
    });

    on("typing", (raw) => this.onTyping(raw as TypingSignal));

    on("call", (raw) => this.onCall(raw as CallSignal));

    // The real calling plane: the one call this machine is in, and the far side's SDP.
    // `call_state` is the whole state every time, so a page that reconnects mid-call
    // learns exactly what a live one knows — and it is the frame that releases the
    // microphone when the call is over.
    on("call_state", (raw) => this.onCallState(raw as CallStatus));
    on("call_media", (raw) => void this.onCallMedia(raw as CallMediaSignal));

    // The RAW calling frames, logged verbatim while the wire schema is still young
    // (NATIVE-CALLING.md § 8). A capture aid beside `call_state`, which is what the app
    // actually acts on: nothing here places, answers or ends a call.
    on("call_signal", (raw) => {
      const f = raw as CallSignalFrame;
      console.info("[call_signal]", f.url, f.call_id, f.body);
    });

    on("read_receipt", (raw) => this.onReadReceipt(raw as ReadReceiptSignal));

    on("agent_stream", (raw) => this.onAgentFrame(raw));

    on("messages_updated", (raw) => {
      const d = raw as { conversation: string; messages: ChatMessage[]; has_more: boolean };
      const history = mergeRefreshedHistoryPage(this.messageCache.get(d.conversation), d);
      this.cacheMessages(d.conversation, history);
      if (d.conversation === this.get().openId) {
        this.set({
          messages: history.messages,
          hasMoreOlder: history.has_more,
          messagesError: null,
          loadingMessages: false,
        });
        // The refresh may have brought messages newer than the position we declared
        // when the thread opened; read up to the new newest one.
        if (document.visibilityState === "visible") this.markThreadRead(d.conversation);
      }
    });

    on("messages_error", (raw) => {
      const d = raw as { conversation: string; error: string };
      if (d.conversation === this.get().openId) {
        this.set({ messagesError: d.error || "Couldn't load messages", loadingMessages: false });
      }
    });

    // The user renamed somebody, or gave them a face — here, or in the other backend
    // sharing this store. Drop what we hold about them and re-read: the name lives on
    // every message they ever sent, and the avatar cache never evicts on its own.
    on("person_override_changed", (raw) => {
      const mri = (raw as { mri?: string } | null)?.mri;
      if (mri) this.forgetPerson(mri);
    });

    on("conversations_changed", () => void this.refreshConversations());
    on("channels_changed", () => void this.refreshChannels());
    on("notifications_changed", () => void this.refreshNotifications());

    // Mail folder metadata moved (new mail, something read elsewhere): refresh the
    // list so the unread badge and counts follow — but only once mail has been
    // opened at least once, so a user who never looks at Mail is never made to load
    // it by a background event.
    on("mail_folders_changed", () => {
      if (this.get().mailFolders.length > 0) void this.refreshMailFolders();
    });

    // The backend reconciled a folder's newest window against the server. Fold it
    // into what we hold: new mail appears, mail read elsewhere updates, and mail
    // deleted elsewhere disappears — without truncating a list scrolled far back.
    on("mail_list_updated", (raw) => {
      const d = raw as MailPage & { folder: string };
      const merged = mergeRefreshedMailPage(this.mailPageCache.get(d.folder), {
        messages: d.messages ?? [],
        has_more: d.has_more ?? false,
      });
      this.mailPageCache.set(d.folder, merged);
      if (this.get().mailFolderId === d.folder) {
        this.set({
          mailMessages: merged.messages,
          mailHasMoreOlder: merged.has_more,
          mailError: null,
          mailLoading: false,
        });
      }
    });

    on("mail_list_error", (raw) => {
      const d = raw as { folder: string; error: string };
      if (this.get().mailFolderId === d.folder && this.get().mailMessages.length === 0) {
        this.set({ mailError: d.error || "Couldn't load mail", mailLoading: false });
      }
    });

    // A calendar's name, colour or order moved. Only refresh once the calendar has
    // been opened at least once, so a user who never looks at it is never made to
    // load it.
    on("calendars_changed", () => {
      if (this.get().calendars.length > 0) void this.refreshCalendars();
    });

    // The backend reconciled the window it is watching. Fold it in: a meeting moved
    // or cancelled in real Outlook appears (or disappears) here without a reload.
    // Guarded on the window still being one we care about — a late update for a
    // month the user has navigated away from is cached, not rendered over.
    on("calendar_view_updated", (raw) => {
      const view = raw as CalendarViewResult;
      if (!view || typeof view.start !== "string" || !Array.isArray(view.events)) return;
      this.set({
        calendarEvents: mergeCalendarWindow(this.get().calendarEvents, view),
        calendarError: null,
        calendarLoading: false,
      });
    });

    on("calendar_view_error", (raw) => {
      const d = raw as { error?: string };
      if (this.get().calendarEvents.length === 0) {
        this.set({ calendarError: d?.error || "Couldn\u2019t load the calendar", calendarLoading: false });
      }
    });
    on("realtime_status", (s) => {
      const status = s as LiveStatus;
      if (status === "disconnected") this.connectionDropped = true;
      this.set({ live: status });
      // The live feed came back after a drop — reconcile what we may have missed
      // while it was down (most importantly, a message deleted server-side).
      if (status === "connected" && this.connectionDropped) {
        this.connectionDropped = false;
        void this.handleLiveRecovery();
      }
    });
    // A newer build exists. The payload can be null in one place only — the mock
    // clearing an armed update between specs — and that clears the phase with it, so no
    // progress can outlive the release it belonged to.
    on("update_available", (u) => {
      const next = (u ?? null) as UpdateInfo | null;
      this.set(next ? { update: next } : { update: null, updateProgress: null });
    });
    // How far installing it has got. Sent on every whole percent of a download and on
    // each phase change, and replayed on connect — so this handler is also what a page
    // that opened in the middle of one learns from.
    on("update_progress", (p) => this.set({ updateProgress: p as UpdateProgress }));
    // How sign-in is doing. The backend sends this on a change of state and in the
    // greeting, so an outage that started before this tab opened still reaches it.
    on("broker_status", (raw) => {
      const next = raw as BrokerStatus | null;
      if (!next || typeof next.ok !== "boolean") return;
      this.set({ brokerStatus: next });
    });
    on("disconnected", () => {
      this.connectionDropped = true;
      this.set({ live: "disconnected" });
    });
    // The backend socket came back (the backend itself, unlike the live feed, may
    // not re-announce a `realtime_status` when only the browser↔backend link
    // blipped) — treat it as a recovery and reconcile the same way.
    on("reconnected", () => {
      // Clear the fatal overlay too: a socket that reopened proves the backend is
      // back, and `watchWakeups` retries long after the backoff gave up — so this
      // is the normal path out of "backend lost" for a phone returning to the tab.
      // A socket that came back invalidates the reason the last send failed — "the
      // backend is not reachable" under a green dot is a sentence the page can no longer
      // stand behind, and the token is re-read below. The words stay in the composer, so
      // the user retries rather than retypes.
      this.set({ live: "connected", fatal: null, status: "reconnected", sendError: null });
      // Refetch the write token. The backend mints a new one per PROCESS, so a
      // backend that restarted — a crash, an update, a `systemctl restart` of the
      // always-on service — invalidates the one this page fetched at startup. Reads
      // keep working, which is what makes it nasty: the tab looks healthy and every
      // send is refused until someone reloads the page. On a phone left open for
      // days that is the normal outcome of a restart, so recovery has to be here.
      void this.loadWriteToken();
      // Forget what we knew about an update, and let the backend that just answered say
      // it again. The socket coming back is precisely how a RESTART onto a new build ends
      // (see lib/update.ts): that backend is current, so it announces no update at all —
      // and without this the page would keep drawing "Restarting…" for ever over a build
      // that already restarted. A download in flight is re-stated in the same greeting,
      // because the backend replays the phase on every connection.
      this.set({ update: null, updateProgress: null });
      if (this.connectionDropped) {
        this.connectionDropped = false;
        void this.handleLiveRecovery();
      }
    });
    on("backend_lost", () =>
      this.set({
        live: "disconnected",
        fatal: "Backend lost — the teams-lite server is no longer reachable.",
        status: "backend lost — retries exhausted",
      }),
    );
  }

  // ---- typing presence -----------------------------------------------------

  /** Fold a live `typing` signal into per-conversation presence and refresh the
   *  open conversation's reactive slice. A `Control/Typing` (re)arms an expiry
   *  timer; a `Control/ClearTyping` removes the person immediately. */
  private onTyping(sig: TypingSignal): void {
    const convId = sig.conversation_id;
    const mri = sig.sender_mri;
    if (!convId || !mri) return;

    if (sig.is_typing) {
      let byMri = this.typingByConv.get(convId);
      if (!byMri) {
        byMri = new Map();
        this.typingByConv.set(convId, byMri);
      }
      const existing = byMri.get(mri);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => this.expireTyping(convId, mri), TYPING_TIMEOUT_MS);
      byMri.set(mri, { name: sig.sender || "Someone", timer });
    } else {
      this.clearTyping(convId, mri);
    }
    this.publishTyping(convId);
  }

  /** Remove one person's typing entry (they sent, stopped, or timed out). Pure:
   *  callers refresh reactive state so a batch of clears renders once. */
  private clearTyping(convId: string, mri: string): void {
    const byMri = this.typingByConv.get(convId);
    if (!byMri) return;
    const entry = byMri.get(mri);
    if (!entry) return;
    clearTimeout(entry.timer);
    byMri.delete(mri);
    if (byMri.size === 0) this.typingByConv.delete(convId);
  }

  private expireTyping(convId: string, mri: string): void {
    this.clearTyping(convId, mri);
    this.publishTyping(convId);
  }

  private typingNamesFor(convId: string): TypingName[] {
    const byMri = this.typingByConv.get(convId);
    if (!byMri) return [];
    return [...byMri.entries()].map(([mri, e]) => ({ mri, name: e.name }));
  }

  /** Publish a conversation's current typers into reactive state so the sidebar
   *  row (and, when open, the message pane) updates. Preserves the array
   *  references of other conversations so their rows don't re-render, and drops
   *  the key entirely when nobody is typing there. */
  private publishTyping(convId: string): void {
    const names = this.typingNamesFor(convId);
    const prev = this.get().typingByConversation;
    if (names.length === 0) {
      if (!(convId in prev)) return;
      const next = { ...prev };
      delete next[convId];
      this.set({ typingByConversation: next });
      return;
    }
    this.set({ typingByConversation: { ...prev, [convId]: names } });
  }

  // ---- incoming calls (awareness only) -------------------------------------
  //
  // teams-lite has no media stack: it cannot carry, answer, or place a call.
  // These handlers turn the backend's `call` event into a ring/dismiss banner so
  // the user KNOWS a call is happening and can jump to the chat (or answer in
  // real Teams). A `started` rings; `ended`/`missed` — or a manual dismiss, or a
  // safety timeout — clears it. The backend already suppresses calls we started
  // ourselves, so a `started` here is always someone else calling.

  /** Fold a live `call` signal into the ringing-banner list. */
  private onCall(sig: CallSignal): void {
    const convId = sig.conversation_id;
    if (!convId) return;
    if (sig.event === "started") {
      this.upsertIncomingCall({
        conversationId: convId,
        caller: sig.caller || "",
        callerMri: sig.caller_mri || "",
        participants: Array.isArray(sig.participants) ? sig.participants : [],
        participantMris: Array.isArray(sig.participant_mris) ? sig.participant_mris : [],
        participantCount: sig.participant_count ?? 0,
      });
    } else {
      // A call that ended or was missed is no longer ringing — drop its banner.
      this.clearIncomingCall(convId);
    }
  }

  /** Raise (or refresh) the ringing banner for a conversation and (re)arm its
   *  safety timeout. Also nudges the desktop when the conversation isn't already
   *  open in front of the user, mirroring message notifications. */
  private upsertIncomingCall(call: IncomingCall): void {
    const convId = call.conversationId;
    const existing = this.callTimers.get(convId);
    if (existing) clearTimeout(existing);
    this.callTimers.set(
      convId,
      setTimeout(() => this.expireIncomingCall(convId), CALL_RING_TIMEOUT_MS),
    );

    const prev = this.get().incomingCalls;
    const idx = prev.findIndex((c) => c.conversationId === convId);
    const next =
      idx === -1 ? [...prev, call] : prev.map((c) => (c.conversationId === convId ? call : c));
    this.set({ incomingCalls: next });

    if (convId !== this.get().openId) {
      notifyCall(call.caller, this.callGroupLabel(convId));
    }
  }

  /** Remove a conversation's ringing banner (it ended, was dismissed, or timed
   *  out) and cancel its safety timer. */
  private clearIncomingCall(convId: string): void {
    const timer = this.callTimers.get(convId);
    if (timer) {
      clearTimeout(timer);
      this.callTimers.delete(convId);
    }
    const prev = this.get().incomingCalls;
    if (!prev.some((c) => c.conversationId === convId)) return;
    this.set({ incomingCalls: prev.filter((c) => c.conversationId !== convId) });
  }

  private expireIncomingCall(convId: string): void {
    this.clearIncomingCall(convId);
  }

  /** Dismiss a ringing banner by hand (the user tapped "Dismiss"). Local only —
   *  it silences the banner here and never touches the call in real Teams. */
  dismissIncomingCall(convId: string): void {
    this.clearIncomingCall(convId);
  }

  // ---- audio calling -------------------------------------------------------
  //
  // The backend signals and this page carries the audio, so every action here is the
  // same three steps in a different order: ask the backend for what a peer connection
  // needs, negotiate locally, hand the SDP back. Nothing here decides whether a call
  // may happen — the backend holds the links and the consent (see lib/call.ts).

  /** The live call's media, while there is one. Deliberately NOT reactive state: it
   *  owns a peer connection and an audio element, and re-rendering must never replace
   *  it. Its observable half is `callStatus`. */
  private callMedia: CallMedia | null = null;

  /** Drops the "why the call ended" line after {@link CALL_NOTICE_MS}. */
  private callNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Fold one `call_state` frame in, and stop the microphone when the call is over.
   *
   *  This is the ONE place media is torn down, whichever side ended the call: our own
   *  hangup, the far side's, a dropped connection, calling being turned off. A path that
   *  released the microphone somewhere else would eventually miss a case and leave the
   *  browser's recording indicator on. */
  private onCallState(status: CallStatus): void {
    this.set({ callStatus: status });
    const call = status.call;
    if (!holdsMicrophone(call)) this.stopCallMedia();
    if (isLive(call)) {
      // A new call clears whatever the last one left on screen.
      this.showCallNotice(null);
      return;
    }
    // The ONE frame that says the call is over. Its reason is kept here because the
    // slot is freed immediately afterwards — reading it off `callStatus` later would
    // find nothing. An ending the user caused says nothing back at them.
    if (call?.phase === "ended") this.showCallNotice(callEndLabel(call) || null);
  }

  /** Show (or clear) the one line about a call that ended, and drop it on its own.
   *  A toast that stays is a toast the user has to dismiss. */
  private showCallNotice(text: string | null): void {
    if (this.callNoticeTimer) {
      clearTimeout(this.callNoticeTimer);
      this.callNoticeTimer = null;
    }
    this.set({ callNotice: text });
    if (!text) return;
    this.callNoticeTimer = setTimeout(() => {
      this.callNoticeTimer = null;
      this.set({ callNotice: null });
    }, CALL_NOTICE_MS);
  }

  /** The far side's SDP: the frame that turns a call that is ringing into audio. */
  private async onCallMedia(signal: CallMediaSignal): Promise<void> {
    const media = this.callMedia;
    if (!media || signal.kind !== "answer") return;
    try {
      await media.setRemoteAnswer(signal.sdp);
    } catch (error) {
      // A rejected answer means this call will never carry audio, so end it rather than
      // leaving a bar that says "connecting" for good.
      console.error("[call] the answer could not be applied", error);
      await this.hangUpCall();
    }
  }

  private stopCallMedia(): void {
    this.callMedia?.stop();
    this.callMedia = null;
  }

  /** Open the microphone and negotiate, using the mock's inert stand-in when the
   *  backend announced itself as the mock.
   *
   *  The mock has no media at all, so a page pointed at it would otherwise ask for a
   *  microphone in order to talk to nothing. Only `web/mock/server.ts` sends that
   *  sentinel, so this can never pick the stand-in against a real backend. */
  private async openCallMedia(options: {
    iceServers: RTCIceServer[];
    remoteOffer?: string;
  }): Promise<CallMedia> {
    if (this.get().backendIsMock) return simulatedCallMedia();
    return startCallMedia({
      iceServers: options.iceServers,
      remoteOffer: options.remoteOffer,
      onConnectionStateChange: (state) => {
        if (state === "failed") {
          console.error("[call] the media transport failed");
          void this.hangUpCall();
        }
      },
    });
  }

  /** Ask the backend what this machine can do about calls. Called on connect, and
   *  after the user flips the setting. */
  async refreshCallStatus(): Promise<void> {
    try {
      this.set({ callStatus: await this.backend.callStatus() });
    } catch {
      // An older backend has no `call_status`; the unknown state is the safe reading.
      this.set({ callStatus: UNKNOWN_CALL_STATUS });
    }
  }

  /** Turn calling on or off. The consent gate: ON registers this machine with Teams as
   *  a device the user's calls ring on. */
  async setCallingEnabled(enabled: boolean): Promise<void> {
    this.set({ callError: null });
    try {
      this.set({ callStatus: await this.backend.setCalling(enabled) });
    } catch (error) {
      this.set({ callError: errText(error) });
      await this.refreshCallStatus();
    }
  }

  /** Place a call in a one-to-one chat: reserve it, open the microphone, send the
   *  offer. Every step is the user's own click — nothing here starts on its own. */
  async startCall(conversationId: string): Promise<void> {
    if (isLive(this.get().callStatus.call)) return;
    this.set({ callError: null });
    this.showCallNotice(null);
    let callId: string | null = null;
    try {
      const prepared = await this.backend.callPrepare({ conversation: conversationId });
      callId = prepared.call_id;
      this.callMedia = await this.openCallMedia({ iceServers: prepared.ice_servers });
      await this.backend.callPlace(prepared.call_id, this.callMedia.localSdp);
    } catch (error) {
      this.set({ callError: callErrorText(error) });
      this.stopCallMedia();
      // The backend reserved the call before the failure, so release it: a machine that
      // thinks it is dialling refuses the next call.
      if (callId) await this.hangUpCall();
      await this.refreshCallStatus();
    }
  }

  /**
   * Join a meeting from the link its calendar event carries.
   *
   * The same three steps as placing a call, and the same gate: the backend reserves the
   * call and hands back what a peer connection needs, the page opens the microphone,
   * and the SDP goes back. Nothing is joined without this click — the calendar's join
   * link is never followed on the user's behalf.
   */
  async joinMeeting(joinUrl: string, subject?: string): Promise<void> {
    if (isLive(this.get().callStatus.call)) return;
    this.set({ callError: null });
    this.showCallNotice(null);
    let callId: string | null = null;
    try {
      const prepared = await this.backend.callPrepare({ joinUrl, subject });
      callId = prepared.call_id;
      this.callMedia = await this.openCallMedia({ iceServers: prepared.ice_servers });
      await this.backend.callJoin(prepared.call_id, joinUrl, this.callMedia.localSdp);
    } catch (error) {
      this.set({ callError: callErrorText(error) });
      this.stopCallMedia();
      if (callId) await this.hangUpCall();
      await this.refreshCallStatus();
    }
  }

  /** Answer the call that is ringing: take its offer, open the microphone, answer. */
  async answerCall(): Promise<void> {
    const call = this.get().callStatus.call;
    if (!call || !call.can_accept) return;
    this.set({ callError: null });
    this.showCallNotice(null);
    try {
      const prepared = await this.backend.callPrepare({ callId: call.id });
      if (!prepared.offer_sdp) throw new Error("that call carried nothing to answer");
      this.callMedia = await this.openCallMedia({
        iceServers: prepared.ice_servers,
        remoteOffer: prepared.offer_sdp,
      });
      await this.backend.callAccept(call.id, this.callMedia.localSdp);
    } catch (error) {
      this.set({ callError: callErrorText(error) });
      this.stopCallMedia();
      await this.hangUpCall();
    }
  }

  /** End the call, or decline it while it is still ringing. The microphone is released
   *  here as well as on the backend's own frame, because the user asked for it now. */
  async hangUpCall(): Promise<void> {
    const call = this.get().callStatus.call;
    this.stopCallMedia();
    if (!call) return;
    try {
      await this.backend.callHangup(call.id);
    } catch (error) {
      console.error("[call] the hangup failed", error);
    }
    await this.refreshCallStatus();
  }

  /** Mute or unmute. The microphone stops first and the service is told second, so the
   *  user is never live for the round trip. */
  async setCallMuted(muted: boolean): Promise<void> {
    const call = this.get().callStatus.call;
    if (!call) return;
    this.callMedia?.setMuted(muted);
    // Reflect it now: the button must follow the microphone, not the network.
    this.set({ callStatus: { ...this.get().callStatus, call: { ...call, muted } } });
    try {
      await this.backend.callMute(call.id, muted);
    } catch (error) {
      console.error("[call] the mute did not reach the service", error);
    }
  }

  // ---- the local agent's live run ------------------------------------------
  //
  // A run is an overlay on the message it is writing into, never a message of its own:
  // the backend has already posted that message and keeps editing it, so what arrives
  // here only changes how the app DRAWS a message it already has. Nothing in this slice
  // sends, and nothing in it is consent — see lib/agent-run.ts.

  /** Fold one `agent_stream` frame in, and (re)arm the guard that drops a run whose
   *  backend stopped talking mid-answer. */
  private onAgentFrame(raw: unknown): void {
    const frame = parseAgentFrame(raw);
    if (!frame) return;
    const runs = withAgentFrame(this.get().agentRuns, frame);
    if (runs !== this.get().agentRuns) this.set({ agentRuns: runs });

    const timer = this.agentRunTimers.get(frame.conversation);
    if (timer) clearTimeout(timer);
    this.agentRunTimers.delete(frame.conversation);
    // A finished run needs no guard: the UI drops it once the answer is fully
    // revealed, and until then it is showing text it already has.
    if (!agentRunIsLive(frame)) return;
    this.agentRunTimers.set(
      frame.conversation,
      setTimeout(() => this.forgetAgentRun(frame.conversation, frame.run_id), AGENT_RUN_STALE_MS),
    );
  }

  /** Let go of a run: the answer is fully on screen (or the run went quiet for so long
   *  that claiming it is still writing would be a lie). The posted message then renders
   *  on its own, which is what it does for every reply this app never watched. */
  forgetAgentRun(convId: string, runId: string): void {
    const timer = this.agentRunTimers.get(convId);
    if (timer) {
      clearTimeout(timer);
      this.agentRunTimers.delete(convId);
    }
    const runs = withoutAgentRun(this.get().agentRuns, convId, runId);
    if (runs !== this.get().agentRuns) this.set({ agentRuns: runs });
  }

  /** The group/channel name to show alongside the caller, or undefined for a 1:1
   *  (whose conversation name is just the other person — already the caller). */
  private callGroupLabel(convId: string): string | undefined {
    const conv = this.get().conversations.find((c) => c.id === convId);
    if (conv) {
      const isGroup = conv.kind === "group" || conv.kind === "unknown";
      return isGroup && conv.name ? conv.name : undefined;
    }
    const channel = this.get().channels.find((c) => c.id === convId);
    return channel?.name || undefined;
  }

  // ---- read receipts ("seen by") -------------------------------------------

  /** Fetch a conversation's read receipts and seed the per-conversation cache,
   *  then publish them if that conversation is still open. Best-effort: a
   *  failure (or a channel / receipts-disabled thread returning nothing) just
   *  leaves no "seen by" avatars. Live movement arrives via `read_receipt`. */
  private async loadReadReceipts(convId: string): Promise<void> {
    let receipts: ReadReceipt[];
    try {
      const res = await this.backend.readReceipts(convId);
      receipts = res.receipts ?? [];
    } catch {
      return; // best-effort — keep whatever we already have (usually nothing)
    }
    const byMri = new Map<string, ReadReceipt>();
    for (const r of receipts) byMri.set(r.member_mri, r);
    this.receiptsByConv.set(convId, byMri);
    if (this.get().openId === convId) this.publishReadReceipts(convId);
  }

  /** Fold a live `read_receipt` update into the per-conversation cache (upsert by
   *  MRI so a member's position only ever moves forward in practice) and refresh
   *  the open conversation's reactive slice. */
  private onReadReceipt(sig: ReadReceiptSignal): void {
    const convId = sig.conversation_id;
    const mri = sig.member_mri;
    if (!convId || !mri) return;
    let byMri = this.receiptsByConv.get(convId);
    if (!byMri) {
      byMri = new Map();
      this.receiptsByConv.set(convId, byMri);
    }
    byMri.set(mri, {
      member_mri: mri,
      member: sig.member,
      last_read_message_id: sig.last_read_message_id,
      read_time_ms: sig.read_time_ms,
    });
    if (this.get().openId === convId) this.publishReadReceipts(convId);
  }

  /** Publish a conversation's current read receipts into reactive state, but only
   *  while it is the open one (the slice is single-conversation). */
  private publishReadReceipts(convId: string): void {
    if (this.get().openId !== convId) return;
    const byMri = this.receiptsByConv.get(convId);
    this.set({ readReceipts: byMri ? [...byMri.values()] : [] });
  }

  // ---- @mention candidates -------------------------------------------------

  /**
   * Make sure the open conversation's mention candidates are loaded, then publish
   * them. Called when the composer sees its first "@", not when a thread opens: the
   * list costs the backend a roster read and a directory lookup, and most messages
   * mention nobody.
   *
   * Cached per conversation for the session and single-flighted, so holding "@" down
   * cannot fan out into a stream of requests. Best-effort: a failure leaves the list
   * empty, and a composer with no suggestions still sends messages.
   */
  async ensureMentionCandidates(): Promise<void> {
    const id = this.get().openId;
    if (!id) return;
    const cached = this.mentionsByConv.get(id);
    if (cached) {
      if (this.get().openId === id) this.set({ mentionCandidates: cached });
      return;
    }
    const pending = this.mentionLoads.get(id);
    if (pending) return pending;
    const load = (async () => {
      try {
        const res = await this.backend.members(id);
        const people = dedupeCandidates(res.members ?? []);
        this.mentionsByConv.set(id, people);
        if (this.get().openId === id) this.set({ mentionCandidates: people });
      } catch {
        // Best-effort: no suggestions rather than an error in the composer.
      } finally {
        this.mentionLoads.delete(id);
      }
    })();
    this.mentionLoads.set(id, load);
    return load;
  }

  // ---- conversations -------------------------------------------------------

  private async loadConversations(): Promise<void> {
    try {
      const convs = await this.backend.conversations();
      for (const conv of convs) {
        if (!this.draftCache.has(conv.id)) this.draftCache.set(conv.id, conv.draft);
      }
      this.set({ conversations: convs, status: `${convs.length} conversations` });
    } catch (e) {
      this.set({ status: `error: ${errText(e)}` });
    }
  }

  // ---- channels ------------------------------------------------------------

  /** Refresh the team/channel tree from the backend. Best-effort: a failure
   *  leaves the current tree untouched (channels are a secondary view). Seeds the
   *  warm draft cache from each channel row, exactly like `loadConversations`, so
   *  a channel opened before its first live event still restores its draft. */
  private async loadChannels(): Promise<void> {
    try {
      const channels = await this.backend.channels();
      for (const ch of channels) {
        if (!this.draftCache.has(ch.id)) this.draftCache.set(ch.id, ch.draft);
      }
      this.set({ channels });
    } catch {
      // ignore — the channel tree is non-critical; the last good tree stands.
    }
  }

  /** Switch the sidebar between the chat list, the channel tree and the mailbox.
   *  Opening Mail for the first time is what loads it — see `loadMailFolders`. */
  setSidebarTab(tab: SidebarTab): void {
    if (this.get().sidebarTab !== tab) this.set({ sidebarTab: tab });
    if (tab === "mail") void this.ensureMailLoaded();
    if (tab === "calendar") void this.ensureCalendarLoaded();
  }

  // ---- mail (read-only Outlook surface) ------------------------------------
  //
  // Local-first, exactly like chat: every list and body is served from the
  // backend's SQLite mirror first, then reconciled from Graph in the background.
  // Read-only end to end — there is no send/reply/delete/move here, and none in the
  // backend either (see src/mail.rs).

  /** Per-folder mail pages, so switching folders is instant and a background
   *  refresh reconciles into what is already on screen. Bounded by the number of
   *  folders a mailbox has (a handful), unlike the message cache. */
  private mailPageCache = new Map<string, MailPage>();
  /** Rendered bodies by mail id, bounded LRU: a body is up to ~135 KB of HTML, so a
   *  session spent reading through an inbox must not accumulate all of them. The
   *  backend caches them durably anyway, so a re-fetch is cheap. */
  private mailBodyCache = new Map<string, MailBody>();

  private refreshMailFolders = coalesce(() => this.loadMailFolders());

  /** Load the folder list (and select the inbox) the first time Mail is shown. */
  private async ensureMailLoaded(): Promise<void> {
    if (this.get().mailFolders.length === 0) await this.refreshMailFolders();
    if (!this.get().mailFolderId) {
      const folders = this.get().mailFolders;
      const inbox = folders.find((f) => f.well_known === "Inbox") ?? folders[0];
      if (inbox) void this.selectMailFolder(inbox.id);
    }
  }

  /** Refresh the folder list. Best-effort: on failure the last good list stands and
   *  the error is surfaced in the mail pane only, never as a fatal. */
  private async loadMailFolders(): Promise<void> {
    try {
      const folders = await this.backend.mailFolders();
      this.set({ mailFolders: folders, mailError: null });
    } catch (e) {
      // Only report it when there is nothing to show — a failed refresh behind a
      // populated sidebar is noise.
      if (this.get().mailFolders.length === 0) this.set({ mailError: errText(e) });
    }
  }

  /** Select a folder and show its mail: the cached page immediately, then the
   *  backend's own local-first answer, which a background sync may follow with a
   *  `mail_list_updated` event. */
  async selectMailFolder(folderId: string): Promise<void> {
    const cached = this.mailPageCache.get(folderId);
    this.set({
      mailFolderId: folderId,
      mailMessages: cached?.messages ?? [],
      mailHasMoreOlder: cached?.has_more ?? false,
      mailLoading: !cached,
      mailLoadingOlder: false,
      mailError: null,
    });

    try {
      const page = await this.backend.mailList(folderId);
      const merged = mergeRefreshedMailPage(this.mailPageCache.get(folderId), page);
      this.mailPageCache.set(folderId, merged);
      if (this.get().mailFolderId === folderId) {
        this.set({ mailMessages: merged.messages, mailHasMoreOlder: merged.has_more });
      }
    } catch (e) {
      if (this.get().mailFolderId === folderId && !cached) this.set({ mailError: errText(e) });
    } finally {
      if (this.get().mailFolderId === folderId) this.set({ mailLoading: false });
    }
  }

  /** Page further back in the selected folder (scroll-up in the mail list). */
  async loadOlderMail(): Promise<void> {
    const folderId = this.get().mailFolderId;
    if (!folderId) return;
    const state = this.get();
    if (state.mailLoadingOlder || !state.mailHasMoreOlder) return;
    const oldest = state.mailMessages[state.mailMessages.length - 1];
    if (!oldest) return;

    this.set({ mailLoadingOlder: true });
    try {
      const page = await this.backend.mailBackfill(folderId, oldest.received);
      if (this.get().mailFolderId !== folderId) return;
      const merged = mergeOlderMailPage(this.mailPageCache.get(folderId), page);
      this.mailPageCache.set(folderId, merged);
      this.set({ mailMessages: merged.messages, mailHasMoreOlder: merged.has_more });
    } catch (e) {
      if (this.get().mailFolderId === folderId) this.set({ mailError: errText(e) });
    } finally {
      if (this.get().mailFolderId === folderId) this.set({ mailLoadingOlder: false });
    }
  }

  /** Open one mail: show its header from the list at once, then its body (from the
   *  session cache when we already rendered it, else fetched — the backend keeps its
   *  own durable copy, so even a cold fetch is usually local to it). */
  async openMail(id: string): Promise<void> {
    const header = this.get().mailMessages.find((m) => m.id === id) ?? null;
    const cachedBody = this.mailBodyCache.get(id) ?? null;
    this.set({
      openMailId: id,
      // Prefer the list's header, then the cached body's own copy (a deep link has
      // no list). Keep the previous header only when re-opening the same mail, so
      // switching mails never shows the old sender against the new body.
      openMail:
        header ??
        cachedBody?.header ??
        (this.get().openMailId === id ? this.get().openMail : null),
      mailBody: cachedBody,
      mailBodyLoading: !cachedBody,
      mailBodyError: null,
    });
    // Reading a mail clears its unread marker, which is what a person expects of
    // opening one. A no-op unless the header we hold says it is unread.
    void this.markMailRead(id);
    if (cachedBody) return;

    try {
      const body = await this.backend.mailBody(id);
      this.cacheMailBody(id, body);
      if (this.get().openMailId === id) {
        // The body carries the header, which is what makes a deep link (or a
        // reload) show the subject and sender: there is no list to read them from.
        this.set({ mailBody: body, openMail: this.get().openMail ?? body.header ?? null });
      }
      // A DEEP LINK had no header until now — the list it would have come from was
      // never loaded — so this is the first moment its read state is known.
      void this.markMailRead(id);
    } catch (e) {
      if (this.get().openMailId === id) this.set({ mailBodyError: errText(e) });
    } finally {
      if (this.get().openMailId === id) this.set({ mailBodyLoading: false });
    }
  }

  /** Clear one mail's unread marker — in THIS APP only.
   *
   *  The mailbox is read-only (src/mail.rs): the backend records the read in its own
   *  mirror and tells Graph nothing, so Outlook keeps the mail unread on the user's
   *  phone and its sender is shown nothing. What clears is the marker here, which is
   *  what a person means when they say they read a mail.
   *
   *  The row is repainted only once the backend confirms it recorded the read — a
   *  read-only backend refuses, and a marker that clears on a refusal would be this
   *  app claiming a state nothing holds. The backend also broadcasts the folder's
   *  list and counts, so a second client (the phone) follows without asking. */
  private async markMailRead(id: string): Promise<void> {
    const state = this.get();
    const header =
      state.mailMessages.find((m) => m.id === id) ??
      (state.openMail?.id === id ? state.openMail : null);
    if (!header || header.is_read) return;

    try {
      const { read } = await this.backend.mailMarkRead(id);
      if (read) this.applyMailRead(id);
    } catch {
      // Best-effort, and self-healing: the marker stays until the next open, which
      // is the honest direction to fail in — nothing recorded, nothing claimed.
    }
  }

  /** Show one mail as read: the open row, the folder page on screen, and the cached
   *  page it came from (a mail deep in the backlog is in no broadcast page, so its
   *  row would otherwise stay bold until the folder is re-opened). */
  private applyMailRead(id: string): void {
    const markRead = (mail: MailHeader): MailHeader =>
      mail.id === id ? { ...mail, is_read: true } : mail;

    for (const [folderId, page] of this.mailPageCache) {
      if (!page.messages.some((m) => m.id === id && !m.is_read)) continue;
      this.mailPageCache.set(folderId, { ...page, messages: page.messages.map(markRead) });
    }

    const state = this.get();
    this.set({
      mailMessages: state.mailMessages.some((m) => m.id === id && !m.is_read)
        ? state.mailMessages.map(markRead)
        : state.mailMessages,
      openMail: state.openMail?.id === id ? markRead(state.openMail) : state.openMail,
    });
  }

  /** Store a rendered body, dropping the least-recently-opened one past the budget. */
  private cacheMailBody(id: string, body: MailBody): void {
    this.mailBodyCache.delete(id); // re-insert so Map order is the LRU order
    this.mailBodyCache.set(id, body);
    while (this.mailBodyCache.size > RETAINED_MAIL_BODIES) {
      const oldest = this.mailBodyCache.keys().next();
      if (oldest.done) break;
      if (oldest.value === this.get().openMailId) break; // never evict what is on screen
      this.mailBodyCache.delete(oldest.value);
    }
  }

  closeMail(): void {
    this.set({ openMailId: null, openMail: null, mailBody: null, mailBodyError: null });
  }

  /** Download one attachment: resolve its bytes to a blob URL and hand it to the
   *  browser under the attachment's own filename. */
  async downloadMailAttachment(messageId: string, attachmentId: string, name: string): Promise<void> {
    try {
      const objectUrl = await this.loadMailAttachment(messageId, attachmentId);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = name || "attachment";
      link.rel = "noopener";
      link.click();
    } catch (e) {
      this.set({ status: `attachment failed: ${errText(e)}` });
      playCue("error");
    }
  }

  /** Load the persisted local channel-pin overrides into state. Best-effort
   *  and SSR-safe: any failure (no localStorage, malformed JSON) leaves the empty
   *  default, so the backend's Teams-sourced `is_pinned` stands alone. */
  private applyPersistedChannelPins(): void {
    const pins = readFlagMap(CHANNEL_PINS_KEY);
    if (pins) this.set({ channelPins: pins });
  }

  /** Load the persisted collapsed sidebar sections. Same best-effort contract as
   *  the pins: on any failure every section keeps its default state. */
  private applyPersistedCollapsedSections(): void {
    const collapsed = readFlagMap(COLLAPSED_SECTIONS_KEY);
    if (collapsed) this.set({ collapsedSections: collapsed });
  }

  /** Load the persisted local chat pin / mute / hide overrides. Same best-effort
   *  contract as the channel pins: on any failure the chat keeps the placement
   *  Microsoft Teams reported. */
  private applyPersistedChatPrefs(): void {
    const pins = readFlagMap(CHAT_PINS_KEY);
    const hides = readTimeMap(CHAT_HIDES_KEY);
    if (!pins && !hides) return;
    this.set({ chatPrefs: { pins: pins ?? {}, hides: hides ?? {} } });
  }

  /** Toggle a channel's pin, lifting it into (or out of) the sidebar's top Pinned
   *  section. Records a local override that wins over Teams' own `is_pinned`,
   *  updates reactive state, and persists it. */
  toggleChannelPin(id: string): void {
    const base = this.get().channels.find((c) => c.id === id)?.is_pinned === true;
    const pins = this.get().channelPins;
    const current = pins[id] ?? base;
    const next = { ...pins, [id]: !current };
    this.set({ channelPins: next });
    writeFlagMap(CHANNEL_PINS_KEY, next);
  }

  /** Toggle a chat's pin, lifting it into (or out of) the chat list's Pinned section.
   *  A local override over Teams' own pin, persisted client-side — nothing is written
   *  back to the account (see `ChatPrefs`). */
  toggleChatPin(id: string): void {
    const conversation = this.get().conversations.find((c) => c.id === id);
    if (!conversation) return;
    const prefs = this.get().chatPrefs;
    const pins = { ...prefs.pins, [id]: !chatIsPinned(conversation, prefs) };
    this.set({ chatPrefs: { ...prefs, pins } });
    writeFlagMap(CHAT_PINS_KEY, pins);
  }

  /**
   * Mute or unmute one chat IN MICROSOFT TEAMS.
   *
   * Outward, and the only one of the three settings that is: Teams keeps a mute as the
   * conversation's own `alerts` property, so the write lands on every device the user is
   * signed in on and their phone stops notifying them about the thread. The backend
   * publishes it and answers with the value it wrote; the row then follows the account
   * rather than this browser, which is why there is no local override to reconcile.
   *
   * A failure is reported: the user asked for a change on their account, so a refusal
   * (a read-only backend, a page without the write token) must not read as success.
   */
  async setChatMuted(id: string, muted: boolean): Promise<void> {
    try {
      await this.backend.setChatMuted(id, muted);
      // Reflect it at once instead of waiting for the backend's list refresh, exactly
      // as a local read does — the next sync brings the same value back from Teams.
      const conversations = this.get().conversations.map((c) =>
        c.id === id ? { ...c, is_muted: muted } : c,
      );
      this.set({ conversations });
    } catch (e) {
      this.set({ status: `${muted ? "mute" : "unmute"} failed: ${errText(e)}` });
      playCue("error");
    }
  }

  /** Hide a chat away in the list, or bring it back.
   *
   *  Hiding records the newest message the chat holds as its watermark, so a NEW
   *  message brings the chat back on its own — which is what Teams' own Hide does.
   *  Showing records `0`, the one way back for a chat Teams itself hides: this app
   *  cannot unhide it on the account, so it says "shown here" instead. */
  setChatHidden(id: string, hidden: boolean): void {
    const conversation = this.get().conversations.find((c) => c.id === id);
    if (!conversation) return;
    const prefs = this.get().chatPrefs;
    const hides = { ...prefs.hides, [id]: hidden ? conversation.last_message_time : 0 };
    this.set({ chatPrefs: { ...prefs, hides } });
    writeTimeMap(CHAT_HIDES_KEY, hides);
  }

  /** Is this thread quiet? A chat muted in Teams or here, or a channel the user muted
   *  in Teams. Read on every inbound message, so a mute silences this app's own
   *  notification and cue as well as dimming the row. */
  private threadIsMuted(id: string): boolean {
    const conversation = this.get().conversations.find((c) => c.id === id);
    if (conversation) return chatIsMuted(conversation);
    const channel = this.get().channels.find((c) => c.id === id);
    return channel ? channelIsMuted(channel) : false;
  }

  /**
   * Mark one chat read from the sidebar, without opening it.
   *
   * This is the same outward call the app makes when the user opens a thread
   * (`mark_read` publishes their consumption horizon, so the sender is shown a read
   * receipt) — it is here because the user asked for it on this chat, and Ghost mode
   * still decides whether Teams is told at all. Unlike the automatic mark on open, a
   * failure is reported: the user clicked, so they must learn it did not happen.
   */
  async markConversationRead(id: string): Promise<void> {
    try {
      const { ghost } = await this.backend.markRead(id);
      this.applyLocalRead(id, ghost);
    } catch (e) {
      this.set({ status: `mark read failed: ${errText(e)}` });
      playCue("error");
    }
  }

  /** Collapse or expand one sidebar section — a team by its id, the channel tree's
   *  Pinned section by `"pinned"`, a team's hidden channels by `"hidden:<team id>"`,
   *  or a chat-list group by `"chats:<section>"`. Persisted, so a user who works out
   *  of two of their fifteen teams keeps the other thirteen folded away across
   *  reloads.
   *
   *  The caller states the target, rather than this deriving it from the stored map:
   *  a section absent from the map is not necessarily expanded (the hidden-things ones
   *  default to folded), so flipping the stored value would need a first click that
   *  appears to do nothing. */
  setSectionCollapsed(id: string, collapsed: boolean): void {
    const next = { ...this.get().collapsedSections, [id]: collapsed };
    this.set({ collapsedSections: next });
    writeFlagMap(COLLAPSED_SECTIONS_KEY, next);
  }

  // ---- calendar (read-only Teams/Outlook surface) --------------------------
  //
  // Local-first like mail: the backend serves a window from its SQLite mirror and
  // reconciles it against Graph in the background, so stepping back to a month
  // already visited is instant.
  //
  // READ-ONLY, and more sharply so than mail: creating an event mails an invitation
  // to every attendee, and answering one mails the organizer. There is no method
  // here that could, and none in the backend either (see src/calendar.rs).

  /** Guards against a stale answer winning. Every view load takes a ticket; a
   *  response whose ticket is no longer the current one is dropped, so quickly
   *  paging through months (or toggling calendars) can never leave the grid showing
   *  a window the user has already left. */
  private calendarLoadToken = 0;

  private refreshCalendars = coalesce(() => this.loadCalendars());

  /** Load the calendars and the first window the first time the Calendar tab is
   *  shown. */
  private async ensureCalendarLoaded(): Promise<void> {
    if (this.get().calendars.length === 0) await this.refreshCalendars();
    await this.loadCalendarView();
  }

  /** Fetch the calendar list. Best-effort: the calendar is a secondary surface, so
   *  a failure is surfaced in the calendar pane only, never as a fatal. */
  private async loadCalendars(): Promise<void> {
    try {
      const calendars = await this.backend.calendars();
      this.set({ calendars, calendarError: null });
      // Nothing chosen yet (a first run, or a persisted choice naming calendars this
      // mailbox no longer has): fall back to the default calendar alone.
      const visible = this.get().visibleCalendarIds.filter((id) =>
        calendars.some((c) => c.id === id),
      );
      if (visible.length === 0) {
        const fallback = calendars.find((c) => c.is_default) ?? calendars[0];
        if (fallback) this.setVisibleCalendars([fallback.id]);
      } else if (visible.length !== this.get().visibleCalendarIds.length) {
        this.setVisibleCalendars(visible);
      }
    } catch (e) {
      if (this.get().calendars.length === 0) this.set({ calendarError: errText(e) });
    }
  }

  /**
   * Load the window the current view shows.
   *
   * The events already held are kept on screen while the request is in flight, so
   * navigating between months never blanks the grid — the new window replaces its own
   * range on arrival (see `mergeCalendarWindow`) and leaves neighbouring months
   * cached for the step back.
   */
  async loadCalendarView(): Promise<void> {
    const state = this.get();
    const range = visibleRange(state.calendarMode, new Date(state.calendarAnchorMs));
    const { start, end } = requestRange(range);
    const calendars = state.visibleCalendarIds;
    // No calendar switched on is not an error and not a load: it is an empty grid.
    if (calendars.length === 0) {
      this.set({ calendarEvents: [], calendarLoading: false, calendarError: null });
      return;
    }

    const token = ++this.calendarLoadToken;
    this.set({ calendarLoading: true, calendarError: null });
    try {
      const view = await this.backend.calendarView(start, end, calendars);
      if (token !== this.calendarLoadToken) return;
      this.set({ calendarEvents: mergeCalendarWindow(this.get().calendarEvents, view) });
    } catch (e) {
      if (token !== this.calendarLoadToken) return;
      this.set({ calendarError: errText(e) });
    } finally {
      if (token === this.calendarLoadToken) this.set({ calendarLoading: false });
    }
  }

  /** Switch the calendar view (month / week / day / agenda) and load its window. */
  setCalendarMode(mode: CalendarViewMode): void {
    if (this.get().calendarMode === mode) return;
    this.set({ calendarMode: mode, openEventId: null });
    void this.loadCalendarView();
  }

  /** Centre the calendar on a date (a click in the mini month, or a day header). */
  setCalendarAnchor(date: Date): void {
    const anchor = startOfDay(date).getTime();
    if (this.get().calendarAnchorMs === anchor) return;
    this.set({ calendarAnchorMs: anchor, openEventId: null });
    void this.loadCalendarView();
  }

  /** Step one view forward (`+1`) or back (`-1`). */
  shiftCalendar(delta: number): void {
    const state = this.get();
    const next = shiftAnchor(state.calendarMode, new Date(state.calendarAnchorMs), delta);
    this.setCalendarAnchor(next);
  }

  /** Jump back to today, keeping the current view. */
  goToToday(): void {
    this.setCalendarAnchor(new Date());
  }

  /** Show or hide one calendar. Hiding is local-only and instant (the events are
   *  already held); showing may need a window the backend has not read for that
   *  calendar yet, so it reloads. */
  toggleCalendarVisible(id: string): void {
    const current = this.get().visibleCalendarIds;
    const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
    this.setVisibleCalendars(next);
    void this.loadCalendarView();
  }

  /** Record the visible calendars in state and in localStorage. */
  private setVisibleCalendars(ids: string[]): void {
    this.set({ visibleCalendarIds: ids });
    try {
      localStorage.setItem(VISIBLE_CALENDARS_KEY, JSON.stringify(ids));
    } catch {
      /* ignore — a failed persist just doesn't survive reload */
    }
  }

  /** Load the persisted visible-calendar choice. Best-effort and SSR-safe: any
   *  failure leaves the list empty, and `loadCalendars` then falls back to the
   *  default calendar. */
  private applyPersistedVisibleCalendars(): void {
    try {
      const raw = localStorage.getItem(VISIBLE_CALENDARS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
        if (ids.length > 0) this.set({ visibleCalendarIds: ids });
      }
    } catch {
      /* ignore — the visible-calendar choice is non-critical */
    }
  }

  /** Open one event's details panel, or close it (`null`). */
  setOpenEvent(id: string | null): void {
    this.set({ openEventId: id });
  }

  /** Flip one of the view menu's display preferences. Purely visual — no window is
   *  re-read, because none of these change which events the view covers. */
  toggleCalendarSetting(key: keyof CalendarSettings): void {
    const next = { ...this.get().calendarSettings, [key]: !this.get().calendarSettings[key] };
    this.set({ calendarSettings: next });
    try {
      localStorage.setItem(CALENDAR_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore — a failed persist just doesn't survive reload */
    }
  }

  /** Load the persisted display preferences. Each key is validated on its own, so a
   *  half-written or outdated blob degrades to the defaults instead of throwing. */
  private applyPersistedCalendarSettings(): void {
    try {
      const raw = localStorage.getItem(CALENDAR_SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<keyof CalendarSettings, unknown>>;
      const next = { ...DEFAULT_CALENDAR_SETTINGS };
      for (const key of Object.keys(next) as (keyof CalendarSettings)[]) {
        if (typeof parsed?.[key] === "boolean") next[key] = parsed[key] as boolean;
      }
      this.set({ calendarSettings: next });
    } catch {
      /* ignore — display preferences are non-critical */
    }
  }

  // ---- notifications (activity feed) --------------------------------------

  // Local "seen" high-water mark (epoch ms). The badge counts unread entries
  // strictly newer than this, so opening the panel clears the badge even though
  // a refetch still reports the same server-side unread — and a genuinely new
  // activity (larger timestamp) re-badges it. Local only: Teams has no
  // mark-read method we call yet.
  private notificationsSeenAt = 0;

  /** Refresh all three activity streams. Best-effort: a failure leaves the
   *  current feeds untouched and never surfaces a fatal error (the panel just
   *  shows stale or empty state). Called on startup and on every
   *  `notifications_changed`. */
  private async loadNotifications(): Promise<void> {
    try {
      const feeds = await this.backend.notifications();
      this.set({
        notifications: {
          activity: feeds.activity.items,
          mentions: feeds.mentions.items,
          following: feeds.following.items,
        },
      });
      this.recomputeUnread();
    } catch {
      // ignore — notifications are non-critical
    }
  }

  /** The badge counts unread Activity entries newer than the seen mark. Activity
   *  is the superset stream, so a mention (which also lands in Mentions) is
   *  counted once, here. */
  private recomputeUnread(): void {
    const unread = this.get().notifications.activity.filter(
      (n) => !n.is_read && n.timestamp > this.notificationsSeenAt,
    ).length;
    if (unread !== this.get().notificationsUnread) this.set({ notificationsUnread: unread });
  }

  /** Clear the bell badge once the user has opened the panel, by marking the
   *  Activity stream's newest entry as seen. The badge re-appears when a newer
   *  activity arrives. */
  markNotificationsSeen(): void {
    const latest = this.get().notifications.activity.reduce(
      (max, n) => Math.max(max, n.timestamp),
      0,
    );
    this.notificationsSeenAt = Math.max(this.notificationsSeenAt, latest);
    this.recomputeUnread();
  }

  /** Force a feed refresh, e.g. when the user opens the panel. Coalesced with
   *  the live-event refresh so rapid opens don't stack network calls. */
  reloadNotifications(): void {
    void this.refreshNotifications();
  }

  private scrollNonce = 0;

  /** Ask the open pane to scroll to a specific message once it is loaded (the
   *  pane pages older until it appears, then highlights it). Used when a
   *  notification is opened so the user lands on the reacted-to message, not the
   *  bottom of the chat. A no-op target id clears any pending request. */
  requestScrollToMessage(convId: string, messageId: string): void {
    if (!messageId) {
      if (this.get().pendingScroll) this.set({ pendingScroll: null });
      return;
    }
    this.scrollNonce += 1;
    this.set({ pendingScroll: { convId, messageId, nonce: this.scrollNonce } });
  }

  /** Clear a consumed (or abandoned) scroll request, guarded by nonce so a newer
   *  request set in the meantime is never dropped. */
  clearScrollTarget(nonce: number): void {
    if (this.get().pendingScroll?.nonce === nonce) this.set({ pendingScroll: null });
  }

  async openConversation(id: string): Promise<void> {
    const previousId = this.get().openId;
    if (previousId && previousId !== id) {
      this.flushDraft(previousId);
      // Whatever backlog was paged into the conversation we're leaving is no
      // longer on screen — keep a generous slice of it, not all of it.
      this.trimCachedHistory(previousId);
    }

    const nextDraft =
      this.draftCache.get(id) ??
      this.get().conversations.find((c) => c.id === id)?.draft ??
      this.get().channels.find((c) => c.id === id)?.draft ??
      "";
    this.draftCache.set(id, nextDraft);

    const cached = this.messageCache.get(id);
    const cachedReceipts = this.receiptsByConv.get(id);
    this.set({
      openId: id,
      replyingTo: null,
      messagesError: null,
      olderError: null,
      loadingOlder: false,
      draft: nextDraft,
      // A send fails in one thread; the sentence about it belongs to that thread alone.
      sendError: null,
      messages: cached?.messages ?? [],
      hasMoreOlder: cached?.has_more ?? false,
      loadingMessages: !cached,
      // Show any cached "seen by" positions instantly on re-open; the fetch below
      // (and live `read_receipt` events) then reconcile them.
      readReceipts: cachedReceipts ? [...cachedReceipts.values()] : [],
      // Whoever this thread can mention, when we already know. Never another
      // thread's people: this slice belongs to the open conversation alone.
      mentionCandidates: this.mentionsByConv.get(id) ?? [],
    });

    // Fetch the current read positions best-effort — never blocks the open, and a
    // channel / receipts-disabled thread just resolves to no avatars.
    void this.loadReadReceipts(id);
    // Opening a thread reads it. From the cache first, so the marker clears with the
    // click; the newest page landing below marks again if it moved the position.
    this.markThreadRead(id);

    try {
      const res = await this.backend.open(id);
      const history = mergeRefreshedHistoryPage(this.messageCache.get(id), res);
      this.cacheMessages(id, history);
      if (this.get().openId === id) {
        this.set({ messages: history.messages, hasMoreOlder: history.has_more });
      }
      this.markThreadRead(id);
    } catch (e) {
      if (this.get().openId === id && !cached) this.set({ messagesError: errText(e) });
      this.set({ status: `open error: ${errText(e)}` });
    } finally {
      if (this.get().openId === id) this.set({ loadingMessages: false });
    }
  }

  // The newest message id we have already declared as read, per thread. Teams'
  // unread flag is server-side, so marking a thread read is a network write — this
  // keeps a re-open, a background refresh and a live message from re-issuing the same
  // one. Cleared for a thread when its mark fails, so the next chance retries.
  private markedReadUpTo = new Map<string, string>();

  /**
   * Tell the backend the user has read this thread up to the newest message we hold —
   * the reason an unread chat stops coming back unread (Teams owns that flag, and
   * until `mark_read` nothing moved it).
   *
   * Called on open and whenever the open thread's newest message changes, because the
   * read position must name the newest message the user has actually seen: `open`
   * answers from the cache first, so the newest page can land a moment later.
   *
   * Best-effort and idempotent by design. A failure is not surfaced: the marker simply
   * stays until the next open, which is much better than an error toast over a chat
   * the user just wanted to read.
   */
  private markThreadRead(id: string): void {
    if (!this.get().ready) return;
    const newest = this.messageCache.get(id)?.messages.at(-1)?.id;
    if (!newest || this.markedReadUpTo.get(id) === newest) return;
    this.markedReadUpTo.set(id, newest);
    void this.backend
      .markRead(id)
      .then(({ ghost }) => this.applyLocalRead(id, ghost))
      .catch(() => {
        // Never leave a thread looking marked when it is not — the next open retries.
        this.markedReadUpTo.delete(id);
      });
  }

  /** Reflect a successful mark in the sidebar immediately, instead of waiting for the
   *  backend's `conversations_changed` round-trip. `ghost` carries whether Teams was
   *  told: with Ghost mode on it was not, and the row is badged as read here only.
   *
   *  A thread is in exactly one of the two lists, and re-reading an already-read one
   *  changes nothing — so each list is only replaced when one of its rows moves,
   *  leaving the other list's identity (and the sidebar's rendering) untouched. */
  private applyLocalRead(id: string, ghost: boolean): void {
    const readHere = <T extends { id: string; is_read: boolean; is_ghost_read?: boolean }>(
      rows: T[],
    ): T[] | null => {
      const row = rows.find((r) => r.id === id);
      if (!row || (row.is_read && (row.is_ghost_read ?? false) === ghost)) return null;
      return rows.map((r) => (r.id === id ? { ...r, is_read: true, is_ghost_read: ghost } : r));
    };
    const conversations = readHere(this.get().conversations);
    const channels = readHere(this.get().channels);
    if (conversations) this.set({ conversations });
    if (channels) this.set({ channels });
  }

  /** Re-sync after the connection recovers from a drop. While disconnected we may
   *  have missed live updates — most importantly a message being deleted (Teams
   *  sends deletions as a `MessageUpdate`, which never arrives while the feed is
   *  down, so a since-deleted message would otherwise stay visible until the next
   *  manual re-open). Reconcile the open conversation against the server's newest
   *  page and refresh the sidebar lists so their previews/ordering catch up.
   *  Best-effort and guarded on `ready` so it never races startup. */
  private async handleLiveRecovery(): Promise<void> {
    if (!this.get().ready) return;
    const openId = this.get().openId;
    if (openId) void this.reconcileOpen(openId);
    void this.refreshConversations();
    void this.refreshChannels();
    // Mail too, but only if it has been opened: its own reconcile is the backend's
    // newest-window re-read, which `selectMailFolder` triggers.
    if (this.get().mailFolders.length > 0) {
      void this.refreshMailFolders();
      const folderId = this.get().mailFolderId;
      if (folderId) void this.selectMailFolder(folderId);
    }

    // And the calendar, on the same terms: a meeting moved or cancelled while we
    // were offline would otherwise only correct itself on the next poll tick, and
    // re-loading the window also re-registers it as the one the backend watches.
    if (this.get().calendars.length > 0) {
      void this.refreshCalendars();
      void this.loadCalendarView();
    }
  }

  /** Re-fetch a conversation's newest page and reconcile it into the cache and (if
   *  still open) the view — without the disruptive parts of `openConversation` (no
   *  draft swap, no reply reset, no loading flash). Used on live-feed recovery to
   *  pull in changes missed while disconnected. The backend's `open` re-persists
   *  the newest page, flipping a since-deleted message's `deleted` flag, and the
   *  merge (replacing by id) swaps the stale bubble for its tombstone. */
  private async reconcileOpen(id: string): Promise<void> {
    try {
      const res = await this.backend.open(id);
      const history = mergeRefreshedHistoryPage(this.messageCache.get(id), res);
      this.cacheMessages(id, history);
      if (this.get().openId === id) {
        this.set({ messages: history.messages, hasMoreOlder: history.has_more });
      }
      // Read positions may also have advanced while we were away.
      void this.loadReadReceipts(id);
    } catch {
      // Best-effort — a later live event or manual re-open will reconcile.
    }
  }

  closeConversation(): void {
    const id = this.get().openId;
    if (id) {
      this.flushDraft(id);
      this.trimCachedHistory(id);
    }
    // The read-receipts, mention and send-failure slices are single-conversation — drop
    // them when nothing is open.
    this.set({
      openId: null,
      replyingTo: null,
      readReceipts: [],
      mentionCandidates: [],
      sendError: null,
    });
  }

  async loadOlderMessages(): Promise<void> {
    const conversation = this.get().openId;
    if (!conversation) return;
    const s = this.get();
    if (s.loadingOlder || !s.hasMoreOlder) return;
    const oldest = s.messages[0];
    if (!oldest) return;

    this.set({ loadingOlder: true, olderError: null });
    try {
      const page = await this.backend.backfill(conversation, oldest.seq);
      if (this.get().openId !== conversation) return;
      const history = mergeOlderHistoryPage(this.messageCache.get(conversation), page);
      this.cacheMessages(conversation, history);
      this.set({ messages: history.messages, hasMoreOlder: history.has_more });
    } catch (e) {
      if (this.get().openId === conversation) {
        this.set({ olderError: errText(e), status: `history error: ${errText(e)}` });
      }
    } finally {
      if (this.get().openId === conversation) this.set({ loadingOlder: false });
    }
  }

  // ---- composer + drafts ---------------------------------------------------

  setDraftText(text: string): void {
    this.set({ draft: text });
    const id = this.get().openId;
    if (!id) return;
    this.draftCache.set(id, text);
    this.scheduleDraftSave(id, text);
  }

  private persistDraft(id: string, text: string): void {
    void this.backend.setDraft(id, text).catch((e) => {
      if (this.draftCache.get(id) === text) this.set({ status: `draft save failed: ${errText(e)}` });
    });
  }

  private scheduleDraftSave(id: string, text: string): void {
    const pending = this.draftSaveTimers.get(id);
    if (pending) clearTimeout(pending);
    this.draftSaveTimers.set(
      id,
      setTimeout(() => {
        this.draftSaveTimers.delete(id);
        this.persistDraft(id, text);
      }, DRAFT_SAVE_DELAY_MS),
    );
  }

  private flushDraft(id: string): void {
    const pending = this.draftSaveTimers.get(id);
    if (!pending) return;
    clearTimeout(pending);
    this.draftSaveTimers.delete(id);
    this.persistDraft(id, this.draftCache.get(id) ?? "");
  }

  startReply(message: ChatMessage): void {
    this.set({ replyingTo: { message, marker: null } });
  }

  /** Set the status-bar text (transient feedback such as "Copied"). */
  setStatus(text: string): void {
    this.set({ status: text });
  }

  // ---- media (hosted-content proxy) ---------------------------------------

  /** Resolve a Teams hosted-content URL (inline image or shared file) to a local
   *  blob object URL, fetching the bytes through the backend proxy. Cached and
   *  deduplicated per URL; a failed load is evicted so a later retry can refetch.
   *  The returned object URL stays valid until the controller is disposed. */
  loadMedia(url: string): Promise<string> {
    return this.loadBlob(url, () => this.backend.fetchMedia(url));
  }

  /** Resolve one mail attachment to a local blob object URL, for downloading or
   *  previewing it. Shares the media cache — and therefore its LRU order and byte
   *  budget — so a mailbox full of attachments cannot grow the page without bound.
   *  Inline images need no call: the backend already embedded them in the body. */
  loadMailAttachment(messageId: string, attachmentId: string): Promise<string> {
    return this.loadBlob(mailAttachmentKey(messageId, attachmentId), () =>
      this.backend.mailAttachment(messageId, attachmentId),
    );
  }

  /** Fetch bytes through the backend once per `key`, hand back a blob object URL,
   *  and keep it under the shared byte budget.
   *
   *  The one place proxied bytes become an object URL, for chat media and mail
   *  attachments alike: one cache, one LRU order, one eviction policy. A failed load
   *  is evicted so a later render can retry. */
  private loadBlob(
    key: string,
    fetch: () => Promise<{ content_type: string; data_base64: string }>,
  ): Promise<string> {
    const cached = this.mediaCache.get(key);
    if (cached) {
      // Re-insert so Map order stays the least-recently-used order.
      this.mediaCache.delete(key);
      this.mediaCache.set(key, cached);
      return cached;
    }

    const pending = (async () => {
      const res = await fetch();
      const blob = new Blob([base64ToArrayBuffer(res.data_base64)], {
        type: res.content_type || "application/octet-stream",
      });
      const objectUrl = URL.createObjectURL(blob);
      this.mediaBlobs.set(key, { objectUrl, bytes: blob.size });
      this.mediaBytes += blob.size;
      this.evictMedia();
      return objectUrl;
    })();

    this.mediaCache.set(key, pending);
    pending.catch(() => this.mediaCache.delete(key));
    return pending;
  }

  /** Mark a media URL as being displayed, so the byte budget never revokes a blob
   *  out from under a mounted view (which would break the picture on screen).
   *  Paired with {@link releaseMedia} on unmount — see `MediaImage`. */
  retainMedia(url: string): void {
    this.mediaRetained.set(url, (this.mediaRetained.get(url) ?? 0) + 1);
  }

  /** Drop one display reference to a media URL, making it evictable again. */
  releaseMedia(url: string): void {
    const count = (this.mediaRetained.get(url) ?? 0) - 1;
    if (count > 0) this.mediaRetained.set(url, count);
    else this.mediaRetained.delete(url);
  }

  /** Bring the media cache back under MEDIA_CACHE_BYTES by revoking the
   *  least-recently-used blobs that nothing is currently displaying. Stops early
   *  when everything left is on screen — a bounded set, since only the visible
   *  slice of a conversation is mounted. */
  private evictMedia(): void {
    if (this.mediaBytes <= MEDIA_CACHE_BYTES) return;
    for (const url of [...this.mediaCache.keys()]) {
      if (this.mediaBytes <= MEDIA_CACHE_BYTES) break;
      if (this.mediaRetained.has(url)) continue;
      const blob = this.mediaBlobs.get(url);
      if (!blob) continue; // still in flight — it has no bytes to reclaim yet
      URL.revokeObjectURL(blob.objectUrl);
      this.mediaBlobs.delete(url);
      this.mediaCache.delete(url);
      this.mediaBytes -= blob.bytes;
    }
  }

  /** Resolve a real profile photo to a local blob object URL, fetching the bytes
   *  through the backend proxy — a person (`kind: "user"`, `id` = their MRI) or a
   *  Teams "team" group (`kind: "team"`, `id` = its AAD group id). Resolves to
   *  `null` when the subject has no photo, so the caller falls back to initials.
   *  Cached and de-duplicated per identity: a "no photo" miss is cached so it is
   *  never re-requested, while a transient failure is evicted for a later retry.
   *  Returns `null` immediately for an empty id. */
  loadAvatar(kind: "user" | "team", id: string): Promise<string | null> {
    if (!id) return Promise.resolve(null);
    return this.cacheAvatar(`${kind}:${id}`, async () => {
      const res = await this.backend.fetchAvatar(kind, id);
      return res.found && res.data_base64 ? res : null;
    });
  }

  /** The picture for one MAIL ADDRESS: a face when the directory knows the person, else
   *  the mark of the organisation the address belongs to.
   *
   *  Three steps, each cached on its own. The address resolves to a person through the
   *  directory; that person's MRI takes the ordinary photo path, so a colleague who
   *  writes from two addresses is fetched once. An address the directory cannot name —
   *  Sentry, Linear, a distribution list — falls through to its domain's own icon
   *  (see `loadSenderIcon`), which is the mark a reader of that mail already knows.
   *  When neither answers, the tinted initials the caller already draws stand. */
  async loadAvatarForAddress(address: string): Promise<AvatarPicture | null> {
    const person = await this.loadAddressPerson(address);
    if (person?.mri) {
      const url = await this.loadAvatar("user", person.mri);
      return url ? { url, kind: "face" } : null;
    }
    // A HUMAN the directory could not name — an external colleague, someone who left —
    // keeps their initials. Their employer's logo would misattribute a message they
    // wrote, and asking that employer's server about them would be a request made for
    // a picture we were never going to draw.
    if (mailAddressSpellsAPerson(address)) return null;
    const url = await this.loadSenderIcon(registrableMailDomain(mailDomain(address)));
    return url ? { url, kind: "mark" } : null;
  }

  /** Resolve one organisation's icon to a local blob object URL, through the backend —
   *  which is where every rail on that request lives (`src/sender_icon.rs`): the domain
   *  is reduced to its registrable form, the answer is remembered per domain so a
   *  server is asked once rather than once per mail, a read-only backend never asks,
   *  and the user can turn the whole thing off.
   *
   *  Asked for by a mail LIST rather than by opening a body, which is deliberate: the
   *  request must not be able to say that a mail was read. */
  loadSenderIcon(domain: string): Promise<string | null> {
    if (!domain || !domain.includes(".")) return Promise.resolve(null);
    return this.cacheAvatar(`icon:${domain}`, async () => {
      const res = await this.backend.senderIcon(domain);
      return res.found && res.data_base64 ? res : null;
    });
  }

  /** Resolve one mail address to the person the directory knows behind it, or `null`
   *  when it knows nobody. Batched: every address asked for within
   *  ADDRESS_BATCH_MS leaves in one request, because a page of mail names dozens of
   *  people at once and one request per row would be a request storm. Cached per
   *  address for the session, a "nobody" included. */
  loadAddressPerson(address: string): Promise<AddressPerson | null> {
    const key = address.trim().toLowerCase();
    // Only a plain address can be looked up; the backend refuses anything else, so
    // a display name or an empty field never becomes a request.
    if (!key || !key.includes("@")) return Promise.resolve(null);
    const cached = this.addressPeopleCache.get(key);
    if (cached) return cached;

    const pending = new Promise<AddressPerson | null>((resolve) => {
      this.addressQueue.set(key, resolve);
      if (!this.addressBatchTimer) {
        this.addressBatchTimer = setTimeout(() => void this.flushAddressQueue(), ADDRESS_BATCH_MS);
      }
    });
    this.addressPeopleCache.set(key, pending);
    return pending;
  }

  /** Ask the directory about every queued address in one request and hand each
   *  waiter its own answer. A batch is capped (ADDRESS_BATCH_MAX, the backend's own
   *  limit), and the surplus goes out in the next one. On failure every waiter gets
   *  `null` and its cache entry is dropped, so a later render retries. */
  private async flushAddressQueue(): Promise<void> {
    this.addressBatchTimer = null;
    const waiting = [...this.addressQueue.entries()].slice(0, ADDRESS_BATCH_MAX);
    for (const [address] of waiting) this.addressQueue.delete(address);
    if (this.addressQueue.size > 0) {
      this.addressBatchTimer = setTimeout(() => void this.flushAddressQueue(), ADDRESS_BATCH_MS);
    }
    if (waiting.length === 0) return;

    try {
      const res = await this.backend.peopleByAddress(waiting.map(([address]) => address));
      // The backend echoes each address as we spelled it, and we send the lowercased
      // key, so an answer maps back to its waiter without a second guess.
      const found = new Map(res.people.map((person) => [person.address.toLowerCase(), person]));
      for (const [address, resolve] of waiting) resolve(found.get(address) ?? null);
    } catch {
      for (const [address, resolve] of waiting) {
        this.addressPeopleCache.delete(address);
        resolve(null);
      }
    }
  }

  /** Resolve a group chat's own picture to a local blob object URL, fetching the
   *  bytes through the media proxy — the same path an inline chat image takes,
   *  since a chat picture is an authenticated hosted-content object (its URL comes
   *  from `Conversation.picture_url`). Deliberately NOT the media cache: that one
   *  evicts by byte budget, and an avatar stays on screen for the whole session.
   *  Returns `null` immediately for an empty URL. */
  loadAvatarPicture(url: string): Promise<string | null> {
    if (!url) return Promise.resolve(null);
    return this.cacheAvatar(`picture:${url}`, () => this.backend.fetchMedia(url));
  }

  /** Fetch avatar bytes once per `key` and hand back a blob object URL that lives
   *  as long as the session (avatars are small, few, and always on screen).
   *
   *  `fetch` resolves to `null` when the subject simply HAS no photo: that null is
   *  cached so it is never re-requested, while a transient failure is evicted so a
   *  later render retries (mirrors the media cache). */
  private cacheAvatar(
    key: string,
    fetch: () => Promise<{ content_type?: string; data_base64?: string } | null>,
  ): Promise<string | null> {
    const cached = this.avatarCache.get(key);
    if (cached) return cached;

    const pending = (async () => {
      const res = await fetch();
      if (!res || !res.data_base64) return null;
      const blob = new Blob([base64ToArrayBuffer(res.data_base64)], {
        type: res.content_type || "application/octet-stream",
      });
      const objectUrl = URL.createObjectURL(blob);
      this.avatarObjectUrls.push(objectUrl);
      return objectUrl;
    })();

    this.avatarCache.set(key, pending);
    pending.catch(() => this.avatarCache.delete(key));
    return pending;
  }

  // ---- people (profile card + presence) -----------------------------------

  /** Resolve one person's directory card (name, job title, department, email, work
   *  location), going through the backend. Resolves to `null` when the directory
   *  knows nobody by this MRI, so the caller falls back to the name it already has.
   *  Cached for the session and de-duplicated per MRI — a card barely changes —
   *  while a transient failure is evicted so a later hover can retry. Returns
   *  `null` immediately for an empty MRI. */
  // ---- the name and face the USER gave somebody ---------------------------

  /** Read back what the user chose for one person — their nickname, whether they
   *  gave them a face, and what Teams itself calls them. Cached per MRI and dropped
   *  when it changes, so the card that offers the rename opens without a round trip.
   *  Resolves to `null` for an empty MRI or when the backend cannot answer. */
  loadPersonOverride(mri: string): Promise<PersonOverride | null> {
    if (!mri) return Promise.resolve(null);
    const cached = this.overrideCache.get(mri);
    if (cached) return cached;
    const pending = this.backend.personOverride(mri).catch(() => null);
    this.overrideCache.set(mri, pending);
    return pending;
  }

  /** Every override the user set, newest change first, without the avatar bytes.
   *  Never cached: it is read by a settings pane that must show the current state,
   *  and it is one small round trip. */
  async loadPersonOverrides(): Promise<PersonOverride[]> {
    const res = await this.backend.personOverrides();
    return res.overrides ?? [];
  }

  /** Call `listener` whenever any person's override changes — here, or in another page
   *  on this store. Returns the unsubscribe. For a surface that LISTS them: every other
   *  reader is served by `forgetPerson`, which re-reads what it holds. */
  onPersonOverrideChange(listener: () => void): () => void {
    this.overrideListeners.add(listener);
    return () => {
      this.overrideListeners.delete(listener);
    };
  }

  /** Rename one person, or with an empty name, put their real name back. */
  async setPersonName(mri: string, name: string): Promise<void> {
    await this.backend.setPersonName(mri, name.trim());
    this.forgetPerson(mri);
  }

  /** Give one person a face, or with `null`, take it back. */
  async setPersonAvatar(
    mri: string,
    avatar: { content_type: string; data_base64: string } | null,
  ): Promise<void> {
    await this.backend.setPersonAvatar(mri, avatar);
    this.forgetPerson(mri);
  }

  /**
   * Drop everything we hold about one person, so the next render asks again.
   *
   * The backend resolves a person's name on the way out of the store, so a rename
   * changes what every already-loaded message says — and this app holds those
   * messages in memory. Nothing here can patch them one by one without re-deriving
   * the sidebar's title rules, so it re-reads instead: the lists, and the open
   * thread. Three caches go with them, and the AVATAR one is the load-bearing part —
   * it never evicts on its own (an avatar is small and stays on screen for the whole
   * session), so without this the old face would survive until a reload.
   *
   * Called both when this app makes the change and when the other backend sharing
   * this store does (`person_override_changed`), so two open pages agree.
   */
  private forgetPerson(mri: string): void {
    this.overrideCache.delete(mri);
    for (const listener of this.overrideListeners) listener();
    this.profileCache.delete(mri);
    this.avatarCache.delete(`user:${mri}`);
    void this.refreshConversations();
    void this.refreshChannels();
    void this.refreshNotifications();
    const openId = this.get().openId;
    if (openId) void this.reconcileOpen(openId);
  }

  loadProfile(mri: string): Promise<PersonProfile | null> {
    if (!mri) return Promise.resolve(null);
    const cached = this.profileCache.get(mri);
    if (cached) return cached;

    const pending = this.backend.profile(mri).then((p) => (p.found ? p : null));
    this.profileCache.set(mri, pending);
    pending.catch(() => this.profileCache.delete(mri));
    return pending;
  }

  /** Resolve one person's live presence. Cached only briefly (see PRESENCE_TTL_MS):
   *  a stale presence is worse than a slightly slower card, so once the entry ages
   *  out the next lookup refetches. Resolves to `null` when the service has no
   *  answer for this person. A transient failure is evicted so a later hover
   *  retries. */
  loadPresence(mri: string): Promise<PersonPresence | null> {
    if (!mri) return Promise.resolve(null);
    const cached = this.presenceCache.get(mri);
    if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) return cached.value;

    const pending = this.backend
      .presence([mri])
      .then((res) => res.presences.find((p) => p.mri === mri) ?? null);
    this.presenceCache.set(mri, { at: Date.now(), value: pending });
    pending.catch(() => this.presenceCache.delete(mri));
    return pending;
  }

  // ---- settings + link enrichment -----------------------------------------

  /** Load the non-secret app settings from the backend into reactive state.
   *  Best-effort: on failure the defaults remain (host gitlab.com, no tokens). */
  private async loadSettings(): Promise<void> {
    try {
      const settings = await this.backend.getSettings();
      this.set({ settings });
    } catch {
      // ignore — settings are non-critical; defaults stand.
    }
  }

  /** Persist app settings (partial) and reflect the fresh non-secret view in
   *  state. Clears the link cache so previews re-evaluate against the new host /
   *  tokens — including the links that resolved to nothing before a token was
   *  stored. Rejects on failure so the caller (the settings form) can surface it.
   *
   *  Sounds its outcome: saving a token is a deliberate action whose result the user
   *  waits for, so the cue rides the answer — never the hover or the click, which say
   *  only that the pointer moved. */
  async saveSettings(patch: SettingsPatch): Promise<AppSettings> {
    let settings: AppSettings;
    try {
      settings = await this.backend.setSettings(patch);
    } catch (e) {
      playCue("error");
      throw e;
    }
    this.set({ settings });
    this.linkCache.clear();
    this.linkResolved.clear();
    playCue("success");
    return settings;
  }

  /** Turn "Always available" on or off and reflect the fresh view in state.
   *
   *  Not part of `saveSettings`, because this one publishes the user's own presence to
   *  Teams: it is gated like a send, and the state only moves once the backend says
   *  the status was actually changed. Rejects on failure so the switch can say why
   *  instead of claiming a status nobody outside this machine can see. */
  async setAlwaysAvailable(enabled: boolean): Promise<AppSettings> {
    let settings: AppSettings;
    try {
      settings = await this.backend.setAlwaysAvailable(enabled);
    } catch (e) {
      playCue("error");
      throw e;
    }
    this.set({ settings });
    playCue("success");
    return settings;
  }

  // ---- the local agent (see lib/agent.ts) ----------------------------------

  /** Read what the backend's machine can do about agent replies. Best-effort: the
   *  feature is an extra, and a failure must not keep the app from starting. */
  private async loadAgentStatus(): Promise<void> {
    try {
      this.set({ agent: await this.backend.agentStatus() });
    } catch {
      // ignore — the menu then says the backend has not answered yet.
    }
  }

  /**
   * Opt one conversation in or out of agent replies.
   *
   * This is the consent gate of the whole feature, not a display preference: turning
   * it on tells the machine it may post an answer under the user's name in THAT
   * conversation, and nowhere else. So it is a write request, it names the
   * conversation explicitly, and the backend's own answer — never a local guess — is
   * what lands in state.
   *
   * Rejects on failure, so the control that called it can say why.
   */
  async setAgentMode(conversationId: string, mode: AgentMode): Promise<AgentStatus> {
    let status: AgentStatus;
    try {
      status = await this.backend.agentSetMode(conversationId, mode);
    } catch (e) {
      playCue("error");
      throw e;
    }
    this.set({ agent: status });
    playCue("success");
    return status;
  }

  /**
   * Grant, or take back, one group of tools the agent may use without being asked.
   *
   * The other half of the same consent: the mode says WHERE this machine answers, this
   * says WHAT the program it runs may reach. So it is a write request too, it sends the
   * whole allowlist rather than a difference, and the backend's own answer — never a
   * local guess — is what lands in state.
   *
   * Rejects on failure, so the control that called it can say why.
   */
  /**
   * Run the agent on the user's own Claude Code configuration, or back on this app's
   * allowlist.
   *
   * The widest of the agent settings: on the user's own configuration the child holds
   * every MCP server and tool their settings hold, which is what their terminal gives
   * them. A write request for that reason, and the backend's own answer is what lands in
   * state.
   *
   * Rejects on failure, so the control that called it can say why.
   */
  async setAgentUnrestricted(unrestricted: boolean): Promise<AgentStatus> {
    let status: AgentStatus;
    try {
      status = await this.backend.agentSetUnrestricted(unrestricted);
    } catch (e) {
      playCue("error");
      throw e;
    }
    this.set({ agent: status });
    playCue("success");
    return status;
  }

  async setAgentTools(tools: string[]): Promise<AgentStatus> {
    let status: AgentStatus;
    try {
      status = await this.backend.agentSetTools(tools);
    } catch (e) {
      playCue("error");
      throw e;
    }
    this.set({ agent: status });
    playCue("success");
    return status;
  }

  /**
   * Enable or disable one AI provider, and/or choose the model it runs.
   *
   * A write request like the ones above, and for the same reason: it decides which
   * program a chat message starts on the backend's machine. The status that lands in
   * state is the backend's own — never a local guess — so a refused write leaves the
   * pane showing what is really stored.
   *
   * Rejects on failure, so the row that called it can say why.
   */
  async setAgentProvider(provider: string, patch: AgentProviderPatch): Promise<AgentStatus> {
    let status: AgentStatus;
    try {
      status = await this.backend.agentSetProvider(provider, patch);
    } catch (e) {
      playCue("error");
      throw e;
    }
    this.set({ agent: status });
    playCue("success");
    return status;
  }

  // ---- push notifications (see lib/push.ts) --------------------------------

  /**
   * Work out where this device stands on push notifications, and re-register it if
   * it is already subscribed.
   *
   * Runs on every start, and the re-registration is the point: a browser may rotate
   * a subscription while the app is closed, and the endpoint the backend holds is
   * then dead. The page is the only place that can notice, because it is the only
   * place with both the browser's current subscription and an authenticated socket.
   *
   * Best-effort throughout: notifications are an extra, and a failure here must
   * never keep the app from starting.
   */
  private async syncPush(): Promise<void> {
    if (typeof window === "undefined") return; // SSR has no browser to ask
    const environment = readPushEnvironment();
    try {
      const status = await this.backend.pushStatus();
      const blocker = pushBlocker(environment, status.supported);
      const subscription = blocker === null ? await currentSubscription() : null;
      this.set({
        push: {
          ...this.get().push,
          environment,
          blocker,
          devices: status.devices,
          endpoint: subscription?.endpoint ?? null,
          error: blocker === "backend" ? (status.reason ?? null) : null,
        },
      });
      if (!subscription) return;
      // Re-register the subscription we found. Idempotent on the backend, and it
      // heals both a rotated subscription and a store that lost the row.
      const payload = subscriptionPayload(subscription, deviceLabel());
      if (!payload) return;
      const refreshed = await this.backend.pushSubscribe(payload);
      this.set({ push: { ...this.get().push, devices: refreshed.devices } });
    } catch {
      // Leave the environment we did resolve, so Settings can still explain iOS's
      // "add to Home Screen" requirement while the backend is unreachable.
      this.set({ push: { ...this.get().push, environment } });
    }
  }

  /**
   * Turn notifications on for this device: ask permission, subscribe, and tell the
   * backend.
   *
   * MUST be called straight from a user gesture — iOS refuses the permission prompt
   * otherwise, which is why this lives behind a button and never runs on load.
   * Rejects with a readable message so the pane can show it.
   */
  async enablePush(): Promise<void> {
    const before = this.get().push;
    this.set({ push: { ...before, busy: true, error: null } });
    try {
      const status = await this.backend.pushStatus();
      if (!status.supported) {
        throw new Error(status.reason ?? "this backend does not send push notifications");
      }
      const payload = await subscribeThisDevice(status.public_key);
      const registered = await this.backend.pushSubscribe(payload);
      this.set({
        push: {
          ...this.get().push,
          busy: false,
          error: null,
          endpoint: payload.endpoint,
          devices: registered.devices,
          environment: readPushEnvironment(),
          blocker: null,
        },
      });
      playCue("success");
    } catch (e) {
      const message = errText(e);
      this.set({
        push: {
          ...this.get().push,
          busy: false,
          error: message,
          environment: readPushEnvironment(),
        },
      });
      playCue("error");
      throw e;
    }
  }

  /** Turn notifications off for this device: drop the browser subscription and have
   *  the backend forget the endpoint. Both halves, or a dead endpoint would keep
   *  collecting failed deliveries. */
  async disablePush(): Promise<void> {
    const before = this.get().push;
    this.set({ push: { ...before, busy: true, error: null } });
    try {
      const endpoint = (await unsubscribeThisDevice()) ?? before.endpoint;
      const status = endpoint ? await this.backend.pushUnsubscribe(endpoint) : null;
      this.set({
        push: {
          ...this.get().push,
          busy: false,
          endpoint: null,
          devices: status?.devices ?? this.get().push.devices,
        },
      });
      playCue("success");
    } catch (e) {
      this.set({ push: { ...this.get().push, busy: false, error: errText(e) } });
      playCue("error");
      throw e;
    }
  }

  /** Ask the backend to push a test notification to every subscribed device.
   *  Resolves with what it managed to deliver, so the pane can say "sent to 1
   *  device" instead of leaving the user watching a lock screen. */
  async testPush(): Promise<{ delivered: number; failed: number; errors: string[] }> {
    const before = this.get().push;
    this.set({ push: { ...before, busy: true, error: null } });
    try {
      const report = await this.backend.pushTest();
      this.set({
        push: {
          ...this.get().push,
          busy: false,
          error: report.failed > 0 ? (report.errors[0] ?? "delivery failed") : null,
        },
      });
      // A test that reached no device is a failure, even though the request itself
      // answered — so the cue follows the delivery, not the round trip.
      playCue(report.delivered > 0 && report.failed === 0 ? "success" : "error");
      return report;
    } catch (e) {
      this.set({ push: { ...this.get().push, busy: false, error: errText(e) } });
      playCue("error");
      throw e;
    }
  }

  /** Ask the backend to repair sign-in by restarting the Intune container.
   *
   *  Marks the broker as repairing straight away, so the button disables before the
   *  backend's own event arrives, and REJECTS on refusal so the banner can say why
   *  (the backend's refusal text is the useful part: a missing write token, or
   *  read-only mode). The repair drops the socket a moment later; the page's own
   *  reconnect brings it back — see `watchWakeups` and the `reconnected` handler. */
  async repairBroker(): Promise<void> {
    const before = this.get().brokerStatus;
    if (before) this.set({ brokerStatus: { ...before, repairing: true } });
    try {
      await this.backend.repairBroker();
    } catch (e) {
      if (before) this.set({ brokerStatus: { ...before, repairing: false } });
      // A refused repair sounds; an accepted one does not. The repair only STARTS
      // here — the socket drops a moment later and the reconnect is the real answer,
      // so a success cue now would applaud a result nobody has yet.
      playCue("error");
      throw e;
    }
  }

  /** Start downloading the new build (the update control's first click).
   *
   *  Moves to `downloading` here rather than waiting for the backend's first frame, so
   *  the button reacts to the press at once; the real progress replaces it a moment
   *  later, and a refusal puts the failure — with the backend's own words, which is the
   *  useful part — where the button can show it. */
  async downloadUpdate(): Promise<void> {
    const total = this.get().update?.size ?? 0;
    this.set({ updateProgress: { phase: "downloading", received: 0, total, error: "" } });
    try {
      this.set({ updateProgress: await this.backend.updateDownload() });
    } catch (e) {
      playCue("error");
      this.set({
        updateProgress: {
          phase: "failed",
          received: 0,
          total,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  /** Install what was downloaded and restart the app onto it (the second click).
   *
   *  The socket drops seconds later — that IS the restart — so this deliberately does
   *  not wait for anything more: `restarting` is a state the control keeps drawing while
   *  disconnected, and the page's own reconnect is what ends it. */
  async applyUpdate(): Promise<void> {
    const previous = this.get().updateProgress;
    const total = this.get().update?.size ?? 0;
    this.set({ updateProgress: { phase: "restarting", received: total, total, error: "" } });
    try {
      await this.backend.updateApply();
    } catch (e) {
      playCue("error");
      this.set({
        updateProgress: {
          phase: "failed",
          received: previous?.received ?? total,
          total,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  /** Resolve rich metadata for a tracker link (or null when no integration
   *  recognizes it), going through the backend. Cached and de-duplicated per URL;
   *  a transient failure is evicted so a later render can retry. */
  enrichLink(url: string): Promise<LinkMetadata | null> {
    const cached = this.linkCache.get(url);
    if (cached) return cached;

    const pending = this.backend.enrichLink(url).then((res) => {
      const meta = res.metadata ?? null;
      this.linkResolved.set(url, meta);
      return meta;
    });
    this.linkCache.set(url, pending);
    pending.catch(() => this.linkCache.delete(url));
    return pending;
  }

  /** What `enrichLink` has already resolved for this URL, without awaiting: the
   *  metadata, `null` when no integration claims the link, or `undefined` when this
   *  session has not resolved it yet. A renderer uses it to draw a known card on its
   *  FIRST render — see `linkResolved` for why that timing decides whether the
   *  history jumps. */
  cachedLink(url: string): LinkMetadata | null | undefined {
    return this.linkResolved.get(url);
  }

  /** Re-enrich a link, bypassing the cached value but replacing it, so a later
   *  render sees the freshest result. Used to keep a live signal current — a
   *  merge request's pipeline status while its CI is still running. A transient
   *  failure is evicted (not cached) so a subsequent lookup can retry. */
  refreshLink(url: string): Promise<LinkMetadata | null> {
    const pending = this.backend.enrichLink(url).then((res) => {
      const meta = res.metadata ?? null;
      this.linkResolved.set(url, meta);
      return meta;
    });
    this.linkCache.set(url, pending);
    pending.catch(() => this.linkCache.delete(url));
    return pending;
  }

  cancelReply(): void {
    this.set({ replyingTo: null });
  }

  /**
   * Edit one of our own messages in place. The backend replaces the message
   * over the network and broadcasts the new content as a live `message` event,
   * which reconciles into the cache by id (see `wireEvents`), so we only need to
   * fire the request and surface failures.
   */
  async editMessage(messageId: string, text: string): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    const clean = text.trim();
    if (!clean) return false;
    try {
      await this.backend.edit(id, messageId, clean);
      return true;
    } catch (e) {
      this.set({ status: `edit failed: ${errText(e)}` });
      playCue("error");
      return false;
    }
  }

  /**
   * Delete one of our own messages. IRREVERSIBLE: it leaves the thread for everybody
   * in it, on every device, so the caller must have taken an explicit confirmation
   * from the user first (see the actions menu in `message-bubble.tsx`).
   *
   * Like `editMessage`, the backend does the outward call, flags its own row and
   * broadcasts the result, which reconciles into the cache by id (see `wireEvents`) —
   * so the bubble becomes the deletion placeholder without anything optimistic here.
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    try {
      await this.backend.deleteMessage(id, messageId);
      return true;
    } catch (e) {
      this.set({ status: `delete failed: ${errText(e)}` });
      playCue("error");
      return false;
    }
  }

  /**
   * React to a message with an emoji, or toggle our reaction off. The backend
   * toggles (clicking our current reaction removes it), applies it optimistically
   * on its side, and re-broadcasts the message, which reconciles into the cache
   * by id (see `wireEvents`) — so we only fire the request and surface failures,
   * exactly like `editMessage`.
   */
  async reactToMessage(messageId: string, key: string): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    try {
      await this.backend.react(id, messageId, key);
      return true;
    } catch (e) {
      this.set({ status: `reaction failed: ${errText(e)}` });
      playCue("error");
      return false;
    }
  }

  /**
   * Send one snapshot of the composer. The snapshot stays visible while the
   * request is pending and after a failure. A successful request clears only the
   * exact submitted text, so text entered during the request is never erased.
   *
   * `mentions` says who the body's mention spans name (the spans themselves carry only
   * an index), which is what makes Teams notify those people.
   */
  async sendDraft(
    text: string,
    html?: string,
    image?: SendImage,
    mentions?: OutboundMention[],
  ): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    const clean = text.trim();
    const richHtml = html?.trim() || undefined;
    if (!clean && !richHtml && !image) return false;

    const submittedDraft = this.draftCache.get(id) ?? this.get().draft;
    const reply = this.get().replyingTo;
    const replyTo: ReplyTo | undefined = reply
      ? replyToPayload(reply.message, "", clean)
      : undefined;

    try {
      await this.backend.send(id, clean, replyTo, richHtml, image, mentions);
    } catch (e) {
      // Both surfaces, and each has its reader. The status line keeps the RAW failure,
      // which is what a developer reads off a screenshot; the composer gets one sentence
      // for the person who pressed the button, next to the words that did not leave (see
      // lib/send-failure.ts). Only the open conversation is told: the message failed in
      // this one, and a sentence about it hanging over another thread would name nothing.
      this.set({ status: `send failed: ${errText(e)}` });
      if (this.get().openId === id) this.set({ sendError: sendFailureMessage(e) });
      playCue("error");
      return false;
    }

    // No cue on a sent message. The composer clearing and the message appearing in
    // the thread already say it left, and a chime on every send is noise in the one
    // action the user repeats all day. A FAILED send still sounds, above: that one
    // the user must notice.
    if (this.draftCache.get(id) === submittedDraft) {
      const pending = this.draftSaveTimers.get(id);
      if (pending) {
        clearTimeout(pending);
        this.draftSaveTimers.delete(id);
      }
      this.draftCache.set(id, "");
      this.persistDraft(id, "");
      if (this.get().openId === id) this.set({ draft: "" });
    }
    if (this.get().openId === id) {
      this.set({
        replyingTo: this.get().replyingTo === reply ? null : this.get().replyingTo,
        scrollToBottomNonce: this.get().scrollToBottomNonce + 1,
        // A message that left answers the last one that did not.
        sendError: null,
      });
    }
    return true;
  }

  // ---- appearance (Light / Dark / System) ---------------------------------

  private systemPrefersDark(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  /** Apply a resolved theme to <html> so the whole palette repaints, and keep the
   *  `theme-color` meta in step — an installed app paints its status-bar band from
   *  it, so switching to Dark must not leave a white strip above the app. The
   *  pre-hydration bootstrap in routes/__root.tsx creates that meta. */
  private paintTheme(theme: ResolvedTheme): void {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLORS[theme]);
  }

  /** Watch the OS dark-mode query while (and only while) following the system. */
  private attachDarkQuery(): void {
    if (this.darkQuery || typeof window === "undefined" || !window.matchMedia) return;
    this.darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.darkListener = () => {
      if (this.get().appearance !== "system") return;
      const theme = this.systemPrefersDark() ? "dark" : "light";
      this.paintTheme(theme);
      this.set({ resolvedTheme: theme });
    };
    this.darkQuery.addEventListener("change", this.darkListener);
  }

  private detachDarkQuery(): void {
    if (this.darkQuery && this.darkListener) {
      this.darkQuery.removeEventListener("change", this.darkListener);
    }
    this.darkQuery = null;
    this.darkListener = null;
  }

  private applyPersistedAppearance(): void {
    let pref: Appearance = DEFAULT_APPEARANCE;
    try {
      pref = coerceAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY));
    } catch {
      /* ignore */
    }
    const theme = resolveTheme(pref, this.systemPrefersDark());
    this.paintTheme(theme);
    this.set({ appearance: pref, resolvedTheme: theme });
    if (pref === "system") this.attachDarkQuery();
  }

  /** Commit and persist an appearance preference. */
  setAppearance(pref: Appearance): void {
    const theme = resolveTheme(pref, this.systemPrefersDark());
    this.paintTheme(theme);
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, pref);
    } catch {
      /* ignore */
    }
    this.set({ appearance: pref, resolvedTheme: theme });
    if (pref === "system") this.attachDarkQuery();
    else this.detachDarkQuery();
  }

  /** Preview an appearance without persisting (live hover in the picker). */
  previewAppearance(pref: Appearance): void {
    this.paintTheme(resolveTheme(pref, this.systemPrefersDark()));
  }

  /** Revert a preview back to the committed appearance. */
  revertAppearance(): void {
    this.paintTheme(this.get().resolvedTheme);
  }

  // ---- interaction sounds (cuelume) ----------------------------------------

  /** Load the persisted sound preference, apply it to the engine, and wire up the
   *  `data-cuelume-*` delegation for button press/hover/toggle cues. Best-effort
   *  and SSR-safe: a storage failure just leaves the default (on). */
  private applyPersistedSounds(): void {
    let enabled = DEFAULT_SOUNDS_ENABLED;
    try {
      enabled = coerceSoundsEnabled(localStorage.getItem(SOUNDS_STORAGE_KEY));
    } catch {
      /* ignore — sounds are non-critical */
    }
    this.set({ soundsEnabled: enabled });
    setCuesEnabled(enabled);
    // Delegate button cues app-wide. The engine gates every cue on the flag set
    // just above, so this is safe to call even when sounds are off.
    bindCues();
  }

  /** Commit and persist the sound preference, and flip the engine's global flag.
   *  Turning sounds back on plays a short confirmation cue (which turning them
   *  off deliberately does not). */
  setSoundsEnabled(enabled: boolean): void {
    try {
      localStorage.setItem(SOUNDS_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      /* ignore — a failed persist just doesn't survive reload */
    }
    this.set({ soundsEnabled: enabled });
    setCuesEnabled(enabled);
    if (enabled) playCue("ready");
  }
}

/** Why a call attempt failed, in words the user can act on.
 *
 *  A refused microphone is the one failure that is not a bug, and it is the common one:
 *  the browser asks once, the user says no, and every later call fails the same way
 *  until they change it in the site settings. So it gets its own sentence rather than a
 *  `NotAllowedError` the page would show verbatim. */
function callErrorText(e: unknown): string {
  if (e instanceof MicrophoneUnavailableError) {
    return "teams-lite could not open the microphone. Allow it for this site, then try again.";
  }
  return errText(e);
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  // Browser WebSocket/DOM failures arrive as opaque Events that stringify to a
  // useless "[object Event]"; prefer any message they carry, else say something
  // readable. The final guard rescues plain objects from "[object Object]" too.
  if (typeof Event !== "undefined" && e instanceof Event) {
    const msg = (e as { message?: unknown }).message;
    return typeof msg === "string" && msg ? msg : "connection error";
  }
  const s = String(e);
  return s.startsWith("[object ") ? "unknown error" : s;
}

/** Decode a base64 string (as returned by the backend media proxy) to an
 *  ArrayBuffer, suitable for constructing a Blob. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buffer;
}
