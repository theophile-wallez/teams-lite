// Shared protocol types + pure message logic for the web app.
//
// These mirror the Rust backend's WebSocket protocol (see src/bin/server.rs).
// Nothing here touches the DOM, the network, or any runtime-specific API.

// Mirrors the Rust `ConversationKind` (src/store.rs).
export type ConversationKind = "one_on_one" | "group" | "notes" | "unknown";

/** One label/value pair of a card's fact list (an Adaptive Card `FactSet`, a
 *  connector card's `sections[].facts`). */
export type CardFact = { title: string; value: string };

/** One action a card offers. `url` is empty for an action that is not a link — a
 *  poll vote, a bot `Action.Submit` — which the UI must therefore NOT render as
 *  something clickable: acting on it would mean posting as the user. */
export type CardAction = { title: string; url: string };

/** An adaptive / connector card, already flattened by the backend (see
 *  src/teams_cards.rs) into the four presentation-free parts a chat bubble can
 *  show. `text` is never HTML, and one line is one visible block of the card; what
 *  it does carry is the card's own markdown — an Adaptive Card `TextBlock` is
 *  markdown by specification — parsed by `parseCardMarkdown` (lib/card-markdown.ts)
 *  so bold stays bold and a link shows its label instead of its URL. */
export type CardPayload = {
  title: string;
  text: string;
  facts: CardFact[];
  actions: CardAction[];
  /** Link-unfurl cards only (see `parse_link_unfurl_cards` in src/teams_unfurl.rs):
   *  the app that produced the preview — "GitHub Notifications", "Figma" — which
   *  Teams shows as a source chip above the card body. Absent on a card posted
   *  directly by a bot, whose title already names it. */
  app_name?: string;
  /** That app's icon, an ordinary public CDN URL (NOT hosted content, so it needs
   *  no media proxy). Empty/absent when the app reported none. */
  app_icon?: string;
};

/** A file/card attachment shared in a message (surfaced from Teams `properties`
 *  by the backend). `url` is an authenticated hosted-content URL — it must be
 *  loaded through the backend media proxy (see `TeamsController.loadMedia`),
 *  never fetched directly by the browser. */
export type AttachmentKind = "image" | "file" | "recording" | "card";
export type Attachment = {
  name: string;
  content_type: string;
  url: string;
  kind: AttachmentKind;
  /** Card only (`kind: "card"`): the decoded card the bubble renders. Absent on
   *  every other kind; a card entry without it has nothing to show. */
  card?: CardPayload;
  /** Meeting-recording only (`kind: "recording"`): a poster frame for the video,
   *  itself an authenticated hosted-content URL loaded through the media proxy.
   *  Empty/absent when Teams reported no thumbnail (the card shows a play glyph). */
  thumbnail_url?: string;
  /** Meeting-recording only: the recording's length in whole seconds (0 when
   *  unknown), rendered as a duration badge via {@link formatCallDuration}. */
  duration_seconds?: number;
};

/** One aggregated reaction (Teams "emotion") on a message, as the backend sends
 *  it (see `reactions_value` in src/bin/server.rs): the emotion `key` — mapped to
 *  an emoji by `reactionEmoji` in lib/notifications.ts — how many people reacted
 *  with it, and whether we are one of them (drives the highlighted chip + toggle). */
export type Reaction = {
  key: string;
  count: number;
  mine: boolean;
};

/** A call/meeting event, rendered as a centered line by `CallEventLine`. */
export type CallSystemEvent = {
  kind: "call";
  /** "ended" (a completed call), "missed", or "started". */
  event: "ended" | "missed" | "started";
  /** Call length in seconds (longest participant duration); 0 when unknown. */
  duration_seconds?: number;
  participant_count?: number;
  /** Display names of the participants, rendered as an overlapping avatar stack. */
  participants?: string[];
  /** Each participant's MRI, aligned index-for-index with {@link participants},
   *  used to load their real profile photo. An empty string (or missing entry)
   *  means no identity was reported, so that avatar falls back to a coin. Absent
   *  on system events stored before photos were wired in. */
  participant_mris?: string[];
  /** True for a meeting-thread call marker — a call that started inside a meeting
   *  chat (`19:meeting_…@thread.v2`). Rendered identically to any other `started`
   *  event, but the backend never rings for it (it carries no caller identity). */
  meeting?: boolean;
};

/** A Teams `ThreadActivity` frame — a membership or pin change in a chat/meeting
 *  thread (see `parse_thread_activity` in src/teams_read.rs) — rendered as a
 *  centered line by `ThreadActivityLine`.
 *
 *  `event` is left open-ended: the backend only emits the three below today, and an
 *  operation it learns to decode later must degrade to "render nothing" rather
 *  than to a broken line. */
export type ThreadActivityEvent = {
  kind: "thread_activity";
  event: "member_added" | "pinned" | "unpinned" | (string & {});
  /** When it happened (epoch ms). */
  time_ms?: number;
  /** Who did it (added the members, pinned the message); empty when unreported. */
  actor_mri?: string;
  /** The members the activity is about (empty for a pin/unpin). Display names, and
   *  Teams routinely sends them EMPTY — the MRI below is then the only identity, so
   *  the UI resolves the name from it (see `ThreadActivityLine`). */
  members?: string[];
  /** Those members' MRIs, aligned index-for-index with {@link members} exactly like
   *  the call event's `participant_mris`. */
  member_mris?: string[];
};

/** A scheduled-meeting activity — Teams' "Scheduled a meeting" / "The meeting … is
 *  cancelled" frames, keyed off `properties.meeting["@type"]` by the backend (see
 *  `parse_meeting_activity` in src/teams_read.rs) rather than off their localised
 *  body text — rendered as a centered line by `MeetingEventLine`.
 *
 *  `event` is left open-ended for the same reason as {@link ThreadActivityEvent}: an
 *  `@type` the backend learns later must degrade to "render nothing". */
export type MeetingSystemEvent = {
  kind: "meeting";
  event: "scheduled" | "cancelled" | "updated" | (string & {});
  /** The meeting's title; may be empty when Teams reported none. */
  title?: string;
  /** Start/end of the meeting (epoch ms), 0 or absent when unknown. */
  start_ms?: number;
  end_ms?: number;
  /** Where it happens, usually "Microsoft Teams Meeting"; empty when unreported. */
  location?: string;
  /** Who scheduled it, resolvable to a name; empty when unreported. */
  organizer_mri?: string;
  /** The meeting's join link. Opening it hands off to real Teams — teams-lite
   *  cannot join a meeting itself. */
  join_url?: string;
};

/** A structured system/activity event a message represents, rendered by the UI as
 *  a centered line instead of a chat bubble (see `system_event_value` in
 *  src/bin/server.rs and `SystemEventLine`).
 *
 *  The union stays OPEN — a bare `{ kind }` is a valid member — because the backend
 *  may start emitting a kind this client predates. Such an event must render
 *  nothing at all (never its raw payload), which is what the {@link isCallEvent} /
 *  {@link isThreadActivityEvent} / {@link isMeetingEvent} guards leave as the
 *  remaining case. */
export type SystemEvent =
  | CallSystemEvent
  | ThreadActivityEvent
  | MeetingSystemEvent
  | { kind: string };

/** Is this system event a call/meeting event? */
export function isCallEvent(event: SystemEvent): event is CallSystemEvent {
  return event.kind === "call";
}

/** Is this system event a thread activity (member added, message pinned)? */
export function isThreadActivityEvent(event: SystemEvent): event is ThreadActivityEvent {
  return event.kind === "thread_activity";
}

/** Is this system event a scheduled-meeting activity? */
export function isMeetingEvent(event: SystemEvent): event is MeetingSystemEvent {
  return event.kind === "meeting";
}

export type Conversation = {
  id: string;
  name: string;
  last_message_time: number;
  kind: ConversationKind;
  last_message_preview: string;
  /** Who wrote the preview. Already resolved through the user's own nickname for them
   *  when they set one — the backend does that on the way out of the store, so no
   *  caller has to (see `person_overrides` in src/store.rs). */
  last_message_sender: string;
  last_message_from_me: boolean;
  /** False when the chat has unread messages. Teams' own flag OR our local read
   *  position, so opening a chat clears the marker for good (see `mark_read`). */
  is_read: boolean;
  /** True when this chat is read HERE ONLY — the user read it in Ghost mode, so Teams
   *  still holds it unread and the sender was shown no read receipt. */
  is_ghost_read?: boolean;
  is_muted: boolean;
  is_pinned: boolean;
  is_hidden: boolean;
  thread_type: string;
  draft: string;
  /** For a 1:1 chat, the other party's MRI — used to fetch their real profile
   *  photo (see `TeamsController.loadAvatar`). Empty/absent for groups and for
   *  1:1s with no message from the other party yet; the UI falls back to initials. */
  avatar_mri?: string;
  /** For a group chat, the picture its members gave it — an absolute URL the
   *  backend's media proxy can fetch (see `TeamsController.loadAvatarPicture`).
   *  Empty/absent when the chat has none, which keeps its tinted initials. The
   *  group counterpart of `avatar_mri`: no single face, but a face of its own. */
  picture_url?: string;
};

/** One team channel, as returned by the `channels` method (mirrors the Rust
 *  `ChannelRow` serialization in src/bin/server.rs). A channel is a distinct
 *  Teams thread (`@thread.tacv2`) whose messages reuse the SAME pipeline as a
 *  chat — open/backfill/send/edit/react all key on the thread id — so only the
 *  sidebar grouping (under its team, on a separate tab) differs. `team_id` /
 *  `team_name` are denormalized onto every row so grouping needs no extra lookup. */
/** How much a channel may notify — the user's own per-channel notification setting
 *  in Microsoft Teams, mirroring `store::ChannelAlerts` on the backend. Four states,
 *  because the two ends mean opposite things: `muted` silences a channel that
 *  mentions the user, `all_new_posts` notifies about a post that mentions nobody.
 *  `mentions_only` is Teams' default. */
export type ChannelAlerts =
  | "muted"
  | "mentions_only"
  | "all_new_posts"
  | "all_new_posts_and_replies";

export type Channel = {
  id: string;
  team_id: string;
  team_name: string;
  /** The parent team's AAD group id (bare GUID), used to fetch the team's photo.
   *  Empty/absent when Teams did not report one; the UI keeps the tinted `#` glyph. */
  team_group_id?: string;
  name: string;
  /** The team's General channel; sorted first within its team. */
  is_general: boolean;
  /** Whether Microsoft Teams SHOWS this channel in the team list. Teams' own
   *  Show/Hide switch (CSA still spells it `isFavorite`), true on most channels and
   *  on every General — so it groups nothing: a shown channel renders inside its
   *  team, a hidden one under that team's "Hidden channels" entry. Absent from a
   *  backend older than the field, and the reader then assumes shown, because a
   *  channel wrongly hidden is a channel the user cannot reach. */
  is_shown?: boolean;
  /** Whether the user PINNED this channel in Microsoft Teams — the one flag that
   *  lifts a channel out of its team, into the sidebar's top Pinned section.
   *  Absent from an older backend; the reader then assumes unpinned. */
  is_pinned?: boolean;
  /** Whether the user has this channel's TEAM folded in their own Teams client. The
   *  backend denormalizes the team's `isCollapsed` onto each of its channels, so every
   *  channel of a team carries the same value. It decides how the team's section OPENS;
   *  a fold made here overrides it from then on, and is never written back to Teams.
   *  Absent from an older backend; the reader then opens the team. */
  team_collapsed?: boolean;
  /** The user's own per-channel notification setting in Microsoft Teams (see
   *  {@link ChannelAlerts}). Absent from a backend older than the field; the
   *  reader then assumes Teams' default. */
  alerts?: ChannelAlerts;
  last_message_time: number;
  last_message_preview: string;
  last_message_sender: string;
  last_message_from_me: boolean;
  is_read: boolean;
  /** Read HERE ONLY (Ghost mode) — see {@link Conversation.is_ghost_read}. */
  is_ghost_read?: boolean;
  draft: string;
};

/** A team with its channels, the unit the sidebar renders as a collapsible
 *  section (team header → channel rows). Produced by {@link groupChannelsByTeam}. */
export type TeamGroup = {
  team_id: string;
  team_name: string;
  /** The team's AAD group id (bare GUID), for its photo. Empty when unknown. */
  group_id: string;
  channels: Channel[];
  /** The team's channels that Teams hides (see {@link Channel.is_shown}). They render
   *  under their own "Hidden channels" entry at the foot of the team, as in Teams —
   *  reachable, and out of the way. Empty for a team that hides none. */
  hidden: Channel[];
  /** Whether the user has this team folded in their own Teams client (see
   *  {@link Channel.team_collapsed}). Decides how the section opens, until the user
   *  folds it here. */
  collapsed: boolean;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  seq: number;
  compose_time: number;
  sender: string;
  sender_mri?: string;
  /** Teams' own `messagetype`, verbatim ("Text", "RichText/Html",
   *  "RichText/Media_Card", "Event/Call", …). It decides how `content` must be READ:
   *  a `Text` body is plain text and must be escaped, not parsed as HTML (see
   *  {@link bodyFormat}). Empty or absent means UNKNOWN — a row stored before the
   *  backend persisted the type — and keeps the historical HTML behaviour. */
  message_type?: string;
  content: string;
  /** File/card attachments (absent or empty when the message has none). Inline
   *  images embedded in `content` as `<img>` are NOT here — they are extracted
   *  from the content HTML by `parseMessageContent`. */
  attachments?: Attachment[];
  /** Reactions on the message (absent or empty when none). Aggregated per emotion
   *  by the backend; the UI maps each `key` to an emoji and shows a chip. */
  reactions?: Reaction[];
  /** Who the body's @mention spans point at, keyed by the span's `itemid` (absent
   *  or empty when the message mentions nobody). Lets a mention show the mentioned
   *  person's card on hover — see {@link mentionsByItemId}. */
  mentions?: MessageMention[];
  /** When present, this message is a system/activity event (e.g. a call ended) and
   *  is rendered as a centered line, not a chat bubble; `content` is empty. */
  system_event?: SystemEvent;
  is_self?: boolean;
  /** Team-channel only: the id of the thread's ROOT message. All posts sharing a
   *  value belong to one thread. Empty for non-channel (chat) messages. */
  thread_root_id?: string;
  /** Team-channel only: the thread title (Teams `properties.subject`), present on
   *  the thread's ROOT post; empty on replies and on non-channel messages. */
  thread_subject?: string;
  /** True when the sender has DELETED this message on Teams. The bubble renders a
   *  "message deleted" placeholder instead of the body; when `content` is still
   *  non-empty (we had cached the message before it was deleted), the placeholder
   *  offers to reveal the original with an "invisible ink" unveil animation. */
  deleted?: boolean;
};

export type ReplyTo = {
  compose_time: number;
  sender: string;
  sender_mri: string;
  preview: string;
  before: string;
  after: string;
};

export type MessagePage = {
  messages: ChatMessage[];
  has_more: boolean;
};

export type UpdateInfo = {
  current: string;
  latest: string;
  url: string;
};

export type LiveStatus = "connecting" | "connected" | "disconnected";

/** Wire shape of the backend `broker_status` event (see `broker_status_payload` in
 *  src/bin/server.rs): the backend's own view of Microsoft's identity broker, which
 *  is what mints every token.
 *
 *  It exists because a broken broker is invisible otherwise. The socket stays up, the
 *  backend stays `active (running)`, and every read fails — so the app shows an empty
 *  sidebar and says nothing. The backend emits this on a CHANGE of state and in each
 *  client's greeting; a healthy backend that never failed emits nothing at all, so the
 *  absence of this event must always read as "fine". */
export type BrokerStatus = {
  ok: boolean;
  /** The classified failure: `disconnected`, `unresponsive`, `unreachable`,
   *  `refused`, `no_account`, `other`. Empty when `ok`. */
  signature: string;
  /** One English sentence, from the backend, safe to show as-is. */
  message: string;
  /** The full cause chain, for a bug report. Not shown by default. */
  detail: string;
  consecutive_failures: number;
  /** Whether the backend can restart the Intune container for this failure. False
   *  for every failure a container restart cannot fix, and on a read-only backend. */
  can_repair: boolean;
  /** True while a repair runs, so every open client disables its button. */
  repairing: boolean;
};

/** Is this broker state worth telling the user about? A missing state (an older
 *  backend, or the mock) and a healthy one are both silence.
 *
 *  Pure, and unit-tested, because it decides whether a banner covers part of the app. */
export function brokerNeedsAttention(status: BrokerStatus | null | undefined): boolean {
  return !!status && status.ok === false;
}

/** Wire shape of the backend `typing` event (see src/bin/server.rs). Ephemeral
 *  presence: `is_typing` is false when the sender stopped or just sent. `sender`
 *  is the display name the backend resolved from `sender_mri` (may be empty when
 *  unknown). */
export type TypingSignal = {
  conversation_id: string;
  sender_mri: string;
  sender: string;
  is_typing: boolean;
};

/** Someone currently typing in a conversation, keyed by MRI so repeats from the
 *  same person coalesce. */
export type TypingName = { mri: string; name: string };

/** Wire shape of the backend `call` event (see src/bin/server.rs). Incoming-call
 *  AWARENESS only: teams-lite has no media stack, so this can raise or dismiss a
 *  banner but never carries, answers, or places a call. `started` rings;
 *  `ended`/`missed` dismiss the banner. `caller` is the display name the backend
 *  resolved for whoever started/ended the call. */
export type CallSignal = {
  conversation_id: string;
  event: "started" | "ended" | "missed";
  caller: string;
  caller_mri: string;
  participants: string[];
  /** Participants' MRIs, aligned with `participants`, for their profile photos. */
  participant_mris?: string[];
  participant_count: number;
};

/** An active incoming-call banner — one per conversation currently ringing. The
 *  view model the store keeps in reactive state; derived from a `started`
 *  {@link CallSignal} and cleared by `ended`/`missed` (or a safety timeout). */
export type IncomingCall = {
  conversationId: string;
  caller: string;
  callerMri: string;
  participants: string[];
  /** Participants' MRIs, aligned with `participants`, for their profile photos. */
  participantMris: string[];
  participantCount: number;
};

/** Wire shape of the EXPERIMENTAL `call_signal` event (see src/bin/server.rs).
 *  A raw, still-being-reverse-engineered native-calling frame from the calling
 *  trouter workers, forwarded verbatim. Only emitted when the backend has calling
 *  enabled (TEAMS_LITE_CALLING=1). `body` is the fully-decoded envelope (with any
 *  nested payload expanded under `_decoded`); its schema is not yet pinned down,
 *  so this is surfaced for capture, not acted upon — no media is placed/answered. */
export type CallSignalFrame = {
  /** The calling worker URL the frame arrived on (…/NGCallManagerWin, …/SkypeSpacesWeb). */
  url: string;
  /** Best-effort call id, for correlating an invite with its later state frames. */
  call_id: string;
  /** The fully-decoded calling envelope. Shape is proprietary and still being learned. */
  body: unknown;
};

/** One member's read position in a conversation ("seen by"), as returned by the
 *  `read_receipts` method and pushed by the `read_receipt` event (see
 *  src/bin/server.rs). Our own position is never included — we only ever show
 *  who ELSE has read. `member` is the display name the backend resolved from
 *  `member_mri` (may be empty when unknown); `last_read_message_id` is the id of
 *  the last message this person has read, used to anchor their avatar. */
export type ReadReceipt = {
  member_mri: string;
  member: string;
  last_read_message_id: string;
  /** When they read it (epoch ms), or 0 when unknown. */
  read_time_ms: number;
};

/** Result of the `read_receipts` method: every OTHER member's read position. */
export type ReadReceiptsResult = { receipts: ReadReceipt[] };

/** Result of the `members` method: the people a message in this conversation can
 *  @mention, most relevant first (whoever wrote most recently, then the rest of the
 *  thread's roster). We are never in it — a mention of oneself notifies nobody — and
 *  neither is anybody the backend could not name. */
export type MembersResult = { members: { mri: string; name: string }[] };

/** One @mention in a message body (mirrors the Rust `parse_mentions` in
 *  src/teams_read.rs). A mention span in `content` carries only its `itemid`, so
 *  this list is what maps the rendered "@James" back to WHO was mentioned.
 *
 *  `kind` is Teams' own `mentionType`: only `"person"` names a human (a
 *  `"channel"`/`"team"`/`"tag"` mention's `mri` is a thread, not someone we can
 *  show a card for). Unknown kinds are passed through, never dropped. */
export type MessageMention = {
  itemid: number;
  mri: string;
  kind: "person" | "channel" | "team" | "tag" | (string & {});
  display_name: string;
};

/** A person's directory card, as the `profile` method returns it (mirrors the Rust
 *  `Profile` in src/teams_profiles.rs). Every field but `mri` may be empty — a
 *  guest or a service account has little in the directory — so the card renders
 *  only what is actually there. `found` is false when the directory knows nobody
 *  by this identity, and then no other field is meaningful. */
export type PersonProfile = {
  found: boolean;
  mri: string;
  object_id: string;
  display_name: string;
  given_name: string;
  surname: string;
  email: string;
  user_principal_name: string;
  job_title: string;
  department: string;
  company_name: string;
  /** The office/site the directory lists — Teams' "work location". */
  office_location: string;
  tenant_name: string;
  /** "Member" or "Guest" (empty when unreported). */
  user_type: string;
};

/** One person the directory knows by a mail address: their card, plus the address
 *  that asked for it — spelled exactly as the caller sent it, so a caller keyed on
 *  its own string finds the answer. */
export type AddressPerson = PersonProfile & { address: string };

/** Result of the `people_by_address` method: one entry per address the directory
 *  answered for. An address it knows nobody by (an external sender, a distribution
 *  list, a shared mailbox) is simply absent, and the UI keeps its tinted initials. */
export type AddressPeopleResult = { people: AddressPerson[] };

/**
 * The name and the face the USER gave somebody, as the `person_override` and
 * `person_overrides` methods return them.
 *
 * Microsoft Teams holds neither — a colleague's display name and photo are theirs to
 * set — so this is a local override stored on this machine only, and nothing ever
 * publishes it back. The two halves are independent: `display_name` is empty when only
 * the picture was replaced, and `has_avatar` is false when only the name was.
 *
 * `teams_name` is what Teams itself calls this person, never overridden, so a surface
 * that shows a nickname can always say who it belongs to. That is the point of
 * carrying it: a rename the user cannot see through would leave them unable to tell
 * who a message is from.
 */
export type PersonOverride = {
  mri: string;
  display_name: string;
  has_avatar: boolean;
  teams_name: string;
  /** When it was last changed (epoch ms). Absent on a single-person read. */
  updated_at?: number;
};

/** Whether a person carries any override at all. An entry with neither half set is
 *  never stored, so this is the one test a caller needs. */
export function hasPersonOverride(o: PersonOverride | null | undefined): boolean {
  return !!o && (o.display_name.trim().length > 0 || o.has_avatar);
}

/** One person's live presence, as the `presence` method returns it (mirrors the
 *  Rust `Presence` in src/teams_presence.rs).
 *
 *  `availability` is the coarse state the badge is coloured by; `activity` is the
 *  finer reason it is labelled with. Both are Teams' own strings rather than a
 *  closed union: Teams keeps adding activities, and an unknown one degrades to its
 *  availability colour instead of disappearing. See `presenceLabel` /
 *  `presenceTone` in lib/presence.ts. */
export type PersonPresence = {
  mri: string;
  availability: string;
  activity: string;
  /** When they were last active (epoch ms), or 0 when unreported. */
  last_active_ms: number;
  out_of_office: boolean;
  out_of_office_note: string;
  /** Their custom status message, empty when unset. */
  note: string;
};

/** Result of the `presence` method: one entry per person the service answered
 *  for (a person it knows nothing about is simply absent). */
export type PresenceResult = { presences: PersonPresence[] };

/** Wire shape of the `read_receipt` live event: one member's read position moved. */
export type ReadReceiptSignal = ReadReceipt & { conversation_id: string };


/** One activity-feed entry (from the Teams `48:notifications` thread), decoded
 *  by the backend from `properties.activity`. Mirrors the Rust `Notification`
 *  (src/teams_activity.rs). All phrasing/emoji mapping happens in the UI (see
 *  lib/notifications.ts) so this stays a faithful mirror of Teams' own fields. */
export type Notification = {
  id: string;
  /** Raw Teams activity type, e.g. "reactionInChat", "mention", "reply". */
  activity_type: string;
  /** Reaction flavor for reactions ("like", "heart", ...); "" otherwise. */
  activity_subtype: string;
  /** Who triggered it. */
  actor_name: string;
  actor_mri: string;
  /** The chat/channel it happened in, so the panel can open it. */
  source_thread_id: string;
  /** The targeted message's id in that thread (for chat reactions), so the UI
   *  can scroll to it; "" when the activity has no specific target. */
  source_message_id: string;
  /** The source conversation's title (e.g. "[Run] Engine merge requests"),
   *  shown as context in the Mentions/Following tabs; "" when Teams omitted it. */
  source_thread_topic: string;
  /** Short preview of the target message. */
  preview: string;
  /** Epoch ms. */
  timestamp: number;
  /** Actors aggregated into this entry (>= 1). */
  count: number;
  /** Teams' server-side read state. */
  is_read: boolean;
};

/** One activity stream plus its unread count. */
export type NotificationFeed = {
  unread: number;
  items: Notification[];
};

/** The three Teams activity streams the `notifications` method returns, one per
 *  tab in the notifications panel: Activity (`48:notifications`), Mentions
 *  (`48:mentions`), and Following (`48:threads`). */
export type NotificationFeeds = {
  activity: NotificationFeed;
  mentions: NotificationFeed;
  following: NotificationFeed;
};

/** The tab keys of the notifications panel, in display order. */
export const NOTIFICATION_TABS = ["activity", "mentions", "following"] as const;
export type NotificationTab = (typeof NOTIFICATION_TABS)[number];

/** Non-secret view of the app settings (mirrors the Rust `get_settings` /
 *  `set_settings` result in src/bin/server.rs). Every token is write-only from the
 *  UI's side: we only ever learn whether one is stored, never its value. */
export type AppSettings = {
  /** GitLab host used for link previews, e.g. "gitlab.com" or a self-hosted host. */
  gitlab_host: string;
  /** True when a GitLab access token is stored on the backend. */
  gitlab_token_set: boolean;
  /** True when a Linear API key is stored on the backend. Linear is SaaS-only, so
   *  it has no host to configure — only whether we hold a key. */
  linear_token_set: boolean;
  /** Ghost mode: read a conversation without telling Teams. Off by default — with it
   *  on, opening a chat clears the marker here only, so the sender is shown no read
   *  receipt and the chat stays unread in every other Teams client. */
  ghost_mode: boolean;
  /** Always available: keep the user's own Teams status green. Off by default — with
   *  it on, the backend registers this machine as an endpoint reporting Available and
   *  refreshes it, so every colleague sees the green dot until it is turned off. */
  always_available: boolean;
  /** Sender icons: show the mark of the organisation a mail came from, fetched from
   *  that organisation's own domain. ON by default, and the only setting here that is:
   *  it is the one place the app requests something from a server nobody configured, so
   *  it is a switch — the rails that make the request defensible live in
   *  `src/sender_icon.rs`. Off means no such request is ever made. */
  sender_icons: boolean;
};

/** A partial settings update. An omitted field is left unchanged, so one
 *  integration's form never clears the other's token; an explicit `""` clears the
 *  stored token it names. */
export type SettingsPatch = {
  gitlabHost?: string;
  gitlabToken?: string;
  linearToken?: string;
  /** Turn Ghost mode on or off (see {@link AppSettings.ghost_mode}). */
  ghostMode?: boolean;
  /** Turn sender icons on or off (see {@link AppSettings.sender_icons}). */
  senderIcons?: boolean;
};

/** Kind discriminant for an enriched GitLab link (mirrors the Rust `LinkMetadata`
 *  `kind` in src/gitlab.rs). */
export type GitLabLinkKind = "merge_request" | "issue" | "project";

/** Rich metadata for a GitLab link, returned by `enrich_link` (mirrors the Rust
 *  `LinkMetadata` in src/gitlab.rs). Optional fields are absent when GitLab did
 *  not provide them or they do not apply to the resource kind. */
export type GitLabLinkMetadata = {
  kind: GitLabLinkKind;
  /** Canonical web URL of the resource (what the card links to). */
  url: string;
  title: string;
  /** Full project path, e.g. "group/subgroup/project". */
  project_path: string;
  /** Short reference: "!42" (MR), "#7" (issue), or "" (project). */
  reference: string;
  state?: string;
  draft?: boolean;
  author_name?: string;
  source_branch?: string;
  target_branch?: string;
  labels?: string[];
  milestone?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  /** Current CI/CD pipeline status for a merge request (GitLab
   *  `head_pipeline.status`): "running" | "success" | "failed" | "pending" |
   *  "canceled" | "skipped" | "manual" | … Absent for issues/projects, or an MR
   *  with no pipeline. The card renders a live status badge from this. */
  pipeline_status?: string;
};

/** Kind discriminant for an enriched Linear link (mirrors the Rust `LinkMetadata`
 *  `kind` in src/linear.rs). */
export type LinearLinkKind = "issue" | "project" | "document";

/** One Linear label, with the colour Linear itself shows it in. */
export type LinearLabel = { name: string; color?: string };

/** Rich metadata for a Linear link, returned by `enrich_link` (mirrors the Rust
 *  `LinkMetadata` in src/linear.rs). Optional fields are absent when Linear did
 *  not provide them or they do not apply to the resource kind. */
export type LinearLinkMetadata = {
  kind: LinearLinkKind;
  /** Canonical web URL of the resource (what the card links to). */
  url: string;
  title: string;
  /** Human reference for an issue, e.g. "ENG-123"; "" for the other kinds. */
  identifier: string;
  /** Owning team name (an issue), or the joined names of a project's teams. */
  team?: string;
  /** Workflow state (issue) or status (project) name, as shown in Linear. */
  state?: string;
  /** The state's *category*, which is what the card colours and shapes its icon
   *  from: "backlog" | "unstarted" | "started" | "completed" | "canceled" |
   *  "triage", plus "planned" and "paused" for a project. Stable across
   *  workspaces, unlike `state`, which anyone can rename. */
  state_type?: string;
  /** The state's colour in Linear, as a CSS hex string ("#5e6ad2"). */
  state_color?: string;
  assignee_name?: string;
  /** Project lead. */
  lead_name?: string;
  /** Document author. */
  creator_name?: string;
  /** Linear's numeric priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority?: number;
  /** The priority's own label ("Urgent", "High", …). */
  priority_label?: string;
  /** The project an issue or document belongs to. */
  project?: string;
  /** Parent issue identifier, for a sub-issue. */
  parent?: string;
  labels?: LinearLabel[];
  description?: string;
  /** Issue due date, as Linear's plain "YYYY-MM-DD". */
  due_date?: string;
  /** Project target date, same format. */
  target_date?: string;
  /** Project completion, 0–1. The card draws a progress bar from it. */
  progress?: number;
};

/** Metadata for one enriched link, tagged with the integration it came from
 *  (mirrors the Rust `link_preview::Preview`).
 *
 *  The `provider` tag is what the union discriminates on, and it is load-bearing
 *  rather than cosmetic: both providers have an "issue" and a "project" kind, so
 *  `kind` alone is ambiguous and only the pair names a card. */
export type LinkMetadata =
  | ({ provider: "gitlab" } & GitLabLinkMetadata)
  | ({ provider: "linear" } & LinearLinkMetadata);

/** Result of an `enrich_link` request: the metadata, or `null` when no integration
 *  recognizes the link (or the resource is private/absent). */
export type LinkMetadataResult = { metadata: LinkMetadata | null };

// ---- message content parsing ------------------------------------------------

/** How a message body must be read: as the bounded Teams HTML subset, or verbatim
 *  as plain text (escaped, never parsed as markup). */
export type BodyFormat = "html" | "text";

/** The Teams `messagetype` whose body is PLAIN text. Compared case-insensitively:
 *  the wire says "Text", but the type is Teams' own string and we never want a
 *  casing change to silently turn a body back into HTML. */
const PLAIN_TEXT_MESSAGE_TYPE = "text";

/**
 * How the body of a message with this `messagetype` must be read.
 *
 * Only `Text` is plain: everything else Teams sends as a body is either HTML
 * (`RichText/*`) or has no body at all (`Event/*`), so it keeps the HTML path. An
 * empty/absent type is a legacy row whose type we never stored — "unknown", which
 * must keep behaving exactly as it did before the type rode the wire (HTML), since
 * guessing "text" would strip the formatting off years of stored messages.
 *
 * This matters because a plain body is NOT markup: parsed as HTML, `Vec<String>`
 * renders as `Vec`, and `pour moi c'est <yyyy>-<id>` as `pour moi c'est -`.
 */
export function bodyFormat(messageType: string | undefined): BodyFormat {
  return messageType?.trim().toLowerCase() === PLAIN_TEXT_MESSAGE_TYPE ? "text" : "html";
}

/** Which Teams blockquote a quote came out of: a reply to a message in the same
 *  conversation (`http://schema.skype.com/Reply`), or a message forwarded in from
 *  somewhere else (`http://schema.skype.com/Forward`). Teams attributes a reply
 *  but sends a forward with no author at all, so this is what lets the UI label a
 *  forwarded block explicitly instead of showing an unattributed quote. */
export type QuoteKind = "reply" | "forward";

/** Attribution of a quoted message, shared by the plain-text ({@link MessageQuote})
 *  and rich ({@link RichQuote}) quote shapes so both parsers agree on it.
 *
 *  Teams only fills these in for a `Reply` blockquote: a `Forward` blockquote
 *  carries the forwarded content and nothing else, so `sender`/`senderMri` are
 *  empty and `time` is absent for a forward — `kind` is the only attribution the
 *  payload provides. */
export type QuoteAttribution = {
  kind: QuoteKind;
  /** Display name of the quoted author, or "" when the payload carries none. */
  sender: string;
  /** The quoted author's MRI, when the quote carries one (it does for every reply
   *  Teams composes). Empty otherwise; the UI then shows the name without a card. */
  senderMri: string;
  /** Compose time of the quoted message, in milliseconds since the Unix epoch, as
   *  Teams reports it on a reply (`<span itemprop="time" itemid>`, else the
   *  blockquote's own `itemid`). Absent when the payload carries no time. */
  time?: number;
};

export type MessageQuote = QuoteAttribution & {
  text: string;
};

/** An image embedded inline in a message's HTML body (`<img>`), e.g. a pasted
 *  screenshot. `src` may be an authenticated hosted-content URL (loaded through
 *  the backend media proxy) or a public URL (loaded directly) — see
 *  `mediaNeedsProxy`. */
export type InlineImage = {
  src: string;
  alt: string;
};

export type ParsedMessage = {
  quote?: MessageQuote;
  body: string;
  beforeQuote?: string;
  afterQuote?: string;
  /** Inline images found in the (non-quoted) message body. Empty when none. */
  images: InlineImage[];
};

/** Decode the handful of HTML entities Teams emits. Shared by the tag stripper
 *  and the inline-image extractor (URLs arrive with `&amp;`). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Strip HTML tags and decode the handful of entities Teams emits. */
export function plain(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).trim();
}

/** Read a double- or single-quoted attribute value from a single HTML tag. */
function tagAttr(tag: string, name: string): string {
  const double = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  if (double) return double[1] ?? "";
  const single = tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return single?.[1] ?? "";
}

/** Extract inline `<img>` images from a message HTML fragment. Only `http(s)`
 *  sources are kept; the `src` is entity-decoded so it is a usable URL. */
export function extractImages(html: string): InlineImage[] {
  const out: InlineImage[] = [];
  const imgTag = /<img\b[^>]*>/gi;
  for (const match of html.matchAll(imgTag)) {
    const tag = match[0];
    const src = decodeEntities(tagAttr(tag, "src"));
    if (!/^https?:\/\//i.test(src)) continue;
    out.push({ src, alt: decodeEntities(tagAttr(tag, "alt")) });
  }
  return out;
}

/** Microsoft domains whose media is authenticated and must be fetched through the
 *  backend proxy: the skypetoken hosts (AMS / chatService) plus OneDrive/SharePoint
 *  (`*.sharepoint.com`), which modern Teams uses for files shared in a chat/channel
 *  and the backend fetches via Microsoft Graph. Mirrors the hosts handled in
 *  src/teams_media.rs. Everything else — public CDNs like giphy or the Teams
 *  static-asset CDN — is loaded directly by the browser, since it needs no
 *  credentials. */
const PROXY_MEDIA_DOMAINS = [
  "skype.com",
  "teams.microsoft.com",
  "teams.cloud.microsoft",
  "teams.office.com",
  "sharepoint.com",
];

/** Lowercased host of an `http(s)` URL, without any `userinfo@` or `:port`, or
 *  `null` when the string is not an http(s) URL. Kept dependency-free (no `URL`)
 *  so it is identical under SSR and node tests, mirroring the backend's host
 *  parsing in src/teams_media.rs / src/gitlab.rs. */
export function urlHost(url: string): string | null {
  const authority = url.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  if (!authority) return null;
  const host = (authority.split("@").pop() ?? "").split(":")[0]?.toLowerCase() ?? "";
  return host || null;
}

/** True when a media URL must be loaded through the backend proxy (its host is
 *  an authenticated Microsoft hosted-content domain). Public URLs return false
 *  and are loaded directly by an `<img>`. */
export function mediaNeedsProxy(url: string): boolean {
  const host = urlHost(url);
  if (!host) return false;
  return PROXY_MEDIA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The two Teams quote blockquotes, captured together so a reply and a forward are
 *  split out of the body the same way. The `itemtype` word is captured to tell them
 *  apart (see {@link QuoteKind}). */
const QUOTE_BLOCKQUOTE =
  /<blockquote\b[^>]*itemtype="http:\/\/schema\.skype\.com\/(Reply|Forward)"[^>]*>([\s\S]*?)<\/blockquote>/i;
const QUOTED_AUTHOR = /<strong\b[^>]*itemprop="mri"[^>]*>([\s\S]*?)<\/strong>/i;
/** The quoted author's MRI, which Teams puts in the same `<strong>`'s `itemid`
 *  (see `reply_quote` in src/teams_send.rs) — so a quoted name can offer that
 *  person's card too. */
const QUOTED_AUTHOR_MRI = /<strong\b[^>]*itemprop="mri"[^>]*itemid="([^"]*)"/i;
/** The OLDER author markup, on replies composed by earlier Teams clients:
 *  `<p><b><span itemprop="mri" itemid="8:orgid:…">Name</span>…</b></p>` instead of a
 *  `<strong itemprop="mri">`. Same microdata, different element — so it is read the
 *  same way rather than leaving the quote unattributed. Only consulted when the
 *  modern shape is absent, which keeps a modern reply's parse untouched. */
const QUOTED_AUTHOR_LEGACY = /<span\b[^>]*itemprop="mri"[^>]*>([\s\S]*?)<\/span>/i;
const QUOTED_AUTHOR_LEGACY_MRI = /<span\b[^>]*itemprop="mri"[^>]*itemid="([^"]*)"/i;
const QUOTED_PREVIEW = /<p\b[^>]*itemprop="preview"[^>]*>([\s\S]*?)<\/p>/i;
/** Compose time of the quoted message: Teams puts it in the `itemid` of an empty
 *  `<span itemprop="time">` inside a reply blockquote. */
const QUOTED_TIME = /<span\b[^>]*itemprop="time"[^>]*itemid="([^"]*)"/i;
/** A reply blockquote repeats the quoted message's id — which is its ms-epoch
 *  compose time — in its own `itemid`; used as a fallback for {@link QUOTED_TIME}. */
const QUOTE_BLOCKQUOTE_ITEMID = /<blockquote\b[^>]*\bitemid="([^"]*)"/i;

/** A quote blockquote located inside a message body: its attribution, the HTML of
 *  the quoted content, and where the whole blockquote sits in the message so the
 *  surrounding body can be sliced out around it. */
type QuoteMatch = {
  attribution: QuoteAttribution;
  /** HTML of the quoted content itself: the reply's `itemprop="preview"` (or the
   *  blockquote minus its author line), or the forward's whole blockquote body. */
  quoteHtml: string;
  /** Offset of the blockquote in the message HTML, and of the first character
   *  after it. */
  start: number;
  end: number;
};

/** Who a reply blockquote attributes its quote to: the display name, the MRI, and
 *  the exact author-line markup, so a quote with no `itemprop="preview"` wrapper can
 *  have that line removed from its body instead of showing it as quoted text.
 *
 *  Teams has composed this line in two shapes over the years (see
 *  {@link QUOTED_AUTHOR} and {@link QUOTED_AUTHOR_LEGACY}); the modern one is tried
 *  first, so a reply that carries it parses exactly as it always did. */
function quotedAuthor(inner: string): { sender: string; senderMri: string; authorHtml: string } {
  const modern = inner.match(QUOTED_AUTHOR);
  const line = modern ?? inner.match(QUOTED_AUTHOR_LEGACY);
  const mri = (modern ? inner.match(QUOTED_AUTHOR_MRI) : inner.match(QUOTED_AUTHOR_LEGACY_MRI))?.[1];
  return {
    sender: plain(line?.[1] ?? ""),
    senderMri: decodeEntities(mri ?? "").trim(),
    authorHtml: line?.[0] ?? "",
  };
}

/** Locate the reply/forward blockquote of a Teams message, or `null` when it has
 *  none. Pure string work, shared by {@link parseMessageContent} and
 *  {@link parseRichMessage} so the plain-text and rich paths never disagree on
 *  what the quote is. */
function matchQuote(html: string): QuoteMatch | null {
  const match = html.match(QUOTE_BLOCKQUOTE);
  const inner = match?.[2];
  if (!match || inner === undefined) return null;

  const kind: QuoteKind = match[1]?.toLowerCase() === "forward" ? "forward" : "reply";
  // A forward carries only the forwarded content: no author line and no preview
  // wrapper, so the whole blockquote body is the quote.
  const author = kind === "reply" ? quotedAuthor(inner) : null;
  const previewHtml = kind === "reply" ? inner.match(QUOTED_PREVIEW)?.[1] : undefined;
  const quoteHtml =
    author === null ? inner : (previewHtml ?? inner.replace(author.authorHtml, ""));
  const rawTime = inner.match(QUOTED_TIME)?.[1] ?? match[0].match(QUOTE_BLOCKQUOTE_ITEMID)?.[1];
  const time = Number(rawTime);

  const start = match.index ?? 0;
  return {
    attribution: {
      kind,
      sender: author?.sender ?? "",
      senderMri: author?.senderMri ?? "",
      ...(rawTime && Number.isFinite(time) && time > 0 ? { time } : {}),
    },
    quoteHtml,
    start,
    end: start + match[0].length,
  };
}

/** True when a quote blockquote holds something worth rendering: text, or an image
 *  (a forwarded screenshot is often the whole quoted message). An empty one is
 *  dropped rather than rendered as a blank recessed block. */
function quoteHasContent(quoteHtml: string): boolean {
  return plain(quoteHtml) !== "" || extractImages(quoteHtml).length > 0;
}

/** Split a raw Teams message HTML into an optional quote plus the body text. */
export function parseMessageContent(html: string): ParsedMessage {
  const match = matchQuote(html);
  if (!match) return { body: plain(html), images: extractImages(html) };

  const { attribution, quoteHtml, start, end } = match;
  const text = plain(quoteHtml);

  const beforeQuote = plain(html.slice(0, start));
  const afterQuote = plain(html.slice(end));
  const body = [beforeQuote, afterQuote].filter(Boolean).join("\n");
  // Inline images live in the body, never inside the quoted preview.
  const images = extractImages(html.slice(0, start) + html.slice(end));

  if (!attribution.sender && !quoteHasContent(quoteHtml)) return { body, images };
  return { quote: { ...attribution, text }, body, beforeQuote, afterQuote, images };
}

export type RichQuote = QuoteAttribution & {
  html: string;
};

export type ParsedRichMessage = {
  quote?: RichQuote;
  beforeHtml?: string;
  bodyHtml: string;
};

/**
 * Like {@link parseMessageContent}, but preserves the raw Teams HTML of each
 * part instead of flattening it to plain text, so the web UI can render inbound
 * formatting (bold, links, lists, code, mentions, images). The quoted block — a
 * reply or a forward — is still split out so it can be shown in its recessed
 * block, labelled from `quote.kind`.
 */
export function parseRichMessage(html: string): ParsedRichMessage {
  const match = matchQuote(html);
  if (!match) return { bodyHtml: html };

  const { attribution, quoteHtml, start, end } = match;
  const beforeHtml = html.slice(0, start);
  const afterHtml = html.slice(end);

  if (!attribution.sender && !quoteHasContent(quoteHtml)) {
    return { bodyHtml: [beforeHtml, afterHtml].filter((s) => plain(s)).join("") };
  }
  return {
    quote: { ...attribution, html: quoteHtml },
    beforeHtml,
    bodyHtml: afterHtml,
  };
}

/** Index a message's @mentions by the `itemid` its body spans carry, so rendering
 *  a mention can look up what it names in one step. Every kind is indexed — the map
 *  says what a span points at, and the renderer decides what to do with it: only a
 *  `person` is offered as a card, while a channel/team/tag mention stays inert. An
 *  entry with no MRI names nothing, so it is left out. Returns an empty map for a
 *  message that mentions nobody. */
export function mentionsByItemId(message: ChatMessage): Map<number, MessageMention> {
  const map = new Map<number, MessageMention>();
  for (const mention of message.mentions ?? []) {
    if (!mention.mri) continue;
    map.set(mention.itemid, mention);
  }
  return map;
}

/** The plain text a "Copy"/"Reply" action should use for a message. A `Text` body
 *  IS that text already — running it through the tag stripper would eat any angle
 *  brackets the author typed (`Vec<String>`), so it is used verbatim. */
export function copyableMessageText(message: ChatMessage): string {
  if (bodyFormat(message.message_type) === "text") return message.content;
  const parsed = parseMessageContent(message.content);
  return parsed.body || parsed.quote?.text || "";
}

/** Compact, human call duration: "45s", "10 min", "1 h 05 min". */
export function formatCallDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")} min`;
}

/** A one-line label for a call/meeting system event, Teams-style, e.g.
 *  "Call ended · 10 min". Duration is shown only for a completed call. The
 *  participants are rendered separately as an avatar stack by `CallEventLine`,
 *  so they are not part of this label. Pure and presentational. */
export function formatCallEvent(event: CallSystemEvent): string {
  const base =
    event.event === "missed"
      ? "Missed call"
      : event.event === "started"
        ? "Call started"
        : "Call ended";
  if (event.event === "ended" && event.duration_seconds && event.duration_seconds > 0) {
    return `${base} · ${formatCallDuration(event.duration_seconds)}`;
  }
  return base;
}

/** How many names a thread-activity line spells out before rolling the rest into
 *  "N others" — enough to be informative, short enough to stay one quiet line. */
const MAX_ACTIVITY_NAMES = 3;

/** "Alice", "Alice and Bob", "Alice, Bob and Carol", "Alice, Bob, Carol and 2
 *  others". `total` is how many people the activity is about, which can exceed the
 *  names we know (Teams often sends none), so the remainder is counted, not named. */
function listPeople(names: string[], total: number): string {
  const shown = names.slice(0, MAX_ACTIVITY_NAMES);
  const rest = Math.max(total - shown.length, 0);
  const parts = rest > 0 ? [...shown, rest === 1 ? "1 other" : `${rest} others`] : shown;
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * A one-line label for a thread-activity system event, Teams-style: "Nathan CAPIAUX
 * was added to the chat", "A message was pinned".
 *
 * `names` overrides the event's own `members`: Teams sends those empty far more
 * often than not, so the UI resolves them from the MRIs first (see
 * `ThreadActivityLine`) and passes the result here. Whatever is still unknown is
 * counted rather than named, so the line never reads as if fewer people were added.
 *
 * Returns `null` for an activity we have no words for — a kind of operation the
 * backend learns to decode later — so it renders nothing at all rather than a line
 * saying "unknown". Pure and presentational.
 */
export function formatThreadActivity(event: ThreadActivityEvent, names?: string[]): string | null {
  switch (event.event) {
    case "member_added": {
      const known = (names ?? event.members ?? []).map((n) => n.trim()).filter(Boolean);
      const total = Math.max(
        event.members?.length ?? 0,
        event.member_mris?.length ?? 0,
        known.length,
      );
      const who = known.length > 0 ? listPeople(known, total) : total === 1 ? "Someone" : `${total} people`;
      return `${who} ${total === 1 ? "was" : "were"} added to the chat`;
    }
    case "pinned":
      return "A message was pinned";
    case "unpinned":
      return "A message was unpinned";
    default:
      return null;
  }
}

/**
 * A one-line label for a scheduled-meeting event: "Meeting scheduled · Weekly sync",
 * "Meeting cancelled" when Teams reported no title.
 *
 * Returns `null` for an `@type` we have no words for, so an unrecognised meeting
 * activity renders nothing rather than a line saying "meeting something". The
 * schedule and the join link are rendered separately by `MeetingEventLine`, so they
 * are not part of this label. Pure and presentational.
 */
export function formatMeetingEvent(event: MeetingSystemEvent): string | null {
  const verb =
    event.event === "scheduled"
      ? "Meeting scheduled"
      : event.event === "cancelled"
        ? "Meeting cancelled"
        : event.event === "updated"
          ? "Meeting updated"
          : null;
  if (!verb) return null;
  const title = event.title?.trim();
  return title ? `${verb} · ${title}` : verb;
}

/**
 * The meeting's local date and time range, e.g. "Mon 4 May, 14:30 – 15:30", or just
 * the date when only a start is known. Returns "" when Teams reported no start time
 * (the line then carries its label alone).
 *
 * An end on a different day than the start is spelled out in full on both sides, so
 * an all-day or overnight meeting never reads as ending before it began. The
 * viewer's own locale and zone format it — the wire carries epoch ms.
 */
export function formatMeetingSchedule(event: MeetingSystemEvent): string {
  const start = event.start_ms && event.start_ms > 0 ? new Date(event.start_ms) : null;
  if (!start) return "";
  const end = event.end_ms && event.end_ms > 0 ? new Date(event.end_ms) : null;
  const day = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (!end) return `${day(start)}, ${time(start)}`;
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${day(start)}, ${time(start)} – ${time(end)}`
    : `${day(start)}, ${time(start)} – ${day(end)}, ${time(end)}`;
}

/** Headline for the incoming-call banner, e.g. "Incoming call · Riley" for a 1:1
 *  or "Incoming call · Design crew" for a group/channel. Pass the conversation's
 *  own name for a group or channel; omit it for a 1:1 (whose name is just the
 *  caller) so the caller's first name is used instead. Pure and presentational —
 *  the banner is awareness only; teams-lite cannot answer or place a call. */
export function incomingCallTitle(call: IncomingCall, conversationName?: string): string {
  const named = conversationName?.trim();
  const who = named && named.length > 0 ? named : firstName(call.caller) || "Someone";
  return `Incoming call · ${who}`;
}

export function replyToPayload(message: ChatMessage, before: string, after: string): ReplyTo {
  return {
    compose_time: message.compose_time,
    sender: message.sender,
    sender_mri: message.sender_mri ?? "",
    preview: copyableMessageText(message),
    before,
    after,
  };
}

// ---- history merge logic ----------------------------------------------------

export const HISTORY_PREFETCH_MESSAGES = 20;

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) => a.seq - b.seq || a.compose_time - b.compose_time || a.id.localeCompare(b.id),
  );
}

export function appendLiveMessage(
  current: MessagePage | undefined,
  message: ChatMessage,
): MessagePage {
  return {
    messages: mergeMessages(current?.messages ?? [], [message]),
    has_more: current?.has_more ?? true,
  };
}

export function mergeOlderHistoryPage(
  current: MessagePage | undefined,
  incoming: MessagePage,
): MessagePage {
  return {
    messages: mergeMessages(current?.messages ?? [], incoming.messages),
    has_more: incoming.has_more,
  };
}

/** How many of the newest messages a conversation keeps in the session cache once
 *  the user has moved on. Paging far back in a long thread can load thousands of
 *  messages; keeping every one of them for every conversation visited is what made
 *  a long session grow heavier and heavier. Re-opening still lands on plenty of
 *  history instantly, and scrolling up simply backfills again. */
export const RETAINED_MESSAGES = 400;

/**
 * Drop all but the newest `keep` messages of a cached page. `has_more` becomes
 * true whenever anything was dropped — older messages provably exist, so the pane
 * must offer to page back to them again. A page already within the budget is
 * returned unchanged (same reference), so trimming is free in the common case.
 */
export function trimHistoryPage(page: MessagePage, keep: number = RETAINED_MESSAGES): MessagePage {
  if (page.messages.length <= keep) return page;
  return { messages: page.messages.slice(-keep), has_more: true };
}

export function mergeRefreshedHistoryPage(
  current: MessagePage | undefined,
  incoming: MessagePage,
): MessagePage {
  const currentOldest = current?.messages[0];
  const incomingOldest = incoming.messages[0];
  const currentExtendsFurtherBack =
    currentOldest !== undefined &&
    (incomingOldest === undefined || currentOldest.seq < incomingOldest.seq);
  return {
    messages: mergeMessages(current?.messages ?? [], incoming.messages),
    has_more: currentExtendsFurtherBack ? current!.has_more : incoming.has_more,
  };
}

// ---- read receipts ("seen by") ---------------------------------------------

/** Compare two Teams message ids by read order. Ids are arrival timestamps in
 *  milliseconds, so a numeric compare orders them; a non-numeric id (rare) falls
 *  back to a lexicographic compare so the function is always total. */
function compareMessageIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Map each currently-displayed message to the members who have read up to it —
 * their "seen by" anchor. For every receipt, the anchor is the newest displayed
 * message whose id is `<=` the member's last-read id (they have read everything
 * up to and including it). A member who has read only messages older than the
 * loaded window has no visible anchor and is omitted, so their avatar never
 * floats above the history; it appears once they read into the loaded range.
 *
 * Each member appears at exactly one anchor (their latest read position). Within
 * an anchor, members are ordered most-recently-read first. Pure and dependency-
 * free so it is unit-testable and cheap to recompute as messages/receipts change.
 */
export function computeReadReceiptAnchors(
  messages: Pick<ChatMessage, "id">[],
  receipts: ReadReceipt[],
): Map<string, ReadReceipt[]> {
  const anchors = new Map<string, ReadReceipt[]>();
  if (messages.length === 0) return anchors;

  for (const receipt of receipts) {
    // Walk newest → oldest and take the first displayed message the member has
    // reached. `messages` is sorted oldest → newest, so scan from the end.
    let anchorId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const id = messages[i]!.id;
      if (compareMessageIds(id, receipt.last_read_message_id) <= 0) {
        anchorId = id;
        break;
      }
    }
    if (anchorId === null) continue; // read position is older than the window
    const bucket = anchors.get(anchorId);
    if (bucket) bucket.push(receipt);
    else anchors.set(anchorId, [receipt]);
  }

  for (const bucket of anchors.values()) {
    bucket.sort((a, b) => b.read_time_ms - a.read_time_ms);
  }
  return anchors;
}

// ---- conversation display helpers -------------------------------------------

export function convLabel(c: Conversation): string {
  if (c.name && c.name.length > 0) return c.name;
  if (c.kind === "notes") return "Notes";
  return "(untitled)";
}

/** True for a multi-party chat, which is every conversation but a 1:1 and Notes.
 *  `unknown` counts: the backend writes it for a thread it has synced an id for
 *  and nothing else, and every such row observed so far is a meeting thread. */
export function isGroupChat(c: Conversation): boolean {
  return c.kind === "group" || c.kind === "unknown";
}

/**
 * True when Microsoft Teams created this group thread FOR a meeting or a call,
 * rather than a person starting a chat by writing in it. The distinction is the
 * thread's origin and it never changes: a call placed inside an existing group
 * chat posts a call line into that chat and creates no thread of its own.
 *
 * Two independent signals, and either one alone is enough (they agree on all 494
 * multi-party threads of the tenant this was measured against):
 *  - the id, which Teams mints as `19:meeting_<base64 GUID>@thread.v2` for a
 *    meeting-backed thread and as `19:<32 hex digits>@thread.v2` for a chat;
 *  - `thread_type`, which is CSA's own `threadType` — `meeting` or `chat`.
 *
 * Both are read because each covers the other's gap: `thread_type` is empty on a
 * store row written before the column existed, and the id shape is Teams'
 * convention rather than a documented contract.
 */
export function isMeetingChat(c: Conversation): boolean {
  if (!isGroupChat(c)) return false;
  return c.thread_type === "meeting" || c.id.startsWith("19:meeting_");
}

function firstName(full: string): string {
  const head = full.trim().split(/\s+/)[0];
  return head || full;
}

/**
 * Sidebar preview line: "You:" when we sent it, "FirstName:" in a group, and the
 * bare snippet in a 1:1 / Notes where the sender is implicit.
 */
export function previewLine(c: Conversation): string {
  const body = c.last_message_preview ?? "";
  if (!body) return "";
  if (c.last_message_from_me) return `You: ${body}`;
  if (isGroupChat(c) && c.last_message_sender) {
    return `${firstName(c.last_message_sender)}: ${body}`;
  }
  return body;
}

// ---- chat placement: pin, mute, hide ----------------------------------------
//
// Microsoft Teams gives a chat three settings that decide WHERE it sits in the list
// and HOW LOUD it is: pinned to the top, muted, hidden away. The backend already
// mirrors all three from CSA (`is_pinned` from `isSticky`, `is_muted`, `is_hidden`),
// so a chat pinned, muted or hidden in Teams arrives that way here.
//
// A change made HERE is a LOCAL override that wins over the mirrored value from then
// on, and nothing writes it back: publishing a setting to the user's account is an
// outward action and would need its own consent gate, exactly like a send. The
// channel pin works the same way (see `channelIsPinned`), and this is the same rule
// applied to the three settings a chat has.

/**
 * The user's own local placement of the chat list, persisted client-side by the
 * store — the two settings this app cannot publish. A chat absent from a map sits
 * where Microsoft Teams put it.
 *
 * The MUTE is not here, and deliberately: it is published to Teams and read back from
 * it (`set_chat_muted`, over `src/teams_chat_settings.rs`), so the conversation's own
 * `is_muted` is the only truth about it. A local override beside it would be a second
 * answer to a question the account already answers.
 */
export type ChatPrefs = {
  /** Chat id → pinned here, overriding `is_pinned`. */
  pins: Record<string, boolean>;
  /**
   * Chat id → the hide watermark, in the same epoch milliseconds as
   * `last_message_time`: the chat stays hidden while its newest message is no newer
   * than the watermark, so a NEW message brings it back — which is what Teams' own
   * Hide does. `0` is an explicit "show it here".
   */
  hides: Record<string, number>;
};

/** No override at all: every chat sits where Microsoft Teams put it. */
export const NO_CHAT_PREFS: ChatPrefs = { pins: {}, hides: {} };

/** Whether this chat is pinned to the top of the list, honouring a local override. */
export function chatIsPinned(c: Conversation, prefs: ChatPrefs): boolean {
  const override = prefs.pins[c.id];
  return override === undefined ? c.is_pinned === true : override;
}

/**
 * Whether this chat is muted — in Microsoft Teams, which is the only place a mute
 * lives. The backend mirrors CSA's `isMuted`, publishes a change to the same property
 * Teams reads (`alerts`), and reports the new value back, so there is one answer on
 * every device rather than one per browser.
 *
 * A muted chat is dimmed, raises no unread marker, and chimes at nobody: this app's
 * own notification for a message in it is dropped (see {@link shouldNotify}).
 */
export function chatIsMuted(c: Conversation): boolean {
  return c.is_muted === true;
}

/**
 * Whether this chat is hidden — out of the list until it has something new to say.
 *
 * This reads the user's own hide HERE and nothing else. Teams' `hidden` flag is
 * deliberately not consulted: measured against the tenant it is true on all 95 of the
 * user's one-to-one chats — including the colleagues they message daily — and on 87 of
 * 499 group chats, so it cannot mean "the user put this away" (see
 * `examples/chat_settings_recon.rs`). Bucketing on it emptied Recent of every direct
 * message.
 */
export function chatIsHidden(c: Conversation, prefs: ChatPrefs): boolean {
  const watermark = prefs.hides[c.id];
  if (watermark === undefined || watermark <= 0) return false;
  return c.last_message_time <= watermark;
}

/** The three groups the chat list renders, in the order they appear. */
export type ChatSectionId = "pinned" | "recent" | "hidden";

/** One group of the chat list: the chats in it, newest first. */
export type ChatSection = {
  id: ChatSectionId;
  label: string;
  chats: Conversation[];
};

/** One rendered line of the chat list — a section header or a chat row. Flat,
 *  because the list is virtualized: a header is a row like any other. */
export type ChatRow =
  | { kind: "header"; section: ChatSection }
  /** `index` is the row's place among the chats currently ON SCREEN, which is what
   *  the keyboard selection counts — a chat inside a folded section has none. */
  | { kind: "chat"; chat: Conversation; sectionId: ChatSectionId; index: number };

/** Every section header carries the state of what it hides while folded, so folding
 *  a group never looks like losing it. */
export function chatSectionCollapsedHint(
  section: ChatSection,
  openId: string | null,
): { hidesUnread: boolean; hidesOpen: boolean } {
  return {
    // A muted chat is not something a folded section should shout about, exactly as
    // it raises no unread marker of its own.
    hidesUnread: section.chats.some((c) => !c.is_read && !chatIsMuted(c)),
    hidesOpen: section.chats.some((c) => c.id === openId),
  };
}

/**
 * Split the chat list into its sections, mirroring Microsoft Teams: the pinned chats
 * on top, then the recent ones, then the chats that are put away.
 *
 * Only a non-empty section is returned, so a list with nothing pinned and nothing
 * hidden is one plain group — the shape this sidebar always had.
 *
 * Each section is sorted newest-first rather than kept in the incoming order: the
 * backend sorts pinned chats to the head of the flat list, and a chat unpinned HERE
 * would otherwise sit at the top of Recent with a two-week-old message. Pure, so the
 * sidebar and the keyboard agree on the order by construction.
 */
export function organizeChats(conversations: Conversation[], prefs: ChatPrefs): ChatSection[] {
  const pinned: Conversation[] = [];
  const recent: Conversation[] = [];
  const hidden: Conversation[] = [];
  for (const c of conversations) {
    if (chatIsHidden(c, prefs)) hidden.push(c);
    else if (chatIsPinned(c, prefs)) pinned.push(c);
    else recent.push(c);
  }
  const newestFirst = (a: Conversation, b: Conversation) =>
    b.last_message_time - a.last_message_time || a.id.localeCompare(b.id);
  const sections: ChatSection[] = [
    { id: "pinned", label: "Pinned", chats: pinned.sort(newestFirst) },
    { id: "recent", label: "Recent", chats: recent.sort(newestFirst) },
    { id: "hidden", label: `Hidden chats (${hidden.length})`, chats: hidden.sort(newestFirst) },
  ];
  return sections.filter((s) => s.chats.length > 0);
}

/**
 * Flatten the sections into the rows the virtualizer renders.
 *
 * A header only appears when there is more than one section to tell apart: a single
 * group needs no name, and Teams shows none either. A folded section contributes its
 * header alone, so its chats are out of the keyboard's reach as well as out of sight.
 */
export function chatRows(
  sections: ChatSection[],
  collapsed: Record<ChatSectionId, boolean>,
): ChatRow[] {
  const rows: ChatRow[] = [];
  let index = 0;
  for (const section of sections) {
    if (sections.length > 1) rows.push({ kind: "header", section });
    if (sections.length > 1 && collapsed[section.id]) continue;
    for (const chat of section.chats) {
      rows.push({ kind: "chat", chat, sectionId: section.id, index });
      index += 1;
    }
  }
  return rows;
}

// ---- channel display helpers -----------------------------------------------

/** The channel's display name, with a safe fallback for an unnamed channel. */
export function channelLabel(c: Channel): string {
  return c.name && c.name.length > 0 ? c.name : "(unnamed channel)";
}

/**
 * Sidebar preview line for a channel. A channel is always multi-party, so we
 * show the sender's first name ("Alice: ...") — or "You: ..." when we posted it.
 * Empty when the channel has no displayable last message.
 */
export function channelPreviewLine(c: Channel): string {
  const body = c.last_message_preview ?? "";
  if (!body) return "";
  if (c.last_message_from_me) return `You: ${body}`;
  if (c.last_message_sender) return `${firstName(c.last_message_sender)}: ${body}`;
  return body;
}

/**
 * Group a flat channel list into teams for the sidebar tree, preserving the
 * order the backend already sorted the flat list into (team, then General-first,
 * then channel name). Teams appear in first-seen order and each team keeps its
 * channels in their incoming order, so the result renders identically whether or
 * not the caller re-sorts.
 */
export function groupChannelsByTeam(channels: Channel[]): TeamGroup[] {
  const groups: TeamGroup[] = [];
  const byTeam = new Map<string, TeamGroup>();
  for (const c of channels) {
    let group = byTeam.get(c.team_id);
    if (!group) {
      group = {
        team_id: c.team_id,
        team_name: c.team_name,
        group_id: c.team_group_id ?? "",
        channels: [],
        hidden: [],
        collapsed: c.team_collapsed === true,
      };
      byTeam.set(c.team_id, group);
      groups.push(group);
    }
    // A later row may carry the group id when the first (e.g. General) lacked it.
    if (!group.group_id && c.team_group_id) group.group_id = c.team_group_id;
    // Every channel of a team reports the same fold state, so any of them may set it —
    // but one that says "folded" is the one to believe: a row from a backend older than
    // the field carries nothing at all, and must not unfold what Teams folded.
    if (c.team_collapsed === true) group.collapsed = true;
    if (channelIsShown(c)) group.channels.push(c);
    else group.hidden.push(c);
  }
  return groups;
}

/**
 * Whether Microsoft Teams shows this channel in its team, as opposed to hiding it.
 *
 * There is no local override, and deliberately so: Show/Hide belongs to the user's
 * Teams account, and hiding a channel here that their phone still lists would make
 * the two disagree about what they are a member of. The pin (see
 * {@link channelIsPinned}) is the one placement the user changes locally.
 */
export function channelIsShown(c: Channel): boolean {
  return c.is_shown !== false;
}

/**
 * Whether a channel is pinned to the top of the sidebar, honouring a local
 * override. The backend seeds `is_pinned` from Teams' own channel pin; the user can
 * then toggle it here (persisted client-side), and that override wins. Absent an
 * override we fall back to Teams' value, so a channel pinned in real Teams is
 * pinned here out of the box.
 */
export function channelIsPinned(c: Channel, overrides: Record<string, boolean>): boolean {
  const override = overrides[c.id];
  return override === undefined ? c.is_pinned === true : override;
}

/**
 * Whether the user muted this channel in Microsoft Teams — directly, or by muting
 * the whole team, which the backend folds into the same setting.
 *
 * A muted channel is dimmed and never marked unread, exactly like a muted chat.
 * There is no local override (unlike the pin): mute belongs to the user's Teams
 * account, and a local "unmute" would claim a channel is loud when their phone
 * stays silent.
 */
export function channelIsMuted(c: Channel): boolean {
  return c.alerts === "muted";
}

/** The sidebar's channel sections: the pinned channels on top, then the team →
 *  channel tree. Mirrors Microsoft Teams, whose channel list has exactly one
 *  top-level group — Pinned — and keeps every other channel inside its team. */
export type ChannelSections = {
  pinned: Channel[];
  teams: TeamGroup[];
};

/**
 * Split the (backend-ordered) channel list into the pinned section and the team tree.
 * A pinned channel is lifted out of its team into a single flat list, preserving the
 * incoming order (the order CSA reported, General first); everything else keeps its
 * team grouping via {@link groupChannelsByTeam}, which also splits each team's
 * hidden channels out. Pure, so the sidebar re-renders deterministically.
 */
export function organizeChannels(
  channels: Channel[],
  pins: Record<string, boolean>,
): ChannelSections {
  const pinned: Channel[] = [];
  const rest: Channel[] = [];
  for (const c of channels) {
    if (channelIsPinned(c, pins)) pinned.push(c);
    else rest.push(c);
  }
  return { pinned, teams: groupChannelsByTeam(rest) };
}

/**
 * Should an incoming message raise a notification? Pure, so it is testable.
 *
 * `muted` is the thread's own quiet setting — a chat muted in Teams or here (see
 * {@link chatIsMuted}), a channel the user muted in Teams ({@link channelIsMuted}).
 * A mute that dimmed the row and still chimed would not be a mute.
 */
export function shouldNotify(
  msg: { conversation_id: string; is_self?: boolean },
  openConversationId: string | null,
  muted = false,
): boolean {
  if (msg.is_self) return false;
  if (muted) return false;
  if (openConversationId !== null && msg.conversation_id === openConversationId) return false;
  return true;
}

/**
 * Human label for the people currently typing, e.g. "Clément is typing",
 * "Clément and Théo are typing", or "Clément, Théo and 2 more are typing".
 * First names keep the hint compact; an unknown name falls back to "Someone".
 * Returns "" when nobody is typing (the indicator then renders nothing).
 */
export function typingLabel(names: string[]): string {
  const unique = [...new Set(names.map((n) => firstName(n) || "Someone"))];
  const [a, b] = unique;
  switch (unique.length) {
    case 0:
      return "";
    case 1:
      return `${a} is typing`;
    case 2:
      return `${a} and ${b} are typing`;
    default:
      return `${a}, ${b} and ${unique.length - 2} more are typing`;
  }
}

// ---- mail (read-only Outlook surface) --------------------------------------
//
// Mirrors the Rust backend's `mail_*` methods (see src/mail.rs and the mail
// serializers in src/bin/server.rs). The mail surface is strictly read-only: there
// is no send/reply/delete/move here, and none exists in the backend either.
//
// Ordering note: mail is keyed by `received`, an ISO 8601 UTC timestamp truncated
// to whole seconds by the backend. Fixed-width UTC text compares chronologically,
// so every sort and page boundary below uses plain string comparison — the same key
// SQLite and Graph order on, which is what keeps the three views consistent.

/** One address on a mail. `name` is often empty (a machine sender); `address` is
 *  the reliable identity. */
export type MailAddress = {
  name: string;
  address: string;
};

/** A mail folder in the sidebar. `well_known` is a stable English label ("Inbox",
 *  "Sent", …) for the folders Graph exposes under a fixed alias, and is empty for a
 *  user-created folder — whose `display_name` is then the only name it has, in
 *  whatever language the mailbox uses. */
export type MailFolder = {
  id: string;
  display_name: string;
  well_known: string;
  total_count: number;
  unread_count: number;
  position: number;
};

/** One attachment on a mail. `is_inline` ones are embedded in the body by the
 *  backend and are not listed as files (see {@link mailFileAttachments}). */
export type MailAttachment = {
  id: string;
  name: string;
  content_type: string;
  size: number;
  is_inline: boolean;
};

/** A mail as the list shows it — no body (bodies are fetched per mail and can be
 *  ~135 KB each). */
export type MailHeader = {
  id: string;
  folder_id: string;
  conversation_id: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** ISO 8601 UTC, whole seconds. The ordering and paging key. */
  received: string;
  /** Read in the mailbox, OR read here (the backend sends one effective flag —
   *  see `MailMessageRow::is_read` in src/store.rs). Opening a mail clears the
   *  marker in this app only: the mailbox is read-only, so Outlook keeps the mail
   *  unread and its sender is told nothing. */
  is_read: boolean;
  has_attachments: boolean;
  importance: string;
  preview: string;
};

/** A page of a folder's mail, newest first. */
export type MailPage = {
  messages: MailHeader[];
  has_more: boolean;
};

/** A rendered mail body, as the backend sanitized it.
 *
 *  `html` is inert and self-contained: no scripts, no styles, no frames, and no
 *  remote references at all — inline images are already embedded as `data:` URIs.
 *  `blocked_remote_images` says how many remote references were dropped, so the UI
 *  can explain a mail it is not showing in full. Displaying a body makes NO network
 *  request, which is also why its sender cannot tell it was read. */
export type MailBody = {
  html: string;
  blocked_remote_images: number;
  truncated: boolean;
  attachments: MailAttachment[];
  /** The mail's own header, sent alongside the body so opening `/m/<id>` cold — a
   *  deep link, a reload, a restored tab — renders the subject and sender without a
   *  second round-trip. Null only when the backend could not key the message. A
   *  client that already has the header from its list ignores this. */
  header?: MailHeader | null;
};

/** The folder's display label: the stable English name for a well-known folder,
 *  else the mailbox's own (localized) name, else a neutral fallback. */
export function mailFolderLabel(folder: MailFolder): string {
  return folder.well_known || folder.display_name || "(folder)";
}

/** How one address on a mail reads: the display name when it carries one, else the
 *  bare address, else nothing (an empty entry names nobody). */
export function mailAddressLabel(address: MailAddress): string {
  return address.name || address.address || "";
}

/** A picture an avatar has loaded, and WHAT it is — the component decides how to draw
 *  it. What the controller answers for a mail address, since an address resolves to one
 *  of two different things:
 *   - "face" — a person's profile photo, drawn in a circle;
 *   - "mark" — an ORGANISATION's own icon, drawn edge to edge on a rounded square, so
 *     the shape says a machine wrote this and the mark is the mark itself: no tile
 *     behind it, no margin around it. */
export type AvatarPicture = { url: string; kind: "face" | "mark" };

/** Everything after the "@", lowercased — the organisation an address belongs to.
 *  Empty when the string is not an address. */
export function mailDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

/** The second-level labels that belong to a public suffix rather than to a name, so
 *  "example.co.uk" keeps both. A short list on purpose: a real public-suffix list is a
 *  megabyte of data to pick a colour and two letters with. */
const SUFFIX_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

/** The registrable part of a mail domain — its name plus the public suffix:
 *  "md.getsentry.com" → "getsentry.com", "updates.tracker.dev" → "tracker.dev". What
 *  sits in front of it is routing ("mail.", "notifications."), so this is what names the
 *  organisation and what two subdomains of one sender share.
 *
 *  Mirrors `sender_icon::registrable_domain` in the backend, which re-derives it before
 *  any request: this copy decides what the UI groups by, that one decides what is
 *  actually fetched, and the backend's answer is the authoritative one. */
export function registrableMailDomain(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  let index = labels.length - 2;
  if (SUFFIX_LABELS.has(labels[index]!)) index -= 1;
  return labels.slice(index).join(".");
}

/** The label inside a mail domain a reader recognises: "md.getsentry.com" →
 *  "getsentry", "linear.app" → "linear". */
export function mailDomainName(domain: string): string {
  return registrableMailDomain(domain).split(".")[0] ?? "";
}

/** True when an address spells a PERSON's name: its local part is exactly two
 *  dot-separated words of letters, which is what a corporate mailbox looks like
 *  ("reva.singh@partner.example.org"). Everything else — "no-reply", "security",
 *  "notifications", "adq_lab_eng" — names a function or a machine.
 *
 *  ONE predicate for two decisions, and that is the point: it picks the initials a
 *  nameless address shows (the person, not their organisation), and it decides whether
 *  an organisation's mark may be drawn at all. A company logo on a human's message
 *  misattributes it, and asking that company's server about a person we are not going to
 *  draw would be a request for nothing. */
export function mailAddressSpellsAPerson(address: string): boolean {
  const at = address.lastIndexOf("@");
  const local = at > 0 ? address.slice(0, at) : "";
  const words = local.split(".");
  return words.length === 2 && words.every((word) => word.length >= 2 && /^[a-z]+$/i.test(word));
}

/** Who a mail is from, for the list and the reading pane: the display name when
 *  the sender has one, else the bare address. */
export function mailSenderLabel(mail: Pick<MailHeader, "from">): string {
  return mailAddressLabel(mail.from) || "(unknown sender)";
}

/** A mail's subject, with the placeholder every mail client shows for an empty one. */
export function mailSubjectLabel(mail: Pick<MailHeader, "subject">): string {
  return mail.subject || "(no subject)";
}

/** `received` as epoch milliseconds, for date formatting. 0 when unparseable, which
 *  the formatters render as no date rather than "Invalid Date". */
export function mailReceivedMs(mail: Pick<MailHeader, "received">): number {
  const ms = Date.parse(mail.received);
  return Number.isFinite(ms) ? ms : 0;
}

/** A compact recipient line ("Alice, Bob and 2 others"). Names are preferred over
 *  addresses; an empty list yields "". */
export function mailRecipientsLabel(addresses: MailAddress[], max = 2): string {
  const labels = addresses.map((a) => a.name || a.address).filter((l) => l.length > 0);
  if (labels.length === 0) return "";
  if (labels.length <= max) return labels.join(", ");
  const shown = labels.slice(0, max).join(", ");
  const rest = labels.length - max;
  return `${shown} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** The attachments worth showing as files: the inline ones are already rendered
 *  inside the body, so listing them again would duplicate the mail's own images. */
export function mailFileAttachments(attachments: MailAttachment[]): MailAttachment[] {
  return attachments.filter((a) => !a.is_inline);
}

/** Human-readable size for an attachment chip. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** Unread count for the sidebar's Mail badge: the inbox's, since that is the only
 *  folder whose unread state a user acts on (Junk and Deleted are noise — this
 *  mailbox has 1558 unread in Deleted alone). Falls back to the first folder when
 *  no inbox is present. */
export function mailUnreadBadge(folders: MailFolder[]): number {
  const inbox = folders.find((f) => f.well_known === "Inbox") ?? folders[0];
  return inbox?.unread_count ?? 0;
}

/** Sort mail newest first, with the id as a deterministic tie-breaker so two mails
 *  received in the same second never swap places between renders. */
function compareMailDesc(a: MailHeader, b: MailHeader): number {
  if (a.received !== b.received) return a.received < b.received ? 1 : -1;
  return a.id.localeCompare(b.id);
}

/** Merge mail lists by id (newest first). Later entries win, so a refreshed header
 *  (one that has since been read elsewhere) replaces the stale copy. */
export function mergeMail(current: MailHeader[], incoming: MailHeader[]): MailHeader[] {
  const byId = new Map(current.map((mail) => [mail.id, mail]));
  for (const mail of incoming) byId.set(mail.id, mail);
  return [...byId.values()].sort(compareMailDesc);
}

/**
 * Fold a freshly-fetched newest page into what we already hold.
 *
 * The backend re-reads only the newest window, so a merge must not truncate a list
 * the user has scrolled far back through: everything older than the incoming page
 * is kept, and `has_more` stays whatever the deeper local list said. Mail the server
 * no longer lists WITHIN the incoming window is dropped, which is how a mail deleted
 * in real Outlook disappears here too.
 */
export function mergeRefreshedMailPage(current: MailPage | undefined, incoming: MailPage): MailPage {
  const held = current?.messages ?? [];
  if (incoming.messages.length === 0) {
    return { messages: held, has_more: held.length > 0 ? (current?.has_more ?? false) : incoming.has_more };
  }
  // The window the server just described, and therefore the range it is
  // authoritative over: everything at or after its oldest entry.
  const windowOldest = incoming.messages[incoming.messages.length - 1]!.received;
  const olderThanWindow = held.filter((mail) => mail.received < windowOldest);
  const extendsFurtherBack = olderThanWindow.length > 0;
  return {
    messages: mergeMail(olderThanWindow, incoming.messages),
    has_more: extendsFurtherBack ? (current?.has_more ?? incoming.has_more) : incoming.has_more,
  };
}

/** Fold a page of OLDER mail (a scroll-up) into what we hold. */
export function mergeOlderMailPage(current: MailPage | undefined, incoming: MailPage): MailPage {
  return {
    messages: mergeMail(current?.messages ?? [], incoming.messages),
    has_more: incoming.has_more,
  };
}

// ---- calendar (read-only Teams/Outlook surface) -----------------------------
//
// Mirrors the Rust backend's `calendars` / `calendar_view` methods (see
// src/calendar.rs and the calendar serializers in src/bin/server.rs). Strictly
// read-only: there is no create, move, cancel, accept, decline or forward here, and
// none exists in the backend either. An event's `join_url` and `web_link` are links
// the USER clicks; nothing in this app ever joins or answers anything.
//
// Ordering note: `start` and `end` are ISO 8601 UTC timestamps truncated to whole
// seconds by the backend, so string comparison is chronological comparison. `end` is
// EXCLUSIVE (Graph's own convention) — for an all-day event it is midnight after the
// last day.

/** One of the mailbox's calendars, as the sidebar lists them. */
export type CalendarInfo = {
  id: string;
  name: string;
  /** Outlook's own colour as `#rrggbb`, or empty when the calendar uses the
   *  automatic colour — the UI then falls back to its own palette (see
   *  {@link calendarColor}). */
  hex_color: string;
  /** The primary calendar: where Teams meetings land, and the one shown by default. */
  is_default: boolean;
  /** What Outlook itself would allow. Shown for honesty only — this app never
   *  writes to a calendar, whatever the flag says. */
  can_edit: boolean;
  position: number;
};

/** A person on an event: its organizer, or one attendee. */
export type EventPerson = {
  name: string;
  address: string;
  /** `accepted` | `declined` | `tentativelyAccepted` | `notResponded` | `none`.
   *  Empty for an organizer. */
  response: string;
  /** `required` | `optional` | `resource`. Empty for an organizer. */
  kind: string;
};

/** One occurrence on the calendar. A recurring meeting arrives as one of these per
 *  occurrence — the backend asks Graph for a view, which expands recurrence
 *  server-side. */
export type CalendarEvent = {
  id: string;
  calendar_id: string;
  subject: string;
  /** Graph's own plain-text first lines of the invitation body. */
  preview: string;
  /** ISO 8601 UTC, whole seconds. */
  start: string;
  /** ISO 8601 UTC, whole seconds, EXCLUSIVE. */
  end: string;
  is_all_day: boolean;
  is_cancelled: boolean;
  is_organizer: boolean;
  organizer: EventPerson;
  location: string;
  /** The Teams join link, when this is an online meeting. */
  join_url: string;
  /** Outlook-on-the-web deep link, for "Open in Outlook". */
  web_link: string;
  /** `free` | `tentative` | `busy` | `oof` | `workingElsewhere` | `unknown`. */
  show_as: string;
  /** The user's own answer, or `organizer` when they own the event. */
  response: string;
  /** `singleInstance` | `occurrence` | `exception` | `seriesMaster`. */
  series: string;
  /** The series' pattern (`daily`, `weekly`, …) when the backend saw one. An
   *  occurrence carries none of its own — `series` is what says it repeats. */
  recurrence: string;
  importance: string;
  sensitivity: string;
  categories: string[];
  /** Up to a capped number of attendees; {@link CalendarEvent.attendee_count} is
   *  the true total (one real invitation in this tenant has 777). */
  attendees: EventPerson[];
  attendee_count: number;
  has_attachments: boolean;
  /** Minutes before the start, or -1 when the event records no reminder. */
  reminder_minutes: number;
};

/** A window of events, plus the window itself so a client can tell a late-arriving
 *  update for a month it has navigated away from apart from one for what it shows. */
export type CalendarViewResult = {
  start: string;
  end: string;
  events: CalendarEvent[];
};

/** Fallback colours for calendars Outlook reports on the automatic colour, keyed by
 *  position so a calendar keeps the same colour for the whole session. Picked to
 *  stay legible as a 3px bar and as a filled chip in both themes. */
const CALENDAR_PALETTE = [
  "#6875e6", // indigo — the app's own accent, for the primary calendar
  "#0ea5e9",
  "#16a34a",
  "#f97316",
  "#a855f7",
  "#ef4444",
  "#0d9488",
  "#d946ef",
] as const;

/** A calendar's display colour: Outlook's own when it has one, else a stable
 *  palette entry. */
export function calendarColor(calendar: Pick<CalendarInfo, "hex_color" | "position">): string {
  if (/^#[0-9a-fA-F]{6}$/.test(calendar.hex_color)) return calendar.hex_color;
  const index = Math.abs(Math.trunc(calendar.position)) % CALENDAR_PALETTE.length;
  return CALENDAR_PALETTE[index]!;
}

/** A calendar's name, with a fallback for one that reports none. */
export function calendarLabel(calendar: Pick<CalendarInfo, "name">): string {
  return calendar.name || "(calendar)";
}

/** An event's title, with the placeholder every calendar shows for an empty one. */
export function eventTitle(event: Pick<CalendarEvent, "subject">): string {
  return event.subject || "(no title)";
}

/** Whether an event repeats — true for any row that belongs to a series. */
export function eventRepeats(event: Pick<CalendarEvent, "series">): boolean {
  return event.series !== "" && event.series !== "singleInstance";
}

/** The organizer's display label, preferring the name over the bare address. */
export function personLabel(person: Pick<EventPerson, "name" | "address">): string {
  return person.name || person.address || "(unknown)";
}

/** Sort events earliest first, with the id as a deterministic tie-breaker so two
 *  meetings at the same minute never swap places between renders. */
function compareEventsAsc(a: CalendarEvent, b: CalendarEvent): number {
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  if (a.end !== b.end) return a.end < b.end ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Merge event lists by id (earliest first). Later entries win, so a refreshed
 *  occurrence — one that has since moved or been answered — replaces the stale copy. */
export function mergeEvents(current: CalendarEvent[], incoming: CalendarEvent[]): CalendarEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(compareEventsAsc);
}

/**
 * Fold a freshly-fetched window into what we hold.
 *
 * The incoming window is AUTHORITATIVE over its own range: an event the server no
 * longer lists inside it has been deleted or moved in real Outlook and must
 * disappear here too. Events outside the window are untouched, so a background
 * refresh of July never drops a cached August.
 */
export function mergeCalendarWindow(
  current: CalendarEvent[],
  incoming: CalendarViewResult,
): CalendarEvent[] {
  const outside = current.filter(
    (event) => !(event.start < incoming.end && (event.end > incoming.start || event.start >= incoming.start)),
  );
  return mergeEvents(outside, incoming.events);
}
