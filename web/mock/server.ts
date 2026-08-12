// teams-lite — MOCK BACKEND (dev-only stand-in for the Rust server)
//
// A standalone Bun WebSocket server that speaks the exact teams-lite backend
// protocol (see src/bin/server.rs) with realistic, deterministic seed data, so
// the web UI (web/src/lib/ws-client.ts) can be developed and verified WITHOUT a
// real Microsoft tenant. It is a faithful stand-in for the Rust core: same
// request/response envelope, same event names, same reply-blockquote markup as
// src/teams_send.rs.
//
//   request  (client -> server):  { "id": <n>, "method": "<m>", "params": {...} }
//   response (server -> client):  { "id": <n>, "result": <v> } | { "id": <n>, "error": "<msg>" }
//   event    (server -> client):  { "event": "<name>", "data": <v> }   (no id)
//
// Methods: ping | conversations | channels | open | backfill | set_draft | send
//          | edit | react | mark_read | notifications | read_receipts | fetch_media
//          | fetch_avatar
//          | profile | people_by_address | presence | sender_icon
//          | get_settings | set_settings | set_always_available | enrich_link
//          | linear_workspace
//          | gitlab_approvals | gitlab_set_approval
//          | push_status | push_subscribe | push_unsubscribe | push_test
//          | mail_folders | mail_list | mail_backfill | mail_body | mail_attachment
//          | mail_mark_read
// Events:  status | realtime_status | message | conversations_changed
//          | channels_changed | typing | call | read_receipt
//          | mail_folders_changed | mail_list_updated
//
// Run it (from the web/ directory):
//   export PATH="$HOME/.bun/bin:$PATH"
//   PORT=19455 bun run mock/server.ts
//
// It listens on ws://127.0.0.1:PORT (PORT defaults to 19455, the dev/E2E mock port —
// deliberately NOT the real backend's 19420, so a mock can never be mistaken for it).
// Point the UI at it with VITE_TEAMS_WS_URL=ws://127.0.0.1:19455.
//
// This file has no dependencies beyond the Bun runtime. Everything below —
// types, seed data, PRNG, protocol handling — is self-contained on purpose, so
// the mock keeps working even if the app's source shape drifts.
//
// English only: this repo mandates English artifacts. No non-English strings.

import type { ServerWebSocket } from "bun";
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Protocol types — mirror web/src/lib/protocol.ts exactly.
// ---------------------------------------------------------------------------

type ConversationKind = "one_on_one" | "group" | "notes" | "unknown";

type AttachmentKind = "image" | "file" | "recording" | "card";

type Attachment = {
  name: string;
  content_type: string;
  url: string;
  kind: AttachmentKind;
  thumbnail_url?: string;
  duration_seconds?: number;
  card?: CardPayload; // card only: the decoded adaptive/connector card
};

// An adaptive / connector card, flattened the way the Rust backend decodes it out
// of a `SWIFT.1` body (mirrors protocol.ts CardPayload and src/teams_cards.rs).
// `text` is PLAIN text with `\n` between blocks; an action with an empty `url` is
// not a link (a poll vote) and must not render as something clickable.
type CardPayload = {
  title: string;
  text: string;
  facts: { title: string; value: string }[];
  actions: { title: string; url: string }[];
  // Link unfurls only (see src/teams_unfurl.rs): which app produced the preview,
  // shown as a source chip above the card body, and its public icon URL.
  app_name?: string;
  app_icon?: string;
};

type Conversation = {
  id: string;
  name: string;
  last_message_time: number;
  kind: ConversationKind;
  last_message_preview: string;
  last_message_sender: string;
  /** Who wrote that preview, as an identity rather than a name, so the sidebar's
   *  attribution follows a nickname the user set (see `last_message_sender_mri` in
   *  src/store.rs). Absent when the frame carried no person `from`. */
  last_message_sender_mri?: string;
  last_message_from_me: boolean;
  is_read: boolean;
  /** Read HERE ONLY (Ghost mode): the marker is clear, Teams still holds it unread. */
  is_ghost_read: boolean;
  is_muted: boolean;
  is_pinned: boolean;
  is_hidden: boolean;
  thread_type: string;
  draft: string;
  /** In a 1:1, the other party's MRI — the single face the chat has. Empty for a
   *  group or a channel, which name no one person (see `avatar_mri` in
   *  src/store.rs). It addresses their photo, their card and their presence. */
  avatar_mri?: string;
  /** A group chat's own uploaded picture, as a hosted-content URL fetched through
   *  `fetch_media` — the shape the real backend reports (see the Rust
   *  `teams_read::parse_thread_picture`). Absent for a chat with none. */
  picture_url?: string;
};

// One team channel, as returned by the `channels` method (mirrors protocol.ts
// `Channel` and the Rust `ChannelRow` serialization). A channel is a distinct
// Teams thread (`@thread.tacv2`) whose messages reuse the SAME pipeline as a
// chat — open/backfill/send/edit/react all key on the thread id — so it never
// appears in the `conversations` list; only the sidebar grouping differs.
// How much a channel may notify: the user's own per-channel setting in Microsoft
// Teams, as the backend derives it (see `store::ChannelAlerts`).
type ChannelAlerts = "muted" | "mentions_only" | "all_new_posts" | "all_new_posts_and_replies";

type Channel = {
  id: string;
  team_id: string;
  team_name: string;
  team_group_id: string;
  name: string;
  is_general: boolean;
  /** Whether Teams SHOWS the channel in its team (its Show/Hide switch, which CSA
   *  still spells `isFavorite`) — not a favorites list. A false one renders under the
   *  team's "Hidden channels" entry. */
  is_shown: boolean;
  /** Whether the user pinned the channel to the top of the sidebar. */
  is_pinned: boolean;
  /** Whether the user has this channel's TEAM folded in their own Teams client. Every
   *  channel of a team carries the same value, as the Rust backend denormalizes it. */
  team_collapsed: boolean;
  alerts: ChannelAlerts;
  last_message_time: number;
  last_message_preview: string;
  last_message_sender: string;
  /** The identity behind that name. Same job as on `Conversation`. */
  last_message_sender_mri?: string;
  last_message_from_me: boolean;
  is_read: boolean;
  /** Read HERE ONLY (Ghost mode) — see `Conversation.is_ghost_read`. */
  is_ghost_read: boolean;
  draft: string;
};

type ChatMessage = {
  id: string;
  conversation_id: string;
  seq: number;
  compose_time: number; // epoch MILLISECONDS
  sender: string;
  sender_mri?: string;
  message_type?: string; // Teams `messagetype`: "Text" bodies are PLAIN, not HTML
  content: string; // HTML-ish, as Teams sends it (unless message_type is "Text")
  attachments?: Attachment[]; // file/card attachments (inline images live in content)
  reactions?: Reaction[]; // aggregated per emotion (key + count + whether ours)
  mentions?: MessageMention[]; // who the body's @mention spans point at, by itemid
  system_event?: SystemEvent; // when set, rendered as a centered system line
  is_self?: boolean;
  mentions_me?: boolean; // whether the mention spans point at US (backend-resolved)
  thread_root_id?: string; // channel only: id of the thread's root post
  thread_subject?: string; // channel only: thread title, present on the root
  deleted?: boolean; // sender deleted it; content (if kept) is revealable
};

// A structured system/activity event (mirrors protocol.ts SystemEvent and the Rust
// `system_event_value` wire shape): a call/meeting event, or a thread activity
// (someone added to the thread, a message pinned).
type SystemEvent =
  | {
      kind: "call";
      event: "ended" | "missed" | "started";
      duration_seconds?: number;
      participant_count?: number;
      participants?: string[];
      participant_mris?: string[]; // aligned with participants, for real profile photos
    }
  | {
      kind: "thread_activity";
      event: "member_added" | "pinned" | "unpinned";
      time_ms: number;
      actor_mri: string;
      members: string[]; // display names; Teams routinely sends these EMPTY
      member_mris: string[]; // aligned with members — the identity that always arrives
    }
  | {
      // A scheduled meeting, keyed off `properties.meeting["@type"]` by the backend
      // (never off the localised body text) — see parse_meeting_activity.
      kind: "meeting";
      event: "scheduled" | "cancelled" | "updated";
      title: string;
      start_ms: number;
      end_ms: number;
      location: string;
      organizer_mri: string;
      join_url: string;
    };

// Aggregated reaction on a message (mirrors protocol.ts Reaction / the Rust
// `reactions_value` wire shape).
//
// `mris` is the mock's own STORAGE, exactly as the Rust store keeps the emotion's
// user list, and `users` is what a read resolves it into (see `nicknamed`) — so a
// renamed colleague is named in a tooltip here for the same reason they are named
// there. A fixture may leave `mris` out; the reaction is then a count with no names,
// which is the honest state for a reactor this machine has never seen write.
type Reaction = { key: string; count: number; mine: boolean; mris?: string[]; users?: ReactionUser[] };

// One person behind a reaction, as the wire carries them.
type ReactionUser = { name: string; mine?: boolean };

// One @mention in a message body (mirrors protocol.ts MessageMention / the Rust
// `parse_mentions` wire shape). The body's span carries only `itemid`; this is
// where the mentioned identity lives. Only `kind: "person"` names a human.
type MessageMention = {
  itemid: number;
  mri: string;
  kind: "person" | "channel" | "team" | "tag";
  display_name: string;
};

type MessagePage = { messages: ChatMessage[]; has_more: boolean };

// The reply metadata the UI sends with `send` (mirrors protocol.ts ReplyTo).
type ReplyTo = {
  compose_time: number;
  sender: string;
  sender_mri: string;
  preview: string;
  before: string;
  after: string;
};

/** One image of the `images` list accepted by `send`. The shape mirrors the web and
 *  Rust protocol. The mock validates it instead of accepting a partial object,
 *  so protocol drift fails a test instead of producing a misleading echo. */
type SendImage = {
  name: string;
  content_type: string;
  data_base64: string;
  width?: number;
  height?: number;
};

/** How many pictures one message carries — `teams_send::MAX_IMAGES` — and what they may
 *  weigh together, `MAX_IMAGES_TOTAL_BYTES`. Mirrored so each refusal is reachable with
 *  no tenant: a mock that accepts what the backend refuses hides the bug rather than
 *  failing a test. */
const MAX_SEND_IMAGES = 10;
const MAX_SEND_IMAGES_TOTAL_BYTES = 30 * 1024 * 1024;

type CapturedSend = {
  conversation: string;
  text: string;
  reply_to?: ReplyTo;
  content_html?: string;
  /** Every picture the message carries, in the order the composer sent them. */
  images?: SendImage[];
  /** Who the body's mention spans name, by the itemid each span carries. What a spec
   *  asserts on to prove a mention actually left the composer. */
  mentions?: OutboundMention[];
};

/** One @mention as the composer sends it (mirrors the Rust `teams_send::Mention`). */
type OutboundMention = {
  itemid: number;
  mri: string;
  display_name: string;
};

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 19455);
const HOST = "127.0.0.1";

/** Matches teams_read::DEFAULT_PAGE_SIZE (see src/bin/server.rs tests). */
const PAGE_SIZE = 40;
/** Backlog per conversation so infinite scroll + backfill are well exercised. */
const BACKLOG = Number(process.env.MOCK_BACKLOG ?? 120);
/** Whether a backlog carries the TALL messages a real thread has (see
 *  `LONG_MESSAGE_POOL`): `MOCK_TALL_ROWS=1`.
 *
 *  Off by default, and that default is a known compromise rather than a preference.
 *  Measured on this account's own store, a chat's median message is ~30 characters
 *  and the tail reaches 5000, so ON is the honest fixture — and turning it on makes
 *  `history.spec.ts` fail two of its assertions, because the virtualized history
 *  really does jerk when a row measures many times its `ROW_ESTIMATE_PX` guess.
 *  That is a live defect with its own repro, not a fixture problem:
 *
 *      MOCK_TALL_ROWS=1 bunx playwright test e2e/history.spec.ts
 *
 *  Turn it on when working on the history's scroll, and leave the default alone
 *  until the estimate is fixed: a suite that fails by default teaches its readers to
 *  ignore it. */
const TALL_ROWS = process.env.MOCK_TALL_ROWS === "1";
/** Fixed seed for the PRNG → deterministic content/structure across runs. */
const SEED = 0x7ea115;
/** How often to inject a live incoming message. Set MOCK_LIVE_MS=0 to disable
 *  the random feed (used by the E2E suite so live events are deterministic). */
const LIVE_INTERVAL_MS = Number(process.env.MOCK_LIVE_MS ?? 7_000);
/** Delay before echoing a sent message, simulating the real-time round trip. */
const SEND_ECHO_DELAY_MS = 150;
/** How long a mock call rings before the far side picks up, and before its audio is
 *  reported as flowing — the same two beats a meeting join uses for its lobby and its
 *  roster. Short by default, so a spec waits through them; the preview script raises
 *  them, because a state nobody can see is a state nobody reviewed. */
const MOCK_CALL_ANSWER_MS = Number(process.env.MOCK_CALL_ANSWER_MS ?? 400);
const MOCK_CALL_CONNECT_MS = Number(process.env.MOCK_CALL_CONNECT_MS ?? 700);

/** When "1", expose an HTTP control plane (POST /__test/emit, GET
 *  /__test/conversations) so E2E tests can drive live events deterministically.
 *  Off by default — the mock behaves exactly as before for plain dev use. */
const TEST_HOOKS = process.env.MOCK_TEST_HOOKS === "1";

/** Mutable send behavior exists only behind the E2E control plane. It lets a
 *  spec prove duplicate-send prevention and failure retention deterministically. */
let testSendDelayMs = 0;
let testSendError = "";
const capturedSends: CapturedSend[] = [];
let nextSentImage = 0;

/** Our own identity. The UI tags messages via `is_self`; the MRI is the anchor. */
const SELF_NAME = "You";
const SELF_MRI = "8:orgid:00000000-0000-4000-8000-000000000000";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + small helpers.
// ---------------------------------------------------------------------------

/** mulberry32: tiny, fast, seedable PRNG. Returns a function yielding [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shared generator for all SEED-driven data (kept in a fixed call order). */
const rand = mulberry32(SEED);

/** Pick a random element using the supplied generator. */
function pick<T>(arr: readonly T[], r: () => number): T {
  return arr[Math.floor(r() * arr.length)]!;
}

/** Return `k` distinct elements from `arr` (Fisher–Yates on a copy). */
function sample<T>(arr: readonly T[], k: number, r: () => number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, k);
}

/** Escape user text into the minimal HTML Teams' RichText/Html wants. Mirrors
 *  teams_send::escape_html — only markup characters are neutralized. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strip HTML tags and decode the handful of entities Teams emits. Mirrors
 *  protocol.ts `plain`, used here to build sidebar previews. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/** Plain, whitespace-collapsed, ~80-char preview of a message's HTML content.
 *
 *  The quoted part of a reply is dropped first, as `teams_read::preview_from_html` drops
 *  it (`preview_drops_the_quoted_part_of_a_reply`): a sidebar row says what the message
 *  ADDS to the thread, and a preview opening with the words being answered names the
 *  wrong message. */
function previewOf(content: string): string {
  const text = plain(withoutQuotedBlocks(content)).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// ---------------------------------------------------------------------------
// Reply-blockquote markup — byte-for-byte compatible with src/teams_send.rs.
// ---------------------------------------------------------------------------

/** paragraph(text) as teams_send.rs builds it (empty text → empty string). */
function paragraph(text: string): string {
  if (!text) return "";
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}

/** The <blockquote> Teams uses to quote the replied-to message. */
function quoteBlock(reply: {
  compose_time: number;
  sender: string;
  sender_mri: string;
  preview: string;
}): string {
  return (
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${reply.compose_time}">` +
    `<strong itemprop="mri" itemid="${escapeHtml(reply.sender_mri)}">${escapeHtml(reply.sender)}</strong>` +
    `<span itemprop="time" itemid="${reply.compose_time}"></span>` +
    `<p itemprop="preview">${escapeHtml(reply.preview)}</p></blockquote>`
  );
}

/** Compose outgoing content exactly like teams_send::message_content: when
 *  replying, the body is paragraph(before) + quote + paragraph(after) and the
 *  plain `text` is ignored (the web UI puts the composed body in `after`).
 *  When `contentHtml` is set (rich send), it is the pre-normalized Teams-safe
 *  HTML body; for a reply the quote is prepended, mirroring the Rust backend. */
function composeContent(
  text: string,
  reply: ReplyTo | undefined,
  contentHtml?: string,
): string {
  if (contentHtml) {
    return reply ? quoteBlock(reply) + contentHtml : contentHtml;
  }
  if (!reply) return escapeHtml(text);
  return paragraph(reply.before) + quoteBlock(reply) + paragraph(reply.after);
}

/** Build a seed/live reply message: quote an earlier message, then a short body. */
function replyContent(
  quoted: ChatMessage,
  body: string,
): string {
  return (
    quoteBlock({
      compose_time: quoted.compose_time,
      sender: quoted.sender,
      sender_mri: quoted.sender_mri ?? "",
      preview: previewOf(quoted.content),
    }) + paragraph(body)
  );
}

// ---------------------------------------------------------------------------
// Seed data pools (all English).
// ---------------------------------------------------------------------------

type Person = { name: string; mri: string };

/** Turn a display name into a stable MRI (any unique string works as a key). */
function personFrom(name: string): Person {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/(^-|-$)/g, "");
  return { name, mri: `8:orgid:${slug}` };
}

/** MRIs for a call's participant names, aligned index-for-index — so mock call
 *  events exercise the real-photo path on the avatar stack (see `mockAvatar`,
 *  which gives roughly two-in-three subjects a picture and the rest a coin). */
function callMris(names: string[]): string[] {
  return names.map((n) => personFrom(n).mri);
}

const PEOPLE: Person[] = [
  "Ava Thompson",
  "Liam Nguyen",
  "Olivia Martins",
  "Noah Kim",
  "Emma Rossi",
  "Lucas Silva",
  "Mia Chen",
  "Ethan Brown",
  "Sofia Garcia",
  "Mason Lee",
  "Isabella Novak",
  "James Wright",
  "Charlotte Dubois",
  "Benjamin Cohen",
  "Amelia Fischer",
  "Henry Walker",
  "Ella Johansson",
  "Alexander Popov",
  "Grace Okoye",
  "Daniel Park",
  "Chloe Bernard",
  "Sebastian Meyer",
  "Zoe Anderson",
  "Jack Murphy",
  "Layla Hassan",
  "Leo Romano",
  "Nora Andersen",
  "Owen Davis",
].map(personFrom);

const GROUP_NAMES = [
  "Platform Team",
  "Design Sync",
  "Frontend Guild",
  "Incident Response",
  "Product Standup",
  "Release Crew",
  "Coffee Chat",
];

/** The group chats Microsoft Teams opened FOR a recurring meeting, as opposed to
 *  the ones a person started by writing in them. A real tenant is mostly these
 *  (398 of 499 multi-party threads on the account this was measured against), so
 *  the seed carries both origins and the sidebar shows both glyphs. */
const MEETING_GROUP_NAMES = new Set(["Design Sync", "Product Standup"]);

/** Teams and their channels. Each channel gets a full backlog and lives under
 *  the Channels tab only — never in the Chats list. "General" is the team's
 *  default channel and always sorts first within its team. `team_id` is any
 *  stable key (the sidebar groups by it); channel ids end in `@thread.tacv2`,
 *  the discriminant the backend uses to route a thread to the channel pipeline. */
const TEAM_SEEDS: { id: string; name: string; channels: string[]; collapsed?: boolean }[] = [
  {
    id: "team-engineering",
    name: "Engineering",
    channels: ["General", "Frontend", "Backend", "Incidents", "Archive"],
  },
  {
    id: "team-design",
    name: "Design",
    channels: ["General", "Research", "Critique"],
  },
  {
    id: "team-product",
    name: "Product",
    channels: ["General", "Roadmap"],
    // Folded in the user's own Teams client, so the sidebar opens it folded too. One
    // team, and the LAST one, so every spec that reaches for the first team still finds
    // its channels.
    collapsed: true,
  },
];

/** The notification setting each seeded channel carries — the mock's stand-in for
 *  what a tenant reports (a channel's `isMuted`, its `channelNotificationSettings`,
 *  and the older `isFollowed`). Keyed `"Team/Channel"`; a channel that is absent
 *  here gets Teams' own default, `mentions_only`.
 *
 *  Fixed, never random: a spec and a screenshot must find the muted row in the same
 *  place every run, and drawing from the PRNG here would shift the sequence every
 *  existing channel spec depends on. */
const CHANNEL_ALERTS: Record<string, ChannelAlerts> = {
  "Design/Critique": "muted",
  "Engineering/Incidents": "all_new_posts",
  "Product/Roadmap": "all_new_posts_and_replies",
};

/** The channels Teams HIDES, keyed `"Team/Channel"` — every other seeded channel is
 *  shown. Fixed for the same reason as the alerts above, and there is exactly one, so
 *  a spec knows which team grows a "Hidden channels" entry.
 *
 *  A real tenant hides plenty (34 of this user's 75 channels), which is precisely why
 *  the flag behind it must not group anything: see `channelIsShown` in
 *  web/src/lib/protocol.ts. */
const HIDDEN_CHANNELS = new Set(["Engineering/Archive"]);

const MESSAGE_POOL = [
  "Morning! Did you get a chance to look at the deploy from last night?",
  "Yeah, it went out clean. No alerts so far.",
  "Can you review my PR when you have a minute?",
  "Just pushed a fix for the flaky test.",
  "Standup in 10, I'll share my screen.",
  "The staging environment is back up.",
  "Do we have a decision on the caching layer yet?",
  "I'll take the on-call rotation this week.",
  "Lunch? There's a new place around the corner.",
  "The customer demo moved to Thursday.",
  "Nice work on the latency graphs.",
  "Merged. Thanks for the quick turnaround!",
  "I think we should split this into two tickets.",
  "Heads up: the API rate limit changed.",
  "Let's pair on this after lunch.",
  "Docs are updated, take a look when you can.",
  "That regression is fixed on main now.",
  "Can you approve the design doc?",
  "Rolling back the last change to be safe.",
  "The build is green again.",
  "Ping me if the pipeline breaks.",
  "Great catch on that null check.",
  "We're good to ship.",
  "I'll write up the postmortem tomorrow.",
  "Coffee is on me today.",
  "Feature flag is enabled for 10% of users.",
  "The metrics look healthy after the rollout.",
  "Let's sync on the roadmap this afternoon.",
  "I updated the mockups with the new spacing.",
  "Tests pass locally but fail in CI, digging in.",
  "Can we bump the timeout to 30 seconds?",
  "Shipping the hotfix now.",
  "Thanks team, that was a solid sprint.",
  "Who owns the auth service this quarter?",
  "The dashboard is live, link is in the channel.",
  "I'll be out Friday afternoon.",
  "Reverted, sorry about the noise.",
  "Looks good to me 👍",
  "Let me double-check the config.",
  "Deploy window is 3pm your time.",
  "The migration ran without issues.",
  "Adding you as a reviewer.",
  "Can you take a look at the error budget?",
  "We hit our SLO for the month.",
  "The retro notes are in the shared doc.",
];

/** The tall messages a real thread carries, and the reason they are here.
 *
 *  Measured on this account's own store, a chat's median message is ~30 characters
 *  — one line, a ~60px row — but the tail reaches 5000: a written-out proposal, a
 *  pasted stack trace, an agent's answer. So a real history is mostly short rows
 *  with the occasional one twenty times taller.
 *
 *  A fixture of uniform one-liners hides every bug the virtualized history can
 *  have, because `ROW_ESTIMATE_PX` then happens to be right for every row and
 *  nothing is ever re-measured. These bodies restore that variance, so the scroll
 *  is reviewable against the shape it meets in production. Keep the spread —
 *  short, medium and very tall — rather than one representative size. */
const LONG_MESSAGE_POOL = [
  "<p>Quick summary of where the caching work stands.</p><p>The read path is done and behind the flag. The write path still invalidates more than it needs to, so I'd rather not turn it on for everyone until that is narrower. I'll have a patch up tomorrow.</p>",
  "<p>Notes from the review, in the order we went through them:</p><ul><li>The retry wrapper swallows the original error, so a timeout and a 500 read the same in the logs.</li><li>We call the profile endpoint once per row instead of batching, which is what makes the list slow on a cold cache.</li><li>The token refresh has no jitter, so every client refreshes in the same second.</li></ul><p>None of these block the release. I'd take the second one first — it is the one users feel.</p>",
  "<p>Longer answer, since the short one would be misleading.</p><p>The reason the numbers disagree is that the two dashboards measure different things. Ours counts a request as failed when the client gave up; theirs counts it when the server returned an error. A request that timed out at the gateway is a failure for us and a success for them, and that is most of the gap.</p><p>I would keep both. The server-side number tells us whether the service is healthy, and the client-side one tells us whether people can use it. When they diverge, the divergence itself is the signal — that is how we found the gateway limit last month.</p><p>What I'd change is the naming, because \"error rate\" on two dashboards meaning two things has cost us an afternoon twice now.</p>",
  "<p>I dug into the flake and it is not the test.</p><p>The fixture builds a store, writes to it, and closes it in an <code>afterEach</code>. Under load the write is still in flight when the close runs, so the next test opens a database with a stale WAL and reads a row that should not exist yet. It passes alone and fails in a full run, which is exactly the pattern we kept blaming on the test itself.</p><p>The fix is to await the write rather than the close, and to give each test its own file so one run can never see another's WAL. I've done both on a branch. It survived two hundred iterations, where it used to fail in about twelve.</p><p>Two things worth saying beyond the fix. First, we have three other suites that share one fixture file, and they will have the same bug the day they get slow enough. Second, the reason it took a week is that the failure named the assertion rather than the cause — the row that appeared was reported as a bad expectation, not as a leak from the previous test. I'd rather spend an hour making that error message name the file it came from than debug this shape again.</p>",
];

const REPLY_BODIES = [
  "Sounds good.",
  "On it.",
  "Thanks!",
  "Let me check and get back to you.",
  "Agreed.",
  "Good point.",
  "Will do.",
  "Makes sense.",
  "I'll take care of it.",
  "Perfect, thanks.",
];

// ---------------------------------------------------------------------------
// In-memory store: conversations + their messages, mutated over the session.
// ---------------------------------------------------------------------------

type ConvState = {
  conv: Conversation;
  messages: ChatMessage[]; // ascending by seq (1..N)
  /** Non-self participants (for choosing live/incoming senders). */
  participants: Person[];
};

const store = new Map<string, ConvState>();
/** Insertion order preserved so the seed is reproducible; sidebar sorts by time. */
const order: string[] = [];
/** The conversations whose sidebar time never moves again, so their place in that sort is a
 *  constant for the whole run. Filled by {@link addFixtureConversation}, which says why. */
const frozenSidebarTime = new Set<string>();

/** A channel mirrors ConvState but tracks a `Channel` summary instead of a
 *  `Conversation`; its messages reuse the shared pipeline (see {@link threadFor}). */
type ChannelState = {
  channel: Channel;
  messages: ChatMessage[]; // ascending by seq (1..N)
  /** Non-self participants (channels are always multi-party). */
  participants: Person[];
};

/** Channels are kept apart from `store` so they never leak into the Chats list,
 *  exactly like the Rust core's separate `channels` table. */
const channelStore = new Map<string, ChannelState>();
const channelOrder: string[] = [];

/** Milliseconds between two consecutive backlog messages: mostly minutes, with
 *  the occasional multi-hour gap so a 120-message backlog spans several days. */
function gapMs(r: () => number): number {
  const minutes = 2 + Math.floor(r() * 148); // 2..150 minutes
  const bigJump = r() < 0.12 ? (4 + Math.floor(r() * 12)) * 60 : 0; // +4..16h
  return (minutes + bigJump) * 60_000;
}

/** Generate a deterministic backlog for one conversation (ascending by seq). */
// Thread titles for channel backlogs (Teams `properties.subject`). Only used
// when `generateBacklog` runs in channel mode, to give each thread a heading.
const THREAD_SUBJECTS = [
  "Weekly sync notes",
  "Deploy went out 🎉",
  "Flaky test in CI",
  "Design review: new nav",
  "Who's on-call this week?",
  "Bug: avatars not loading",
  "Proposal: bump the token TTL",
  "Lunch plans?",
];

function generateBacklog(
  convId: string,
  kind: ConversationKind,
  participants: Person[],
  newestTime: number,
  channel = false,
): ChatMessage[] {
  // Fill timestamps backward from the newest so seq order == time order.
  const times = new Array<number>(BACKLOG);
  let t = newestTime;
  for (let i = BACKLOG - 1; i >= 0; i--) {
    times[i] = t;
    t -= gapMs(rand);
  }

  const messages: ChatMessage[] = [];
  let prevSelf = rand() < 0.5; // whichever side opens the 1:1
  // In channel mode, posts belong to threads: keep a few threads "open" and
  // either start a new one (this post is its root, with a subject) or reply to a
  // recent one. Posts from different threads thus interleave by seq, exactly as
  // the real API returns them — which is what the UI regroups.
  const openThreads: string[] = [];
  for (let i = 0; i < BACKLOG; i++) {
    const seq = i + 1;
    const compose_time = times[i]!;

    // Decide who sent this one.
    let isSelf: boolean;
    let sender: string;
    let senderMri: string;
    if (kind === "notes") {
      isSelf = true;
    } else if (kind === "one_on_one") {
      // Mostly alternate, but allow short runs from the same side.
      isSelf = rand() < 0.35 ? prevSelf : !prevSelf;
    } else {
      // Group: usually a teammate, sometimes us.
      isSelf = rand() < 0.22;
    }
    prevSelf = isSelf;
    if (isSelf) {
      sender = SELF_NAME;
      senderMri = SELF_MRI;
    } else {
      const p = kind === "one_on_one" ? participants[0]! : pick(participants, rand);
      sender = p.name;
      senderMri = p.mri;
    }

    // Content: mostly a plain line; occasionally a reply that quotes an earlier
    // message so the UI's reply-blockquote parsing is exercised, and every ninth
    // one a TALL body (see `LONG_MESSAGE_POOL`) so the history carries the height
    // variance a real thread has.
    //
    // The tall one is chosen from the index rather than from `rand()` on purpose:
    // the generator's randomness is one seeded stream, so drawing from it here
    // would shift every later draw and silently rewrite every fixture in the mock
    // — including the bodies the specs assert on.
    let content: string;
    if (i >= 3 && rand() < 0.12) {
      const start = Math.max(0, i - 8);
      const quoted = messages[start + Math.floor(rand() * (i - start))]!;
      content = replyContent(quoted, pick(REPLY_BODIES, rand));
    } else {
      content = escapeHtml(pick(MESSAGE_POOL, rand));
    }
    // The tall body REPLACES what the draws above produced, rather than standing
    // in front of them as its own branch: the draws still happen, in the same
    // order, so every other message in every fixture keeps the exact body it had.
    if (TALL_ROWS && i % 9 === 4) {
      content = LONG_MESSAGE_POOL[Math.floor(i / 9) % LONG_MESSAGE_POOL.length]!;
    }

    const id = `${convId}#${seq}`;
    let thread_root_id: string | undefined;
    let thread_subject: string | undefined;
    if (channel) {
      const startNew = openThreads.length === 0 || rand() < 0.28;
      if (startNew) {
        thread_root_id = id; // this post is the thread's root
        thread_subject = pick(THREAD_SUBJECTS, rand);
        openThreads.push(id);
        if (openThreads.length > 4) openThreads.shift(); // keep a handful active
      } else {
        thread_root_id = pick(openThreads, rand); // a reply to a recent thread
      }
    }

    messages.push({
      id,
      conversation_id: convId,
      seq,
      compose_time,
      sender,
      sender_mri: senderMri,
      content,
      is_self: isSelf,
      thread_root_id,
      thread_subject,
    });
  }
  return messages;
}

/** Recompute the sidebar summary fields from the newest message. */
/** Short sidebar label for a system event (mirrors the backend's
 *  `call_event_label` in src/teams_read.rs). */
function systemEventSidebarLabel(event: SystemEvent): string {
  if (event.kind === "thread_activity") {
    if (event.event === "member_added") return "Added to the chat";
    return event.event === "pinned" ? "Pinned a message" : "Unpinned a message";
  }
  if (event.kind === "meeting") {
    if (event.event === "cancelled") return "Meeting cancelled";
    return event.event === "updated" ? "Meeting updated" : "Meeting scheduled";
  }
  if (event.event === "missed") return "Missed call";
  if (event.event === "started") return "Call started";
  return "Call ended";
}

function recomputeSummary(cs: ConvState): void {
  const last = cs.messages.at(-1);
  if (!last) return;
  // A FIXTURE thread keeps the time its seed gave it, whatever a spec posts into it, so its
  // place in the sidebar is a constant for the whole run — see `addFixtureConversation` for
  // what that protects. Everything else about the summary still follows the newest message:
  // what breaks other specs is the ORDER, not the words in the row.
  if (!frozenSidebarTime.has(cs.conv.id)) cs.conv.last_message_time = last.compose_time;
  cs.conv.last_message_preview = last.system_event
    ? systemEventSidebarLabel(last.system_event)
    : previewOf(last.content);
  cs.conv.last_message_sender = last.system_event ? "" : last.sender;
  // The identity too, so the attribution follows a nickname like every other name.
  cs.conv.last_message_sender_mri = last.system_event ? "" : (last.sender_mri ?? "");
  cs.conv.last_message_from_me = Boolean(last.is_self) && !last.system_event;
}

/** Recompute a channel's sidebar summary from its newest message. */
function recomputeChannelSummary(chs: ChannelState): void {
  const last = chs.messages.at(-1);
  if (!last) return;
  chs.channel.last_message_time = last.compose_time;
  chs.channel.last_message_preview = last.system_event
    ? systemEventSidebarLabel(last.system_event)
    : previewOf(last.content);
  chs.channel.last_message_sender = last.system_event ? "" : last.sender;
  chs.channel.last_message_sender_mri = last.system_event ? "" : (last.sender_mri ?? "");
  chs.channel.last_message_from_me = Boolean(last.is_self) && !last.system_event;
}

/** Create one conversation with its backlog and register it in the store. */
function addConversation(input: {
  id: string;
  name: string;
  kind: ConversationKind;
  participants: Person[];
  isRead: boolean;
  isMuted: boolean;
  isPinned: boolean;
  /** The `hidden` flag CSA reports for a chat. It is deliberately NOT a hide: measured
   *  against the tenant it is true on all 95 one-to-one chats, the colleagues the user
   *  messages daily included. One fixture carries it so the app can be held to reading
   *  it that way — the row stays in Recent (see `chatIsHidden`). */
  isHidden?: boolean;
  /** A custom group picture, as on a real tenant where some groups have one. */
  pictureUrl?: string;
  /** CSA's own `threadType`. Pass `"meeting"` for a thread Teams opened for a
   *  meeting or a call; omitted, a chat gets `"chat"` like the tenant sends. */
  threadType?: string;
}): void {
  const newestTime = Date.now() - Math.floor(rand() * 6 * 24 * 3_600_000); // 0..~6 days ago
  const messages = generateBacklog(input.id, input.kind, input.participants, newestTime);
  const conv: Conversation = {
    id: input.id,
    name: input.name,
    last_message_time: 0,
    kind: input.kind,
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: input.isRead,
    is_ghost_read: false,
    is_muted: input.isMuted,
    is_pinned: input.isPinned,
    is_hidden: input.isHidden === true,
    thread_type:
      input.threadType ??
      (input.kind === "one_on_one" || input.kind === "group" ? "chat" : ""),
    draft: "",
    // The other party's MRI, exactly as the Rust backend derives it (see
    // `avatar_mri` in src/store.rs: the 1:1 counterpart, empty for a group). It is
    // what gives a 1:1 header their photo, their card and their live presence.
    avatar_mri: input.kind === "one_on_one" ? (input.participants[0]?.mri ?? "") : "",
    picture_url: input.pictureUrl,
  };
  const cs: ConvState = { conv, messages, participants: input.participants };
  recomputeSummary(cs);
  // A conversation whose last message is ours has necessarily been read.
  if (conv.last_message_from_me) conv.is_read = true;
  store.set(conv.id, cs);
  order.push(conv.id);
}

/** Build the full deterministic seed: ~34 conversations with 120 messages each. */
function seed(): void {
  // 26 one-on-one chats (one per person).
  const oneOnOnePeople = PEOPLE.slice(0, 26);
  oneOnOnePeople.forEach((person, idx) => {
    addConversation({
      id: `19:1on1-${person.mri.split(":").pop()}@unq.gbl.spaces`,
      name: person.name,
      kind: "one_on_one",
      participants: [person],
      // A spread of unread chats; keep it deterministic via the shared PRNG.
      isRead: rand() >= 0.35,
      isMuted: rand() < 0.08,
      isPinned: idx === 0, // pin one 1:1
      // One chat carries Teams' `hidden` flag, so a spec can prove the app does not
      // read it as a hide: Olivia Martins, the third person.
      isHidden: idx === 2,
    });
  });

  // 7 group chats with varied membership.
  GROUP_NAMES.forEach((groupName, idx) => {
    const memberCount = 3 + Math.floor(rand() * 3); // 3..5 teammates
    const members = sample(PEOPLE, memberCount, rand);
    const slug = groupName.toLowerCase().replace(/[^a-z]+/g, "-");
    // A meeting-backed thread carries BOTH signals the app reads: the
    // `19:meeting_…@thread.v2` id Teams mints, and `threadType: "meeting"`.
    const isMeeting = MEETING_GROUP_NAMES.has(groupName);
    addConversation({
      id: isMeeting ? `19:meeting_${slug}-mock@thread.v2` : `19:${slug}-mock@thread.v2`,
      name: groupName,
      kind: "group",
      threadType: isMeeting ? "meeting" : undefined,
      participants: members,
      isRead: rand() >= 0.4,
      isMuted: rand() < 0.12,
      isPinned: idx === 0, // pin one group
      // Every other group carries a custom picture, so the sidebar shows both
      // states side by side — a real tenant is mixed the same way.
      pictureUrl:
        idx % 2 === 0
          ? `https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/mock-group-${slug}/views/avatar_fullsize`
          : undefined,
    });
  });

  // Exactly one Notes (self chat). `48:notes` is the real Teams notes-to-self id.
  addConversation({
    id: "48:notes",
    name: "Notes",
    kind: "notes",
    participants: [],
    isRead: true,
    isMuted: false,
    isPinned: false,
  });
}

/** Seed every team's channels with a full backlog. Called LAST so it never
 *  perturbs the PRNG sequence the chat seed depends on, keeping the Chats list
 *  identical for the existing specs. Channels are multi-party (a group backlog)
 *  and land in `channelStore`, so they surface only under the Channels tab. */
function seedChannels(): void {
  for (const team of TEAM_SEEDS) {
    team.channels.forEach((channelName) => {
      const teamSlug = team.name.toLowerCase().replace(/[^a-z]+/g, "-");
      const chanSlug = channelName.toLowerCase().replace(/[^a-z]+/g, "-");
      const id = `19:${teamSlug}-${chanSlug}-mock@thread.tacv2`;
      const isGeneral = channelName === "General";
      const memberCount = 3 + Math.floor(rand() * 3); // 3..5 teammates
      const participants = sample(PEOPLE, memberCount, rand);
      const newestTime = Date.now() - Math.floor(rand() * 6 * 24 * 3_600_000);
      const messages = generateBacklog(id, "group", participants, newestTime, true);
      const channel: Channel = {
        id,
        team_id: team.id,
        team_name: team.name,
        // In real tenants this is the AAD group id from the team's site info; the
        // mock reuses the stable team id so each team resolves a team avatar.
        team_group_id: team.id,
        name: channelName,
        is_general: isGeneral,
        is_shown: !HIDDEN_CHANNELS.has(`${team.name}/${channelName}`),
        // Nothing is pinned out of the box, exactly as the tenant reports (0 of 75):
        // the Pinned section only appears once the user pins something.
        is_pinned: false,
        team_collapsed: team.collapsed === true,
        alerts: CHANNEL_ALERTS[`${team.name}/${channelName}`] ?? "mentions_only",
        last_message_time: 0,
        last_message_preview: "",
        last_message_sender: "",
        last_message_from_me: false,
        is_read: rand() >= 0.4,
        is_ghost_read: false,
        draft: "",
      };
      const chs: ChannelState = { channel, messages, participants };
      recomputeChannelSummary(chs);
      // A channel whose last message is ours has necessarily been read.
      if (channel.last_message_from_me) channel.is_read = true;
      channelStore.set(id, chs);
      channelOrder.push(id);
    });
  }
}

/** The channel that carries the alert-card thread below — a spec and a screenshot
 *  both reach it by that name. */
const ALERT_CHANNEL = { team: "Engineering", channel: "Incidents" };

/** Append an app-card thread to the Engineering / Incidents channel: a monitoring
 *  alert relayed by a bot, which is a whole class of channel — a post whose entire
 *  content is one adaptive card, plus a couple of human replies under it.
 *
 *  It exists because a channel post is already framed by its thread's card, so a
 *  card post must render flush on that frame instead of drawing a second one inside
 *  it. Fully deterministic (no PRNG draw), and appended after `seedChannels` so the
 *  backlog every other spec asserts on is untouched. */
function seedChannelAlertThread(): void {
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, "-");
  const id = `19:${slug(ALERT_CHANNEL.team)}-${slug(ALERT_CHANNEL.channel)}-mock@thread.tacv2`;
  const chs = channelStore.get(id);
  if (!chs) return;

  const grafana = "https://grafana.example.com";
  const logs = `${grafana}/explore?left=%7B%22datasource%22%3A%22loki%22%2C%22queries%22%3A%5B%7B%22expr%22%3A%22%7Benvironment%3D%5C%22preprod%5C%22%2Cnamespace%3D%5C%22checkout%5C%22%7D%22%7D%5D%2C%22range%22%3A%7B%22from%22%3A%22now-1h%22%7D%7D`;
  const silence = `${grafana}/alerting/silence/new?alertmanager=grafana&matcher=__alert_rule_uid__%3Dcfto40tofrhfka`;
  const alert = (pod: string, env: string) =>
    [
      `**warning** — checkout-api in ${pod} (${env}) stuck in ImagePullBackOff for 15m.`,
      `**Debug:** kubectl -n checkout describe pod ${pod}`,
      `[🪵 Logs](${logs}) · [🔕 Silence](${silence})`,
    ].join("\n");

  const last = chs.messages.at(-1)!;
  let seq = last.seq;
  const push = (
    msg: Omit<ChatMessage, "id" | "conversation_id" | "seq" | "compose_time">,
    offsetMs: number,
  ): void => {
    seq += 1;
    chs.messages.push({
      id: `${id}#${seq}`,
      conversation_id: id,
      seq,
      compose_time: last.compose_time + offsetMs,
      ...msg,
    });
  };

  const rootId = `${id}#${seq + 1}`;
  push(
    {
      sender: "Workflows",
      content: "",
      thread_root_id: rootId,
      // A bot's alert post carries no subject at all — Teams shows the card's own
      // first line as the headline, which is exactly why the card must own the
      // whole post rather than sit in a box inside it.
      attachments: [
        {
          name: "Card",
          content_type: "application/vnd.microsoft.card.adaptive",
          url: "",
          kind: "card",
          card: {
            title: "🟠 FIRING:2 · ContainerCannotStartNonProd",
            text: [
              alert("checkout-api-6d844c5876-p66vq", "preprod"),
              alert("checkout-api-5778775fc7-sbhjx", "preprod-us"),
              "Lucas Silva used a Workflow template to send this card.",
            ].join("\n"),
            facts: [],
            actions: [{ title: "View URL", url: `${grafana}/alerting/list` }],
          },
        },
      ],
      is_self: false,
    },
    60_000,
  );
  push(
    {
      sender: PEOPLE[0]!.name,
      sender_mri: PEOPLE[0]!.mri,
      content: "<p>The registry credentials expired — rotating them now.</p>",
      thread_root_id: rootId,
      is_self: false,
    },
    120_000,
  );
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: "<p>Thanks, I'll watch the rollout.</p>",
      thread_root_id: rootId,
      is_self: true,
    },
    180_000,
  );

  recomputeChannelSummary(chs);
  chs.channel.is_read = true;
}

/** Register a dedicated "Media Gallery" conversation whose messages exercise the
 *  UI's inline-image and attachment rendering: a pasted screenshot embedded in
 *  the HTML, an image shared as an attachment, a non-image file, plus two
 *  image-only messages (one mine, one incoming) that render without a bubble —
 *  the incoming one keeping its sender name in the void above the picture. It is
 *  a standalone conversation (not one the other specs mutate or reorder), so
 *  tests reach it deterministically by name via the command palette. */
function seedMediaSamples(): void {
  const convId = "19:media-gallery-demo@thread.v2";
  const other = PEOPLE[0]!;
  // Dated well in the past so this fixed 4-message conversation never sorts to
  // the top of the sidebar (index 0), where other specs expect a full backlog.
  // Tests reach it by name via the command palette, so its position is moot.
  const base = Date.now() - 30 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  let seq = 0;

  const push = (
    msg: Omit<ChatMessage, "id" | "conversation_id" | "seq" | "compose_time">,
    offsetMs: number,
  ): void => {
    seq += 1;
    messages.push({
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: base + offsetMs,
      ...msg,
    });
  };

  push(
    { sender: other.name, sender_mri: other.mri, content: escapeHtml("Sharing some media below."), is_self: false },
    0,
  );
  // 1. An inline pasted screenshot: the image is embedded in the message HTML,
  //    exactly as Teams delivers an AMS inline image.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<div>Here's the screenshot from the incident:</div>` +
        `<div><img itemtype="http://schema.skype.com/AMSImage" ` +
        `src="https://eu-api.asm.skype.com/v1/objects/mock-inline-1/views/imgo" alt="incident graph"/></div>`,
      is_self: false,
    },
    60_000,
  );
  // 2. An image shared as an attachment (surfaced from properties.files).
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: `<p>And the updated diagram:</p>`,
      attachments: [
        {
          name: "architecture.png",
          content_type: "image/png",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-img-att-1/views/original",
          kind: "image",
        },
      ],
      is_self: true,
    },
    120_000,
  );
  // 3. A non-image file shared in the chat.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: `<p>Sharing the Q3 report</p>`,
      attachments: [
        {
          name: "quarterly-report.pdf",
          content_type: "application/pdf",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-file-1/content",
          kind: "file",
        },
      ],
      is_self: false,
    },
    180_000,
  );
  // 4. An image I sent with no text at all: an image-only message renders without
  //    a bubble, the picture standing alone.
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: "",
      attachments: [
        {
          name: "sunset.png",
          content_type: "image/png",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-img-att-2/views/original",
          kind: "image",
        },
      ],
      is_self: true,
    },
    240_000,
  );
  // 5. An inline image someone sent with no text. Following my message above, it
  //    starts a fresh incoming run, so the sender name shows — floating in the
  //    void above the picture rather than inside a bubble.
  //    The <p> wrapper is not decoration: Teams always delivers a pasted
  //    screenshot inside a block (`<p><img></p>` or `<div><img></div>`), never as a
  //    bare <img>, which pushes the image one level deeper in the rendered tree.
  //    A bare-<img> fixture hid a mat-padding bug that every real message had.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<p><img itemtype="http://schema.skype.com/AMSImage" ` +
        `src="https://eu-api.asm.skype.com/v1/objects/mock-inline-2/views/imgo" alt="whiteboard"/></p>`,
      is_self: false,
    },
    300_000,
  );
  // 6. A finished meeting recording (Teams `Video.2/CallRecording.1`), surfaced as
  //    a video card: a proxied poster with a play overlay and a duration badge,
  //    captioned with the recording title. The backend clears the body and the
  //    sender for these (their only author hint is a bare contacts URL), so this
  //    renders with no name and no bubble — exercising the blank-sender path.
  push(
    {
      sender: "",
      sender_mri: other.mri,
      content: "",
      attachments: [
        {
          name: "Keynote #3 du Lab Eng X Gen AI",
          content_type: "video/mp4",
          url: "https://siapartners1-my.sharepoint.com/:v:/g/personal/demo/IQCmMockRecording",
          kind: "recording",
          thumbnail_url:
            "https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/mock-recording-1/views/thumbnail",
          duration_seconds: 4083,
        },
      ],
      is_self: false,
    },
    360_000,
  );

  // 7. A SMALL raster picture (64×48 px). It is the one case an SVG fixture
  //    cannot express: a picture with a fixed resolution, smaller than the
  //    viewport, which the lightbox has to GROW when it opens (see
  //    lib/image-zoom.ts). It carries text, so it is not one of the two
  //    image-only messages the mat specs count.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: `<p>The exported icon, small on purpose:</p>`,
      attachments: [
        {
          name: "icon-small.png",
          content_type: "image/png",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-img-small/views/original",
          kind: "image",
        },
      ],
      is_self: false,
    },
    390_000,
  );

  // 8. Several files at once, of different types: the chips must name each family
  //    by its own coloured icon (see components/file-type-icon.tsx), and the last
  //    one carries a name with no extension — the case that falls back to the MIME
  //    type, and then to a plain page.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: `<p>All the workshop material</p>`,
      attachments: [
        {
          name: "Kickoff minutes.docx",
          content_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-file-2/content",
          kind: "file",
        },
        {
          name: "Budget 2026.xlsx",
          content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-file-3/content",
          kind: "file",
        },
        {
          name: "20260730 - Streams Introduction.pptx",
          content_type:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-file-4/content",
          kind: "file",
        },
        {
          name: "logs.zip",
          content_type: "application/zip",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-file-5/content",
          kind: "file",
        },
        {
          name: "voice-note",
          content_type: "audio/mp4",
          url: "https://eu-api.asm.skype.com/v1/objects/mock-file-6/content",
          kind: "file",
        },
      ],
      is_self: false,
    },
    420_000,
  );

  const conv: Conversation = {
    id: convId,
    name: "Media Gallery",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_ghost_read: false,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
  };
  const cs: ConvState = { conv, messages, participants: [other] };
  recomputeSummary(cs);
  store.set(convId, cs);
  order.push(convId);
}

/** Register a dedicated "Call Events" conversation whose messages are call/meeting
 *  system events (ended with a duration and roster, a missed call, a 1:1 call),
 *  so the UI's centered `CallEventLine` (not a chat bubble) is exercised. Reached
 *  by name in the command palette.
 *
 *  It is a meeting-backed thread, like every thread that carries these events on a
 *  real tenant: Teams mints the `19:meeting_…` id when the call starts it. */
function seedCallEvents(): void {
  const convId = "19:meeting_call-events-demo@thread.v2";
  const other = PEOPLE[0]!;
  const base = Date.now() - 20 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  let seq = 0;

  const push = (
    msg: Omit<ChatMessage, "id" | "conversation_id" | "seq" | "compose_time">,
    offsetMs: number,
  ): void => {
    seq += 1;
    messages.push({
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: base + offsetMs,
      ...msg,
    });
  };

  // A normal chat message, so the call lines sit among real bubbles.
  push(
    { sender: other.name, sender_mri: other.mri, content: escapeHtml("Jumping on a quick call."), is_self: false },
    0,
  );
  // A group call that ended: five participants -> a full avatar stack, no overflow.
  const groupRoster = ["Leonor GROELL", "Clément DELBARRE", "Matthieu GAUCHER", "Clément BOSLE", "Théophile WALLEZ"];
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "call",
        event: "ended",
        duration_seconds: 600,
        participant_count: groupRoster.length,
        participants: groupRoster,
        participant_mris: callMris(groupRoster),
      },
    },
    60_000,
  );
  // A large call: more than five participants -> five avatars plus a "+N" chip
  // that opens the full-roster dialog.
  const largeRoster = [
    "Leonor GROELL",
    "Clément DELBARRE",
    "Matthieu GAUCHER",
    "Clément BOSLE",
    "Théophile WALLEZ",
    "Souhail LYAMANI",
    "James BASSE",
  ];
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "call",
        event: "ended",
        duration_seconds: 3600,
        participant_count: largeRoster.length,
        participants: largeRoster,
        participant_mris: callMris(largeRoster),
      },
    },
    120_000,
  );
  // A missed call (no duration, no roster), rendered with a red-ish accent.
  push(
    {
      sender: "",
      content: "",
      system_event: { kind: "call", event: "missed" },
    },
    180_000,
  );
  // A 1:1 call that ended: two participants -> two avatars, duration only.
  const oneOnOneRoster = ["Clément BOSLE", "You"];
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "call",
        event: "ended",
        duration_seconds: 1400,
        participant_count: oneOnOneRoster.length,
        participants: oneOnOneRoster,
        participant_mris: callMris(oneOnOneRoster),
      },
    },
    240_000,
  );

  const conv: Conversation = {
    id: convId,
    name: "Call Events",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_ghost_read: false,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "meeting",
    draft: "",
  };
  const cs: ConvState = { conv, messages, participants: [other] };
  recomputeSummary(cs);
  store.set(convId, cs);
  order.push(convId);
}

/** Register a dedicated "Deleted Messages" conversation exercising the
 *  deleted-message UI: a message the sender deleted whose original text we had
 *  cached (revealable with the invisible-ink unveil), one of mine I deleted (also
 *  cached), and a pure tombstone we only ever saw as deleted (nothing to reveal).
 *  A couple of live bubbles sit around them so the ghosts read in context.
 *  Reached by name via the command palette. */
function seedDeletedMessages(): void {
  const convId = "19:deleted-messages-demo@thread.v2";
  const other = PEOPLE[0]!;
  const base = Date.now() - 10 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  let seq = 0;

  const push = (
    msg: Omit<ChatMessage, "id" | "conversation_id" | "seq" | "compose_time">,
    offsetMs: number,
  ): void => {
    seq += 1;
    messages.push({
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: base + offsetMs,
      ...msg,
    });
  };

  push(
    { sender: other.name, sender_mri: other.mri, content: escapeHtml("Thanks!"), is_self: false },
    0,
  );
  // A message the sender deleted, but which we had already cached — its original
  // text survives so it can be revealed with the unveil animation.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: escapeHtml("Sorry, I had to move our sprint prep — I'm in an interview and it's running over"),
      is_self: false,
      deleted: true,
    },
    60_000,
  );
  // One of mine that I deleted, also cached — shows the first-person label.
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: escapeHtml("Oops, sent that too soon 😅"),
      is_self: true,
      deleted: true,
    },
    120_000,
  );
  // A pure tombstone: deleted before we ever cached it, so there is nothing to
  // reveal — just the placeholder.
  push(
    { sender: other.name, sender_mri: other.mri, content: "", is_self: false, deleted: true },
    180_000,
  );
  push(
    { sender: other.name, sender_mri: other.mri, content: escapeHtml("No worries, let's lock it in tomorrow 👍"), is_self: false },
    240_000,
  );

  const conv: Conversation = {
    id: convId,
    name: "Deleted Messages",
    last_message_time: 0,
    kind: "one_on_one",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_ghost_read: false,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
    avatar_mri: other.mri,
  };
  const cs: ConvState = { conv, messages, participants: [other] };
  recomputeSummary(cs);
  store.set(convId, cs);
  order.push(convId);
}

/** Register a dedicated "Mention Demo" group whose messages exercise the person
 *  card: an @mention of a person (hoverable), an @mention of the channel itself
 *  (which must stay inert — a thread is not a person), and a reply quoting someone
 *  (whose quoted name is hoverable too). A mention span carries only an `itemid`;
 *  the identities ride alongside in `mentions`, exactly as the real backend sends
 *  them. Standalone and dated in the past, so tests reach it by name via the
 *  command palette without disturbing the specs that assume a full backlog at the
 *  top of the sidebar. */
function seedMentionSamples(): void {
  const convId = "19:mention-demo@thread.v2";
  const [ava, liam] = [PEOPLE[0]!, PEOPLE[1]!];
  const base = Date.now() - 25 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  let seq = 0;

  const push = (
    msg: Omit<ChatMessage, "id" | "conversation_id" | "seq" | "compose_time">,
    offsetMs: number,
  ): void => {
    seq += 1;
    messages.push({
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: base + offsetMs,
      ...msg,
    });
  };

  const mentionSpan = (itemid: number, text: string) =>
    `<span itemscope itemtype="http://schema.skype.com/Mention" itemid="${itemid}">${escapeHtml(text)}</span>`;

  // A person mention (card on hover) next to a channel mention (inert).
  push(
    {
      sender: ava.name,
      sender_mri: ava.mri,
      content: `<p>${mentionSpan(0, liam.name)} could you take a look? ${mentionSpan(1, "Platform Team")} FYI.</p>`,
      is_self: false,
      mentions: [
        { itemid: 0, mri: liam.mri, kind: "person", display_name: liam.name },
        { itemid: 1, mri: convId, kind: "channel", display_name: "Platform Team" },
      ],
    },
    0,
  );
  // A mention of us, and one of the same person again — repeat mentions of one
  // person must share a single lookup.
  push(
    {
      sender: liam.name,
      sender_mri: liam.mri,
      content: `<p>On it ${mentionSpan(0, SELF_NAME)} — ${mentionSpan(1, ava.name)} I'll ping you after.</p>`,
      is_self: false,
      mentions: [
        { itemid: 0, mri: SELF_MRI, kind: "person", display_name: SELF_NAME },
        { itemid: 1, mri: ava.mri, kind: "person", display_name: ava.name },
      ],
    },
    60_000,
  );
  // How Teams really sends a full name: one span PER WORD, each with its own itemid,
  // all of them naming one MRI. They must read as ONE chip. The two people written
  // back to back after them must not: same shape, two MRIs, so two chips.
  push(
    {
      sender: ava.name,
      sender_mri: ava.mri,
      content:
        `<p>${mentionSpan(0, "Clément")}&nbsp;${mentionSpan(1, "BOSLE")} ping me — ` +
        `${mentionSpan(2, ava.name)}&nbsp;${mentionSpan(3, liam.name)} too.</p>`,
      is_self: false,
      mentions: [
        { itemid: 0, mri: "8:orgid:clement", kind: "person", display_name: "Clément" },
        { itemid: 1, mri: "8:orgid:clement", kind: "person", display_name: "BOSLE" },
        { itemid: 2, mri: ava.mri, kind: "person", display_name: ava.name },
        { itemid: 3, mri: liam.mri, kind: "person", display_name: liam.name },
      ],
    },
    75_000,
  );
  // A mention in OUR OWN message: the chip sits on the accent-filled bubble, where a
  // light blue wash would disappear, so it must render in its `-mine` colours.
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: `<p>${mentionSpan(0, ava.name)} shipped it, thanks!</p>`,
      is_self: true,
      mentions: [{ itemid: 0, mri: ava.mri, kind: "person", display_name: ava.name }],
    },
    90_000,
  );
  // A reply: the quoted author's name carries their MRI, so it is hoverable too.
  push(
    {
      sender: ava.name,
      sender_mri: ava.mri,
      content: replyContent(messages[1]!, "Perfect, thanks!"),
      is_self: false,
    },
    120_000,
  );

  const conv: Conversation = {
    id: convId,
    name: "Mention Demo",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_ghost_read: false,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
  };
  const cs: ConvState = { conv, messages, participants: [ava, liam] };
  recomputeSummary(cs);
  store.set(convId, cs);
  order.push(convId);
}

function seedGitLabSamples(): void {
  const convId = "19:gitlab-links-demo@thread.v2";
  const other = PEOPLE[1]!;
  // Dated in the past so it never sorts to the top of the sidebar (other specs
  // assume index 0 has a full backlog); tests reach it by name.
  const base = Date.now() - 20 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  let seq = 0;

  const push = (
    msg: Omit<ChatMessage, "id" | "conversation_id" | "seq" | "compose_time">,
    offsetMs: number,
  ): void => {
    seq += 1;
    messages.push({
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: base + offsetMs,
      ...msg,
    });
  };

  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<p>Can you review ` +
        `<a href="https://gitlab.com/acme/webapp/-/merge_requests/42">this merge request</a>` +
        ` before the release?</p>`,
      is_self: false,
    },
    0,
  );
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content:
        `<p>Sure — it's tracked by ` +
        `<a href="https://gitlab.com/acme/webapp/-/issues/7">issue 7</a>.</p>`,
      is_self: true,
    },
    60_000,
  );
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<p>Repo for reference: ` +
        `<a href="https://gitlab.com/acme/webapp">acme/webapp</a></p>`,
      is_self: false,
    },
    120_000,
  );
  // A message that names its OWN project through the quote it replies to, and one that names
  // none at all — the shape measured on the tenant, where the link is pasted once and every
  // message after it says `!99`. `ENG-1` needs no project; `UTF-8` is a word that only looks
  // like a reference (see lib/tracker-ref.ts).
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      // A REPLY, which is the shape that makes a bare reference resolvable: the project comes
      // from the whole message, quote included (see `trackerProject` in message-bubble.tsx) —
      // and it is exactly the shape an agent's answer takes, since the request it quotes is
      // what named the merge request. It adds no card of its own: a quoted link is not
      // enriched, or the thread would draw a second card for a link already on screen.
      content:
        quoteBlock({
          compose_time: base,
          sender: other.name,
          sender_mri: other.mri,
          preview: "Can you review https://gitlab.com/acme/webapp/-/merge_requests/42 …",
        }) +
        `<p>Done — !99 is the follow-up and ENG-1 tracks the rest. UTF-8 is untouched.</p>`,
      is_self: true,
    },
    150_000,
  );
  // And the one that names NOTHING: no link, no quote, no full reference. It reads `!99`
  // because the thread said which project three messages ago, which is the rule
  // `threadProjects` exists for.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: `<p>Thanks — I will look at !99 tomorrow.</p>`,
      is_self: false,
    },
    165_000,
  );
  // A message that is ONLY a link (as Teams autolinks a pasted URL — the anchor
  // text is the URL itself). It should render as just the integration card, with
  // no message bubble around it.
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content:
        `<a href="https://gitlab.com/acme/webapp/-/merge_requests/99">` +
        `https://gitlab.com/acme/webapp/-/merge_requests/99</a>`,
      is_self: true,
    },
    180_000,
  );
  // The same shape again, at the length real merge requests reach (see
  // LONG_GITLAB_PATH): the card has to fit a phone, so every line of it must be
  // free to shrink.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<a href="https://gitlab.com/${LONG_GITLAB_PATH}/-/merge_requests/6">` +
        `https://gitlab.com/${LONG_GITLAB_PATH}/-/merge_requests/6</a>`,
      is_self: false,
    },
    240_000,
  );

  const conv: Conversation = {
    id: convId,
    name: "GitLab Links",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_ghost_read: false,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
  };
  const cs: ConvState = { conv, messages, participants: [other] };
  recomputeSummary(cs);
  store.set(convId, cs);
  order.push(convId);
}

/** A conversation of Linear links — one per resource kind, plus a bare URL — so the
 *  preview cards and the "link-only message" layout can be seen and asserted on.
 *  Mirrors seedGitLabSamples so the two providers are exercised the same way. */
function seedLinearSamples(): void {
  const convId = "19:linear-links-demo@thread.v2";
  const other = PEOPLE[2]!;
  // Dated in the past so it never sorts to the top of the sidebar (other specs
  // assume index 0 has a full backlog); tests reach it by name.
  const base = Date.now() - 19 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);

  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      // The link on its own line, which is how it usually arrives: the card
      // replaces the anchor, so a sentence built around one reads with a hole in
      // it. The bubble still carries text, so this exercises the card-with-text
      // layout rather than the link-only one.
      content:
        `<p>This one is blocking the release — can you take a look?</p>` +
        `<p><a href="https://linear.app/acme/issue/ENG-1/show-linear-links-as-cards">ENG-1</a></p>`,
      is_self: false,
    },
    0,
  );
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content:
        `<p>On it. It sits under the Chat integrations project:</p>` +
        `<p><a href="https://linear.app/acme/project/chat-integrations-a05573177921">Chat integrations</a></p>`,
      is_self: true,
    },
    60_000,
  );
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<p>The design is written up here:</p>` +
        `<p><a href="https://linear.app/acme/document/link-previews-ebc85c4d4d74">system design</a></p>`,
      is_self: false,
    },
    120_000,
  );
  // A message that is ONLY a link (as Teams autolinks a pasted URL — the anchor
  // text is the URL itself). It should render as just the integration card, with
  // no message bubble around it.
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content:
        `<a href="https://linear.app/acme/issue/ENG-3/freeze-actions-on-an-archived-trace">` +
        `https://linear.app/acme/issue/ENG-3/freeze-actions-on-an-archived-trace</a>`,
      is_self: true,
    },
    180_000,
  );
  // The same shape at the length a real workspace reaches (see LONG_LINEAR_ISSUE):
  // this card shares its frame with GitLab's, so it has to fit a phone the same way.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<a href="https://linear.app/acme/issue/${LONG_LINEAR_ISSUE}/freeze-every-action-on-an-archived-trace">` +
        `https://linear.app/acme/issue/${LONG_LINEAR_ISSUE}/freeze-every-action-on-an-archived-trace</a>`,
      is_self: false,
    },
    240_000,
  );

  const conv: Conversation = {
    id: convId,
    name: "Linear Links",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_ghost_read: false,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
  };
  const cs: ConvState = { conv, messages, participants: [other] };
  recomputeSummary(cs);
  store.set(convId, cs);
  order.push(convId);
}

/** Push helper shared by the fixture seeds below: assigns ids/seq/compose_time so a
 *  seed only states what a message IS. */
function pusher(convId: string, base: number, messages: ChatMessage[]) {
  let seq = 0;
  return (
    msg: Omit<ChatMessage, "id" | "conversation_id" | "seq" | "compose_time">,
    offsetMs: number,
  ): void => {
    seq += 1;
    messages.push({
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: base + offsetMs,
      ...msg,
    });
  };
}

/** Register a fixture conversation from an already-built message list. Dated in the past by
 *  its caller so it never sorts to the top of the sidebar; specs reach it by name through
 *  the command palette.
 *
 *  And it STAYS down there, because its sidebar time is frozen at what the seed computed
 *  (`frozenSidebarTime`). One mock process serves the whole run and the sidebar sorts by
 *  recency, so a spec that SENDS into its own fixture would otherwise make that fixture
 *  conversation number 0 for every spec that follows — and ~90 places open
 *  `openConversationAt(page, 0)` meaning "a chat I can send into". `custom-emoji.spec.ts`
 *  sends six messages into its thread and did exactly that, which turned reactions.spec.ts
 *  red. Freezing it here rather than cleaning up afterwards is what makes the promise above
 *  hold for what a spec does as well as for what the seed wrote: there is no discipline for
 *  the next feature fixture to remember. */
function addFixtureConversation(convId: string, name: string, messages: ChatMessage[]): void {
  const conv: Conversation = {
    id: convId,
    name,
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_ghost_read: false,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
  };
  const cs: ConvState = { conv, messages, participants: [PEOPLE[0]!] };
  // The seed's own date first, then the freeze — in that order, or the row would keep the
  // zero above and a sidebar built for review would show 1970 under every fixture.
  recomputeSummary(cs);
  frozenSidebarTime.add(convId);
  store.set(convId, cs);
  order.push(convId);
}

/** Register an "App Cards" conversation made of the adaptive/connector cards apps
 *  and bots post — what the GitHub / Figma / Sentry / n-Alerts channels consist of.
 *  The backend decodes these out of a `SWIFT.1` body into a `kind: "card"`
 *  attachment (see src/teams_cards.rs); this exercises every part of one: title,
 *  multi-block text, facts, a link action, and a NON-link action (a poll vote),
 *  which must never look clickable. */
function seedAppCards(): void {
  const convId = "19:app-cards-demo@thread.v2";
  const base = Date.now() - 21 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);

  // A monitoring alert (connector card): title, text, facts, one link action.
  push(
    {
      sender: "n-Alerts",
      content: "",
      attachments: [
        {
          name: "Filebeat error(s)",
          content_type: "application/vnd.microsoft.teams.card.o365connector",
          url: "",
          kind: "card",
          card: {
            title: "Filebeat error(s)",
            text: "3 fatal log lines in the last hour.\nCluster: eu-central-1",
            facts: [
              { title: "level", value: "error" },
              { title: "service", value: "ingest-worker" },
              { title: "count", value: "3" },
            ],
            actions: [{ title: "View in Kibana", url: "https://kibana.example.com/app/discover" }],
          },
        },
      ],
      is_self: false,
    },
    0,
  );
  // A poll (adaptive card): its only action is a vote, which is NOT a link — no
  // URL to open, and voting would post as the user.
  push(
    {
      sender: PEOPLE[1]!.name,
      sender_mri: PEOPLE[1]!.mri,
      content: "",
      attachments: [
        {
          name: `${PEOPLE[1]!.name} sent a poll`,
          content_type: "application/vnd.microsoft.card.adaptive",
          url: "",
          kind: "card",
          card: {
            title: `${PEOPLE[1]!.name} sent a poll`,
            text: "Poll\nNames are recorded; results shared\nLaser game availability",
            facts: [],
            actions: [{ title: "Submit vote", url: "" }],
          },
        },
      ],
      is_self: false,
    },
    60_000,
  );
  // A card alongside real text: the bubble keeps its chrome and the card sits in it.
  push(
    {
      sender: PEOPLE[0]!.name,
      sender_mri: PEOPLE[0]!.mri,
      content: "<p>This one needs a look:</p>",
      attachments: [
        {
          name: "Sentry",
          content_type: "application/vnd.microsoft.card.adaptive",
          url: "",
          kind: "card",
          card: {
            title: "New issue: TypeError in checkout",
            text: "internal · production",
            facts: [{ title: "events", value: "12" }],
            actions: [{ title: "Open in Sentry", url: "https://sentry.io/issues/1" }],
          },
        },
      ],
      is_self: false,
    },
    120_000,
  );

  // A monitoring alert relayed by the Workflows bot — the card the whole markdown
  // path exists for. It has NO title of its own (Teams shows its first block as the
  // headline), one block per alert holding bold labels and two short links over
  // URLs long enough to fill the bubble, and a footer block. Printed verbatim it is
  // a wall of asterisks and query strings; see `parseCardMarkdown`.
  const grafana = "https://grafana.example.com";
  const logs = `${grafana}/explore?left=%7B%22datasource%22%3A%22loki%22%2C%22queries%22%3A%5B%7B%22expr%22%3A%22%7Bnamespace%3D%5C%22metabase%5C%22%7D%22%7D%5D%7D`;
  const silence = `${grafana}/alerting/silence/new?alertmanager=grafana&matcher=__alert_rule_uid__%3Dcfto40tofrhfka&matcher=severity%3Dcritical`;
  push(
    {
      sender: "Workflows",
      content: "",
      attachments: [
        {
          name: "Card",
          content_type: "application/vnd.microsoft.card.adaptive",
          url: "",
          kind: "card",
          card: {
            title: "",
            text: [
              "✅ RESOLVED · ContainerRestartStorm · release-us",
              "**critical** — metabase in metabase-58b9cd89d-f2vz8 (release-us) restarted 12 times in the last hour.",
              "**Debug:** kubectl -n metabase describe pod metabase-58b9cd89d-f2vz8",
              `[🪵 Logs](${logs}) · [🔕 Silence](${silence})`,
              "**critical** — trace-api in trace-api-68b956c4b6-4tbzc (release-us) restarted 11 times in the last hour.",
              `[🪵 Logs](${logs}) · [🔕 Silence](${silence})`,
              "Lucas Silva used a Workflow template to send this card.",
            ].join("\n"),
            facts: [],
            actions: [{ title: "View URL", url: `${grafana}/alerting/list` }],
          },
        },
      ],
      is_self: false,
    },
    150_000,
  );

  // A link unfurl: the app that produced the preview is named (and iconed) beside
  // the card, and the body keeps the link the unfurl is about. The `InputExtension`
  // span Teams leaves in the body renders as nothing now that the real card arrived
  // (see `cardShownSeparately` in RichContent).
  push(
    {
      sender: PEOPLE[2]!.name,
      sender_mri: PEOPLE[2]!.mri,
      content:
        '<p><a href="https://github.com/acme/webapp">https://github.com/acme/webapp</a>' +
        '<span itemscope="" itemtype="http://schema.skype.com/InputExtension" itemid="c1"></span></p>',
      attachments: [
        {
          name: "acme/webapp",
          content_type: "application/vnd.microsoft.card.adaptive",
          url: "",
          kind: "card",
          card: {
            title: "acme/webapp",
            text: "Repository | acme/webapp\nRust\n•\n12 Stars",
            facts: [],
            actions: [{ title: "View Repository", url: "https://github.com/acme/webapp" }],
            app_name: "GitHub Notifications",
            app_icon: "",
          },
        },
      ],
      is_self: false,
    },
    180_000,
  );

  addFixtureConversation(convId, "App Cards", messages);
}

/** Register a "Thread Activity" conversation whose messages are system events rather
 *  than chat: the membership and pin frames Teams posts into a thread, plus a
 *  scheduled meeting and its cancellation. Teams sends `friendlyname` EMPTY on nearly
 *  all membership frames, so one fixture carries names and the others carry only
 *  MRIs, which is what makes the UI resolve the name from the MRI instead of saying
 *  "Someone". */
function seedThreadActivity(): void {
  const convId = "19:thread-activity-demo@thread.v2";
  const base = Date.now() - 22 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);
  const [alice, bob, carol] = PEOPLE;

  push(
    {
      sender: alice!.name,
      sender_mri: alice!.mri,
      content: "<p>Adding a couple of people to this thread.</p>",
      is_self: false,
    },
    0,
  );
  // One member added, named by Teams.
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "thread_activity",
        event: "member_added",
        time_ms: base + 60_000,
        actor_mri: alice!.mri,
        members: [bob!.name],
        member_mris: [bob!.mri],
      },
    },
    60_000,
  );
  // Two members added with NO names — only MRIs, the common real-world shape.
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "thread_activity",
        event: "member_added",
        time_ms: base + 120_000,
        actor_mri: alice!.mri,
        members: ["", ""],
        member_mris: [carol!.mri, PEOPLE[3]!.mri],
      },
    },
    120_000,
  );
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "thread_activity",
        event: "pinned",
        time_ms: base + 180_000,
        actor_mri: bob!.mri,
        members: [],
        member_mris: [],
      },
    },
    180_000,
  );
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "thread_activity",
        event: "unpinned",
        time_ms: base + 240_000,
        actor_mri: bob!.mri,
        members: [],
        member_mris: [],
      },
    },
    240_000,
  );

  // A scheduled meeting and its cancellation. Teams posts these as ordinary-looking
  // messages whose localised body ("Scheduled a meeting") was attributed to a raw
  // contacts URL; the backend keys them off `properties.meeting["@type"]` instead, so
  // they arrive as their own system-event kind with the real schedule attached.
  // Rounded to the hour so the fixture reads like a real invite, not a timestamp.
  const meetingStart =
    Math.floor((base + 3 * 24 * 60 * 60_000) / (60 * 60_000)) * 60 * 60_000 + 10 * 60 * 60_000;
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "meeting",
        event: "scheduled",
        title: "Quarterly planning",
        start_ms: meetingStart,
        end_ms: meetingStart + 60 * 60_000,
        location: "Microsoft Teams Meeting",
        organizer_mri: alice!.mri,
        join_url: "https://teams.microsoft.com/l/meetup-join/quarterly-planning",
      },
    },
    300_000,
  );
  push(
    {
      sender: "",
      content: "",
      system_event: {
        kind: "meeting",
        event: "cancelled",
        title: "Quarterly planning",
        start_ms: meetingStart,
        end_ms: meetingStart + 60 * 60_000,
        location: "Microsoft Teams Meeting",
        organizer_mri: alice!.mri,
        join_url: "https://teams.microsoft.com/l/meetup-join/quarterly-planning",
      },
    },
    360_000,
  );

  addFixtureConversation(convId, "Thread Activity", messages);
}

/** Register a "Forwarded Messages" conversation: a message forwarded in with an
 *  intro line, one forwarded on its own, and an image-only forward. Teams sends a
 *  `Forward` blockquote with NO author, no MRI and no time, so the UI has nothing to
 *  attribute it to and labels the block "Forwarded" instead. */
function seedForwardedMessages(): void {
  const convId = "19:forwarded-messages-demo@thread.v2";
  const base = Date.now() - 24 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);
  const other = PEOPLE[4]!;

  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<p>ouh lala&nbsp;</p>\n` +
        `<blockquote itemtype="http://schema.skype.com/Forward">\n` +
        `<p>For clarification our current issue is they're being logged out during ` +
        `activity — as soon as they perform their next action they're signed out.</p>\n` +
        `</blockquote>`,
      is_self: false,
    },
    0,
  );
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content:
        `<blockquote itemtype="http://schema.skype.com/Forward">` +
        `<p>it has to be sia.partners&nbsp;</p>` +
        `</blockquote>`,
      is_self: true,
    },
    60_000,
  );
  // An image-only forward: the quote block holds the picture, so this is NOT the
  // frameless image-only treatment (which has no room for a "Forwarded" label).
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        `<blockquote itemtype="http://schema.skype.com/Forward">` +
        `<p><img itemtype="http://schema.skype.com/AMSImage" ` +
        `src="https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/mock-forward-1/views/imgo" ` +
        `alt="forwarded screenshot"></p>` +
        `</blockquote>`,
      is_self: false,
    },
    120_000,
  );

  addFixtureConversation(convId, "Forwarded Messages", messages);
}

/** Register a "Plain Text" conversation of `messagetype: Text` bodies — which are
 *  NOT HTML. Every fixture here renders wrong the moment something parses it as
 *  markup: the angle-bracketed parts simply disappear. The last message is the
 *  payload-less shape that used to render as a blank coloured pill. */
function seedPlainTextSamples(): void {
  const convId = "19:plain-text-demo@thread.v2";
  const base = Date.now() - 23 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);
  const other = PEOPLE[2]!;

  // The repro from the audit: a placeholder in angle brackets must survive.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      message_type: "Text",
      content: "pour moi c'est <yyyy>-<id>",
      is_self: false,
    },
    0,
  );
  // Generics, and a tag that is text rather than markup.
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      message_type: "Text",
      content: "Vec<String> works, and so does <b>not bold</b>",
      is_self: true,
    },
    60_000,
  );
  // Newlines are the only structure a plain body has — and a bare URL still links.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      message_type: "Text",
      content: "two lines:\nsecond one, see https://example.com/docs.",
      is_self: false,
    },
    120_000,
  );
  // A message with no visible payload at all: empty body, no attachment, no system
  // event, not deleted. It must not render as a blank bubble.
  push({ sender: other.name, sender_mri: other.mri, content: "", is_self: false }, 180_000);

  addFixtureConversation(convId, "Plain Text", messages);
}

/** Register a thread the "stop a run" spec drives, of its own so a reply it leaves behind
 *  cannot match another agent test's bubble. One plain message, off by default like every
 *  fixture but the sandbox — the spec opts it in and hands it back off. */
function seedStopAgentThread(): void {
  const convId = "19:stop-agent-demo@thread.v2";
  const base = Date.now() - 21 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);
  const other = PEOPLE[2]!;
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: "<p>Ask the agent something, then stop it.</p>",
      is_self: false,
    },
    0,
  );
  addFixtureConversation(convId, "Stop the Agent", messages);
}

/** Register the SANDBOX thread as a conversation of its own — the one the Rust policy
 *  opts in out of the box (`MOCK_AGENT_SANDBOX`, after `agent_policy::SANDBOX_THREAD`).
 *
 *  It exists so the composer's agent tag can be exercised in the state a fresh backend is
 *  really in: a thread that would answer, with nothing switched on by a test first. Every
 *  other conversation here is off, which is the other half of that rule. Dated in the past
 *  like the rest of the fixtures, so it never sorts to the top of the sidebar.
 *
 *  It also holds the OTHER machine's half of the feature: a colleague who runs teams-lite
 *  too, their own `@claude` and the answer their agent posted under their name. Both are
 *  drawn exactly as ours are — the prefix as that vendor's chip, the reply under the CLI's
 *  mark with the signature line stripped — and nothing here can be faked by this app's own
 *  gates, which is what makes the pair reviewable with no second tenant. */
function seedAgentSandbox(): void {
  const convId = MOCK_AGENT_SANDBOX;
  const base = Date.now() - 22 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);
  const other = PEOPLE[1]!;

  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: "<p>This thread is where we try things out.</p>",
      is_self: false,
    },
    0,
  );
  push(
    {
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: "<p>Good — the agent answers here, and nowhere else.</p>",
      is_self: true,
    },
    60_000,
  );
  // A colleague summoning THEIR agent. It ran on their machine, not on this one, so no
  // setting of ours decides whether the chip is drawn.
  const trigger = { compose_time: base + 120_000, preview: "@claude which model do you run?" };
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content: "<p>@claude which model do you run?</p>",
      is_self: false,
    },
    120_000,
  );
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        quoteBlock({ ...trigger, sender: other.name, sender_mri: other.mri }) +
        agentSignedHtml("claude", "I run **Sonnet 4.5** here.", { pending: false }),
      is_self: false,
    },
    121_000,
  );
  addFixtureConversation(convId, "Agent Sandbox", messages);
}

/** A thread of its own for CUSTOM EMOJI: a colleague's message carrying real inline emoji
 *  markup, with its own art URL.
 *
 *  Its own thread on purpose. This fixture used to be the newest message of the agent
 *  sandbox, which is a conversation three other spec files already assert on — and the emoji
 *  feature has no business changing what those see, nor what a deep link into a seeded
 *  thread has to scroll past. `custom-emoji.spec.ts` sends here too, so the six messages it
 *  posts land where nothing else looks — and, because this is a fixture, they do not move
 *  the thread in the sidebar either (see `addFixtureConversation`). */
function seedCustomEmojiThread(): void {
  const convId = "19:custom-emoji-demo@thread.v2";
  const base = Date.now() - 21 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);
  const other = PEOPLE[1]!;

  push(
    { sender: other.name, sender_mri: other.mri, content: "Shipping the emoji pack today.", is_self: false },
    0,
  );
  // The inbound half of the feature: the art travels inside the message, so it is drawn
  // from THIS `src` and never from the reader's own pack.
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        '<p>Got it <img itemtype="http://schema.skype.com/Emoji" itemid="shipit" ' +
        `alt=":shipit:" src="https://eu-api.asm.skype.com/v1/objects/0-${EMOJI_OBJECT}-inbound/views/imgo" ` +
        'width="20" height="20"> — thanks!</p>',
      is_self: false,
    },
    60_000,
  );

  addFixtureConversation(convId, "Custom Emoji", messages);
}

/** A thread where a MERGE REQUEST is being asked about — the state the two rows a message
 *  menu grows for one really live in.
 *
 *  It is opted in for the agent, which is what `agent_set_mode` leaves behind: a work
 *  thread the user turned on, rather than the sandbox. So "Review !44 with Claude" is
 *  exercised where a review is actually asked for, and the sandbox keeps its own job — the
 *  thread a fresh backend answers in with nothing switched on first.
 *
 *  Two merge requests, because they are not the same offer: !44 is OPEN, so it can be
 *  approved, and !42 is MERGED, where an approval would only earn a refusal from GitLab
 *  (the review row stays — a merged branch is still worth reading). */
function seedMergeRequestReview(): void {
  const convId = MOCK_MERGE_REQUEST_THREAD;
  const base = Date.now() - 21 * 24 * 60 * 60_000;
  const messages: ChatMessage[] = [];
  const push = pusher(convId, base, messages);
  const other = PEOPLE[1]!;

  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        "<p>Can you review " +
        '<a href="https://gitlab.com/acme/webapp/-/merge_requests/44">this merge request</a>' +
        " before the release?</p>",
      is_self: false,
    },
    0,
  );
  push(
    {
      sender: other.name,
      sender_mri: other.mri,
      content:
        "<p>The one from last week is in: " +
        '<a href="https://gitlab.com/acme/webapp/-/merge_requests/42">!42</a></p>',
      is_self: false,
    },
    60_000,
  );

  addFixtureConversation(convId, "Merge Request Review", messages);
}

// ---------------------------------------------------------------------------
// Paging (operate on ascending-by-seq arrays, mirroring the Rust store).
// ---------------------------------------------------------------------------

/** Newest page: the last PAGE_SIZE messages; has_more when older ones exist. */
function newestPage(messages: ChatMessage[]): MessagePage {
  const page = messages.slice(-PAGE_SIZE);
  return { messages: page.map(nicknamed), has_more: messages.length > page.length };
}

/** Older page: up to PAGE_SIZE messages with seq < before_seq (ascending). */
function pageBefore(messages: ChatMessage[], beforeSeq: number): MessagePage {
  const older = messages.filter((m) => m.seq < beforeSeq); // still ascending
  const page = older.slice(-PAGE_SIZE);
  return { messages: page.map(nicknamed), has_more: older.length > page.length };
}

// ---------------------------------------------------------------------------
// The name and face the USER gave somebody — the mock's half of
// `person_overrides` (src/store.rs). Microsoft Teams holds neither, so both are
// local overrides that no sync ever supplies or takes away.
//
// The Rust store resolves a nickname on the way OUT of every read, which is what
// makes one rename cover every message the person ever sent, the title of their
// 1:1, the sidebar's preview attribution and the typing line at once. The mock
// mirrors that placement rather than the storage: the fixtures keep the Teams
// name, and it is replaced at the read boundary.
// ---------------------------------------------------------------------------

type PersonOverrideEntry = {
  display_name: string;
  avatar: { content_type: string; data_base64: string } | null;
  updated_at: number;
};

const personOverrides = new Map<string, PersonOverrideEntry>();

/** The name the user chose for this person, or "" when they chose none. */
function nickname(mri: string | undefined): string {
  if (!mri) return "";
  return personOverrides.get(mri)?.display_name ?? "";
}

/** One message on its way to a page: its author renamed when the user renamed them,
 *  and the two facts only a backend can state about it.
 *
 *  `mentions_me` is one of them (see `message_json` in src/bin/server.rs): the page
 *  never learns the user's own MRI, so it cannot read the mention list for itself — and
 *  it needs the answer to apply the user's per-channel notification setting rather than
 *  chiming at every post in every channel. */
function nicknamed(m: ChatMessage): ChatMessage {
  const own = nickname(m.sender_mri);
  const mentions_me = (m.mentions ?? []).some((mention) => mention.mri === SELF_MRI);
  const reactions = m.reactions?.map(reactionWithPeople);
  return { ...m, sender: own || m.sender, mentions_me, reactions };
}

/** One reaction on its way to a page: the people behind it named, the way the Rust
 *  `reactions_value` names them off each reactor's MRI. A reaction with no stored MRIs
 *  keeps its count and names nobody, which is what the page counts instead. */
function reactionWithPeople(r: Reaction): Reaction {
  const users = (r.mris ?? []).map((mri) => ({
    name: nickname(mri) || teamsNameFor(mri),
    mine: mri === SELF_MRI,
  }));
  return { key: r.key, count: r.count, mine: r.mine, users };
}

/** Drop an override entry that no longer overrides anything, so "no override" is
 *  always the absence of an entry — same rule as the Rust store's row. */
function pruneEmptyOverride(mri: string): void {
  const entry = personOverrides.get(mri);
  if (entry && !entry.display_name && !entry.avatar) personOverrides.delete(mri);
}

/** One conversation with the names it states resolved through the user's nicknames:
 *  a 1:1's title (which IS a person) and the sidebar's preview attribution. A group's
 *  title is the group's, so renaming a member never retitles it — the same rule the
 *  Rust query encodes by testing the kind. */
function nicknamedConversation(c: Conversation): Conversation {
  const titled = c.kind === "one_on_one" ? nickname(c.avatar_mri) : "";
  const attributed = nickname(c.last_message_sender_mri);
  return {
    ...c,
    name: titled || c.name,
    last_message_sender: attributed || c.last_message_sender,
  };
}

/** What TEAMS calls this person — never overridden, so a surface offering a rename
 *  can always say who it belongs to. The Rust store reads it off the newest message
 *  they sent; the mock reads its own roster, which is the same fact. */
function teamsNameFor(mri: string): string {
  return PEOPLE.find((p) => p.mri === mri)?.name ?? "";
}

/** What the `person_override` method answers: the user's choice, plus what Teams
 *  itself calls this person so a surface can always show both. */
function personOverrideView(mri: string): {
  mri: string;
  display_name: string;
  has_avatar: boolean;
  teams_name: string;
  updated_at: number;
} {
  const entry = personOverrides.get(mri);
  return {
    mri,
    display_name: entry?.display_name ?? "",
    has_avatar: !!entry?.avatar,
    teams_name: teamsNameFor(mri),
    updated_at: entry?.updated_at ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Custom emoji — the mock pack, seeded with three emoji so Task 6's render
// path is exercised with nothing leaving the machine.
// ---------------------------------------------------------------------------

type CustomEmojiEntry = {
  name: string;
  alias_of: string;
  content_type: string;
  width: number;
  height: number;
  source: string;
  added_ms: number;
  data_base64: string;
};

const customEmojiPack = new Map<string, CustomEmojiEntry>();

/** The AMS object id an emoji's art hangs off, in the mock's own hosted-content URLs. Its
 *  own word so `mockMedia` can tell a glyph from a picture and answer with glyph-shaped
 *  bytes — a message's emoji is drawn from ITS OWN src, never from the pack, so those bytes
 *  are the only ones a bubble ever shows. */
const EMOJI_OBJECT = "mock-emoji";

/** The mock's AMS object URL for one emoji's art. ONE spelling, because a message's
 *  inline `src` and a custom reaction's key have to name the same object — that is what
 *  makes the chip and the glyph in the words above it the same picture. */
function emojiObjectUrl(name: string): string {
  return `https://eu-api.asm.skype.com/v1/objects/0-${EMOJI_OBJECT}-${name}/views/imgo`;
}

function seedCustomEmoji(): void {
  const now = Date.now();
  customEmojiPack.set("shipit", {
    name: "shipit",
    alias_of: "",
    content_type: "image/png",
    width: 20,
    height: 20,
    source: "mock",
    added_ms: now - 1000,
    data_base64: solidPng(20, 20, hslToRgb(180, 0.72, 0.52)).toString("base64"),
  });
  customEmojiPack.set("partyparrot", {
    name: "partyparrot",
    alias_of: "",
    content_type: "image/gif",
    width: 20,
    height: 20,
    source: "mock",
    added_ms: now - 500,
    data_base64: solidGif(20, hslToRgb(270, 0.72, 0.52)),
  });
  customEmojiPack.set("ship", {
    name: "ship",
    alias_of: "shipit",
    content_type: "",
    width: 0,
    height: 0,
    source: "mock",
    added_ms: now,
    data_base64: "",
  });
}

/**
 * Encode a one-colour GIF, so the `image/gif` half of the pack is a REAL GIF.
 *
 * It has to decode: the page turns these bytes into a Blob of the type the pack DECLARES,
 * so art whose bytes disagree with its type draws nowhere — and every emoji surface then
 * captures as a broken image while every test that only counts elements still passes.
 *
 * Written out by hand beside {@link solidPng}, and for the same reason: this file takes no
 * dependency beyond the Bun runtime. The LZW is deliberately the dumbest stream that is
 * still valid — a CLEAR before every pixel, which holds the dictionary at its initial size
 * so no code ever has to widen. Wasteful, and a few hundred bytes for a glyph.
 */
function solidGif(size: number, rgb: [number, number, number]): string {
  const CLEAR = 4;
  const END = 5;
  const codes: number[] = [];
  for (let i = 0; i < size * size; i++) codes.push(CLEAR, 1);
  codes.push(END);
  // 3-bit codes, packed least-significant bit first, as GIF wants them.
  const bytes: number[] = [];
  let acc = 0;
  let filled = 0;
  for (const code of codes) {
    acc |= code << filled;
    filled += 3;
    while (filled >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      filled -= 8;
    }
  }
  if (filled > 0) bytes.push(acc & 0xff);
  // The image data travels in sub-blocks of at most 255 bytes, each led by its length.
  const blocks: number[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    size & 0xff, size >> 8, size & 0xff, size >> 8, // logical screen, size × size
    0x80, 0x00, 0x00, // a global colour table of two entries
    0x00, 0x00, 0x00, // colour 0, unused
    rgb[0], rgb[1], rgb[2], // colour 1, every pixel
    0x2c, 0x00, 0x00, 0x00, 0x00, // image descriptor, at the origin
    size & 0xff, size >> 8, size & 0xff, size >> 8,
    0x00, // no local colour table, not interlaced
    0x02, // LZW minimum code size
    ...blocks,
    0x00, // end of the image data
    0x3b, // trailer
  ]).toString("base64");
}

// ---------------------------------------------------------------------------
// Mock hosted content — stands in for the Rust media proxy (`fetch_media`).
// ---------------------------------------------------------------------------

/** A stable non-negative hash of a string, for deriving a deterministic color. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Return deterministic bytes for a requested media URL, mirroring the Rust
 *  backend's `fetch_media` result shape `{ content_type, data_base64 }`. We
 *  synthesize a labeled colored SVG so every hosted-content URL renders as a
 *  distinct, visible image in the UI without any real tenant. */
function mockMedia(url: string): { content_type: string; data_base64: string } {
  if (url.endsWith("/views/avatar_fullsize")) return mockGroupPicture(url);
  if (url.includes("mock-img-small")) return mockSmallPng(url);
  if (url.includes("mock-inline-")) return mockInlinePicture(url);
  // A custom emoji travels as hosted content like any inline image, but it is a GLYPH:
  // the 320×200 picture below would draw it as a flat bar sized to the text, which says
  // nothing about the size a capture is meant to show. Square, and its own hue per code.
  if (url.includes(EMOJI_OBJECT)) {
    // The object the URL names, when the pack holds it: an emoji uploaded FROM the pack
    // (a send's inline art, a custom reaction's key) really is those bytes, so a chip and
    // the glyph above it must be the same picture. Anything else — a colleague's own
    // `:shipit:`, which is exactly what the inbound fixture carries — is its own art, and
    // gets its own hue.
    const object = url.split(`0-${EMOJI_OBJECT}-`)[1]?.split("/")[0] ?? "";
    const asked = customEmojiPack.get(object);
    const entry = asked?.alias_of ? customEmojiPack.get(asked.alias_of) : asked;
    if (entry?.data_base64) {
      return { content_type: entry.content_type, data_base64: entry.data_base64 };
    }
    return {
      content_type: "image/png",
      data_base64: solidPng(20, 20, hslToRgb(hashString(url) % 360, 0.72, 0.52)).toString(
        "base64",
      ),
    };
  }
  // The hue and the label name the OBJECT rather than the view, so one picture is one colour
  // and one word whichever resolution the page asked for (see `mockInlinePicture`).
  const object = url.replace(/\/views\/[^/]*$/, "");
  const hue = hashString(object) % 360;
  const label = (object.split("/").filter(Boolean).pop() ?? "media").slice(0, 24);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">` +
    `<rect width="320" height="200" rx="12" fill="hsl(${hue} 65% 52%)"/>` +
    `<text x="160" y="104" font-family="system-ui,sans-serif" font-size="16" fill="white" ` +
    `text-anchor="middle" dominant-baseline="middle">${escapeHtml(label)}</text></svg>`;
  return {
    content_type: "image/svg+xml",
    data_base64: Buffer.from(svg, "utf8").toString("base64"),
  };
}

/** The view an AMS object serves the whole picture from, spelled here as the backend spells
 *  it (`protocol.ts`'s `FULL_MEDIA_VIEW`) — this mock stands for that backend, so it holds
 *  its own copy rather than importing the app's. */
const MOCK_FULL_VIEW = "imgpsh_fullsize_anim";

/** The object whose full view this mock REFUSES, so the fallback to the reduced view the
 *  message points at is a state a spec can reach: a picture must never be lost to an object
 *  store that publishes one view and not the other. It is the SECOND inline fixture rather
 *  than a message of its own — one mock process serves the whole run, and a picture added to
 *  the seeded history moves every row a later spec counts on. */
const MOCK_NO_FULL_VIEW = "mock-inline-2";

/**
 * An inline picture, in the two resolutions the real object store really serves.
 *
 * Measured on the tenant by `examples/inline_image_recon.rs`: the `views/imgo` a Teams client
 * writes on an `<img>` is a JPEG capped at 800 px, while `views/imgpsh_fullsize_anim` carries
 * the pixels the sender uploaded — up to 2.8x more of them. A mock that answered one picture
 * for every view could not show whether the app asks for the right one, so these two differ in
 * RESOLUTION, which is a fact a page can be measured against (`naturalWidth`).
 */
function mockInlinePicture(url: string): { content_type: string; data_base64: string } {
  const hue = hashString(url.replace(/\/views\/.*$/, "")) % 360;
  const whole = url.endsWith(`/views/${MOCK_FULL_VIEW}`);
  if (whole && url.includes(MOCK_NO_FULL_VIEW)) {
    throw new Error("hosted-content media -> 404 Not Found");
  }
  const [width, height] = whole ? [640, 400] : [160, 100];
  return {
    content_type: "image/png",
    data_base64: solidPng(width, height, hslToRgb(hue, 0.65, 0.52)).toString("base64"),
  };
}

/** A small RASTER picture (64×48 px), for the one thing the SVG above cannot
 *  express: a fixed resolution. An SVG has none, so it says nothing about whether
 *  the lightbox grows a picture that is smaller than the viewport. */
function mockSmallPng(url: string): { content_type: string; data_base64: string } {
  const hue = hashString(url) % 360;
  return {
    content_type: "image/png",
    data_base64: solidPng(64, 48, hslToRgb(hue, 0.65, 0.52)).toString("base64"),
  };
}

/** HSL (h in degrees, s and l in 0..1) as 8-bit RGB, so the raster picture is
 *  tinted from the same per-URL hue as every other mock image. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const sector = ((h % 360) + 360) % 360 / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const base = l - chroma / 2;
  const byte = (v: number) => Math.round((v + base) * 255);
  return [byte(r), byte(g), byte(b)];
}

/**
 * What custom emoji art really is, decided the way the backend decides it: the type
 * sniffed from the BYTES (never from what a client claimed), the dimensions read out of
 * them, and both caps checked — or it throws the sentence the backend refuses it with.
 * The mirror of `custom_emoji::measure_art`, over `sender_icon::image_kind`.
 *
 * ONE copy, because both ways into the pack go through it. `custom_emoji_add` and
 * `custom_emoji_import` each held a verbatim copy of this and they had already drifted:
 * the import branch refused with "not a valid image type" and "file too large", sentences
 * the backend never says — so a spec reading the mock's refusal was reading words that
 * exist nowhere else, which is a mock hiding the bug instead of failing a test.
 *
 * The one thing it does NOT mirror is JPEG and WebP dimensions: reading those means a real
 * parser, and no fixture here needs one. They are answered as 20x20, which is inside the
 * cap — so a mock never refuses a picture the backend would accept.
 */
function measureMockEmojiArt(bytes: Buffer): {
  contentType: string;
  width: number;
  height: number;
} {
  // Magic-byte sniff, the table `sender_icon::image_kind` holds. The GIF check wants
  // 'GIF8' (four bytes) and not just 'GIF', because the backend's pattern does.
  let contentType = "";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    contentType = "image/png";
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    contentType = "image/jpeg";
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    contentType = "image/gif";
  } else if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    contentType = "image/webp";
  }
  if (!contentType) {
    throw new Error("an emoji must be a PNG, JPEG, GIF or WebP image");
  }
  if (bytes.length > 128 * 1024) {
    throw new Error("an emoji must be 128 KB or smaller");
  }

  let width = 20;
  let height = 20;
  if (contentType === "image/png" && bytes.length >= 24) {
    const ihdr = bytes.subarray(12, 16);
    if (ihdr[0] === 0x49 && ihdr[1] === 0x48 && ihdr[2] === 0x44 && ihdr[3] === 0x52) {
      width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
      height = (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!;
    }
  } else if (contentType === "image/gif" && bytes.length >= 10) {
    width = bytes[6]! | (bytes[7]! << 8);
    height = bytes[8]! | (bytes[9]! << 8);
  }

  if (width > 512 || height > 512) {
    throw new Error("an emoji must be 512 pixels or smaller on a side");
  }
  return { contentType, width: width || 20, height: height || 20 };
}

/** Encode a one-colour truecolour PNG. Written out by hand (header, one deflated
 *  IDAT of unfiltered scanlines, IEND, each chunk CRC'd) because this file takes
 *  no dependency beyond the Bun runtime, and `node:zlib` is part of it. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits per sample
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One length-type-body-CRC PNG chunk. */
function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A group chat's own picture: a square emblem on a per-URL gradient, so it reads
 *  as a picture the members chose rather than as a person's photo (the silhouette
 *  in `mockAvatar`) or a shared image (the labeled landscape card above). Teams
 *  serves these as `…/views/avatar_fullsize` objects, which is how `mockMedia`
 *  recognizes one. */
function mockGroupPicture(url: string): { content_type: string; data_base64: string } {
  const hue = hashString(url) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="hsl(${hue} 78% 58%)"/>` +
    `<stop offset="100%" stop-color="hsl(${(hue + 70) % 360} 72% 40%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="192" height="192" fill="url(#g)"/>` +
    `<circle cx="74" cy="82" r="30" fill="rgba(255,255,255,0.9)"/>` +
    `<circle cx="124" cy="112" r="38" fill="rgba(255,255,255,0.55)"/>` +
    `</svg>`;
  return {
    content_type: "image/svg+xml",
    data_base64: Buffer.from(svg, "utf8").toString("base64"),
  };
}

/** Synthesize a deterministic "profile photo" for an avatar subject, mirroring
 *  the Rust backend's `fetch_avatar` result shape `{ found, content_type,
 *  data_base64 }`. We draw a head-and-shoulders silhouette on a per-id gradient
 *  so a real photo is visibly distinct from the flat tinted initials. Roughly
 *  one subject in three deterministically has *no* photo (`found: false`), so
 *  the UI's initials fallback is exercised too — as on a real tenant where many
 *  people and teams never set a picture. */
function mockAvatar(
  kind: "user" | "team",
  id: string,
): { found: true; content_type: string; data_base64: string } | { found: false } {
  // A face the USER gave this person wins, exactly as in the Rust backend: the
  // override answers before anything the tenant would have. This is what makes a
  // custom avatar visible everywhere at once in the mock, since every render site
  // already asks this method.
  const own = personOverrides.get(id);
  if (kind === "user" && own?.avatar) {
    return { found: true, content_type: own.avatar.content_type, data_base64: own.avatar.data_base64 };
  }
  if (hashString(`${kind}:${id}`) % 3 === 0) return { found: false };
  const hue = hashString(id) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">` +
    `<defs><radialGradient id="g" cx="35%" cy="28%" r="90%">` +
    `<stop offset="0%" stop-color="hsl(${hue} 80% 72%)"/>` +
    `<stop offset="100%" stop-color="hsl(${(hue + 40) % 360} 68% 42%)"/>` +
    `</radialGradient></defs>` +
    `<rect width="192" height="192" fill="url(#g)"/>` +
    `<circle cx="96" cy="76" r="34" fill="rgba(255,255,255,0.92)"/>` +
    `<rect x="38" y="120" width="116" height="88" rx="44" fill="rgba(255,255,255,0.92)"/>` +
    `</svg>`;
  return {
    found: true,
    content_type: "image/svg+xml",
    data_base64: Buffer.from(svg, "utf8").toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// People — stand-in for the Rust `profile` (fetchShortProfile) and `presence`
// (unified presence service) methods that back the person card.
// ---------------------------------------------------------------------------

type MockProfile = {
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
  office_location: string;
  tenant_name: string;
  user_type: string;
};

type MockPresence = {
  mri: string;
  availability: string;
  activity: string;
  last_active_ms: number;
  out_of_office: boolean;
  out_of_office_note: string;
  note: string;
};

const JOB_TITLES = [
  "Senior Consultant",
  "Staff Engineer",
  "Product Manager",
  "Data Scientist",
  "Engineering Manager",
];
const DEPARTMENTS = ["Platform (Engineering)", "Data & AI", "Design", "Delivery", "Security"];
const OFFICES = ["Paris (FIM)", "London", "Montreal (NA)", "Berlin", "Remote"];

/** A person's directory card, derived deterministically from their MRI so a given
 *  identity always answers the same. One MRI in seven is deliberately unknown to
 *  the directory (`found: false`), exercising the card's name-only fallback the way
 *  a service account or a removed guest does on a real tenant. */
function mockProfile(mri: string): MockProfile | { found: false } {
  const person = PEOPLE.find((p) => p.mri === mri);
  const name = person?.name ?? (mri === SELF_MRI ? SELF_NAME : "");
  const h = hashString(mri);
  if (!name || h % 7 === 0) return { found: false };
  const [given = name, surname = ""] = name.split(" ");
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;
  return {
    found: true,
    mri,
    object_id: mri.replace(/^8:orgid:/, ""),
    display_name: name,
    given_name: given,
    surname,
    email,
    user_principal_name: email,
    job_title: JOB_TITLES[h % JOB_TITLES.length]!,
    department: DEPARTMENTS[(h >>> 3) % DEPARTMENTS.length]!,
    company_name: "Example Group",
    office_location: OFFICES[(h >>> 5) % OFFICES.length]!,
    tenant_name: "EXAMPLE",
    user_type: "Member",
  };
}

/** The second-level labels that belong to a public suffix (mirrors
 *  `sender_icon::registrable_domain` in the backend and `registrableMailDomain` in the
 *  app — three copies of one notion, and the backend's is the one that decides what is
 *  actually fetched). */
const MOCK_SUFFIX_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

/** The registrable part of a domain: "updates.tracker.dev" → "tracker.dev". */
function registrableDomain(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  let index = labels.length - 2;
  if (MOCK_SUFFIX_LABELS.has(labels[index]!)) index -= 1;
  return labels.slice(index).join(".");
}

/** The icon of one organisation that mails the user — the mock half of `sender_icon`,
 *  and it reaches no domain: it draws a square mark with the organisation's own letters
 *  on a per-domain colour, which is what a favicon looks like once it is in the avatar.
 *
 *  A quarter of domains deterministically serve NONE (`found: false`), because that is
 *  the real shape: measured over the domains that write to this mailbox, 7 in 18 answer
 *  nothing usable, and the tinted initials have to stand there. `tracker.dev` is pinned
 *  to serving one, so the two Tracker fixtures exercise the icon rather than the dice. */
function mockSenderIcon(
  domain: string,
): { found: true; content_type: string; data_base64: string } | { found: false } {
  if (domain !== "tracker.dev" && hashString(`icon:${domain}`) % 4 === 0) {
    return { found: false };
  }
  const hue = hashString(domain) % 360;
  const letters = (domain.split(".")[0] ?? domain).slice(0, 2).toUpperCase();
  // Two real shapes, because the app draws the icon with nothing behind it: most
  // favicons are a flat square that fills the frame, and plenty are a bare glyph on
  // TRANSPARENT pixels — which is the case that needs the avatar's own tint as a
  // backdrop rather than the monogram underneath (see `AvatarPicture`).
  // `buildbot.dev` is pinned to the transparent shape, exactly as `tracker.dev` is
  // pinned to serving an icon at all: both shapes then stand in the list on every run
  // instead of depending on the dice.
  const transparent = domain === "buildbot.dev" || hashString(`shape:${domain}`) % 3 === 1;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
    (transparent ? "" : `<rect width="128" height="128" fill="hsl(${hue} 72% 46%)"/>`) +
    `<text x="64" y="82" text-anchor="middle" font-family="Arial, sans-serif" ` +
    `font-size="58" font-weight="bold" fill="${transparent ? `hsl(${hue} 72% 38%)` : "#ffffff"}">` +
    `${letters}</text>` +
    `</svg>`;
  return {
    found: true,
    content_type: "image/svg+xml",
    data_base64: Buffer.from(svg, "utf8").toString("base64"),
  };
}

/** The person behind one MAIL ADDRESS, or `null` when the directory knows nobody by
 *  it — the mock half of `people_by_address`. A colleague's address resolves (which
 *  is what puts a real face on a mail), while a shared mailbox like
 *  `guild@example.com` and every address off the tenant's domain
 *  (`digest@platformweekly.io`, `notifications@tracker.dev`) resolve to nothing,
 *  exactly as an external sender, a distribution list and a shared mailbox do on a
 *  real tenant. The mail surface therefore shows both states side by side in the
 *  mock. */
function mockAddressPerson(address: string): (MockProfile & { address: string }) | null {
  const [local = "", domain = ""] = address.toLowerCase().split("@");
  if (!local || domain !== "example.com") return null;
  // `personAddress` builds "first.last@example.com" from a name whose MRI is
  // "8:orgid:first-last", so the two are one substitution apart.
  const mri = local === "you" ? SELF_MRI : `8:orgid:${local.replace(/\./g, "-")}`;
  const profile = mockProfile(mri);
  if (!profile.found) return null;
  return { ...profile, address };
}

/** The presence states the mock cycles through, one per MRI, so every badge tone
 *  and label is reachable in dev: reachable, in a meeting, away, offline (with a
 *  "last seen"), out of office (with an auto-reply note), and unknown. */
const MOCK_PRESENCES: ReadonlyArray<Omit<MockPresence, "mri" | "last_active_ms">> = [
  { availability: "Available", activity: "Available", out_of_office: false, out_of_office_note: "", note: "" },
  { availability: "Busy", activity: "InAMeeting", out_of_office: false, out_of_office_note: "", note: "Heads down until noon" },
  { availability: "Busy", activity: "InACall", out_of_office: false, out_of_office_note: "", note: "" },
  { availability: "DoNotDisturb", activity: "Presenting", out_of_office: false, out_of_office_note: "", note: "" },
  { availability: "Away", activity: "Away", out_of_office: false, out_of_office_note: "", note: "" },
  { availability: "Offline", activity: "Offline", out_of_office: false, out_of_office_note: "", note: "" },
  { availability: "Offline", activity: "Offline", out_of_office: true, out_of_office_note: "On leave, back Monday.", note: "" },
  { availability: "PresenceUnknown", activity: "PresenceUnknown", out_of_office: false, out_of_office_note: "", note: "" },
];

/** One person's presence, derived deterministically from their MRI. `last_active_ms`
 *  is only meaningful for someone who isn't reachable, which is exactly when the
 *  card shows "Last seen …". */
function mockPresence(mri: string): MockPresence {
  const h = hashString(`presence:${mri}`);
  const base = MOCK_PRESENCES[h % MOCK_PRESENCES.length]!;
  const away = base.availability === "Offline" || base.availability === "Away";
  return {
    mri,
    ...base,
    last_active_ms: away ? Date.now() - ((h % 20) + 3) * 60_000 : 0,
  };
}

// ---------------------------------------------------------------------------
// App settings + link enrichment — stand-in for the Rust store settings table
// (`get_settings`/`set_settings`) and the `link_preview` dispatch over the
// `gitlab` and `linear` modules (`enrich_link`). Deterministic and
// self-contained: no real GitLab or Linear workspace is ever contacted.
// ---------------------------------------------------------------------------

/** In-memory settings (the real backend persists these in SQLite). A token is
 *  write-only from the UI's side, so only its presence is ever reported back. */
const mockSettings = {
  gitlab_host: "gitlab.com",
  gitlab_token: "",
  // Pre-configured, unlike GitLab's: Linear has no anonymous read, so without a key
  // the seeded Linear conversation would show four bare URLs and no cards. Any
  // non-empty string does — this mock never contacts Linear.
  linear_token: "lin_api_mock",
  // Off, like the real backend's default: opening a chat reads it on Teams too.
  ghost_mode: false,
  // Off, like the real backend's default. Here it is only a flag: the mock publishes
  // no presence at all, which is the whole point of driving the UI against it.
  always_available: false,
  // ON, like the real backend's default (see `sender_icons_enabled` in
  // src/bin/server.rs). Here it reaches no domain either: `mockSenderIcon` draws the
  // mark, so the whole surface is exercised with nothing leaving the machine.
  sender_icons: true,
  // ON, like the real backend's default (see `emoji_auto_import_enabled` in
  // src/bin/server.rs). Here it is only a flag: the import itself happens as a live
  // message is INGESTED, which is a backend act with no surface of its own — the policy
  // that decides it is pure Rust (`custom_emoji::take_as`) and pinned there. What this
  // mock owes the UI is the switch's own state.
  emoji_auto_import: true,
};

/** Devices that "subscribed" to push notifications, keyed by endpoint (the real
 *  backend keeps these in SQLite). In memory, so a mock restart forgets them. */
const mockPushDevices = new Map<
  string,
  { endpoint: string; label: string; created_ms: number; last_ok_ms: number; last_error: string }
>();

/** A VAPID public key of the right SHAPE (65-byte uncompressed P-256 point,
 *  base64url), so `pushManager.subscribe` accepts it in a browser driven against
 *  this mock. Fixed, and useless for anything: the mock holds no private half and
 *  never signs a push. */
const MOCK_VAPID_PUBLIC_KEY =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

/** The `push_status` result, matching the Rust one. */
function pushStatusView(): {
  supported: boolean;
  public_key: string;
  devices: {
    endpoint: string;
    label: string;
    created_ms: number;
    last_ok_ms: number;
    last_error: string;
  }[];
} {
  return {
    supported: true,
    public_key: MOCK_VAPID_PUBLIC_KEY,
    devices: [...mockPushDevices.values()],
  };
}

/** The conversation the Rust policy opts in out of the box (`agent_policy::
 *  SANDBOX_THREAD`). Named here so the mock's `agent_status` has the same one entry a
 *  fresh real backend has, and a spec can tell "on by default" from "the user
 *  switched it on". */
const MOCK_AGENT_SANDBOX = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/** The thread where a merge request is being asked about (`seedMergeRequestReview`). The
 *  user opted it in, which is what `agent_set_mode` leaves behind — so the review row can
 *  be exercised in a work thread rather than in the sandbox. */
const MOCK_MERGE_REQUEST_THREAD = "19:merge-request-review@thread.v2";

/** Which conversations answer an `@claude` message, as the mock remembers it: the sandbox,
 *  exactly as the backend's own default does, plus the merge-request thread the user turned
 *  on themselves. Every other conversation is off, which is the half that keeps a spec
 *  honest about where an agent may post. */
const mockAgentModes = new Map<string, "off" | "reply">([
  [MOCK_AGENT_SANDBOX, "reply"],
  [MOCK_MERGE_REQUEST_THREAD, "reply"],
]);

/** The groups of tools the mock offers, in the shape `agent::TOOL_GRANTS` publishes.
 *  The real catalogue lives in src/agent.rs and is the reviewed one; the mock carries a
 *  representative tool or two per group, which is what a UI needs to draw a switch and
 *  a spec needs to prove the grant travelled to the backend. */
const MOCK_AGENT_TOOL_GRANTS = [
  {
    key: "files",
    label: "Read files",
    detail: "Open, list and search the files in its workspace.",
    tools: ["Read", "Glob", "Grep"],
  },
  {
    key: "grafana",
    label: "Read Grafana",
    detail: "Dashboards, Prometheus and Loki queries, incidents. No dashboard edit.",
    tools: [
      "mcp__grafana__list_datasources",
      "mcp__grafana__query_prometheus",
      "mcp__grafana__query_loki_logs",
    ],
  },
  {
    key: "sentry",
    label: "Read Sentry",
    detail: "Projects, issues and events. No issue edit, and no Seer run.",
    tools: ["mcp__sentry__find_projects", "mcp__sentry__search_issues"],
  },
  {
    key: "linear",
    label: "Read Linear",
    detail: "Issues, projects and comments. No issue, comment or status written.",
    tools: ["mcp__linear__list_issues", "mcp__linear__get_issue"],
  },
];

/** What an agent may do here, as the mock remembers it. Starts at the read-only default
 *  the Rust `DEFAULT_TOOLS` holds, so a spec can tell the default from a grant. */
let mockAgentTools: string[] = ["Read", "Glob", "Grep"];

/** One model the picker offers, in the shape `agent_models::Choice` publishes. */
type MockAgentModel = {
  id: string;
  label: string;
  vendor: string;
  vendor_label: string;
  context: number | null;
  output: number | null;
};

/** The models the mock's `claude` offers, mirroring `agent_policy::BACKENDS`.
 *
 *  The real list for `opencode` is read off the machine (`agent_models`), so a mock
 *  cannot have one — which is the other reason `opencode` is the uninstalled half
 *  here. */
const MOCK_CLAUDE_MODELS: MockAgentModel[] = [
  { id: "fable", label: "Fable 5", vendor: "anthropic", vendor_label: "Anthropic", context: 1_000_000, output: 128_000 },
  { id: "opus", label: "Opus 5", vendor: "anthropic", vendor_label: "Anthropic", context: 1_000_000, output: 128_000 },
  { id: "sonnet", label: "Sonnet 5", vendor: "anthropic", vendor_label: "Anthropic", context: 1_000_000, output: 128_000 },
  { id: "haiku", label: "Haiku 4.5", vendor: "anthropic", vendor_label: "Anthropic", context: 200_000, output: 64_000 },
];

/** Which AI providers this "machine" holds, and what the user chose for each — the
 *  state the Settings › AI providers pane draws.
 *
 *  `claude` is installed and `opencode` is not, on purpose: both halves of the pane
 *  matter, and the "Not installed" row with its disabled switch is exactly the state a
 *  real machine with one CLI is in. `enabled` starts true for both, as the Rust default
 *  does (`agent_policy::Providers`), and `models` mirrors `agent_models::choices`. */
const mockAgentProviders = new Map<
  string,
  {
    prefix: string;
    available: boolean;
    enabled: boolean;
    model: string | null;
    models: MockAgentModel[];
  }
>([
  [
    "claude",
    {
      prefix: "@claude",
      available: true,
      enabled: true,
      model: null,
      models: MOCK_CLAUDE_MODELS,
    },
  ],
  ["opencode", { prefix: "@opencode", available: false, enabled: true, model: null, models: [] }],
]);

/** Which provider a message's ⋯ menu offers — `claude`, exactly like a fresh Rust store
 *  (`agent_policy::DEFAULT_BACKEND`). Moved by `agent_set_provider {default: true}`, and by
 *  the `{kind: "agent_providers"}` test hook, which a spec MUST reset. */
let mockAgentDefaultProvider = "claude";

/** Whether this pretend machine holds the `opencode` CLI. The default is NO — one
 *  installed CLI and one missing is the state that keeps the pane's own "Not installed" row
 *  honest — so a spec that needs two usable providers arms it through the
 *  `{kind: "agent_providers"}` test hook and resets it afterwards. */
const MOCK_OPENCODE_INSTALLED = false;

/** Put the providers back the way this file declares them. One mock process serves the
 *  whole E2E run, so a spec that armed a second CLI or moved the default has to hand the
 *  next one the state it expects. */
function resetMockAgentProviders(): void {
  const claude = mockAgentProviders.get("claude");
  const opencode = mockAgentProviders.get("opencode");
  if (claude) {
    claude.enabled = true;
    claude.model = null;
  }
  if (opencode) {
    opencode.available = MOCK_OPENCODE_INSTALLED;
    opencode.enabled = true;
    opencode.model = null;
  }
  mockAgentDefaultProvider = "claude";
}

/** Whether the agent would run on the user's own Claude Code configuration. Off, like a
 *  fresh Rust store: the mock runs no CLI, so this is only the setting travelling to the
 *  backend and back — which is exactly what the switch has to prove. */
let mockAgentUnrestricted = false;

/** The runs in flight right now, by `run_id` — the stand-in for the Rust process's own
 *  registry of live runs. `agent_stop` answers `stopped: false` for anything not in here,
 *  exactly as the backend does for a run that finished or belongs to the other install. */
const mockAgentRunning = new Set<string>();

/** The runs the user has asked to stop, by `run_id`. `agent_stop` adds one and
 *  `simulateMockAgentRun` checks it between steps — the stand-in for the Rust registry
 *  that cancels the run future. A run whose id is in here jumps to its terminal frame with
 *  the answer so far and a "stopped by you" note, exactly as the backend finalizes it. */
const mockAgentStopped = new Set<string>();

/** The `agent_status` result, matching the Rust one. */
function agentStatusView(): {
  backends: {
    name: string;
    prefix: string;
    available: boolean;
    enabled: boolean;
    model: string | null;
    models: MockAgentModel[];
  }[];
  default_provider: string;
  conversations: { conversation: string; mode: string }[];
  tools: string[];
  tool_grants: { key: string; label: string; detail: string; tools: string[] }[];
  unrestricted: boolean;
  workspace: string;
  enabled: boolean;
  sandbox_conversation: string;
} {
  return {
    backends: [...mockAgentProviders].map(([name, provider]) => ({ name, ...provider })),
    default_provider: mockAgentDefaultProvider,
    conversations: [...mockAgentModes].map(([conversation, mode]) => ({ conversation, mode })),
    tools: [...mockAgentTools],
    tool_grants: MOCK_AGENT_TOOL_GRANTS,
    unrestricted: mockAgentUnrestricted,
    workspace: "/home/mock/GitHub/teams-lite",
    enabled: true,
    sandbox_conversation: MOCK_AGENT_SANDBOX,
  };
}

// ---------------------------------------------------------------------------
// Audio calling (see src/calling.rs and NATIVE-CALLING.md).
//
// The mock registers nothing with Teams, opens no microphone and carries no audio: it
// reproduces the SIGNALING — the ring, the answer, the mute, the ending — so the whole
// surface is reviewable with nothing leaving the machine. The page pairs it with
// `simulatedCallMedia`, which it picks because this mock announces itself as one.
// ---------------------------------------------------------------------------

/** The one call the mock is in, in the shape `call_status` answers with. */
type MockCall = {
  id: string;
  direction: "incoming" | "outgoing";
  kind: "call" | "group" | "meeting";
  phase: "ringing" | "dialing" | "connecting" | "connected" | "ended";
  conversation_id: string | null;
  peer: string;
  peer_mri: string;
  /** Everybody else in a meeting or a group call, the way a roster frame names them. */
  others: string[];
  other_mris: string[];
  in_lobby: boolean;
  waiting_in_lobby: number;
  muted: boolean;
  connected_at_ms: number | null;
  end_reason: string | null;
  /** What the others publish, and the source ids a subscription is addressed by — the
   *  half of the roster the real backend reads out of `endpoints[…].call.mediaStreams`. */
  publishing: MockPublishing[];
  /** What THIS machine is sending beyond audio, published so every client agrees. */
  sending: string[];
  can_accept: boolean;
  can_hangup: boolean;
  /** New media is only accepted on an established call, so the buttons are only offered
   *  there. */
  can_send_media: boolean;
};

/** One person in the meeting and what they are sending. */
type MockPublishing = {
  mri: string;
  name: string;
  streams: Array<{
    label: string;
    kind: string;
    source_id: number;
    direction: string;
    server_muted: boolean;
    shared_screen: boolean;
    camera: boolean;
  }>;
};

/** The people the mock puts in a meeting once the join is answered — a roster arriving
 *  after the fact, which is what the real service sends. */
const MOCK_MEETING_ROSTER = ["Ava Thompson", "Liam Nguyen", "Priya Raman"];

/** How many people one call may ring, mirroring `MAX_GROUP_CALL_PEOPLE` in
 *  src/bin/server.rs: every one of them is a device buzzing in somebody's pocket, and a
 *  mis-click on a 60-person thread cannot be taken back. */
const MOCK_MAX_GROUP_CALL_PEOPLE = 20;

/** One audio stream per person, plus a CAMERA for the first and a SHARED SCREEN for the
 *  second. The source ids are small integers like the real ones, and they are the addresses
 *  `call_subscribe` names. */
function mockPublishing(names: string[]): MockPublishing[] {
  return names.map((name, index) => {
    const mri = PEOPLE.find((p) => p.name === name)?.mri ?? `8:orgid:mock-${index}`;
    const base = 2400 + index * 10;
    const streams: MockPublishing["streams"] = [
      {
        label: "main-audio",
        kind: "audio",
        source_id: base,
        direction: "sendrecv",
        server_muted: false,
        shared_screen: false,
        camera: false,
      },
    ];
    if (index === 0) {
      streams.push({
        label: "main-video",
        kind: "video",
        source_id: base + 1,
        direction: "sendrecv",
        server_muted: false,
        shared_screen: false,
        camera: true,
      });
    }
    if (index === 1) {
      streams.push({
        label: "applicationsharing-video",
        kind: "applicationsharing-video",
        source_id: base + 2,
        direction: "sendonly",
        server_muted: false,
        shared_screen: true,
        camera: false,
      });
    }
    return { mri, name, streams };
  });
}

/**
 * The offer the service makes ON ITS OWN, which is how video arrives (NATIVE-CALLING.md
 * § 10.3a).
 *
 * The labels and the mids are the measured ones — audio at 0, a camera at 1, a shared screen
 * at 3, data at 4 — because the page reads the label per mid to decide which section carries
 * what, and a mock that made them up would exercise a mapping the tenant does not have.
 */
const MOCK_RENEGOTIATION_OFFER = [
  "v=0",
  "o=- 0 0 IN IP4 127.0.0.1",
  "s=teams-lite-mock-renegotiation",
  "t=0 0",
  "m=audio 3478 RTP/SAVP 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=mid:0",
  "a=label:main-audio",
  "a=sendrecv",
  "m=video 3481 RTP/SAVP 107",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:107 H264/90000",
  "a=mid:1",
  "a=label:main-video",
  "a=sendonly",
  "m=video 3481 RTP/SAVP 107",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:107 H264/90000",
  "a=mid:3",
  "a=label:applicationsharing-video",
  "a=sendonly",
  "",
].join("\r\n");

/**
 * A description that REJECTS one of the sections this page is sending — the section still
 * written down, its port zeroed, which is how the far side says a section is gone. Against a
 * real tenant the browser reads that and stops the transceiver; the simulated media has none
 * and reads the label instead.
 *
 * It is sent as either half of a negotiation, because WHICH half it is is the whole
 * difference between the two endings the app has to tell apart:
 *
 * * as an OFFER (`{kind:"call_media", drop:…}`) it takes away a capture the meeting had
 *   accepted, so the picture stopped and turning it on again is worth doing;
 * * as an ANSWER to our own offer (`{kind:"call_media", reject:…}`) it says the meeting never
 *   accepted the capture at all — the state a screen share really met on this tenant, where
 *   turning it on again meets the same refusal in the same second.
 *
 * Both are reachable nowhere else: the page's own simulated camera is never rejected, and the
 * service that rejects one is a real tenant.
 */
function mockSectionRejection(label: string, mid = "2"): string {
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=teams-lite-mock-drop",
    "t=0 0",
    "m=audio 3478 RTP/SAVP 111",
    "c=IN IP4 0.0.0.0",
    "a=rtpmap:111 opus/48000/2",
    "a=mid:0",
    "a=label:main-audio",
    "a=sendrecv",
    // Port 0: the rejection. The mid defaults to the one the page's own section was given,
    // and a section of the SERVICE's own — a colleague's screen, at the measured mid 3 —
    // names its own.
    "m=video 0 RTP/SAVP 107",
    "c=IN IP4 0.0.0.0",
    "a=rtpmap:107 H264/90000",
    `a=mid:${mid}`,
    `a=label:${label}`,
    "a=inactive",
    "",
  ].join("\r\n");
}

/** ON, exactly like every Rust backend the user launches: each registers as a device their
 *  calls ring on at startup, and there is no switch to find. The
 *  `{kind:"calling", enabled:false}` test hook is the only way back, and it reproduces the
 *  ONE backend that really answers `false` — a read-only one, which is the install the user
 *  never opened. */
let mockCallingEnabled = true;
let mockCall: MockCall | null = null;
/** Timers of a simulated call, cleared on every ending so a reused mock cannot let an
 *  old call finish connecting inside a later spec. */
let mockCallTimers: ReturnType<typeof setTimeout>[] = [];
/** Armed by the `{kind:"call_media", refuse:true}` test hook: the NEXT `call_offer_media`
 *  is refused, and only that one. It is what makes a mid-call failure reviewable — the
 *  page's simulated camera never refuses, and the service that would is a real tenant. */
let mockRefusesNextMedia = false;
/** The content-sharing session this mock has granted, if any. A share asks for one before it
 *  offers a section, and asking twice is refused exactly as the Rust backend refuses it —
 *  which is what makes "the session is given back on every ending" a rule a spec can hold the
 *  app to rather than a sentence in a comment. */
let mockSharingSession: string | null = null;
/** The ORDER the sharing calls arrived in, for the one rule a spec cannot read off the screen:
 *  the modality is asked for BEFORE the section is offered. A meeting rejects a section from an
 *  endpoint that never asked, so an app that offered first would look right and share nothing. */
let mockSharingOrder: string[] = [];
/** Armed by the `{kind:"call_start", hold:"prepare"|"place"}` test hook: that ONE step of
 *  the next start answers late, and only that one.
 *
 *  It is what makes a CANCELLED start reviewable. A real start waits on a microphone and
 *  on ICE gathering (up to `GATHER_TIMEOUT_MS`), then on a POST to Teams, so a call the
 *  user stops a second after placing it lands inside one of those waits — while the mock's
 *  own media is instant, which left the whole case unreachable from a spec. Which step is
 *  held decides which half is exercised: the offer that must never go out, or the invite
 *  that went out and has to be taken back. */
let mockCallStartHold: { at: "prepare" | "place"; ms: number } | null = null;

/** Wait out the hold armed for `step`, once. */
async function holdMockCallStart(step: "prepare" | "place"): Promise<void> {
  const hold = mockCallStartHold;
  if (!hold || hold.at !== step) return;
  mockCallStartHold = null;
  await new Promise((resolve) => setTimeout(resolve, hold.ms));
}

function mockCallStatus(): { enabled: boolean; ready: boolean; call: MockCall | null } {
  return {
    enabled: mockCallingEnabled,
    // Ready as soon as it calls at all: the mock has no connection to wait for, and a
    // state stuck on "connecting…" is one the real backend leaves in seconds.
    ready: mockCallingEnabled,
    call: mockCall,
  };
}

function broadcastMockCall(): void {
  broadcast("call_state", mockCallStatus());
}

function clearMockCallTimers(): void {
  for (const timer of mockCallTimers) clearTimeout(timer);
  mockCallTimers = [];
}

/** End the mock call and hand out one last frame carrying the reason — the same shape
 *  the Rust backend emits, so the page releases its (simulated) microphone. */
function endMockCall(reason: string): void {
  clearMockCallTimers();
  // The session goes with the call: the meeting's presenter cannot outlive the meeting, and a
  // session left behind would refuse the first share of the NEXT call in a shared mock.
  mockSharingSession = null;
  mockSharingOrder = [];
  if (!mockCall) return;
  mockCall = { ...mockCall, phase: "ended", end_reason: reason, can_accept: false, can_hangup: false };
  broadcastMockCall();
  mockCall = null;
}

/**
 * Take the share off whoever holds it, which is what the service does the moment this endpoint
 * is granted the sharing session.
 *
 * Measured 2026-08-06 against a colleague's real share: the role was granted, and their
 * `applicationsharing-video` section came straight back at PORT 0. A meeting shows one screen at
 * a time, and this is how it changes hands — for a Teams client and now for this app too.
 *
 * BOTH halves are reproduced, because the surface reads them in two places: the ROSTER says who
 * is sharing (the People panel, and the sentence the Share control carries before it is
 * pressed), and the SECTION is what carries the picture the stage draws.
 *
 * Nothing goes out while this page is sending a screen of its own: the two share one label, so
 * the zeroed section would then read as its own capture being dropped. A takeover happens before
 * any capture of ours exists, so that state cannot be one this stands for.
 */
function takeMockShareFromPresenter(callId: string): void {
  if (!mockCall || mockCall.sending.includes("screen")) return;
  const presenting = mockCall.publishing.some((person) =>
    person.streams.some((stream) => stream.shared_screen),
  );
  if (!presenting) return;
  mockCall = {
    ...mockCall,
    publishing: mockCall.publishing.map((person) => ({
      ...person,
      streams: person.streams.filter((stream) => !stream.shared_screen),
    })),
  };
  broadcastMockCall();
  broadcast("call_media", {
    call_id: callId,
    // Their section, at the mid the mock's own renegotiation gave it.
    sdp: mockSectionRejection("applicationsharing-video", "3"),
    kind: "offer",
  });
}

/** An inert answer SDP. The page's simulated media ignores it; it exists so the
 *  `call_media` frame the real backend sends is exercised too. */
const MOCK_ANSWER_SDP = [
  "v=0",
  "o=- 0 0 IN IP4 127.0.0.1",
  "s=teams-lite-mock-answer",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=sendrecv",
  "",
].join("\r\n");

/**
 * An answer no browser can read, sent by the `{kind:"call_media", unreadable:true}` hook.
 *
 * It reproduces what a screen share really met on this tenant: the offer went out, the service
 * answered, and the answer was thrown out by the browser — after which this app hung up, so
 * the user lost the person they were talking to a few seconds after they shared. The blob is
 * not a session description at all, because WHY the browser refuses one is not the point: what
 * is pinned is that a mid-call answer it cannot read costs the picture and never the call.
 */
const UNREADABLE_ANSWER_SDP = "this is not a session description";

/** Ring this machine, the way an invite on the calling socket does. Used by the gated
 *  test hook and by the preview script. */
function injectMockCallInvite(conversation: string): MockCall | null {
  const thread = threadFor(conversation);
  if (!thread) return null;
  const person = thread.participants[0];
  clearMockCallTimers();
  mockCall = {
    id: `mock-call-${Date.now()}`,
    direction: "incoming",
    kind: "call",
    phase: "ringing",
    conversation_id: conversation,
    peer: person?.name ?? "Someone",
    peer_mri: person?.mri ?? "8:orgid:someone",
    others: [],
    other_mris: [],
    in_lobby: false,
    waiting_in_lobby: 0,
    muted: false,
    connected_at_ms: null,
    end_reason: null,
    publishing: [],
    sending: [],
    can_accept: true,
    can_hangup: true,
    can_send_media: false,
  };
  // A backend that does not call is a backend no invite reaches, so an invite implies
  // one that does: a spec ringing a window that reported `enabled:false` would be
  // testing a state no backend can be in.
  mockCallingEnabled = true;
  broadcastMockCall();
  return mockCall;
}

/** The model shape the Rust RPC accepts (`agent_policy::is_valid_model`). The mock
 *  enforces it too, so a spec can prove the refusal without a real backend. */
function isValidMockModel(model: string): boolean {
  return (
    model.length > 0 &&
    model.length <= 80 &&
    !model.startsWith("-") &&
    /^[A-Za-z0-9._:/-]+$/.test(model)
  );
}

/** The Linear workspace this mock's key belongs to (`linear::Workspace`), which is what turns
 *  a bare `ENG-1` in anybody's words into a link to that issue.
 *
 *  `ENG` and nothing else, deliberately: the seeded messages write `ENG-1` and also `UTF-8`,
 *  so the surface shows both halves of the rule — a reference that resolves beside a word
 *  that only looks like one. The url key matches the Linear links these fixtures already
 *  carry, so a chip and a card name one workspace. */
const MOCK_LINEAR_WORKSPACE = { url_key: "acme", team_keys: ["ENG"] };

/** Non-secret settings view, matching the Rust `get_settings` result. */
function settingsView(): {
  gitlab_host: string;
  gitlab_token_set: boolean;
  linear_token_set: boolean;
  ghost_mode: boolean;
  always_available: boolean;
  sender_icons: boolean;
  emoji_auto_import: boolean;
} {
  const host = mockSettings.gitlab_host.trim() || "gitlab.com";
  return {
    gitlab_host: host,
    gitlab_token_set: mockSettings.gitlab_token.length > 0,
    linear_token_set: mockSettings.linear_token.length > 0,
    ghost_mode: mockSettings.ghost_mode,
    always_available: mockSettings.always_available,
    sender_icons: mockSettings.sender_icons,
    emoji_auto_import: mockSettings.emoji_auto_import,
  };
}

type GitLabKind = "merge_request" | "issue" | "project";
type ParsedGitLab = { kind: GitLabKind; project_path: string; iid?: number };

/** GitLab application routes that are never a project (mirrors src/gitlab.rs). */
const GITLAB_RESERVED_TOP = new Set([
  "-", "admin", "api", "dashboard", "explore", "groups", "help", "profile", "projects", "search",
  "users",
]);

/** Parse a GitLab web URL into a supported resource, mirroring src/gitlab.rs. */
function parseGitLabUrl(url: string, host: string): ParsedGitLab | null {
  if (!/^https:\/\//i.test(url)) return null;
  const match = url.match(/^https:\/\/([^/?#]+)([^?#]*)/i);
  if (!match) return null;
  const urlHost = (match[1]!.split("@").pop() ?? "").split(":")[0]!.toLowerCase();
  if (urlHost !== host.trim().toLowerCase()) return null;

  const segments = (match[2] ?? "").split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const dash = segments.indexOf("-");
  if (dash > 0) {
    const projectPath = segments.slice(0, dash).join("/");
    const rest = segments.slice(dash + 1);
    if (rest[0] === "merge_requests" && /^\d+$/.test(rest[1] ?? "")) {
      return { kind: "merge_request", project_path: projectPath, iid: Number(rest[1]) };
    }
    if (rest[0] === "issues" && /^\d+$/.test(rest[1] ?? "")) {
      return { kind: "issue", project_path: projectPath, iid: Number(rest[1]) };
    }
    return null;
  }
  if (GITLAB_RESERVED_TOP.has(segments[0]!.toLowerCase())) return null;
  return { kind: "project", project_path: segments.join("/") };
}

/** The one seeded project whose every field is as long as a real one's: a deeply
 *  nested group path, a branch named after its ticket, a sentence for a title. The
 *  other fixtures are short enough to fit any width, so they said nothing about a
 *  phone — and a card whose text cannot shrink is what ran off the side of one. */
const LONG_GITLAB_PATH = "acme/platform/infrastructure/dlq-to-dynamodb-lambda";

/** Deterministic metadata for a parsed GitLab URL — canned, but varied by iid so
 *  the UI shows realistic, distinct cards without any tenant. */
function mockGitLabMetadata(url: string): Record<string, unknown> | null {
  const parsed = parseGitLabUrl(url, mockSettings.gitlab_host || "gitlab.com");
  if (!parsed) return null;
  const { project_path } = parsed;
  const long = project_path === LONG_GITLAB_PATH;

  if (parsed.kind === "merge_request") {
    const iid = parsed.iid!;
    const state = iid % 3 === 0 ? "merged" : "opened";
    // Deterministic CI status per MR so cards show realistic variety (mirrors
    // GitLab's `head_pipeline.status`). !42 → success, !99 → running.
    const pipeline_status = ["failed", "pending", "success", "canceled", "running"][iid % 5]!;
    return {
      provider: "gitlab",
      kind: "merge_request",
      url,
      title: long
        ? `feat: add better testing and error handling to the replay lambda (!${iid})`
        : `Add rich link previews for GitLab (!${iid})`,
      project_path,
      reference: `!${iid}`,
      state,
      draft: iid % 5 === 0,
      // Colleagues this mock's Teams also knows, so a card is reviewable with a real face on
      // it — while the ISSUE card below keeps somebody only GitLab knows, which is the other
      // shape (see `withMockTeamsPeople`).
      author: long
        ? { name: "Charlotte Dubois", username: "charlotte.dubois" }
        : { name: "Mia Chen", username: "mia.chen" },
      source_branch: long ? "feature/error-handling-and-test" : "feat/gitlab-rich-links",
      target_branch: long ? "master" : "main",
      labels: ["frontend", "enhancement"],
      milestone: "v1.0",
      description: "Render GitLab links in chat as rich cards with title, state, and author.",
      pipeline_status,
    };
  }
  if (parsed.kind === "issue") {
    const iid = parsed.iid!;
    return {
      provider: "gitlab",
      kind: "issue",
      url,
      title: `Links should show a preview card (#${iid})`,
      project_path,
      reference: `#${iid}`,
      state: iid % 2 === 0 ? "closed" : "opened",
      author: { name: "Grace Hopper", username: "grace" },
      labels: ["bug"],
      description: "A bare URL is hard to scan; show the target's title and status inline.",
    };
  }
  return {
    provider: "gitlab",
    kind: "project",
    url,
    title: project_path,
    project_path,
    reference: "",
    description: "A sample GitLab project used by the teams-lite mock backend.",
  };
}

/** The approval state of one merge request, in memory (the real backend reads GitLab).
 *  `others` are the colleagues who have approved; `mine` is the user's own approval, which
 *  is what the menu's toggle moves. */
type MockApproval = { mine: boolean; others: string[]; approvals_required?: number };

/** Per merge-request URL, created on first ask so every seeded MR has one. */
const mockApprovals = new Map<string, MockApproval>();

/** When set, `gitlab_set_approval` fails with this sentence — the shape GitLab's own
 *  refusal takes. Armed and cleared by the `{kind:"gitlab_approval"}` test hook. */
let mockApprovalRefusal: string | null = null;

/** When true, no merge request has an approval state at all: the shape of a machine with
 *  no GitLab token, where the app must offer no approval row rather than an action the
 *  backend would refuse. Same hook. */
let mockApprovalsUnavailable = false;

/** The stored state of a merge request URL, or null when the URL names no merge request on
 *  the configured host — the same question `gitlab::parse_url` answers. */
function mockApprovalFor(url: string): MockApproval | null {
  const parsed = parseGitLabUrl(url, mockSettings.gitlab_host || "gitlab.com");
  if (!parsed || parsed.kind !== "merge_request") return null;
  const known = mockApprovals.get(url);
  if (known) return known;
  // Deterministic per iid, like the rest of the GitLab fixtures: !42 wants two approvals
  // and already has a colleague's, !99 wants one and has none.
  const iid = parsed.iid ?? 1;
  const fresh: MockApproval = {
    mine: false,
    others: iid % 2 === 0 ? ["Ada Lovelace"] : [],
    approvals_required: (iid % 3) + 1,
  };
  mockApprovals.set(url, fresh);
  return fresh;
}

/** The `gitlab_approvals` / `gitlab_set_approval` result shape (mirrors the Rust
 *  `Approval` plus `token_set`).
 *
 *  `token_set` is a FIXTURE here, deliberately not derived from `mockSettings.gitlab_token`:
 *  this mock contacts no GitLab, so which project it can act on is something the fixture
 *  decides — and gating it on that setting would let one spec's "remove the token" step
 *  silently delete a whole surface from another spec's app. The app's own rail (no token →
 *  no row) is armed by the test hook instead. */
function mockApprovalResult(url: string): {
  approval: Record<string, unknown> | null;
  token_set: boolean;
} {
  if (mockApprovalsUnavailable) return { approval: null, token_set: false };
  const state = mockApprovalFor(url);
  if (!state) return { approval: null, token_set: true };
  const parsed = parseGitLabUrl(url, mockSettings.gitlab_host || "gitlab.com");
  // People, not bare names — the shape the Rust `Approval` carries, so the same walk that
  // names a merge request's author names whoever approved it (`withMockTeamsPeople`).
  const approved_by = [...state.others, ...(state.mine ? [MOCK_GITLAB_ME.name] : [])].map(
    (name) => ({ name, username: name.toLowerCase().replace(/[^a-z]+/g, ".") }),
  );
  return withMockTeamsPeople({
    approval: {
      reference: `!${parsed?.iid ?? 1}`,
      approved: approved_by.length > 0,
      approvals_required: state.approvals_required,
      approvals_left: Math.max(0, (state.approvals_required ?? 1) - approved_by.length),
      approved_by,
      mine: state.mine,
    },
    token_set: true,
  });
}

// ---- the merge-request page (`gitlab_mr_*`) ---------------------------------
//
// The whole surface with no GitLab and no token: a list of merge requests that are not
// merged, one of them in full, its comments and its LIVE pipeline — plus the four writes
// (merge, comment, delete a comment, close/reopen), which move this in-memory state and
// nothing else. That is what makes the page reviewable: `bun run preview -- --gitlab`
// walks it, and web/e2e/gitlab.spec.ts holds the app to every rule it is built on.
//
// Two fixtures are deliberate and load-bearing:
//
//   - **The list rows carry NO pipeline**, exactly as the real endpoint answers (measured
//     against the tenant — see src/gitlab_mr.rs). A mock that helpfully added one would hide
//     the reason the sidebar shows `detailed_merge_status` instead.
//   - **One pipeline is genuinely LIVE**: its jobs advance one step per read, so the poll,
//     the "following" mark and a job turning green are all things a spec can watch happen
//     rather than assert about a still picture.

type MockGitLabPerson = { name: string; username: string };

type MockJob = {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure: boolean;
  duration?: number;
  /** What this job WAITS FOR, by name — the field GitLab's REST jobs endpoint does not carry
   *  and the backend reads over GraphQL instead (`src/gitlab_ci_graph.rs`). It is here because
   *  the graph's dependency grouping and its curves exist only where a pipeline declares one,
   *  so a mock without it could only ever show half the surface. Measured on the real
   *  instance: 21 of 25 pipelines declare dependencies, and the deepest chain is 4 columns. */
  needs?: string[];
};

type MockPipeline = {
  id: number;
  status: string;
  jobs: MockJob[];
  /** The stage names in the pipeline's own order, which is what the backend reads over GraphQL
   *  (`src/gitlab_ci_graph.rs`) — because GitLab's REST jobs endpoint answers NEWEST FIRST and
   *  therefore in REVERSE stage order. `mockPipelineView` reverses the jobs on the way out for
   *  exactly that reason, so a page that read the order off the answer draws this fixture
   *  backwards, as it drew every real multi-stage pipeline backwards until it was measured. */
  stages?: string[];
  live?: boolean;
  /** How many times this pipeline has been read. The FIRST read never advances it, so the
   *  first paint shows the seeded state and every POLL after it shows something happening —
   *  which is what makes "the panel follows the run" a thing a spec can watch. */
  reads?: number;
};

type MockNote = {
  id: number;
  author: MockGitLabPerson;
  body: string;
  system: boolean;
  created_at: string;
  /** When it was last REWRITTEN, which is how the page knows to say "edited" (GitLab moves
   *  this on an edit and on nothing else a reader can see — see `noteWasEdited`). */
  updated_at?: string;
  resolvable: boolean;
  resolved: boolean;
  mine: boolean;
  /** Where a code comment hangs, in the shape `gitlab_mr::NotePosition` answers with — the
   *  anchor's two line numbers, and both ends when the comment is about several lines. */
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number;
    old_line?: number;
    line_range?: {
      start: { new_line?: number; old_line?: number; type?: string };
      end: { new_line?: number; old_line?: number; type?: string };
    };
  };
};

type MockDiscussion = { id: string; individual_note: boolean; notes: MockNote[] };

type MockMergeRequest = {
  project_path: string;
  iid: number;
  title: string;
  description?: string;
  state: "opened" | "closed" | "merged";
  draft: boolean;
  author: MockGitLabPerson;
  reviewers: MockGitLabPerson[];
  assignees: MockGitLabPerson[];
  labels: string[];
  source_branch: string;
  target_branch: string;
  detailed_merge_status: string;
  sha: string;
  changes_count: string;
  upvotes: number;
  updated_at: string;
  created_at: string;
  pipeline: MockPipeline | null;
  discussions: MockDiscussion[];
  merged_at?: string;
  closed_at?: string;
};

/** The account this mock acts as, in GitLab's own shape. The same person the approval
 *  fixtures name, so one identity runs through the whole surface. */
const MOCK_GITLAB_ME: MockGitLabPerson = { name: "Théophile WALLEZ", username: "theophile" };
const MOCK_GITLAB_ADA: MockGitLabPerson = { name: "Ada Lovelace", username: "ada" };
const MOCK_GITLAB_GRACE: MockGitLabPerson = { name: "Grace Hopper", username: "grace" };
const MOCK_GITLAB_BOT: MockGitLabPerson = { name: "review-bot", username: "review-bot" };
/** Two colleagues who are in this mock's TEAMS as well as on its GitLab, under the same real
 *  name — so the page draws them as those colleagues: their Teams face, and the name the user
 *  gave them if they gave one (see `mockTeamsPersonFor`). Mia HAS a photo in this mock and
 *  Lucas does not, which is the whole range of the feature on one merge request: a real face,
 *  a Teams name over tinted initials, and — in Ada, Grace and the bot, who are on GitLab only
 *  — GitLab's own words untouched. */
const MOCK_GITLAB_MIA: MockGitLabPerson = { name: "Mia Chen", username: "mia.chen" };
const MOCK_GITLAB_LUCAS: MockGitLabPerson = { name: "Lucas Silva", username: "lucas.silva" };

// ---- who a GitLab user is in TEAMS -----------------------------------------
//
// The mock's half of `src/tracker_people.rs`: the people on a merge request — or on a Linear
// issue — are matched to the people this app knows by their REAL NAME, and the answer travels
// as one more field on each person. It is done at the answer boundary, exactly where the
// backend does it — never baked into the fixtures — because that is what makes a rename show up
// here at once, and what keeps the tracker's own words the thing the fixtures hold.

/** The comparison key two systems' record of one person has to agree on: case folded and
 *  whitespace collapsed. A port of `tracker_people::name_key`, whose own doc says why accents
 *  are NOT folded (it was measured, and it changes nothing). */
function mockNameKey(name: string): string {
  return name.trim().toLowerCase().split(/\s+/).join(" ");
}

/** Everybody this mock's Teams can name, by that key — the stand-in for
 *  `Store::named_people`. It holds the user themselves under the name TEAMS has for them,
 *  which is not the "You" this mock's own messages carry: the real store holds a real name
 *  there too, and it is what a GitLab account of theirs matches. */
const mockTeamsPeopleByName = new Map<string, Person>([
  ...PEOPLE.map((person) => [mockNameKey(person.name), person] as const),
  [mockNameKey(MOCK_GITLAB_ME.name), { name: SELF_NAME, mri: SELF_MRI }],
]);

/** The Teams person one GitLab display name is, or `undefined` when this app knows nobody by
 *  it. The NAME that comes back is the user's own nickname when they set one, like every
 *  other name this mock answers with (`nickname`). */
function mockTeamsPersonFor(name: string): { mri: string; name: string } | undefined {
  const person = mockTeamsPeopleByName.get(mockNameKey(name));
  if (!person) return undefined;
  return { mri: person.mri, name: nickname(person.mri) || person.name };
}

/** Name every person in one tracker payload — the walk `tracker_people::annotate` does, under
 *  the same rule: a person is an object carrying both a `name` and a `username`, so one pass
 *  reaches a row's author, a merge request's reviewers, every comment's author and a Linear
 *  issue's assignee, and never a CI job (which has a name and no handle).
 *
 *  It answers a COPY. The fixtures above are shared by every read — a row hands out the very
 *  object a detail and a note hand out — so writing an identity into them would be this mock
 *  remembering something a real GitLab never said. */
function withMockTeamsPeople<T>(payload: T): T {
  payload = structuredClone(payload);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const map = value as Record<string, unknown>;
    if (typeof map.name === "string" && typeof map.username === "string") {
      const teams = mockTeamsPersonFor(map.name);
      if (teams) map.teams = teams;
      else delete map.teams;
    }
    for (const child of Object.values(map)) walk(child);
  };
  walk(payload);
  return payload;
}

/** Minutes ago as an ISO timestamp, so the fixtures read as recent work. */
function agoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

let mockNoteId = 90_000;

/** The live pipeline as it is SEEDED, so the test hook can put it back — one mock process
 *  serves the whole run and every read of it moves it on, so without this the second spec to
 *  look at a running pipeline would find it finished. It is also the fixture the whole GRAPH is
 *  reviewed against.
 *
 *  Its shape is deliberate, and every job in it is there for a state the graph has to draw:
 *  a build the rest waits for, TWO jobs that wait for it (so a curve fans out), one job that
 *  waits for NOTHING in a later stage (`🤖 opencode review` — which is the whole point of the
 *  dependency grouping: it starts at once, and a stage view hides that), one allowed to fail,
 *  and a manual deploy waiting on a person. It is the shape of the pipeline in GitLab's own
 *  documentation for `needs:`, which is what the reference design for this surface shows. */
const MOCK_LIVE_PIPELINE_JOBS: MockJob[] = [
  { id: 1, name: "🔎 lint", stage: "check", status: "success", allow_failure: false, duration: 42.5 },
  { id: 2, name: "🧪 unit", stage: "test", status: "running", allow_failure: false, needs: ["🔎 lint"] },
  { id: 3, name: "🧪 e2e", stage: "test", status: "created", allow_failure: false, needs: ["🔎 lint"] },
  { id: 4, name: "🤖 opencode review", stage: "test", status: "created", allow_failure: true },
  {
    id: 5,
    name: "🚀 deploy staging",
    stage: "deploy",
    status: "manual",
    allow_failure: false,
    needs: ["🧪 unit", "🧪 e2e"],
  },
];

/** The seeded merge requests, newest activity first — the order GitLab answers in. */
const mockMergeRequests: MockMergeRequest[] = [
  {
    project_path: "acme/webapp",
    iid: 596,
    title: "✨ HA replicas + PodDisruptionBudgets for the user-facing APIs",
    // Real GitLab markdown, in the shape the authors on the tenant actually write it —
    // measured by `examples/merge_request_markdown_recon.rs`: a heading in 32 of 36
    // descriptions, a table in 24, a fenced block in 19, a task list in 18, a nested bullet
    // in 10. It is deliberately every one of those at once, because this fixture is what
    // makes `parseGitLabMarkdown` reviewable with no GitLab and no token.
    description:
      "## What changes\n\n" +
      "Adds **two replicas** and a PodDisruptionBudget to every user-facing API,\n" +
      "so a node drain can never take the last pod of one.\n\n" +
      // Tracker references, in the three shapes an author writes them: a bare `!595` (this
      // project, GitLab's own rule), a Linear identifier, and one word that only LOOKS like
      // one. The last is the point — `UTF-8` must stay the text it is (see lib/tracker-ref.ts).
      "Closes ENG-1, supersedes !595, and leaves the UTF-8 handling alone.\n\n" +
      "| Service  | Replicas | Budget |\n" +
      "| -------- | -------- | ------ |\n" +
      "| `web`    | 2        | 1      |\n" +
      "| `api`    | 2        | 1      |\n" +
      "| `worker` | 2        | 1      |\n\n" +
      "### How to roll it out\n\n" +
      "```sh\n" +
      "helmfile -e staging apply --selector name=web\n" +
      "kubectl get pdb -n user-facing\n" +
      "```\n\n" +
      "- a `preStop` hook drains connections\n" +
      "  - 10s for `web`, which holds websockets\n" +
      "  - 2s everywhere else\n\n" +
      "---\n\n" +
      "- [x] staging\n" +
      "- [ ] production, one cluster at a time\n\n" +
      "### Before and after\n\n" +
      // A pasted SCREENSHOT, in the exact shape GitLab writes one — a relative upload path
      // and its own attribute block (measured: the one description with a picture on the
      // tenant had both). Its bytes come through `gitlab_mr_upload`, because no browser can
      // ask GitLab for an upload at all.
      "![deploy-topology.png](/uploads/9f3c1e77a4bd42f0b6e5c8d31a7b04e2/deploy-topology.png){width=777 height=312}",
    state: "opened",
    draft: false,
    author: MOCK_GITLAB_ADA,
    // One person the app's own Teams knows (Lucas) beside one it does not (Ada), on one
    // merge request: both shapes of a person are on screen at once.
    reviewers: [MOCK_GITLAB_ME, MOCK_GITLAB_LUCAS],
    assignees: [MOCK_GITLAB_ADA],
    labels: ["infra", "needs-review"],
    source_branch: "feature/ha-replicas",
    target_branch: "main",
    // The one that CAN merge, so the merge flow is reviewable end to end.
    detailed_merge_status: "mergeable",
    sha: "e2607442e33693652508637a6a02eb9997d496ff",
    changes_count: "11",
    upvotes: 2,
    updated_at: agoIso(4),
    created_at: agoIso(2 * 24 * 60),
    pipeline: {
      id: 190_933,
      status: "running",
      live: true,
      stages: ["check", "test", "deploy"],
      jobs: MOCK_LIVE_PIPELINE_JOBS.map((job) => ({ ...job })),
    },
    discussions: [
      {
        id: "d-596-1",
        individual_note: true,
        notes: [
          {
            id: 69_848,
            // A colleague this app's Teams also knows, so the comment carries her real face
            // and the name the user calls her — beside the bot below, which stays what
            // GitLab called it.
            author: MOCK_GITLAB_MIA,
            // An upload of this project, which is drawn — and beside it an image on somebody
            // ELSE's host, which stays a link: fetching that one would tell its host the user
            // read this page (measured: every image in a comment on the tenant was one).
            body:
              "Two replicas is right, but please check the `preStop` timing against the load balancer.\n\n" +
              "![drain.png](/uploads/1b7d40c9e5f84a2db3608c17ae9f52d4/drain.png){width=420 height=180}\n\n" +
              "![build status](https://img.shields.io/badge/build-passing-green.svg)",
            system: false,
            created_at: agoIso(90),
            resolvable: false,
            resolved: false,
            mine: false,
          },
        ],
      },
      {
        id: "d-596-2",
        individual_note: false,
        notes: [
          {
            id: 69_852,
            author: MOCK_GITLAB_BOT,
            // A review comment quotes code as often as a description does, so the same
            // markdown runs on both surfaces.
            body:
              "🟡 **MEDIUM**: the `preStop` command interpolates a Helm value into a shell string.\n\n" +
              "```yaml\n" +
              "preStop:\n" +
              "  exec:\n" +
              "    command: [\"sh\", \"-c\", \"sleep {{ .Values.drain }}\"]\n" +
              "```",
            system: false,
            created_at: agoIso(70),
            resolvable: true,
            resolved: false,
            mine: false,
            position: { new_path: "charts/app/templates/deployment.yaml", new_line: 42 },
          },
          {
            id: 69_853,
            author: MOCK_GITLAB_ME,
            body: "Quoted it in `2f91ac0`.",
            system: false,
            created_at: agoIso(65),
            resolvable: true,
            resolved: false,
            mine: true,
          },
        ],
      },
      // A thread on a RANGE of lines of a file the diff page really shows, which is what puts
      // the whole comment-on-a-diff surface on screen out of the box: the card, its span
      // ("Lines 8–10"), a colleague's comment, the user's own reply — so the deletion that
      // makes commenting acceptable is reachable — and the reply box under both.
      {
        id: "d-596-4",
        individual_note: false,
        notes: [
          {
            id: 69_861,
            author: MOCK_GITLAB_MIA,
            body: "Three returns for one question — could this be one expression?",
            system: false,
            created_at: agoIso(52),
            resolvable: true,
            resolved: false,
            mine: false,
            position: {
              new_path: "src/server/health.ts",
              old_path: "src/server/health.ts",
              new_line: 10,
              line_range: {
                start: { new_line: 8, type: "new" },
                end: { new_line: 10, type: "new" },
              },
            },
          },
          {
            id: 69_862,
            author: MOCK_GITLAB_ME,
            body: "Kept them apart on purpose: `draining` and `ready` are logged differently.",
            system: false,
            created_at: agoIso(48),
            resolvable: true,
            resolved: false,
            mine: true,
            position: {
              new_path: "src/server/health.ts",
              old_path: "src/server/health.ts",
              new_line: 10,
              line_range: {
                start: { new_line: 8, type: "new" },
                end: { new_line: 10, type: "new" },
              },
            },
          },
        ],
      },
      {
        id: "d-596-3",
        individual_note: true,
        notes: [
          {
            id: 69_849,
            author: MOCK_GITLAB_BOT,
            body: "changed the description",
            system: true,
            created_at: agoIso(120),
            resolvable: false,
            resolved: false,
            mine: false,
          },
        ],
      },
    ],
  },
  {
    project_path: "acme/webapp",
    iid: 595,
    title: "🔒 ci(helm): assert live image tags after helmfile apply",
    description: "Checks the tags that are actually running after a deploy.",
    state: "opened",
    draft: false,
    author: MOCK_GITLAB_ME,
    reviewers: [MOCK_GITLAB_GRACE],
    assignees: [MOCK_GITLAB_ME],
    labels: ["ci"],
    source_branch: "ci/assert-image-tags",
    target_branch: "main",
    detailed_merge_status: "not_approved",
    sha: "8b1f0c6d2a7e4b5c9d3f1a2b3c4d5e6f70819234",
    changes_count: "3",
    upvotes: 0,
    updated_at: agoIso(35),
    created_at: agoIso(26 * 60),
    pipeline: {
      id: 190_901,
      status: "failed",
      stages: ["check", "test", "deploy"],
      // RED and ORANGE in one pipeline, which is the pair the tones exist to tell apart: the
      // unit test failed and blocks the merge, the review failed and nobody has to fix it. The
      // deploy was SKIPPED, because a job that will never run now is neither of those.
      jobs: [
        { id: 11, name: "🔎 lint", stage: "check", status: "success", allow_failure: false, duration: 38 },
        {
          id: 12,
          name: "🧪 unit",
          stage: "test",
          status: "failed",
          allow_failure: false,
          duration: 121.4,
          needs: ["🔎 lint"],
        },
        {
          id: 13,
          name: "🤖 opencode review",
          stage: "test",
          status: "failed",
          allow_failure: true,
          duration: 300.8,
          needs: ["🔎 lint"],
        },
        {
          id: 14,
          name: "🚀 deploy staging",
          stage: "deploy",
          status: "skipped",
          allow_failure: false,
          needs: ["🧪 unit"],
        },
      ],
    },
    discussions: [],
  },
  {
    project_path: "acme/infrastructure",
    iid: 297,
    // A title the length the authors on the tenant really write, and the shape they write it
    // in: a summary followed by every ticket the branch closes. It is a fixture rather than a
    // curiosity — a title this long used to widen the whole detail column, because `truncate`
    // shortens nothing while its container is free to grow (see the `min-w-0` on the shell's
    // own `detail-pane` in web/src/components/app.tsx).
    title:
      "✨ feat(batch): scalable batch actions system - phase 1 " +
      "[ACME-3346 ACME-3343 ACME-3348 ACME-3354 ACME-3353 ACME-3359 ACME-3341 " +
      "ACME-3357 ACME-3340 ACME-3345 ACME-3347 ACME-3342 ACME-3360 ACME-3351]",
    description: "Widens the forwarder's policy to the new bucket.",
    state: "opened",
    draft: true,
    // A colleague the app's own Teams knows, on a merge request no spec ever merges or
    // closes — which is what lets one pin that a rename reaches this page.
    author: MOCK_GITLAB_MIA,
    reviewers: [],
    assignees: [],
    labels: [],
    source_branch: "feat/lambda-policy",
    target_branch: "main",
    detailed_merge_status: "draft_status",
    sha: "cc11aa22bb33dd44ee55ff6677889900aabbccdd",
    changes_count: "1",
    upvotes: 0,
    updated_at: agoIso(2 * 60),
    created_at: agoIso(3 * 24 * 60),
    pipeline: null,
    discussions: [],
  },
  {
    project_path: "acme/design-system",
    iid: 63,
    title: "Conflicting rename of the token scale",
    state: "opened",
    draft: false,
    author: MOCK_GITLAB_ADA,
    reviewers: [MOCK_GITLAB_ME],
    // The one merge request whose assignee is somebody OTHER than its author, so both shapes
    // of the people rows are reviewable: this one names the two, and !596 — assigned to the
    // person who wrote it, which is the common case here — names them once.
    assignees: [MOCK_GITLAB_LUCAS],
    labels: ["design"],
    source_branch: "refactor/token-scale",
    target_branch: "main",
    detailed_merge_status: "conflict",
    sha: "1122334455667788990011223344556677889900",
    changes_count: "24",
    upvotes: 1,
    updated_at: agoIso(6 * 60),
    created_at: agoIso(5 * 24 * 60),
    pipeline: {
      id: 190_500,
      status: "success",
      stages: ["check", "test"],
      jobs: [
        { id: 21, name: "🔎 lint", stage: "check", status: "success", allow_failure: false, duration: 30 },
        { id: 22, name: "🧪 unit", stage: "test", status: "success", allow_failure: false, duration: 88 },
      ],
    },
    discussions: [],
  },
  {
    project_path: "acme/webapp",
    iid: 594,
    title: "🧰 ci(helm): assert live image tags after helmfile apply",
    description: "Superseded by !595.",
    state: "closed",
    draft: false,
    author: MOCK_GITLAB_ME,
    reviewers: [],
    assignees: [],
    labels: ["ci"],
    source_branch: "ci/assert-tags-first-try",
    target_branch: "main",
    detailed_merge_status: "not_open",
    sha: "aa00bb11cc22dd33ee44ff5566778899aabbccdd",
    changes_count: "3",
    upvotes: 0,
    updated_at: agoIso(20 * 60),
    created_at: agoIso(30 * 60),
    closed_at: agoIso(20 * 60),
    pipeline: null,
    discussions: [],
  },
];


/** Put the live pipeline back where it started. */
function resetMockLivePipeline(): void {
  const mr = mockMergeRequestFor("acme/webapp", 596);
  if (!mr) return;
  mr.pipeline = {
    id: 190_933,
    status: "running",
    live: true,
    reads: 0,
    stages: ["check", "test", "deploy"],
    jobs: MOCK_LIVE_PIPELINE_JOBS.map((job) => ({ ...job })),
  };
}

/** When set, every `gitlab_mr_*` WRITE fails with this sentence — the shape GitLab's own
 *  refusal takes. Armed and cleared by the `{kind:"gitlab_mr"}` test hook, because the half
 *  a page owns is that an outward action which failed is reported rather than swallowed. */
let mockGitLabWriteRefusal: string | null = null;

/** When true, the machine holds no GitLab token: the list answers empty and says so, which
 *  is what the page's own notice is drawn from. Same hook. */
let mockGitLabTokenMissing = false;

/** When set, the DIFF read fails with this sentence. Its own switch rather than a share of
 *  `mockGitLabWriteRefusal`, because the two prove opposite halves: a refused write must be
 *  reported beside the button, and a refused diff must cost the Changes panel and nothing
 *  else — the page's other four panels have to stay drawn. Same hook, same contract: a spec
 *  that arms it MUST clear it. */
let mockGitLabDiffRefusal: string | null = null;

/** When set, an UPLOAD read fails with this sentence. Its own switch for the reason the diff's
 *  is: a picture this app cannot fetch must cost that picture and nothing else — the words
 *  around it stay drawn. Same hook, same contract: a spec that arms it MUST clear it. */
let mockGitLabUploadRefusal: string | null = null;

/** The pictures the seeded merge requests point at, keyed the way the markdown names one:
 *  the project, then GitLab's own secret for the file. Each is drawn on demand at the size its
 *  own attribute block claims, so what the page shows is a real picture of the stated shape —
 *  and a secret nobody seeded is a 404, exactly as GitLab answers one. */
const mockUploads = new Map<string, { width: number; height: number; hue: number }>([
  ["acme/webapp:9f3c1e77a4bd42f0b6e5c8d31a7b04e2", { width: 777, height: 312, hue: 214 }],
  ["acme/webapp:1b7d40c9e5f84a2db3608c17ae9f52d4", { width: 420, height: 180, hue: 28 }],
]);

function mockMergeRequestFor(projectPath: string, iid: number): MockMergeRequest | undefined {
  return mockMergeRequests.find((mr) => mr.project_path === projectPath && mr.iid === iid);
}

/** GitLab's own `web_url` for one of these, on the configured host — so the page's approval
 *  read (which is addressed by URL) lands on the same merge request. */
function mockMergeRequestUrl(mr: MockMergeRequest): string {
  const host = mockSettings.gitlab_host.trim() || "gitlab.com";
  return `https://${host}/${mr.project_path}/-/merge_requests/${mr.iid}`;
}

/** One sidebar row. Deliberately WITHOUT a pipeline, like the real list endpoint. */
function mockMergeRequestRow(mr: MockMergeRequest): Record<string, unknown> {
  return {
    project_path: mr.project_path,
    iid: mr.iid,
    reference: `!${mr.iid}`,
    title: mr.title,
    state: mr.state,
    draft: mr.draft,
    web_url: mockMergeRequestUrl(mr),
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    author: mr.author,
    detailed_merge_status: mr.detailed_merge_status,
    labels: mr.labels,
    user_notes_count: mr.discussions.flatMap((d) => d.notes).filter((n) => !n.system).length,
    upvotes: mr.upvotes,
    downvotes: 0,
    updated_at: mr.updated_at,
    created_at: mr.created_at,
  };
}

/** The position a comment on a diff line carried, turned into the shape a READ answers with.
 *
 *  The client sends primitives — a file, two line numbers and a side — and the real backend
 *  spells GitLab's own `position` from them (`gitlab_diff_anchor` in src/bin/server.rs). This
 *  mock does the same translation, so what the page reads back is the shape it would get from
 *  the tenant: only the side a line is really on is stated, and a range of one is a line. */
function mockDiffNotePosition(value: unknown): MockNote["position"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const line = (input: unknown) => {
    if (typeof input !== "object" || input === null) return undefined;
    const end = input as Record<string, unknown>;
    const side = end.side;
    if (typeof end.old !== "number" || typeof end.new !== "number") return undefined;
    return {
      ...(side === "old" || side === "both" ? { old_line: end.old } : {}),
      ...(side === "new" || side === "both" ? { new_line: end.new } : {}),
      ...(side === "old" ? { type: "old" } : side === "new" ? { type: "new" } : {}),
    };
  };
  const anchor = line(raw.line);
  if (!anchor) return undefined;
  const start = line(raw.start);
  return {
    ...(typeof raw.new_path === "string" ? { new_path: raw.new_path } : {}),
    ...(typeof raw.old_path === "string" ? { old_path: raw.old_path } : {}),
    ...anchor,
    ...(start ? { line_range: { start, end: anchor } } : {}),
  };
}

function mockMergeRequestDetail(mr: MockMergeRequest): Record<string, unknown> {
  return {
    ...mockMergeRequestRow(mr),
    description: mr.description,
    assignees: mr.assignees,
    reviewers: mr.reviewers,
    sha: mr.sha,
    // The three commits a comment on a diff LINE is placed against. Without them the diff
    // page offers no comment at all (`diffCommentsAvailable`), so the mock states them for
    // the same reason it states a `sha`: the gate is exercised rather than assumed.
    diff_refs: {
      base_sha: `base-${mr.sha.slice(0, 8)}`,
      head_sha: mr.sha,
      start_sha: `start-${mr.sha.slice(0, 8)}`,
    },
    merge_status: mr.detailed_merge_status === "mergeable" ? "can_be_merged" : "cannot_be_merged",
    has_conflicts: mr.detailed_merge_status === "conflict",
    blocking_discussions_resolved: !mr.discussions.some((d) =>
      d.notes.some((n) => n.resolvable && !n.resolved),
    ),
    squash: false,
    should_remove_source_branch: true,
    changes_count: mr.changes_count,
    merged_at: mr.merged_at,
    closed_at: mr.closed_at,
    pipeline: mr.pipeline
      ? { id: mr.pipeline.id, status: mr.pipeline.status, web_url: `${mockMergeRequestUrl(mr)}/pipelines` }
      : undefined,
  };
}

/** Advance a LIVE pipeline by one step, so a poll shows something happening: the first job
 *  still in flight finishes, the next one starts, and the pipeline settles when none is
 *  left. Called on every pipeline read of that merge request. */
function advanceMockPipeline(pipeline: MockPipeline): void {
  if (!pipeline.live) return;
  const running = pipeline.jobs.find((job) => job.status === "running");
  if (running) {
    running.status = "success";
    running.duration = 30 + running.id * 7;
    const next = pipeline.jobs.find((job) => job.status === "created");
    if (next) next.status = "running";
    else {
      pipeline.status = "success";
      pipeline.live = false;
    }
    return;
  }
  const created = pipeline.jobs.find((job) => job.status === "created");
  if (created) created.status = "running";
  else {
    pipeline.status = "success";
    pipeline.live = false;
  }
}

function mockPipelineView(mr: MockMergeRequest): Record<string, unknown> {
  if (!mr.pipeline) return { jobs: [] };
  const reads = mr.pipeline.reads ?? 0;
  mr.pipeline.reads = reads + 1;
  if (reads > 0) advanceMockPipeline(mr.pipeline);
  return {
    pipeline: {
      id: mr.pipeline.id,
      status: mr.pipeline.status,
      web_url: `${mockMergeRequestUrl(mr)}/pipelines`,
    },
    stages: mr.pipeline.stages ?? [],
    // NEWEST FIRST, which is what the real endpoint answers — measured on this instance: of 25
    // merge requests, 16 came back in reverse stage order and the other 9 had a single stage.
    // The mock used to answer in stage order, which is the one way it could have hidden the bug
    // that shipped: the page drew `install` last on every real pipeline.
    jobs: [...mr.pipeline.jobs].reverse().map((job) => ({
      ...job,
      web_url: `${mockMergeRequestUrl(mr)}/jobs/${job.id}`,
    })),
  };
}

function mockDiscussionList(mr: MockMergeRequest): Record<string, unknown> {
  return { discussions: mr.discussions, truncated: false };
}

// ---- one job's LOG ----------------------------------------------------------
//
// The page a job card opens (§ A job's LOG is a page). The fixture below is written the way the
// RUNNER writes one, because that is the whole of what the page has to read: the marker with its
// carriage return and erase, sections that NEST (a project's own `pnpm_section` inside
// `step_script`), a progress line rewritten in place, and SGR colour — every one of them measured
// by `examples/job_trace_recon.rs` (48 of 58 logs carry sections, 48 of 48 a bare carriage return,
// 35 856 SGR sequences in all).
//
// Four states are reachable here, because each says something different on screen: a FAILED job
// with a rich log, a RUNNING one whose log grows on every read (which is what makes "following"
// reviewable with no CI at all), a `manual` one with NO log, and a log too big to travel whole.

const ESC = "\u001b";
/** One line the way the runner writes a section marker: the marker, a return, the erase, and then
 *  the section's own heading. */
function mockSection(kind: "start" | "end", at: number, name: string, heading = ""): string {
  return `section_${kind}:${at}:${name}\r${ESC}[0K${heading}`;
}

/** The log of the job that FAILED. Everything the renderer has to draw, once. */
const MOCK_FAILED_TRACE = [
  mockSection("start", 1_754_400_000, "prepare_executor", `${ESC}[0;mPreparing the "docker" executor`),
  `Using Docker executor with image ${ESC}[1mnode:22-alpine${ESC}[0m`,
  "Pulling docker image node:22-alpine ...",
  mockSection("end", 1_754_400_009, "prepare_executor"),
  mockSection("start", 1_754_400_009, "get_sources", `${ESC}[32;1m$ git fetch --depth 50${ESC}[0;m`),
  "Checking out e2607442 as detached HEAD...",
  mockSection("end", 1_754_400_013, "get_sources"),
  mockSection("start", 1_754_400_013, "step_script", `${ESC}[32;1m$ pnpm install --frozen-lockfile${ESC}[0;m`),
  mockSection("start", 1_754_400_014, "pnpm_section", "Resolving 812 packages"),
  // One line rewritten in place, which is what a progress bar is: only the last of these shows.
  `Progress: 12%\rProgress: 48%\r${ESC}[0KProgress: 100%`,
  `${ESC}[38;5;208mwarn${ESC}[0m two peer dependencies are unmet`,
  mockSection("end", 1_754_400_061, "pnpm_section"),
  mockSection("start", 1_754_400_061, "unit_tests_section", `${ESC}[32;1m$ pnpm vitest run${ESC}[0;m`),
  " ✓ src/lib/gitlab-mr.test.ts (34 tests) 118ms",
  " ✓ src/lib/gitlab-diff.test.ts (41 tests) 204ms",
  ` ${ESC}[31m✗${ESC}[0m src/lib/gitlab-job-log.test.ts (19 tests | 1 failed)`,
  `   ${ESC}[31;1mAssertionError${ESC}[0m: expected 4 to be 26`,
  `    at ${ESC}[36msrc/lib/gitlab-job-log.test.ts:54:11${ESC}[0m`,
  mockSection("end", 1_754_400_142, "unit_tests_section"),
  mockSection("end", 1_754_400_142, "step_script"),
  mockSection("start", 1_754_400_142, "upload_artifacts_on_failure", "Uploading artifacts..."),
  "coverage/: found 214 matching artifact files and directories",
  mockSection("end", 1_754_400_148, "upload_artifacts_on_failure"),
  mockSection("start", 1_754_400_148, "cleanup_file_variables", "Cleaning up project directory"),
  mockSection("end", 1_754_400_149, "cleanup_file_variables"),
  `${ESC}[31;1mERROR: Job failed: exit code 1${ESC}[0;m`,
  "",
].join("\n");

/** The log of the RUNNING job, as the lines it has written so far. Each read of it adds one, so
 *  the page can be watched following a live log with no CI anywhere. */
const MOCK_RUNNING_LINES = [
  mockSection("start", 1_754_400_200, "prepare_executor", `${ESC}[0;mPreparing the "docker" executor`),
  "Using Docker executor with image node:22-alpine",
  mockSection("end", 1_754_400_206, "prepare_executor"),
  mockSection("start", 1_754_400_206, "step_script", `${ESC}[32;1m$ pnpm vitest run${ESC}[0;m`),
  " ✓ src/lib/protocol.test.ts (52 tests) 96ms",
  " ✓ src/lib/rich-text.test.ts (88 tests) 141ms",
  " ✓ src/lib/agent-run.test.ts (26 tests) 88ms",
  " ✓ src/lib/call-stage.test.ts (31 tests) 74ms",
  ` ${ESC}[32m✓${ESC}[0m src/lib/gitlab-pipeline-graph.test.ts (23 tests) 61ms`,
];

/** How many lines of the running job's log have been handed out so far. It only ever grows, like
 *  a real one — and the `{kind:"gitlab_mr", clear:true}` hook puts it back, because one mock
 *  process serves the whole run. */
let mockRunningLogLines = 5;

/** When set, the JOB LOG read fails with this sentence. Its own switch beside the diff's, for the
 *  same reason: this page IS that read, so a refusal has to be reachable on its own. */
let mockGitLabJobLogRefusal: string | null = null;

/** When set, the JOB answers in full and its LOG does not — the shape GitLab takes when a trace
 *  file is gone (404 on the trace, 200 on the job). Its own switch, because the page must say that
 *  rather than "this job printed nothing": one is a fact about the job, the other about this app. */
let mockGitLabTraceRefusal: string | null = null;

/** When true, the job log answers as the TAIL of something much bigger — the state a reader has to
 *  be told about, because the top of the log is missing and no Range read can ask for it. */
let mockGitLabJobLogTruncated = false;

function resetMockJobLogs(): void {
  mockRunningLogLines = 5;
  mockGitLabJobLogRefusal = null;
  mockGitLabTraceRefusal = null;
  mockGitLabJobLogTruncated = false;
}

/** One job's log, the way the backend answers it (`gitlab_mr::JobLog`). */
function mockJobLog(mr: MockMergeRequest, jobId: number): Record<string, unknown> {
  const job = mr.pipeline?.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("GitLab has no job there, or the token cannot see it");
  const finished = job.status === "success" || job.status === "failed" || job.status === "canceled";
  const trace =
    job.status === "failed"
      ? MOCK_FAILED_TRACE
      : job.status === "running"
        ? `${MOCK_RUNNING_LINES.slice(0, Math.min(mockRunningLogLines++, MOCK_RUNNING_LINES.length)).join("\n")}\n`
        : job.status === "success"
          ? `${MOCK_RUNNING_LINES.join("\n")}\n${ESC}[32;1mJob succeeded${ESC}[0;m\n`
          : // `manual`, `created`, `skipped`: GitLab answers 200 with an empty body, and the page
            // says WHY rather than drawing a blank screen.
            "";
  return {
    job: {
      id: job.id,
      name: job.name,
      stage: job.stage,
      status: job.status,
      allow_failure: job.allow_failure,
      ...(job.duration === undefined ? {} : { duration: job.duration }),
      ...(finished || job.status === "running"
        ? {
            queued_duration: 2.7,
            started_at: agoIso(6),
            runner: "shared-runner-04 (docker)",
          }
        : {}),
      ...(finished ? { finished_at: agoIso(3) } : {}),
      ...(job.status === "failed" ? { failure_reason: "script_failure" } : {}),
      created_at: agoIso(8),
      web_url: `${mockMergeRequestUrl(mr)}/jobs/${job.id}`,
      pipeline_id: mr.pipeline?.id,
    },
    trace: mockGitLabTraceRefusal ? "" : trace,
    // GitLab's own byte count, which is bigger than what travelled whenever a log was cut.
    bytes: mockGitLabJobLogTruncated ? 4_194_304 : trace.length,
    truncated: mockGitLabJobLogTruncated && trace.length > 0 && !mockGitLabTraceRefusal,
    complete: finished,
    ...(mockGitLabTraceRefusal ? { trace_error: mockGitLabTraceRefusal } : {}),
  };
}

// ---- the diff ---------------------------------------------------------------
//
// The Changes section reads what a merge request changed, and the mock has to reproduce every
// state a real answer holds — because four of the five are files with NO patch, and each says
// something different (see `diffFileState` in web/src/lib/gitlab-diff.ts). Measured on the
// real instance by `examples/merge_request_diff_recon.rs`: of 508 files over 25 merge
// requests, 356 carried a patch, 18 were pure renames, 4 were binary and 148 were collapsed
// by GitLab. So the fixture below holds one of each, plus a generated file and a directory
// deep enough for the tree to have something to fold.
//
// The PATCH is a complete unified diff, header and all — the shape `gitlab_mr::unified_patch`
// writes, never GitLab's bare hunks, because the page's renderer parses the header to learn
// what happened to the file.

/** One file of a mock diff, in the shape the backend answers with. */
type MockDiffFile = {
  path: string;
  old_path?: string;
  change: "new" | "deleted" | "renamed" | "changed";
  patch?: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Whether GitLab would refuse to expand it. Its patch is dropped by `mockDiffFor` unless
   *  the reader asks for the expanded read, which is the whole flow this reproduces. */
  collapsed?: boolean;
  generated?: boolean;
};

/** The files each mock merge request changed, keyed the way the reads address it.
 *
 *  Deliberately several languages: the renderer resolves a Shiki grammar per extension, so a
 *  fixture of one language would never exercise a second load. */
const mockDiffFiles = new Map<string, MockDiffFile[]>([
  [
    "acme/webapp!596",
    [
      {
        path: "charts/user-facing/values.yaml",
        change: "changed",
        additions: 6,
        deletions: 2,
        patch:
          "diff --git a/charts/user-facing/values.yaml b/charts/user-facing/values.yaml\n" +
          "--- a/charts/user-facing/values.yaml\n" +
          "+++ b/charts/user-facing/values.yaml\n" +
          "@@ -12,8 +12,12 @@ web:\n" +
          "   image:\n" +
          "     repository: registry.acme.dev/web\n" +
          '     tag: "1.42.0"\n' +
          "-  replicaCount: 1\n" +
          "+  replicaCount: 2\n" +
          "+  podDisruptionBudget:\n" +
          "+    minAvailable: 1\n" +
          "   resources:\n" +
          "     requests:\n" +
          "-      cpu: 100m\n" +
          "+      cpu: 250m\n" +
          "+      memory: 256Mi\n" +
          "+  terminationGracePeriodSeconds: 30\n" +
          " \n" +
          " api:\n",
      },
      {
        path: "charts/user-facing/templates/pdb.yaml",
        change: "new",
        additions: 12,
        deletions: 0,
        patch:
          "diff --git a/charts/user-facing/templates/pdb.yaml b/charts/user-facing/templates/pdb.yaml\n" +
          "new file mode 100644\n" +
          "--- /dev/null\n" +
          "+++ b/charts/user-facing/templates/pdb.yaml\n" +
          "@@ -0,0 +1,12 @@\n" +
          "+{{- range $name, $svc := .Values.services }}\n" +
          "+{{- if $svc.podDisruptionBudget }}\n" +
          "+apiVersion: policy/v1\n" +
          "+kind: PodDisruptionBudget\n" +
          "+metadata:\n" +
          "+  name: {{ $name }}\n" +
          "+spec:\n" +
          "+  minAvailable: {{ $svc.podDisruptionBudget.minAvailable }}\n" +
          "+  selector:\n" +
          "+    matchLabels:\n" +
          "+      app: {{ $name }}\n" +
          "+{{- end }}\n" +
          "+{{- end }}\n",
      },
      {
        path: "src/server/health.ts",
        change: "changed",
        additions: 9,
        deletions: 3,
        patch:
          "diff --git a/src/server/health.ts b/src/server/health.ts\n" +
          "--- a/src/server/health.ts\n" +
          "+++ b/src/server/health.ts\n" +
          "@@ -1,10 +1,16 @@\n" +
          // The leading space is a context line's own mark, and GitLab sends one on every
          // unchanged line. Without it this fixture is not a patch the tenant could answer
          // with, and a line number read off it would be one out.
          ' import type { Server } from "./types";\n' +
          " \n" +
          "-export function health(server: Server) {\n" +
          "-  return server.ready ? 200 : 503;\n" +
          "+/** Whether this replica may take traffic.\n" +
          "+ *\n" +
          "+ * A draining replica answers 503 while it finishes the connections it holds, so the\n" +
          "+ * load balancer stops sending it new ones before the pod goes. */\n" +
          "+export function health(server: Server): number {\n" +
          "+  if (server.draining) return 503;\n" +
          "+  if (!server.ready) return 503;\n" +
          "+  return 200;\n" +
          " }\n" +
          " \n" +
          "-export const READY_PATH = \"/ready\";\n" +
          "+export const READY_PATH = \"/readyz\";\n" +
          "+export const LIVE_PATH = \"/livez\";\n",
      },
      // A pure RENAME: no hunks at all, so the header IS the change. Measured on 18 of 508
      // files, several of which GitLab also flagged `collapsed` — which is exactly what the
      // page must not read as an elision.
      {
        path: "src/server/drain.ts",
        old_path: "src/server/shutdown.ts",
        change: "renamed",
        additions: 0,
        deletions: 0,
        patch:
          "diff --git a/src/server/shutdown.ts b/src/server/drain.ts\n" +
          "similarity index 100%\n" +
          "rename from src/server/shutdown.ts\n" +
          "rename to src/server/drain.ts\n",
      },
      // A BINARY file: GitLab describes it with one sentence rather than hunks, and this page
      // states that rather than running its prose through a code renderer.
      {
        path: "docs/diagrams/rollout.png",
        change: "new",
        additions: 0,
        deletions: 0,
        binary: true,
      },
      // A file GitLab COLLAPSED. Its patch exists here and is withheld until the reader asks
      // for the expanded read — which is the flow `canExpandDiff` gates.
      {
        path: "bun.lock",
        change: "changed",
        additions: 4,
        deletions: 4,
        collapsed: true,
        generated: true,
        patch:
          "diff --git a/bun.lock b/bun.lock\n" +
          "--- a/bun.lock\n" +
          "+++ b/bun.lock\n" +
          "@@ -204,8 +204,8 @@\n" +
          '     "@types/node": {\n' +
          '-      "version": "22.9.0",\n' +
          '-      "resolved": "https://registry.npmjs.org/@types/node/-/node-22.9.0.tgz",\n' +
          '+      "version": "22.10.2",\n' +
          '+      "resolved": "https://registry.npmjs.org/@types/node/-/node-22.10.2.tgz",\n' +
          '     },\n' +
          '     "typescript": {\n' +
          '-      "version": "5.6.3",\n' +
          '+      "version": "5.7.2",\n' +
          '     },\n',
      },
      {
        path: "docs/runbooks/old-drain.md",
        change: "deleted",
        additions: 0,
        deletions: 5,
        patch:
          "diff --git a/docs/runbooks/old-drain.md b/docs/runbooks/old-drain.md\n" +
          "deleted file mode 100644\n" +
          "--- a/docs/runbooks/old-drain.md\n" +
          "+++ /dev/null\n" +
          "@@ -1,5 +0,0 @@\n" +
          "-# Draining a node by hand\n" +
          "-\n" +
          "-1. `kubectl drain <node>`\n" +
          "-2. wait for the last pod to go\n" +
          "-3. hope\n",
      },
    ],
  ],
  [
    "acme/infra!297",
    [
      {
        path: "terraform/lambda/policy.tf",
        change: "changed",
        additions: 5,
        deletions: 1,
        patch:
          "diff --git a/terraform/lambda/policy.tf b/terraform/lambda/policy.tf\n" +
          "--- a/terraform/lambda/policy.tf\n" +
          "+++ b/terraform/lambda/policy.tf\n" +
          '@@ -8,7 +8,11 @@ data "aws_iam_policy_document" "lambda" {\n' +
          "   statement {\n" +
          '     effect  = "Allow"\n' +
          '-    actions = ["s3:GetObject"]\n' +
          '+    actions = [\n' +
          '+      "s3:GetObject",\n' +
          '+      "s3:ListBucket",\n' +
          "+    ]\n" +
          '+    resources = [aws_s3_bucket.uploads.arn]\n' +
          "   }\n" +
          " }\n",
      },
    ],
  ],
]);

/** What one merge request changed, at one depth.
 *
 *  The COLLAPSE is reproduced the way GitLab really behaves: the plain read withholds the
 *  patch of every collapsed file and counts them, and the expanded read hands them over. That
 *  is the whole reason this mock has a diff at all — the flow behind `canExpandDiff` cannot be
 *  seen from a fixture where every file has its patch. */
function mockDiffFor(mr: MockMergeRequest, depth: "listed" | "raw"): Record<string, unknown> {
  const source = mockDiffFiles.get(`${mr.project_path}!${mr.iid}`) ?? [];
  const expanded = depth === "raw";
  const files = source.map((file) => {
    const withheld = file.collapsed === true && !expanded;
    return {
      path: file.path,
      ...(file.old_path ? { old_path: file.old_path } : {}),
      change: file.change,
      // A binary file never has a patch at either depth: GitLab will not diff one.
      ...(file.binary || withheld || !file.patch ? {} : { patch: file.patch }),
      additions: withheld ? 0 : file.additions,
      deletions: withheld ? 0 : file.deletions,
      binary: file.binary === true,
      collapsed: withheld,
      generated: file.generated === true,
    };
  });
  return {
    files,
    total: files.length,
    truncated: false,
    collapsed: files.filter((file) => file.collapsed).length,
    expanded,
  };
}

/** Tell every open page that one merge request moved — the same `stale` frame the real
 *  backend broadcasts after a write, which is what makes a second page follow. */
function broadcastMockMergeRequest(mr: MockMergeRequest): void {
  broadcast("gitlab_mr_updated", {
    project_path: mr.project_path,
    iid: mr.iid,
    kind: "stale",
  });
}

type LinearKind = "issue" | "project" | "document";
type ParsedLinear = { kind: LinearKind; id: string };

/** Parse a Linear web URL into a supported resource, mirroring src/linear.rs. The
 *  path is `/<workspace>/<kind>/<id>`; an issue is named by its identifier, a
 *  project and a document by the slug id ending their segment. */
function parseLinearUrl(url: string): ParsedLinear | null {
  const match = url.match(/^https:\/\/([^/?#]+)([^?#]*)/i);
  if (!match) return null;
  const host = (match[1]!.split("@").pop() ?? "").split(":")[0]!.toLowerCase();
  if (host !== "linear.app") return null;

  const segments = (match[2] ?? "").split("/").filter(Boolean);
  const [, kind, id] = segments;
  if (!kind || !id) return null;

  if (kind === "issue") {
    return /^[a-z0-9]+-\d+$/i.test(id) ? { kind: "issue", id: id.toUpperCase() } : null;
  }
  if (kind !== "project" && kind !== "document") return null;
  const slugId = id.split("-").pop() ?? "";
  return /^[0-9a-f]{8,36}$/.test(slugId) ? { kind, id: slugId } : null;
}

/** The Linear twin of LONG_GITLAB_PATH: the one seeded issue whose title, team and
 *  project are as long as a real workspace's, since that context line is what a
 *  phone-width card has to shrink. */
const LONG_LINEAR_ISSUE = "ENG-247";

/** Deterministic metadata for a parsed Linear URL — canned, but varied by the
 *  issue number so the UI shows realistic, distinct cards without any workspace.
 *  Returns null when no key is configured, matching the real module: Linear has no
 *  anonymous read, so an unconfigured integration enriches nothing. */
function mockLinearMetadata(url: string): Record<string, unknown> | null {
  const parsed = parseLinearUrl(url);
  if (!parsed || mockSettings.linear_token.length === 0) return null;

  if (parsed.kind === "issue") {
    const number = Number(parsed.id.split("-").pop());
    const long = parsed.id === LONG_LINEAR_ISSUE;
    // One issue per state category, so every icon and tint is exercised.
    const states = [
      { name: "Backlog", type: "backlog", color: "#bec2c8" },
      { name: "Todo", type: "unstarted", color: "#e2e2e2" },
      { name: "In Progress", type: "started", color: "#f2c94c" },
      { name: "Done", type: "completed", color: "#5e6ad2" },
      { name: "Canceled", type: "canceled", color: "#95a2b3" },
    ];
    const state = states[number % states.length]!;
    return {
      provider: "linear",
      kind: "issue",
      url,
      identifier: parsed.id,
      title: long
        ? `Freeze every action on an archived trace, replay included (${parsed.id})`
        : `Show Linear links as rich cards (${parsed.id})`,
      team: long ? "Platform infrastructure" : "Engineering",
      state: state.name,
      state_type: state.type,
      state_color: state.color,
      // People, not bare names, exactly as the Rust `LinkMetadata` carries them — and one of
      // them is somebody this mock's own Teams knows, so a Linear card is reviewable with a
      // real face on it (see `withMockTeamsPeople`).
      assignee: long
        ? { name: "Charlotte Dubois", username: "charlotte.dubois" }
        : { name: "Mia Chen", username: "mia.chen" },
      // ENG-1 is urgent, ENG-2 high, the rest unbadged — see `badgedPriority`.
      priority: number % 5,
      priority_label: ["No priority", "Urgent", "High", "Medium", "Low"][number % 5],
      project: long ? "Dead-letter queue replay pipeline" : "Chat integrations",
      ...(number % 3 === 0 ? { parent: "ENG-100" } : {}),
      labels: [
        { name: "frontend", color: "#bb87fc" },
        { name: "enhancement", color: "#4cb782" },
      ],
      description:
        "A bare Linear URL says nothing; show the title, the state and who owns it.",
      due_date: "2026-09-11",
    };
  }
  if (parsed.kind === "project") {
    return {
      provider: "linear",
      kind: "project",
      url,
      identifier: "",
      title: "Chat integrations",
      team: "Engineering, Platform",
      state: "In Progress",
      state_type: "started",
      state_color: "#f2c94c",
      // Somebody only Linear knows: the other shape, on the card beside it.
      lead: { name: "Grace Hopper", username: "grace" },
      progress: 0.42,
      target_date: "2026-10-02",
      description: "Bring the trackers the team lives in into the chat itself.",
    };
  }
  return {
    provider: "linear",
    kind: "document",
    url,
    identifier: "",
    title: "Link previews — system design",
    creator: { name: "Ada Lovelace", username: "ada" },
    project: "Chat integrations",
    description: "How a link in a message becomes a card, and what each provider knows.",
  };
}

// ---------------------------------------------------------------------------
// WebSocket plumbing.
// ---------------------------------------------------------------------------

type Socket = ServerWebSocket<unknown>;

/** Every connected UI, so events can be fanned out to all of them. */
const sockets = new Set<Socket>();

function sendJson(ws: Socket, value: unknown): void {
  try {
    ws.send(JSON.stringify(value));
  } catch {
    /* socket went away mid-send; ignore */
  }
}

/** Fan an event out to every connected client. */
function broadcast(event: string, data: unknown): void {
  const frame = JSON.stringify({ event, data });
  for (const ws of sockets) {
    try {
      ws.send(frame);
    } catch {
      /* ignore a dead socket; close() will clean it up */
    }
  }
}

// ---- request parameter helpers (lenient; never throw on shape, only on missing) ----

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireString(params: unknown, key: string): string {
  const v = asObject(params)[key];
  if (typeof v !== "string") throw new Error(`missing param: ${key}`);
  return v;
}

function requireNumber(params: unknown, key: string): number {
  const v = asObject(params)[key];
  if (typeof v !== "number") throw new Error(`missing param: ${key}`);
  return v;
}

/** Parse the optional reply metadata, tolerating partial shapes. */
function parseReplyTo(value: unknown): ReplyTo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  return {
    compose_time: typeof o.compose_time === "number" ? o.compose_time : Date.now(),
    sender: typeof o.sender === "string" ? o.sender : "",
    sender_mri: typeof o.sender_mri === "string" ? o.sender_mri : "",
    preview: typeof o.preview === "string" ? o.preview : "",
    before: typeof o.before === "string" ? o.before : "",
    after: typeof o.after === "string" ? o.after : "",
  };
}

/** Parse the optional `images` list the way the real backend's `parse_send_images` does:
 *  every entry a whole image, at most `MAX_SEND_IMAGES` of them, weighing no more than
 *  `MAX_SEND_IMAGES_TOTAL_BYTES` together — and never the single-`image` shape a page from
 *  before this feature sends, which must be refused rather than silently dropped. */
function parseSendImages(params: Record<string, unknown>): SendImage[] {
  if (params.image !== undefined && params.image !== null) {
    throw new Error("this page is too old to send pictures — reload it and try again");
  }
  const value = params.images;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("invalid images param");
  if (value.length > MAX_SEND_IMAGES) throw new Error("too many images in one message");
  const images = value.map(parseSendImage);
  const bytes = images.reduce((total, image) => total + decodedBytes(image.data_base64), 0);
  if (bytes > MAX_SEND_IMAGES_TOTAL_BYTES) {
    throw new Error("those images add up to more than 30 MiB");
  }
  return images;
}

/** How many bytes a base64 payload decodes to, without decoding it. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Parse one image of that list strictly, so protocol drift fails a test instead of
 *  producing a misleading echo. */
function parseSendImage(value: unknown): SendImage {
  const o = asObject(value);
  if (typeof o.name !== "string" || o.name.length === 0) {
    throw new Error("invalid image param: name");
  }
  if (typeof o.content_type !== "string" || !o.content_type.startsWith("image/")) {
    throw new Error("invalid image param: content_type");
  }
  if (typeof o.data_base64 !== "string" || o.data_base64.length === 0) {
    throw new Error("invalid image param: data_base64");
  }
  const width = typeof o.width === "number" ? o.width : undefined;
  const height = typeof o.height === "number" ? o.height : undefined;
  return {
    name: o.name,
    content_type: o.content_type,
    data_base64: o.data_base64,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

/** Parse the optional `mentions` list the way the real backend does: a person MRI, a
 *  name to show, and an itemid no other mention repeats. A bad entry is an error here
 *  too — a mention that names nobody would be a message pinging nobody. */
function parseSendMentions(value: unknown): OutboundMention[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("invalid mentions param");
  const out: OutboundMention[] = [];
  for (const entry of value) {
    const o = asObject(entry);
    if (typeof o.itemid !== "number" || !Number.isInteger(o.itemid) || o.itemid < 0) {
      throw new Error("invalid mention param: itemid");
    }
    if (typeof o.mri !== "string" || !o.mri.startsWith("8:")) {
      throw new Error("invalid mention param: mri");
    }
    if (typeof o.display_name !== "string" || o.display_name.trim().length === 0) {
      throw new Error("invalid mention param: display_name");
    }
    if (out.some((m) => m.itemid === o.itemid)) throw new Error("duplicate mention itemid");
    out.push({ itemid: o.itemid, mri: o.mri, display_name: o.display_name });
  }
  return out;
}

/** Build the AMS inline-image HTML Teams returns after a successful upload. */
function sentImageContent(image: SendImage): string {
  nextSentImage += 1;
  const objectId = `mock-sent-image-${nextSentImage}`;
  const url = `https://eu-api.asm.skype.com/v1/objects/${objectId}/views/imgo`;
  return (
    `<p><img itemtype="http://schema.skype.com/AMSImage" ` +
    `src="${url}" alt="${escapeHtml(image.name)}"></p>`
  );
}

// ---- next sequence / message id for freshly created messages ----

/** Next seq for an ascending-by-seq message array. */
function nextSeq(messages: ChatMessage[]): number {
  return (messages.at(-1)?.seq ?? 0) + 1;
}

// ---- unified thread accessor (chat conversation OR team channel) ----

/** A message-bearing thread: a chat conversation or a team channel. The message
 *  pipeline (open/backfill/send/edit/react/set_draft) is shared and keys on the
 *  thread id, never caring which kind it is — exactly like the Rust core, where
 *  channel messages live in the same `messages` table. Only the sidebar-summary
 *  target and the "changed" event that follows a mutation differ per kind. */
type Thread = {
  messages: ChatMessage[];
  participants: Person[];
  getDraft: () => string;
  setDraft: (text: string) => void;
  setRead: (read: boolean) => void;
  /** Mark the thread read up to its newest message. `ghost` records that Teams was
   *  never told, which is what the sidebar's ghost icon reflects. */
  markRead: (ghost: boolean) => void;
  recompute: () => void;
  changedEvent: "conversations_changed" | "channels_changed";
};

/** Resolve a thread id to its handle, checking chats first then channels. */
function threadFor(id: string): Thread | null {
  const cs = store.get(id);
  if (cs) {
    return {
      messages: cs.messages,
      participants: cs.participants,
      getDraft: () => cs.conv.draft,
      setDraft: (text) => {
        cs.conv.draft = text;
      },
      setRead: (read) => {
        cs.conv.is_read = read;
      },
      markRead: (ghost) => {
        cs.conv.is_read = true;
        cs.conv.is_ghost_read = ghost;
      },
      recompute: () => recomputeSummary(cs),
      changedEvent: "conversations_changed",
    };
  }
  const chs = channelStore.get(id);
  if (chs) {
    return {
      messages: chs.messages,
      participants: chs.participants,
      getDraft: () => chs.channel.draft,
      setDraft: (text) => {
        chs.channel.draft = text;
      },
      setRead: (read) => {
        chs.channel.is_read = read;
      },
      markRead: (ghost) => {
        chs.channel.is_read = true;
        chs.channel.is_ghost_read = ghost;
      },
      recompute: () => recomputeChannelSummary(chs),
      changedEvent: "channels_changed",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Method dispatch — returns the `result` value or throws (message → error).
// ---------------------------------------------------------------------------

// Activity streams — the three Teams system feeds the `notifications` method
// returns, one per tab: Activity (`48:notifications`, the superset of reactions/
// mentions/replies directed at "me"), Mentions (`48:mentions`), and Following
// (`48:threads`). The real backend decodes each from `properties.activity`; the
// mock serves a small static sample per stream keyed to real seeded conversations
// (so selecting an entry opens a live chat), plus anything injected via the test
// hook (which lands in Activity).
type MockNotification = {
  id: string;
  activity_type: string;
  activity_subtype: string;
  actor_name: string;
  actor_mri: string;
  source_thread_id: string;
  source_message_id: string;
  /** The source conversation's title, shown as context in Mentions/Following;
   *  "" for reactions on 1:1 chats (no topic). */
  source_thread_topic: string;
  preview: string;
  timestamp: number;
  count: number;
  is_read: boolean;
};

/** One activity stream plus its unread count (mirrors protocol.ts
 *  `NotificationFeed`). */
type MockFeed = { unread: number; items: MockNotification[] };

const injectedNotifications: MockNotification[] = [];

// ---------------------------------------------------------------------------
// Read receipts ("seen by") — mirrors protocol.ts `ReadReceipt`. Empty by
// default so opening a conversation shows no avatars until a test injects one
// via POST /__test/emit {kind:"read_receipt"}; the RPC and the live event both
// read from this same per-conversation store, keyed by member MRI.
// ---------------------------------------------------------------------------

type ReadReceipt = {
  member_mri: string;
  member: string;
  last_read_message_id: string;
  read_time_ms: number;
};

const injectedReceipts = new Map<string, Map<string, ReadReceipt>>();

/** The broker health the mock reports, or null for "healthy and never announced".
 *  Null is the default so every existing spec keeps seeing an app with no banner.
 *  HELD rather than only broadcast, so a reconnect replays it exactly as the Rust
 *  backend replays its own state in the greeting. */
let mockBrokerStatus: {
  ok: boolean;
  signature: string;
  message: string;
  detail: string;
  consecutive_failures: number;
  can_repair: boolean;
  repairing: boolean;
} | null = null;

// ---- a pending update (see src/update.rs, and update-button.tsx) ---------------
// The whole two-click flow with no GitHub and no binary: a release that exists, a
// download that takes a couple of seconds, and an install that cannot restart anything
// because there is nothing here to restart. That last part is not a shortcut — it is the
// `installed` phase the real backend reports when nothing put the app back up, so the
// mock exercises a real state rather than pretending a restart happened.

/** The download a mock release claims, in bytes. The size of the real asset, measured on
 *  the published release (133,429,376 B), so the button's "Downloads 133 MB." line reads
 *  like the one a user sees. */
const MOCK_UPDATE_SIZE = 133 * 1024 * 1024;
/** How long a mock download takes, and how often it reports. Two seconds is long enough
 *  to screenshot the bar mid-transfer and short enough that a spec waits on nothing. */
const MOCK_DOWNLOAD_MS = 2000;
const MOCK_DOWNLOAD_TICK_MS = 100;

/** What this mock answers `write_lock_status` with.
 *
 *  `held` by default, which is the truth for a page driving the mock: this backend gates
 *  nothing, so nothing it presses is refused. The other states are armed by
 *  `{kind: "write_lock", state: …}` so the banner they draw can be looked at and pinned —
 *  a spec MUST put it back (`{kind: "write_lock", reset: true}`), because one mock process
 *  serves the whole run and a banner left armed sits in every later sidebar. */
let mockWriteLockState: "held" | "foreign" | "read_only" = "held";
let mockWriteLockPinned = true;

/** The update the mock reports, or null for "this build is current" — the default, so
 *  every existing spec keeps seeing a sidebar with no update row. Armed through the test
 *  hook (`{kind: "update"}`), exactly like the broker status, and HELD rather than only
 *  broadcast so a reconnect replays it the way the Rust backend replays its own. */
let mockUpdate: {
  current: string;
  latest: string;
  url: string;
  size: number;
  can_install: boolean;
  changes: typeof MOCK_UPDATE_CHANGES | null;
} | null = null;

/** What the mock update brings, in the shape `changelog::Changelog` serializes to.
 *
 *  Written in the project's own commit style, with a scope on most entries and one without,
 *  because the panel draws those two differently. Every group the backend can produce is
 *  NOT here on purpose — this is one ordinary update, and a spec that wants the truncation
 *  line arms `changes_omitted`. */
const MOCK_UPDATE_CHANGES = {
  groups: [
    {
      title: "New",
      changes: [
        { scope: "calendar", summary: "join a meeting from the event it belongs to" },
        { scope: "mail", summary: "draw a sender's own mark beside their name" },
      ],
    },
    {
      title: "Fixed",
      changes: [
        { scope: "media", summary: "never let a sender's own words name a file on disk" },
        { scope: "history", summary: "keep the scroll still while a tall row measures" },
        { summary: "stop a refused send from looking like it went out" },
      ],
    },
    {
      title: "Documented",
      changes: [{ scope: "calling", summary: "map video and screen sharing" }],
    },
  ],
  total: 6,
  omitted: 0,
};

/** How far the mock update has got. Mirrors `UpdateSlot` in src/bin/server.rs, including
 *  that the phase is replayed on connect whenever it is not `idle`. */
let mockUpdateProgress = {
  phase: "idle" as "idle" | "downloading" | "ready" | "restarting" | "installed" | "failed",
  received: 0,
  total: 0,
  error: "",
};
let mockDownloadTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Make the NEXT download fail, once (armed with `{kind: "update", fail_once: true}`).
 *
 * The state the user was really stuck in: `latest` is a rolling tag, its asset was replaced
 * while the app was up, and the transfer was checked against the size measured at startup —
 * so every attempt failed on a number that could never match again. The backend heals that
 * by re-reading the release before every attempt (`fetch_release_asset` in
 * src/bin/server.rs); this is the other half, and the half a page owns: a failure the user
 * is shown must be one the button can really recover from.
 */
let mockUpdateFailsOnce = false;

/** The failure the user was shown, word for word from `size_mismatch` in src/update.rs, so
 *  the mock exercises the message the app really has to fit in that row. */
const MOCK_REPLACED_RELEASE_ERROR =
  "the release was replaced while it was being fetched (134092928 bytes, not 134088832)";

/** What Settings › This app is armed to answer (the `{kind: "maintenance"}` test hook).
 *
 *  `check` overrides what `update_check` reports — every outcome but "available"/"current"
 *  needs arming, because those two are the only ones the mock can be genuinely in. `runs` is
 *  how many agent replies the pretend backend is writing, which is what makes the armed
 *  "Restart anyway" reachable; `refuse` is the shape with no launcher and no supervisor, the
 *  one refusal the user cannot press through.
 *
 *  A spec MUST reset it (`{kind: "maintenance", reset: true}`): one mock process serves the
 *  whole run, and a backend armed to refuse a restart is one every later spec inherits. */
let mockMaintenance: {
  check: string | null;
  runs: number;
  refuse: boolean;
} = { check: null, runs: 0, refuse: false };

/** The refusal a hand-started backend really gives, word for word from
 *  `restart::NOTHING_WOULD_RESTART_IT` — with the RPC name the socket prefixes it with, so
 *  the mock exercises the stripping `lib/maintenance.ts` does. */
const MOCK_NO_RESTARTER_ERROR =
  "restart_backend: refused: nothing here would start this backend again — it was started " +
  "by hand, so restart it the way it was started";

/** Why a check could not be made, for the `failed` outcome. The transport's own words, since
 *  that is what `update::fetch_release` propagates. */
const GITHUB_UNREACHABLE = "error sending request for url (https://api.github.com/…)";

/** How long the mock waits before it drops the sockets on an accepted restart.
 *
 *  The answer to the RPC travels on the socket the restart takes down, exactly as it does in
 *  the real backend (`RESTART_ANSWER_GRACE` in src/bin/server.rs) — so a mock that closed
 *  them inside the handler would swallow the reply and the page would never leave "asking". */
const MOCK_RESTART_ANSWER_MS = 150;

/** Put the update back to "nothing has been asked of it", timers included. One mock
 *  process serves a whole E2E run, so a download left in flight would report progress
 *  into the next spec. */
function resetMockUpdate(): void {
  if (mockDownloadTimer) clearInterval(mockDownloadTimer);
  mockDownloadTimer = null;
  mockUpdateProgress = { phase: "idle", received: 0, total: mockUpdate?.size ?? 0, error: "" };
}

function broadcastUpdateProgress(): void {
  broadcast("update_progress", { ...mockUpdateProgress });
}

/** Upsert one member's read position for a conversation (newest write wins),
 *  returning the stored receipt so the caller can broadcast it. */
function setReceipt(conversationId: string, receipt: ReadReceipt): ReadReceipt {
  let byMri = injectedReceipts.get(conversationId);
  if (!byMri) {
    byMri = new Map();
    injectedReceipts.set(conversationId, byMri);
  }
  byMri.set(receipt.member_mri, receipt);
  return receipt;
}

// Stable base time for the static sample — captured once so repeated
// `notifications` calls return identical timestamps (a per-call Date.now() would
// drift forward and spuriously re-mark entries unread after the panel is seen).
const NOTIFICATIONS_BASE = Date.now();

/** Build the three activity streams. Message ids are `${convId}#${seq}` and every
 *  thread seeds 120 messages, so targeting seq 90..100 lands on a real, non-bottom
 *  message (the newest page is seq 81..120) — opening the entry scrolls up to it.
 *  Group chats are at indices 26.. in `order`, so mention/following samples point
 *  there and set a matching topic; reactions on 1:1s carry no topic. */
function buildNotificationFeeds(): {
  activity: MockNotification[];
  mentions: MockNotification[];
  following: MockNotification[];
} {
  const now = NOTIFICATIONS_BASE;
  const thread = (i: number) => order[i] ?? order[0] ?? "";
  const msg = (i: number, seq: number) => `${thread(i)}#${seq}`;
  // The seeded group chats, by name -> index in `order` (26 one-on-ones precede
  // them), so a mention/following entry both opens the right chat and shows a
  // topic that matches it.
  const platform = 26; // "Platform Team"
  const incident = 29; // "Incident Response"
  const frontend = 28; // "Frontend Guild"

  const reactions: MockNotification[] = [
    {
      id: "act-sample-1",
      activity_type: "reactionInChat",
      activity_subtype: "laugh",
      actor_name: "Riley Carter",
      actor_mri: "8:orgid:riley",
      source_thread_id: thread(0),
      source_message_id: msg(0, 100),
      source_thread_topic: "",
      preview: "Sounds good to me",
      timestamp: now - 4 * 60_000,
      count: 1,
      is_read: false,
    },
    {
      id: "act-sample-2",
      activity_type: "reactionInChat",
      activity_subtype: "heart",
      actor_name: "Morgan Ellis",
      actor_mri: "8:orgid:morgan",
      source_thread_id: thread(1),
      source_message_id: msg(1, 96),
      source_thread_topic: "",
      preview: "Can I deploy to staging real quick?",
      timestamp: now - 55 * 60_000,
      count: 1,
      is_read: false,
    },
    {
      id: "act-sample-3",
      // An extended reaction key, the `<code points>_<name>` form real tenants
      // send for emoji Teams has no animation for — so the fixture covers more
      // than the six classic subtypes.
      activity_type: "reactionInChat",
      activity_subtype: "1f389_partypopper",
      actor_name: "Jordan Blake",
      actor_mri: "8:orgid:jordan",
      source_thread_id: thread(2),
      source_message_id: msg(2, 90),
      source_thread_topic: "",
      preview: "I don't think so, we'd have had feedback otherwise",
      timestamp: now - 3 * 3_600_000,
      count: 1,
      is_read: true,
    },
  ];

  const mentions: MockNotification[] = [
    {
      id: "mention-sample-1",
      activity_type: "mention",
      activity_subtype: "",
      actor_name: "Priya Nair",
      actor_mri: "8:orgid:priya",
      source_thread_id: thread(platform),
      source_message_id: msg(platform, 98),
      source_thread_topic: "Platform Team",
      preview: "can you take a look when you get a chance?",
      timestamp: now - 12 * 60_000,
      count: 1,
      is_read: false,
    },
    {
      id: "mention-sample-2",
      activity_type: "mention",
      activity_subtype: "",
      actor_name: "Diego Santos",
      actor_mri: "8:orgid:diego",
      source_thread_id: thread(incident),
      source_message_id: msg(incident, 92),
      source_thread_topic: "Incident Response",
      preview: "paging you on the sev-2, need eyes on the dashboard",
      timestamp: now - 2 * 3_600_000,
      count: 1,
      is_read: true,
    },
  ];

  const following: MockNotification[] = [
    {
      id: "following-sample-1",
      activity_type: "threads",
      activity_subtype: "",
      actor_name: "Amelia Fischer",
      actor_mri: "8:orgid:amelia-fischer",
      source_thread_id: thread(frontend),
      source_message_id: msg(frontend, 100),
      source_thread_topic: "Frontend Guild",
      preview: "pushed a follow-up, the flaky test is green now",
      timestamp: now - 40 * 60_000,
      count: 1,
      is_read: false,
    },
    {
      id: "following-sample-2",
      activity_type: "threads",
      activity_subtype: "",
      actor_name: "Henry Walker",
      actor_mri: "8:orgid:henry-walker",
      source_thread_id: thread(frontend),
      source_message_id: msg(frontend, 88),
      source_thread_topic: "Frontend Guild",
      preview: "agreed, let's split this into two tickets",
      timestamp: now - 5 * 3_600_000,
      count: 1,
      is_read: true,
    },
  ];

  // Activity is the superset: injected entries (from the test hook) + reactions +
  // mentions, newest kept first as the client expects. Following stays its own
  // stream, so the badge (Activity-only) never double-counts it.
  return {
    activity: [...injectedNotifications, ...reactions, ...mentions],
    mentions,
    following,
  };
}

/** Wrap a stream as a `MockFeed` (items + unread count), matching the Rust
 *  `feed_json` shape the `notifications` method returns per tab. */
function toFeed(items: MockNotification[]): MockFeed {
  // The actor's name comes off the activity feed rather than out of the message
  // store, so it needs the nickname applied here — as the Rust `feed_json` does.
  const named = items.map((n) => {
    const own = nickname(n.actor_mri);
    return own ? { ...n, actor_name: own } : n;
  });
  return { unread: named.filter((n) => !n.is_read).length, items: named };
}

// ---------------------------------------------------------------------------
// Mail — stands in for the READ-ONLY Outlook surface (src/mail.rs + src/mail_html.rs).
//
// Two things this mock must get right, because the UI's behaviour depends on them:
//
//   1. Bodies arrive ALREADY SANITIZED. The real backend runs every mail through
//      ammonia before it reaches a client: no scripts, no remote references, inline
//      images embedded as `data:` URIs, and a count of what was dropped. The
//      fixtures below are written in exactly that shape (table layouts, inline
//      styles, a data-URI logo, a newsletter reporting blocked remote images), so
//      the web renderer is exercised against realistic input.
//   2. There is no way to send. No `mail_send`/`mail_reply`/`mail_delete` case
//      exists here, mirroring a backend where the capability is absent rather than
//      merely ungated. `mail_mark_read` is the one mail case that changes anything,
//      and it changes only what this mock holds — as the real backend changes only
//      its own mirror, never the mailbox.
// ---------------------------------------------------------------------------

type MailAddress = { name: string; address: string };

type MailFolder = {
  id: string;
  display_name: string;
  well_known: string;
  total_count: number;
  unread_count: number;
  position: number;
};

type MailAttachment = {
  id: string;
  name: string;
  content_type: string;
  size: number;
  is_inline: boolean;
};

type MailHeader = {
  id: string;
  folder_id: string;
  conversation_id: string;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** ISO 8601 UTC, whole seconds — the ordering and paging key. */
  received: string;
  is_read: boolean;
  has_attachments: boolean;
  importance: string;
  preview: string;
};

type MailBody = {
  html: string;
  blocked_remote_images: number;
  truncated: boolean;
  attachments: MailAttachment[];
  /** The mail's header, which the real backend reads in the same Graph request as
   *  the body so a deep link needs no second round-trip. Filled in by the
   *  `mail_body` handler from the folder's own list. */
  header?: MailHeader | null;
};

/** How many mails the inbox holds, so the list virtualizes and pages. */
const MAIL_BACKLOG = Number(process.env.MOCK_MAIL_BACKLOG ?? 64);

/** The mock mailbox's own address, for `to`/`from` on mail we "received"/"sent". */
const SELF_ADDRESS: MailAddress = { name: "You", address: "you@example.com" };

const MAIL_FOLDER_SEEDS: { id: string; display_name: string; well_known: string }[] = [
  // These localized display names are DATA UNDER TEST, not UI strings — the one
  // deliberate exception to the English-only rule in this file. Graph returns a
  // mailbox's folder names in the tenant's language ("Boîte de réception"), which is
  // exactly why the sidebar labels well-known folders from `well_known` and orders
  // them by `position` instead. Translating these fixtures to English would silently
  // delete the coverage for that.
  { id: "mf-inbox", display_name: "Boîte de réception", well_known: "Inbox" },
  { id: "mf-archive", display_name: "Archive", well_known: "Archive" },
  { id: "mf-sent", display_name: "Éléments envoyés", well_known: "Sent" },
  { id: "mf-drafts", display_name: "Brouillons", well_known: "Drafts" },
  { id: "mf-deleted", display_name: "Éléments supprimés", well_known: "Deleted" },
  // A user folder: no stable label, sorted after every well-known one.
  { id: "mf-projects", display_name: "Projects", well_known: "" },
];

const MAIL_SUBJECTS = [
  "Quarterly platform review — deck attached",
  "Re: Trouter reconnect backoff",
  "Your build finished: teams-lite #4821",
  "Weekly digest: what shipped last week",
  "Invitation: architecture guild, Thursday 14:00",
  "Access request approved",
  "Re: SQLite WAL checkpointing under load",
  "Reminder: submit your timesheet",
  "New sign-in from a Linux device",
  "Re: mail rendering — sanitizer or iframe?",
  "Offsite logistics (please read)",
  "Security advisory: rotate your PAT",
  "Design review notes",
  "Re: read receipts endpoint",
  "Monthly platform costs",
];

const MAIL_PREVIEWS = [
  "Thanks for the quick turnaround on this — a couple of comments inline before we ship.",
  "I had a look at the traces this morning and the reconnect storm is coming from the registrar, not us.",
  "The pipeline is green. Artifacts are attached to the run and expire in 30 days.",
  "Here is what landed: the virtualized history, the read-only backend, and the sparkle nickname.",
  "Agenda: local-first storage, the write lock, and what we do about calling.",
  "Your request has been approved. No further action is needed on your side.",
];

/** Deterministic mail ids that look like Graph's (base64-ish, padded). */
function mailId(folderId: string, index: number): string {
  return `AAMk-${folderId}-${String(index).padStart(4, "0")}==`;
}

/** ISO 8601 UTC, whole seconds — the exact shape the Rust backend normalizes to. */
function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

const mailFolders: MailFolder[] = [];
/** Every mail header by folder, newest first (the order the backend serves). */
const mailByFolder = new Map<string, MailHeader[]>();
/** Bodies by mail id, in the sanitized shape the backend returns. */
const mailBodies = new Map<string, MailBody>();

/** A small SVG as a `data:` URI — stands in for an inline (`cid:`) image the
 *  backend embedded after fetching the attachment. */
function inlineLogoDataUri(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">` +
    `<rect width="120" height="40" rx="6" fill="#2d6cdf"/>` +
    `<text x="60" y="21" font-family="system-ui,sans-serif" font-size="13" fill="white" ` +
    `text-anchor="middle" dominant-baseline="middle">teams-lite</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** A plain, sanitized HTML body for an ordinary mail. */
function simpleMailBody(sender: string, paragraphs: string[]): MailBody {
  const body =
    `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1f1f1f">` +
    paragraphs.map((p) => `<p style="margin: 0 0 12px">${escapeHtml(p)}</p>`).join("") +
    `<p style="margin: 16px 0 0; color: #666666">— ${escapeHtml(sender)}</p>` +
    `</div>`;
  return { html: body, blocked_remote_images: 0, truncated: false, attachments: [] };
}

/** Seed the mail folders and their contents. Deterministic: same fixtures every
 *  run, so screenshots and E2E assertions are stable. */
function seedMail(): void {
  const now = Date.now();
  for (const [position, seed] of MAIL_FOLDER_SEEDS.entries()) {
    mailFolders.push({
      id: seed.id,
      display_name: seed.display_name,
      well_known: seed.well_known,
      total_count: 0,
      unread_count: 0,
      position,
    });
    mailByFolder.set(seed.id, []);
  }

  // ---- the inbox, including the cases the renderer must handle --------------
  const inbox: MailHeader[] = [];
  const hour = 60 * 60 * 1000;

  /** Add one inbox mail with an explicit body. */
  const add = (
    index: number,
    header: Partial<MailHeader> & { subject: string; from: MailAddress; preview: string },
    body: MailBody,
  ) => {
    const id = mailId("mf-inbox", index);
    const mail: MailHeader = {
      id,
      folder_id: "mf-inbox",
      conversation_id: `mc-${index}`,
      subject: header.subject,
      from: header.from,
      to: header.to ?? [SELF_ADDRESS],
      cc: header.cc ?? [],
      received: isoSeconds(now - index * hour),
      is_read: header.is_read ?? true,
      has_attachments: body.attachments.some((a) => !a.is_inline),
      importance: header.importance ?? "normal",
      preview: header.preview,
    };
    inbox.push(mail);
    mailBodies.set(id, body);
  };

  // A table-based newsletter whose remote images were all blocked: the case that
  // must render as a notice plus whatever text survived, never as a blank pane.
  add(
    0,
    {
      subject: "Weekly digest: what shipped last week",
      // An external sender, on its own domain: nobody the directory can name, so this
      // is the face the domain rule draws (see `mailAvatarSeed`).
      from: { name: "Platform Digest", address: "digest@platformweekly.io" },
      preview: MAIL_PREVIEWS[3]!,
      is_read: false,
    },
    {
      html:
        `<table cellpadding="0" cellspacing="0" border="0" width="600" style="font-family: Arial, sans-serif">` +
        `<tr><td bgcolor="#f4f6fb" style="padding: 16px; font-size: 18px; color: #1f1f1f">` +
        `Platform weekly</td></tr>` +
        `<tr><td style="padding: 16px; font-size: 14px; color: #333333">` +
        `<p style="margin: 0 0 10px">Three things shipped last week:</p>` +
        `<ul style="margin: 0 0 12px; padding-left: 20px">` +
        `<li style="margin-bottom: 6px">A virtualized message history</li>` +
        `<li style="margin-bottom: 6px">A read-only backend on its own port</li>` +
        `<li>The sparkled nickname in the web UI</li></ul>` +
        // An image whose source the sanitizer removed: the tag survives, the
        // reference does not (exactly what ammonia leaves behind).
        `<img alt="Sponsor banner" width="560" height="80">` +
        `<p style="margin: 12px 0 0"><a href="https://example.com/digest/47">Read it on the web</a></p>` +
        `</td></tr></table>`,
      blocked_remote_images: 7,
      truncated: false,
      attachments: [],
    },
  );

  // A mail with real file attachments plus an embedded inline logo.
  add(
    1,
    {
      subject: "Quarterly platform review — deck attached",
      from: personAddress("Lucas Silva"),
      cc: [personAddress("Mia Chen"), personAddress("Noah Kim")],
      preview: MAIL_PREVIEWS[0]!,
      is_read: false,
      importance: "high",
    },
    {
      html:
        `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1f1f1f">` +
        `<p style="margin: 0 0 12px">Hi,</p>` +
        `<p style="margin: 0 0 12px">The deck for Thursday is attached, along with the cost model. ` +
        `The short version: storage is flat, egress is not.</p>` +
        `<blockquote style="margin: 12px 0; padding-left: 12px; border-left: 2px solid #dddddd; color: #555555">` +
        `&gt; Can we get the numbers before the guild?</blockquote>` +
        `<p style="margin: 0 0 12px">Yes — slide 4.</p>` +
        `<img src="${inlineLogoDataUri()}" alt="teams-lite" width="120" height="40">` +
        `</div>`,
      blocked_remote_images: 0,
      truncated: false,
      attachments: [
        {
          id: "att-deck",
          name: "platform-review-q3.pdf",
          content_type: "application/pdf",
          size: 2_418_133,
          is_inline: false,
        },
        {
          id: "att-costs",
          name: "cost-model.xlsx",
          content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 48_210,
          is_inline: false,
        },
        {
          id: "att-logo",
          name: "logo.svg",
          content_type: "image/svg+xml",
          size: 812,
          is_inline: true,
        },
      ],
    },
  );

  // A plain-text mail: escaped, line breaks preserved, nothing invented.
  add(
    2,
    {
      subject: "Your build finished: teams-lite #4821",
      from: { name: "CI", address: "builds@ci.buildbot.dev" },
      preview: MAIL_PREVIEWS[2]!,
    },
    {
      html:
        `<div style="white-space: pre-wrap">Pipeline #4821 succeeded.<br><br>` +
        `  cargo test ... ok (248 tests)<br>  bun run test ... ok (228 tests)<br><br>` +
        `Artifacts expire in 30 days.</div>`,
      blocked_remote_images: 0,
      truncated: false,
      attachments: [],
    },
  );

  // An unusually large mail, so the "shortened" notice has a fixture.
  add(
    3,
    {
      subject: "Re: mail rendering — sanitizer or iframe?",
      from: personAddress("Ava Thompson"),
      preview: "Both, and in that order: sanitize server-side, then isolate what is left.",
    },
    {
      html:
        `<div style="font-family: Arial, sans-serif; font-size: 14px">` +
        `<p>Both, and in that order.</p>` +
        `${"<p>A very long thread of quoted history.</p>".repeat(40)}` +
        `</div>`,
      blocked_remote_images: 2,
      truncated: true,
      attachments: [],
    },
  );

  // A mail addressed to a whole room: more recipients than the header card shows at
  // once, so the "+N" chip and its expansion have a fixture — and so has a face for
  // every person a message names, which is the point of the recipient lines.
  add(
    4,
    {
      subject: "Invitation: architecture guild, Thursday 14:00",
      from: personAddress("Olivia Martins"),
      to: [
        SELF_ADDRESS,
        ...["Ava Thompson", "Liam Nguyen", "Noah Kim", "Emma Rossi", "Lucas Silva", "Mia Chen"].map(
          personAddress,
        ),
        // Nobody the directory knows: an alias and an off-tenant guest, so the
        // initials fallback stands next to the real photos.
        { name: "Architecture guild", address: "guild@example.com" },
        { name: "", address: "reva.singh@partner.example.org" },
      ],
      cc: [personAddress("Ethan Brown"), personAddress("Sofia Garcia")],
      preview: MAIL_PREVIEWS[4]!,
    },
    simpleMailBody("Olivia Martins", [
      MAIL_PREVIEWS[4]!,
      "The room takes twelve, so reply if you cannot make it and I will free the seat.",
    ]),
  );

  // Two machines at one organisation, on two subdomains, one of them with no display
  // name at all. They have to read as ONE sender: the same tint, and initials taken
  // from the domain rather than from "security@", which says nothing about who wrote.
  add(
    5,
    {
      subject: "Tracker: 3 issues moved to In Review",
      from: { name: "Tracker", address: "notifications@tracker.dev" },
      preview: "Ava moved PLAT-114, PLAT-115 and PLAT-118 while you were away.",
    },
    simpleMailBody("Tracker", ["Ava moved three issues to In Review."]),
  );
  add(
    6,
    {
      subject: "Security advisory: rotate your PAT",
      from: { name: "", address: "security@updates.tracker.dev" },
      preview: "A token you created two years ago is older than the policy allows.",
      is_read: false,
    },
    simpleMailBody("Tracker Security", ["Rotate the token before the end of the month."]),
  );

  // The rest of the backlog: ordinary mail, so the list pages and virtualizes.
  for (let index = 7; index < MAIL_BACKLOG; index++) {
    const person = PEOPLE[index % PEOPLE.length]!;
    const subject = MAIL_SUBJECTS[index % MAIL_SUBJECTS.length]!;
    const preview = MAIL_PREVIEWS[index % MAIL_PREVIEWS.length]!;
    add(
      index,
      {
        subject,
        from: personAddress(person.name),
        preview,
        // A deterministic scattering of unread mail near the top of the list.
        is_read: index % 7 !== 0,
      },
      simpleMailBody(person.name, [preview, "Let me know if that works for you."]),
    );
  }
  mailByFolder.set("mf-inbox", inbox);

  // ---- the other folders: small, but real enough to browse -----------------
  const sent: MailHeader[] = [];
  for (let index = 0; index < 8; index++) {
    const person = PEOPLE[(index * 3) % PEOPLE.length]!;
    const id = mailId("mf-sent", index);
    sent.push({
      id,
      folder_id: "mf-sent",
      conversation_id: `ms-${index}`,
      subject: `Re: ${MAIL_SUBJECTS[(index * 5) % MAIL_SUBJECTS.length]!}`,
      from: SELF_ADDRESS,
      to: [personAddress(person.name)],
      cc: [],
      received: isoSeconds(now - (index + 1) * 5 * hour),
      is_read: true,
      has_attachments: false,
      importance: "normal",
      preview: "Sounds good — I'll take a look this afternoon.",
    });
    mailBodies.set(
      id,
      simpleMailBody("You", ["Sounds good — I'll take a look this afternoon."]),
    );
  }
  mailByFolder.set("mf-sent", sent);

  const archive: MailHeader[] = [];
  for (let index = 0; index < 12; index++) {
    const person = PEOPLE[(index * 7) % PEOPLE.length]!;
    const id = mailId("mf-archive", index);
    archive.push({
      id,
      folder_id: "mf-archive",
      conversation_id: `ma-${index}`,
      subject: MAIL_SUBJECTS[(index * 2) % MAIL_SUBJECTS.length]!,
      from: personAddress(person.name),
      to: [SELF_ADDRESS],
      cc: [],
      received: isoSeconds(now - (index + 2) * 26 * hour),
      is_read: index % 4 !== 0,
      has_attachments: false,
      importance: "normal",
      preview: MAIL_PREVIEWS[(index * 3) % MAIL_PREVIEWS.length]!,
    });
    mailBodies.set(id, simpleMailBody(person.name, ["Archived for reference."]));
  }
  mailByFolder.set("mf-archive", archive);

  // Drafts / Deleted / a user folder exist and are simply empty here: an empty
  // folder is a state the UI has to render, and this is the cheapest fixture for it.
  recomputeMailCounts();
}

/** A mail address for one of the mock's people. */
function personAddress(name: string): MailAddress {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/(^\.|\.$)/g, "");
  return { name, address: `${slug}@example.com` };
}

/** Refresh every folder's total/unread counts from its contents. */
function recomputeMailCounts(): void {
  for (const folder of mailFolders) {
    const mail = mailByFolder.get(folder.id) ?? [];
    folder.total_count = mail.length;
    folder.unread_count = mail.filter((m) => !m.is_read).length;
  }
}

/** One mail's header, wherever it lives, or null. */
function mailHeaderById(id: string): MailHeader | null {
  for (const mail of mailByFolder.values()) {
    const found = mail.find((m) => m.id === id);
    if (found) return found;
  }
  return null;
}

/** A folder's page, newest first, optionally starting before a timestamp. */
function mailPage(folderId: string, before: string | null, limit: number): {
  messages: MailHeader[];
  has_more: boolean;
} {
  const all = mailByFolder.get(folderId) ?? [];
  const filtered = before ? all.filter((m) => m.received < before) : all;
  const page = filtered.slice(0, limit);
  return { messages: page, has_more: filtered.length > page.length };
}

/** Inject a new mail at the top of a folder and broadcast it, mirroring what the
 *  Rust backend emits after its newest-window poll finds something. */
function injectMail(input: {
  folderId: string;
  subject?: string;
  sender?: string;
  preview?: string;
}): MailHeader | null {
  const folder = mailFolders.find((f) => f.id === input.folderId);
  const all = mailByFolder.get(input.folderId);
  if (!folder || !all) return null;

  const sender = input.sender ?? "Riley Carter";
  const id = mailId(input.folderId, 9000 + all.length);
  const mail: MailHeader = {
    id,
    folder_id: input.folderId,
    conversation_id: `mc-live-${all.length}`,
    subject: input.subject ?? "A new message",
    from: personAddress(sender),
    to: [SELF_ADDRESS],
    cc: [],
    received: isoSeconds(Date.now()),
    is_read: false,
    has_attachments: false,
    importance: "normal",
    preview: input.preview ?? "This just arrived.",
  };
  all.unshift(mail);
  mailBodies.set(id, simpleMailBody(sender, [mail.preview]));
  recomputeMailCounts();

  const page = mailPage(input.folderId, null, PAGE_SIZE);
  broadcast("mail_list_updated", { folder: input.folderId, ...page });
  broadcast("mail_folders_changed", {});
  return mail;
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "ping":
      return "pong";

    // Where the asking client stands with the write lock (`write_lock_status` in
    // src/bin/server.rs). This backend gates nothing — it has no token and no account to
    // protect — so the honest answer for a page driving the mock is `held`: nothing it
    // presses will be refused. The `{kind: "write_lock"}` test hook arms the other states,
    // because the banner they draw is the whole point of the feature and the mock is the
    // only place it can be looked at.
    case "write_lock_status":
      return { state: mockWriteLockState, pinned: mockWriteLockPinned };

    case "conversations": {
      // Newest activity first, exactly like the sidebar expects. Channels live
      // in their own store, so they never appear here — matching the Rust
      // `conversations()` query that excludes ids present in the channels table.
      return order
        .map((id) => store.get(id)!.conv)
        .slice()
        .sort((a, b) => b.last_message_time - a.last_message_time)
        .map(nicknamedConversation);
    }

    case "channels": {
      // The order the Rust `channels()` query returns: the seed insertion order
      // (team-by-team, General first within each team), which is what team_pos,
      // General-first and channel_pos add up to — NOT an alphabetical sort.
      // `channelOrder` already holds ids in that order, and the sidebar's
      // `groupChannelsByTeam` preserves it.
      return channelOrder.map((id) => {
        const channel = channelStore.get(id)!.channel;
        const attributed = nickname(channel.last_message_sender_mri);
        return { ...channel, last_message_sender: attributed || channel.last_message_sender };
      });
    }

    case "notifications": {
      // Three streams in one round-trip, one per panel tab (mirrors the Rust
      // `notifications` method fetching 48:notifications / 48:mentions / 48:threads).
      const feeds = buildNotificationFeeds();
      return {
        activity: toFeed(feeds.activity),
        mentions: toFeed(feeds.mentions),
        following: toFeed(feeds.following),
      };
    }

    case "read_receipts": {
      // "Seen by": every OTHER member's read position. Empty until a test injects
      // one (mirrors the real backend returning nothing for a receipts-disabled
      // or channel thread); our own position is never included.
      const id = requireString(params, "conversation");
      const byMri = injectedReceipts.get(id);
      return { receipts: byMri ? [...byMri.values()] : [] };
    }

    case "members": {
      // The people this thread can @mention. Never us — a mention of oneself notifies
      // nobody — which is exactly what the real backend leaves out.
      const id = requireString(params, "conversation");
      const t = threadFor(id);
      // Named through the user's nicknames, like the Rust `thread_senders` read the
      // real list is completed from: a person the user renamed is renamed in the
      // @mention list too, or they could not find them by the name they gave them.
      const members = (t?.participants ?? []).map((p) => ({
        mri: p.mri,
        name: nickname(p.mri) || p.name,
      }));
      return { members };
    }

    case "open": {
      const id = requireString(params, "conversation");
      const t = threadFor(id);
      if (!t) return { messages: [], has_more: false };
      return newestPage(t.messages);
    }

    case "backfill": {
      const id = requireString(params, "conversation");
      const beforeSeq = requireNumber(params, "before_seq");
      const t = threadFor(id);
      if (!t) return { messages: [], has_more: false };
      return pageBefore(t.messages, beforeSeq);
    }

    case "set_draft": {
      const id = requireString(params, "conversation");
      const text = requireString(params, "text");
      const t = threadFor(id);
      if (t) t.setDraft(text); // reflected by a later `conversations` / `channels`
      return { saved: true };
    }

    case "send": {
      const input = asObject(params);
      const id = requireString(params, "conversation");
      const text = requireString(params, "text");
      const replyTo = parseReplyTo(input.reply_to);
      const rawHtml = input.content_html;
      const contentHtml = typeof rawHtml === "string" && rawHtml.length > 0 ? rawHtml : undefined;
      const images = parseSendImages(input);
      const mentions = parseSendMentions(input.mentions);
      if (TEST_HOOKS) {
        capturedSends.push({
          conversation: id,
          text,
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(contentHtml ? { content_html: contentHtml } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(mentions.length > 0 ? { mentions } : {}),
        });
        if (testSendError) throw new Error(testSendError);
        if (testSendDelayMs > 0) {
          return new Promise((resolve) => {
            setTimeout(() => {
              scheduleSendEcho(id, text, replyTo, contentHtml, images, mentions);
              resolve({ sent: true });
            }, testSendDelayMs);
          });
        }
      }
      scheduleSendEcho(id, text, replyTo, contentHtml, images, mentions);
      return { sent: true };
    }

    case "edit": {
      const id = requireString(params, "conversation");
      const messageId = requireString(params, "message_id");
      const text = requireString(params, "text");
      editMessage(id, messageId, text);
      return { edited: true };
    }

    case "delete": {
      const id = requireString(params, "conversation");
      const messageId = requireString(params, "message_id");
      deleteMessage(id, messageId);
      return { deleted: true };
    }

    // React, mirroring the Rust `react` including the half that makes a custom emoji
    // reaction work: `emoji` names one of the user's own, and the KEY is minted here from
    // the object its art was uploaded to — a page can never mint it, because the object
    // does not exist until the backend has made it. `key` carries an existing reaction
    // verbatim, which is how one is toggled back off with no second upload.
    case "react": {
      const id = requireString(params, "conversation");
      const messageId = requireString(params, "message_id");
      const picked = asObject(params).emoji;
      // The NAME rides beside the address, as `custom_emoji::custom_reaction_key` writes it:
      // it is what lets a reader's pack hold a colleague's reaction emoji at all.
      const key =
        typeof picked === "string" && picked
          ? `tlcustom-${emojiObjectUrl(picked)}#${picked}`
          : requireString(params, "key");
      // A pick is always an ADD: its key names one upload, so it can never be the key
      // already on the message.
      const on = reactMessage(id, messageId, key, typeof picked === "string" && Boolean(picked));
      return { reacted: on };
    }

    // Mark a thread read, mirroring the Rust `mark_read`: with Ghost mode off the real
    // backend publishes the read position to Teams (nothing to imitate here, the mock
    // has no tenant); with it on the read stays local and the row is badged. Either way
    // the marker clears and the list event follows — which is what a spec asserts.
    case "mark_read": {
      const id = requireString(params, "conversation");
      const t = threadFor(id);
      if (!t) throw new Error(`unknown conversation: ${id}`);
      if (t.messages.length === 0) return { read: false, ghost: mockSettings.ghost_mode };
      t.markRead(mockSettings.ghost_mode);
      broadcast(t.changedEvent, {});
      return { read: true, ghost: mockSettings.ghost_mode };
    }

    // The one chat setting the app publishes to Teams. The mock has no tenant, so it
    // does what the tenant does from the app's point of view: store the new value on the
    // conversation and announce the list changed — which is what lets a spec (and
    // `bun run preview`) exercise the round trip with nothing leaving the machine.
    case "set_chat_muted": {
      const id = requireString(params, "conversation");
      const muted = asObject(params).muted === true;
      const cs = store.get(id);
      if (!cs) throw new Error(`unknown conversation: ${id}`);
      cs.conv.is_muted = muted;
      broadcast("conversations_changed", {});
      return { muted };
    }

    case "repair_broker": {
      // Pretend the repair unit started: flip `repairing`, then report a healthy
      // broker a beat later. That is what lets a spec — and `bun run preview` — drive
      // the whole flow with no Intune container anywhere near it.
      if (mockBrokerStatus) {
        mockBrokerStatus = { ...mockBrokerStatus, repairing: true };
        broadcast("broker_status", mockBrokerStatus);
        setTimeout(() => {
          mockBrokerStatus = {
            ok: true,
            signature: "",
            message: "",
            detail: "",
            consecutive_failures: 0,
            can_repair: false,
            repairing: false,
          };
          broadcast("broker_status", mockBrokerStatus);
        }, 500);
      }
      return { started: true };
    }

    // Settings › This app, first row: ask "now" whether a newer build exists. There is no
    // GitHub here, so the answer is what this mock is currently holding — armed, and
    // otherwise the honest "you are on the newest build", which is the answer the row exists
    // to be able to give at all.
    case "update_check": {
      if (mockMaintenance.check) return { outcome: mockMaintenance.check, error: GITHUB_UNREACHABLE };
      if (mockUpdateProgress.phase !== "idle") return { outcome: "busy" };
      // A release the mock holds is announced the way a real pass announces one, so the
      // sidebar's row appears from the press rather than from the test hook.
      if (mockUpdate) {
        broadcast("update_available", { ...mockUpdate });
        return { outcome: "available" };
      }
      return { outcome: "current" };
    }

    // Second row: restart the backend. Nothing is spawned here — what a page can be shown is
    // the answer and then the socket going, which is the whole of what it reacts to.
    case "restart_backend": {
      if (mockMaintenance.refuse) throw new Error(MOCK_NO_RESTARTER_ERROR);
      // The arming is the backend's, driven by `force` and never by a counter, exactly as in
      // `Ctx::restart_backend`: the first press is answered with the runs it would cut off,
      // and the second one carries the user's answer to that.
      if (mockMaintenance.runs > 0 && asObject(params).force !== true) {
        return { restarted: false, blocked: "agent", runs: mockMaintenance.runs };
      }
      setTimeout(() => {
        for (const ws of sockets) ws.close();
      }, MOCK_RESTART_ANSWER_MS);
      return { restarted: true, via: "launcher" };
    }

    // The update's first click: fetch the new build. Reports progress on a timer the way
    // the real one reports it per whole percent, and joins a download already in flight
    // rather than starting a second one — the button may be open in two pages.
    case "update_download": {
      if (!mockUpdate) throw new Error("there is no new build to download");
      if (mockUpdateProgress.phase === "downloading") return { ...mockUpdateProgress };
      // Armed to fail ONCE, and disarmed by the attempt it fails: what the spec then
      // presses is a retry that has to work, because a button whose only offer cannot
      // succeed is the state that left the user with no way forward.
      if (mockUpdateFailsOnce) {
        mockUpdateFailsOnce = false;
        resetMockUpdate();
        mockUpdateProgress = {
          phase: "failed",
          received: 0,
          total: mockUpdate.size,
          error: MOCK_REPLACED_RELEASE_ERROR,
        };
        broadcastUpdateProgress();
        return { ...mockUpdateProgress };
      }
      resetMockUpdate();
      mockUpdateProgress = {
        phase: "downloading",
        received: 0,
        total: mockUpdate.size,
        error: "",
      };
      broadcastUpdateProgress();
      const step = mockUpdate.size / (MOCK_DOWNLOAD_MS / MOCK_DOWNLOAD_TICK_MS);
      mockDownloadTimer = setInterval(() => {
        if (mockUpdateProgress.phase !== "downloading") return;
        mockUpdateProgress.received = Math.min(
          mockUpdateProgress.total,
          mockUpdateProgress.received + step,
        );
        if (mockUpdateProgress.received >= mockUpdateProgress.total) {
          if (mockDownloadTimer) clearInterval(mockDownloadTimer);
          mockDownloadTimer = null;
          mockUpdateProgress.phase = "ready";
        }
        broadcastUpdateProgress();
      }, MOCK_DOWNLOAD_TICK_MS);
      return { ...mockUpdateProgress };
    }

    // The second click: install it and restart onto it. There is no binary here and no
    // launcher, so this walks the two phases the real backend walks when nothing restarts
    // the app — `restarting`, then `installed`, which is the honest end for a mock.
    case "update_apply": {
      if (mockUpdateProgress.phase !== "ready") {
        throw new Error("nothing is downloaded yet — download the update before applying it");
      }
      mockUpdateProgress = {
        phase: "restarting",
        received: mockUpdateProgress.total,
        total: mockUpdateProgress.total,
        error: "",
      };
      broadcastUpdateProgress();
      setTimeout(() => {
        if (mockUpdateProgress.phase !== "restarting") return;
        mockUpdateProgress.phase = "installed";
        broadcastUpdateProgress();
      }, 1200);
      return { ...mockUpdateProgress };
    }

    case "fetch_media": {
      const url = requireString(params, "url");
      return mockMedia(url);
    }

    case "fetch_avatar": {
      const o = asObject(params);
      const kind = o.kind === "team" ? "team" : "user";
      const id = requireString(params, "id");
      return mockAvatar(kind, id);
    }

    case "profile": {
      const mri = requireString(params, "mri");
      return mockProfile(mri);
    }

    case "sender_icon": {
      // The real backend reduces the domain to its registrable form before anything
      // else, so the mock does too — a spec must see the same key the app will get.
      const domain = requireString(params, "domain").trim().toLowerCase();
      if (!mockSettings.sender_icons) return { found: false };
      return mockSenderIcon(registrableDomain(domain));
    }

    case "people_by_address": {
      const o = asObject(params);
      const addresses = Array.isArray(o.addresses)
        ? o.addresses.filter((a): a is string => typeof a === "string")
        : [requireString(params, "address")];
      return { people: addresses.map(mockAddressPerson).filter((p) => p !== null) };
    }

    // ---- the name and face the USER gave somebody ---------------------------
    // Teams holds neither, so nothing here reaches a tenant even in the real
    // backend. Reading is open; setting carries the write token (MACHINE_METHODS in
    // src/bin/server.rs), which the mock does not enforce — the point of the mock is
    // to exercise the flow, and the token gate is pinned by the Rust tests.

    case "person_override": {
      return personOverrideView(requireString(params, "mri"));
    }

    case "person_overrides": {
      const overrides = [...personOverrides.keys()]
        .map(personOverrideView)
        .sort((a, b) => b.updated_at - a.updated_at || a.mri.localeCompare(b.mri));
      return { overrides };
    }

    case "set_person_name": {
      const mri = requireString(params, "mri");
      const name = String(asObject(params).name ?? "").trim();
      const entry = personOverrides.get(mri) ?? { display_name: "", avatar: null, updated_at: 0 };
      personOverrides.set(mri, { ...entry, display_name: name, updated_at: Date.now() });
      pruneEmptyOverride(mri);
      broadcast("person_override_changed", { mri });
      return { saved: true };
    }

    case "set_person_avatar": {
      const mri = requireString(params, "mri");
      const o = asObject(params);
      const data = typeof o.data_base64 === "string" ? o.data_base64 : "";
      const contentType = typeof o.content_type === "string" ? o.content_type : "";
      const entry = personOverrides.get(mri) ?? { display_name: "", avatar: null, updated_at: 0 };
      personOverrides.set(mri, {
        ...entry,
        avatar: data ? { content_type: contentType, data_base64: data } : null,
        updated_at: Date.now(),
      });
      pruneEmptyOverride(mri);
      broadcast("person_override_changed", { mri });
      return { saved: true };
    }

    case "presence": {
      const o = asObject(params);
      const mris = Array.isArray(o.mris)
        ? o.mris.filter((m): m is string => typeof m === "string")
        : [requireString(params, "mri")];
      return { presences: mris.map(mockPresence) };
    }

    // ---- custom emoji ------------------------------------------------------

    case "custom_emoji": {
      // Sorted by name, as the real backend hands the pack back (`store.rs`: `FROM
      // custom_emoji ORDER BY name ASC`). A Map iterates in INSERTION order, so without
      // this the mock's pack came back in seeding order — and the `:` menu, which shows
      // the pack in the order it is given, listed it differently here than in the app.
      const emoji = [...customEmojiPack.values()]
        .map((e) => ({
          name: e.name,
          alias_of: e.alias_of,
          content_type: e.content_type,
          width: e.width,
          height: e.height,
          source: e.source,
          added_ms: e.added_ms,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { emoji };
    }

    case "custom_emoji_image": {
      const name = requireString(params, "name");
      const asked = customEmojiPack.get(name);
      // An alias holds no art of its own: follow ONE hop to its target, exactly as
      // `Store::custom_emoji_art` does. Without it `:ship:` draws nothing anywhere the
      // pack's own art is shown — the composer chip, the suggestion row, the settings list.
      const entry = asked?.alias_of ? customEmojiPack.get(asked.alias_of) : asked;
      if (!entry || entry.alias_of || !entry.data_base64) {
        return { content_type: "", data_base64: "" };
      }
      return { content_type: entry.content_type, data_base64: entry.data_base64 };
    }

    case "custom_emoji_export": {
      const emoji = [...customEmojiPack.values()].map((e) => ({
        name: e.name,
        alias_of: e.alias_of,
        content_type: e.content_type,
        data_base64: e.data_base64,
        width: e.width,
        height: e.height,
      }));
      return { emoji };
    }

    case "custom_emoji_add": {
      const name = requireString(params, "name");
      const source = requireString(params, "source");

      // Name shape check: mirrors custom_emoji::is_valid_name in src/custom_emoji.rs.
      // 1..64 chars, first must be lowercase letter or digit, remaining may also be -, _, +.
      if (
        name.length === 0 ||
        name.length > 64 ||
        !/^[a-z0-9]/.test(name) ||
        !/^[a-z0-9_+\-]+$/.test(name)
      ) {
        throw new Error("an emoji name may hold lowercase letters, numbers, dashes and underscores");
      }

      const o = asObject(params);
      const alias_of = typeof o.alias_of === "string" ? o.alias_of : "";
      const url = typeof o.url === "string" ? o.url : "";
      const media_url = typeof o.media_url === "string" ? o.media_url : "";
      const data_base64 = typeof o.data_base64 === "string" ? o.data_base64 : "";

      const existing = Array.from(customEmojiPack.values());
      if (existing.some((e) => e.name === name || e.alias_of === name)) {
        throw new Error("If your emoji name is taken, choose another.");
      }

      // Exactly one source check: count the sources before handling any.
      const sources = [alias_of, url, media_url, data_base64].filter((s) => s !== "").length;
      if (sources !== 1) {
        throw new Error("exactly one source must be present");
      }

      if (alias_of) {
        customEmojiPack.set(name, {
          name,
          alias_of,
          content_type: "",
          width: 0,
          height: 0,
          source,
          added_ms: Date.now(),
          data_base64: "",
        });
      } else if (url) {
        let host = "";
        try {
          const parsed = new URL(url);
          host = parsed.hostname;
        } catch {
          throw new Error("URL has no host");
        }
        const domain = registrableDomain(host);
        const hue = hashString(url) % 360;
        const png = solidPng(20, 20, hslToRgb(hue, 0.72, 0.52));
        customEmojiPack.set(name, {
          name,
          alias_of: "",
          content_type: "image/png",
          width: 20,
          height: 20,
          source: `url:${domain}`,
          added_ms: Date.now(),
          data_base64: png.toString("base64"),
        });
      } else if (media_url) {
        // Teams-hosted media URL check: mirrors teams_media::is_allowed_media_url.
        // Only URLs on the backend's allowlist are accepted; this check prevents a
        // hostile client from making the mock hand over synthesized art for a URL
        // the backend would refuse.
        const teamsMediaHosts = [
          "api.asm.skype.com",
          "api.flightproxy.teams.microsoft.com",
          "teams.microsoft.com",
          "statics.teams.cdn.office.net",
          "asyncgw.teams.microsoft.com",
        ];
        let allowed = false;
        try {
          const parsed = new URL(media_url);
          const host = parsed.hostname.toLowerCase();
          allowed = teamsMediaHosts.some((base) => host === base || host.endsWith(`.${base}`));
        } catch {
          /* invalid URL */
        }
        if (!allowed) {
          throw new Error("Only Teams-hosted media URLs are allowed");
        }

        const hue = hashString(media_url) % 360;
        const png = solidPng(20, 20, hslToRgb(hue, 0.72, 0.52));
        customEmojiPack.set(name, {
          name,
          alias_of: "",
          content_type: "image/png",
          width: 20,
          height: 20,
          source: "message",
          added_ms: Date.now(),
          data_base64: png.toString("base64"),
        });
      } else if (data_base64) {
        // The bytes are measured rather than believed, because the backend measures them
        // too and a check the mock skips is one no UI test can exercise.
        const measured = measureMockEmojiArt(Buffer.from(data_base64, "base64"));
        customEmojiPack.set(name, {
          name,
          alias_of: "",
          content_type: measured.contentType,
          width: measured.width,
          height: measured.height,
          source,
          added_ms: Date.now(),
          data_base64,
        });
      }
      broadcast("custom_emoji_changed", {});
      return { added: true };
    }

    case "custom_emoji_remove": {
      const name = requireString(params, "name");
      const removed = customEmojiPack.delete(name);
      if (removed) broadcast("custom_emoji_changed", {});
      return { removed };
    }

    case "custom_emoji_import": {
      const o = asObject(params);
      const emoji = Array.isArray(o.emoji) ? o.emoji : [];
      let added = 0;
      const errors: string[] = [];

      for (const e of emoji) {
        if (typeof e !== "object" || !e || typeof e.name !== "string") {
          continue;
        }

        const name = e.name;

        // Name shape check: same validation as custom_emoji_add.
        if (
          name.length === 0 ||
          name.length > 64 ||
          !/^[a-z0-9]/.test(name) ||
          !/^[a-z0-9_+\-]+$/.test(name)
        ) {
          errors.push(`${name}: invalid name`);
          continue;
        }

        const existing = Array.from(customEmojiPack.values());
        if (existing.some((ex) => ex.name === name || ex.alias_of === name)) {
          errors.push(`${name}: name taken`);
          continue;
        }

        const alias_of = typeof e.alias_of === "string" ? e.alias_of : "";
        const data_base64 = typeof e.data_base64 === "string" ? e.data_base64 : "";

        if (alias_of && !data_base64) {
          // Alias entry.
          customEmojiPack.set(name, {
            name,
            alias_of,
            content_type: "",
            width: 0,
            height: 0,
            source: "import",
            added_ms: Date.now(),
            data_base64: "",
          });
          added++;
        } else if (!alias_of && data_base64) {
          // Art entry: the same measurement `custom_emoji_add` makes, refused the way the
          // backend refuses a row of a pack file — `<name>: <the sentence>`.
          try {
            const measured = measureMockEmojiArt(Buffer.from(data_base64, "base64"));
            customEmojiPack.set(name, {
              name,
              alias_of: "",
              content_type: measured.contentType,
              width: measured.width,
              height: measured.height,
              source: "import",
              added_ms: Date.now(),
              data_base64,
            });
            added++;
          } catch (err) {
            errors.push(`${name}: ${err instanceof Error ? err.message : "validation failed"}`);
          }
        } else {
          errors.push(`${name}: must have exactly one of alias_of or data_base64`);
        }
      }

      if (added > 0) broadcast("custom_emoji_changed", {});
      return { added, errors };
    }

    // ---- push notifications ------------------------------------------------
    // The mock accepts a subscription and answers with a plausible status, so a
    // spec or `bun run preview` can drive the whole Settings flow. It never sends
    // anything: a real push needs Apple's or Google's service and a real device, so
    // `push_test` reports what it is — nothing delivered.

    case "push_status":
      return pushStatusView();

    case "push_subscribe": {
      const endpoint = requireString(params, "endpoint");
      const o = asObject(params);
      mockPushDevices.set(endpoint, {
        endpoint,
        label: typeof o.label === "string" ? o.label : "",
        created_ms: Date.now(),
        last_ok_ms: 0,
        last_error: "",
      });
      return pushStatusView();
    }

    case "push_unsubscribe": {
      const endpoint = requireString(params, "endpoint");
      const removed = mockPushDevices.delete(endpoint);
      return { ...pushStatusView(), removed };
    }

    case "push_test":
      return {
        delivered: 0,
        failed: mockPushDevices.size,
        errors: mockPushDevices.size > 0 ? ["the mock backend never sends a real push"] : [],
      };

    // ---- the local agent ---------------------------------------------------
    // The mock runs no CLI and posts nothing. It only remembers which conversations
    // are opted in, so the consent flow itself can be driven end to end.

    case "agent_status":
      return agentStatusView();

    case "agent_set_mode": {
      const conversation = requireString(params, "conversation");
      const mode = requireString(params, "mode") === "reply" ? "reply" : "off";
      mockAgentModes.set(conversation, mode);
      return agentStatusView();
    }

    case "agent_set_unrestricted": {
      mockAgentUnrestricted = asObject(params).unrestricted === true;
      return agentStatusView();
    }

    case "agent_stop": {
      // A run in flight is stopped by flagging its id; the running simulation sees the
      // flag between steps and finalizes with the answer so far. A flag for a run that is
      // not in flight answers `stopped: false`, exactly as the Rust registry does for a
      // run this backend does not own.
      const runId = requireString(params, "run_id");
      const stopped = mockAgentRunning.has(runId);
      if (stopped) mockAgentStopped.add(runId);
      return { stopped };
    }

    case "agent_set_tools": {
      const tools = asObject(params).tools;
      mockAgentTools = Array.isArray(tools)
        ? tools.filter((tool): tool is string => typeof tool === "string" && tool.trim() !== "")
        : [];
      return agentStatusView();
    }

    case "agent_set_provider": {
      const name = requireString(params, "provider");
      const provider = mockAgentProviders.get(name);
      if (!provider) throw new Error(`no such provider: ${name}`);
      const o = asObject(params);
      if (typeof o.enabled === "boolean") provider.enabled = o.enabled;
      if (typeof o.model === "string") {
        const model = o.model.trim();
        if (model.length === 0) {
          provider.model = null;
        } else {
          if (!isValidMockModel(model)) throw new Error(`\`${model}\` is not a model name`);
          provider.model = model;
        }
      }
      // Exactly one provider is the default, so `false` is refused rather than leaving
      // none — the same sentence the Rust handler answers with.
      if (typeof o.default === "boolean") {
        if (!o.default) {
          throw new Error(
            "a machine has exactly one default provider: name the other one instead of " +
              "clearing this one",
          );
        }
        mockAgentDefaultProvider = name;
      }
      return agentStatusView();
    }

    // ---- audio calling ------------------------------------------------------
    // Nothing is registered, nobody is rung, and no audio exists. The phases move on
    // timers so the page's own flow — prepare, negotiate, answer, mute, hang up — runs
    // end to end (see the calling block above).

    case "call_status":
      return mockCallStatus();

    case "call_prepare": {
      const o = asObject(params);
      if (!mockCallingEnabled) throw new Error("call_prepare: calling is not connected yet");
      // Answering: hand back the offer that is ringing, exactly like the Rust one.
      if (typeof o.call_id === "string") {
        if (!mockCall || mockCall.id !== o.call_id || mockCall.phase !== "ringing") {
          throw new Error("call_prepare: that call is not ringing");
        }
        return {
          call_id: mockCall.id,
          offer_sdp: MOCK_ANSWER_SDP,
          ice_servers: [{ urls: ["stun:mock.invalid:3478"] }],
        };
      }
      // Joining a meeting: reserve it from the address the caller named, exactly like the
      // Rust one — the link a calendar event carries, or the meeting's own thread out of
      // the chat list. The mock checks both shapes, so a spec can prove either refusal.
      if (typeof o.join_url === "string" || typeof o.meeting_thread === "string") {
        const thread = typeof o.meeting_thread === "string" ? o.meeting_thread : null;
        if (thread !== null && !thread.startsWith("19:meeting_")) {
          throw new Error("call_prepare: that conversation is not a meeting");
        }
        if (thread === null && !/\/meetup-join\/(19%3a|19:)/i.test(String(o.join_url))) {
          throw new Error("call_prepare: that is not a Teams meeting link");
        }
        if (mockCall && mockCall.phase !== "ended") {
          throw new Error("call_prepare: this machine is already in a call — leave it first");
        }
        clearMockCallTimers();
        // The title: from the caller when a calendar event supplied one, and otherwise
        // from the thread's own name, which is what the Rust backend reads out of its
        // store rather than minting a second spelling of it.
        const subject =
          typeof o.subject === "string" && o.subject.trim()
            ? o.subject.trim()
            : (thread && store.get(thread)?.conv.name) || "Meeting";
        mockCall = {
          id: `mock-meeting-${Date.now()}`,
          direction: "outgoing",
          kind: "meeting",
          // Joining, not ringing: nobody has to pick up.
          phase: "connecting",
          conversation_id: thread,
          peer: subject,
          peer_mri: "",
          others: [],
          other_mris: [],
          in_lobby: false,
          waiting_in_lobby: 0,
          muted: false,
          connected_at_ms: null,
          end_reason: null,
          publishing: [],
          sending: [],
          can_accept: false,
          can_hangup: true,
          can_send_media: false,
        };
        broadcastMockCall();
        return { call_id: mockCall.id, ice_servers: [{ urls: ["stun:mock.invalid:3478"] }] };
      }
      const conversation = requireString(params, "conversation");
      const thread = threadFor(conversation);
      if (!thread) throw new Error(`call_prepare: no such conversation: ${conversation}`);
      if (mockCall && mockCall.phase !== "ended") {
        throw new Error("call_prepare: this machine is already in a call — hang up first");
      }
      // One person is a 1:1 call; several is a GROUP call, which rings every one of them
      // at once and names the CONVERSATION rather than a person — the same split the Rust
      // backend makes from the roster it fetches, and the same cap.
      const ring = thread.participants;
      if (ring.length === 0) {
        throw new Error(`call_prepare: nobody to ring in ${conversation}`);
      }
      if (ring.length > MOCK_MAX_GROUP_CALL_PEOPLE) {
        throw new Error(
          `call_prepare: ${conversation} has ${ring.length} other people — this app rings ` +
            `at most ${MOCK_MAX_GROUP_CALL_PEOPLE} at once`,
        );
      }
      const group = ring.length > 1;
      const person = ring[0];
      clearMockCallTimers();
      mockCall = {
        id: `mock-call-${Date.now()}`,
        direction: "outgoing",
        kind: group ? "group" : "call",
        phase: "dialing",
        conversation_id: conversation,
        peer: group ? (store.get(conversation)?.conv.name ?? "Group call") : (person?.name ?? "Someone"),
        peer_mri: group ? "" : (person?.mri ?? "8:orgid:someone"),
        others: [],
        other_mris: [],
        in_lobby: false,
        waiting_in_lobby: 0,
        muted: false,
        connected_at_ms: null,
        end_reason: null,
        publishing: [],
        sending: [],
        can_accept: false,
        can_hangup: true,
        can_send_media: false,
      };
      broadcastMockCall();
      const reserved = mockCall.id;
      // The frame above is out, so the page is already dialling: a hold here is the wait a
      // real start spends on the microphone, with the stage — and its Hang up — on screen.
      await holdMockCallStart("prepare");
      return {
        call_id: reserved,
        ice_servers: [{ urls: ["stun:mock.invalid:3478"] }],
        // The same split the Rust backend publishes: a 1:1 negotiates the camera and the
        // screen up front, a group adds them when somebody turns one on.
        one_to_one: !group,
      };
    }

    case "call_place": {
      const callId = requireString(params, "call_id");
      requireString(params, "sdp");
      if (!mockCall || mockCall.id !== callId) throw new Error("call_place: no such call");
      // A hold here is the POST itself: the invite is on the wire, and a hang-up in this
      // window is the one the Rust backend has to take back (`hang_up_orphan`).
      await holdMockCallStart("place");
      if (!mockCall || mockCall.id !== callId) {
        // The user hung up while the invite was going out. The real backend hangs the
        // placed call up on the links the answer carried; there is nothing to hang up
        // here, and the page must be told this call is not going to connect.
        return { call_id: callId, cancelled: true };
      }
      // The far side picks up, then their SDP arrives — the two frames the real
      // service sends, in the real order.
      mockCallTimers.push(
        setTimeout(() => {
          if (!mockCall || mockCall.id !== callId) return;
          mockCall = { ...mockCall, phase: "connecting" };
          broadcastMockCall();
          broadcast("call_media", { call_id: callId, sdp: MOCK_ANSWER_SDP, kind: "answer" });
        }, MOCK_CALL_ANSWER_MS),
      );
      mockCallTimers.push(
        setTimeout(() => {
          if (!mockCall || mockCall.id !== callId) return;
          // A GROUP call answers "who is in it" from the roster the service reports, the
          // way a meeting does — so the people who picked up arrive here and not before.
          const roster =
            mockCall.kind === "group"
              ? (store.get(mockCall.conversation_id ?? "")?.participants ?? [])
              : [];
          mockCall = {
            ...mockCall,
            phase: "connected",
            connected_at_ms: Date.now(),
            others: roster.map((p) => p.name),
            other_mris: roster.map((p) => p.mri),
          };
          broadcastMockCall();
        }, MOCK_CALL_CONNECT_MS),
      );
      return { call_id: callId };
    }

    case "call_join": {
      const callId = requireString(params, "call_id");
      requireString(params, "sdp");
      const address = asObject(params);
      // The same address the reservation named, in whichever shape it came — and exactly
      // one of the two, which is what the client sends (`meetingParams`).
      if (typeof address.join_url !== "string" && typeof address.meeting_thread !== "string") {
        throw new Error("call_join: no meeting named — pass join_url or meeting_thread");
      }
      if (!mockCall || mockCall.id !== callId) throw new Error("call_join: no such meeting");
      // The lobby first, then somebody lets us in, then the roster arrives. Three
      // frames, in the order the real service sends them — which is what makes the
      // states the UI draws reviewable.
      mockCall = { ...mockCall, in_lobby: true };
      broadcastMockCall();
      mockCallTimers.push(
        setTimeout(() => {
          if (!mockCall || mockCall.id !== callId) return;
          mockCall = {
            ...mockCall,
            in_lobby: false,
            phase: "connected",
            connected_at_ms: Date.now(),
            // The service refuses new media on a call that is not established, so the
            // camera and share buttons appear exactly here and not before.
            can_send_media: true,
          };
          broadcastMockCall();
        }, MOCK_CALL_ANSWER_MS),
      );
      mockCallTimers.push(
        setTimeout(() => {
          if (!mockCall || mockCall.id !== callId) return;
          mockCall = {
            ...mockCall,
            others: MOCK_MEETING_ROSTER,
            other_mris: MOCK_MEETING_ROSTER.map(
              (name) => PEOPLE.find((p) => p.name === name)?.mri ?? "8:orgid:someone",
            ),
            publishing: mockPublishing(MOCK_MEETING_ROSTER),
          };
          broadcastMockCall();
          // And then the service renegotiates ON ITS OWN, offering the sections for what
          // those people are publishing. The real one does this ~9 s in, unprompted; the
          // mock does it right after the roster so the whole receive path — answer,
          // subscribe, draw — runs in one pass of a spec.
          broadcast("call_media", {
            call_id: callId,
            sdp: MOCK_RENEGOTIATION_OFFER,
            kind: "offer",
          });
        }, MOCK_CALL_CONNECT_MS),
      );
      return { call_id: callId };
    }

    case "call_accept": {
      const callId = requireString(params, "call_id");
      requireString(params, "sdp");
      if (!mockCall || mockCall.id !== callId) throw new Error("call_accept: no such call");
      mockCall = {
        ...mockCall,
        phase: "connected",
        connected_at_ms: Date.now(),
        can_accept: false,
        can_send_media: true,
      };
      broadcastMockCall();
      return { call_id: callId };
    }

    // The answer to a renegotiation the service offered. It carries the page's own SDP and
    // the modalities it declares, and the mock checks both the way the backend does: a name
    // outside the four the service knows is refused, because a modality is a claim about
    // what this machine is sending.
    case "call_answer_media": {
      const callId = requireString(params, "call_id");
      requireString(params, "sdp");
      const o = asObject(params);
      const modalities = Array.isArray(o.modalities) ? o.modalities : [];
      for (const name of modalities) {
        if (!["audio", "Video", "ScreenSharer", "ScreenViewer"].some(
          (known) => String(name).toLowerCase() === known.toLowerCase(),
        )) {
          throw new Error(`${JSON.stringify(name)} is not a modality this app negotiates`);
        }
      }
      if (!mockCall || mockCall.id !== callId) {
        throw new Error("call_answer_media: no such call");
      }
      return { call_id: callId };
    }

    // OFFERING new media: the user's camera, or their screen. The mock records what the page
    // says it is sending and publishes it, because that state belongs to the machine and not
    // to one page — which is exactly the thing a second open page would get wrong.
    case "call_offer_media": {
      const callId = requireString(params, "call_id");
      requireString(params, "sdp");
      const o = asObject(params);
      const modalities = Array.isArray(o.modalities) ? o.modalities : [];
      for (const name of modalities) {
        if (!["audio", "Video", "ScreenSharer", "ScreenViewer"].some(
          (known) => String(name).toLowerCase() === known.toLowerCase(),
        )) {
          throw new Error(`${JSON.stringify(name)} is not a modality this app negotiates`);
        }
      }
      if (!mockCall || mockCall.id !== callId) throw new Error("call_offer_media: no such call");
      // The ORDER, for the rule no screen can show: the session is asked for before the
      // section is offered.
      if (Array.isArray(o.sending) && o.sending.includes("screen")) {
        mockSharingOrder.push("offer_media");
      }
      // Armed by the `{kind:"call_media", refuse:true}` test hook, and spent here: one
      // refusal, so the click after it works and the surface is seen recovering.
      if (mockRefusesNextMedia) {
        mockRefusesNextMedia = false;
        throw new Error("call_offer_media: the service refused this media offer");
      }
      if (mockCall.phase !== "connected") {
        throw new Error(
          "call_offer_media: this call is not connected yet — the service refuses new media " +
            "on a call that is not established",
        );
      }
      const sending = Array.isArray(o.sending) ? o.sending.map(String) : [];
      mockCall = { ...mockCall, sending };
      broadcastMockCall();
      // The real service answers in the response for this negotiation, so the mock does too:
      // a page that waited for a frame the backend never sends would never apply an answer.
      return { call_id: callId, answer_sdp: MOCK_ANSWER_SDP };
    }

    // A subscription: put somebody's source on one of our sections. It publishes nothing
    // about the user, so it is the one call method the mock can answer with no state at all
    // — the picture itself comes from the page's own simulated media.
    case "call_subscribe": {
      const callId = requireString(params, "call_id");
      requireString(params, "mid");
      requireString(params, "stream_msid");
      const o = asObject(params);
      if (typeof o.source_id !== "number") throw new Error("call_subscribe: source_id is required");
      if (!mockCall || mockCall.id !== callId) throw new Error("call_subscribe: no such call");
      return { call_id: callId, source_id: o.source_id };
    }

    // The meeting's content-sharing session: a screen share asks for one before it offers a
    // section, because a meeting shows ONE screen at a time and the service rejects a section
    // from an endpoint that never asked. Reproduced so the ORDER is reviewable — the modality
    // first, the media after it — with no tenant and no presenter.
    case "call_start_sharing": {
      const callId = requireString(params, "call_id");
      if (!mockCall || mockCall.id !== callId) throw new Error("call_start_sharing: no such call");
      if (mockSharingSession) {
        throw new Error("call_start_sharing: this call already holds a sharing session");
      }
      mockSharingSession = `mock-sharing-${callId}`;
      mockSharingOrder.push("start_sharing");
      // And the session CHANGES HANDS: a meeting shows one screen at a time, so granting it
      // here takes the old presenter's share down.
      takeMockShareFromPresenter(callId);
      return { call_id: callId, can_stop: true };
    }

    case "call_stop_sharing": {
      const callId = requireString(params, "call_id");
      if (!mockCall || mockCall.id !== callId) throw new Error("call_stop_sharing: no such call");
      const told = mockSharingSession !== null;
      mockSharingSession = null;
      return { call_id: callId, told_service: told };
    }

    case "call_hangup": {
      const callId = requireString(params, "call_id");
      if (!mockCall || mockCall.id !== callId) throw new Error("call_hangup: no such call");
      const declining = mockCall.direction === "incoming" && mockCall.phase === "ringing";
      endMockCall(declining ? "CallEndReasonDeclined" : "CallEndReasonHangup");
      return { call_id: callId, told_service: true };
    }

    case "call_mute": {
      const callId = requireString(params, "call_id");
      const o = asObject(params);
      if (typeof o.muted !== "boolean") throw new Error("`muted` must be true or false");
      if (!mockCall || mockCall.id !== callId) throw new Error("call_mute: no such call");
      mockCall = { ...mockCall, muted: o.muted };
      broadcastMockCall();
      return { call_id: callId, muted: o.muted, told_service: true };
    }

    case "get_settings":
      return settingsView();

    // The Linear workspace a bare `ENG-1` is addressed in (see lib/tracker-ref.ts). A read
    // this mock can answer with no Linear at all, because it is two facts rather than a
    // lookup: how the workspace is addressed, and which team keys it holds.
    case "linear_workspace":
      return {
        workspace: mockSettings.linear_token.length > 0 ? MOCK_LINEAR_WORKSPACE : null,
        read_at_ms: Date.now(),
      };

    case "set_settings": {
      const o = asObject(params);
      if (typeof o.gitlab_host === "string") mockSettings.gitlab_host = o.gitlab_host.trim();
      if (typeof o.gitlab_token === "string") mockSettings.gitlab_token = o.gitlab_token.trim();
      if (typeof o.linear_token === "string") mockSettings.linear_token = o.linear_token.trim();
      if (typeof o.ghost_mode === "boolean") mockSettings.ghost_mode = o.ghost_mode;
      if (typeof o.sender_icons === "boolean") mockSettings.sender_icons = o.sender_icons;
      if (typeof o.emoji_auto_import === "boolean") {
        mockSettings.emoji_auto_import = o.emoji_auto_import;
      }
      return settingsView();
    }

    // The real backend registers a Teams endpoint here and refreshes it (see
    // `set_always_available` in src/bin/server.rs). The mock only remembers the flag:
    // nothing leaves the machine, which is what makes driving the switch safe.
    case "set_always_available": {
      const o = asObject(params);
      if (typeof o.enabled !== "boolean") throw new Error("`enabled` must be true or false");
      mockSettings.always_available = o.enabled;
      return settingsView();
    }

    // Each provider claims its own host, exactly as `link_preview::enrich` does.
    case "enrich_link": {
      const url = requireString(params, "url");
      // EITHER card names people, so both go through the same walk the page's answers do.
      return withMockTeamsPeople({
        metadata: mockGitLabMetadata(url) ?? mockLinearMetadata(url),
      });
    }

    // Who has approved a merge request. A read, ungated like `enrich_link`.
    case "gitlab_approvals": {
      const url = requireString(params, "url");
      return mockApprovalResult(url);
    }

    // Give or take back the user's own approval — the one write this app makes to a
    // tracker (`gitlab_set_approval`, an OUTWARD_METHODS entry). Nothing leaves this
    // machine: the state lives in `mockApprovals`, so the whole surface — the two-step
    // confirmation, the outcome in the menu, the revoke that follows — is reviewable with
    // no GitLab and no token.
    case "gitlab_set_approval": {
      const url = requireString(params, "url");
      const o = asObject(params);
      if (typeof o.approved !== "boolean") throw new Error("`approved` must be true or false");
      const state = mockApprovalFor(url);
      if (!state) throw new Error("not a merge request on the configured GitLab host");
      // The refusal the real backend reports when GitLab will not have it (see `refusal`
      // in src/gitlab_approval.rs). Armed by the `{kind:"gitlab_approval"}` test hook, so
      // a spec can hold the app to reporting a failed approval instead of swallowing it.
      if (mockApprovalRefusal) throw new Error(mockApprovalRefusal);
      // The user's own approval is the only thing this write moves; every count follows
      // from it in `mockApprovalResult`, the way GitLab derives them.
      state.mine = o.approved;
      return mockApprovalResult(url);
    }

    // ---- the merge-request page --------------------------------------------
    //
    // Four reads, then four writes. The reads answer from the fixtures above; the writes
    // move them and broadcast, so a second page follows exactly as it would against the
    // real backend. Nothing here contacts GitLab, which is what makes the merge — the one
    // irreversible action in this app — reviewable at all.

    case "gitlab_mr_list": {
      const o = asObject(params);
      const scope = typeof o.scope === "string" ? o.scope : "all";
      const state = typeof o.state === "string" ? o.state : "opened";
      // The two closed sets the backend enforces. A mock that accepted anything would let
      // a bug through that the real backend refuses.
      if (!["all", "assigned", "mine", "reviewing"].includes(scope)) {
        throw new Error(`unknown scope: ${scope}`);
      }
      if (!["opened", "closed"].includes(state)) {
        throw new Error(`a merge-request list is opened or closed, not ${state}`);
      }
      if (mockGitLabTokenMissing) {
        return { scope, state, items: [], truncated: false, token_set: false };
      }
      const items = mockMergeRequests
        .filter((mr) => mr.state === state)
        .filter((mr) => {
          if (scope === "mine") return mr.author.username === MOCK_GITLAB_ME.username;
          if (scope === "assigned") {
            return mr.assignees.some((p) => p.username === MOCK_GITLAB_ME.username);
          }
          if (scope === "reviewing") {
            return mr.reviewers.some((p) => p.username === MOCK_GITLAB_ME.username);
          }
          return true;
        })
        .map(mockMergeRequestRow);
      // Every answer this page gets says who its people are in Teams, exactly as the
      // backend's does — see `withMockTeamsPeople`.
      return withMockTeamsPeople({
        scope,
        state,
        items,
        total: items.length,
        truncated: false,
        token_set: true,
      });
    }

    case "gitlab_mr_detail": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      return withMockTeamsPeople(mockMergeRequestDetail(mr));
    }

    case "gitlab_mr_notes": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      return withMockTeamsPeople(mockDiscussionList(mr));
    }

    case "gitlab_mr_pipeline": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      return mockPipelineView(mr);
    }

    // What the merge request CHANGED. `depth` is the closed set the backend keeps, so an
    // unknown name is refused here too rather than quietly read as the cheap one — a page
    // served the plain diff for the expanded read it asked for would report the files GitLab
    // withheld as files GitLab withheld twice.
    // ONE job's LOG, for the page a job card opens. The biggest read on this surface, and the one
    // whose freshness the ANSWER decides: `complete` is what the page polls on.
    case "gitlab_mr_job_log": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const jobId = requireNumber(params, "job_id");
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabJobLogRefusal) throw new Error(mockGitLabJobLogRefusal);
      return mockJobLog(mr, jobId);
    }

    case "gitlab_mr_diff": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const depth = asObject(params).depth ?? "listed";
      if (depth !== "listed" && depth !== "raw") {
        throw new Error(`a diff is listed or raw, not ${String(depth)}`);
      }
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabDiffRefusal) throw new Error(mockGitLabDiffRefusal);
      return mockDiffFor(mr, depth);
    }

    // One PICTURE a description or a comment points at. The real backend asks GitLab's own
    // upload API with the token, sniffs the bytes and hands them over base64; this answers with
    // a picture it draws itself, so the whole surface is reviewable with no GitLab and no
    // token. The upload is named by its three parts here exactly as it is there, so a page
    // that assembled a URL instead would fail against both.
    case "gitlab_mr_upload": {
      const projectPath = requireString(params, "project_path");
      const secret = requireString(params, "secret");
      const filename = requireString(params, "filename");
      if (!/^[0-9a-f]{16,64}$/i.test(secret)) throw new Error("that is not a GitLab upload secret");
      if (!filename || filename.includes("/")) {
        throw new Error("that is not a GitLab upload filename");
      }
      const upload = mockUploads.get(`${projectPath}:${secret}`);
      if (!upload) {
        throw new Error("GitLab no longer holds this picture, or the token cannot see it");
      }
      if (mockGitLabUploadRefusal) throw new Error(mockGitLabUploadRefusal);
      const png = solidPng(upload.width, upload.height, hslToRgb(upload.hue, 0.5, 0.62));
      return { content_type: "image/png", data_base64: png.toString("base64") };
    }

    // MERGE. The one write in this app that no later call takes back — and the `sha` is
    // what stands between it and landing a commit nobody read, so this mock checks it the
    // way GitLab does: a mismatch is the 409 the page has to report.
    case "gitlab_mr_merge": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const sha = requireString(params, "sha");
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabWriteRefusal) throw new Error(mockGitLabWriteRefusal);
      if (sha !== mr.sha) {
        throw new Error(
          "GitLab refused: the branch moved since this page read it, so nothing was merged — reload and look again",
        );
      }
      if (mr.detailed_merge_status !== "mergeable") {
        throw new Error(
          "GitLab refused: it will not merge it yet — a pipeline, an approval, a conflict or an unresolved thread is in the way (405)",
        );
      }
      mr.state = "merged";
      mr.detailed_merge_status = "not_open";
      mr.merged_at = new Date().toISOString();
      mr.updated_at = mr.merged_at;
      broadcastMockMergeRequest(mr);
      return { merge: { state: "merged", merge_commit_sha: `merge-${mr.sha.slice(0, 8)}`, merged_at: mr.merged_at } };
    }

    // COMMENT — a new one, a reply into a thread, or a new thread on a DIFF LINE.
    case "gitlab_mr_comment": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const body = requireString(params, "body");
      const o = asObject(params);
      const discussionId = typeof o.discussion_id === "string" ? o.discussion_id : null;
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabWriteRefusal) throw new Error(mockGitLabWriteRefusal);
      if (body.trim() === "") throw new Error("an empty comment says nothing, so it is not posted");
      // The rail the real backend holds: a reply lands in the thread it answers, which
      // already hangs where it hangs, so it cannot also name a line.
      const position = mockDiffNotePosition(o.position);
      if (position && discussionId) {
        throw new Error("a reply lands in the thread it answers, so it cannot also name a diff line");
      }

      const note: MockNote = {
        id: ++mockNoteId,
        author: MOCK_GITLAB_ME,
        body: body.trim(),
        system: false,
        created_at: new Date().toISOString(),
        // A comment on a diff line starts a THREAD, which is what makes it resolvable — the
        // same thing GitLab's own `/discussions` answer says.
        resolvable: discussionId !== null || position !== undefined,
        resolved: false,
        mine: true,
        position,
      };
      const thread = discussionId ? mr.discussions.find((d) => d.id === discussionId) : undefined;
      if (discussionId && !thread) throw new Error("that thread is not on this merge request");
      if (thread) thread.notes.push(note);
      else {
        mr.discussions.push({
          id: `d-${mr.iid}-${note.id}`,
          individual_note: position === undefined,
          notes: [note],
        });
      }
      mr.updated_at = note.created_at;
      broadcastMockMergeRequest(mr);
      return withMockTeamsPeople({ note: { ...note, discussion_id: thread?.id } });
    }

    // EDIT one of the user's OWN comments. The real backend re-reads whose it is before it
    // writes and refuses a colleague's, so this mock refuses the same way — and it moves
    // `updated_at`, which is the only thing that makes the "edited" mark real here.
    case "gitlab_mr_edit_comment": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const noteId = requireNumber(params, "note_id");
      const body = requireString(params, "body");
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabWriteRefusal) throw new Error(mockGitLabWriteRefusal);
      if (body.trim() === "") {
        throw new Error("an edit cannot empty a comment — delete it instead, which asks first");
      }
      const note = mr.discussions.flatMap((d) => d.notes).find((one) => one.id === noteId);
      if (!note) throw new Error("that comment is no longer on the merge request");
      if (!note.mine) {
        throw new Error(
          "that comment is somebody else's — this app only edits what the user wrote themselves",
        );
      }
      note.body = body.trim();
      note.updated_at = new Date().toISOString();
      mr.updated_at = note.updated_at;
      broadcastMockMergeRequest(mr);
      const owner = mr.discussions.find((d) => d.notes.some((one) => one.id === noteId));
      return withMockTeamsPeople({ note: { ...note, discussion_id: owner?.id } });
    }

    // RESOLVE a thread, or open it again. GitLab marks the NOTES, so this does too — which is
    // what the page reads back to decide whether a thread is settled. A comment of its own
    // carries no such state, and the real service answers 400 for one; this mock says the same
    // thing in the same words, so the rail is exercised rather than assumed.
    case "gitlab_mr_resolve_thread": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const discussionId = requireString(params, "discussion_id");
      const resolved = asObject(params).resolved === true;
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabWriteRefusal) throw new Error(mockGitLabWriteRefusal);
      const thread = mr.discussions.find((d) => d.id === discussionId);
      if (!thread) throw new Error("that thread is not on this merge request any more");
      if (!thread.notes.some((note) => note.resolvable)) {
        throw new Error(
          "GitLab refused: only a thread can be resolved, and this is a comment of its own",
        );
      }
      for (const note of thread.notes) {
        if (note.resolvable) note.resolved = resolved;
      }
      mr.updated_at = new Date().toISOString();
      broadcastMockMergeRequest(mr);
      return { discussion_id: discussionId, resolved };
    }

    // DELETE one of the user's OWN comments. The real backend re-reads whose it is before
    // it deletes, and refuses a colleague's; this mock refuses the same way, so the rail is
    // exercised rather than assumed.
    case "gitlab_mr_delete_comment": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const noteId = requireNumber(params, "note_id");
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabWriteRefusal) throw new Error(mockGitLabWriteRefusal);
      const owner = mr.discussions
        .flatMap((d) => d.notes)
        .find((note) => note.id === noteId);
      if (!owner) throw new Error("that comment is no longer on the merge request");
      if (!owner.mine) {
        throw new Error(
          "that comment is somebody else's — this app only deletes what the user wrote themselves",
        );
      }
      for (const discussion of mr.discussions) {
        discussion.notes = discussion.notes.filter((note) => note.id !== noteId);
      }
      mr.discussions = mr.discussions.filter((discussion) => discussion.notes.length > 0);
      broadcastMockMergeRequest(mr);
      return { deleted: noteId };
    }

    // CLOSE or REOPEN — each other's undo.
    case "gitlab_mr_set_state": {
      const projectPath = requireString(params, "project_path");
      const iid = requireNumber(params, "iid");
      const change = requireString(params, "change");
      if (change !== "close" && change !== "reopen") {
        throw new Error('`change` must be "close" or "reopen"');
      }
      const mr = mockMergeRequestFor(projectPath, iid);
      if (!mr) throw new Error("GitLab has no merge request there, or the token cannot see it");
      if (mockGitLabWriteRefusal) throw new Error(mockGitLabWriteRefusal);
      mr.state = change === "close" ? "closed" : "opened";
      mr.detailed_merge_status = change === "close" ? "not_open" : "not_approved";
      mr.closed_at = change === "close" ? new Date().toISOString() : undefined;
      mr.updated_at = new Date().toISOString();
      broadcastMockMergeRequest(mr);
      return { state: mr.state };
    }

    // ---- mail (read-only) --------------------------------------------------

    case "mail_folders":
      return mailFolders;

    case "mail_list": {
      const folder = requireString(params, "folder");
      const o = asObject(params);
      const limit = typeof o.limit === "number" ? o.limit : PAGE_SIZE;
      return mailPage(folder, null, limit);
    }

    case "mail_backfill": {
      const folder = requireString(params, "folder");
      const before = requireString(params, "before");
      const o = asObject(params);
      const limit = typeof o.limit === "number" ? o.limit : PAGE_SIZE;
      return mailPage(folder, before, limit);
    }

    case "mail_body": {
      const id = requireString(params, "id");
      const body = mailBodies.get(id);
      if (!body) throw new Error(`unknown mail: ${id}`);
      // The header rides along, exactly as the Rust backend sends it (it reads both
      // in one Graph request) — so a deep link renders subject and sender with no
      // list to take them from.
      return { ...body, header: mailHeaderById(id) };
    }

    // Clear one mail's unread marker. The real backend records this in its OWN
    // mirror and never tells Graph (see `mail_mark_read` in src/bin/server.rs), so
    // the mailbox keeps calling the mail unread; this mock holds one read state, so
    // it simply flips it and re-broadcasts the folder like the backend does.
    case "mail_mark_read": {
      const id = requireString(params, "id");
      const mail = mailHeaderById(id);
      if (!mail || mail.is_read) return { read: true, moved: false };
      mail.is_read = true;
      recomputeMailCounts();
      broadcast("mail_list_updated", {
        folder: mail.folder_id,
        ...mailPage(mail.folder_id, null, PAGE_SIZE),
      });
      broadcast("mail_folders_changed", {});
      return { read: true, moved: true };
    }

    case "mail_attachment": {
      const messageId = requireString(params, "message_id");
      const attachmentId = requireString(params, "attachment_id");
      const body = mailBodies.get(messageId);
      const attachment = body?.attachments.find((a) => a.id === attachmentId);
      if (!attachment) throw new Error(`unknown attachment: ${attachmentId}`);
      // Deterministic stand-in bytes, like `fetch_media` does for chat media.
      const media = mockMedia(`mail/${messageId}/${attachmentId}`);
      return { ...media, name: attachment.name };
    }

    // ---- calendar (read-only) ----------------------------------------------

    case "calendars":
      return MOCK_CALENDARS;

    case "calendar_view": {
      const start = requireString(params, "start");
      const end = requireString(params, "end");
      return mockCalendarView(start, end, optionalStringList(params, "calendars"));
    }

    default:
      throw new Error(`unknown method: ${method}`);
  }
}

/** Handle one text frame: parse, dispatch, reply. Never throws to the caller. */
async function handleFrame(ws: Socket, raw: string): Promise<void> {
  let req: { id?: unknown; method?: unknown; params?: unknown };
  try {
    req = JSON.parse(raw);
  } catch {
    return; // ignore malformed JSON
  }
  if (!req || typeof req !== "object") return;

  const id = req.id ?? 0;
  const method = typeof req.method === "string" ? req.method : "";
  const params = req.params ?? null;

  try {
    const result = await dispatch(method, params);
    sendJson(ws, { id, result });
  } catch (e) {
    sendJson(ws, { id, error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Simulated real-time: sent-message echoes + periodic incoming messages.
// ---------------------------------------------------------------------------

/** Edit a stored message in place and broadcast the new content, mirroring the
 *  Rust backend: it PUTs the message resource, updates the local row, then emits
 *  a `message` event that the UI reconciles by id (replacing the old bubble). */
function editMessage(convId: string, messageId: string, text: string): void {
  const t = threadFor(convId);
  if (!t) return;
  const msg = t.messages.find((m) => m.id === messageId);
  if (!msg) return;
  let content = escapeHtml(text);
  content = substituteCustomEmoji(content);
  if (msg.content === content) return; // no-op edit: nothing to broadcast
  msg.content = content;
  t.recompute();
  broadcast("message", nicknamed(msg));
  broadcast(t.changedEvent, {});
}

/** Flag a stored message as deleted and broadcast it, mirroring the Rust backend's
 *  `delete`: Teams keeps the message row and marks it, so the bubble becomes the
 *  "You deleted this message" placeholder instead of vanishing — and the body stays
 *  in the row, which is what the placeholder's Reveal unveils. */
function deleteMessage(convId: string, messageId: string): void {
  const t = threadFor(convId);
  if (!t) return;
  const msg = t.messages.find((m) => m.id === messageId);
  if (!msg || msg.deleted) return; // unknown, or already gone: nothing to broadcast
  msg.deleted = true;
  // The message event only, exactly like the Rust `delete`: the sidebar preview
  // belongs to Teams' own conversation sync, not to this call.
  broadcast("message", nicknamed(msg));
}

/** Toggle OUR reaction on a message and broadcast it, mirroring the Rust
 *  backend's `react`: Teams keeps one reaction per user, so clicking our current
 *  emotion removes it and any other key replaces it. Returns the resulting on/off
 *  (whether we now react with `key`). */
function reactMessage(
  convId: string,
  messageId: string,
  key: string,
  alwaysOn = false,
): boolean {
  const t = threadFor(convId);
  if (!t) return false;
  const msg = t.messages.find((m) => m.id === messageId);
  if (!msg) return false;

  const list = msg.reactions ?? [];
  // Drop our reaction from wherever it currently sits (one per user) — out of the
  // count AND out of the user list, which is what the tooltip is drawn from.
  const withoutMine = list
    .map((r) =>
      r.mine
        ? {
            ...r,
            count: r.count - 1,
            mine: false,
            mris: (r.mris ?? []).filter((mri) => mri !== SELF_MRI),
          }
        : r,
    )
    .filter((r) => r.count > 0);
  const wasMineKey = list.find((r) => r.mine)?.key;
  // Same key => toggle off. `alwaysOn` is what a PICK from the pack does: the real
  // backend uploads the art and mints a key that names that one object, so a pick can
  // never land on the key already there.
  const on = alwaysOn || wasMineKey !== key;

  let next = withoutMine;
  if (on) {
    const existing = withoutMine.find((r) => r.key === key);
    next = existing
      ? withoutMine.map((r) =>
          r.key === key
            ? { ...r, count: r.count + 1, mine: true, mris: [...(r.mris ?? []), SELF_MRI] }
            : r,
        )
      : [...withoutMine, { key, count: 1, mine: true, mris: [SELF_MRI] }];
  }

  msg.reactions = next;
  broadcast("message", nicknamed(msg));
  return on;
}

/** ~150ms after a `send`, echo the message back as the backend's trouter would,
 *  then clear the draft (matches src/bin/server.rs behavior on a successful send). */
/** Substitute each `:code:` in `html` with custom emoji markup, the same way the Rust
 *  backend does in `custom_emoji::substitute_codes`. A code the pack holds becomes
 *  `<img itemtype="http://schema.skype.com/Emoji" ... >`, a code it does not hold stays
 *  text. Skips `<code>`, `<pre>`, and reply quotes — the three regions the backend skips. */
function substituteCustomEmoji(html: string): string {
  const pack = Array.from(customEmojiPack.values());
  const names = new Map(pack.map((e) => [e.name, e]));
  const aliases = new Map(pack.filter((e) => e.alias_of).map((e) => [e.name, e.alias_of]));

  let out = "";
  let pos = 0;
  let skipDepth = { code: 0, pre: 0, blockquote: 0 };

  while (pos < html.length) {
    const tagStart = html.indexOf("<", pos);
    if (tagStart === -1) {
      out += substituteInText(html.slice(pos), names, aliases, skipDepth);
      break;
    }

    out += substituteInText(html.slice(pos, tagStart), names, aliases, skipDepth);

    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) {
      out += html.slice(tagStart);
      break;
    }

    const tag = html.slice(tagStart, tagEnd + 1);
    out += tag;
    pos = tagEnd + 1;

    const tagContent = html.slice(tagStart + 1, tagEnd).trim();
    const isClosing = tagContent.startsWith("/");
    const tagName = (isClosing ? tagContent.slice(1) : tagContent).split(/\s/)[0]?.toLowerCase();

    if (tagName === "code" || tagName === "pre" || tagName === "blockquote") {
      skipDepth[tagName as keyof typeof skipDepth] += isClosing ? -1 : 1;
      if (skipDepth[tagName as keyof typeof skipDepth] < 0) skipDepth[tagName as keyof typeof skipDepth] = 0;
    }
  }
  return out;
}

function substituteInText(
  text: string,
  names: Map<string, CustomEmojiEntry>,
  aliases: Map<string, string>,
  skipDepth: { code: number; pre: number; blockquote: number },
): string {
  if (skipDepth.code > 0 || skipDepth.pre > 0 || skipDepth.blockquote > 0) return text;

  let out = "";
  let pos = 0;
  const bytes = text.split("");

  while (pos < bytes.length) {
    if (bytes[pos] === ":") {
      const start = pos;
      pos++;
      let name = "";
      while (pos < bytes.length && bytes[pos] !== ":") {
        const c = bytes[pos];
        if (c && /[a-z0-9_+\-]/.test(c)) {
          name += c;
          pos++;
        } else {
          break;
        }
      }
      if (pos < bytes.length && bytes[pos] === ":" && name) {
        pos++;
        const target = aliases.get(name) || name;
        const emoji = names.get(target);
        if (emoji) {
          out += `<img itemtype="http://schema.skype.com/Emoji" itemid="${name}" alt=":${name}:" src="${emojiObjectUrl(name)}" width="20" height="20">`;
        } else {
          out += text.slice(start, pos);
        }
      } else {
        out += text.slice(start, pos);
      }
    } else {
      out += bytes[pos];
      pos++;
    }
  }
  return out;
}

function scheduleSendEcho(
  convId: string,
  text: string,
  replyTo: ReplyTo | undefined,
  contentHtml?: string,
  images: SendImage[] = [],
  mentions?: OutboundMention[],
): void {
  setTimeout(() => {
    const t = threadFor(convId);
    if (!t) return;
    const seq = nextSeq(t.messages);
    const body = substituteCustomEmoji(composeContent(text, replyTo, contentHtml));
    const imageHtml = images.map(sentImageContent).join("");
    const msg: ChatMessage = {
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: Date.now(),
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: body + imageHtml,
      is_self: true,
      // The body's mention spans carry only an index; this is what says whom each one
      // names, so a sent mention comes back rendered as a mention (like the real echo).
      ...(mentions && mentions.length > 0
        ? {
            mentions: mentions.map((m) => ({
              itemid: m.itemid,
              mri: m.mri,
              kind: "person" as const,
              display_name: m.display_name,
            })),
          }
        : {}),
    };
    t.messages.push(msg);
    t.recompute();
    t.setRead(true); // it's ours
    t.setDraft(""); // the accepted send clears the persisted draft
    broadcast("message", nicknamed(msg));
    broadcast(t.changedEvent, {});
    maybeRunMockAgent(convId, msg);
  }, SEND_ECHO_DELAY_MS);
}

// ---------------------------------------------------------------------------
// The local agent, simulated (mirrors `agent_reply` in src/bin/server.rs).
//
// The real feature runs a coding-agent CLI on the backend's machine. The mock has no
// CLI and no tenant — but it CAN reproduce the two things the UI is built on: the
// message that gets posted and then edited, and the `agent_stream` frames that let this
// app draw the answer being written. Without that, the whole streaming surface would be
// unreachable from the mock, and the only way to look at it would be the real account.
//
// It follows the real flow step for step: post the placeholder, narrate the run, edit
// the message a few times on the way (as a Teams client would see it), and land the
// signed answer. The gate is the real one too — a conversation nobody opted in gets
// nothing, exactly as `agent_live_message` refuses.
// ---------------------------------------------------------------------------

/** How long each step of the simulated run takes. Slow enough to look at, quick enough
 *  that a spec waiting for the answer is not waiting long. Overridable so a screenshot
 *  can slow the run down and a spec can hurry it up. */
const MOCK_AGENT_STEP_MS = Number(process.env.MOCK_AGENT_STEP_MS ?? 420);

/** What the simulated run answers, in the Markdown a CLI would emit. */
const MOCK_AGENT_ANSWER =
  "The backend listens on `19420`, and that is the send-capable one the always-on " +
  "service owns.\n\n" +
  "Two others sit beside it:\n" +
  "- **19421** — the hands-on dev backend, so both can run at once\n" +
  "- **19430** — read-only, which is what tooling talks to\n\n" +
  "```rust\nconst DEFAULT_PORT: u16 = 19420;\n```\n\n" +
  "The table in CLAUDE.md is the authority, and the defaults live in `src/bin/server.rs`.\n\n" +
  // The trackers an answer names, which is what the reference chips are for: a merge
  // request that lands on this app's own page, an issue that goes to Linear, one word that
  // only looks like a reference, and one inside code that must stay code (see
  // lib/tracker-ref.ts). It is written the way a CLI writes it: bare words, no markup.
  "acme/webapp!596 moved them there, ENG-1 tracks the rest, and the UTF-8 handling is " +
  "untouched. Write `!596` to name it in a message.";

/** One entry of the transcript on the wire — `agent_step_json` in src/bin/server.rs. */
type MockAgentStep =
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: string; target: string; done: boolean };

/**
 * How the run works itself out, in the order a CLI reports it: what the model reasons,
 * what it does about it, and what that leads it to reason next.
 *
 * Interleaved on purpose. The transcript's whole value is that order (see `agent::Step`),
 * and a fixture that reasoned once and then called two tools would let a panel that lost
 * the order look right.
 */
const MOCK_AGENT_SCRIPT: ({ kind: "thought"; text: string } | { kind: "tool"; tool: string; target: string })[] = [
  {
    kind: "thought",
    text:
      "The question is about the port. The table in CLAUDE.md lists them, and the " +
      "defaults are constants in the server binary — I should read both rather than " +
      "answer from memory.",
  },
  { kind: "tool", tool: "Grep", target: "DEFAULT_PORT" },
  {
    kind: "thought",
    text:
      "One hit, in src/bin/server.rs. The read-only port is declared beside it, so the " +
      "answer should name both rather than leave the reader to find the second one.",
  },
  { kind: "tool", tool: "Read", target: "src/bin/server.rs" },
  {
    kind: "thought",
    text: "19420 for the service, 19421 for the dev backend, 19430 read-only. That agrees with the table.",
  },
];

/** A reply/forward body with its QUOTE removed — `teams_read::strip_quoted_blocks`.
 *
 *  The trigger reads the body the same way the backend does, and the backend reads it
 *  with the quote gone. It matters for one shape in particular: "Answer with <agent>"
 *  writes a REPLY whose body opens with the prefix, so a mock that kept the quote would
 *  see the quoted author first and answer nothing at all. */
function withoutQuotedBlocks(html: string): string {
  return html.replace(
    /<blockquote[^>]*schema\.skype\.com\/(?:reply|forward)[^>]*>[\s\S]*?(?:<\/blockquote>|$)/gi,
    "",
  );
}

/** The backend a message asks for, or null — `agent_policy::split_prefix`, and the same
 *  rule: the address may sit ANYWHERE, as a word of its own, and something has to be left
 *  over to ask. */
function mockAgentBackend(text: string): string | null {
  let found: { backend: string; at: number } | null = null;
  for (const backend of ["claude", "opencode"]) {
    // A word of its own on both sides: the text opens there or whitespace separates it,
    // and it ends the text or is followed by something that ends a word — so
    // "@claudette" is another word and "ping@claude.example" is another kind of address.
    const at = new RegExp(`(^|\\s)@${backend}(?![\\p{L}\\p{N}_-])`, "iu").exec(text);
    if (!at) continue;
    const start = at.index + at[1]!.length;
    if (!found || start < found.at) found = { backend, at: start };
  }
  if (!found) return null;
  const rest = text.slice(found.at + found.backend.length + 1);
  // A bare "@claude" asks nothing, and neither does one with only its own punctuation.
  const prompt = `${text.slice(0, found.at)} ${rest.replace(/^[:,]+/, "")}`.trim();
  return prompt === "" ? null : found.backend;
}

/** Answer a trigger the user wrote, if the conversation is opted in.
 *
 *  The prefix is read out of the message's own CONTENT, not out of the `send` request's
 *  `text` — which is what the backend does (`command_for` reads `message.content`), and
 *  which matters: the rich composer puts the whole message in `content_html` and sends an
 *  empty `text`, so a mock that trusted that field would answer nothing at all. */
function maybeRunMockAgent(convId: string, trigger: ChatMessage): void {
  const backend = mockAgentBackend(plain(withoutQuotedBlocks(trigger.content)));
  if (!backend) return;
  // The consent gate, not a convenience: off is the default everywhere but the sandbox,
  // and a mock that answered regardless would make the switch untestable.
  if (mockAgentModes.get(convId) !== "reply") return;
  void simulateMockAgentRun(convId, trigger, backend);
}

async function simulateMockAgentRun(
  convId: string,
  trigger: ChatMessage,
  backend: string,
): Promise<void> {
  const t = threadFor(convId);
  if (!t) return;
  const step = () => new Promise((resolve) => setTimeout(resolve, MOCK_AGENT_STEP_MS));

  // The answer is posted as a native reply to the message that summoned it (`agent_send`
  // builds the same markup), so every body below opens with the trigger quoted.
  const quote = quoteBlock({
    compose_time: trigger.compose_time,
    sender: trigger.sender,
    sender_mri: trigger.sender_mri ?? "",
    preview: previewOf(trigger.content),
  });
  const body = (answer: string, pending: boolean) =>
    quote + agentSignedHtml(backend, answer, { pending });

  // 1. The placeholder, posted before the run starts — its id is what the edits address.
  const seq = nextSeq(t.messages);
  const reply: ChatMessage = {
    id: `${convId}#${seq}`,
    conversation_id: convId,
    seq,
    compose_time: Date.now(),
    sender: SELF_NAME,
    sender_mri: SELF_MRI,
    content: body("", true),
    is_self: true,
  };
  t.messages.push(reply);
  t.recompute();
  t.setRead(true);
  broadcast("message", reply);
  broadcast(t.changedEvent, {});

  const runId = `${convId}/${trigger.id}`;
  mockAgentRunning.add(runId);
  let toolsUsed = 0;
  let written = "";
  // The transcript the run has built so far. Every frame carries the WHOLE of it, the way
  // the backend's do — a dropped frame must cost nothing (see web/src/lib/agent-run.ts).
  const steps: MockAgentStep[] = [];
  const lastCall = (): MockAgentStep | undefined =>
    [...steps].reverse().find((entry) => entry.kind === "tool");
  // Derived, never tracked, exactly as `Answer::progress` derives it: a call in flight
  // beats everything, then an answer that has started arriving, then reasoning.
  const phase = (): string => {
    const call = lastCall();
    if (call && call.kind === "tool" && !call.done) return "working";
    return written ? "writing" : "thinking";
  };
  const frame = (over: Record<string, unknown> = {}) => {
    const call = lastCall();
    broadcast("agent_stream", {
      run_id: runId,
      conversation: convId,
      message_id: reply.id,
      backend,
      phase: phase(),
      text: written,
      steps: steps.map((entry) => ({ ...entry })),
      activity:
        call && call.kind === "tool"
          ? { tool: call.tool, target: call.target, done: call.done }
          : null,
      tools_used: toolsUsed,
      error: null,
      at: Date.now(),
      ...over,
    });
  };

  // The user's Stop, seen between steps — the stand-in for the Rust `select!` that drops
  // the run future. It finalizes with the answer so far and a "stopped by you" note over
  // the DONE signature, and ends the run as `done` (a stop is not a failure), which is
  // exactly what `agent_run_to_completion` does. Returns true when it fired, so each loop
  // can break out of its remaining steps.
  const stoppedNow = (): boolean => mockAgentStopped.has(runId);
  const finalizeStopped = (): void => {
    editAgentReply(convId, reply.id, quote + agentStoppedHtml(backend, written));
    frame({ phase: "done" });
  };

  try {
    // 2. The run works itself out: nothing at all for a beat (the model is being called),
    // then the transcript, an entry at a time — reasoning a clause at a time, and a tool
    // call held for as long as one takes.
    frame();
    await step();
    await step();
    for (const entry of MOCK_AGENT_SCRIPT) {
      if (stoppedNow()) return finalizeStopped();
      if (entry.kind === "thought") {
        const clauses = entry.text.split(". ");
        steps.push({ kind: "thought", text: "" });
        for (let i = 0; i < clauses.length; i += 1) {
          // The newest thought GROWS: reasoning is one text arriving, not a row per
          // fragment, and a client that appended instead would draw a paragraph a line.
          steps[steps.length - 1] = { kind: "thought", text: clauses.slice(0, i + 1).join(". ") };
          await step();
          if (stoppedNow()) return finalizeStopped();
          frame();
        }
        continue;
      }
      toolsUsed += 1;
      steps.push({ kind: "tool", tool: entry.tool, target: entry.target, done: false });
      await step();
      frame();
      await step();
      await step();
      steps[steps.length - 1] = { kind: "tool", tool: entry.tool, target: entry.target, done: true };
      frame();
    }

    // 3. Writing: the answer in bursts of uneven size, which is how a model streams and
    // therefore what the client's reveal has to smooth out.
    const bursts = burstsOf(MOCK_AGENT_ANSWER);
    for (let b = 0; b < bursts.length; b += 1) {
      written += bursts[b];
      await step();
      if (stoppedNow()) return finalizeStopped();
      frame();
      // The Teams-visible half: the message itself is edited as the answer grows, far
      // more coarsely than the stream (see AGENT_EDIT_INTERVAL).
      if (b % 3 === 0) {
        editAgentReply(convId, reply.id, body(written, true));
      }
    }

    // 4. Done: the authoritative answer, signed, in the message and on the stream. The
    // transcript rides the terminal frame too, because it is an overlay on the message and
    // this is the last frame that can carry it.
    await step();
    if (stoppedNow()) return finalizeStopped();
    written = MOCK_AGENT_ANSWER;
    editAgentReply(convId, reply.id, body(MOCK_AGENT_ANSWER, false));
    frame({ phase: "done" });
  } finally {
    // The run is over however it ended; a later `agent_stop` for this id must answer
    // `stopped: false`, and the flag is spent.
    mockAgentRunning.delete(runId);
    mockAgentStopped.delete(runId);
  }
}

/** Split an answer into uneven chunks, the way tokens actually arrive. Deterministic
 *  (a length-driven walk, no randomness) so a screenshot of a given step is stable. */
function burstsOf(text: string): string[] {
  const words = text.split(/(\s+)/).filter((piece) => piece !== "");
  const bursts: string[] = [];
  let i = 0;
  let size = 1;
  while (i < words.length) {
    bursts.push(words.slice(i, i + size * 2).join(""));
    i += size * 2;
    size = (size % 4) + 1;
  }
  return bursts;
}

/** The reply's body as `agent_policy::reply_html` / `thinking_html` build it: the answer
 *  as HTML, then the line that says a machine wrote it. */
function agentSignedHtml(backend: string, answer: string, opts: { pending: boolean }): string {
  const body = agentAnswerHtml(answer);
  if (!body) return `<p><em>${backend} is thinking…</em></p>`;
  const footer = opts.pending
    ? `<p><em>${backend} is writing…</em></p>`
    : `<p><em>— ${backend}, via teams-lite</em></p>`;
  return body + footer;
}

/** The reply's body for a run the user stopped, as `agent_policy::stopped_body` builds it:
 *  the answer so far, a "stopped by you" note, and the DONE signature LAST — which is what
 *  makes the reply read as a finished agent message (`agentAuthorship` matches the trailing
 *  `<p><em>…</em></p>`). An empty answer leaves the note standing alone. */
function agentStoppedHtml(backend: string, answer: string): string {
  return (
    agentAnswerHtml(answer) +
    `<p><em>— stopped by you</em></p>` +
    `<p><em>— ${backend}, via teams-lite</em></p>`
  );
}

/** The Markdown subset src/agent_markdown.rs renders, as much of it as the fixture
 *  needs: fenced code, bullet lists, bold, inline code, paragraphs. */
function agentAnswerHtml(markdown: string): string {
  const lines = markdown.split("\n");
  let html = "";
  let i = 0;
  const inline = (text: string) =>
    escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  while (i < lines.length) {
    const line = (lines[i] ?? "").trimEnd();
    i += 1;
    if (line.startsWith("```")) {
      const code: string[] = [];
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        code.push(escapeHtml(lines[i] ?? ""));
        i += 1;
      }
      i += 1;
      html += `<pre><code>${code.join("\n")}</code></pre>`;
      continue;
    }
    if (line.trim() === "") continue;
    const isItem = (candidate: string) => /^[-*+] /.test(candidate.trimStart());
    if (isItem(line)) {
      const items = [line];
      while (i < lines.length && isItem(lines[i] ?? "")) {
        items.push((lines[i] ?? "").trimEnd());
        i += 1;
      }
      html += `<ul>${items
        .map((item) => `<li>${inline(item.trimStart().slice(2))}</li>`)
        .join("")}</ul>`;
      continue;
    }
    html += `<p>${inline(line.trim())}</p>`;
  }
  return html;
}

/** Replace an agent reply's HTML body and broadcast it — the mock's equivalent of the
 *  backend editing the message it posted. Unlike `editMessage` this takes HTML, because
 *  that is what the real edit carries. */
function editAgentReply(convId: string, messageId: string, content: string): void {
  const t = threadFor(convId);
  if (!t) return;
  const msg = t.messages.find((m) => m.id === messageId);
  if (!msg || msg.content === content) return;
  msg.content = content;
  t.recompute();
  broadcast("message", nicknamed(msg));
  broadcast(t.changedEvent, {});
}

/** Every ~7s, drop an incoming (is_self:false) message into a random chat and
 *  push it live, so live updates and notifications are exercised in the UI. */
function startLiveFeed(): void {
  if (LIVE_INTERVAL_MS <= 0) return; // deterministic mode (e.g. E2E): no feed
  setInterval(() => {
    if (sockets.size === 0) return; // no listeners → don't grow history pointlessly

    // Pick a random thread (chat OR channel) that has someone else who can talk
    // to us, so both the Chats and Channels tabs see live traffic.
    const candidates = [...order, ...channelOrder]
      .map((id) => ({ id, t: threadFor(id)! }))
      .filter((c) => c.t.participants.length > 0);
    if (candidates.length === 0) return;
    const { id, t } = pick(candidates, Math.random);
    const person = pick(t.participants, Math.random);
    const seq = nextSeq(t.messages);

    // Occasionally reply to the latest message; otherwise a fresh line.
    const last = t.messages.at(-1);
    const content =
      last && Math.random() < 0.2
        ? replyContent(last, pick(REPLY_BODIES, Math.random))
        : escapeHtml(pick(MESSAGE_POOL, Math.random));

    const msg: ChatMessage = {
      id: `${id}#${seq}`,
      conversation_id: id,
      seq,
      compose_time: Date.now(),
      sender: person.name,
      sender_mri: person.mri,
      content,
      is_self: false,
    };
    t.messages.push(msg);
    t.recompute();
    t.setRead(false); // a new incoming message is unread
    broadcast("message", nicknamed(msg));
    broadcast(t.changedEvent, {});
  }, LIVE_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Test control plane (gated by MOCK_TEST_HOOKS) — deterministic live events.
// ---------------------------------------------------------------------------

/** Inject a message into a conversation and broadcast it live, exactly like the
 *  live feed / send echo do. Returns the message, or null if the conversation
 *  is unknown. Used only by the gated HTTP test hook. */
function injectMessage(input: {
  conversation: string;
  content: string;
  sender?: string;
  senderMri?: string;
  isSelf?: boolean;
  reply?: boolean;
  /** The body VERBATIM, for a spec that is about the markup rather than the words — an
   *  agent's own signature line, say, which is what tells this app a reply is still being
   *  written. `content` is escaped, so it cannot carry one. */
  html?: string;
}): ChatMessage | null {
  const t = threadFor(input.conversation);
  if (!t) return null;
  const isSelf = input.isSelf ?? false;
  const fallback = t.participants[0];
  const sender = input.sender ?? (isSelf ? SELF_NAME : (fallback?.name ?? "Someone"));
  const senderMri =
    input.senderMri ?? (isSelf ? SELF_MRI : (fallback?.mri ?? "8:orgid:someone"));
  const seq = nextSeq(t.messages);
  const last = t.messages.at(-1);
  const content =
    input.html ??
    (input.reply && last ? replyContent(last, input.content) : escapeHtml(input.content));
  const msg: ChatMessage = {
    id: `${input.conversation}#${seq}`,
    conversation_id: input.conversation,
    seq,
    compose_time: Date.now(),
    sender,
    sender_mri: senderMri,
    content,
    is_self: isSelf,
  };
  t.messages.push(msg);
  t.recompute();
  t.setRead(isSelf); // an incoming message is unread; ours is read
  broadcast("message", nicknamed(msg));
  broadcast(t.changedEvent, {});
  return msg;
}

/** Handle the gated test HTTP endpoints. Returns null when not a test route. */
async function handleTestHook(req: Request, url: URL): Promise<Response | null> {
  if (!TEST_HOOKS) return null;
  if (req.method === "POST" && url.pathname === "/__test/emit") {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      /* tolerate an empty/invalid body */
    }
    // Inject an activity-feed entry (reaction/mention) rather than a chat
    // message, then nudge the client to refresh — exercises the bell + panel.
    if (body.kind === "notification") {
      injectedNotifications.unshift({
        id: `act-live-${Date.now()}`,
        activity_type: typeof body.activity_type === "string" ? body.activity_type : "reactionInChat",
        activity_subtype: typeof body.activity_subtype === "string" ? body.activity_subtype : "laugh",
        actor_name: typeof body.actor_name === "string" ? body.actor_name : "Riley Carter",
        actor_mri: "8:orgid:riley",
        source_thread_id:
          typeof body.source_thread_id === "string" ? body.source_thread_id : (order[0] ?? ""),
        source_message_id:
          typeof body.source_message_id === "string"
            ? body.source_message_id
            : `${order[0] ?? ""}#118`,
        source_thread_topic:
          typeof body.source_thread_topic === "string" ? body.source_thread_topic : "",
        preview: typeof body.preview === "string" ? body.preview : "reacted to your message",
        timestamp: Date.now(),
        count: 1,
        is_read: false,
      });
      broadcast("notifications_changed", {});
      return Response.json({ ok: true }, { status: 200 });
    }
    // Move or cancel an event and broadcast the window it lives in, exactly like the
    // Rust backend's `calendar_view_updated` — so the E2E suite can drive a
    // reconciliation (a meeting rescheduled or removed in real Outlook) without
    // waiting for a poll. READ-ONLY still holds: this is the test control plane
    // pretending the SERVER changed, not a client writing.
    // Ring this machine, the way an invite on the calling socket does — and reset,
    // because one mock process serves a whole run and a call left ringing would ring
    // inside every later spec.
    //
    // `call_invite`, not `call`: that kind is the AWARENESS signal below (the
    // after-the-fact chat event), and the two are different things — one is a call this
    // machine can answer, the other is a note that a call happened.
    // Make the next capture the user asks for FAIL, once — the service refusing new media
    // mid-call. It is the only way to see what a mid-call failure does to this surface: the
    // page's simulated media never refuses, and a real refusal needs a real tenant. A spec
    // MUST reset afterwards (`call_invite {reset:true}` clears it), since one mock process
    // serves the whole run.
    if (body.kind === "call_media" && body.refuse === true) {
      mockRefusesNextMedia = true;
      return Response.json({ ok: true, refuse: true }, { status: 200 });
    }
    // End the live call the way the SERVICE does, with a reason of its own choosing — the
    // one this exists for being `CallEndReasonNobodyReachable`, a call that rang nothing
    // because the callee has no client signed in. Measured against the tenant by
    // `web/scripts/call-live.ts`, and reachable nowhere else: the mock rings no devices, so
    // the only way to review what the app SAYS about it is to say it here.
    if (body.kind === "call_end" && typeof body.reason === "string") {
      if (!mockCall) return Response.json({ ok: false, error: "no call" }, { status: 409 });
      endMockCall(body.reason);
      return Response.json({ ok: true, reason: body.reason }, { status: 200 });
    }
    // Answer an offer of the page's in a way no browser can read — the third way a capture
    // ends without a click, after a refusal and a drop, and the one that used to cost the
    // whole call. Nothing is armed: the answer goes out now, on the live call.
    // What ORDER the sharing calls arrived in. It is the one rule of this feature a spec
    // cannot read off the screen: a meeting rejects a section from an endpoint that never
    // asked to present, so an app that offered the media first would look right on screen and
    // share nothing at all.
    if (body.kind === "call_sharing_order") {
      return Response.json({ ok: true, order: mockSharingOrder }, { status: 200 });
    }
    if (body.kind === "call_media" && body.unreadable === true) {
      if (!mockCall) return Response.json({ ok: false, error: "no call" }, { status: 409 });
      broadcast("call_media", {
        call_id: mockCall.id,
        sdp: UNREADABLE_ANSWER_SDP,
        kind: "answer",
      });
      return Response.json({ ok: true, unreadable: true }, { status: 200 });
    }
    // REFUSE a capture the page just turned on, the way the service really did: the answer to
    // our own offer, with the section rejected. It is the state a screen share met on this
    // tenant, and the one the app used to describe as a DROP — so the user was told to share
    // again and met the same refusal. Nothing is armed: it happens now, on the live call.
    if (body.kind === "call_media" && typeof body.reject === "string") {
      if (!mockCall) return Response.json({ ok: false, error: "no call" }, { status: 409 });
      const label = body.reject === "screen" ? "applicationsharing-video" : "main-video";
      broadcast("call_media", {
        call_id: mockCall.id,
        sdp: mockSectionRejection(label),
        kind: "answer",
      });
      return Response.json({ ok: true, reject: body.reject }, { status: 200 });
    }
    // Take a capture AWAY from the page, the way the service does it: one offer that rejects
    // the section. Nothing is armed — the drop happens now, on the live call — so there is
    // nothing for a later spec to inherit.
    if (body.kind === "call_media" && typeof body.drop === "string") {
      if (!mockCall) return Response.json({ ok: false, error: "no call" }, { status: 409 });
      const label = body.drop === "screen" ? "applicationsharing-video" : "main-video";
      broadcast("call_media", {
        call_id: mockCall.id,
        sdp: mockSectionRejection(label),
        kind: "offer",
      });
      return Response.json({ ok: true, drop: body.drop }, { status: 200 });
    }
    // A backend that does not take calls at all, which is a read-only one and nothing
    // else. The app itself has no switch, so this hook is
    // the only way to reach that state — and it is the state the disabled call button and
    // the disabled Join button say their reason in. A spec MUST reset afterwards
    // (`call_invite {reset:true}` puts it back), since one mock process serves the run.
    if (body.kind === "calling" && body.enabled === false) {
      endMockCall("CallEndReasonCallingTurnedOff");
      mockCallingEnabled = false;
      broadcastMockCall();
      return Response.json({ ok: true, enabled: false }, { status: 200 });
    }
    // Hold ONE step of the next start, so a spec can hang up inside it — the window a real
    // call spends on a microphone, and the one it spends posting the invite. Nothing is
    // armed for later than that next step (`holdMockCallStart` disarms as it fires), and
    // `call_invite {reset:true}` clears it with the rest.
    if (body.kind === "call_start") {
      const at = body.hold === "place" ? "place" : "prepare";
      const ms = typeof body.hold_ms === "number" ? body.hold_ms : 1500;
      mockCallStartHold = { at, ms };
      return Response.json({ ok: true, hold: at, hold_ms: ms }, { status: 200 });
    }
    if (body.kind === "call_invite") {
      if (body.reset === true) {
        endMockCall("CallEndReasonHangup");
        // Back to what a real backend reports: it calls. The hook above is the only way
        // out of that, and it must not leak into the next spec.
        mockCallingEnabled = true;
        mockRefusesNextMedia = false;
        mockCallStartHold = null;
        broadcastMockCall();
        return Response.json({ ok: true, reset: true }, { status: 200 });
      }
      const conversation = typeof body.conversation === "string" ? body.conversation : (order[0] ?? "");
      const call = injectMockCallInvite(conversation);
      if (!call) {
        return Response.json({ ok: false, error: `unknown conversation: ${conversation}` }, { status: 404 });
      }
      return Response.json({ ok: true, call_id: call.id }, { status: 200 });
    }
    if (body.kind === "calendar") {
      // Re-seed the calendar, so a serial suite can undo the reschedules and
      // removals below and stay deterministic across runs against a reused mock.
      if (body.reset === true) {
        calendarEvents.length = 0;
        seedCalendar();
        broadcast("calendars_changed", {});
        return Response.json({ ok: true, reset: true }, { status: 200 });
      }
      const id = typeof body.event_id === "string" ? body.event_id : "";
      const index = calendarEvents.findIndex((e) => e.id === id);
      if (index < 0) {
        return Response.json({ ok: false, error: `unknown event: ${id}` }, { status: 404 });
      }
      const event = calendarEvents[index]!;
      if (body.remove === true) {
        calendarEvents.splice(index, 1);
      } else {
        if (typeof body.subject === "string") event.subject = body.subject;
        if (typeof body.start === "string") event.start = body.start;
        if (typeof body.end === "string") event.end = body.end;
        if (typeof body.is_cancelled === "boolean") event.is_cancelled = body.is_cancelled;
        if (typeof body.response === "string") event.response = body.response;
      }
      // The watched window, the way the backend describes it: whole calendar months
      // around the event, so the client's merge is authoritative over the same range
      // the real backend would claim.
      const start = typeof body.start === "string" ? body.start : event.start;
      const month = start.slice(0, 7);
      const [year, monthNumber] = month.split("-").map(Number);
      const windowStart = `${month}-01T00:00:00Z`;
      const nextMonth =
        monthNumber === 12 ? `${(year ?? 0) + 1}-01` : `${year}-${String((monthNumber ?? 1) + 1).padStart(2, "0")}`;
      const windowEnd = `${nextMonth}-01T00:00:00Z`;
      broadcast(
        "calendar_view_updated",
        mockCalendarView(windowStart, windowEnd, typeof body.calendar === "string" ? [body.calendar] : []),
      );
      return Response.json({ ok: true }, { status: 200 });
    }
    // Broadcast a typing/presence signal, exactly like the Rust backend's
    // `typing` event, so the E2E suite can drive the indicator deterministically.
    if (body.kind === "typing") {
      const typerMri = typeof body.sender_mri === "string" ? body.sender_mri : "8:orgid:riley";
      broadcast("typing", {
        conversation_id:
          typeof body.conversation === "string" ? body.conversation : (order[0] ?? ""),
        sender_mri: typerMri,
        // The Rust backend resolves the typer's name through `display_name_for_mri`,
        // which answers with the nickname first — so the indicator names them the way
        // every other surface does.
        sender:
          nickname(typerMri) ||
          (typeof body.sender === "string" ? body.sender : "Riley Carter"),
        is_typing: body.is_typing === undefined ? true : Boolean(body.is_typing),
      });
      return Response.json({ ok: true }, { status: 200 });
    }
    // Broadcast an incoming-call awareness signal, exactly like the Rust backend's
    // `call` event, so the E2E suite can drive the ringing banner deterministically.
    // A `started` rings; `ended`/`missed` dismisses it. Awareness only — no media.
    if (body.kind === "call") {
      broadcast("call", {
        conversation_id:
          typeof body.conversation === "string" ? body.conversation : (order[0] ?? ""),
        event: typeof body.event === "string" ? body.event : "started",
        caller: typeof body.caller === "string" ? body.caller : "Riley Carter",
        caller_mri: typeof body.caller_mri === "string" ? body.caller_mri : "8:orgid:riley",
        participants: Array.isArray(body.participants) ? body.participants : [],
        participant_count:
          typeof body.participant_count === "number" ? body.participant_count : 0,
      });
      return Response.json({ ok: true }, { status: 200 });
    }
    // Set the broker health the mock reports, and broadcast it — mirroring the Rust
    // backend's `broker_status` event. `{ kind: "broker", ok: true }` puts it back,
    // which a spec must do before it ends: the mock is shared and adopted across runs.
    if (body.kind === "broker") {
      const ok = body.ok === true;
      mockBrokerStatus = {
        ok,
        signature: typeof body.signature === "string" ? body.signature : ok ? "" : "disconnected",
        message:
          typeof body.message === "string"
            ? body.message
            : ok
              ? ""
              : "The identity broker stopped answering. Its keyring is usually locked.",
        detail: typeof body.detail === "string" ? body.detail : "",
        consecutive_failures:
          typeof body.consecutive_failures === "number" ? body.consecutive_failures : ok ? 0 : 3,
        can_repair: body.can_repair === undefined ? !ok : Boolean(body.can_repair),
        repairing: Boolean(body.repairing),
      };
      broadcast("broker_status", mockBrokerStatus);
      return Response.json({ ok: true, broker: mockBrokerStatus }, { status: 200 });
    }
    // Arm which CLIs this pretend machine holds and which provider is the default, so a
    // spec can put two usable providers in front of the app — the state that proves the ⋯
    // menu offers ONE of them (`defaultUsableBackends`) while the composer offers both. A
    // spec MUST reset it afterwards (`{kind: "agent_providers", reset: true}`): one mock
    // process serves the whole run, and a second CLI left installed changes what every
    // later spec's menu holds.
    if (body.kind === "agent_providers") {
      if (body.reset === true) {
        resetMockAgentProviders();
        return Response.json({ ok: true, reset: true }, { status: 200 });
      }
      const available = asObject(body.available);
      for (const [name, provider] of mockAgentProviders) {
        const installed = available[name];
        if (typeof installed === "boolean") provider.available = installed;
      }
      if (typeof body.default === "string" && mockAgentProviders.has(body.default)) {
        mockAgentDefaultProvider = body.default;
      }
      return Response.json(
        {
          ok: true,
          default_provider: mockAgentDefaultProvider,
          available: [...mockAgentProviders].map(([name, p]) => ({ name, available: p.available })),
        },
        { status: 200 },
      );
    }
    // Arm where this page stands with the write lock, so the banner that says "this window
    // can read, but not send" can be driven (see write-lock-banner.tsx). A spec MUST reset
    // it: one mock process serves the whole run, and a left-behind banner sits above every
    // later sidebar.
    if (body.kind === "write_lock") {
      if (body.reset === true) {
        mockWriteLockState = "held";
        mockWriteLockPinned = true;
        return Response.json({ ok: true, reset: true }, { status: 200 });
      }
      const state = body.state;
      if (state === "held" || state === "foreign" || state === "read_only") {
        mockWriteLockState = state;
      }
      if (typeof body.pinned === "boolean") mockWriteLockPinned = body.pinned;
      return Response.json(
        { ok: true, state: mockWriteLockState, pinned: mockWriteLockPinned },
        { status: 200 },
      );
    }
    // Arm what Settings › This app answers: the outcome of a check, how many agent replies a
    // restart would cut off, and the machine that has nothing to restart it. A spec MUST
    // reset it — one mock process serves the whole run, and a backend armed to refuse would
    // refuse for every later spec.
    if (body.kind === "maintenance") {
      if (body.reset === true) {
        mockMaintenance = { check: null, runs: 0, refuse: false };
        return Response.json({ ok: true, maintenance: mockMaintenance }, { status: 200 });
      }
      mockMaintenance = {
        check: typeof body.check === "string" ? body.check : null,
        runs: typeof body.runs === "number" ? body.runs : 0,
        refuse: body.refuse === true,
      };
      return Response.json({ ok: true, maintenance: mockMaintenance }, { status: 200 });
    }
    // Arm (or clear) a pending update, and say whether this pretend install can replace
    // itself — the difference between the button and the plain link (`can_install` in
    // src/update.rs). A spec MUST clear it afterwards: one mock process serves the whole
    // run, and a left-behind update row moves every later sidebar screenshot.
    if (body.kind === "update") {
      // What a real restart looks like from the page: this backend goes away mid-phase,
      // and the one that answers next is the NEW build — current, so it announces no
      // update at all. Dropping the sockets is the whole of it; the page's own reconnect
      // is what has to end up with an empty update row rather than a stuck "Restarting…".
      if (body.restarted === true) {
        mockUpdate = null;
        mockUpdateFailsOnce = false;
        resetMockUpdate();
        for (const ws of sockets) ws.close();
        return Response.json({ ok: true, restarted: true }, { status: 200 });
      }
      if (body.available === false) {
        mockUpdate = null;
        mockUpdateFailsOnce = false;
        resetMockUpdate();
        broadcast("update_available", null);
        return Response.json({ ok: true, update: null }, { status: 200 });
      }
      // A download that fails once, so a spec can press the retry the user was left
      // pressing. Armed per release, and never left behind: the clear above disarms it.
      mockUpdateFailsOnce = body.fail_once === true;
      mockUpdate = {
        current: typeof body.current === "string" ? body.current : "abc1234",
        latest: typeof body.latest === "string" ? body.latest : "def5678",
        url:
          typeof body.url === "string"
            ? body.url
            : "https://github.com/theophile-wallez/teams-lite/releases/tag/latest",
        size: typeof body.size === "number" ? body.size : MOCK_UPDATE_SIZE,
        can_install: body.can_install !== false,
        // What it brings. `changes: false` is the backend that could not read the
        // comparison — offline, rate-limited, a force-pushed history — which a spec needs,
        // because the button must still be offered with nothing to disclose.
        // `changes_omitted` arms the other end: a build so far behind that the list is
        // capped, which is the one case the panel says something extra.
        changes:
          body.changes === false
            ? null
            : typeof body.changes_omitted === "number"
              ? {
                  ...MOCK_UPDATE_CHANGES,
                  total: MOCK_UPDATE_CHANGES.total + body.changes_omitted,
                  omitted: body.changes_omitted,
                }
              : MOCK_UPDATE_CHANGES,
      };
      resetMockUpdate();
      broadcast("update_available", { ...mockUpdate });
      // And say the flow is back at the start. Arming a release resets the phase here, so
      // a page that is not told keeps drawing the one it had — a "Restart to update" whose
      // click then applies a build this backend no longer holds.
      broadcastUpdateProgress();
      return Response.json({ ok: true, update: mockUpdate }, { status: 200 });
    }
    // Move a member's read position ("seen by") and broadcast it, exactly like
    // the Rust backend's `read_receipt` event, so the E2E suite can drive the
    // avatar row deterministically. Defaults anchor the reader to the newest
    // message (avatars land at the bottom), and persist so a re-open's
    // `read_receipts` fetch returns the same position.
    // Clear every name and face the user gave somebody. One mock process serves the
    // whole run, so a rename left behind would rename that person for the next spec
    // too — and a spec asserting a fixture's real name would fail for no visible
    // reason. Same job as the read_receipt reset below.
    // Arm what GitLab says about an approval: a refusal sentence (`refuse`), a machine
    // with no token at all (`unavailable`), or a clean slate. A spec MUST clear it
    // afterwards — one mock process serves the whole run, and a left-behind refusal turns
    // every later approval into an error nobody armed.
    if (body.kind === "gitlab_approval") {
      if (body.clear === true) {
        mockApprovals.clear();
        mockApprovalRefusal = null;
        mockApprovalsUnavailable = false;
        return Response.json({ ok: true, cleared: true }, { status: 200 });
      }
      mockApprovalRefusal = typeof body.refuse === "string" ? body.refuse : null;
      mockApprovalsUnavailable = body.unavailable === true;
      return Response.json(
        { ok: true, refuse: mockApprovalRefusal, unavailable: mockApprovalsUnavailable },
        { status: 200 },
      );
    }
    // Arm what GitLab says about the merge-request PAGE's writes: a refusal sentence
    // (`refuse`), a machine with no token at all (`no_token`), or a clean slate. The same
    // contract the approval hook carries, and for the same reason — one mock process serves
    // the whole run, so a spec MUST clear whatever it armed, or every later merge on this
    // surface fails for no reason anybody can see.
    if (body.kind === "gitlab_mr") {
      if (body.clear === true) {
        mockGitLabWriteRefusal = null;
        mockGitLabTokenMissing = false;
        mockGitLabDiffRefusal = null;
        mockGitLabUploadRefusal = null;
        // Every job log goes back too: the running one's length grows on each read, so a spec
        // that wants to watch a live log has to start from a known number of lines.
        resetMockJobLogs();
        // The live pipeline goes back to its first frame too: every read moves it on, so a
        // spec that wants to WATCH it move has to start from a known one.
        resetMockLivePipeline();
        return Response.json({ ok: true, cleared: true }, { status: 200 });
      }
      mockGitLabWriteRefusal = typeof body.refuse === "string" ? body.refuse : null;
      mockGitLabTokenMissing = body.no_token === true;
      mockGitLabDiffRefusal = typeof body.refuse_diff === "string" ? body.refuse_diff : null;
      mockGitLabUploadRefusal =
        typeof body.refuse_upload === "string" ? body.refuse_upload : null;
      mockGitLabJobLogRefusal =
        typeof body.refuse_job_log === "string" ? body.refuse_job_log : null;
      mockGitLabTraceRefusal = typeof body.refuse_trace === "string" ? body.refuse_trace : null;
      mockGitLabJobLogTruncated = body.truncate_job_log === true;
      return Response.json(
        {
          ok: true,
          refuse: mockGitLabWriteRefusal,
          no_token: mockGitLabTokenMissing,
          refuse_diff: mockGitLabDiffRefusal,
          refuse_upload: mockGitLabUploadRefusal,
          refuse_job_log: mockGitLabJobLogRefusal,
          refuse_trace: mockGitLabTraceRefusal,
          truncate_job_log: mockGitLabJobLogTruncated,
        },
        { status: 200 },
      );
    }
    if (body.kind === "person_overrides" && body.clear === true) {
      const affected = [...personOverrides.keys()];
      personOverrides.clear();
      for (const mri of affected) broadcast("person_override_changed", { mri });
      return Response.json({ ok: true, cleared: affected.length }, { status: 200 });
    }
    if (body.kind === "custom_emoji" && body.clear === true) {
      const cleared = customEmojiPack.size;
      customEmojiPack.clear();
      seedCustomEmoji();
      broadcast("custom_emoji_changed", {});
      return Response.json({ ok: true, cleared }, { status: 200 });
    }
    if (body.kind === "read_receipt") {
      // Clear all injected read positions — lets a serial E2E suite reset the
      // shared mock between specs so "seen by" avatars never leak across tests.
      if (body.clear === true) {
        injectedReceipts.clear();
        return Response.json({ ok: true, cleared: true }, { status: 200 });
      }
      const conversation =
        typeof body.conversation === "string" ? body.conversation : (order[0] ?? "");
      const t = threadFor(conversation);
      const lastReadMessageId =
        typeof body.last_read_message_id === "string"
          ? body.last_read_message_id
          : (t?.messages.at(-1)?.id ?? "");
      const readerMri = typeof body.member_mri === "string" ? body.member_mri : "8:orgid:riley";
      const receipt = setReceipt(conversation, {
        member_mri: readerMri,
        // Resolved like the typing line, and for the same reason.
        member:
          nickname(readerMri) ||
          (typeof body.member === "string" ? body.member : "Riley Carter"),
        last_read_message_id: lastReadMessageId,
        read_time_ms: typeof body.read_time_ms === "number" ? body.read_time_ms : Date.now(),
      });
      broadcast("read_receipt", { conversation_id: conversation, ...receipt });
      return Response.json({ ok: true, receipt }, { status: 200 });
    }
    // Deliver a new mail into a folder and broadcast the refreshed window, exactly
    // like the Rust backend does after its newest-window poll notices one.
    if (body.kind === "mail") {
      const mail = injectMail({
        folderId: typeof body.folder === "string" ? body.folder : "mf-inbox",
        subject: typeof body.subject === "string" ? body.subject : undefined,
        sender: typeof body.sender === "string" ? body.sender : undefined,
        preview: typeof body.preview === "string" ? body.preview : undefined,
      });
      return Response.json({ ok: mail !== null, mail }, { status: mail ? 200 : 404 });
    }
    // Set a reaction on an existing message (from someone else by default), then
    // re-broadcast it — exercises the received-reaction chips deterministically.
    if (body.kind === "reaction") {
      const conversation =
        typeof body.conversation === "string" ? body.conversation : (order[0] ?? "");
      const cs = store.get(conversation);
      const key = typeof body.key === "string" ? body.key : "like";
      const messageId =
        typeof body.message_id === "string"
          ? body.message_id
          : (cs?.messages.at(-1)?.id ?? "");
      const msg = cs?.messages.find((m) => m.id === messageId);
      if (!msg) return Response.json({ ok: false }, { status: 404 });
      const count = typeof body.count === "number" ? body.count : 1;
      const mine = Boolean(body.mine);
      // WHO reacted, so a spec can read the tooltip. `mris` names them explicitly;
      // by default they are the first colleagues of the roster (plus us when `mine`),
      // and a spec asking for more reactors than that leaves the rest unnamed — which
      // is the state a tooltip counts rather than names.
      const named = Array.isArray(body.mris)
        ? body.mris.filter((mri): mri is string => typeof mri === "string")
        : [
            ...(mine ? [SELF_MRI] : []),
            ...PEOPLE.slice(0, Math.max(0, count - (mine ? 1 : 0))).map((p) => p.mri),
          ];
      const others = (msg.reactions ?? []).filter((r) => r.key !== key);
      msg.reactions = count > 0 ? [...others, { key, count, mine, mris: named }] : others;
      broadcast("message", nicknamed(msg));
      return Response.json({ ok: true, message: msg }, { status: 200 });
    }
    const conversation =
      typeof body.conversation === "string" ? body.conversation : (order[0] ?? "");
    const msg = injectMessage({
      conversation,
      content: typeof body.content === "string" ? body.content : "test message",
      sender: typeof body.sender === "string" ? body.sender : undefined,
      senderMri: typeof body.sender_mri === "string" ? body.sender_mri : undefined,
      isSelf: Boolean(body.is_self),
      reply: Boolean(body.reply),
      html: typeof body.html === "string" ? body.html : undefined,
    });
    return Response.json({ ok: msg !== null, message: msg }, { status: msg ? 200 : 404 });
  }
  if (req.method === "POST" && url.pathname === "/__test/send-control") {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      /* an empty body resets the controls */
    }
    testSendDelayMs =
      typeof body.delay_ms === "number" && Number.isFinite(body.delay_ms)
        ? Math.max(0, body.delay_ms)
        : 0;
    testSendError = typeof body.error === "string" ? body.error : "";
    if (body.clear === true) capturedSends.length = 0;
    return Response.json({ ok: true, delay_ms: testSendDelayMs, error: testSendError });
  }
  if (req.method === "GET" && url.pathname === "/__test/sends") {
    return Response.json({ sends: capturedSends });
  }
  if (req.method === "GET" && url.pathname === "/__test/conversations") {
    return Response.json(
      order.map((id) => {
        const c = store.get(id)!.conv;
        return { id: c.id, name: c.name, kind: c.kind };
      }),
    );
  }
  if (req.method === "GET" && url.pathname === "/__test/mail") {
    return Response.json({
      folders: mailFolders,
      inbox: (mailByFolder.get("mf-inbox") ?? []).map((m) => ({
        id: m.id,
        subject: m.subject,
        is_read: m.is_read,
        received: m.received,
      })),
    });
  }
  if (req.method === "GET" && url.pathname === "/__test/calendar") {
    return Response.json({
      calendars: MOCK_CALENDARS,
      events: calendarEvents.map((e) => ({
        id: e.id,
        calendar_id: e.calendar_id,
        subject: e.subject,
        start: e.start,
        end: e.end,
        is_all_day: e.is_all_day,
        response: e.response,
      })),
    });
  }
  // Which conversations the mock has been told to answer in. A spec asserts the
  // CONSENT through this, not through the page's memory of its own click: the switch is
  // only meaningful if the backend stored it.
  if (req.method === "GET" && url.pathname === "/__test/agent") {
    return Response.json({
      sandbox: MOCK_AGENT_SANDBOX,
      conversations: [...mockAgentModes].map(([conversation, mode]) => ({ conversation, mode })),
      // The other half of the same consent: what the agent may reach. Asserted here for
      // the same reason — a switch is only meaningful if the backend stored it.
      tools: [...mockAgentTools],
      unrestricted: mockAgentUnrestricted,
      default_provider: mockAgentDefaultProvider,
      providers: [...mockAgentProviders].map(([name, p]) => ({
        name,
        available: p.available,
        enabled: p.enabled,
        model: p.model,
      })),
    });
  }
  if (req.method === "GET" && url.pathname === "/__test/channels") {
    return Response.json(
      channelOrder.map((id) => {
        const c = channelStore.get(id)!.channel;
        return { id: c.id, name: c.name, team_id: c.team_id, team_name: c.team_name };
      }),
    );
  }
  return null;
}


// ---------------------------------------------------------------------------
// Calendar (READ-ONLY, mirrors src/calendar.rs).
//
// Two properties are load-bearing, exactly as for mail:
//   1. The fixtures cover what the views must survive — a recurring stand-up, a
//      multi-day leave bar, an all-day holiday, three overlapping meetings, an
//      unanswered invitation, a cancelled one, a tentative one, a meeting that
//      crosses midnight, and an invitation with more attendees than the backend
//      keeps. That is the set that breaks a naive layout.
//   2. There is no way to write. No `calendar_create` / `calendar_respond` case
//      exists here, mirroring a backend where the capability is absent rather than
//      merely ungated.
//
// Events are generated RELATIVE TO TODAY so the calendar always has something in
// the window it opens on, and anchored to whole hours so a screenshot is stable.
// ---------------------------------------------------------------------------

type MockCalendar = {
  id: string;
  name: string;
  hex_color: string;
  is_default: boolean;
  can_edit: boolean;
  position: number;
};

type MockEventPerson = { name: string; address: string; response: string; kind: string };

type MockCalendarEvent = {
  id: string;
  calendar_id: string;
  subject: string;
  preview: string;
  /** ISO 8601 UTC, whole seconds — the exact shape the Rust backend normalizes to. */
  start: string;
  /** ISO 8601 UTC, whole seconds, EXCLUSIVE. */
  end: string;
  is_all_day: boolean;
  is_cancelled: boolean;
  is_organizer: boolean;
  organizer: MockEventPerson;
  location: string;
  join_url: string;
  web_link: string;
  show_as: string;
  response: string;
  series: string;
  recurrence: string;
  importance: string;
  sensitivity: string;
  categories: string[];
  attendees: MockEventPerson[];
  attendee_count: number;
  has_attachments: boolean;
  reminder_minutes: number;
};

/** Matches `calendar::MAX_ATTENDEES` on the Rust side. */
const MOCK_MAX_ATTENDEES = 20;

const MOCK_CALENDARS: MockCalendar[] = [
  { id: "cal-main", name: "Calendar", hex_color: "#9fe1e7", is_default: true, can_edit: true, position: 0 },
  { id: "cal-team", name: "Platform team", hex_color: "#5e6ad2", is_default: false, can_edit: false, position: 1 },
  // No hex colour: exercises the UI's own fallback palette.
  { id: "cal-birthdays", name: "Birthdays", hex_color: "", is_default: false, can_edit: false, position: 2 },
  { id: "cal-holidays", name: "Holidays in France", hex_color: "#16a765", is_default: false, can_edit: false, position: 3 },
];

const calendarEvents: MockCalendarEvent[] = [];

/** A person as an event attendee. */
function mockAttendee(name: string, response: string, kind = "required"): MockEventPerson {
  return { ...personAddress(name), response, kind };
}

/** Local midnight today, as the anchor every fixture is offset from. */
function mockToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** An instant `days` from today at local `hour`:`minute`, as a canonical timestamp. */
function mockAt(days: number, hour: number, minute = 0): string {
  const base = mockToday();
  return isoSeconds(
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, minute).getTime(),
  );
}

/** Midnight UTC on the date `days` from today — the shape Graph uses for an all-day
 *  boundary, which is a DATE and not an instant. */
function mockAllDay(days: number): string {
  const base = mockToday();
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
  const year = day.getFullYear();
  const month = `${day.getMonth() + 1}`.padStart(2, "0");
  const date = `${day.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${date}T00:00:00Z`;
}

/** Add one event, filling in the defaults a sparse fixture leaves out. */
function addMockEvent(
  event: Pick<MockCalendarEvent, "id" | "subject" | "start" | "end"> & Partial<MockCalendarEvent>,
): void {
  const attendees = event.attendees ?? [];
  calendarEvents.push({
    calendar_id: "cal-main",
    preview: "",
    is_all_day: false,
    is_cancelled: false,
    is_organizer: false,
    organizer: mockAttendee("Lucas Silva", ""),
    location: "",
    join_url: "",
    web_link: "https://outlook.office.com/calendar/item/mock",
    show_as: "busy",
    response: "accepted",
    series: "singleInstance",
    recurrence: "",
    importance: "normal",
    sensitivity: "normal",
    categories: [],
    attendee_count: attendees.length,
    has_attachments: false,
    reminder_minutes: 15,
    ...event,
    attendees: attendees.slice(0, MOCK_MAX_ATTENDEES),
  });
}

/** Seed the calendars and a month of events around today. Deterministic given the
 *  date, so screenshots and E2E assertions are stable within a day. */
function seedCalendar(): void {
  // The real shape a Teams join link has, context included: the thread, the message id
  // ("0" for a meeting on the calendar) and the `{Tid, Oid}` the calling service reads as
  // its `meetingInfo` (see `calling::MeetingJoin`). The ids are invented; the shape is
  // not, and it is the shape the Join button and the backend both parse.
  const teamsJoin =
    "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_mock%40thread.v2/0" +
    "?context=%7B%22Tid%22%3A%2200000000-0000-4000-8000-000000000001%22%2C" +
    "%22Oid%22%3A%2200000000-0000-4000-8000-000000000002%22%7D";

  // A recurring stand-up on every weekday of the surrounding five weeks: the case
  // that proves the backend expands recurrence and the grid draws one row per
  // occurrence.
  //
  // Each weekday also carries one event on the PRIMARY calendar, so the app's own
  // defaults — the working week, with the primary calendar alone switched on — are
  // never an empty grid. The fixtures are relative to today, so a suite run on a
  // Saturday looks at a week made entirely of other days.
  for (let offset = -14; offset <= 21; offset++) {
    const day = new Date(mockToday().getFullYear(), mockToday().getMonth(), mockToday().getDate() + offset);
    const weekday = day.getDay();
    if (weekday === 0 || weekday === 6) continue;
    addMockEvent({
      id: `ev-focus-${offset}`,
      subject: "Focus block",
      preview: "Head down. No meetings.",
      start: mockAt(offset, 8, 0),
      end: mockAt(offset, 8, 45),
      is_organizer: true,
      response: "organizer",
      show_as: "busy",
      reminder_minutes: -1,
    });
    addMockEvent({
      id: `ev-standup-${offset}`,
      subject: "Platform stand-up",
      preview: "Round the room: what shipped, what is stuck.",
      start: mockAt(offset, 9, 30),
      end: mockAt(offset, 9, 45),
      calendar_id: "cal-team",
      series: offset === 0 ? "exception" : "occurrence",
      recurrence: "weekly",
      join_url: teamsJoin,
      location: "Microsoft Teams Meeting",
      attendees: [
        mockAttendee("Lucas Silva", "accepted"),
        mockAttendee("Ada Kimani", "accepted"),
        mockAttendee("Mei Tanaka", "notResponded", "optional"),
      ],
    });
  }

  // Three quarter-hour meetings back to back this morning: the case where the grid must
  // NOT overlap anything. A short block is grown so its title fits, and the growth stops
  // at the next meeting's start — without that, each of these covered the one after it.
  for (const [index, minute] of [0, 15, 30].entries()) {
    addMockEvent({
      id: `ev-quarter-${index}`,
      subject: ["Triage", "Standby handover", "Metrics check"][index]!,
      start: mockAt(0, 11, minute),
      end: mockAt(0, 11, minute + 15),
      join_url: index === 1 ? teamsJoin : "",
    });
  }

  // Three overlapping meetings this afternoon: the case the column layout exists for.
  addMockEvent({
    id: "ev-overlap-a",
    subject: "Architecture guild",
    // The body an invitation really carries: the organizer's own words, then the block
    // Outlook writes under them — a rule of 80 underscores and a join link, each ONE
    // unbreakable word. That is the fixture's whole point. Unbroken, the longest of them
    // decides how wide the details panel is, which pushed the footer's last control off
    // the panel's clip on a phone; the mock's short one-liners hid the case entirely.
    preview:
      "Agenda: local-first storage, the write lock, and what we do about calling.\n" +
      "________________________________________________________________________________\n" +
      "Microsoft Teams Need help? Join the meeting now " +
      "https://teams.microsoft.com/meet/4155248391045?p=Xk7QvNbLd2RsTfWy " +
      "Meeting ID: 415 524 839 1045 Passcode: q7Ldn2Rs",
    start: mockAt(0, 14, 0),
    end: mockAt(0, 15, 0),
    join_url: teamsJoin,
    location: "Microsoft Teams Meeting",
    categories: ["Platform"],
    attendees: [mockAttendee("Ada Kimani", "accepted"), mockAttendee("Mei Tanaka", "accepted")],
  });
  addMockEvent({
    id: "ev-overlap-b",
    subject: "1:1 with Ada",
    start: mockAt(0, 14, 30),
    end: mockAt(0, 15, 30),
    calendar_id: "cal-main",
    is_organizer: true,
    response: "organizer",
    attendees: [mockAttendee("Ada Kimani", "accepted")],
  });
  addMockEvent({
    id: "ev-overlap-c",
    subject: "Release sign-off",
    start: mockAt(0, 14, 45),
    end: mockAt(0, 15, 15),
    calendar_id: "cal-team",
    show_as: "tentative",
    response: "tentativelyAccepted",
    join_url: teamsJoin,
  });

  // An unanswered invitation with more attendees than the backend keeps: the outline
  // treatment plus the "and N more" count.
  addMockEvent({
    id: "ev-all-hands",
    subject: "Engineering all-hands",
    preview: "Quarterly review. Recording will be shared afterwards.",
    start: mockAt(1, 16, 0),
    end: mockAt(1, 17, 0),
    response: "notResponded",
    show_as: "tentative",
    join_url: teamsJoin,
    location: "Microsoft Teams Meeting",
    attendee_count: 777,
    attendees: Array.from({ length: MOCK_MAX_ATTENDEES }, (_, i) =>
      mockAttendee(PEOPLE[i % PEOPLE.length]!.name, i % 3 === 0 ? "accepted" : "notResponded"),
    ),
  });

  // A cancelled meeting: struck through, still visible (Outlook keeps it until it is
  // removed from the calendar).
  addMockEvent({
    id: "ev-cancelled",
    subject: "Vendor demo",
    start: mockAt(2, 11, 0),
    end: mockAt(2, 12, 0),
    is_cancelled: true,
    response: "declined",
  });

  // A whole week of leave: the multi-day bar, laid out in its own lane across
  // several week rows.
  addMockEvent({
    id: "ev-leave",
    subject: "Ada — annual leave",
    start: mockAllDay(3),
    end: mockAllDay(10),
    is_all_day: true,
    calendar_id: "cal-team",
    show_as: "oof",
    reminder_minutes: -1,
  });

  // A one-day all-day event, from a calendar with no colour of its own.
  addMockEvent({
    id: "ev-holiday",
    subject: "Public holiday",
    start: mockAllDay(5),
    end: mockAllDay(6),
    is_all_day: true,
    calendar_id: "cal-holidays",
    show_as: "free",
    reminder_minutes: -1,
  });
  addMockEvent({
    id: "ev-birthday",
    subject: "Mei's birthday",
    start: mockAllDay(-2),
    end: mockAllDay(-1),
    is_all_day: true,
    calendar_id: "cal-birthdays",
    show_as: "free",
    reminder_minutes: -1,
  });

  // A timed event that crosses midnight: it cannot be a block in one day column, so
  // it must ride in the all-day band.
  addMockEvent({
    id: "ev-overnight",
    subject: "Datacentre migration window",
    start: mockAt(4, 22, 0),
    end: mockAt(5, 2, 0),
    calendar_id: "cal-team",
    location: "Remote",
  });

  // A dense morning next week, so the week view has something to lay out away from
  // today.
  for (const [index, hour] of [8, 10, 11, 13, 17].entries()) {
    addMockEvent({
      id: `ev-week-${index}`,
      subject: ["Design review", "Incident retro", "Interview: platform", "Roadmap sync", "Deep work"][index]!,
      start: mockAt(8, hour, 0),
      end: mockAt(8, hour + 1, 0),
      calendar_id: index % 2 === 0 ? "cal-main" : "cal-team",
      show_as: index === 4 ? "free" : "busy",
      join_url: index % 2 === 0 ? teamsJoin : "",
    });
  }
}

/** Every event overlapping `[start, end)`, restricted to `calendarIds` when given.
 *  The same overlap rule the Rust store and `calendar::overlaps` implement — the
 *  zero-length clause included. */
function mockCalendarView(
  start: string,
  end: string,
  calendarIds: string[],
): { start: string; end: string; events: MockCalendarEvent[] } {
  const events = calendarEvents
    .filter((event) => calendarIds.length === 0 || calendarIds.includes(event.calendar_id))
    .filter((event) => event.start < end && (event.end > start || event.start >= start))
    .sort((a, b) => (a.start === b.start ? a.id.localeCompare(b.id) : a.start < b.start ? -1 : 1));
  return { start, end, events };
}

/** An optional array-of-strings param, empty when absent — mirrors the backend's
 *  `param_str_list`. */
function optionalStringList(params: unknown, key: string): string[] {
  const value = asObject(params)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

seed();
seedMediaSamples();
seedCallEvents();
seedDeletedMessages();
seedMentionSamples();
seedGitLabSamples();
seedLinearSamples();
seedAppCards();
seedThreadActivity();
seedForwardedMessages();
seedPlainTextSamples();
seedStopAgentThread();
seedAgentSandbox();
seedMergeRequestReview();
seedCustomEmojiThread();
seedCustomEmoji();
// Seed channels LAST so the chat seed's PRNG sequence (and thus the Chats list
// the existing specs assert on) is left completely unchanged.
seedChannels();
// Appended to a channel that already exists, and drawing no random numbers, so it
// changes nothing but the one channel it names.
seedChannelAlertThread();
// Mail draws no random numbers at all (its fixtures are fully deterministic), so
// its position here cannot disturb any existing spec either.
seedMail();
// Same for the calendar: fully deterministic given today's date, and it draws no
// random numbers, so it cannot disturb any existing spec either.
seedCalendar();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  websocket: {
    open(ws) {
      sockets.add(ws);
      // Identify ourselves FIRST, before anything else on the wire: this is the
      // sentinel the app turns into its MOCK/LIVE badge, and the one automation
      // must see before it is allowed to type (see web/scripts/preview.ts). The
      // real Rust backend never emits this event, so "no sentinel" reads as
      // LIVE — the fail-safe direction. Never make this conditional.
      sendJson(ws, { event: "backend_info", data: { mock: true, name: "web/mock/server.ts" } });
      // Then greet exactly like the Rust backend does on a fresh connection.
      sendJson(ws, { event: "status", data: "connected" });
      sendJson(ws, { event: "realtime_status", data: "connected" });
      // Only when something is wrong, like the real backend: a mock that announced a
      // healthy broker would make the banner's "null means silence" rule untestable.
      if (mockBrokerStatus) sendJson(ws, { event: "broker_status", data: mockBrokerStatus });
      // A pending update, and how far it has got — replayed on connect exactly like the
      // Rust backend replays it, so a page that opens mid-download draws the bar it is
      // already in rather than an untouched button.
      if (mockUpdate) {
        sendJson(ws, { event: "update_available", data: { ...mockUpdate } });
        if (mockUpdateProgress.phase !== "idle") {
          sendJson(ws, { event: "update_progress", data: { ...mockUpdateProgress } });
        }
      }
    },
    message(ws, message) {
      const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
      handleFrame(ws, raw);
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
  async fetch(req, server) {
    // Upgrade WebSocket handshakes first.
    if (server.upgrade(req)) return undefined;
    const url = new URL(req.url);
    const hook = await handleTestHook(req, url);
    if (hook) return hook;
    // A plain GET (e.g. Playwright's webServer readiness probe) gets a hello.
    return new Response("teams-lite mock backend");
  },
});

startLiveFeed();

console.log(
  `[mock] teams-lite mock backend on ws://${server.hostname}:${server.port} ` +
    `(${store.size} conversations, ${channelStore.size} channels)` +
    (TEST_HOOKS ? " [test-hooks]" : "") +
    (LIVE_INTERVAL_MS <= 0 ? " [no-live-feed]" : ""),
);
