// Shared protocol types + pure message logic for the web UI.
//
// These mirror the Rust backend's WebSocket protocol (see src/bin/server.rs) and
// port the terminal UI's pure helpers (ui/src/message-content.ts,
// ui/src/message-history.ts) so the web and terminal clients behave identically.
// Nothing here touches the DOM, the network, or any runtime-specific API.

// Mirrors the Rust `ConversationKind` (src/store.rs).
export type ConversationKind = "one_on_one" | "group" | "notes" | "unknown";

/** A file/card attachment shared in a message (surfaced from Teams `properties`
 *  by the backend). `url` is an authenticated hosted-content URL — it must be
 *  loaded through the backend media proxy (see `TeamsController.loadMedia`),
 *  never fetched directly by the browser. */
export type AttachmentKind = "image" | "file";
export type Attachment = {
  name: string;
  content_type: string;
  url: string;
  kind: AttachmentKind;
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

/** A structured system/activity event a message represents, rendered by the UI as
 *  a centered line instead of a chat bubble (see `system_event_value` in
 *  src/bin/server.rs and `CallEventLine`). Currently only call/meeting events. */
export type SystemEvent = {
  kind: "call";
  /** "ended" (a completed call), "missed", or "started". */
  event: "ended" | "missed" | "started";
  /** Call length in seconds (longest participant duration); 0 when unknown. */
  duration_seconds?: number;
  participant_count?: number;
  /** Display names of the participants, rendered as an overlapping avatar stack. */
  participants?: string[];
};

export type Conversation = {
  id: string;
  name: string;
  last_message_time: number;
  kind: ConversationKind;
  last_message_preview: string;
  last_message_sender: string;
  last_message_from_me: boolean;
  is_read: boolean;
  is_muted: boolean;
  is_pinned: boolean;
  is_hidden: boolean;
  thread_type: string;
  draft: string;
};

/** One team channel, as returned by the `channels` method (mirrors the Rust
 *  `ChannelRow` serialization in src/bin/server.rs). A channel is a distinct
 *  Teams thread (`@thread.tacv2`) whose messages reuse the SAME pipeline as a
 *  chat — open/backfill/send/edit/react all key on the thread id — so only the
 *  sidebar grouping (under its team, on a separate tab) differs. `team_id` /
 *  `team_name` are denormalized onto every row so grouping needs no extra lookup. */
export type Channel = {
  id: string;
  team_id: string;
  team_name: string;
  name: string;
  /** The team's General channel; sorted first within its team. */
  is_general: boolean;
  is_favorite: boolean;
  last_message_time: number;
  last_message_preview: string;
  last_message_sender: string;
  last_message_from_me: boolean;
  is_read: boolean;
  draft: string;
};

/** A team with its channels, the unit the sidebar renders as a collapsible
 *  section (team header → channel rows). Produced by {@link groupChannelsByTeam}. */
export type TeamGroup = {
  team_id: string;
  team_name: string;
  channels: Channel[];
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  seq: number;
  compose_time: number;
  sender: string;
  sender_mri?: string;
  content: string;
  /** File/card attachments (absent or empty when the message has none). Inline
   *  images embedded in `content` as `<img>` are NOT here — they are extracted
   *  from the content HTML by `parseMessageContent`. */
  attachments?: Attachment[];
  /** Reactions on the message (absent or empty when none). Aggregated per emotion
   *  by the backend; the UI maps each `key` to an emoji and shows a chip. */
  reactions?: Reaction[];
  /** When present, this message is a system/activity event (e.g. a call ended) and
   *  is rendered as a centered line, not a chat bubble; `content` is empty. */
  system_event?: SystemEvent;
  is_self?: boolean;
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
  /** Short preview of the target message. */
  preview: string;
  /** Epoch ms. */
  timestamp: number;
  /** Actors aggregated into this entry (>= 1). */
  count: number;
  /** Teams' server-side read state. */
  is_read: boolean;
};

/** The activity feed plus its unread count, as returned by `notifications`. */
export type NotificationFeed = {
  unread: number;
  items: Notification[];
};

/** Non-secret view of the app settings (mirrors the Rust `get_settings` /
 *  `set_settings` result in src/bin/server.rs). The GitLab token is write-only
 *  from the UI's side: we only ever learn whether one is stored, never its value. */
export type AppSettings = {
  /** GitLab host used for link previews, e.g. "gitlab.com" or a self-hosted host. */
  gitlab_host: string;
  /** True when a GitLab access token is stored on the backend. */
  gitlab_token_set: boolean;
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
};

/** Result of an `enrich_link` request: the metadata, or `null` when the link is
 *  not an enrichable GitLab resource (or is private/absent). */
export type LinkMetadataResult = { metadata: GitLabLinkMetadata | null };

// ---- message content parsing (ported from ui/src/message-content.ts) -------

export type MessageQuote = {
  sender: string;
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

/** Microsoft domains whose media is authenticated and must be fetched through
 *  the backend proxy (mirrors the allowlist in src/teams_media.rs). Everything
 *  else — public CDNs like giphy or the Teams static-asset CDN — is loaded
 *  directly by the browser, since it needs no credentials. */
const PROXY_MEDIA_DOMAINS = [
  "skype.com",
  "teams.microsoft.com",
  "teams.cloud.microsoft",
  "teams.office.com",
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

const REPLY_BLOCKQUOTE =
  /<blockquote\b[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[^>]*>([\s\S]*?)<\/blockquote>/i;
const QUOTED_AUTHOR = /<strong\b[^>]*itemprop="mri"[^>]*>([\s\S]*?)<\/strong>/i;
const QUOTED_PREVIEW = /<p\b[^>]*itemprop="preview"[^>]*>([\s\S]*?)<\/p>/i;

/** Split a raw Teams message HTML into an optional quote plus the body text. */
export function parseMessageContent(html: string): ParsedMessage {
  const match = html.match(REPLY_BLOCKQUOTE);
  const inner = match?.[1];
  if (inner === undefined) return { body: plain(html), images: extractImages(html) };

  const sender = plain(inner.match(QUOTED_AUTHOR)?.[1] ?? "");
  const previewHtml = inner.match(QUOTED_PREVIEW)?.[1];
  const text = plain(previewHtml ?? inner.replace(QUOTED_AUTHOR, ""));

  const quoteIndex = match?.index ?? 0;
  const quoteEnd = quoteIndex + (match?.[0].length ?? 0);
  const beforeQuote = plain(html.slice(0, quoteIndex));
  const afterQuote = plain(html.slice(quoteEnd));
  const body = [beforeQuote, afterQuote].filter(Boolean).join("\n");
  // Inline images live in the body, never inside the quoted preview.
  const images = extractImages(html.slice(0, quoteIndex) + html.slice(quoteEnd));

  if (!sender && !text) return { body, images };
  return { quote: { sender, text }, body, beforeQuote, afterQuote, images };
}

export type RichQuote = {
  sender: string;
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
 * formatting (bold, links, lists, code, mentions, images). The reply quote is
 * still split out so it can be shown in its recessed block.
 */
export function parseRichMessage(html: string): ParsedRichMessage {
  const match = html.match(REPLY_BLOCKQUOTE);
  const inner = match?.[1];
  if (inner === undefined) return { bodyHtml: html };

  const sender = plain(inner.match(QUOTED_AUTHOR)?.[1] ?? "");
  const previewHtml = inner.match(QUOTED_PREVIEW)?.[1];
  const quoteHtml = previewHtml ?? inner.replace(QUOTED_AUTHOR, "");

  const quoteIndex = match?.index ?? 0;
  const quoteEnd = quoteIndex + (match?.[0].length ?? 0);
  const beforeHtml = html.slice(0, quoteIndex);
  const afterHtml = html.slice(quoteEnd);

  if (!sender && plain(quoteHtml) === "") {
    return { bodyHtml: [beforeHtml, afterHtml].filter((s) => plain(s)).join("") };
  }
  return {
    quote: { sender, html: quoteHtml },
    beforeHtml,
    bodyHtml: afterHtml,
  };
}

/** The plain text a "Copy"/"Reply" action should use for a message. */
export function copyableMessageText(message: ChatMessage): string {
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
export function formatCallEvent(event: SystemEvent): string {
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

// ---- history merge logic (ported from ui/src/message-history.ts) -----------

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

// ---- conversation display helpers (ported from ui/src/app.tsx) -------------

export function convLabel(c: Conversation): string {
  if (c.name && c.name.length > 0) return c.name;
  if (c.kind === "notes") return "Notes";
  return "(untitled)";
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
  const isGroup = c.kind === "group" || c.kind === "unknown";
  if (isGroup && c.last_message_sender) return `${firstName(c.last_message_sender)}: ${body}`;
  return body;
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
      group = { team_id: c.team_id, team_name: c.team_name, channels: [] };
      byTeam.set(c.team_id, group);
      groups.push(group);
    }
    group.channels.push(c);
  }
  return groups;
}

/**
 * Whether a channel is favorited, honouring a local override. The backend seeds
 * `is_favorite` from Teams' own favorite/pinned state; the user can then toggle
 * it locally (persisted client-side), and that override wins. Absent an override
 * we fall back to Teams' value, so channels favorited in real Teams show as
 * favorites out of the box.
 */
export function channelIsFavorite(c: Channel, overrides: Record<string, boolean>): boolean {
  const override = overrides[c.id];
  return override === undefined ? c.is_favorite : override;
}

/** The sidebar's channel sections: a flat Favorites list pinned at the top, then
 *  the team → channel tree for everything else. Mirrors Microsoft Teams, where a
 *  favorited channel is lifted into a top "Favorites" area. */
export type ChannelSections = {
  favorites: Channel[];
  teams: TeamGroup[];
};

/**
 * Split the (Teams-ordered) channel list into the pinned Favorites and the
 * remaining team tree. Favorited channels are lifted out of their team into a
 * single flat Favorites list, preserving the incoming order (the user's own
 * Microsoft Teams order); the rest keep their team grouping via
 * {@link groupChannelsByTeam}. Pure, so the sidebar re-renders deterministically.
 */
export function organizeChannels(
  channels: Channel[],
  overrides: Record<string, boolean>,
): ChannelSections {
  const favorites: Channel[] = [];
  const rest: Channel[] = [];
  for (const c of channels) {
    if (channelIsFavorite(c, overrides)) favorites.push(c);
    else rest.push(c);
  }
  return { favorites, teams: groupChannelsByTeam(rest) };
}

/** Should an incoming message raise a notification? Pure, so it is testable. */
export function shouldNotify(
  msg: { conversation_id: string; is_self?: boolean },
  openConversationId: string | null,
): boolean {
  if (msg.is_self) return false;
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
