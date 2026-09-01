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
import {
  channelMentionCandidate,
  dedupeCandidates,
  type MentionCandidate,
  type OutboundMention,
} from "./mentions";
import {
  appendLiveMessage,
  chatIsMuted,
  chatIsPinned,
  copyableMessageText,
  fullSizeMediaUrl,
  mergeOlderHistoryPage,
  mergeOlderMailPage,
  mergeRefreshedHistoryPage,
  mergeRefreshedMailPage,
  replyToPayload,
  messageIsHeld,
  shouldNotify,
  withoutWireLine,
  trimHistoryPage,
  mergeCalendarWindow,
  mailAddressSpellsAPerson,
  mailDomain,
  registrableMailDomain,
  type AddressPerson,
  type AvatarPicture,
  type AppSettings,
  type PresenceSchedule,
  type LinearWorkspace,
  type BrokerStatus,
  type SigninState,
  INITIAL_SIGNIN,
  type CalendarEvent,
  type BackendRestartResult,
  type CalendarInfo,
  type CalendarViewResult,
  type CallSignal,
  type CallSignalFrame,
  type Channel,
  type ChatMessage,
  type ChatPrefs,
  type Conversation,
  type CustomEmoji,
  type IncomingCall,
  type GitLabApproval,
  type GitLabApprovalResult,
  type LinkMetadata,
  type LiveStatus,
  type MailBody,
  type MailFolder,
  type MailHeader,
  type MailPage,
  type MessagePage,
  type Notification,
  type NotificationTab,
  type NotifyPlacement,
  type PersonPresence,
  type PersonOverride,
  type PersonProfile,
  type ReactionPick,
  type ReadReceipt,
  type ReadReceiptSignal,
  type ReplyTo,
  type SealSetResult,
  type SealStatus,
  type SettingsPatch,
  type TypingName,
  type TypingSignal,
  type UpdateCheckResult,
  type UpdateInfo,
  type UpdateProgress,
  type WriteLock,
  channelLabel,
  isChannelThreadId,
  UNKNOWN_WRITE_LOCK,
} from "./protocol";
import { channelLayoutOf, threadReplyQuotes, threadRootOf, type ChannelLayout } from "./threads";
import {
  chessMessageHtml,
  chessMessageText,
  type ChessLedger,
  type ChessWire,
} from "./chess-wire";
import { NO_CHESS_ENGINE, type ChessEngineState } from "./chess-engine";
import { NO_CHESS_SOUNDS, type ChessSoundsState } from "./chess-sound";
import { chessGamesInThread, chessSlotKey, type ChessGame } from "./chess-thread";
import { petMessageHtml, petMessageText } from "./pet-wire";
import { petSlotKey, PET_PAT_KEY } from "./pet-thread";
// The publish is a TYPE here and nothing more, so the skins pet-act reaches for are not dragged into
// the store's own chunk: what a press writes is decided in pet-act.ts, and this only posts it.
import type { PetPublish } from "./pet-act";
import type { PetFoldAct } from "./pet-state";
import {
  DEFAULT_PETS_SHOWN,
  PETS_SHOWN_STORAGE_KEY,
  coercePetsShown,
  petsShownValue,
} from "./pet-visibility";
import type { AgentMode, AgentProviderPatch, AgentStatus } from "./agent";
import type { AgentPersonaPatch } from "./agent-persona";
import {
  AGENT_RUN_STALE_MS,
  agentRunIsLive,
  agentTranscriptOf,
  keepAgentTranscript,
  parseAgentFrame,
  withAgentFrame,
  withoutAgentRun,
  type AgentRun,
  type AgentTranscript,
} from "./agent-run";
import {
  UNKNOWN_CALL_STATUS,
  callEndLabel,
  holdsMicrophone,
  isLive,
  modalityFor,
  type ActiveCall,
  type CallMediaSignal,
  type CallStatus,
  type MeetingAddress,
} from "./call";
import { callStageTitle } from "./call-stage";
import { uploadKey, type UploadRef } from "./gitlab-upload";
import {
  simulatedCallMedia,
  startCallMedia,
  type CallAudio,
  type CallMedia,
  type LocalVideo,
  type RemoteVideo,
  type SendKind,
} from "./call-media";
import {
  callFailureMessage,
  captureDroppedMessage,
  captureRefusedMessage,
  renegotiationRefusedMessage,
} from "./call-failure";
import {
  canExpandDiff,
  FILES_COLUMN_DEFAULT_WIDTH,
  SYMBOLS_PANEL_DEFAULT_WIDTH,
  type DiffDepth,
  type DiffLayout,
  type GitLabDiff,
} from "./gitlab-diff";
import {
  diffCommentPosition,
  diffCommentTarget,
  diffCommentsAvailable,
  pierreSideOf,
  type DiffCommentTarget,
  type DiffLineSelection,
  type PierreLineRange,
  type PierreSide,
} from "./gitlab-diff-comment";
import {
  symbolIsSearchable,
  symbolOccurrences,
  type DiffSymbolTarget,
} from "./gitlab-diff-symbols";
import {
  REVIEW_CHAT_DEFAULT_WIDTH,
  reviewTagsToWire,
  type GitLabReview,
  type GitLabReviewChat,
  type PendingReviewQuestion,
  type ReviewTag,
} from "./gitlab-review";
import { jobLogIsLive } from "./gitlab-job-log";
import {
  isNotMerged,
  mergeRequestId,
  pipelineIsLive,
  sameMergeRequest,
  type GitLabDiscussionList,
  type GitLabJobLog,
  type GitLabPipelineView,
  type MergeRequestDetail,
  type MergeRequestKey,
  type MergeRequestList,
  type MergeRequestRow,
  type MergeRequestScope,
  type MergeRequestState,
} from "./gitlab-mr";
import {
  RECORDING_EMPTY_MESSAGE,
  callCanBeRecorded,
  recordingFailureMessage,
  recordingSavedMessage,
  recordingSources,
  type CallRecording,
} from "./call-recording";
import { startCallRecorder, type CallRecorder, type RecordingInput } from "./call-recorder";
import {
  deleteRecording as deleteStoredRecording,
  getRecordingBlob,
  listRecordings,
  putRecording,
  recordingsCanBeKept,
} from "./recording-store";
import { CALL_NOTICE, RECORDING_NOTICE, dismissNotice, showNotice } from "./notice";
import { coalesce } from "./singleflight";
import {
  requestRange,
  shiftAnchor,
  startOfDay,
  visibleRange,
  type CalendarViewMode,
} from "./calendar";
import { notifyCall, notifyMessage } from "./notify";
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

export type PendingReply = {
  message: ChatMessage;
  marker: string | null;
  /** The CHANNEL THREAD this reply is a post in, or `null` in a chat, which has no threads.
   *
   *  Resolved ONCE, where the reply starts, because three surfaces ask it and two answers
   *  would disagree: the send addresses the thread with it (`teams_send::parse_thread_root`),
   *  the thread's own card lights up while it is the one being answered, and the composer's
   *  banner says the reader is posting IN a thread rather than quoting a message. */
  threadRoot: string | null;
};

/** The recording in flight, as the UI reads it.
 *
 *  It carries no blob and no recorder: those are non-reactive fields on the controller, and a
 *  `MediaRecorder` in reactive state would be replaced by a re-render. What a page needs to
 *  draw is which call it belongs to, when it started, and whether it is being wound up. */
export type LiveRecording = {
  id: string;
  callId: string;
  startedAtMs: number;
  /** True from the moment the user presses stop until the file is written. It is a state of
   *  its own because writing a long recording out takes a moment, and a control that snapped
   *  back to "record" in it would invite a second recording of nothing. */
  saving: boolean;
};

/** Which sidebar list is showing: normal chats, the team/channel tree, or the
 *  mailbox. Each is a distinct source — a channel never appears in the chat list,
 *  and mail is a different backend surface entirely — so this is a hard switch. */
export type SidebarTab = "chats" | "channels" | "mail" | "calendar" | "gitlab";

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
  /** Chats the user marked unread HERE (chat id → true), persisted to localStorage.
   *  Not part of `chatPrefs`: that is where a chat SITS in the list, and this is what
   *  its row says. Read through `chatIsUnread`, cleared by opening the chat or by
   *  marking it read. */
  chatUnreads: Record<string, boolean>;
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
  /** How an interactive sign-in is going, if one is (see src/signin.rs and SIGN-IN.md).
   *
   *  Always a shape, never null: the backend's own "nothing is going on" is `idle`, so one
   *  field decides whether the panel is drawn and a backend too old to answer is never
   *  mistaken for a sign-in in progress. It lives here rather than in the panel because a
   *  sign-in is exactly when a reader changes device — press it on the laptop, pick up the
   *  phone for the Authenticator — so every open page follows the same flow. The FRAMES are
   *  deliberately not here: they are one component's business and would put a PNG a second
   *  through the whole app's state. */
  signin: SigninState;
  /** True once the reader put the panel away, until they ask for another sign-in.
   *
   *  Dismissing does not touch the flow (see `dismissSignin`), so the backend keeps reporting
   *  it — and without this the modal came BACK on its own when the flow settled, possibly ten
   *  minutes later, over whatever the reader was doing by then. */
  signinDismissed: boolean;
  /** Where this page stands with the backend's write lock, or null until it answers.
   *
   *  It is a state about the whole app rather than about one button: `foreign` means
   *  every send, reaction, mark-as-read and update will be refused while every read keeps
   *  working, which is the one failure this app cannot let itself look healthy through.
   *  Null and `unknown` must stay silent — the mock and an older backend never answer —
   *  and `read_only` is silent too, because there refusing is the feature. See
   *  {@link writeLockNeedsAttention}. */
  writeLock: WriteLock | null;
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
  /** Why the last CHESS message did not leave, in the same one sentence and for the same
   *  reason (see {@link sendFailureMessage}). It is its own slice rather than `sendError`
   *  because it is drawn somewhere else — at the board, where the player pressed — and a
   *  failed move reported over the composer would be a sentence about words nobody typed. */
  /**
   *  KEYED BY GAME (`chessSlotKey`), because a conversation holds several at once: one slot drew
   *  the sentence about a refused move under EVERY board in the thread, including the games it
   *  had nothing to do with.
   */
  chessError: Record<string, string>;
  /** A chess move that has left this page and whose message has not come back yet, per GAME.
   *
   *  The board draws it at once, because a board that waits for a round trip before the piece
   *  moves feels broken — and it is taken back if the publish fails, which is the rule
   *  `removeSentWords` follows for the words. The KEY names the conversation and the game, so a
   *  move pending in one game can never be drawn onto another one's board — and a reader who
   *  moves in two games before either message comes back keeps both. */
  chessPending: Record<
    string,
    {
      ply: number;
      san: string;
      /** What the mover stated they had left, and WHEN they moved. Both are what the two
       *  clocks are read from, so the optimistic board keeps counting the right one down
       *  rather than freezing until the message comes back. */
      clockMs: number | null;
      at: number;
    }
  >;
  /** Why the last PET act did not leave, in the same one sentence (see {@link sendFailureMessage}).
   *
   *  KEYED BY PET (`petSlotKey`), for the reason a chess error is keyed by game: a conversation holds
   *  a creature per person, so one slot would draw the sentence about a refused feed under every pet
   *  in the thread — including the ones the press had nothing to do with. The pet it is keyed by is
   *  the one the reader PRESSED ON (`PetPublish.pet`), which for a feed on a colleague's creature is
   *  theirs rather than ours: that is where the reader is looking. */
  petError: Record<string, string>;
  /**
   * Every PET-carrying message one conversation's WHOLE STORED HISTORY holds, keyed by conversation —
   * merged into the loaded history before the creatures are folded out of it (`withPetArchive`).
   *
   * It is `chessArchive`'s shape for a sharper reason, and the difference decides where it is read.
   * There the whole-history read buys a head-to-head SCORE, so it is a second opinion beside the
   * derivation; here it feeds the derivation ITSELF, because a pet's ledger message keeps the `seq` it
   * was first posted at and pages out of the loaded window while the creature is alive — at which point
   * the app drew no pet of the reader's own and OFFERED THEM A SPAWN, which posts an arrival message
   * for a creature they already own and can no longer reach. `withPetArchive` argues it in full.
   *
   * It holds MESSAGES rather than folded pets, unlike `chessArchive`'s games, for that same reason: the
   * fold has to run over the union, and a fold of the archive alone would be a second set of creatures
   * to reconcile with the first.
   *
   * Empty until a conversation asks, which is what keeps it off the path of a reader who has turned
   * companions off.
   */
  petArchive: Record<string, ChatMessage[]>;
  /** The publish this page has in flight in a conversation, with the act it draws before the message
   *  comes back — or no entry, which is what lets the next press go out.
   *
   *  A pet reacts to a feed AT ONCE, because a creature that waits for a round trip before it stops
   *  being hungry reads as one that ignored you — and the act is TAKEN BACK if the publish fails,
   *  which is the rule `removeSentWords` follows for the words.
   *
   *  **THE GRAIN IS THE CONVERSATION, AND THAT IS THE WHOLE POINT OF THE SLOT.** A reader's ledger is
   *  ONE message for the whole conversation, so every press they make contends on that one message —
   *  a feed on a colleague's pet, a nap on their own, a removal. Each publish is built from the
   *  record as the page currently holds it, so two in flight at once both start from N acts, both
   *  write N+1, and the later edit wins: one act SILENTLY GONE from a record that is the only copy
   *  there is. Keyed per PET this is invisible, because two presses on two pets are two edits of one
   *  message and no per-pet check sees a conflict. So `publishPetLedger` takes this slot and refuses
   *  a second publish while it is held, which serializes the writes; the pet is kept beside the act
   *  so the layer can still draw it on the right creature. `petError` stays keyed per PET, because a
   *  refusal belongs to the creature the press was about. Chess is protected by the same rule one
   *  layer up — `use-chess-game.ts` will not move "with anything of theirs already in flight" — and
   *  this holds it in the one place every surface goes through.
   *
   *  **IT IS RELEASED ON SUCCESS AS WELL AS ON FAILURE**, which is where it differs from
   *  `chessPending`: the backend's `edit` handler writes the local row and emits the `message` event
   *  BEFORE it answers `{edited: true}` (src/bin/server.rs), so by the time the promise resolves the
   *  derived ledger already states the act and a pending copy of it would be counted twice. What the
   *  ordering really buys is a BOUND rather than a proof: the event and the response travel to this
   *  page over the same socket but not necessarily through the same queue, so what is left is a
   *  window of at most a frame or two in which the act may show nowhere — over a stat that decays
   *  two points an hour, nothing a reader can see, and nothing that landed can be lost.
   *
   *  **AND THAT ORDERING IS THE `edit` HANDLER'S ALONE — IT DOES NOT TRANSFER TO A SPAWN.** A spawn
   *  is the one publish here that is a `send`, and the `send` arm neither writes the local row nor
   *  emits anything: it answers `{sent: true}` and the message reaches this page only on the trouter
   *  echo. Nothing in this store inserts optimistically either. So releasing the slot on success
   *  leaves a real window in which the creature is nowhere on this page — 150 ms against the mock,
   *  one round trip against the tenant, unbounded while the live feed is reconnecting — and a second
   *  press inside it MINTS A SECOND id and SENDS AGAIN, which the fold absorbs whole: two visible
   *  arrival messages, one drawing no creature, and `despawn` edits the first, so nothing in this
   *  feature can reach the other again. Reading this paragraph as "the message is always back by the
   *  time the promise resolves" is what produced that bug. The window is held shut by the one control
   *  that can spawn (`spawnTravelling` in components/conversation-menu.tsx) rather than by this slot,
   *  which would need a release path that is not the promise. */
  petPending: Record<string, { pet: string; act: PetFoldAct | null }>;
  /** The move the reader has set to play the MOMENT their opponent's lands — a premove.
   *
   *  It is the app's state rather than the board's because it outlives a remount: the reader
   *  may set one on the inline card and walk into the full-screen page, and a premove that
   *  vanished on the way would be a move they believe is queued. It names the conversation and
   *  the game for the reason a pending move does, and it costs {@link PREMOVE_SPEND_MS} of
   *  their clock rather than the time their opponent spent thinking. */
  chessPremove: Record<string, { from: string; to: string; promotion?: "q" | "r" | "b" | "n" }>;
  /**
   * Every game one conversation's WHOLE STORED HISTORY holds, keyed by conversation — what the
   * head-to-head score is counted over (see lib/chess-series.ts).
   *
   * It is the backend's own read (`chess_messages`) put through THIS app's one derivation, so the
   * wire has exactly one spelling and the backend never needs the rules. It is a SNAPSHOT: the
   * thread's own live games win over it per game id (`chessSeriesGames`), because a game that
   * finished a moment ago is settled in the thread and still running in here.
   *
   * Empty until a board asks, which is what keeps this off the path of every chat.
   */
  chessArchive: Record<string, ChessGame[]>;
  /**
   * What this machine holds of the CHESS ENGINE: whether it is here, what fetching it costs, how far
   * a fetch has got, and why one failed.
   *
   * It is the BACKEND's answer (`chess_engine_status`, refreshed by every `chess_engine_progress` event), because
   * the engine is 7.3 MB on this machine's disk rather than anything in a browser — so two open pages
   * see one truth, and a page that reloads mid-download picks the bar back up.
   */
  chessEngine: ChessEngineState;
  /**
   * What this machine holds of the board's own SOUNDS — chess.com's twelve recordings.
   *
   * It is the BACKEND's answer (`chess_sound_status`, refreshed by `chess_sound_changed`), because
   * they are 64 KB on this machine's disk served from this app's own origin rather than anything a
   * page fetched. `present: false` is the safe reading as well as the honest one: it means the
   * synthesized palette plays, so a board never goes silent waiting for this.
   */
  chessSounds: ChessSoundsState;
  /** Every message Teams is HOLDING for this account, soonest first — what "see all
   *  scheduled messages" lists. Loaded on demand and after anything that changes it;
   *  empty until then, because a list nobody has opened is a read nobody asked for. */
  scheduledMessages: ChatMessage[];
  /** Words handed BACK to a composer that is already open — today only from the scheduled
   *  list, whose Edit cancels a queued message and returns it to be written again.
   *
   *  It needs a slice of its own because `draft` seeds the editor at MOUNT: the editor is
   *  keyed per conversation, so setting the draft of the thread already on screen changes
   *  nothing the reader can see. The token is what applies it exactly once, which is the
   *  shape `agentAnswer` already uses for the same reason. */
  composerRestore: {
    conversation: string;
    text: string;
    /** The TITLE that message had, where it had one — a channel post handed back from the
     *  scheduled list. Absent for every untitled one. */
    subject?: string;
    token: number;
  } | null;
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
   *  registered. The backend decides it — there is no switch in this app, and a
   *  page holds no preference of its own about calling. */
  callStatus: CallStatus;
  /**
   * The video arriving on the call right now — a colleague's camera, a colleague's shared
   * screen. Empty whenever there is nothing to draw, which is most calls.
   *
   * It holds live `MediaStream` objects, so it is deliberately NOT part of anything that is
   * serialized or compared by value: a tile is attached to its element by identity, and
   * replacing the stream restarts the picture.
   */
  callVideo: RemoteVideo[];
  /** What THIS page is sending, for the preview only the sender sees. The MEETING's view of
   *  it is `callStatus.call.sending`, which the backend publishes to every client so two open
   *  pages agree and a reconnecting one is told rather than guessing. */
  callLocalVideo: LocalVideo[];
  /**
   * Whose picture is on each section, keyed by mid.
   *
   * A section says what it carries (a screen, a camera) and never WHOSE it is: the person is
   * on the other side of the subscription, in the roster. So the name is recorded at the
   * moment this page asks for that source, which is the one point where both halves are in
   * one place — and it is what lets a tile say "Clément's screen" rather than "a screen".
   */
  callVideoNames: Record<string, string>;
  /**
   * The recording running right now, or null.
   *
   * teams-lite's own, and Teams is never told: it is made in this page out of the streams
   * the call already carries, and it is kept in this browser (see lib/call-recording.ts).
   * The state is the PAGE's rather than the backend's — unlike `call.sending`, which the
   * backend publishes so two open pages agree — because nothing outside this page knows a
   * recording exists, and a second page claiming to be recording would be claiming to hold
   * a file it does not have.
   */
  callRecording: LiveRecording | null;
  /** Every recording this browser holds, newest first. Metadata only: the files are read
   *  from storage when one is played or saved (see lib/recording-store.ts). */
  recordings: CallRecording[];
  /** Whether this browser can keep a recording at all. False means no IndexedDB — a private
   *  window that refuses one, an ancient browser — and the control is not offered, because a
   *  recording that could not be kept is a recording nobody asked for. */
  recordingsCanBeKept: boolean;
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
  /** How each CHANNEL this page has opened is laid out, by channel id — Teams' own choice, read
   *  once per channel WITH its history and kept for the session (see `channelLayoutFor`). A
   *  channel absent here is drawn as POSTS, which is the answer for every classic channel and
   *  the surface this app drew before the layout was read at all. */
  channelLayouts: Record<string, ChannelLayout>;
  /** User appearance preference (System follows the OS). */
  appearance: Appearance;
  /** Concrete theme currently applied to <html> (what CSS keys off). */
  resolvedTheme: ResolvedTheme;
  /** Whether curated interaction sounds play (client-only preference). Gates the
   *  cuelume engine globally — imperative cues and `data-cuelume-*` alike. */
  soundsEnabled: boolean;
  /** Whether THIS WINDOW draws the conversations' companions (client-only preference, beside
   *  the sounds and for its reasons — see lib/pet-visibility.ts). False means the overlay is not
   *  mounted at all; it never means a pet was put down, which is its own menu's Remove. */
  petsShown: boolean;
  /** Non-secret app settings (the GitLab host + whether each integration's token
   *  is stored + Ghost mode), loaded from the backend on start. Drives which links
   *  get rich previews, and whether reading a chat is declared to Teams. */
  settings: AppSettings;
  /** The Linear workspace this machine's key belongs to, or null while it is unknown —
   *  no key, a key Linear refused, a read that failed, or a backend too old to answer.
   *
   *  It is what turns a bare `STMN-3439` written anywhere into a link to that issue (see
   *  lib/tracker-ref.ts). Null means no bare identifier is recognised, which is the reading
   *  every unanswered capability takes in this app: a hopeful guess would draw a chip
   *  pointing at a workspace nobody named. GitLab needs no counterpart here — its host is
   *  in `settings`, so a `!42` is addressed from what the page already holds. */
  linearWorkspace: LinearWorkspace | null;
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
  /** What the runs this page WATCHED worked out, by the message each one wrote into.
   *  The overlay is transient; this is not, because the reasoning exists nowhere else —
   *  the Teams message holds the answer alone. Bounded, and gone on a reload. */
  agentTranscripts: Record<string, AgentTranscript>;
  /** Which of those panels the reader opened or folded, by the same key. Their choice
   *  outlives the run and every remount of the row (see AgentStoredTranscript); a
   *  message nobody touched is absent, which leaves the fold automatic. */
  agentTranscriptsOpen: Record<string, boolean>;

  // ---- a sealed chat (see lib/seal.ts) -------------------------------------

  /** Which conversations this machine seals, and which passphrases it holds for each —
   *  null until the backend answers.
   *
   *  It carries no key and no passphrase: the backend is the encryption boundary, so the
   *  page never holds one (the secret leaves it only through `sealReveal`, on a press). Null
   *  rather than an empty status because the two say different things — nothing has been
   *  ASKED yet, versus nothing here is sealed — and every decision in lib/seal.ts reads null
   *  as "draw nothing about sealing", which is the reading every unanswered capability takes
   *  in this app. A hopeful empty status would tell the reader their next message goes out in
   *  the clear while the backend was about to seal it. */
  sealStatus: SealStatus | null;

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

  // ---- the GitLab merge-request page ----------------------------------------
  //
  // Loaded lazily like mail and the calendar: nothing here is fetched until the GitLab
  // tab is opened once. Every read is served from the backend's durable cache first, so
  // re-opening a merge request paints immediately and the fresh copy arrives on an event.

  /** Which merge requests the sidebar asks for. Persisted locally: it is a preference
   *  about this screen, not anything GitLab knows. */
  gitlabScope: MergeRequestScope;
  gitlabState: MergeRequestState;
  /** The rows on screen, newest activity first. */
  gitlabList: MergeRequestRow[];
  /** How many match, when GitLab said, and whether the list stops short of it. A list
   *  that stopped without saying so would read as a complete one. */
  gitlabTotal: number | null;
  gitlabTruncated: boolean;
  gitlabListLoading: boolean;
  /** Why the list could not be read, or null. Scoped to this page: GitLab failing must
   *  never break the chat surfaces. */
  gitlabListError: string | null;
  /** Whether this machine holds a GitLab token at all — the backend's own answer, carried
   *  by the list read. Without one the page can read nothing, so it says that instead of
   *  showing an empty list somebody would read as "no work".
   *
   *  TRUE until told otherwise: the notice must not flash in front of a list that is about
   *  to arrive, and an older backend that says nothing is one whose list still works. */
  gitlabTokenSet: boolean;

  /** The open merge request (mirrors the `/mr/<id>` route), or null. */
  openMergeRequest: MergeRequestKey | null;
  gitlabDetail: MergeRequestDetail | null;
  gitlabDetailLoading: boolean;
  gitlabDetailError: string | null;
  /** Its approval state, and whether the user's own approval is on. The same read the
   *  message menu uses (`gitlab_approvals`), so there is one answer in this app. */
  gitlabApproval: GitLabApproval | null;
  /** Its comments, and its pipeline with jobs. */
  gitlabNotes: GitLabDiscussionList | null;
  gitlabPipeline: GitLabPipelineView | null;
  /** ONE job's log, for the page a job card opens (`/mr/<id>/jobs/<jobId>`), or null when no job
   *  is open. It is not cached across opens for the pipeline's own reason: the backend holds a
   *  finished log for a day, so re-opening one is a local round trip, while a stale log of a
   *  RUNNING job is the one thing here that would be read as current. */
  gitlabJobLog: GitLabJobLog | null;
  /** Which job the URL asks for, whether or not its log has arrived. It is what a frame about
   *  another job is checked against, and what the header names while the read is travelling. */
  gitlabJobId: number | null;
  gitlabJobLogLoading: boolean;
  /** Why the log could not be read. This page IS that read, so a failure it never stated would
   *  be "Reading the log…" for ever — the rule the pipeline page already holds. */
  gitlabJobLogError: string | null;
  /** Why the pipeline could not be read, when nothing of it is on screen. The PANEL can fall
   *  back on the rest of the page, but the pipeline PAGE is that read and nothing else — so a
   *  failure it never stated would be "Reading the pipeline…" for ever. */
  gitlabPipelineError: string | null;
  /** What it CHANGED, for the Changes section. Read with the page, like the four above:
   *  reviewing the diff is what a merge-request page is for, so it is never behind a click.
   *  The RENDERER is lazy (see gitlab-diff-view.tsx) because Shiki carries a grammar per
   *  language; the read itself
   *  is measured at ~40 KB for a typical merge request on this instance. */
  gitlabDiff: GitLabDiff | null;
  gitlabDiffLoading: boolean;
  /** Reported inside the section rather than on the page: a diff that could not be read
   *  costs the Changes panel and nothing else, exactly as the comments do. */
  gitlabDiffError: string | null;
  /** Which file the reader is AT in the diff's feed, or null for "whichever `selectDiffFile`
   *  picks". It is what the file tree lights, and it moves two ways: a press on a row, and the
   *  reader scrolling the feed past the top of another file. Per merge request, so walking away
   *  and back opens where they stopped reading. */
  gitlabDiffPath: string | null;
  /** Whether the reader has asked for the expanded read of THIS merge request. Their ask,
   *  their merge request: it is not a preference, because the cost is per diff. */
  gitlabDiffDepth: DiffDepth;
  /** Unified or split, the reader's own choice, persisted per browser. A narrow screen
   *  overrides it to unified without forgetting it (see `effectiveDiffLayout`). */
  gitlabDiffLayout: DiffLayout;
  /** The NAME the reader pressed in the code, and where they pressed it — which is what the
   *  occurrences panel searches for and what says which line to light.
   *
   *  Per merge request only in the sense that it is dropped when one is opened or left: it is a
   *  question about the diff on screen, and carrying it to another branch would answer it about
   *  files that have nothing to do with the press. */
  gitlabDiffSymbol: DiffSymbolTarget | null;
  /** Whether the diff page should open on the CODE rather than on the file list, because the reader
   *  arrived by pressing a NAME in the reading's prose and has already answered which file.
   *
   *  A ONE-SHOT INTENT, consumed by that page on mount, and that is what makes it right where reading
   *  {@link gitlabDiffSymbol} would be wrong: the symbol OUTLIVES the visit — it is dropped only when
   *  a merge request is opened or left — so a reader who pressed a name, went back, and then opened
   *  the Diffs tab would find that page skipping its own file list on the strength of a press they
   *  made two surfaces ago. An intent says "this navigation", where a symbol says "this branch". */
  gitlabDiffOpenOnCode: boolean;
  /** The AI reading of this merge request's diff that this machine has made, or null. It is a
   *  reading of one COMMIT, and it carries the sha it read so the page can say when the branch has
   *  moved since (see `reviewIsStale`). */
  gitlabReview: GitLabReview | null;
  /** Whether a reading is being made right now. One at a time: a run is tens of seconds, and a
   *  reader who pressed again because nothing had happened yet would pay for two. */
  gitlabReviewBusy: boolean;
  /** Why a reading did not happen, in the CLI's or the backend's own words, reported where the press
   *  was made — the contract every outward-ish action in this app holds. */
  gitlabReviewError: string | null;
  /** The FOLLOW-UP questions asked about that reading, oldest first. Its own field rather than one
   *  on the reading, for the reason it is its own store row: a fresh reading replaces the reading and
   *  must not throw away the questions somebody asked. */
  gitlabReviewChat: GitLabReviewChat;
  /** Whether a question is in flight. One at a time, for the reason a reading is. */
  gitlabReviewAsking: boolean;
  /** Why a question was not answered, in the CLI's or the backend's own words, reported at the box
   *  the words are still in — the composer's own contract. */
  gitlabReviewAskError: string | null;
  /** A question that has left this page and whose answer has not come back. It is DRAWN as the
   *  reader's own turn at once — the rule `chessPending` holds for a move, because a composer that
   *  swallows a question and shows nothing feels broken — and it is taken back if the publish fails,
   *  with the words handed back to the box. */
  gitlabReviewPending: PendingReviewQuestion | null;
  /** The answer to the pending question SO FAR, as the backend streams it (`gitlab_mr_review_answer`).
   *
   *  A run is tens of seconds, so an answer that appeared whole at the end left the reader watching a
   *  spinner for all of it — and there was nothing on screen to say the model had started. It is drawn
   *  in the pending turn's own place, so the words simply become the answer when the run ends.
   *
   *  It is the PENDING question's, which is what makes it honest: the pending bubble belongs to the
   *  page that pressed, so a page with none ignores the frames and meets the turn when it lands. */
  gitlabReviewStreaming: string;
  /** How wide the reader dragged the READING's conversation column, in pixels. Persisted per browser
   *  beside the diff page's own two, and for their reason: a per-screen decision with no upstream to
   *  write it to. */
  gitlabReviewChatWidth: number;
  /** How wide the two side columns of the diff page are, in pixels — the reader's own drag,
   *  persisted per browser beside the layout above and for its reason: a per-screen decision with
   *  no upstream to write it to.
   *
   *  They are stored as ASKED FOR and clamped on the way out (`resolveDiffColumnWidths`), never
   *  clamped on the way in: a width chosen on a wide monitor has to survive being read back in a
   *  small window and then found again when the monitor comes back. */
  gitlabDiffFilesWidth: number;
  gitlabDiffSymbolsWidth: number;
  /** The lines the diff renderer LIGHTS, in its own vocabulary — a press on a line number, or
   *  wherever a drag down them has reached.
   *
   *  Kept apart from the composer below, and the split is load-bearing: the box has to open at
   *  the END of a gesture rather than during it. A card drawn mid-drag inserts a row into the
   *  patch, which moves the line numbers under the reader's own pointer — measured, and it cut
   *  a drag from line 3 to line 6 short at line 4.
   *
   *  It names its FILE, because the diff is a feed of all of them: a bare range would light line
   *  42 of every file that has one. */
  gitlabDiffSelection: DiffLineSelection | null;
  /** WHERE on the diff the reader is writing a comment: the file and the line — or the two
   *  ends of the range they dragged over — and null when they are not writing one. Set when a
   *  gesture ENDS. */
  gitlabDiffComment: DiffCommentTarget | null;
  /** What that composer holds. Deliberately NOT kept per merge request like the page's own
   *  draft below: it belongs to one line of one file, and a line moves under a reader the
   *  moment somebody pushes. */
  gitlabDiffCommentDraft: string;
  gitlabDiffCommentBusy: boolean;
  /** Why a comment did not go out, and WHICH box it was written in — `thread` is the
   *  discussion for a reply or a deletion, and null for a new comment.
   *
   *  The owner travels with the sentence because this page holds several boxes at once: a
   *  refusal drawn in every card would report a failed reply inside three threads that have
   *  nothing to do with it. It is reported here rather than on the merge-request page for the
   *  same reason one step further out — a refusal shown where the reader is not looking is a
   *  refusal nobody reads. */
  gitlabDiffCommentError: { thread: string | null; message: string } | null;
  /** What the composer holds, per merge request, so walking away and back keeps a
   *  half-written comment — and a reply keeps its own draft apart from the main one. */
  gitlabCommentDraft: string;
  /** Which thread the composer is replying into, or null for a new comment. */
  gitlabReplyTo: string | null;
  /** An outward action in flight — "merge", "comment", "close", "reopen", "approve" —
   *  so the page can disable exactly one control rather than all of them. */
  gitlabActing: string | null;
  /** What the last outward action said, reported where the click was made. An action
   *  that failed must never be left looking like it worked. */
  gitlabActionError: string | null;
  gitlabActionDone: string | null;
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
// And where a chat the user marked unread by hand is remembered. Its own key for the
// same reason: a malformed value costs the marker and neither the pin nor the hide.
const CHAT_UNREADS_KEY = "teams-lite:chat-unreads";
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
// How many merge requests keep their detail, comments and draft in the session cache. A
// reviewer walks between a handful at a time; the backend caches every read durably, so
// re-opening an evicted one is a local round-trip.
const RETAINED_MERGE_REQUESTS = 8;
// How often a LIVE pipeline is re-read while its merge request is open.
//
// It has to sit above the backend's own cache window (GITLAB_PIPELINE_TTL, 5 s) or the poll
// would keep being served the same cached answer and the page would look frozen; and it has
// to stay short enough that a job turning green is seen while the reader is still looking.
// Only ever armed while something is actually in flight (see `pipelineIsLive`).
const GITLAB_PIPELINE_POLL_MS = 6000;
// How often a LIVE job's log is re-read while its page is open.
//
// The pipeline's own interval, for the pipeline's own reasons: it sits above the backend's cache
// window for a running log (5 s) so a poll is never served the same answer twice, and it is short
// enough that a line arriving is seen while the reader is looking at it. Armed only while the job
// has not finished (see `jobLogIsLive`), so a red job nobody is going to touch again costs
// nothing.
const GITLAB_JOB_LOG_POLL_MS = 6000;
// Where the locally-chosen visible calendars are persisted (client-only, like the
// channel-pin overrides).
const VISIBLE_CALENDARS_KEY = "teams-lite:visible-calendars";
// And the view menu's display preferences.
const CALENDAR_SETTINGS_KEY = "teams-lite:calendar-settings";
// Whether the reader reads a diff unified or split. Client-only, like the calendar's own
// preferences and for the same reason: it is a per-screen decision and there is no upstream
// to write it to. What is deliberately NOT here is the expanded read — that is per merge
// request, because its cost is (see `canExpandDiff`).
/** The empty conversation, shared.
 *
 *  ONE frozen object rather than a fresh `{turns: []}` per reset: this is read by a selector, and a
 *  new array on every unrelated change would re-render the transcript for nothing. */
const EMPTY_REVIEW_CHAT: GitLabReviewChat = Object.freeze({ turns: [] });

const GITLAB_DIFF_LAYOUT_KEY = "teams-lite:gitlab-diff-layout";
// How wide the diff page's two side columns are. Client-only for the same reason the layout is —
// a per-screen decision with no upstream — and stored as the reader ASKED rather than as drawn, so
// a width chosen on a wide monitor is found again when the monitor comes back (the clamp against
// the window happens at draw time, in `resolveDiffColumnWidths`).
const GITLAB_DIFF_FILES_WIDTH_KEY = "teams-lite:gitlab-diff-files-width";
const GITLAB_DIFF_SYMBOLS_WIDTH_KEY = "teams-lite:gitlab-diff-symbols-width";
const GITLAB_REVIEW_CHAT_WIDTH_KEY = "teams-lite:gitlab-review-chat-width";

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
    chatUnreads: {},
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
    signin: INITIAL_SIGNIN,
    signinDismissed: false,
    writeLock: null,
    ready: false,
    splashMessage: "connecting",
    fatal: null,
    update: null,
    updateProgress: null,
    draft: "",
    sendError: null,
    chessError: {},
    chessPending: {},
    chessPremove: {},
    chessArchive: {},
    petError: {},
    petArchive: {},
    petPending: {},
    chessEngine: NO_CHESS_ENGINE,
    chessSounds: NO_CHESS_SOUNDS,
    scheduledMessages: [],
    composerRestore: null,
    replyingTo: null,
    notifications: { activity: [], mentions: [], following: [] },
    notificationsUnread: 0,
    pendingScroll: null,
    scrollToBottomNonce: 0,
    typingByConversation: {},
    incomingCalls: [],
    callStatus: UNKNOWN_CALL_STATUS,
    callVideo: [],
    callLocalVideo: [],
    callVideoNames: {},
    callRecording: null,
    recordings: [],
    // False until the browser is asked, which happens on start. It is the same reading the
    // calling switch takes before `call_status` answers: a control offered on a hopeful
    // default would promise a file this browser cannot keep.
    recordingsCanBeKept: false,
    readReceipts: [],
    mentionCandidates: [],
    channelLayouts: {},
    appearance: DEFAULT_APPEARANCE,
    resolvedTheme: "light",
    soundsEnabled: DEFAULT_SOUNDS_ENABLED,
    petsShown: DEFAULT_PETS_SHOWN,
    settings: {
      gitlab_host: "gitlab.com",
      gitlab_token_set: false,
      linear_token_set: false,
      ghost_mode: false,
      always_available: false,
      // No hours is all day, and `available_now` false until the backend answers — the
      // reading every unanswered capability takes in this app: a pane that claimed a green
      // dot before the settings land would state a status nobody outside can see.
      available_from: null,
      available_to: null,
      available_zone: null,
      available_now: false,
      // On, like the backend's own default (see `sender_icons_enabled`): the switch
      // must not read "off" for the moment before the settings land, or the user would
      // be told no icon is fetched while one is.
      sender_icons: true,
      // On, like the backend's own default (see `emoji_auto_import_enabled`), for the
      // reason the line above gives: a switch that read "off" until the settings land
      // would tell the user no emoji is being taken while one is.
      emoji_auto_import: true,
      // OFF, like the backend's own default, and the opposite reading from the two above for
      // the opposite reason: a switch that read "on" until the settings land would say the
      // words of a sealed chat are drawn on a lock screen while they are being withheld.
      sealed_push_words: false,
    },
    linearWorkspace: null,
    push: INITIAL_PUSH_STATE,
    agent: null,
    agentRuns: {},
    agentTranscripts: {},
    agentTranscriptsOpen: {},
    sealStatus: null,
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
    // Every open merge request the token can see — the question the page exists to
    // answer. The other three scopes narrow it, and `merged` is not a state it can ask.
    gitlabScope: "all",
    gitlabState: "opened",
    gitlabList: [],
    gitlabTotal: null,
    gitlabTruncated: false,
    gitlabListLoading: false,
    gitlabListError: null,
    gitlabTokenSet: true,
    openMergeRequest: null,
    gitlabDetail: null,
    gitlabDetailLoading: false,
    gitlabDetailError: null,
    gitlabApproval: null,
    gitlabNotes: null,
    gitlabPipeline: null,
    gitlabPipelineError: null,
    gitlabJobLog: null,
    gitlabJobId: null,
    gitlabJobLogLoading: false,
    gitlabJobLogError: null,
    gitlabDiff: null,
    gitlabDiffLoading: false,
    gitlabDiffError: null,
    gitlabDiffPath: null,
    gitlabDiffDepth: "listed",
    gitlabDiffLayout: "unified",
    gitlabDiffSymbol: null,
    gitlabDiffOpenOnCode: false,
    gitlabReview: null,
    gitlabReviewBusy: false,
    gitlabReviewError: null,
    gitlabReviewChat: EMPTY_REVIEW_CHAT,
    gitlabReviewAsking: false,
    gitlabReviewAskError: null,
    gitlabReviewPending: null,
    gitlabReviewStreaming: "",
    gitlabReviewChatWidth: REVIEW_CHAT_DEFAULT_WIDTH,
    gitlabDiffFilesWidth: FILES_COLUMN_DEFAULT_WIDTH,
    gitlabDiffSymbolsWidth: SYMBOLS_PANEL_DEFAULT_WIDTH,
    gitlabDiffSelection: null,
    gitlabDiffComment: null,
    gitlabDiffCommentDraft: "",
    gitlabDiffCommentBusy: false,
    gitlabDiffCommentError: null,
    gitlabCommentDraft: "",
    gitlabReplyTo: null,
    gitlabActing: null,
    gitlabActionError: null,
    gitlabActionDone: null,
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

  // The approval state of a merge request, per URL, as last read or last written. Not a
  // promise cache like the one above: this one is asked for when a ⋯ menu OPENS, which is
  // a moment the reader chose, so every open re-reads GitLab and the stored answer is
  // only what the menu draws while that request is in flight. A cached "you approved"
  // that outlived a revoke made in GitLab's own UI would offer the wrong action.
  private approvalResolved = new Map<string, GitLabApprovalResult>();

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

  // Custom emoji blob cache: name -> a promise of a blob object URL, or null when there
  // is no art. Cached the same way as avatars, but evicted on `custom_emoji_changed` so
  // a replaced emoji shows its new art rather than keeping the old one until reload.
  private customEmojiCache = new Map<string, Promise<string | null>>();
  private customEmojiObjectUrls: string[] = [];
  /** One custom agent's face as a blob URL, keyed by `<name>@<updated_ms>` so a REPLACED
   *  picture is a different key: a persona's row changes far more often than an emoji's, and
   *  a cache keyed by name alone would draw the old face until a reload. */
  private personaAvatarCache = new Map<string, Promise<string | null>>();
  private personaAvatarObjectUrls: string[] = [];

  // The pack ITSELF, one promise for the whole page (see `loadCustomEmoji`).
  private customEmojiList: Promise<CustomEmoji[]> | null = null;

  // Surfaces that read the custom emoji pack, so they can re-read when it changes.
  private customEmojiListeners = new Set<() => void>();

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
    this.applyPersistedPetsShown();
    this.applyPersistedChannelPins();
    this.applyPersistedChatPrefs();
    this.applyPersistedChatUnreads();
    this.applyPersistedCollapsedSections();
    this.applyPersistedVisibleCalendars();
    this.applyPersistedCalendarSettings();
    this.applyPersistedDiffLayout();
    this.applyPersistedDiffColumnWidths();
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
    // And when even a fresh token is refused, this page cannot act at all — every send,
    // reaction and update will come back refused while every read answers. That is worth
    // a banner rather than one more failed button, so the refusal re-asks where we stand.
    this.backend.setWriteRefusedHandler(() => void this.refreshWriteLock());
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
      // What Teams is holding for later. Read at startup rather than on demand, because
      // the banner over a composer is DERIVED from it: without this, a thread with a
      // message waiting said nothing about it until one more was queued in this page.
      // It is a store read on the backend and costs no network request.
      void this.loadScheduledMessages();
      // App settings (the GitLab host, and which integration tokens are stored)
      // are best-effort too — a failure just leaves the defaults, which enrich
      // nothing but public gitlab.com links.
      void this.loadSettings();
      // And the Linear workspace those settings' key belongs to, which is what a bare
      // `STMN-3439` in anybody's words is addressed with (see `linearWorkspace`). Asked on
      // every connect because the backend answers it from a cache that outlives a restart.
      void this.loadLinearWorkspace();
      // Which conversations answer an `@claude` message, and whether this machine
      // holds an agent CLI at all. Best-effort: a failure leaves the menu saying the
      // backend has not answered, never a switch that pretends to work.
      void this.loadAgentStatus();
      // Whether this machine holds the CHESS ENGINE, and what fetching it would cost. Two file
      // stats on the backend, so it costs nothing — and the answer is what decides whether a
      // conversation offers a game against the computer at all: an offer drawn before the answer
      // arrives would start a game whose first move nothing could make.
      void this.loadChessEngine();
      // Which chats this machine seals, and which passphrases it holds for each. Best-effort
      // on the same terms, and the failure reads correctly on its own: with no answer nothing
      // about sealing is drawn at all, which is what the app looked like before the feature —
      // never a padlock over a message that went out in the clear.
      void this.loadSealStatus();
      // Whether this machine takes calls, and whether it is in one. Best-effort for
      // the same reason: an unanswered status reads as "off", which is what the
      // backend defaults to.
      void this.refreshCallStatus();
      // The recordings this browser holds. Nothing about them is the backend's — they are
      // this browser's own files (see lib/recording-store.ts) — so this is read locally and
      // is best-effort: no storage means no recordings, and the control is not offered.
      void this.loadRecordings();
      // Where this device stands on push notifications, and a re-registration if it
      // is already subscribed (a browser may have rotated the subscription while the
      // app was closed — see syncPush).
      void this.syncPush();
      // And whether the token we just read is the one this backend accepts. Asked BEFORE
      // anything is pressed, because the answer used to arrive as the refusal of whatever
      // the user pressed first — see `refreshWriteLock`.
      void this.refreshWriteLock();
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
    // Nothing asks for notification permission here, deliberately: a prompt with no
    // question in front of it is dismissed, and a browser dismissed a few times answers
    // `denied` for good — the one state neither this app nor its Settings pane can undo.
    // The reader is offered notifications by a row they can read first (see
    // notification-offer.tsx), and the permission is asked from that press.
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

  /**
   * Ask the backend whether the token this page holds is the one it accepts, and keep
   * the answer for the banner (see `WriteLockBanner`).
   *
   * WHY THE PAGE ASKS AT ALL. The pairing between a page and its backend can break with
   * nothing visible: `teams` attaches to a backend another instance spawned — whose token
   * is pinned, so it is in no file — or `TEAMS_LITE_WS_URL` points this page's socket at
   * one backend while its token came from another. Reads keep answering in both, so the
   * app looks healthy and every outward action is refused. It reached a user as
   * "Update failed", and before this the state was stated nowhere but in the refusal text
   * of whatever they had pressed.
   *
   * Best-effort and quiet on failure: an older backend answers `unknown method`, which
   * must read as "nothing to say" rather than as a fault — exactly like a missing broker
   * status.
   */
  /** Re-read the token and ask again — the banner's own button
   *  (see `WriteLockBanner`). The user mends this outside the app, by stopping the other
   *  instance, so the one action it can offer is to look again. */
  async checkWriteLock(): Promise<void> {
    await this.loadWriteToken();
    await this.refreshWriteLock();
  }

  private async refreshWriteLock(): Promise<void> {
    try {
      this.set({ writeLock: await this.backend.writeLockStatus() });
    } catch {
      this.set({ writeLock: UNKNOWN_WRITE_LOCK });
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
    this.stopPipelinePolling();
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
    this.approvalResolved.clear();
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
      // A message Teams is HOLDING arrives on the feed like any other — it is a real
      // message, posted now and delivered later — so it never joins the thread, never
      // chimes and never bumps a preview. What it does is refresh the scheduled list,
      // which is where the reader was told to look for it.
      if (messageIsHeld(m)) {
        void this.loadScheduledMessages();
        return;
      }
      const cached = this.messageCache.get(m.conversation_id);
      // Read BEFORE the merge: a frame carrying a message this page already holds is a
      // reaction, an edit or a deletion on it rather than news (see `shouldNotify`), and
      // after the append every frame looks known.
      const alreadyKnown = cached?.messages.some((held) => held.id === m.id) === true;
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
      } else if (
        shouldNotify(m, this.get().openId, this.notifyPlacement(m.conversation_id), {
          alreadyKnown,
        })
      ) {
        // The message's own text, read the way its type says it must be (a `Text`
        // body is plain, not HTML) — so a notification never eats what it quotes — and
        // WITHOUT the machine-readable line a game or a companion signs itself with. This
        // is the sharpest reader of that line and the last one to get the rule: it is
        // built from the BODY rather than from a 120-character preview, so a colleague's
        // spawn popped a notification carrying the whole record. The strip is the sidebar's
        // own (`withoutWireLine`), and `copyableMessageText` itself is left alone: COPY
        // hands the reader the message as it really is.
        notifyMessage(m.sender, withoutWireLine(copyableMessageText(m)), m.conversation_id);
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

    // The settings moved without this page asking. Today one thing does that: the
    // presence hours turning, which the backend acts on while nobody is clicking anything
    // (see `spawn_presence_heartbeat`). Without it a Settings pane left open across 19:00
    // would keep claiming a green dot the backend had already withdrawn.
    on("settings_changed", (raw) => {
      if (raw && typeof raw === "object") this.set({ settings: raw as AppSettings });
    });

    // The custom emoji pack changed — here, or in the other backend sharing this store.
    // Evict the blob URLs and notify listeners, so a replaced emoji shows its new art
    // rather than keeping the old one until a reload.
    // Another page — or the other backend on this machine — changed a custom agent. The
    // status is re-read rather than patched: the personas ride inside it, so one read keeps
    // the composer's "@", every chip and the Settings pane in step at once.
    on("agent_personas_changed", () => {
      this.forgetPersonaAvatars();
      void this.loadAgentStatus();
    });

    // A chat was sealed, stopped being sealed, or gained or lost a passphrase — here, or in
    // the other backend sharing this store.
    //
    // TWO HALVES, and the second is the load-bearing one. Re-reading the status is what moves
    // the padlock and the composer's own sentence. Re-reading the MESSAGES is what makes the
    // history readable: a locked body is handed to the page EMPTY, never as ciphertext, so
    // adding the passphrase changes nothing the page is already holding — the reader would
    // type it in, watch the rows stay locked, and reload. Nothing here can decrypt them
    // either; the backend decrypts on its own read, so the only way to see the words is to
    // ask again. That is `forgetPerson`'s shape exactly, and for the same reason: the answer
    // is derived on the way out of the store, so what is in memory is stale.
    //
    // The SIDEBAR is re-read for that same reason — a row's preview is one of those bodies —
    // and only the conversations: a channel cannot be sealed (`sealCanBeUsed`), so nothing in
    // that list can have moved.
    on("seal_changed", (raw) => {
      const conversation = (raw as { conversation?: string } | null)?.conversation;
      void this.loadSealStatus();
      void this.refreshConversations();
      // Only the thread the event names, when it names one: a passphrase added to another
      // chat says nothing about the open one, and its own cached page is reconciled by the
      // `open` that every `openConversation` makes anyway.
      const openId = this.get().openId;
      if (openId && (!conversation || openId === conversation)) void this.reconcileOpen(openId);
    });

    on("custom_emoji_changed", () => {
      this.forgetCustomEmoji();
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
    // The backend refreshed a merge-request list behind the page. It names the query it
    // answers, so a page showing another filter ignores it — the sidebar must never
    // silently swap the rows the user is reading for another scope's.
    on("gitlab_list_updated", (raw) => {
      const list = raw as (MergeRequestList & { scope?: string; state?: string }) | null;
      if (!list || !Array.isArray(list.items)) return;
      const state = this.get();
      if (list.scope !== state.gitlabScope || list.state !== state.gitlabState) return;
      this.applyGitLabList(list);
    });

    // One merge request moved. `kind` says which read arrived — or `stale`, which is what
    // a WRITE broadcasts: it carries no payload, because the point of it is that every
    // page (this one included, and the phone beside it) has to read again.
    // THE ANSWER TO A QUESTION, AS IT IS WRITTEN. A run is tens of seconds, so an answer that
    // appeared whole at the end left the reader watching a spinner for all of it with nothing saying
    // the model had even started.
    //
    // It is drawn into the PENDING question's own place, which is what makes it honest: that bubble
    // belongs to the page that pressed, so a page with no pending question ignores these frames and
    // meets the turn when the answer lands — which is what it did before this existed.
    on("gitlab_mr_review_answer", (raw) => {
      const d = raw as { project_path?: string; iid?: number; text?: string } | null;
      if (!d || typeof d.project_path !== "string" || typeof d.iid !== "number") return;
      if (typeof d.text !== "string") return;
      if (!sameMergeRequest({ projectPath: d.project_path, iid: d.iid }, this.get().openMergeRequest)) {
        return;
      }
      // Only while a question of THIS page's is out. Without it a frame arriving after the answer had
      // landed — the last one always races the response — would draw a half answer under a turn that
      // is already complete.
      if (!this.get().gitlabReviewPending) return;
      if (this.get().gitlabReviewStreaming === d.text) return;
      this.set({ gitlabReviewStreaming: d.text });
    });

    on("gitlab_mr_updated", (raw) => {
      const d = raw as
        | (Record<string, unknown> & { project_path?: string; iid?: number; kind?: string })
        | null;
      if (!d || typeof d.project_path !== "string" || typeof d.iid !== "number") return;
      const key = { projectPath: d.project_path, iid: d.iid };
      if (!sameMergeRequest(key, this.get().openMergeRequest)) return;
      const id = mergeRequestId(key);
      // Each frame is validated on the one field its own shape cannot be without, so a
      // payload this build does not understand is ignored rather than drawn as an empty
      // panel. A frame with no `kind` this page knows — `stale`, which is what a WRITE
      // broadcasts — is the ask to read again.
      if (d.kind === "detail" && typeof d.title === "string") {
        const detail = d as unknown as MergeRequestDetail;
        this.cacheGitLabDetail(id, detail);
        this.set({ gitlabDetail: detail, gitlabDetailError: null });
      } else if (d.kind === "notes" && Array.isArray(d.discussions)) {
        const notes = d as unknown as GitLabDiscussionList;
        this.gitlabNotesCache.set(id, notes);
        this.set({ gitlabNotes: notes });
      } else if (d.kind === "diff" || d.kind === "diff-raw") {
        // The DEPTH is part of the kind, so the plain read refreshing behind the page can
        // never replace the expanded one a reader asked for — it holds fewer patches.
        const depth: DiffDepth = d.kind === "diff-raw" ? "raw" : "listed";
        if (!Array.isArray(d.files)) return;
        const diff = d as unknown as GitLabDiff;
        this.gitlabDiffCache.set(this.gitlabDiffKey(id, depth), diff);
        if (this.get().gitlabDiffDepth === depth) {
          this.set({ gitlabDiff: diff, gitlabDiffError: null });
        }
      } else if (d.kind === "pipeline") {
        const view = d as unknown as GitLabPipelineView;
        this.set({ gitlabPipeline: view, gitlabPipelineError: null });
        // A refresh that arrived from somewhere else still decides whether this page keeps
        // polling: a pipeline that finished must stop the timer, and one that started must
        // arm it.
        if (pipelineIsLive(view)) this.schedulePipelinePoll(key);
        else this.stopPipelinePolling();
      } else if (d.kind === "job") {
        // WHICH job is in the payload's own `job.id`: a page watching one job's log ignores a
        // frame about another, exactly as the sidebar ignores a frame about another filter.
        const log = d as unknown as GitLabJobLog;
        if (typeof log.job?.id !== "number" || log.job.id !== this.get().gitlabJobId) return;
        this.set({ gitlabJobLog: log, gitlabJobLogError: null });
        // A refresh that arrived from somewhere else still decides whether this page keeps
        // polling: a job that has just finished must stop the timer.
        if (jobLogIsLive(log)) this.scheduleJobLogPoll(key, log.job.id);
        else this.stopJobLogPolling();
      } else if (d.kind === "stale") {
        void this.reloadMergeRequest();
      }
    });

    // A background refresh was refused. Reported only when there is nothing on screen:
    // a failed refresh behind a populated page is noise, and the page keeps the answer it
    // has — but an EMPTY page with no word would read as "there are no merge requests".
    on("gitlab_read_error", (raw) => {
      const d = raw as { key?: string; error?: string } | null;
      const message = d?.error || "GitLab could not be read";
      const state = this.get();
      if (typeof d?.key === "string" && d.key.startsWith("list:")) {
        if (state.gitlabList.length === 0) this.set({ gitlabListError: message });
        return;
      }
      if (!state.gitlabDetail) this.set({ gitlabDetailError: message });
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
    // How the CHESS ENGINE's download is going, and whether it is here at all. Sent on every whole
    // percent and on every change of state, so a second window draws the same bar and a page that
    // opened in the middle of a fetch learns from this rather than from nothing.
    on("chess_engine_progress", (raw) => {
      const next = raw as Partial<ChessEngineState> | null;
      if (next && typeof next.present === "boolean") {
        this.set({ chessEngine: { ...NO_CHESS_ENGINE, ...next } });
      }
    });
    // The board's own SOUNDS arriving on this machine, or being given back. Sent to EVERY page
    // rather than answered to the one that asked, because the fetch happens in the background: the
    // board that started it has already drawn itself, and this is what tells it to stop
    // synthesizing.
    on("chess_sound_changed", (raw) => {
      const next = raw as Partial<ChessSoundsState> | null;
      if (next && typeof next.present === "boolean") {
        this.set({ chessSounds: { ...NO_CHESS_SOUNDS, ...next } });
      }
    });
    // How sign-in is doing. The backend sends this on a change of state and in the
    // greeting, so an outage that started before this tab opened still reaches it.
    on("broker_status", (raw) => {
      const next = raw as BrokerStatus | null;
      if (!next || typeof next.ok !== "boolean") return;
      this.set({ brokerStatus: next });
    });
    // How a sign-in is going. Pushed when it settles and in the greeting while one is
    // running, so a page that connects mid-flow draws the panel it never started.
    on("signin_status", (raw) => {
      const next = raw as SigninState | null;
      if (!next || typeof next.phase !== "string") return;
      this.set({ signin: next });
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
      // And ask again where that leaves us, AFTER the re-read: the backend that answers
      // now may be another process, or another INSTANCE — a restart is exactly how a page
      // ends up holding a token nothing accepts, so the banner has to follow the socket.
      // Chained rather than fired beside it, or the question would carry the old token and
      // the answer would accuse a page that had already healed itself.
      void this.loadWriteToken().then(() => this.refreshWriteLock());
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

  // ---- incoming calls (awareness) ------------------------------------------
  //
  // These handlers turn the backend's `call` event — the after-the-fact `Event/Call`
  // chat message, not the calling plane — into a ring/dismiss banner, so the user
  // KNOWS a call is happening in a conversation nothing rang here. A `started` rings;
  // `ended`/`missed` — or a manual dismiss, or a safety timeout — clears it. The
  // backend already suppresses calls we started ourselves, so a `started` here is
  // always someone else calling.
  //
  // What the CARD offers is decided there (`components/incoming-call-banner.tsx`): a
  // ringing MEETING is joined, because its thread is a join address on its own, and every
  // other conversation is opened. The real calling plane is the block below.

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
      notifyCall(call.caller, this.callGroupLabel(convId), convId);
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

  /** Which start the page is on. A hang-up moves it, so a start still in flight learns
   *  that the user changed their mind.
   *
   *  A start is three awaits long — reserve, open the microphone, post the offer — and
   *  the microphone alone takes up to `GATHER_TIMEOUT_MS`, so a call stopped a second
   *  after it was placed lands INSIDE one of them. Without this the start ran on to the
   *  end, the backend refused the offer for a call it had already let go, and the app
   *  reported that refusal to the user as a fault ("no such call — call_prepare first")
   *  — for a call they stopped themselves. The counter is the user's own intention, and
   *  that is why it is not read off a `call_state` frame: a frame says the call is over
   *  whoever ended it, the failure included, and a failure must still be said. */
  private callAttempt = 0;

  /** True while `attempt` is still the start the user wants. */
  private callAttemptStands(attempt: number): boolean {
    return attempt === this.callAttempt;
  }

  /** Take the media a start opened — or release it, because the user hung up while it
   *  was opening.
   *
   *  `this.callMedia` is the only handle on a microphone, and it is assigned here: a
   *  capture adopted after the hang-up would be one nothing could find to stop, and the
   *  browser's recording indicator would stay on for a call that does not exist. */
  private adoptCallMedia(media: CallMedia, attempt: number): boolean {
    if (!this.callAttemptStands(attempt)) {
      media.stop();
      return false;
    }
    this.callMedia = media;
    return true;
  }

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
    // Otherwise: a roster frame is how somebody arriving becomes a name, so a running
    // recording collects them here — the people named in the file are everybody who was in
    // the call while it ran, not everybody who was in it when it started.
    else this.syncRecorder();
    // A live call says nothing, and — importantly — takes nothing back. Clearing the
    // notice here looked right and was wrong: these frames arrive throughout a call (a
    // roster, a renegotiation, a camera going on), so the first one after a refused
    // capture erased the reason a beat after it appeared. What a new attempt leaves
    // behind is taken back where that attempt STARTS, which is the only place that knows
    // one is starting.
    if (isLive(call)) return;
    // The ONE frame that says the call is over. It is said here because the slot is freed
    // immediately afterwards — reading the reason off `callStatus` later would find
    // nothing. An ending the user caused says nothing back at them.
    if (call?.phase === "ended") this.reportCall(callEndLabel(call), "report");
  }

  /** Say one thing about the call — why it ended, or why it did not happen.
   *
   *  It is a NOTICE and not state: by the time there is anything to say the call is
   *  gone, so there is no surface of its own left to say it in, and a sentence that
   *  nothing clears is a sentence that stays for ever. That is what this used to be. */
  private reportCall(text: string, kind: "error" | "report"): void {
    showNotice({ text, kind, id: CALL_NOTICE, testId: "call-notice" });
  }

  /** Say one thing about a RECORDING of a call — where the file went, or why there is none.
   *
   *  Its own id, so it never replaces the reason the CALL ended: the two arrive together when
   *  a call drops, and which of them the user cannot work out for themselves is the call's. */
  private reportRecording(text: string, kind: "error" | "report"): void {
    showNotice({ text, kind, id: RECORDING_NOTICE, testId: "call-recording-notice" });
  }

  /** The far side's SDP. An ANSWER is what turns a ringing call into audio; an OFFER is
   *  the service renegotiating on its own, which is how video arrives. */
  private async onCallMedia(signal: CallMediaSignal): Promise<void> {
    const media = this.callMedia;
    if (!media) return;
    if (signal.kind === "offer") {
      await this.answerRemoteOffer(signal);
      return;
    }
    try {
      await media.setRemoteAnswer(signal.sdp);
    } catch (error) {
      console.error("[call] the answer could not be applied", error);
      // WHICH answer it was decides everything. THE answer is what makes a call a call: with
      // it refused nothing will ever be heard, so the call goes rather than leaving a bar
      // that says "connecting" for good. A LATER one answers a renegotiation of OURS — a
      // camera, a screen — on a call that is already carrying audio, and ending that call is
      // exactly what this app did to a real user seconds after they shared their screen.
      // Losing it costs the picture and nothing else.
      if (media.negotiated) {
        await this.abandonCallRenegotiation();
        return;
      }
      await this.hangUpCall();
    }
  }

  /**
   * Take back an offer of ours the meeting answered in a way this browser cannot read.
   *
   * The offer will never be completed, so the connection is rolled back to where it stood
   * before the attempt and every capture it carried is released — the same shape a capture the
   * meeting DROPPED takes, and for the same reason: a camera whose light is on while nothing
   * goes out is the worst state this surface has. The service is told with one offer, and a
   * failure to tell it changes nothing that can be done here.
   */
  private async abandonCallRenegotiation(): Promise<void> {
    const media = this.callMedia;
    if (!media) return;
    const { released, offer } = await media.abandonLocalOffer();
    // The service is told FIRST, and the sentence is said after it: both speak through one
    // notice, and this is the one that has to survive — a report that the take-back could not
    // be posted would replace "you are still in the call" with a fact the user cannot act on.
    // Swallowed for the same reason: there is nothing left to try.
    if (offer) await this.publishSending(offer, "take back a media offer").catch(() => {});
    this.reportCall(renegotiationRefusedMessage(released), "error");
  }

  /**
   * Answer a media offer the service made mid-call, then ask for what it can now send.
   *
   * The service renegotiates unprompted and its offer already carries the sections for a
   * colleague's camera and a colleague's shared screen, so this is the whole receive path:
   * answer, then subscribe (NATIVE-CALLING.md § 10.3a).
   *
   * **A failure here never ends the call.** Audio is already up and unaffected; losing this
   * costs a tile, and the service offers again. Ending a working call because a screen could
   * not be drawn would be much the worse outcome.
   */
  private async answerRemoteOffer(signal: CallMediaSignal): Promise<void> {
    const media = this.callMedia;
    if (!media) return;
    try {
      const answer = await media.answerRemoteOffer(signal.sdp);
      if (!answer) return;
      await this.backend.callAnswerMedia(signal.call_id, answer, ["audio", "ScreenViewer"]);
      await this.subscribeToRemoteVideo();
    } catch (error) {
      console.error("[call] a media renegotiation could not be answered", error);
    }
  }

  /**
   * Ask the meeting's media server to put the people who are publishing onto the sections
   * it just gave us.
   *
   * Two halves have to meet here, and they come from opposite directions: the SOURCE IDs are
   * in the roster (the backend's `publishing`), and the SECTIONS are in the page (the mids
   * and stream ids the browser reported). Neither side can do this alone, which is why it is
   * here rather than in `call-media.ts` or the backend.
   *
   * A shared screen wins the sections it needs first: it is the thing somebody deliberately
   * put on screen for others to read, and a text-heavy stream is the one that suffers most
   * from being dropped.
   */
  private async subscribeToRemoteVideo(): Promise<void> {
    const media = this.callMedia;
    const call = this.get().callStatus.call;
    if (!media || !call) return;
    const sections = media.remoteVideo;
    if (sections.length === 0) return;
    // Everything the others publish that this app can draw, screens before cameras.
    const wanted = call.publishing
      .flatMap((person) => person.streams.map((stream) => ({ person, stream })))
      .filter(({ stream }) => stream.shared_screen || stream.camera)
      .sort((a, b) => Number(b.stream.shared_screen) - Number(a.stream.shared_screen));
    const taken = new Set<string>();
    for (const { person, stream } of wanted) {
      // A screen goes on a section the service labelled for a screen, and a camera on one
      // labelled for a camera: the label is the service's own statement about what that
      // section carries, and putting a screen on a camera's section asks for a stream it
      // said it would not send there.
      const section = sections.find(
        (candidate) =>
          !taken.has(candidate.mid) && candidate.sharing === stream.shared_screen,
      );
      if (!section) continue;
      taken.add(section.mid);
      try {
        await this.backend.callSubscribe({
          callId: call.id,
          mid: section.mid,
          sourceId: stream.source_id,
          streamMsid: section.streamMsid,
        });
        // Remember whose it is. The section itself never says, so this is the one moment
        // the person and the mid are both in hand.
        this.set({
          callVideoNames: { ...this.get().callVideoNames, [section.mid]: person.name },
        });
        // A running recording draws the name under that tile, so it learns it here too —
        // this is the one moment the person and the section are both in hand.
        this.syncRecorder();
      } catch (error) {
        // One refused subscription is one missing tile, not a broken call.
        console.error("[call] could not subscribe to a stream", error);
      }
    }
  }

  private stopCallMedia(): void {
    // The session dies with the call — a meeting has no presenter once nobody is in it — so
    // the flag goes rather than a POST: the links it would use are the ended call's own.
    this.sharingSessionHeld = false;
    // A recording is closed out HERE, on the one path the microphone is released on and for
    // the same reason: every ending — our hangup, theirs, a dropped transport, calling
    // switched off — comes through this function, and a recording lost because of which side
    // hung up would be a file that exists nowhere else. It is requested before the media goes
    // so the last second of the call is in it, and it is idempotent, so the user's own press
    // and the call ending in the same moment write one file.
    void this.stopCallRecording();
    this.callMedia?.stop();
    this.callMedia = null;
    // The tiles go with the connection that fed them. A `<video>` left holding a stopped
    // stream shows its last frame for good, which reads as a call that is still up.
    if (this.get().callVideo.length > 0 || this.get().callLocalVideo.length > 0) {
      this.set({ callVideo: [], callLocalVideo: [], callVideoNames: {} });
    }
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
    oneToOne?: boolean;
  }): Promise<CallMedia> {
    // Every callback below is wired ONCE, for the stand-in as much as for the real thing: the
    // mock is where this surface is reviewed, and a bridge the mock path skipped is a rule no
    // spec could ever hold the app to.
    const media = this.get().backendIsMock
      ? simulatedCallMedia({ answering: options.remoteOffer !== undefined })
      : await startCallMedia({
          iceServers: options.iceServers,
          remoteOffer: options.remoteOffer,
          oneToOne: options.oneToOne,
          onConnectionStateChange: (state) => {
            if (state === "failed") {
              console.error("[call] the media transport failed");
              void this.hangUpCall();
            }
          },
        });
    // The tiles are reactive state; the connection behind them is not. This is the one
    // bridge between the two, and it is set before anything can arrive on it.
    //
    // Each one also re-points a RUNNING recording, so a camera that comes on five minutes in
    // is in the file from the moment it is on screen — one recording per call, whatever
    // changes inside it.
    media.onRemoteVideoChange = (videos) => {
      this.set({ callVideo: videos });
      this.syncRecorder();
    };
    media.onLocalVideoChange = (videos) => {
      this.set({ callLocalVideo: [...videos] });
      this.syncRecorder();
      // The SESSION is given back on the one path every ending of a screen share passes
      // through, which is this one — the user's own press, the browser's "Stop sharing" bar, a
      // section the meeting dropped, and an offer rolled back because its answer could not be
      // read. It is the rule the microphone already follows, and for the same reason: a
      // release wired per ending eventually misses one, and a meeting left believing this
      // endpoint is still its presenter refuses the NEXT share.
      if (!videos.some((video) => video.kind === "screen")) void this.releaseSharingSession();
    };
    // A voice joining or leaving. It changes nothing on screen — the audio elements play it
    // either way — so a recording is its only reader.
    media.onAudioChange = () => this.syncRecorder();
    // A capture that ended with no click of ours: the BROWSER's own "Stop sharing" bar, or a
    // section the MEETING dropped. Either way the service has to be told from here, or it
    // keeps a section that carries no picture while the button still says on.
    media.onSendingEnded = (kind, offer, reason) => {
      // Both endings the user did not ask for are told, and they are told DIFFERENTLY: a
      // capture the meeting accepted and then took away is worth turning on again, and one it
      // never accepted is not — that advice sent a real user straight back into the same
      // refusal. The browser's own bar needs no word: they pressed it themselves.
      if (reason === "dropped") this.reportCall(captureDroppedMessage(kind), "error");
      if (reason === "refused") this.reportCall(captureRefusedMessage(kind), "error");
      void this.publishSending(offer, `stop ${kind}`);
    };
    return media;
  }

  /**
   * Turn the user's CAMERA on or off in the call they are in.
   *
   * The click is the consent, and the browser asks its own permission under it. Nothing here
   * runs on its own: a machine that opened a camera by itself would be the worst thing in
   * this app.
   */
  async setCameraOn(on: boolean): Promise<void> {
    await this.setSending("camera", on);
  }

  /**
   * Share the user's SCREEN, or stop.
   *
   * Sharper than the camera and treated the same way, because the difference is not in the
   * mechanism: a face shows a face, and a screen shows whatever else is on it. The browser's
   * own picker is what chooses WHAT is shared, and this app never pre-selects it.
   */
  async setScreenShareOn(on: boolean): Promise<void> {
    await this.setSending("screen", on);
  }

  /**
   * Start or stop one capture, and tell the service what changed.
   *
   * Both directions are one function because the failure handling has to be identical: an
   * offer that does not go out must leave the page and the meeting agreeing, and the only way
   * to guarantee that is one path.
   */
  private async setSending(kind: SendKind, on: boolean): Promise<void> {
    const media = this.callMedia;
    const call = this.get().callStatus.call;
    if (!media || !call) return;
    try {
      // A SCREEN is asked for before it is offered: a meeting shows one at a time, so this
      // endpoint has to hold its content-sharing session or the section is rejected outright.
      // The order is the client's own — the modality first, the media after it — and it comes
      // BEFORE the capture, so a meeting that will not grant one never opens a screen picker.
      if (kind === "screen" && on) {
        await this.backend.callStartSharing(call.id);
        this.sharingSessionHeld = true;
      }
      const offer = on ? await media.startSending(kind) : await media.stopSending(kind);
      await this.publishSending(offer, `${on ? "start" : "stop"} ${kind}`);
    } catch (error) {
      // A refused camera is a decision, not a fault, so it is said in the user's words and
      // the call carries on. Whatever happened, the capture is released: `startSending` stops
      // its own tracks on the way out, and releasing it is what gives the session back — a
      // share that failed after the meeting granted one would otherwise leave a presenter
      // showing nothing.
      this.reportCall(callFailureMessage(error), "error");
      if (on) {
        await media.stopSending(kind).catch(() => {});
        // A capture that never started raises no change, so the session is released here too.
        if (kind === "screen") await this.releaseSharingSession();
      }
    }
  }

  /** Whether the meeting has granted this endpoint its content-sharing session. Not reactive:
   *  nothing on screen is drawn from it, and the button reads the backend's own `sending`. */
  private sharingSessionHeld = false;

  /**
   * Give the meeting's sharing session back, once, if this endpoint holds one.
   *
   * Idempotent and silent: the picture has already stopped by the time this runs, so there is
   * nothing left for the user to act on, and a failure costs the meeting one stale presenter
   * rather than costing them anything.
   */
  private async releaseSharingSession(): Promise<void> {
    const call = this.get().callStatus.call;
    if (!this.sharingSessionHeld || !call) return;
    this.sharingSessionHeld = false;
    await this.backend.callStopSharing(call.id).catch(() => {});
  }

  /**
   * POST the offer that says what this side now sends, and apply the answer.
   *
   * `sending` travels with it so the BACKEND can publish it to every client: a second page,
   * or a phone that reconnects mid-call, has to be told the camera is on rather than draw its
   * button from its own memory.
   */
  private async publishSending(offer: string | null, what: string): Promise<void> {
    const media = this.callMedia;
    const call = this.get().callStatus.call;
    if (!media || !call || !offer) return;
    const kinds = media.localVideo.map((video) => video.kind);
    const modalities = ["audio", ...kinds.map(modalityFor)];
    try {
      const result = await this.backend.callOfferMedia(call.id, offer, modalities, kinds);
      // The answer is in the response when the service put it there, and arrives as a
      // `call_media` frame when it did not. Applying whichever came is what makes the
      // section carry anything.
      if (result.answer_sdp) await media.setRemoteAnswer(result.answer_sdp);
    } catch (error) {
      console.error(`[call] could not ${what}`, error);
      this.reportCall(callFailureMessage(error), "error");
      throw error;
    }
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

  /** Place a call in a one-to-one chat: reserve it, open the microphone, send the
   *  offer. Every step is the user's own click — nothing here starts on its own. */
  async startCall(conversationId: string): Promise<void> {
    if (isLive(this.get().callStatus.call)) return;
    dismissNotice(CALL_NOTICE);
    const attempt = ++this.callAttempt;
    let callId: string | null = null;
    try {
      const prepared = await this.backend.callPrepare({ conversation: conversationId });
      callId = prepared.call_id;
      const media = await this.openCallMedia({
        iceServers: prepared.ice_servers,
        // A one-to-one negotiates the camera and the screen up front, the way the real
        // client does. The backend decides it: the ring list is what says how many people
        // the call reaches.
        oneToOne: prepared.one_to_one === true,
      });
      // The user hung up while the microphone was opening: the reservation went back with
      // their click, so the offer must not go out and nothing is said.
      if (!this.adoptCallMedia(media, attempt)) return;
      await this.backend.callPlace(prepared.call_id, media.localSdp);
    } catch (error) {
      // A start the user stopped is not a failure to report: they were there, and the
      // hang-up already released the microphone and the reservation.
      if (!this.callAttemptStands(attempt)) return;
      this.reportCall(callFailureMessage(error), "error");
      this.stopCallMedia();
      // The backend reserved the call before the failure, so release it: a machine that
      // thinks it is dialling refuses the next call.
      if (callId) await this.hangUpCall();
      await this.refreshCallStatus();
    }
  }

  /**
   * Join a meeting — from the link its calendar event carries, or from the meeting's own
   * conversation in the chat list (see {@link MeetingAddress}).
   *
   * The same three steps as placing a call, and the same gate: the backend reserves the
   * call and hands back what a peer connection needs, the page opens the microphone,
   * and the SDP goes back. Nothing is joined without this click — the calendar's join
   * link is never followed on the user's behalf.
   */
  async joinMeeting(meeting: MeetingAddress, subject?: string): Promise<void> {
    if (isLive(this.get().callStatus.call)) return;
    dismissNotice(CALL_NOTICE);
    const attempt = ++this.callAttempt;
    let callId: string | null = null;
    try {
      const prepared = await this.backend.callPrepare({ meeting, subject });
      callId = prepared.call_id;
      const media = await this.openCallMedia({ iceServers: prepared.ice_servers });
      if (!this.adoptCallMedia(media, attempt)) return;
      await this.backend.callJoin(prepared.call_id, meeting, media.localSdp);
    } catch (error) {
      if (!this.callAttemptStands(attempt)) return;
      this.reportCall(callFailureMessage(error), "error");
      this.stopCallMedia();
      if (callId) await this.hangUpCall();
      await this.refreshCallStatus();
    }
  }

  /** Answer the call that is ringing: take its offer, open the microphone, answer. */
  async answerCall(): Promise<void> {
    const call = this.get().callStatus.call;
    if (!call || !call.can_accept) return;
    dismissNotice(CALL_NOTICE);
    const attempt = ++this.callAttempt;
    try {
      const prepared = await this.backend.callPrepare({ callId: call.id });
      if (!prepared.offer_sdp) throw new Error("that call carried nothing to answer");
      const media = await this.openCallMedia({
        iceServers: prepared.ice_servers,
        remoteOffer: prepared.offer_sdp,
      });
      if (!this.adoptCallMedia(media, attempt)) return;
      await this.backend.callAccept(call.id, media.localSdp);
    } catch (error) {
      if (!this.callAttemptStands(attempt)) return;
      this.reportCall(callFailureMessage(error), "error");
      this.stopCallMedia();
      await this.hangUpCall();
    }
  }

  /** End the call, or decline it while it is still ringing. The microphone is released
   *  here as well as on the backend's own frame, because the user asked for it now. */
  async hangUpCall(): Promise<void> {
    const call = this.get().callStatus.call;
    // Whatever start is in flight is over: this click is the user saying so, and it is the
    // one thing an await inside that start cannot see (see {@link callAttempt}).
    this.callAttempt += 1;
    this.stopCallMedia();
    if (!call) return;
    try {
      await this.backend.callHangup(call.id);
    } catch (error) {
      console.error("[call] the hangup failed", error);
    }
    await this.refreshCallStatus();
  }

  // ---- recording a call (teams-lite's own, and Teams is never told) ---------
  //
  // The whole feature lives in this page: the streams are the ones the call already
  // carries, the file is written by a `MediaRecorder` here, and it is kept in this
  // browser. Nothing in this slice reaches the backend, and nothing in it can — which is
  // the point (see lib/call-recording.ts).

  /** The recorder behind {@link AppState.callRecording}. Not reactive, for the reason the
   *  call's own media is not: it owns a canvas, a `MediaRecorder` and an `AudioContext`,
   *  and a re-render must never replace it. */
  private recorder: CallRecorder | null = null;

  /** Who was in the call while the recording ran, by name, the user included.
   *
   *  A UNION rather than a snapshot: somebody who joined half way through is in the file,
   *  so they are in the list. It is collected here because the roster changes under a
   *  running recording and the recorder has no reason to know about people. */
  private recordingPeople = new Set<string>();

  /** Object URLs handed out for playback, one per recording, revoked when it is deleted.
   *
   *  Cached because a URL is what a `<video>` holds and the history is virtualized: a card
   *  that scrolled out of view and back would otherwise mint a second URL for the same file
   *  and leak the first. */
  private recordingUrls = new Map<string, string>();

  /**
   * Start recording this call — the picture of everybody in it, and the audio of everybody
   * in it, into one file in this browser.
   *
   * Nothing is announced: this is not Teams' recording and it cannot be, so the people on
   * the call are not told (the control says so before it is pressed). Nothing is sent, and
   * no message goes out — the file appears in the conversation for this user alone, once it
   * is finished.
   */
  async startCallRecording(): Promise<void> {
    const call = this.get().callStatus.call;
    if (!callCanBeRecorded(call) || !call) return;
    if (this.get().callRecording || this.recorder) return;
    // What the LAST recording had to say is taken back, and nothing else: a notice about the
    // call — a camera it refused, a section it dropped — is about something still true.
    dismissNotice(RECORDING_NOTICE);
    try {
      const recorder = startCallRecorder(this.recordingInput(call));
      this.recorder = recorder;
      this.recordingPeople = new Set(this.callPeople(call));
      this.set({
        callRecording: {
          id: `rec-${recorder.startedAtMs}`,
          callId: call.id,
          startedAtMs: recorder.startedAtMs,
          saving: false,
        },
      });
    } catch (error) {
      // A browser that cannot record says so once, in its own sentence, and the call carries
      // on untouched: a recording is something extra a call can have, never a part of it.
      this.recorder = null;
      this.set({ callRecording: null });
      this.reportRecording(recordingFailureMessage(error), "error");
    }
  }

  /**
   * Stop recording and keep what was recorded.
   *
   * Every path out of a call comes through here — the user's own press, the hangup, the far
   * side leaving, calling being switched off — because the file has to be closed and written
   * whoever ended the call. A recording lost because somebody hung up would be the one
   * failure this feature cannot afford: there is no second copy anywhere.
   */
  async stopCallRecording(): Promise<void> {
    const recorder = this.recorder;
    const live = this.get().callRecording;
    if (!recorder || !live) return;
    // The recorder is released from this controller FIRST, so a second stop — the user's
    // press and the call ending in the same second — cannot write the file twice.
    this.recorder = null;
    this.set({ callRecording: { ...live, saving: true } });
    const call = this.get().callStatus.call;
    const title = call ? callStageTitle(call) : "Call";
    try {
      const blob = await recorder.stop();
      const endedAtMs = Date.now();
      if (blob.size === 0) {
        // A recorder stopped in the same second it started writes no frames at all. There is
        // nothing to keep, and an empty row in the history would be worse than the sentence.
        this.reportRecording(RECORDING_EMPTY_MESSAGE, "report");
        return;
      }
      const recording: CallRecording = {
        id: live.id,
        callId: live.callId,
        // The conversation is read at the END, from the call that is still in hand: a
        // meeting joined from a calendar link names none, and that recording lives in
        // Settings instead (see `recordingBelongsInHistory`).
        conversationId: call?.conversation_id?.trim() || null,
        title,
        startedAtMs: live.startedAtMs,
        endedAtMs,
        durationMs: Math.max(0, endedAtMs - live.startedAtMs),
        size: blob.size,
        mimeType: blob.type,
        participants: [...this.recordingPeople],
      };
      const kept = await putRecording(recording, blob);
      if (!kept) {
        // The file is in hand and this browser will not hold it — a full quota, a private
        // window. Saying so is all this app can do, and it is what the user needs in order
        // to make room and record again.
        this.reportRecording("This browser could not keep that recording.", "error");
        return;
      }
      this.set({ recordings: [recording, ...this.get().recordings] });
      this.reportRecording(recordingSavedMessage(recording), "report");
    } catch (error) {
      console.error("[call] the recording could not be written", error);
      this.reportRecording(recordingFailureMessage(error), "error");
    } finally {
      this.recordingPeople.clear();
      this.set({ callRecording: null });
    }
  }

  /** What the recorder should be drawing and mixing right now.
   *
   *  Built in one place, so the recording that starts and the recording that follows the call
   *  are made of the same thing. */
  private recordingInput(call: ActiveCall): RecordingInput {
    const state = this.get();
    const audio: CallAudio = this.callMedia?.audio ?? { microphone: null, remote: [] };
    return {
      sources: recordingSources(state.callVideo, state.callLocalVideo, state.callVideoNames),
      audio,
      title: callStageTitle(call),
    };
  }

  /** Everybody in the call by name, the user first. The roster's own words, and "You" for
   *  the one person it never names. */
  private callPeople(call: ActiveCall): string[] {
    return ["You", ...call.others.map((name) => name.trim()).filter(Boolean)];
  }

  /**
   * Re-point a running recording at what the call carries now.
   *
   * Called from every place the call's media changes: a camera coming on, a screen share
   * ending, a voice arriving, a subscription naming whose picture a section holds. The
   * recording never restarts — it is one file for one call, and the sources inside it change
   * exactly as they did on screen.
   */
  private syncRecorder(): void {
    const recorder = this.recorder;
    const call = this.get().callStatus.call;
    if (!recorder || !call) return;
    recorder.update(this.recordingInput(call));
    for (const person of this.callPeople(call)) this.recordingPeople.add(person);
  }

  /** Read every recording this browser holds, and whether it can hold one at all.
   *
   *  Metadata only — the files are read when one is played (see {@link recordingUrl}). */
  async loadRecordings(): Promise<void> {
    this.set({ recordingsCanBeKept: recordingsCanBeKept() });
    this.set({ recordings: await listRecordings() });
  }

  /**
   * A URL a `<video>` can play one recording from, or null when this browser does not hold
   * the file.
   *
   * It is an object URL over the stored blob, so playback and seeking are local and cost no
   * request — a recording never travels anywhere, not even to this app's own server.
   */
  async recordingUrl(id: string): Promise<string | null> {
    const held = this.recordingUrls.get(id);
    if (held) return held;
    const blob = await getRecordingBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.recordingUrls.set(id, url);
    return url;
  }

  /**
   * Forget one recording, file and all.
   *
   * There is nothing upstream to take it back from, so this deletion is the whole deletion —
   * which is why the card asks twice, exactly as deleting a message does.
   */
  async deleteCallRecording(id: string): Promise<void> {
    await deleteStoredRecording(id);
    const url = this.recordingUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.recordingUrls.delete(id);
    }
    this.set({ recordings: this.get().recordings.filter((recording) => recording.id !== id) });
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
   *  on its own, which is what it does for every reply this app never watched — with the
   *  work the run showed kept beside it, folded (see {@link agentTranscripts}). */
  forgetAgentRun(convId: string, runId: string): void {
    const timer = this.agentRunTimers.get(convId);
    if (timer) {
      clearTimeout(timer);
      this.agentRunTimers.delete(convId);
    }
    const run = this.get().agentRuns[convId];
    const runs = withoutAgentRun(this.get().agentRuns, convId, runId);
    if (runs === this.get().agentRuns) return;
    const kept = run && run.run_id === runId ? agentTranscriptOf(run) : null;
    this.set({
      agentRuns: runs,
      ...(kept
        ? { agentTranscripts: keepAgentTranscript(this.get().agentTranscripts, kept) }
        : {}),
    });
  }

  /** The reader's own fold on a transcript panel. Recorded per message, because the panel
   *  is remounted when the run ends and again on every pass of the virtualized history. */
  setAgentTranscriptOpen(messageId: string, open: boolean): void {
    this.set({
      agentTranscriptsOpen: { ...this.get().agentTranscriptsOpen, [messageId]: open },
    });
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
      this.publishMentionCandidates(id, cached);
      return;
    }
    const pending = this.mentionLoads.get(id);
    if (pending) return pending;
    const load = (async () => {
      try {
        const res = await this.backend.members(id);
        const people = dedupeCandidates(res.members ?? []);
        this.mentionsByConv.set(id, people);
        this.publishMentionCandidates(id, people);
      } catch {
        // Best-effort: no suggestions rather than an error in the composer.
      } finally {
        this.mentionLoads.delete(id);
      }
    })();
    this.mentionLoads.set(id, load);
    return load;
  }

  /**
   * How a CHANNEL is laid out, for the open above — `undefined` for a chat, for a channel
   * this page already knows, and for a read that failed.
   *
   * **IT IS PART OF OPENING THE CONVERSATION, and that placement is a bug fix rather than
   * tidiness.** It rode a `useEffect` in the pane first, which fires the moment `openId`
   * moves — so the answer landed in the middle of the pane's own open, while the history was
   * still in flight. Measured on the mock: a channel then opened 2 100px short of its end
   * with a second page pulled in behind it, because the pane read as "near the top" and
   * backfilled; the newest post in that channel was not mounted at all, which is what the
   * capture caught. Read here it lands in the SAME state change as the messages, so the rows
   * are decided once and nothing about the scroll can depend on which answer won a race.
   *
   * It costs no latency: `Promise.all` puts it beside the history read rather than after it.
   *
   * **The answer is kept for the session and never re-read.** The modality is fixed where the
   * channel was created, so a window on it would only be a second chance to ask; the BACKEND
   * caches it per process as well, so a reload of this page costs one small GET per channel
   * the reader visits and no more.
   *
   * **Best-effort, and what it falls back to is the surface that already shipped.** A read
   * that fails leaves the channel absent from the map, which `channelLayoutOf` reads as
   * POSTS — so a tenant this app cannot reach draws the channel exactly as it did before the
   * layout was read at all, rather than drawing nothing or reporting a fault the reader can
   * do nothing about.
   */
  private async channelLayoutFor(id: string): Promise<ChannelLayout | undefined> {
    if (!isChannelThreadId(id) || this.get().channelLayouts[id]) return undefined;
    try {
      return channelLayoutOf((await this.backend.channelLayout(id)).layout);
    } catch {
      return undefined;
    }
  }

  /**
   * Publish a conversation's mention candidates, with the CHANNEL ITSELF at the front where
   * the conversation is one.
   *
   * The channel row is derived HERE rather than cached with the roster, and that placement is
   * the point: the cache holds what the `members` read answered, while the channel row is
   * read off the sidebar's own list — which arrives on its own schedule. Cached with the
   * people it would be decided once, in the one window where `channels` may not have landed
   * yet (a deep link straight into a channel), and the row would then be missing for the
   * whole session with nothing to heal it. Deriving it costs one `find` per "@".
   *
   * It costs no network read either: a channel mention names the channel's own thread id
   * (measured — see `channelMentionCandidate`), which is the id this conversation is already
   * open under, and the name is the one the sidebar draws. It is FIRST because a bare "@"
   * then offers it above the people — one fixed row a reader learns once, over a list that
   * grows, which is the argument the providers already make against the personas.
   */
  private publishMentionCandidates(id: string, people: MentionCandidate[]): void {
    if (this.get().openId !== id) return;
    this.set({ mentionCandidates: this.mentionTargetsFor(id, people) });
  }

  /**
   * The same list, for the caller that cannot go through the guard above.
   *
   * `openConversation` writes `mentionCandidates` inside the batch that SETS `openId`, so
   * the guard would refuse its own conversation — and a second spelling that simply read the
   * roster cache is what left a channel with no channel row until the composer's next "@"
   * re-published it. One place decides what an "@" offers.
   */
  private mentionTargetsFor(id: string, people: MentionCandidate[]): MentionCandidate[] {
    const channel = this.get().channels.find((c) => c.id === id);
    const asMention = channelMentionCandidate({
      conversationId: id,
      // The name the SIDEBAR draws, through its own one mapping — so the row cannot be
      // labelled differently from the channel it names two panes away.
      name: channel ? channelLabel(channel) : "",
    });
    return asMention ? [asMention, ...people] : people;
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

  /** Switch the sidebar between the chat list, the channel tree, the mailbox, the
   *  calendar and the merge requests. Opening one of the lazy surfaces for the first time
   *  is what loads it — see `loadMailFolders`, `ensureCalendarLoaded`,
   *  `ensureGitLabLoaded`. */
  setSidebarTab(tab: SidebarTab): void {
    if (this.get().sidebarTab !== tab) this.set({ sidebarTab: tab });
    if (tab === "mail") void this.ensureMailLoaded();
    if (tab === "calendar") void this.ensureCalendarLoaded();
    if (tab === "gitlab") void this.ensureGitLabLoaded();
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

  /** Load the chats the user marked unread by hand. Same best-effort contract: on any
   *  failure a chat reads as Teams reports it. */
  private applyPersistedChatUnreads(): void {
    const unreads = readFlagMap(CHAT_UNREADS_KEY);
    if (unreads) this.set({ chatUnreads: unreads });
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

  /** Mark one chat unread — HERE, and this browser only.
   *
   *  Teams is told nothing: `mark_read` only ever publishes a horizon that moves
   *  FORWARD, and the read receipt the sender was already shown cannot be taken back,
   *  so there is no outward call to make and nothing to report (see `chatIsUnread`).
   *  There is no opposite of this method either — that is "Mark as read", which is the
   *  outward `markConversationRead` below. */
  markChatUnread(id: string): void {
    if (!this.get().conversations.some((c) => c.id === id)) return;
    const unreads = { ...this.get().chatUnreads, [id]: true };
    this.set({ chatUnreads: unreads });
    writeFlagMap(CHAT_UNREADS_KEY, unreads);
  }

  /** Drop the local unread marker, if the chat carries one. Both ways back from
   *  `markChatUnread` come through here — opening the chat, and marking it read — so a
   *  marker can never outlive the thing it was waiting for. */
  private clearChatUnread(id: string): void {
    if (this.get().chatUnreads[id] !== true) return;
    const unreads = { ...this.get().chatUnreads };
    delete unreads[id];
    this.set({ chatUnreads: unreads });
    writeFlagMap(CHAT_UNREADS_KEY, unreads);
  }

  /** Where a live message landed, with the setting that decides how loud it may be: a
   *  chat's mute (in Teams or here), or a channel's own Teams notification setting. Read
   *  on every inbound message, so a mute silences this app's notification and cue as
   *  well as dimming the row, and a channel is as quiet here as the user asked Teams to
   *  make it.
   *
   *  A thread this page holds in NEITHER list — a chat not synced yet, a channel of a
   *  team it has not read — is an unmuted chat: the frame is a message addressed to the
   *  user until something says otherwise. */
  private notifyPlacement(id: string): NotifyPlacement {
    const conversation = this.get().conversations.find((c) => c.id === id);
    if (conversation) return { kind: "chat", muted: chatIsMuted(conversation) };
    const channel = this.get().channels.find((c) => c.id === id);
    // Teams' own default, which is what the backend assumes for a channel whose setting
    // it could not read (see `store::ChannelAlerts`).
    if (channel) return { kind: "channel", alerts: channel.alerts ?? "mentions_only" };
    return { kind: "chat", muted: false };
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
    // The local marker is this browser's, so it goes first and always succeeds: a chat
    // Teams already holds read must not stay bold because the outward call was refused.
    this.clearChatUnread(id);
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

  // ---- the GitLab merge-request page ---------------------------------------
  //
  // Local-first in the same shape as mail: the backend answers every read from its own
  // durable cache and refreshes behind the page, so switching between merge requests is
  // instant and the fresh copy lands on an event. On top of that this holds a per-query
  // cache of its own, so flipping the sidebar's filter back and forth costs nothing at
  // all — not even a round trip to the backend.
  //
  // The four WRITES are the only outward things here, and each is one click: nothing on
  // this page ever posts, merges or closes on its own.

  /** Rows per (scope, state), so a filter the user has already looked at paints at once.
   *  Bounded by the eight combinations the two closed sets allow. */
  private gitlabListCache = new Map<string, MergeRequestList>();
  /** Detail / notes / pipeline per merge request, so walking back to one is instant.
   *  Bounded LRU — a session spent reviewing must not accumulate every merge request. */
  private gitlabDetailCache = new Map<string, MergeRequestDetail>();
  private gitlabNotesCache = new Map<string, GitLabDiscussionList>();
  /** The diff per merge request AND per depth, so walking back to one paints at once and the
   *  expanded read a reader paid for is never silently replaced by the plain one. */
  private gitlabDiffCache = new Map<string, GitLabDiff>();
  /** Which file the reader was on, per merge request. Kept OUT of the reactive state for the
   *  reason a draft is: it survives a walk away without re-rendering anything. */
  private gitlabDiffPathCache = new Map<string, string>();
  /** Comment drafts per merge request, so leaving a half-written comment and coming back
   *  keeps it. Kept OUT of the reactive state for the same reason chat drafts are. */
  private gitlabDraftCache = new Map<string, string>();
  /** The pipeline poll of the OPEN merge request, and nothing else: a page polls the one
   *  pipeline it is showing, and closing the page stops it. */
  private gitlabPipelineTimer: ReturnType<typeof setTimeout> | null = null;
  /** The log poll of the OPEN job, and nothing else. Leaving the page stops it, so a job log
   *  nobody is looking at asks GitLab nothing — the rule the pipeline poll already holds. */
  private gitlabJobLogTimer: ReturnType<typeof setTimeout> | null = null;

  private refreshGitLabList = coalesce(() => this.loadMergeRequests(false));

  /** Load the sidebar the first time the GitLab tab is shown. */
  private async ensureGitLabLoaded(): Promise<void> {
    if (this.gitlabListCache.size === 0) await this.refreshGitLabList();
  }

  /** Forget everything read through the old token or the old host. Called when either
   *  changes: what a token can see IS the page, so keeping a row would be showing one
   *  account's world under another's credentials. */
  private forgetGitLabReads(): void {
    this.gitlabListCache.clear();
    this.gitlabDetailCache.clear();
    this.gitlabNotesCache.clear();
    this.gitlabDiffCache.clear();
    this.gitlabDiffPathCache.clear();
    this.set({
      gitlabList: [],
      gitlabTotal: null,
      gitlabTruncated: false,
      gitlabListError: null,
      gitlabDetail: null,
      gitlabNotes: null,
      gitlabPipeline: null,
      gitlabPipelineError: null,
      gitlabApproval: null,
      gitlabDiff: null,
      gitlabDiffError: null,
    });
    if (this.get().sidebarTab === "gitlab") void this.loadMergeRequests(true);
    if (this.get().openMergeRequest) void this.reloadMergeRequest();
  }

  /** The key one query's rows are cached under. */
  private gitlabListKey(scope: MergeRequestScope, state: MergeRequestState): string {
    return `${scope}:${state}`;
  }

  /** Show the rows of one list answer, dropping anything that is no longer un-merged: a
   *  refresh that crossed a merge must not leave a merged row in a list whose whole
   *  promise is "not merged". */
  private applyGitLabList(list: MergeRequestList): void {
    const items = list.items.filter(isNotMerged);
    this.gitlabListCache.set(this.gitlabListKey(list.scope as MergeRequestScope, list.state as MergeRequestState), {
      ...list,
      items,
    });
    const state = this.get();
    if (list.scope !== state.gitlabScope || list.state !== state.gitlabState) return;
    this.set({
      gitlabList: items,
      gitlabTotal: list.total ?? null,
      gitlabTruncated: list.truncated === true,
      gitlabTokenSet: list.token_set !== false,
      gitlabListError: null,
      gitlabListLoading: false,
    });
  }

  /** Read the sidebar's list. `refresh` is the user's own Reload — it waits for GitLab
   *  rather than taking the backend's cached answer. */
  private async loadMergeRequests(refresh: boolean): Promise<void> {
    const { gitlabScope: scope, gitlabState: state } = this.get();
    const cached = this.gitlabListCache.get(this.gitlabListKey(scope, state));
    this.set({ gitlabListLoading: !cached || refresh, gitlabListError: null });
    try {
      const list = await this.backend.gitlabMergeRequests(scope, state, refresh);
      this.applyGitLabList(list);
    } catch (e) {
      const now = this.get();
      // A failed refresh behind rows on screen is noise; with nothing to show it is the
      // only thing the page can say.
      if (now.gitlabScope === scope && now.gitlabState === state) {
        this.set({
          gitlabListError: now.gitlabList.length === 0 ? errText(e) : now.gitlabListError,
          gitlabListLoading: false,
        });
      }
    }
  }

  /** Narrow (or widen) which merge requests the sidebar shows. */
  setGitLabScope(scope: MergeRequestScope): void {
    if (this.get().gitlabScope === scope) return;
    this.set({ gitlabScope: scope });
    this.showCachedGitLabList();
    void this.loadMergeRequests(false);
  }

  /** Switch between the open and the closed merge requests — the two halves of "not
   *  merged", and the only two this page can ask for. */
  setGitLabState(state: MergeRequestState): void {
    if (this.get().gitlabState === state) return;
    this.set({ gitlabState: state });
    this.showCachedGitLabList();
    void this.loadMergeRequests(false);
  }

  /** Paint whatever this filter held last, so a switch is never a blank list. */
  private showCachedGitLabList(): void {
    const { gitlabScope: scope, gitlabState: state } = this.get();
    const cached = this.gitlabListCache.get(this.gitlabListKey(scope, state));
    this.set({
      gitlabList: cached?.items ?? [],
      gitlabTotal: cached?.total ?? null,
      gitlabTruncated: cached?.truncated === true,
      gitlabListError: null,
      gitlabListLoading: !cached,
    });
  }

  /** Re-read the list from GitLab, at the user's own asking. */
  async reloadMergeRequests(): Promise<void> {
    await this.loadMergeRequests(true);
  }

  /** Open one merge request: paint what is cached at once, then read the four things the
   *  page shows — the detail, its approvals, its comments and its pipeline — in parallel,
   *  so one slow read never holds the others up. */
  async openMergeRequestPage(key: MergeRequestKey): Promise<void> {
    const id = mergeRequestId(key);
    const detail = this.gitlabDetailCache.get(id) ?? null;
    const notes = this.gitlabNotesCache.get(id) ?? null;
    // The depth is per merge request, so a reader who paid for the expanded read of THIS one
    // gets it back — while another merge request opens on the cheap read, as it should.
    const diff = this.gitlabDiffCache.get(this.gitlabDiffKey(id, "raw"))
      ?? this.gitlabDiffCache.get(this.gitlabDiffKey(id, "listed"))
      ?? null;
    this.stopPipelinePolling();
    // A job belongs to ONE merge request's pipeline, so opening another takes its log away — the
    // rule a diff comment already follows.
    this.stopJobLogPolling();
    this.set({
      openMergeRequest: key,
      gitlabJobLog: null,
      gitlabJobId: null,
      gitlabJobLogLoading: false,
      gitlabJobLogError: null,
      gitlabDetail: detail,
      gitlabDetailLoading: !detail,
      gitlabDetailError: null,
      gitlabNotes: notes,
      gitlabDiff: diff,
      gitlabDiffLoading: !diff,
      gitlabDiffError: null,
      gitlabDiffPath: this.gitlabDiffPathCache.get(id) ?? null,
      gitlabDiffDepth: diff?.expanded ? "raw" : "listed",
      // A name pressed in one branch's code says nothing about another's, so the panel closes
      // with the merge request rather than searching this diff for the last one's word.
      gitlabDiffSymbol: null,
      gitlabDiffOpenOnCode: false,
      // A reading belongs to ONE merge request. It is re-read from the store below rather than
      // carried over, and the view opens on the FILES — a themes view with the last branch's
      // reading in it would be a grouping of files this page is not drawing.
      gitlabReview: null,
      gitlabReviewBusy: false,
      gitlabReviewError: null,
      gitlabReviewChat: EMPTY_REVIEW_CHAT,
      gitlabReviewAsking: false,
      gitlabReviewAskError: null,
      gitlabReviewPending: null,
      gitlabReviewStreaming: "",
      // The pipeline is deliberately NOT cached across opens: a stale CI badge is the one
      // piece of this page that would be read as current when it is minutes old.
      gitlabPipeline: null,
      gitlabPipelineError: null,
      gitlabApproval: null,
      // A comment being written belongs to one line of one file, so opening another merge
      // request — or leaving this one — takes it away rather than carrying it over to a line
      // that means something else there.
      gitlabDiffSelection: null,
      gitlabDiffComment: null,
      gitlabDiffCommentDraft: "",
      gitlabDiffCommentBusy: false,
      gitlabDiffCommentError: null,
      gitlabCommentDraft: this.gitlabDraftCache.get(id) ?? "",
      gitlabReplyTo: null,
      gitlabActing: null,
      gitlabActionError: null,
      gitlabActionDone: null,
    });
    await this.loadMergeRequestPage(key, false);
  }

  /** Re-read everything about the open merge request.
   *
   *  COALESCED, and that is what keeps a write cheap: every write drops the backend's cache
   *  for that merge request and broadcasts `stale`, so the page is asked to re-read by its
   *  own action AND by the event its own action caused — and each read is four requests to
   *  GitLab. One in flight plus one trailing run is the whole amplification this can have
   *  (see `coalesce`, whose own doc names this exact loop). */
  private reloadOpenMergeRequest = coalesce(async () => {
    const key = this.get().openMergeRequest;
    if (key) await this.loadMergeRequestPage(key, true);
  });

  /** Re-read the open merge request. Called by a write's own broadcast, by the page's
   *  Reload, and by every action that changes what GitLab would answer. */
  async reloadMergeRequest(): Promise<void> {
    await this.reloadOpenMergeRequest();
  }

  private async loadMergeRequestPage(key: MergeRequestKey, refresh: boolean): Promise<void> {
    const id = mergeRequestId(key);
    const open = () => sameMergeRequest(this.get().openMergeRequest, key);

    const detail = this.backend
      .gitlabMergeRequest(key, refresh)
      .then((detail) => {
        this.cacheGitLabDetail(id, detail);
        if (open()) this.set({ gitlabDetail: detail, gitlabDetailError: null });
        // The approval read is addressed by URL — the same call the message menu makes,
        // so there is one answer about approvals in this app — and the URL is GitLab's
        // own, from the detail we just read.
        return this.loadMergeRequestApproval(key, detail.web_url);
      })
      .catch((e) => {
        if (open() && !this.get().gitlabDetail) this.set({ gitlabDetailError: errText(e) });
      })
      .finally(() => {
        if (open()) this.set({ gitlabDetailLoading: false });
      });

    // The reading this machine has already made. A local `get_setting`, so it costs no network and
    // rides the page's own load like the reads beside it.
    void this.loadGitLabReview(key);
    void this.loadGitLabReviewChat(key);

    const notes = this.backend
      .gitlabMergeRequestNotes(key, refresh)
      .then((notes) => {
        this.gitlabNotesCache.set(id, notes);
        if (open()) this.set({ gitlabNotes: notes });
      })
      .catch(() => {
        /* the comments are one panel: a failure there must not empty the page */
      });

    const pipeline = this.loadPipeline(key, refresh);
    const diff = this.loadDiff(key, this.get().gitlabDiffDepth, refresh);
    await Promise.all([detail, notes, pipeline, diff]);
  }

  /** The key one merge request's diff is cached under, per depth.
   *
   *  Per depth because the two answers differ in what they HOLD — the plain one carried 47
   *  patches of 100 files where the expanded one carried 142 of 149 (measured) — so one entry
   *  would serve a reader the cheap answer for the read they paid for. */
  private gitlabDiffKey(id: string, depth: DiffDepth): string {
    return `${id}:${depth}`;
  }

  /** Read what a merge request changed.
   *
   *  A failure costs the Changes panel and nothing else — the contract the comments already
   *  hold: this page is a header, four panels and a composer, and one panel that cannot be
   *  read must not empty the others. */
  private async loadDiff(
    key: MergeRequestKey,
    depth: DiffDepth,
    refresh: boolean,
  ): Promise<void> {
    const id = mergeRequestId(key);
    const open = () => sameMergeRequest(this.get().openMergeRequest, key);
    // Only claim the spinner while the reader has nothing on screen, or asked for this
    // read themselves: a background refresh behind a drawn diff is not something to say.
    if (open() && (!this.get().gitlabDiff || refresh)) this.set({ gitlabDiffLoading: true });
    try {
      const diff = await this.backend.gitlabMergeRequestDiff(key, depth, refresh);
      this.gitlabDiffCache.set(this.gitlabDiffKey(id, depth), diff);
      // The depth is checked as well as the merge request: a reader who asked for the
      // expanded read while the plain one was still travelling must not have it replaced by
      // the smaller answer that arrives second.
      if (open() && this.get().gitlabDiffDepth === depth) {
        this.set({ gitlabDiff: diff, gitlabDiffError: null });
      }
    } catch (e) {
      if (open() && this.get().gitlabDiffDepth === depth && !this.get().gitlabDiff) {
        this.set({ gitlabDiffError: errText(e) });
      }
    } finally {
      if (open() && this.get().gitlabDiffDepth === depth) this.set({ gitlabDiffLoading: false });
    }
  }

  /**
   * The file the reader is at in the open diff — the row the tree lights, and where the page
   * opens next time.
   *
   * It is written by a press on a row AND by the feed scrolling past the top of another file, so
   * it must be cheap and it must touch nothing else: a comment being written stays where it is,
   * because in a feed the reader never leaves the file it is about. It used to clear that
   * composer, which was right while the page drew one file at a time and would now throw away a
   * half-written comment for scrolling.
   */
  setGitLabDiffFile(path: string): void {
    if (this.get().gitlabDiffPath === path) return;
    const key = this.get().openMergeRequest;
    if (key) this.gitlabDiffPathCache.set(mergeRequestId(key), path);
    this.set({ gitlabDiffPath: path });
  }

  // ---- a comment on a diff line ---------------------------------------------

  /** One file of the open diff, by its own path. Every rule about a comment is relative to the
   *  file the GESTURE was made in — which in a feed is not the file the reader is at — so the
   *  path travels with the gesture and this is the one place it is resolved. */
  private diffFileAt(path: string | null | undefined) {
    if (!path) return null;
    return this.get().gitlabDiff?.files.find((file) => file.path === path) ?? null;
  }

  /**
   * The lines the reader is picking RIGHT NOW: their pointer is still down, or they have just
   * pressed a line number. Only the highlight moves.
   *
   * The composer deliberately does not open here. It appears at the END of the gesture
   * ({@link openGitLabDiffComment}), because a card drawn mid-drag inserts a row into the patch
   * and moves the line numbers under the reader's own pointer.
   */
  setGitLabDiffSelection(path: string, range: PierreLineRange | null): void {
    if (!range) {
      this.closeGitLabDiffComment();
      return;
    }
    if (!diffCommentsAvailable(this.diffFileAt(path), this.get().gitlabDetail?.diff_refs)) return;
    this.set({ gitlabDiffSelection: { path, range } });
  }

  /**
   * The gesture ENDED on these lines: open the composer under them.
   *
   * The range is the RENDERER's (a line number on a side); what it means is worked out by
   * `diffCommentTarget`, so a line the patch does not hold — a drag past the end of a hunk —
   * opens nothing rather than a composer about no line. `null` closes what is open, which is the
   * same gesture in reverse: pressing the lit line again.
   *
   * A range that resolves to the lines already open is left alone, draft and all: a reader
   * dragging over the same lines twice has not asked for their words to be thrown away.
   */
  openGitLabDiffComment(path: string, range: PierreLineRange | null): void {
    if (!range) {
      this.closeGitLabDiffComment();
      return;
    }
    const state = this.get();
    const file = this.diffFileAt(path);
    if (!diffCommentsAvailable(file, state.gitlabDetail?.diff_refs)) return;
    const target = diffCommentTarget(file, range);
    if (!target) return;
    const open = state.gitlabDiffComment;
    if (
      open &&
      open.path === target.path &&
      open.first.row === target.first.row &&
      open.last.row === target.last.row
    ) {
      return;
    }
    this.set({
      gitlabDiffSelection: { path, range },
      gitlabDiffComment: target,
      gitlabDiffCommentDraft: "",
      gitlabDiffCommentError: null,
    });
  }

  /** Stop writing that comment: the box goes, and so does the highlight it was about. */
  closeGitLabDiffComment(): void {
    if (!this.get().gitlabDiffComment && !this.get().gitlabDiffSelection) return;
    this.set({
      gitlabDiffSelection: null,
      gitlabDiffComment: null,
      gitlabDiffCommentDraft: "",
      gitlabDiffCommentError: null,
    });
  }

  /** What that composer holds. */
  setGitLabDiffCommentDraft(text: string): void {
    this.set({ gitlabDiffCommentDraft: text });
  }

  /**
   * Post the comment written on a diff line — a new thread there, or a reply into the thread
   * `discussionId` names.
   *
   * Outward: everybody watching the merge request is told, under the user's own name. So it
   * happens on their own Enter, the words STAY in the box until GitLab has taken them, and a
   * refusal is reported at that box rather than swallowed — the contract the chat composer
   * holds (see lib/send-failure.ts) and the merge-request page's own composer with it.
   *
   * It ANSWERS whether the comment landed, because a reply's box is held by the thread it is in
   * rather than by this store: without the answer that box would close on a refusal and take the
   * words with it, which is the one thing this contract forbids.
   */
  async postGitLabDiffComment(body: string, discussionId?: string): Promise<boolean> {
    const where = discussionId ?? null;
    const state = this.get();
    const key = state.openMergeRequest;
    const text = body.trim();
    if (!key || text === "" || state.gitlabDiffCommentBusy) return false;
    // A reply lands in the thread it answers, which already hangs where it hangs; only a NEW
    // comment carries a position. Sending both is refused by the backend, so the page must
    // not build both.
    // The file the COMMENT is about, never the one the reader has since scrolled to: the box
    // stays open while the feed moves under it.
    const position = discussionId
      ? null
      : diffCommentPosition(
          this.diffFileAt(state.gitlabDiffComment?.path),
          state.gitlabDetail?.diff_refs,
          state.gitlabDiffComment,
        );
    if (!discussionId && !position) {
      this.set({
        gitlabDiffCommentError: {
          thread: where,
          message:
            "This page cannot say which line that is about any more — reload the changes and pick it again.",
        },
      });
      return false;
    }
    this.set({ gitlabDiffCommentBusy: true, gitlabDiffCommentError: null });
    try {
      await this.backend.gitlabComment(key, text, discussionId, position ?? undefined);
      // Only now do the words leave the box, and only the composer that sent them closes: a
      // comment that never left must not vanish from under the person who wrote it.
      if (sameMergeRequest(this.get().openMergeRequest, key) && !discussionId) {
        this.set({ gitlabDiffSelection: null, gitlabDiffComment: null, gitlabDiffCommentDraft: "" });
      }
      await this.refreshGitLabNotes(key);
      return true;
    } catch (e) {
      this.set({ gitlabDiffCommentError: { thread: where, message: errText(e) } });
      return false;
    } finally {
      this.set({ gitlabDiffCommentBusy: false });
    }
  }

  /** Rewrite one of the user's OWN comments from the diff page.
   *
   *  The twin of [[editGitLabComment]], reporting in the thread the words are in rather than on
   *  the merge-request page — this is a full-screen surface of its own, and it holds several
   *  boxes at once. It ANSWERS whether the edit landed, so a refusal keeps the rewrite in the
   *  box the reader is looking at. */
  async editGitLabDiffComment(
    noteId: number,
    body: string,
    discussionId: string,
  ): Promise<boolean> {
    const key = this.get().openMergeRequest;
    const text = body.trim();
    if (!key || text === "" || this.get().gitlabDiffCommentBusy) return false;
    this.set({ gitlabDiffCommentBusy: true, gitlabDiffCommentError: null });
    try {
      await this.backend.gitlabEditComment(key, noteId, text);
      await this.refreshGitLabNotes(key);
      return true;
    } catch (e) {
      this.set({ gitlabDiffCommentError: { thread: discussionId, message: errText(e) } });
      return false;
    } finally {
      this.set({ gitlabDiffCommentBusy: false });
    }
  }

  /** Resolve one thread from the diff page, or open it again.
   *
   *  Each direction is the other's undo, so it is one press: nothing here needs a rail in place
   *  of an undo it has. A refusal is reported in the thread it is about — GitLab's own words,
   *  which on a comment that is not a thread say exactly that. */
  async setGitLabDiffThreadResolved(discussionId: string, resolved: boolean): Promise<void> {
    const key = this.get().openMergeRequest;
    if (!key || this.get().gitlabDiffCommentBusy) return;
    this.set({ gitlabDiffCommentBusy: true, gitlabDiffCommentError: null });
    try {
      await this.backend.gitlabResolveThread(key, discussionId, resolved);
      await this.refreshGitLabNotes(key);
    } catch (e) {
      this.set({ gitlabDiffCommentError: { thread: discussionId, message: errText(e) } });
    } finally {
      this.set({ gitlabDiffCommentBusy: false });
    }
  }

  /** Delete one of the user's OWN comments from the diff page — the undo that makes
   *  commenting here acceptable, offered where the comment is (see AGENTS.md § The
   *  trackers). The backend re-reads whose comment it is before it deletes, so this is a
   *  request rather than a claim, and the outcome is reported on this page. */
  async deleteGitLabDiffComment(noteId: number, discussionId: string): Promise<void> {
    const key = this.get().openMergeRequest;
    if (!key || this.get().gitlabDiffCommentBusy) return;
    this.set({ gitlabDiffCommentBusy: true, gitlabDiffCommentError: null });
    try {
      await this.backend.gitlabDeleteComment(key, noteId);
      await this.refreshGitLabNotes(key);
    } catch (e) {
      // In the thread the comment is in, which is the only place the reader can see what
      // failed to go away.
      this.set({ gitlabDiffCommentError: { thread: discussionId, message: errText(e) } });
    } finally {
      this.set({ gitlabDiffCommentBusy: false });
    }
  }

  /** Ask GitLab to expand the files it collapsed.
   *
   *  The reader's own ask, and it happens once: the answer is cached under its own depth, and
   *  `canExpandDiff` stops the control being offered again — the expanded read costs half a
   *  megabyte on a large merge request, and it does not always expand everything. */
  async expandGitLabDiff(): Promise<void> {
    const key = this.get().openMergeRequest;
    if (!key || !canExpandDiff(this.get().gitlabDiff)) return;
    const cached = this.gitlabDiffCache.get(this.gitlabDiffKey(mergeRequestId(key), "raw"));
    this.set({ gitlabDiffDepth: "raw", gitlabDiffError: null });
    if (cached) {
      this.set({ gitlabDiff: cached });
      return;
    }
    await this.loadDiff(key, "raw", false);
  }

  // ---- the AI reading of the diff -------------------------------------------

  /** Read the reading this machine has already made for the open merge request, if any.
   *
   *  It is a `get_setting` on the backend — no network, no agent — so it rides the page's own load
   *  like the four reads beside it. A failure is SILENT: a reading nobody has made yet and a read
   *  that failed both mean "there is nothing to draw", and the panel's own offer is what a reader
   *  acts on either way. */
  private async loadGitLabReview(key: MergeRequestKey): Promise<void> {
    try {
      const { review } = await this.backend.gitlabMergeRequestReview(key);
      if (sameMergeRequest(this.get().openMergeRequest, key)) this.set({ gitlabReview: review });
    } catch {
      /* a reading that cannot be read is a reading nobody has made — the offer stands either way */
    }
  }

  /** Read the FOLLOW-UP questions this machine has already asked about the open merge request.
   *
   *  Open like the reading's own read — a `get_setting`, so no network and no agent — and SILENT on a
   *  failure for its reason: a conversation nobody has had and a read that failed both mean there is
   *  nothing to draw, and the composer is what the reader acts on either way. */
  private async loadGitLabReviewChat(key: MergeRequestKey): Promise<void> {
    try {
      const { chat } = await this.backend.gitlabMergeRequestReviewChat(key);
      if (sameMergeRequest(this.get().openMergeRequest, key)) this.set({ gitlabReviewChat: chat });
    } catch {
      /* nothing to draw either way */
    }
  }

  /**
   * Ask a FOLLOW-UP about the reading: the same agent run, narrowed to what the reader tagged.
   *
   * **The question is DRAWN at once**, as the reader's own turn with no answer under it yet
   * (`gitlabReviewPending`). That is the rule `chessPending` already holds for a move and for its
   * reason: a run is tens of seconds, so a composer that takes the words and shows nothing until the
   * answer lands looks like one that lost them. The words go from the box to the transcript in one
   * frame, and they are never in neither.
   *
   * **A publish that FAILED takes the turn back**, and the caller puts the words back in the box
   * beside the reason (`gitlabReviewAskError`). That is the composer's own contract read through the
   * optimistic draw: a question that did not reach the model must end up where the reader can press
   * again, and a bubble left standing over a failure would say it was asked.
   */
  async askGitLabReview(question: string, tags: ReviewTag[]): Promise<boolean> {
    const key = this.get().openMergeRequest;
    if (!key || this.get().gitlabReviewAsking) return false;
    const wire = reviewTagsToWire(tags);
    this.set({
      gitlabReviewAsking: true,
      gitlabReviewAskError: null,
      // What really TRAVELS, so the pending turn says the same thing the real one will. The paths
      // are the wire's — bounded — rather than every file the reader tagged.
      gitlabReviewPending: {
        question,
        themes: wire.themes,
        paths: wire.paths,
        asked_ms: Date.now(),
      },
      // Nothing of the LAST answer, or a fresh question would open under the words of the one before.
      gitlabReviewStreaming: "",
    });
    try {
      const { chat } = await this.backend.gitlabAskMergeRequestReview(key, question, wire);
      // The real turn REPLACES the pending one in the same state change, so the transcript never
      // draws the question twice — which is what a separate clear would let a render between the two
      // do.
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        this.set({ gitlabReviewChat: chat, gitlabReviewPending: null, gitlabReviewStreaming: "" });
      }
      return true;
    } catch (e) {
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        this.set({
          gitlabReviewAskError: errText(e),
          gitlabReviewPending: null,
          gitlabReviewStreaming: "",
        });
      }
      return false;
    } finally {
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        this.set({ gitlabReviewAsking: false });
      }
    }
  }

  /** Remember how wide the reader dragged the reading's conversation column. */
  setGitLabReviewChatWidth(width: number): void {
    if (!Number.isFinite(width)) return;
    const next = Math.round(width);
    if (this.get().gitlabReviewChatWidth === next) return;
    this.set({ gitlabReviewChatWidth: next });
    try {
      localStorage.setItem(GITLAB_REVIEW_CHAT_WIDTH_KEY, String(next));
    } catch {
      /* ignore — a failed persist just does not survive a reload */
    }
  }

  /**
   * Ask for a reading of the open merge request's diff: ONE agent run, on this machine.
   *
   * It is the reader's own press and never automatic — the run costs them money and puts their
   * employer's code in a prompt that reaches a model provider (see `src/gitlab_review.rs`). So the
   * outcome is reported where the press was made, the words of a refusal are GitLab's or the CLI's
   * own, and a run already in flight is not started twice: the run is tens of seconds long, and a
   * reader who pressed again because nothing had happened yet would pay for two.
   */
  async runGitLabReview(): Promise<void> {
    const key = this.get().openMergeRequest;
    if (!key || this.get().gitlabReviewBusy) return;
    this.set({ gitlabReviewBusy: true, gitlabReviewError: null });
    try {
      const { review } = await this.backend.gitlabRunMergeRequestReview(key);
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        // The reading is shown the moment it lands, and the view switches to it: the reader pressed
        // a control that says "read this diff", so being left on the file feed would be a press
        // whose answer is somewhere they have to go and find.
        this.set({ gitlabReview: review });
      }
    } catch (e) {
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        this.set({ gitlabReviewError: errText(e) });
      }
    } finally {
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        this.set({ gitlabReviewBusy: false });
      }
    }
  }

  /** Switch between the unified and the split layout, and remember it. */
  setGitLabDiffLayout(layout: DiffLayout): void {
    if (this.get().gitlabDiffLayout === layout) return;
    this.set({ gitlabDiffLayout: layout });
    try {
      localStorage.setItem(GITLAB_DIFF_LAYOUT_KEY, layout);
    } catch {
      /* ignore — a failed persist just doesn't survive reload */
    }
  }

  /** Load the persisted layout choice. Best-effort and SSR-safe, like every other
   *  client-only preference: a failure leaves the unified default, which is the one that
   *  works at every width. */
  private applyPersistedDiffLayout(): void {
    try {
      const raw = localStorage.getItem(GITLAB_DIFF_LAYOUT_KEY);
      if (raw === "unified" || raw === "split") this.set({ gitlabDiffLayout: raw });
    } catch {
      /* ignore — the layout choice is non-critical */
    }
  }

  // ---- a name pressed in the code -------------------------------------------

  /**
   * The reader pressed a name in the diff: open the occurrences panel on it.
   *
   * The token comes from the renderer, so it is whatever Shiki made of a line — a brace, a string,
   * a run of whitespace. `symbolIsSearchable` is what decides, and a press on something that is
   * not a name does NOTHING rather than opening an empty panel: a side panel that appeared with
   * nothing in it would read as a bug, where a press that changes nothing reads as a brace not
   * being a name.
   *
   * Pressing the SAME name again closes the panel. That is the shape the comment gesture already
   * has (pressing the lit line again closes the box), and it is what makes the press its own undo.
   */
  openGitLabDiffSymbol(name: string, path: string, lineNumber: number, side: PierreSide): void {
    if (!symbolIsSearchable(name)) return;
    const open = this.get().gitlabDiffSymbol;
    if (open && open.name === name && open.path === path && open.lineNumber === lineNumber) {
      this.closeGitLabDiffSymbol();
      return;
    }
    this.set({ gitlabDiffSymbol: { name, path, lineNumber, side } });
  }

  /** Close the occurrences panel. */
  closeGitLabDiffSymbol(): void {
    if (!this.get().gitlabDiffSymbol) return;
    this.set({ gitlabDiffSymbol: null });
  }

  /**
   * Take the reader to one occurrence: that file becomes the one they are at, and the LIT line
   * moves to the occurrence they went to.
   *
   * The panel does NOT close — a reader walking a list of six occurrences is going to press the next
   * one — and the search does not run again, because it is keyed on the NAME and only the place has
   * moved. Moving the highlight is what says where they landed: the code the feed scrolls to is a
   * screenful of lines, and without it nothing in it says which one was the answer.
   */
  goToGitLabDiffOccurrence(path: string, lineNumber: number, side: PierreSide): void {
    const open = this.get().gitlabDiffSymbol;
    // Only ever while a name IS open: this is a press inside the panel that name opened.
    if (!open) return;
    this.setGitLabDiffFile(path);
    this.set({ gitlabDiffSymbol: { name: open.name, path, lineNumber, side } });
  }

  /**
   * Open a name's occurrences panel from the READING, where there is no line to have pressed.
   *
   * The reading's prose names things (§ AN AI READING OF THE DIFF); the diff page is where a list of
   * places belongs. So a chip there resolves to a PLACE before it navigates — `openGitLabDiffSymbol`
   * takes one because a press in the code has one, and this is the same state reached from a surface
   * that does not.
   *
   * `place` is the row the reader pressed inside the hover card, when they pressed one. With none it
   * is the FIRST place the name stands, in the diff's own order — the same order the panel will list,
   * so the reader lands on the row they would have pressed first anyway.
   *
   * It does nothing at all when the name stands nowhere: a chip is only ever minted for a name the
   * index holds, so that cannot happen from one — but the diff may have moved under a page that has
   * been open a while, and landing the reader on an empty panel would be worse than the press doing
   * nothing.
   */
  openGitLabReviewSymbol(
    name: string,
    place?: { path: string; lineNumber: number; side: PierreSide },
  ): void {
    if (!symbolIsSearchable(name)) return;
    const at = place ?? firstPlaceOf(this.get().gitlabDiff, name);
    if (!at) return;
    this.setGitLabDiffFile(at.path);
    this.set({
      gitlabDiffSymbol: { name, path: at.path, lineNumber: at.lineNumber, side: at.side },
      // THIS navigation opens on the code. It is an intent rather than something read back off the
      // symbol, because the symbol outlives the visit — see the field.
      gitlabDiffOpenOnCode: true,
    });
  }

  /** Consume the "open on the code" intent above. The diff page calls it on mount, having already
   *  read it: an intent that stayed set would make the NEXT arrival at that page — the Diffs tab,
   *  pressed later — skip its own file list on the strength of a press made two surfaces ago. */
  consumeGitLabDiffOpenOnCode(): void {
    if (!this.get().gitlabDiffOpenOnCode) return;
    this.set({ gitlabDiffOpenOnCode: false });
  }

  // ---- how wide the two side columns are ------------------------------------

  /** Remember how wide the reader dragged the files column. */
  setGitLabDiffFilesWidth(width: number): void {
    this.rememberDiffColumnWidth("gitlabDiffFilesWidth", GITLAB_DIFF_FILES_WIDTH_KEY, width);
  }

  /** Remember how wide they dragged the occurrences panel. */
  setGitLabDiffSymbolsWidth(width: number): void {
    this.rememberDiffColumnWidth("gitlabDiffSymbolsWidth", GITLAB_DIFF_SYMBOLS_WIDTH_KEY, width);
  }

  /** One spelling of "store a column width", because two would drift on the day one of them
   *  stopped rounding or stopped refusing a width that is not a number. */
  private rememberDiffColumnWidth(
    field: "gitlabDiffFilesWidth" | "gitlabDiffSymbolsWidth",
    key: string,
    width: number,
  ): void {
    if (!Number.isFinite(width)) return;
    const next = Math.round(width);
    if (this.get()[field] === next) return;
    this.set({ [field]: next } as Partial<AppState>);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* ignore — a failed persist just doesn't survive reload */
    }
  }

  /** Load the persisted column widths. Best-effort and SSR-safe like the layout above, and it
   *  validates by SHAPE rather than by range: what is a sensible width depends on the window, and
   *  that is `resolveDiffColumnWidths`' answer at draw time rather than this one's. A stored value
   *  that is not a positive number at all leaves the default. */
  private applyPersistedDiffColumnWidths(): void {
    try {
      const files = Number(localStorage.getItem(GITLAB_DIFF_FILES_WIDTH_KEY));
      if (Number.isFinite(files) && files > 0) this.set({ gitlabDiffFilesWidth: Math.round(files) });
      const symbols = Number(localStorage.getItem(GITLAB_DIFF_SYMBOLS_WIDTH_KEY));
      if (Number.isFinite(symbols) && symbols > 0) {
        this.set({ gitlabDiffSymbolsWidth: Math.round(symbols) });
      }
      // The READING's conversation column, read back here rather than in a loader of its own: it is
      // the same kind of preference, kept on the same terms.
      const chat = Number(localStorage.getItem(GITLAB_REVIEW_CHAT_WIDTH_KEY));
      if (Number.isFinite(chat) && chat > 0) this.set({ gitlabReviewChatWidth: Math.round(chat) });
    } catch {
      /* ignore — a column width is non-critical */
    }
  }

  private async loadMergeRequestApproval(key: MergeRequestKey, webUrl: string): Promise<void> {
    if (!webUrl) return;
    try {
      const { approval } = await this.backend.gitlabApprovals(webUrl);
      if (sameMergeRequest(this.get().openMergeRequest, key)) this.set({ gitlabApproval: approval });
    } catch {
      /* an approval panel that cannot be read shows nothing rather than a guess */
    }
  }

  /** Read the pipeline, and keep reading it while it moves.
   *
   *  THE live half of this page. The poll is armed only while the pipeline is actually in
   *  flight (see `pipelineIsLive`), so a finished pipeline costs nothing, and the backend's
   *  own cache window is what makes two open pages cost one request between them. */
  private async loadPipeline(key: MergeRequestKey, refresh: boolean): Promise<void> {
    try {
      const view = await this.backend.gitlabMergeRequestPipeline(key, refresh);
      if (!sameMergeRequest(this.get().openMergeRequest, key)) return;
      this.set({ gitlabPipeline: view, gitlabPipelineError: null });
      if (pipelineIsLive(view)) this.schedulePipelinePoll(key);
      else this.stopPipelinePolling();
    } catch (e) {
      // A pipeline that cannot be read leaves whatever is on screen as it stands and stops
      // polling: hammering a refusal would earn the token a rate limit. The REASON is kept for
      // the surface that has nothing else to draw — the pipeline page — and a page still
      // holding a pipeline keeps it rather than replacing a run with a sentence.
      if (sameMergeRequest(this.get().openMergeRequest, key) && !this.get().gitlabPipeline) {
        this.set({ gitlabPipelineError: errText(e) });
      }
      this.stopPipelinePolling();
    }
  }

  private schedulePipelinePoll(key: MergeRequestKey): void {
    this.stopPipelinePolling();
    this.gitlabPipelineTimer = setTimeout(() => {
      this.gitlabPipelineTimer = null;
      if (sameMergeRequest(this.get().openMergeRequest, key)) void this.loadPipeline(key, false);
    }, GITLAB_PIPELINE_POLL_MS);
  }

  private stopPipelinePolling(): void {
    if (this.gitlabPipelineTimer === null) return;
    clearTimeout(this.gitlabPipelineTimer);
    this.gitlabPipelineTimer = null;
  }

  /** Open ONE job's log — the page a job card opens.
   *
   *  It is read on its own rather than with the merge request: a pipeline holds up to fifteen
   *  jobs and each log is up to a megabyte, so reading them with the page would be the biggest
   *  read here made fifteen times over for the one card the reader might press. The job the URL
   *  names is put in the state FIRST, so the header can say which job is being read while the
   *  read is still travelling. */
  async openJobLog(key: MergeRequestKey, jobId: number): Promise<void> {
    this.stopJobLogPolling();
    // A different job's log must never be left on screen under a new job's header, so the old
    // one goes at once — the rule the pipeline follows across merge requests.
    if (this.get().gitlabJobId !== jobId) {
      this.set({ gitlabJobLog: null, gitlabJobLogError: null });
    }
    this.set({ gitlabJobId: jobId, gitlabJobLogLoading: !this.get().gitlabJobLog });
    await this.loadJobLog(key, jobId, false);
  }

  /** Re-read the open job's log at the user's own asking. */
  async reloadJobLog(): Promise<void> {
    const key = this.get().openMergeRequest;
    const jobId = this.get().gitlabJobId;
    if (!key || jobId === null) return;
    this.set({ gitlabJobLogLoading: true });
    await this.loadJobLog(key, jobId, true);
  }

  private async loadJobLog(
    key: MergeRequestKey,
    jobId: number,
    refresh: boolean,
  ): Promise<void> {
    // BOTH halves are checked on the way back, because both can change while a megabyte is
    // travelling: the reader can walk to another job, or to another merge request entirely.
    const open = () =>
      sameMergeRequest(this.get().openMergeRequest, key) && this.get().gitlabJobId === jobId;
    try {
      const log = await this.backend.gitlabJobLog(key, jobId, refresh);
      if (!open()) return;
      this.set({ gitlabJobLog: log, gitlabJobLogError: null });
      if (jobLogIsLive(log)) this.scheduleJobLogPoll(key, jobId);
      else this.stopJobLogPolling();
    } catch (e) {
      // A log that cannot be read leaves whatever is on screen standing and stops polling:
      // hammering a refusal would earn the token a rate limit. The reason is kept for a page
      // that has nothing else to draw, which is this one whenever no log has arrived.
      if (open() && !this.get().gitlabJobLog) this.set({ gitlabJobLogError: errText(e) });
      this.stopJobLogPolling();
    } finally {
      if (open()) this.set({ gitlabJobLogLoading: false });
    }
  }

  private scheduleJobLogPoll(key: MergeRequestKey, jobId: number): void {
    this.stopJobLogPolling();
    this.gitlabJobLogTimer = setTimeout(() => {
      this.gitlabJobLogTimer = null;
      if (sameMergeRequest(this.get().openMergeRequest, key) && this.get().gitlabJobId === jobId) {
        void this.loadJobLog(key, jobId, false);
      }
    }, GITLAB_JOB_LOG_POLL_MS);
  }

  private stopJobLogPolling(): void {
    if (this.gitlabJobLogTimer === null) return;
    clearTimeout(this.gitlabJobLogTimer);
    this.gitlabJobLogTimer = null;
  }

  /** Leave the job-log page. The merge request stays open underneath, because the reader came
   *  from it and is going back to it. */
  closeJobLog(): void {
    this.stopJobLogPolling();
    this.set({
      gitlabJobLog: null,
      gitlabJobId: null,
      gitlabJobLogLoading: false,
      gitlabJobLogError: null,
    });
  }

  closeMergeRequestPage(): void {
    this.stopPipelinePolling();
    this.stopJobLogPolling();
    this.set({
      openMergeRequest: null,
      gitlabJobLog: null,
      gitlabJobId: null,
      gitlabJobLogLoading: false,
      gitlabJobLogError: null,
      gitlabDetail: null,
      gitlabDetailError: null,
      gitlabNotes: null,
      gitlabPipeline: null,
      gitlabPipelineError: null,
      gitlabApproval: null,
      gitlabDiff: null,
      gitlabDiffLoading: false,
      gitlabDiffError: null,
      gitlabDiffPath: null,
      gitlabDiffDepth: "listed",
      // A name pressed in one branch's code says nothing about another's — and the panel's own
      // width is NOT reset here, because that is the persisted preference (see the field).
      gitlabDiffSymbol: null,
      gitlabDiffOpenOnCode: false,
      gitlabReview: null,
      gitlabReviewBusy: false,
      gitlabReviewError: null,
      gitlabReviewChat: EMPTY_REVIEW_CHAT,
      gitlabReviewAsking: false,
      gitlabReviewAskError: null,
      gitlabReviewPending: null,
      gitlabReviewStreaming: "",
      // A comment being written belongs to one line of one file, so opening another merge
      // request — or leaving this one — takes it away rather than carrying it over to a line
      // that means something else there.
      gitlabDiffSelection: null,
      gitlabDiffComment: null,
      gitlabDiffCommentDraft: "",
      gitlabDiffCommentBusy: false,
      gitlabDiffCommentError: null,
      gitlabCommentDraft: "",
      gitlabReplyTo: null,
      gitlabActing: null,
      gitlabActionError: null,
      gitlabActionDone: null,
    });
  }

  /** Store one detail and drop the least-recently-opened merge request past the budget.
   *
   *  Insertion order doubles as the LRU order, which is why the entry is re-inserted rather
   *  than merely written: `Map.set` on an existing key keeps its old position. */
  private cacheGitLabDetail(id: string, detail: MergeRequestDetail): void {
    this.gitlabDetailCache.delete(id);
    this.gitlabDetailCache.set(id, detail);
    this.trimGitLabCaches(id);
  }

  /** Drop the least-recently-opened merge request past the budget, never the open one. */
  private trimGitLabCaches(justUsed: string): void {
    while (this.gitlabDetailCache.size > RETAINED_MERGE_REQUESTS) {
      const oldest = this.gitlabDetailCache.keys().next();
      if (oldest.done || oldest.value === justUsed) break;
      this.gitlabDetailCache.delete(oldest.value);
      this.gitlabNotesCache.delete(oldest.value);
      this.gitlabDraftCache.delete(oldest.value);
      this.gitlabDiffPathCache.delete(oldest.value);
      // Both depths, because the diff is by far the largest thing kept per merge request —
      // measured at half a megabyte for one expanded read — and a reviewer walks through
      // dozens in a session.
      this.gitlabDiffCache.delete(this.gitlabDiffKey(oldest.value, "listed"));
      this.gitlabDiffCache.delete(this.gitlabDiffKey(oldest.value, "raw"));
    }
  }

  /** What the comment composer holds. Kept per merge request, so walking away and back
   *  keeps a half-written comment — the same promise the chat composer makes. */
  setGitLabCommentDraft(text: string): void {
    const key = this.get().openMergeRequest;
    if (key) this.gitlabDraftCache.set(mergeRequestId(key), text);
    this.set({ gitlabCommentDraft: text });
  }

  /** Reply into one thread, or stop replying (`null`) and write a new comment instead. */
  setGitLabReplyTo(discussionId: string | null): void {
    this.set({ gitlabReplyTo: discussionId, gitlabActionError: null });
  }

  /** Post the comment in the composer — a new one, or a reply into the open thread.
   *
   *  Outward: everybody watching the merge request is told, under the user's own name. So
   *  it happens on their Enter and nowhere else, the words STAY in the composer until
   *  GitLab has taken them, and a refusal is reported beside the box rather than swallowed
   *  (the same contract the chat composer holds — see lib/send-failure.ts). */
  async postGitLabComment(): Promise<void> {
    const state = this.get();
    const key = state.openMergeRequest;
    const body = state.gitlabCommentDraft.trim();
    if (!key || body === "" || state.gitlabActing) return;

    this.set({ gitlabActing: "comment", gitlabActionError: null, gitlabActionDone: null });
    try {
      await this.backend.gitlabComment(key, body, state.gitlabReplyTo ?? undefined);
      // Only now are the words gone from the box: a comment that never left must not
      // vanish from under the person who wrote it.
      this.gitlabDraftCache.delete(mergeRequestId(key));
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        this.set({ gitlabCommentDraft: "", gitlabReplyTo: null });
      }
      await this.refreshGitLabNotes(key);
    } catch (e) {
      this.set({ gitlabActionError: errText(e) });
    } finally {
      this.set({ gitlabActing: null });
    }
  }

  /** Delete one of the user's OWN comments. The backend re-reads whose it is before it
   *  deletes, so this is a request rather than a claim. */
  async deleteGitLabComment(noteId: number): Promise<void> {
    const key = this.get().openMergeRequest;
    if (!key || this.get().gitlabActing) return;
    this.set({ gitlabActing: `delete:${noteId}`, gitlabActionError: null, gitlabActionDone: null });
    try {
      await this.backend.gitlabDeleteComment(key, noteId);
      await this.refreshGitLabNotes(key);
      this.set({ gitlabActionDone: "Comment deleted." });
    } catch (e) {
      this.set({ gitlabActionError: errText(e) });
    } finally {
      this.set({ gitlabActing: null });
    }
  }

  /** Rewrite one of the user's OWN comments, from the merge-request page.
   *
   *  It ANSWERS whether the edit landed, because the box holding the words belongs to the
   *  component that opened it: without the answer that box would close on a refusal and take
   *  the rewrite with it. The backend re-reads whose comment it is before it writes. */
  async editGitLabComment(noteId: number, body: string): Promise<boolean> {
    const key = this.get().openMergeRequest;
    const text = body.trim();
    if (!key || text === "" || this.get().gitlabActing) return false;
    this.set({ gitlabActing: `edit:${noteId}`, gitlabActionError: null, gitlabActionDone: null });
    try {
      await this.backend.gitlabEditComment(key, noteId, text);
      await this.refreshGitLabNotes(key);
      this.set({ gitlabActionDone: "Comment rewritten." });
      return true;
    } catch (e) {
      this.set({ gitlabActionError: errText(e) });
      return false;
    } finally {
      this.set({ gitlabActing: null });
    }
  }

  /** Resolve one thread, or open it again, from the merge-request page.
   *
   *  Each direction is the other's undo, so it is one press and no confirmation — the shape
   *  the approval already has. What is REPORTED is what GitLab says the thread is now. */
  async setGitLabThreadResolved(discussionId: string, resolved: boolean): Promise<void> {
    const key = this.get().openMergeRequest;
    if (!key || this.get().gitlabActing) return;
    this.set({
      gitlabActing: `resolve:${discussionId}`,
      gitlabActionError: null,
      gitlabActionDone: null,
    });
    try {
      const answer = await this.backend.gitlabResolveThread(key, discussionId, resolved);
      await this.refreshGitLabNotes(key);
      this.set({ gitlabActionDone: answer.resolved ? "Thread resolved." : "Thread reopened." });
    } catch (e) {
      this.set({ gitlabActionError: errText(e) });
    } finally {
      this.set({ gitlabActing: null });
    }
  }

  private async refreshGitLabNotes(key: MergeRequestKey): Promise<void> {
    try {
      const notes = await this.backend.gitlabMergeRequestNotes(key, true);
      this.gitlabNotesCache.set(mergeRequestId(key), notes);
      if (sameMergeRequest(this.get().openMergeRequest, key)) this.set({ gitlabNotes: notes });
    } catch {
      /* the comment landed; a failed re-read is not a failed comment */
    }
  }

  /** MERGE the open merge request.
   *
   *  The one action in this app that no later click takes back, which is why it sends the
   *  `sha` the page DREW: GitLab refuses a merge whose sha is not the branch's head, so a
   *  merge request that moved since the reader looked is refused rather than landed. The UI
   *  asks for a second, explicit confirmation before calling this. */
  async mergeOpenMergeRequest(): Promise<void> {
    const state = this.get();
    const key = state.openMergeRequest;
    const detail = state.gitlabDetail;
    if (!key || !detail || state.gitlabActing) return;
    if (!detail.sha) {
      this.set({
        gitlabActionError:
          "This page does not know which commit to merge — reload it and look again.",
      });
      return;
    }

    this.set({ gitlabActing: "merge", gitlabActionError: null, gitlabActionDone: null });
    try {
      const { merge } = await this.backend.gitlabMerge(key, {
        sha: detail.sha,
        squash: detail.squash,
        removeSourceBranch: detail.should_remove_source_branch,
      });
      this.set({
        gitlabActionDone:
          merge.state === "merged"
            ? `Merged into ${detail.target_branch}.`
            : `GitLab reports it as ${merge.state}.`,
      });
      await this.reloadMergeRequest();
      // A merged merge request leaves a list whose promise is "not merged", so the
      // sidebar is re-read rather than left showing a row that is gone.
      await this.loadMergeRequests(true);
    } catch (e) {
      this.set({ gitlabActionError: errText(e) });
    } finally {
      this.set({ gitlabActing: null });
    }
  }

  /** Close the open merge request, or reopen it. Each direction undoes the other. */
  async setOpenMergeRequestState(change: "close" | "reopen"): Promise<void> {
    const key = this.get().openMergeRequest;
    if (!key || this.get().gitlabActing) return;
    this.set({ gitlabActing: change, gitlabActionError: null, gitlabActionDone: null });
    try {
      const { state } = await this.backend.gitlabSetMergeRequestState(key, change);
      this.set({ gitlabActionDone: state === "closed" ? "Closed." : "Reopened." });
      await this.reloadMergeRequest();
      await this.loadMergeRequests(true);
    } catch (e) {
      this.set({ gitlabActionError: errText(e) });
    } finally {
      this.set({ gitlabActing: null });
    }
  }

  /** Give the user's own approval, or take it back — the same call the message menu makes,
   *  so there is one approval path in this app and not two. */
  async setOpenMergeRequestApproval(approved: boolean): Promise<void> {
    const state = this.get();
    const key = state.openMergeRequest;
    const url = state.gitlabDetail?.web_url;
    if (!key || !url || state.gitlabActing) return;
    this.set({
      gitlabActing: approved ? "approve" : "unapprove",
      gitlabActionError: null,
      gitlabActionDone: null,
    });
    try {
      const { approval } = await this.backend.gitlabSetApproval(url, approved);
      if (sameMergeRequest(this.get().openMergeRequest, key)) {
        this.set({
          gitlabApproval: approval,
          gitlabActionDone: approved ? "Approved." : "Approval revoked.",
        });
      }
      // An approval can be what a merge was waiting for, so the detail is re-read: the
      // Merge button's own reason comes from `detailed_merge_status`.
      await this.reloadMergeRequest();
    } catch (e) {
      this.set({ gitlabActionError: errText(e) });
    } finally {
      this.set({ gitlabActing: null });
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
    // Opening a chat is what a person means by having read it, so it takes back a
    // marker they set by hand — the thread is on screen and `markThreadRead` is about
    // to publish the read anyway.
    this.clearChatUnread(id);
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
      // NOTHING chess-related is dropped on a conversation change any more, and that is the
      // key doing its job: every slot is keyed by conversation AND game, so a sentence about a
      // refused move cannot hang over another chat and a move pending in the thread the reader
      // just left cannot be drawn onto the board of the one they opened. What it buys is that a
      // premove survives the walk to another conversation and back, which is what a queued
      // intention should do.
        messages: cached?.messages ?? [],
      hasMoreOlder: cached?.has_more ?? false,
      loadingMessages: !cached,
      // Show any cached "seen by" positions instantly on re-open; the fetch below
      // (and live `read_receipt` events) then reconcile them.
      readReceipts: cachedReceipts ? [...cachedReceipts.values()] : [],
      // Whoever this thread can mention, when we already know — the CHANNEL itself
      // included, through the one function that decides that. Never another thread's
      // people: this slice belongs to the open conversation alone.
      mentionCandidates: this.mentionTargetsFor(id, this.mentionsByConv.get(id) ?? []),
    });

    // Fetch the current read positions best-effort — never blocks the open, and a
    // channel / receipts-disabled thread just resolves to no avatars.
    void this.loadReadReceipts(id);
    // Opening a thread reads it. From the cache first, so the marker clears with the
    // click; the newest page landing below marks again if it moved the position.
    this.markThreadRead(id);

    try {
      // The history, and — for a CHANNEL — how it is LAID OUT, read in parallel and landed in
      // ONE state change. See `channelLayoutFor` for why the two must arrive together.
      const [res, layout] = await Promise.all([this.backend.open(id), this.channelLayoutFor(id)]);
      const history = mergeRefreshedHistoryPage(this.messageCache.get(id), res);
      this.cacheMessages(id, history);
      if (this.get().openId === id) {
        this.set({
          messages: history.messages,
          hasMoreOlder: history.has_more,
          ...(layout ? { channelLayouts: { ...this.get().channelLayouts, [id]: layout } } : {}),
        });
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
    // And where the seal stands. `seal_changed` is how this page normally hears about it, and
    // an event that fired while the socket was down is an event nobody replays — so a
    // passphrase added on the other install on this machine would leave the padlock and the
    // composer's sentence wrong until a reload. It is a store read on the backend and costs no
    // network request; the messages above have already been reconciled.
    void this.loadSealStatus();
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
    // The read-receipts, mention, send-failure and chess slices are single-conversation —
    // drop them when nothing is open.
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
    // A CHANNEL is threaded and a chat is not, so a reply means two different things and the
    // difference is settled here rather than at each of the three surfaces that read it (see
    // `PendingReply.threadRoot`).
    const inChannel = this.get().channels.some((c) => c.id === message.conversation_id);
    this.set({
      replyingTo: { message, marker: null, threadRoot: inChannel ? threadRootOf(message) : null },
    });
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

  /**
   * Resolve a PICTURE a message carries to a local blob object URL, at the best resolution
   * its object store serves (see {@link fullSizeMediaUrl}): the view a Teams client writes
   * on an `<img>` is a reduced, re-encoded copy, and this app draws pictures rather than
   * previews of them.
   *
   * The cache is keyed on the URL the MESSAGE carries, never on the view that answered, so
   * the picture's identity is the message's own — which is what lets `MediaImage` retain and
   * release it without knowing which view the bytes came from.
   *
   * The reduced view is the FALLBACK, and it is what keeps this from ever costing a picture:
   * an object whose full view the store refuses (too large for the proxy's own cap, or a
   * shape this tenant does not publish) still draws exactly as it did before.
   */
  loadPicture(url: string): Promise<string> {
    const full = fullSizeMediaUrl(url);
    if (!full) return this.loadMedia(url);
    return this.loadBlob(url, async () => {
      try {
        return await this.backend.fetchMedia(full);
      } catch {
        return await this.backend.fetchMedia(url);
      }
    });
  }

  /** Resolve one picture a GitLab description or comment points at to a local blob object URL,
   *  fetching the bytes through the backend (see `gitlab-upload.ts` for why they cannot come
   *  any other way). Shares the media cache, so its LRU order and byte budget cover a merge
   *  request full of screenshots exactly as they cover a chat full of images. */
  loadGitLabUpload(upload: UploadRef): Promise<string> {
    return this.loadBlob(uploadKey(upload), () => this.backend.gitlabUpload(upload));
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
    this.rereadGitLabPeople();
  }

  /** Re-read what the GitLab page says about its people, after a rename.
   *
   *  A merge request's author is named by the BACKEND, which resolves them against the
   *  user's own Teams on the way out (`with_teams_people` in src/bin/server.rs) — so a
   *  rename changes that answer while GitLab's own copy of it is untouched. That is why the
   *  read asks for no refresh: it is served from the backend's own response cache, and
   *  nothing here reaches GitLab. Only what is already loaded is re-read; a list nobody has
   *  opened is named when it is. */
  private rereadGitLabPeople(): void {
    if (this.gitlabListCache.size > 0) void this.refreshGitLabList();
    const key = this.get().openMergeRequest;
    if (key) void this.loadMergeRequestPage(key, false);
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

  // ---- custom emoji --------------------------------------------------------

  /** The custom emoji pack, without the art bytes (those are fetched per name
   *  through {@link customEmojiUrl}).
   *
   *  Held behind ONE promise, dropped on `custom_emoji_changed` like the art beside it.
   *  Every message row asks for the pack — a code in a colleague's message may be one the
   *  user could take, and the quick reaction row offers their own — so opening a thread of
   *  forty bubbles used to be forty `custom_emoji` RPCs, and more as rows remount while
   *  the history scrolls. A failed read is dropped so the next caller retries. */
  loadCustomEmoji(): Promise<CustomEmoji[]> {
    const pending = (this.customEmojiList ??= this.backend
      .customEmoji()
      .then((res) => res.emoji ?? []));
    pending.catch(() => {
      if (this.customEmojiList === pending) this.customEmojiList = null;
    });
    return pending;
  }

  /** Resolve one custom emoji's art to a local blob object URL, fetching the bytes
   *  through the backend. Cached and de-duplicated per name; a "no art" miss is
   *  cached so it is never re-requested, while a transient failure is evicted for a
   *  later retry. Returns `null` when the emoji has no art. */
  customEmojiUrl(name: string): Promise<string | null> {
    if (!name) return Promise.resolve(null);
    // Concurrent fetches are deduplicated: two components drawing the same emoji in one
    // frame (the normal case in a virtualized history) get the same promise, so the bytes
    // are requested once.
    const cached = this.customEmojiCache.get(name);
    if (cached) return cached;

    const pending = (async () => {
      const res = await this.backend.customEmojiImage(name);
      if (!res.data_base64) return null;
      const blob = new Blob([base64ToArrayBuffer(res.data_base64)], {
        type: res.content_type || "application/octet-stream",
      });
      const objectUrl = URL.createObjectURL(blob);
      this.customEmojiObjectUrls.push(objectUrl);
      return objectUrl;
    })();

    this.customEmojiCache.set(name, pending);
    pending.catch(() => this.customEmojiCache.delete(name));
    return pending;
  }

  /** Add one emoji to the pack. The name must be valid and available, and exactly
   *  one source must be present. Rejects with the backend's own reason on failure.
   *
   *  A picture travels as BYTES and nothing else: the backend sniffs the type and reads
   *  the dimensions out of them (`custom_emoji::measure_art`) rather than believing a
   *  client, so a `content_type`, `width` or `height` here would be a field nothing on
   *  the other side reads. */
  async addCustomEmoji(params: {
    name: string;
    alias_of?: string;
    data_base64?: string;
    url?: string;
    media_url?: string;
    source: string;
  }): Promise<void> {
    await this.backend.customEmojiAdd(params);
  }

  /** Remove one emoji from the pack. Returns true when it existed, false when it
   *  was already gone. */
  async removeCustomEmoji(name: string): Promise<boolean> {
    const res = await this.backend.customEmojiRemove(name);
    return res.removed;
  }

  /** Import a pack of emoji, adding all that pass. Returns the count added. */
  async importCustomEmoji(emoji: Array<{
    name: string;
    alias_of: string;
    content_type: string;
    data_base64: string;
    width: number;
    height: number;
  }>): Promise<number> {
    const res = await this.backend.customEmojiImport(emoji);
    return res.added;
  }

  /** Export the pack with its art, for download. */
  async exportCustomEmoji(): Promise<{
    emoji: Array<{
      name: string;
      alias_of: string;
      content_type: string;
      data_base64: string;
      width: number;
      height: number;
    }>;
  }> {
    return await this.backend.customEmojiExport();
  }

  /** Call `listener` whenever the custom emoji pack changes — here, or in another
   *  page on this store. Returns the unsubscribe. */
  onCustomEmojiChange(listener: () => void): () => void {
    this.customEmojiListeners.add(listener);
    return () => {
      this.customEmojiListeners.delete(listener);
    };
  }

  /** Evict the custom emoji cache and notify listeners. Called both when this app
   *  makes the change and when the other backend sharing this store does
   *  (`custom_emoji_changed`), so two open pages and the two backends sharing the
   *  store agree. Without this, a replaced emoji keeps its old art until a reload. */
  private forgetCustomEmoji(): void {
    this.customEmojiList = null;
    for (const [name] of this.customEmojiCache) {
      this.customEmojiCache.delete(name);
    }
    for (const objectUrl of this.customEmojiObjectUrls) {
      URL.revokeObjectURL(objectUrl);
    }
    this.customEmojiObjectUrls = [];
    for (const listener of this.customEmojiListeners) listener();
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

  /** Load the Linear workspace a bare `STMN-3439` is addressed in (see `linearWorkspace`).
   *
   *  Best-effort, like the settings beside it: a failure leaves it null, and a reference then
   *  stays the word it is — which is what it was before this feature existed. The backend
   *  caches the answer for hours, so asking on every connect costs no request (see
   *  `linear_workspace` in src/bin/server.rs). */
  private async loadLinearWorkspace(): Promise<void> {
    try {
      const { workspace } = await this.backend.linearWorkspace();
      this.set({ linearWorkspace: workspace ?? null });
    } catch {
      // ignore — no chip is drawn for a bare identifier, and every link still is.
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
    // A new host or a new token changes who GitLab thinks we are, so what it said about
    // an approval no longer holds either — nor does anything the merge-request page read,
    // which is a whole world seen through that token.
    this.approvalResolved.clear();
    this.forgetGitLabReads();
    // A new Linear key may name another workspace, and the backend forgets its cached one on
    // the same write — so the page reads it again rather than keeping an address that key no
    // longer reaches.
    void this.loadLinearWorkspace();
    playCue("success");
    return settings;
  }

  /** Turn "Always available" on or off — and set the HOURS it keeps, and the ZONE they are
   *  kept in — reflecting the fresh view in state.
   *
   *  The whole schedule is always sent: the pane holds what the backend last answered with,
   *  so a call that omitted either half would clear the user's hours or their zone every time
   *  they touched the switch.
   *
   *  Not part of `saveSettings`, because this one publishes the user's own presence to
   *  Teams: it is gated like a send, and the state only moves once the backend says
   *  the status was actually changed. Rejects on failure so the switch can say why
   *  instead of claiming a status nobody outside this machine can see. */
  async setAlwaysAvailable(
    enabled: boolean,
    schedule: PresenceSchedule,
  ): Promise<AppSettings> {
    let settings: AppSettings;
    try {
      settings = await this.backend.setAlwaysAvailable(enabled, schedule);
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
   * Create or change one of the user's CUSTOM AGENTS, and adopt the status it answers with.
   *
   * The whole status comes back, exactly as it does from the other agent setters, so the
   * pane draws the backend's own answer rather than a local guess — a refused write leaves
   * what is really stored on screen. Rejects with the backend's reason (a name already
   * taken, a picture that is not an image), which the dialog says.
   */
  async saveAgentPersona(patch: AgentPersonaPatch): Promise<AgentStatus> {
    const status = await this.backend.agentPersonaSave(patch);
    this.set({ agent: status });
    // The face may have been replaced, and its cache key moves with `updated_ms` — but the
    // OLD blob is still held, so it is dropped here rather than left for the page's life.
    this.forgetPersonaAvatars();
    return status;
  }

  /** Forget one custom agent. `@bebou` is a plain word from the next message on. */
  async removeAgentPersona(name: string): Promise<AgentStatus> {
    const status = await this.backend.agentPersonaRemove(name);
    this.set({ agent: status });
    this.forgetPersonaAvatars();
    return status;
  }

  /**
   * Resolve one custom agent's face to a local blob object URL, fetching the bytes through
   * the backend. Null when it has none.
   *
   * Cached and de-duplicated per name AND per version: a history of forty bubbles from one
   * persona costs one request, and replacing the picture costs exactly one more. A "no face"
   * miss is cached so it is never re-requested; a transient failure is evicted for a retry —
   * the shape {@link customEmojiUrl} already has, because it is the same problem.
   */
  agentPersonaAvatarUrl(name: string, version: number): Promise<string | null> {
    if (!name) return Promise.resolve(null);
    const key = `${name}@${version}`;
    const cached = this.personaAvatarCache.get(key);
    if (cached) return cached;

    const pending = (async () => {
      const res = await this.backend.agentPersonaAvatar(name);
      if (!res.data_base64) return null;
      const blob = new Blob([base64ToArrayBuffer(res.data_base64)], {
        type: res.content_type || "application/octet-stream",
      });
      const objectUrl = URL.createObjectURL(blob);
      this.personaAvatarObjectUrls.push(objectUrl);
      return objectUrl;
    })();

    this.personaAvatarCache.set(key, pending);
    pending.catch(() => this.personaAvatarCache.delete(key));
    return pending;
  }

  /** Drop every cached face. Called when this app changes a persona and when the other
   *  backend sharing this store does (`agent_personas_changed`), so two open pages agree —
   *  the reason `forgetCustomEmoji` exists, for the same failure. */
  private forgetPersonaAvatars(): void {
    this.personaAvatarCache.clear();
    for (const objectUrl of this.personaAvatarObjectUrls) URL.revokeObjectURL(objectUrl);
    this.personaAvatarObjectUrls = [];
  }

  /**
   * Stop a run this backend is streaming, mid-answer.
   *
   * The user pressed Stop on the live bubble. This only asks — the backend flips the
   * run's switch, and the run's own path finalizes the message with the answer so far
   * and a "stopped by you" note. The overlay then tears down when the terminal frame
   * arrives, exactly as it does for a normal finish (`forgetAgentRun`), so nothing here
   * touches `agentRuns`.
   *
   * `stopped: false` means this backend does not own that run — it finished already, or
   * it is streaming on the other install on this machine. Rejects on a real failure, so
   * the button that called it can say why.
   */
  async stopAgentRun(runId: string): Promise<{ stopped: boolean }> {
    let result: { stopped: boolean };
    try {
      result = await this.backend.agentStop(runId);
    } catch (e) {
      playCue("error");
      throw e;
    }
    playCue("success");
    return result;
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

  // ---- a sealed chat (see lib/seal.ts) -------------------------------------
  //
  // The BACKEND is the encryption boundary (src/seal.rs): it seals every body it posts to a
  // sealed conversation and decrypts on every store read. So nothing below holds a key, a
  // passphrase or a byte of ciphertext — the four writes are asks, and the one secret that
  // ever comes back (`sealReveal`) is handed to the caller and never kept in state, which is
  // read by every subscriber and printed by every devtool.

  /** Read which chats this machine seals, and which passphrases it holds for each.
   *
   *  Best-effort, like the agent status beside it: a backend too old to know the method
   *  answers `unknown method`, and that must read as "nothing to say" rather than as a fault.
   *  The status then stays null and no surface says anything about sealing at all. */
  private async loadSealStatus(): Promise<void> {
    try {
      this.set({ sealStatus: await this.backend.sealStatus() });
    } catch {
      // ignore — null is what makes every seal decision draw nothing (see AppState.sealStatus).
    }
  }

  /**
   * Seal a conversation under a passphrase — the user's own, or one the backend invents when
   * none is given.
   *
   * It is the consent gate of the whole feature and not a display preference: from here on,
   * every message this machine posts to THAT chat leaves encrypted, and a colleague without
   * the passphrase reads none of them. So it is a write request, it names the conversation
   * explicitly, and the status that lands in state is the backend's own — a refused write
   * leaves what is really stored on screen.
   *
   * Returns the two things only the dialog needs: the passphrase when the BACKEND invented it
   * (the one time it crosses the socket, so the user can be shown what to give their
   * colleagues), and whether it opens the sealed messages the thread ALREADY holds — the
   * warning that catches two people sealing one chat under two different passphrases, which
   * is the sharpest failure this feature has.
   *
   * The MESSAGES are not re-read here. This write emits `seal_changed`, and that handler is
   * where the re-read lives — one path for our own write and for the other backend's, rather
   * than two that have to stay in step.
   *
   * Rejects with the backend's reason (a channel, a passphrase it refuses) so the dialog can
   * say why.
   */
  async sealSet(
    conversationId: string,
    passphrase?: string,
  ): Promise<{ passphrase?: string; opens_existing: boolean; key_ids_in_use: string[] }> {
    let result: SealSetResult;
    try {
      result = await this.backend.sealSet(conversationId, passphrase);
    } catch (e) {
      playCue("error");
      throw e;
    }
    this.adoptSealStatus(result);
    playCue("success");
    return {
      passphrase: result.passphrase,
      opens_existing: result.opens_existing,
      key_ids_in_use: result.key_ids_in_use,
    };
  }

  /**
   * Stop sealing NEW messages here, and keep every passphrase — so the messages already in
   * the thread stay readable.
   *
   * That is the whole difference from {@link sealForget}, and it is why this one needs no
   * confirmation: nothing becomes unreadable. Whether anything was really sealing is in the
   * fresh status this adopts, so there is nothing for the caller to report.
   *
   * Rejects on failure, so the control that called it can say why.
   */
  async sealOff(conversationId: string): Promise<void> {
    try {
      this.adoptSealStatus(await this.backend.sealOff(conversationId));
    } catch (e) {
      playCue("error");
      throw e;
    }
    playCue("success");
  }

  /**
   * Forget one passphrase. Every message it opened becomes unreadable on this machine, for
   * good.
   *
   * The one act in this feature that no later call takes back — the messages are still in the
   * thread and nothing here can open them again — so the surface asks twice, the way a
   * deletion does (see SEAL_FORGET_WARNING).
   *
   * Rejects on failure, so the control that called it can say why.
   */
  async sealForget(conversationId: string, keyId: string): Promise<void> {
    try {
      this.adoptSealStatus(await this.backend.sealForget(conversationId, keyId));
    } catch (e) {
      playCue("error");
      throw e;
    }
    playCue("success");
  }

  /**
   * The passphrase behind one key, for the user's own press.
   *
   * It exists so somebody who joins the conversation in March can be GIVEN something: a
   * passphrase this app could not show again would force a rotation of the whole chat just to
   * share it. Handed straight back to the caller and never written into state — a secret in a
   * reactive store is a secret every subscriber holds — and it sounds no cue, because nothing
   * changed: showing it IS the feedback.
   *
   * Rejects when this machine holds no passphrase for that key, so the row can say so.
   */
  async sealReveal(conversationId: string, keyId: string): Promise<string> {
    try {
      const { passphrase } = await this.backend.sealReveal(conversationId, keyId);
      return passphrase;
    } catch (e) {
      playCue("error");
      throw e;
    }
  }

  /** Take the status out of what a seal write answered, and nothing else.
   *
   *  Every one of them answers with the whole fresh view PLUS what it just did — and for
   *  `seal_set` that includes the passphrase. Assigning the answer wholesale would put that
   *  secret into reactive state, where it would outlive the dialog and reach every subscriber,
   *  so only the conversations are kept. */
  private adoptSealStatus(answer: SealStatus): void {
    this.set({ sealStatus: { conversations: answer.conversations } });
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

  // ---- signing in again, from here ---------------------------------------------
  // The remedy for the sign-in failure a container restart cannot fix: the identity broker
  // asks a human, and these bring its own window to whichever browser this app is being read
  // in (see src/signin.rs, SIGN-IN.md, and components/signin-panel.tsx).

  /** Start one. The answer is the FIRST state, not the outcome: most sign-ins finish with
   *  nobody typing anything, and the rest take as long as a person takes. */
  async startSignin(): Promise<void> {
    // Optimistic, and only as far as `starting`: the panel has to appear on the press, or the
    // reader presses again. Every later phase arrives from the backend.
    this.set({ signin: { ...INITIAL_SIGNIN, phase: "starting" }, signinDismissed: false });
    try {
      const answer = await this.backend.startSignin();
      if (answer.signin) this.set({ signin: answer.signin });
    } catch (e) {
      // A refusal is the whole answer here — the broker has no display, or this backend is
      // read-only — so it is shown in the panel the press opened rather than swallowed.
      this.set({
        signin: {
          ...INITIAL_SIGNIN,
          phase: "failed",
          detail: e instanceof Error ? e.message : String(e),
        },
      });
      playCue("error");
    }
  }

  /** Re-read the phase. The panel polls this while it waits, because the transition that
   *  matters — the broker putting a window up — is one the backend can only notice when it is
   *  asked: there is no signal that says "I am asking a human". */
  async refreshSignin(): Promise<void> {
    try {
      const next = await this.backend.signinStatus();
      if (next && typeof next.phase === "string") this.set({ signin: next });
    } catch {
      // A poll that failed says nothing: the socket blinking is not a sign-in failing, and
      // the next tick answers. What the app holds stays the last phase the backend stated.
    }
  }

  /** One frame of the broker's window. Held by the panel, never by this state: it is a PNG a
   *  second, and the rest of the app has no use for it. */
  signinFrame(): Promise<{ width: number; height: number; png: string }> {
    return this.backend.signinFrame();
  }

  /** One keystroke, or one click, into that window. */
  signinInput(
    input: { char: string } | { key: string } | { x: number; y: number; button?: string },
  ): Promise<{ sent: boolean }> {
    return this.backend.signinInput(input);
  }

  /** Put the panel away without touching the sign-in.
   *
   *  Not the same act as cancelling, and keeping them apart is the point: a reader may want
   *  the app back while the broker still holds their window — they are reaching for their
   *  phone — and the banner offers the panel again. Only Cancel ends the flow. */
  dismissSignin(): void {
    // The flow is left alone and so is its state, so the reader can be shown how it ended if
    // they open the panel again — what is remembered is that they closed it.
    this.set({ signinDismissed: true });
  }

  /** Close the window, which is how a flow is ended. */
  async cancelSignin(): Promise<void> {
    try {
      await this.backend.cancelSignin();
    } catch (e) {
      // Report it and leave the phase alone: the backend decides what a sign-in became, and a
      // cancel that failed has ended nothing.
      this.set({ status: e instanceof Error ? e.message : String(e) });
      playCue("error");
      return;
    }
    // The phase itself arrives as the backend's own `cancelled`, once the broker's pending
    // call comes back — one spelling of "how it ended", never this page's guess.
    void this.refreshSignin();
  }

  /** Ask GitHub now whether a newer build exists — Settings › This app.
   *
   *  A read, so it is passed straight through: the row that offers an update follows the
   *  `update_available` event this may publish, exactly as it does after a poll, and the
   *  ANSWER is only what the button says. A failure to reach GitHub arrives as an outcome
   *  rather than as a rejection, so there is one place the words are chosen (see
   *  lib/maintenance.ts). */
  checkForUpdate(): Promise<UpdateCheckResult> {
    return this.backend.updateCheck();
  }

  /** Restart the backend — Settings › This app.
   *
   *  `force` is the user's second press, after the backend said a local agent is mid-reply.
   *  Nothing is set on the store: the socket drops a moment later and comes back on its own,
   *  which is the state the whole app already draws, and the ROW that asked is where the
   *  outcome belongs. A refused request sounds, like a refused repair — an accepted one does
   *  not, because what the user asked for has not happened yet. */
  async restartBackend(force: boolean): Promise<BackendRestartResult> {
    try {
      return await this.backend.restartBackend(force);
    } catch (e) {
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

  /** The approval state of a merge request, freshly read from GitLab through the backend,
   *  and remembered for the next menu open (see {@link cachedApproval}).
   *
   *  A READ: it names who has approved and whether the user's own approval is among them,
   *  which is what decides whether the menu offers "Approve" or "Revoke approval". A
   *  transient failure resolves to "no approval state", so the menu offers nothing rather
   *  than an action it cannot stand behind. */
  async mergeRequestApproval(url: string): Promise<GitLabApprovalResult | null> {
    try {
      const result = await this.backend.gitlabApprovals(url);
      this.approvalResolved.set(url, result);
      return result;
    } catch {
      return null;
    }
  }

  /** What {@link mergeRequestApproval} last answered for this URL, without awaiting, so a
   *  reopened menu draws the state it showed before rather than flickering through
   *  "unknown". `undefined` when this session has never read it. */
  cachedApproval(url: string): GitLabApprovalResult | undefined {
    return this.approvalResolved.get(url);
  }

  /** Give the user's own approval to a merge request, or take it back, and answer with the
   *  state GitLab reports afterwards.
   *
   *  THE one write this app makes to a tracker (see src/gitlab_approval.rs): it is
   *  token-gated like a send, it carries out one click the user just made, and it is
   *  offered only because the same call undoes it. The outcome is RETURNED rather than
   *  swallowed into the status line — the menu the user clicked in reports it, the way the
   *  composer reports a failed send — and the status line carries the raw sentence too,
   *  for whoever reads a screenshot. */
  async setMergeRequestApproval(url: string, approved: boolean): Promise<GitLabApprovalResult> {
    try {
      const result = await this.backend.gitlabSetApproval(url, approved);
      this.approvalResolved.set(url, result);
      const what = result.approval?.reference ?? "the merge request";
      this.setStatus(approved ? `Approved ${what} on GitLab` : `Revoked your approval of ${what}`);
      return result;
    } catch (e) {
      // The reason is GitLab's own sentence (see `refusal` in src/gitlab_approval.rs), so
      // it is shown as it arrived rather than replaced by a cue.
      const reason = e instanceof Error ? e.message : String(e);
      this.setStatus(`error: ${reason}`);
      throw e;
    }
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
  // ---- scheduled messages (what Teams is holding for later) -----------------

  /**
   * Load the messages Teams is holding, into {@link AppState.scheduledMessages}.
   *
   * An ordinary read that costs no network request on the backend either, so it is called
   * freely: when the list is opened, and after anything that changes what is queued.
   */
  async loadScheduledMessages(): Promise<void> {
    try {
      const { messages } = await this.backend.scheduledMessages();
      this.set({ scheduledMessages: messages });
    } catch (e) {
      this.set({ status: `scheduled messages failed: ${errText(e)}` });
    }
  }

  /**
   * Cancel a scheduled message: Teams never delivers it.
   *
   * It is the ORDINARY `delete`, and that is measured rather than assumed — `DELETE` on a
   * held message clears its `scheduledsendtime` and sets `deletetime`
   * (`examples/scheduled_send_probe.rs`), so the one call both stops the delivery and takes
   * the row out of the list. Nothing new is gated: `delete` is already an
   * `OUTWARD_METHODS` entry, and the row asks twice before calling it exactly as a
   * message's own Delete does.
   *
   * Cheaper than a re-read for the reader, but the list is re-read anyway: the store is
   * the authority on what is still queued, and a row dropped locally on a call that failed
   * would tell them a message is cancelled when it is not.
   */
  async cancelScheduledMessage(message: ChatMessage): Promise<boolean> {
    try {
      await this.backend.deleteMessage(message.conversation_id, message.id);
    } catch (e) {
      this.set({ status: `cancel failed: ${errText(e)}` });
      playCue("error");
      return false;
    }
    await this.loadScheduledMessages();
    return true;
  }

  /**
   * Send a scheduled message NOW: cancel the held one, post the same body immediately.
   *
   * Two calls rather than one, deliberately. The service DOES release a held message when
   * it is edited — measured — but resting "send now" on that side effect would make it a
   * silent no-op the day the tenant stops doing it, and an edit is not what the reader
   * asked for. Cancel-then-send is two writes this app already makes, in the order that
   * cannot double-post: if the send fails the message is simply cancelled, which the list
   * then shows, rather than delivered twice.
   */
  async sendScheduledMessageNow(message: ChatMessage): Promise<boolean> {
    if (!(await this.cancelScheduledMessage(message))) return false;
    try {
      await this.backend.send(
        message.conversation_id,
        copyableMessageText(message),
        undefined,
        // The body as Teams stored it, so formatting, mentions' own spans and inline
        // pictures survive — the plain text above is only the fallback a `Text` frame needs.
        message.content || undefined,
        [],
        undefined,
        undefined,
        // And its TITLE, because this is a re-send: the held message carries the subject
        // Teams stored, and posting the words without it would deliver an announcement
        // stripped of the line above them.
        message.thread_subject || undefined,
      );
    } catch (e) {
      this.set({ status: `send failed: ${errText(e)}` });
      if (this.get().openId === message.conversation_id) {
        this.set({ sendError: sendFailureMessage(e) });
      }
      playCue("error");
      return false;
    }
    await this.loadScheduledMessages();
    return true;
  }

  /**
   * Take a scheduled message back into the composer of its own conversation: cancel it, put
   * its words in that thread's draft, and open the thread.
   *
   * This is the one row that covers both "edit the words" and "pick another time", and it
   * is that shape because the service leaves no other: **an edit RELEASES a held message**
   * (it is delivered at once) and a `properties` PUT of the moment is refused
   * `400 InvalidMessagePropertyType` — both measured. So the honest offer is to un-queue it
   * and hand it back, where the words and the moment are both the reader's again.
   */
  async editScheduledMessage(message: ChatMessage): Promise<boolean> {
    const text = copyableMessageText(message);
    if (!(await this.cancelScheduledMessage(message))) return false;
    await this.openConversation(message.conversation_id);
    // Both halves: the DRAFT so it survives a reload and a walk through other threads, and
    // the restore so the editor already on screen really shows the words. Setting the draft
    // alone changed nothing visible, because the editor seeds from it at mount.
    this.setDraftText(text);
    this.set({
      composerRestore: {
        conversation: message.conversation_id,
        text,
        // A titled post hands its TITLE back too, or the reader re-posts an announcement
        // with the heading silently removed. It is not in the draft: a draft is words, and
        // the title is a property of the message (see lib/post-subject.ts).
        subject: message.thread_subject || undefined,
        token: (this.get().composerRestore?.token ?? 0) + 1,
      },
    });
    return true;
  }

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
  async reactToMessage(messageId: string, pick: ReactionPick): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    try {
      await this.backend.react(id, messageId, pick);
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
   *
   * `scheduledAt` (epoch ms) hands the message to Teams to deliver at that moment instead
   * of now. It is the same request either way — the service holds it, so nothing here
   * waits and the app may be closed when it goes out — and it is reported the same way: a
   * failure at the composer, and for a scheduled one a note saying where the words went,
   * because they leave the box and the message is not in the thread yet.
   */
  async sendDraft(
    text: string,
    html?: string,
    images: SendImage[] = [],
    mentions?: OutboundMention[],
    scheduledAt?: number,
    /** The post's TITLE, where the composer offered one — a channel post, never a chat
     *  message and never a reply (see lib/post-subject.ts). It rides in the send that
     *  posts the words it titles, exactly as the pictures and the mentions do. */
    subject?: string,
  ): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    const clean = text.trim();
    const richHtml = html?.trim() || undefined;
    if (!clean && !richHtml && images.length === 0) return false;

    const submittedDraft = this.draftCache.get(id) ?? this.get().draft;
    const reply = this.get().replyingTo;
    // Which thread this post lands in, decided when the reply started (`startReply`). A reply
    // into a channel thread QUOTES only when it answers another reply: a quote of the
    // announcement above the first answer in the announcement's own thread says one thing
    // twice, and Teams draws none there either (see lib/threads.ts). In a chat, where there
    // are no threads, a reply stays the quote it always was.
    const threadRoot = reply?.threadRoot ?? undefined;
    const quotes = !reply ? false : !reply.threadRoot || threadReplyQuotes(reply.message);
    const replyTo: ReplyTo | undefined =
      reply && quotes ? replyToPayload(reply.message, "", clean) : undefined;

    try {
      await this.backend.send(
        id,
        clean,
        replyTo,
        richHtml,
        images,
        mentions,
        scheduledAt,
        subject,
        threadRoot,
      );
    } catch (e) {
      // Both surfaces, and each has its reader. The status line keeps the RAW failure,
      // which is what a developer reads off a screenshot; the composer gets one sentence
      // for the person who pressed the button, next to the words that did not leave (see
      // lib/send-failure.ts). Only the open conversation is told: the message failed in
      // this one, and a sentence about it hanging over another thread would name nothing.
      this.set({ status: `send failed: ${errText(e)}` });
      if (this.get().openId === id) {
        this.set({ sendError: sendFailureMessage(e) });
      }
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
    // A SCHEDULED send leaves nothing in the thread, so what accounts for the words is the
    // queue — read it back rather than announcing it here, so the banner says what is really
    // waiting. Belt as well as braces: the live frame refreshes it too, and this covers a
    // tenant that echoes a held message on no feed at all.
    if (scheduledAt) void this.loadScheduledMessages();
    return true;
  }

  // ---- chess (a game played in the conversation) ---------------------------
  //
  // A move has to reach another machine and Teams has no private data channel, so every
  // challenge, accept, move, draw offer and resignation is an ordinary message in the thread
  // (see lib/chess-wire.ts). Nothing about the game is stored: the position replays out of
  // the history.

  /**
   * Publish one player's own LEDGER: their whole record of one game, in one message.
   *
   * It rides the existing `send` and `edit`, which are already the `OUTWARD_METHODS` entries
   * that gate every post this app makes: a move is the click the user just made, exactly as
   * pressing Enter in the composer is. Nothing here widens either gate, and this feature has no
   * RPC of its own.
   *
   * **THE FIRST ACT SENDS AND EVERY LATER ONE EDITS.** A challenge and an accept are new
   * messages, because they are how a game reaches the thread at all; every move after that
   * rewrites the same message, so a sixty-move game costs the conversation two messages rather
   * than sixty. `messageId` is the reader's own ledger message when they already have one, and
   * it comes from the DERIVATION (`game.ledgers[ourColor]`) rather than from anything this
   * store remembers — so a page that reloaded mid-game edits the right message.
   *
   * A MOVE is drawn before it lands and TAKEN BACK if the publish fails, which is the rule
   * `removeSentWords` follows for the words — and the failure is reported at the board rather
   * than swallowed into a cue, because a move that did not leave is otherwise invisible.
   */
  async publishChessLedger(
    conversationId: string,
    args: {
      game: string;
      ledger: ChessLedger;
      /** Our own ledger message, or null the first time. */
      messageId: string | null;
      /** The move this publish adds, when it adds one — what the board draws at once. */
      pending?: { ply: number; san: string; clockMs: number | null; at: number };
    },
  ): Promise<boolean> {
    const wire: ChessWire = { game: args.game, body: { kind: "ledger", ledger: args.ledger } };
    const key = chessSlotKey(conversationId, args.game);
    const { [key]: _wasError, ...otherErrors } = this.get().chessError;
    this.set({
      chessError: otherErrors,
      ...(args.pending
        ? { chessPending: { ...this.get().chessPending, [key]: args.pending } }
        : {}),
    });
    try {
      const text = chessMessageText(wire);
      const html = chessMessageHtml(wire);
      if (args.messageId) await this.backend.edit(conversationId, args.messageId, text, html);
      else await this.backend.send(conversationId, text, undefined, html);
    } catch (e) {
      // Both surfaces, and each has its reader: the status line keeps the RAW failure for
      // whoever reads a screenshot, the board gets the sentence the player acts on — under THAT
      // board, which is what the key is for.
      const { [key]: _gone, ...restPending } = this.get().chessPending;
      this.set({
        status: `chess ${args.messageId ? "edit" : "send"} failed: ${errText(e)}`,
        chessError: { ...this.get().chessError, [key]: sendFailureMessage(e) },
        // The move never left, so the board must not keep showing it.
        ...(args.pending ? { chessPending: restPending } : {}),
      });
      playCue("error");
      return false;
    }
    return true;
  }

  /**
   * Read every game this conversation's WHOLE STORED HISTORY holds, for the head-to-head score.
   *
   * The backend answers the chess-carrying messages (`chess_messages`, an ordinary open read that
   * makes no network request) and the derivation here turns them into games — the SAME derivation
   * the pane and the page use, so the wire keeps one spelling and the backend never needs the rules.
   *
   * It is asked when a BOARD is drawn rather than on connect: a reader who plays no chess must not
   * pay for this, and a score is only ever read beside a board. A read that fails leaves whatever
   * was there — a stale score is better than a score that vanishes — and the page still counts the
   * games the thread itself holds, which is what a sealed conversation gets in any case.
   *
   * **ONCE per conversation, because the askers are boards.** A history holds a card per game and
   * each one mounts and unmounts as the reader scrolls, so an ungated read would be one request per
   * board per pass. What that costs is that a game finishing does not re-read — and nothing needs it
   * to, because the thread's own live games win over this snapshot (`chessSeriesGames`).
   */
  async loadChessArchive(conversationId: string): Promise<void> {
    if (this.get().chessArchive[conversationId]) return;
    try {
      const { messages } = await this.backend.chessMessages(conversationId);
      this.set({
        chessArchive: { ...this.get().chessArchive, [conversationId]: chessGamesInThread(messages) },
      });
    } catch {
      // A backend too old to know the method, or one that could not answer. The series then counts
      // the loaded page alone, which is the honest fallback rather than an empty score.
    }
  }

  /**
   * Read what this machine holds of the engine, and remember it.
   *
   * Asked once when the app connects and again whenever a surface needs it: the answer is cheap (a
   * stat of two files) and the whole feature turns on it — a menu cannot offer a game against an
   * engine that is not there, and an offer drawn on a hopeful answer would start a game whose first
   * move nothing could make.
   */
  async loadChessEngine(): Promise<void> {
    try {
      const state = await this.backend.engineStatus();
      this.set({ chessEngine: { ...NO_CHESS_ENGINE, ...state } });
    } catch {
      // A backend too old to know the method, or one that could not answer: the engine reads as
      // ABSENT, which is what stops a game being offered that nothing could play.
      this.set({ chessEngine: NO_CHESS_ENGINE });
    }
  }

  /**
   * Read what this machine holds of the board's SOUNDS, and remember it.
   *
   * **THIS READ IS ALSO WHAT FETCHES THEM.** The backend starts the one 64 KB download on it (see
   * `Ctx::chess_sound_status`), so it is asked when a board mounts with the app's sounds ON and never
   * on connect: a reader who never plays chess must not make this app reach chess.com's CDN, and a
   * reader who turned the app's cues off has said they want no sound at all.
   *
   * A backend too old to know the method leaves the recordings ABSENT, which is exactly the state
   * the synthesized palette exists for.
   */
  async loadChessSounds(): Promise<void> {
    try {
      const state = await this.backend.chessSoundStatus();
      this.set({ chessSounds: { ...NO_CHESS_SOUNDS, ...state } });
    } catch {
      this.set({ chessSounds: NO_CHESS_SOUNDS });
    }
  }

  /** Give the disk back. The one action here that takes something away, so the row says how much. */
  async forgetChessSounds(): Promise<boolean> {
    try {
      const state = await this.backend.chessSoundForget();
      this.set({ chessSounds: { ...NO_CHESS_SOUNDS, ...state } });
      return true;
    } catch (e) {
      this.set({ status: `board sounds remove failed: ${errText(e)}` });
      playCue("error");
      return false;
    }
  }

  /**
   * Fetch the engine onto this machine — the user's own press.
   *
   * It is the BACKEND that downloads it (this page never fetches from a stranger's server) and the
   * backend that verifies it against a digest it pins, so all this does is ask and then draw what
   * comes back. The progress arrives as `chess_engine_progress` events, so a second window draws the same
   * bar and a reload picks it up.
   */
  async downloadChessEngine(): Promise<boolean> {
    try {
      const state = await this.backend.engineDownload();
      this.set({ chessEngine: { ...NO_CHESS_ENGINE, ...state } });
      return true;
    } catch (e) {
      // The refusal in the backend's own words, where the press was made: a download that did not
      // start must never be left looking like it did.
      this.set({
        status: `engine download failed: ${errText(e)}`,
        chessEngine: { ...this.get().chessEngine, downloading: false, error: errText(e) },
      });
      playCue("error");
      return false;
    }
  }

  /** Give the disk back. The one action here that takes something away, so the row says how much. */
  async forgetChessEngine(): Promise<boolean> {
    try {
      const state = await this.backend.engineForget();
      this.set({ chessEngine: { ...NO_CHESS_ENGINE, ...state } });
      return true;
    } catch (e) {
      this.set({ status: `engine remove failed: ${errText(e)}` });
      playCue("error");
      return false;
    }
  }

  /**
   * Set — or take back — the move that plays itself the moment the opponent's lands.
   *
   * It is stored rather than sent: a premove is a private intention, and posting one would be
   * telling a colleague what the reader is about to do. It becomes a real move through
   * {@link publishChessLedger} like any other, at which point it costs its player
   * `PREMOVE_SPEND_MS` of clock rather than the minutes their opponent spent.
   */
  setChessPremove(
    conversationId: string,
    game: string,
    move: { from: string; to: string; promotion?: "q" | "r" | "b" | "n" } | null,
  ): void {
    const key = chessSlotKey(conversationId, game);
    const { [key]: _gone, ...rest } = this.get().chessPremove;
    this.set({ chessPremove: move ? { ...rest, [key]: move } : rest });
  }

  /**
   * Forget a pending move once the thread really holds it.
   *
   * The message itself is what clears it: it arrives on the live feed, the derivation picks it
   * up, and from then on the board is drawing the thread rather than a guess. Called by the
   * card with the ply count the thread states.
   */
  settleChessMove(conversationId: string, game: string, plies: number): void {
    const key = chessSlotKey(conversationId, game);
    const pending = this.get().chessPending[key];
    if (!pending || plies < pending.ply) return;
    const { [key]: _landed, ...rest } = this.get().chessPending;
    this.set({ chessPending: rest });
  }

  // ---- a companion in a conversation -------------------------------------

  /**
   * Publish a pet's record — one message per person, rewritten in place.
   *
   * WHAT to publish is decided by `petPublishFor` (lib/pet-act.ts) and nothing about that decision is
   * repeated here: four surfaces press these controls, and a store that made its own choice about
   * what a feed writes would be a fifth answer. This is the imperative half — the RPC, the optimistic
   * draw and the rollback — and it needs no gate of its own, because `send` and `edit` are already
   * `OUTWARD_METHODS` entries and a pet's acts ride them exactly as a mention rides a send.
   *
   * **THE FIRST ACT SENDS AND EVERY LATER ONE EDITS.** Taking a creature is a new message, because it
   * is how a pet reaches the thread at all; every act after that rewrites the same message, so months
   * of feeding cost the conversation ONE message rather than hundreds. `messageId` comes from the
   * DERIVATION rather than from anything this store remembers, so a page that reloaded, a second
   * window and a phone all edit the right message.
   *
   * **THE EDIT CARRIES `content_html` AND THE PLAIN-TEXT TWIN.** An edit that carried only text would
   * have the ledger line ESCAPED — the trailing italic block stops matching, and every reader loses
   * the creature while its message is still there. That is why `content_html` exists on the edit RPC
   * at all (chess needed it first), and the text travels beside it for a client that shows no HTML.
   *
   * An act is drawn before it lands and TAKEN BACK if the publish fails, and the failure is reported
   * at the pet the reader pressed rather than swallowed into a cue — the composer's own rule, because
   * a feed that did not leave is otherwise invisible.
   *
   * **ONE PUBLISH AT A TIME PER CONVERSATION, and that is a correctness rail rather than a nicety.**
   * Every press a reader makes rewrites the SAME message — their one ledger for the whole thread —
   * and `petPublishFor` builds each one from the record as this page currently holds it. Two in
   * flight therefore both start from N acts, both write N+1, and the later edit wins: one act
   * silently gone from the only copy of it there is, whether the two presses were two feeds or a
   * removal racing a feed on a colleague's pet. So a second publish is REFUSED while
   * `petPending[conversationId]` is held — the same rule `use-chess-game.ts` applies one layer up
   * ("nothing of theirs already in flight"), held here because every surface goes through this.
   * It refuses silently: the press never left, so there is nothing to report, and a control should
   * not be offered while that slot is taken.
   */
  async publishPetLedger(conversationId: string, publish: PetPublish): Promise<boolean> {
    if (this.get().petPending[conversationId]) return false;
    const key = petSlotKey(conversationId, publish.pet);
    const { [key]: _wasError, ...otherErrors } = this.get().petError;
    this.set({
      petError: otherErrors,
      petPending: {
        ...this.get().petPending,
        [conversationId]: { pet: publish.pet, act: publish.pending ?? null },
      },
    });
    try {
      const text = petMessageText(publish.ledger, publish.label);
      const html = petMessageHtml(publish.ledger, publish.label);
      if (publish.messageId) await this.backend.edit(conversationId, publish.messageId, text, html);
      else await this.backend.send(conversationId, text, undefined, html);
    } catch (e) {
      // Both surfaces, and each has its reader: the status line keeps the RAW failure for whoever
      // reads a screenshot, the pet gets the sentence the reader acts on — under THAT pet, which is
      // what the key is for. The act never left, so nothing may keep drawing it.
      this.set({
        status: `pet ${publish.messageId ? "edit" : "send"} failed: ${errText(e)}`,
        petError: { ...this.get().petError, [key]: sendFailureMessage(e) },
        petPending: this.petPendingWithout(conversationId),
      });
      playCue("error");
      return false;
    }
    // Released on SUCCESS too, because from here the LEDGER holds it: the backend emits the edited
    // message before it answers, so a pending copy of the act would be counted twice (see
    // `petPending`).
    this.set({ petPending: this.petPendingWithout(conversationId) });
    return true;
  }

  /**
   * PAT a pet — a reaction on its ledger message, toggling.
   *
   * It is here rather than at the two surfaces that press it because of the FAILURE, not the call:
   * `reactToMessage` reports only into `status` and a cue, which is eleven pixels at the foot of a
   * sidebar, and a pat is the ONE thing a reader with no creature of their own can do — so swallowed,
   * their only control fails silently. The sentence therefore lands in `petError` under the same key
   * a refused feed uses (`petSlotKey`), which is what puts it under the creature the press was about
   * and nowhere else. Two surfaces read that slot: the menu draws the words, and the trigger in the
   * pet's own lane turns, which is where a reader who tapped the sprite is looking.
   *
   * It takes NO pending slot, and that is the difference from `publishPetLedger`: a reaction writes
   * no record, so it cannot lose an act to a race, and a toggle a reader presses twice is a toggle.
   */
  async patPet(conversationId: string, pet: { id: string; messageId: string }): Promise<boolean> {
    const key = petSlotKey(conversationId, pet.id);
    const { [key]: _wasError, ...otherErrors } = this.get().petError;
    this.set({ petError: otherErrors });
    try {
      await this.backend.react(conversationId, pet.messageId, { key: PET_PAT_KEY });
    } catch (e) {
      this.set({
        status: `pat failed: ${errText(e)}`,
        petError: { ...this.get().petError, [key]: sendFailureMessage(e) },
      });
      playCue("error");
      return false;
    }
    return true;
  }

  /**
   * Read every PET-carrying message this conversation's WHOLE STORED HISTORY holds.
   *
   * `pet_messages` is an ordinary open read that makes no network request — a pet IS its messages, so
   * the store already holds every one of them — and what comes back is merged into the loaded history
   * before the fold runs (`withPetArchive`, which argues why the fold must be complete rather than
   * merely helpful).
   *
   * **IT IS ASKED PER CONVERSATION AND ONLY WHILE COMPANIONS ARE ON.** A reader who turned the switch
   * off draws no creature, is offered no spawn and therefore cannot reach the bug this closes — the
   * split `loadChessArchive` makes for a reader who plays no chess. Once per conversation, because the
   * asker is a pane that re-renders on every scroll. What the switch does not buy is the FIRST
   * conversation they open: `petsShown` holds its hopeful `true` until `start()` has read the browser's
   * preference in an effect, so that one costs a store read (no network) and nothing after it does.
   *
   * **A READ THAT FAILS LEAVES NOTHING BEHIND, and that costs exactly what it did before.** A backend
   * too old to know the method, or one that could not answer, falls back to the loaded page — the
   * behaviour this replaces. It is not retried and no sentence is drawn: there is nothing the reader
   * could do about it, and a spawn refused on the strength of a read that failed would take the one way
   * into the feature away from somebody who really has no companion here.
   */
  async loadPetArchive(conversationId: string): Promise<void> {
    if (!this.get().petsShown) return;
    if (this.get().petArchive[conversationId]) return;
    try {
      const { messages } = await this.backend.petMessages(conversationId);
      this.set({ petArchive: { ...this.get().petArchive, [conversationId]: messages } });
    } catch {
      // See above: the loaded page alone is the honest fallback, and it is what shipped.
    }
  }

  /**
   * Drop the sentence about one pet without publishing anything — the one slot nothing else can reach.
   *
   * `petError` is keyed per PET so a refusal is drawn under the creature the press was about, and every
   * other key is reachable for ever: the pet is on screen, so its own menu and trigger keep reading it
   * and a later press clears it. A FIRST SPAWN's key is not, because its pet id is freshly minted and
   * held only by the receipt in `ConversationMenu` — and the RETRY mints ANOTHER one, so the moment
   * that receipt moves the old slot is a string no surface will ever draw again, growing by one on
   * every refused attempt. The component owns both ids at that instant, so it is the only thing that
   * can name the slot to drop; this is the write it needs.
   */
  forgetPetError(conversationId: string, petId: string): void {
    const key = petSlotKey(conversationId, petId);
    const { [key]: had, ...rest } = this.get().petError;
    if (had !== undefined) this.set({ petError: rest });
  }

  /** The conversations with a publish in flight, minus this one. */
  private petPendingWithout(
    conversationId: string,
  ): Record<string, { pet: string; act: PetFoldAct | null }> {
    const { [conversationId]: _done, ...rest } = this.get().petPending;
    return rest;
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

  // ---- companions (the pets a conversation draws) ---------------------------

  /** Load whether this window draws the companions. Best-effort and SSR-safe, like every other
   *  client-only preference here: a storage that cannot be read leaves the default (shown). */
  private applyPersistedPetsShown(): void {
    let shown = DEFAULT_PETS_SHOWN;
    try {
      shown = coercePetsShown(localStorage.getItem(PETS_SHOWN_STORAGE_KEY));
    } catch {
      /* ignore — a preference that cannot be read is not a reason to draw nothing */
    }
    this.set({ petsShown: shown });
  }

  /** Commit and persist whether this window draws the companions. It reaches nothing outside
   *  this browser: the pets live in the thread's own messages, so turning them off here leaves
   *  every one of them where it was for everybody else (see lib/pet-visibility.ts).
   *
   *  The value is `petsShownValue`'s and never spelled here, so the write and the read that
   *  loads it back cannot drift apart — a format written in one place and parsed in another is
   *  a preference that forgets, silently, on the next reload. */
  setPetsShown(shown: boolean): void {
    try {
      localStorage.setItem(PETS_SHOWN_STORAGE_KEY, petsShownValue(shown));
    } catch {
      /* ignore — a failed persist just doesn't survive reload */
    }
    this.set({ petsShown: shown });
  }
}

/** The FIRST place a name stands in a diff, in the diff's own order, or `null` when it stands
 *  nowhere.
 *
 *  It reads through `symbolOccurrences`, which is the one answer in this app to "where does this name
 *  stand in these changes" — so the place a chip lands on and the first row of the panel it opens are
 *  the same row by construction. The side is translated into the renderer's own two words, because
 *  that is the vocabulary a lit line is stated in. */
function firstPlaceOf(
  diff: GitLabDiff | null,
  name: string,
): { path: string; lineNumber: number; side: PierreSide } | null {
  const search = symbolOccurrences(diff, name);
  const file = search?.files[0];
  const occurrence = file?.occurrences[0];
  if (!file || !occurrence) return null;
  return {
    path: file.path,
    lineNumber: occurrence.lineNumber,
    side: pierreSideOf(occurrence.side),
  };
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
