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
// Methods: ping | conversations | open | backfill | set_draft | send | edit
//          | notifications | fetch_media | get_settings | set_settings | enrich_link
// Events:  status | realtime_status | message | conversations_changed | typing
//
// Run it (from the web/ directory):
//   export PATH="$HOME/.bun/bin:$PATH"
//   PORT=8420 bun run mock/server.ts
//
// It listens on ws://127.0.0.1:PORT (PORT defaults to 8420). Point the UI at it
// with VITE_TEAMS_WS_URL=ws://127.0.0.1:8420 (that is already the default URL).
//
// This file has no dependencies beyond the Bun runtime. Everything below —
// types, seed data, PRNG, protocol handling — is self-contained on purpose, so
// the mock keeps working even if the app's source shape drifts.
//
// English only: this repo mandates English artifacts. No non-English strings.

import type { ServerWebSocket } from "bun";

// ---------------------------------------------------------------------------
// Protocol types — mirror web/src/lib/protocol.ts exactly.
// ---------------------------------------------------------------------------

type ConversationKind = "one_on_one" | "group" | "notes" | "unknown";

type AttachmentKind = "image" | "file";

type Attachment = {
  name: string;
  content_type: string;
  url: string;
  kind: AttachmentKind;
};

type Conversation = {
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

type ChatMessage = {
  id: string;
  conversation_id: string;
  seq: number;
  compose_time: number; // epoch MILLISECONDS
  sender: string;
  sender_mri?: string;
  content: string; // HTML-ish, as Teams sends it
  attachments?: Attachment[]; // file/card attachments (inline images live in content)
  is_self?: boolean;
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

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8420);
const HOST = "127.0.0.1";

/** Matches teams_read::DEFAULT_PAGE_SIZE (see src/bin/server.rs tests). */
const PAGE_SIZE = 40;
/** Backlog per conversation so infinite scroll + backfill are well exercised. */
const BACKLOG = 120;
/** Fixed seed for the PRNG → deterministic content/structure across runs. */
const SEED = 0x7ea115;
/** How often to inject a live incoming message. Set MOCK_LIVE_MS=0 to disable
 *  the random feed (used by the E2E suite so live events are deterministic). */
const LIVE_INTERVAL_MS = Number(process.env.MOCK_LIVE_MS ?? 7_000);
/** Delay before echoing a sent message, simulating the real-time round trip. */
const SEND_ECHO_DELAY_MS = 150;

/** When "1", expose an HTTP control plane (POST /__test/emit, GET
 *  /__test/conversations) so E2E tests can drive live events deterministically.
 *  Off by default — the mock behaves exactly as before for plain dev use. */
const TEST_HOOKS = process.env.MOCK_TEST_HOOKS === "1";

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

/** Plain, whitespace-collapsed, ~80-char preview of a message's HTML content. */
function previewOf(content: string): string {
  const text = plain(content).replace(/\s+/g, " ").trim();
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

/** Milliseconds between two consecutive backlog messages: mostly minutes, with
 *  the occasional multi-hour gap so a 120-message backlog spans several days. */
function gapMs(r: () => number): number {
  const minutes = 2 + Math.floor(r() * 148); // 2..150 minutes
  const bigJump = r() < 0.12 ? (4 + Math.floor(r() * 12)) * 60 : 0; // +4..16h
  return (minutes + bigJump) * 60_000;
}

/** Generate a deterministic backlog for one conversation (ascending by seq). */
function generateBacklog(
  convId: string,
  kind: ConversationKind,
  participants: Person[],
  newestTime: number,
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
    // message so the UI's reply-blockquote parsing is exercised.
    let content: string;
    if (i >= 3 && rand() < 0.12) {
      const start = Math.max(0, i - 8);
      const quoted = messages[start + Math.floor(rand() * (i - start))]!;
      content = replyContent(quoted, pick(REPLY_BODIES, rand));
    } else {
      content = escapeHtml(pick(MESSAGE_POOL, rand));
    }

    messages.push({
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time,
      sender,
      sender_mri: senderMri,
      content,
      is_self: isSelf,
    });
  }
  return messages;
}

/** Recompute the sidebar summary fields from the newest message. */
function recomputeSummary(cs: ConvState): void {
  const last = cs.messages.at(-1);
  if (!last) return;
  cs.conv.last_message_time = last.compose_time;
  cs.conv.last_message_preview = previewOf(last.content);
  cs.conv.last_message_sender = last.sender;
  cs.conv.last_message_from_me = Boolean(last.is_self);
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
    is_muted: input.isMuted,
    is_pinned: input.isPinned,
    is_hidden: false,
    thread_type: input.kind === "one_on_one" || input.kind === "group" ? "chat" : "",
    draft: "",
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
    });
  });

  // 7 group chats with varied membership.
  GROUP_NAMES.forEach((groupName, idx) => {
    const memberCount = 3 + Math.floor(rand() * 3); // 3..5 teammates
    const members = sample(PEOPLE, memberCount, rand);
    const slug = groupName.toLowerCase().replace(/[^a-z]+/g, "-");
    addConversation({
      id: `19:${slug}-mock@thread.v2`,
      name: groupName,
      kind: "group",
      participants: members,
      isRead: rand() >= 0.4,
      isMuted: rand() < 0.12,
      isPinned: idx === 0, // pin one group
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

/** Register a dedicated "Media Gallery" conversation whose messages exercise the
 *  UI's inline-image and attachment rendering: a pasted screenshot embedded in
 *  the HTML, an image shared as an attachment, and a non-image file. It is a
 *  standalone conversation (not one the other specs mutate or reorder), so tests
 *  reach it deterministically by name via the command palette. */
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
        `<img itemtype="http://schema.skype.com/AMSImage" ` +
        `src="https://eu-api.asm.skype.com/v1/objects/mock-inline-1/views/imgo" alt="incident graph"/>`,
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

  const conv: Conversation = {
    id: convId,
    name: "Media Gallery",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
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

/** Register a dedicated "GitLab Links" conversation whose messages embed GitLab
 *  merge-request, issue, and project links (as real `<a href>` anchors, the way
 *  Teams delivers links), so the UI's rich link-preview cards are exercised. Its
 *  URLs resolve through the mock's `enrich_link`. Reached by name in the palette. */
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

  const conv: Conversation = {
    id: convId,
    name: "GitLab Links",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
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

// ---------------------------------------------------------------------------
// Paging (operate on ascending-by-seq arrays, mirroring the Rust store).
// ---------------------------------------------------------------------------

/** Newest page: the last PAGE_SIZE messages; has_more when older ones exist. */
function newestPage(messages: ChatMessage[]): MessagePage {
  const page = messages.slice(-PAGE_SIZE);
  return { messages: page, has_more: messages.length > page.length };
}

/** Older page: up to PAGE_SIZE messages with seq < before_seq (ascending). */
function pageBefore(messages: ChatMessage[], beforeSeq: number): MessagePage {
  const older = messages.filter((m) => m.seq < beforeSeq); // still ascending
  const page = older.slice(-PAGE_SIZE);
  return { messages: page, has_more: older.length > page.length };
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
  const hue = hashString(url) % 360;
  const label = (url.split("/").filter(Boolean).pop() ?? "media").slice(0, 24);
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

// ---------------------------------------------------------------------------
// App settings + GitLab link enrichment — stand-in for the Rust store settings
// table (`get_settings`/`set_settings`) and the `gitlab` module (`enrich_link`).
// Deterministic, self-contained: no real GitLab tenant is ever contacted.
// ---------------------------------------------------------------------------

/** In-memory settings (the real backend persists these in SQLite). The token is
 *  write-only from the UI's side, so only its presence is ever reported back. */
const mockSettings = { gitlab_host: "gitlab.com", gitlab_token: "" };

/** Non-secret settings view, matching the Rust `get_settings` result. */
function settingsView(): { gitlab_host: string; gitlab_token_set: boolean } {
  const host = mockSettings.gitlab_host.trim() || "gitlab.com";
  return { gitlab_host: host, gitlab_token_set: mockSettings.gitlab_token.length > 0 };
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

/** Deterministic metadata for a parsed GitLab URL — canned, but varied by iid so
 *  the UI shows realistic, distinct cards without any tenant. */
function mockGitLabMetadata(url: string): Record<string, unknown> | null {
  const parsed = parseGitLabUrl(url, mockSettings.gitlab_host || "gitlab.com");
  if (!parsed) return null;
  const { project_path } = parsed;

  if (parsed.kind === "merge_request") {
    const iid = parsed.iid!;
    const state = iid % 3 === 0 ? "merged" : "opened";
    return {
      kind: "merge_request",
      url,
      title: `Add rich link previews for GitLab (!${iid})`,
      project_path,
      reference: `!${iid}`,
      state,
      draft: iid % 5 === 0,
      author_name: "Ada Lovelace",
      source_branch: "feat/gitlab-rich-links",
      target_branch: "main",
      labels: ["frontend", "enhancement"],
      milestone: "v1.0",
      description: "Render GitLab links in chat as rich cards with title, state, and author.",
    };
  }
  if (parsed.kind === "issue") {
    const iid = parsed.iid!;
    return {
      kind: "issue",
      url,
      title: `Links should show a preview card (#${iid})`,
      project_path,
      reference: `#${iid}`,
      state: iid % 2 === 0 ? "closed" : "opened",
      author_name: "Grace Hopper",
      labels: ["bug"],
      description: "A bare URL is hard to scan; show the target's title and status inline.",
    };
  }
  return {
    kind: "project",
    url,
    title: project_path,
    project_path,
    reference: "",
    description: "A sample GitLab project used by the teams-lite mock backend.",
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

// ---- next sequence / message id for freshly created messages ----

function nextSeqFor(cs: ConvState): number {
  const last = cs.messages.at(-1);
  return (last?.seq ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Method dispatch — returns the `result` value or throws (message → error).
// ---------------------------------------------------------------------------

// Activity feed (`48:notifications`) — reactions/mentions/replies directed at
// "me". The real backend decodes these from `properties.activity`; the mock
// serves a small static sample keyed to real seeded conversations (so selecting
// an entry opens a live chat), plus anything injected via the test hook.
type MockNotification = {
  id: string;
  activity_type: string;
  activity_subtype: string;
  actor_name: string;
  actor_mri: string;
  source_thread_id: string;
  source_message_id: string;
  preview: string;
  timestamp: number;
  count: number;
  is_read: boolean;
};

const injectedNotifications: MockNotification[] = [];

// Stable base time for the static sample — captured once so repeated
// `notifications` calls return identical timestamps (a per-call Date.now() would
// drift forward and spuriously re-mark entries unread after the panel is seen).
const NOTIFICATIONS_BASE = Date.now();

function notificationsFeed(): MockNotification[] {
  const now = NOTIFICATIONS_BASE;
  const thread = (i: number) => order[i] ?? order[0] ?? "";
  // Target a real, non-bottom message so opening the notification scrolls up to
  // it (message ids are `${convId}#${seq}`; 1:1s seed 120 messages, newest page
  // is seq 81..120).
  const msg = (i: number, seq: number) => `${thread(i)}#${seq}`;
  const sample: MockNotification[] = [
    {
      id: "act-sample-1",
      activity_type: "reactionInChat",
      activity_subtype: "laugh",
      actor_name: "Riley Carter",
      actor_mri: "8:orgid:riley",
      source_thread_id: thread(0),
      source_message_id: msg(0, 100),
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
      preview: "Can I deploy to staging real quick?",
      timestamp: now - 55 * 60_000,
      count: 1,
      is_read: false,
    },
    {
      id: "act-sample-3",
      activity_type: "reactionInChat",
      activity_subtype: "like",
      actor_name: "Jordan Blake",
      actor_mri: "8:orgid:jordan",
      source_thread_id: thread(2),
      source_message_id: msg(2, 90),
      preview: "I don't think so, we'd have had feedback otherwise",
      timestamp: now - 3 * 3_600_000,
      count: 1,
      is_read: true,
    },
  ];
  return [...injectedNotifications, ...sample];
}

function dispatch(method: string, params: unknown): unknown {
  switch (method) {
    case "ping":
      return "pong";

    case "conversations": {
      // Newest activity first, exactly like the sidebar expects.
      return order
        .map((id) => store.get(id)!.conv)
        .slice()
        .sort((a, b) => b.last_message_time - a.last_message_time)
        .map((c) => ({ ...c }));
    }

    case "notifications": {
      const items = notificationsFeed();
      return { unread: items.filter((n) => !n.is_read).length, items };
    }

    case "open": {
      const id = requireString(params, "conversation");
      const cs = store.get(id);
      if (!cs) return { messages: [], has_more: false };
      return newestPage(cs.messages);
    }

    case "backfill": {
      const id = requireString(params, "conversation");
      const beforeSeq = requireNumber(params, "before_seq");
      const cs = store.get(id);
      if (!cs) return { messages: [], has_more: false };
      return pageBefore(cs.messages, beforeSeq);
    }

    case "set_draft": {
      const id = requireString(params, "conversation");
      const text = requireString(params, "text");
      const cs = store.get(id);
      if (cs) cs.conv.draft = text; // reflected by a later `conversations`
      return { saved: true };
    }

    case "send": {
      const id = requireString(params, "conversation");
      const text = requireString(params, "text");
      const replyTo = parseReplyTo(asObject(params).reply_to);
      const rawHtml = asObject(params).content_html;
      const contentHtml = typeof rawHtml === "string" && rawHtml.length > 0 ? rawHtml : undefined;
      scheduleSendEcho(id, text, replyTo, contentHtml);
      return { sent: true };
    }

    case "edit": {
      const id = requireString(params, "conversation");
      const messageId = requireString(params, "message_id");
      const text = requireString(params, "text");
      editMessage(id, messageId, text);
      return { edited: true };
    }

    case "fetch_media": {
      const url = requireString(params, "url");
      return mockMedia(url);
    }

    case "get_settings":
      return settingsView();

    case "set_settings": {
      const o = asObject(params);
      if (typeof o.gitlab_host === "string") mockSettings.gitlab_host = o.gitlab_host.trim();
      if (typeof o.gitlab_token === "string") mockSettings.gitlab_token = o.gitlab_token.trim();
      return settingsView();
    }

    case "enrich_link": {
      const url = requireString(params, "url");
      return { metadata: mockGitLabMetadata(url) };
    }

    default:
      throw new Error(`unknown method: ${method}`);
  }
}

/** Handle one text frame: parse, dispatch, reply. Never throws to the caller. */
function handleFrame(ws: Socket, raw: string): void {
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
    const result = dispatch(method, params);
    sendJson(ws, { id, result });
  } catch (e) {
    sendJson(ws, { id, error: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Simulated real-time: sent-message echoes + periodic incoming messages.
// ---------------------------------------------------------------------------

/** Append a message to a conversation and refresh its summary. */
function appendMessage(cs: ConvState, msg: ChatMessage): void {
  cs.messages.push(msg);
  recomputeSummary(cs);
}

/** Edit a stored message in place and broadcast the new content, mirroring the
 *  Rust backend: it PUTs the message resource, updates the local row, then emits
 *  a `message` event that the UI reconciles by id (replacing the old bubble). */
function editMessage(convId: string, messageId: string, text: string): void {
  const cs = store.get(convId);
  if (!cs) return;
  const msg = cs.messages.find((m) => m.id === messageId);
  if (!msg) return;
  const content = escapeHtml(text);
  if (msg.content === content) return; // no-op edit: nothing to broadcast
  msg.content = content;
  recomputeSummary(cs);
  broadcast("message", msg);
  broadcast("conversations_changed", {});
}

/** ~150ms after a `send`, echo the message back as the backend's trouter would,
 *  then clear the draft (matches src/bin/server.rs behavior on a successful send). */
function scheduleSendEcho(
  convId: string,
  text: string,
  replyTo: ReplyTo | undefined,
  contentHtml?: string,
): void {
  setTimeout(() => {
    const cs = store.get(convId);
    if (!cs) return;
    const seq = nextSeqFor(cs);
    const msg: ChatMessage = {
      id: `${convId}#${seq}`,
      conversation_id: convId,
      seq,
      compose_time: Date.now(),
      sender: SELF_NAME,
      sender_mri: SELF_MRI,
      content: composeContent(text, replyTo, contentHtml),
      is_self: true,
    };
    appendMessage(cs, msg);
    cs.conv.is_read = true; // it's ours
    cs.conv.draft = ""; // the accepted send clears the persisted draft
    broadcast("message", msg);
    broadcast("conversations_changed", {});
  }, SEND_ECHO_DELAY_MS);
}

/** Every ~7s, drop an incoming (is_self:false) message into a random chat and
 *  push it live, so live updates and notifications are exercised in the UI. */
function startLiveFeed(): void {
  if (LIVE_INTERVAL_MS <= 0) return; // deterministic mode (e.g. E2E): no feed
  setInterval(() => {
    if (sockets.size === 0) return; // no listeners → don't grow history pointlessly

    // Pick a random conversation that has someone else who can talk to us.
    const candidates = order
      .map((id) => store.get(id)!)
      .filter((cs) => cs.participants.length > 0);
    if (candidates.length === 0) return;
    const cs = pick(candidates, Math.random);
    const person = pick(cs.participants, Math.random);
    const seq = nextSeqFor(cs);

    // Occasionally reply to the latest message; otherwise a fresh line.
    const last = cs.messages.at(-1);
    const content =
      last && Math.random() < 0.2
        ? replyContent(last, pick(REPLY_BODIES, Math.random))
        : escapeHtml(pick(MESSAGE_POOL, Math.random));

    const msg: ChatMessage = {
      id: `${cs.conv.id}#${seq}`,
      conversation_id: cs.conv.id,
      seq,
      compose_time: Date.now(),
      sender: person.name,
      sender_mri: person.mri,
      content,
      is_self: false,
    };
    appendMessage(cs, msg);
    cs.conv.is_read = false; // a new incoming message is unread
    broadcast("message", msg);
    broadcast("conversations_changed", {});
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
}): ChatMessage | null {
  const cs = store.get(input.conversation);
  if (!cs) return null;
  const isSelf = input.isSelf ?? false;
  const fallback = cs.participants[0];
  const sender = input.sender ?? (isSelf ? SELF_NAME : (fallback?.name ?? "Someone"));
  const senderMri =
    input.senderMri ?? (isSelf ? SELF_MRI : (fallback?.mri ?? "8:orgid:someone"));
  const seq = nextSeqFor(cs);
  const last = cs.messages.at(-1);
  const content =
    input.reply && last ? replyContent(last, input.content) : escapeHtml(input.content);
  const msg: ChatMessage = {
    id: `${cs.conv.id}#${seq}`,
    conversation_id: cs.conv.id,
    seq,
    compose_time: Date.now(),
    sender,
    sender_mri: senderMri,
    content,
    is_self: isSelf,
  };
  appendMessage(cs, msg);
  cs.conv.is_read = isSelf; // an incoming message is unread; ours is read
  broadcast("message", msg);
  broadcast("conversations_changed", {});
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
        preview: typeof body.preview === "string" ? body.preview : "reacted to your message",
        timestamp: Date.now(),
        count: 1,
        is_read: false,
      });
      broadcast("notifications_changed", {});
      return Response.json({ ok: true }, { status: 200 });
    }
    // Broadcast a typing/presence signal, exactly like the Rust backend's
    // `typing` event, so the E2E suite can drive the indicator deterministically.
    if (body.kind === "typing") {
      broadcast("typing", {
        conversation_id:
          typeof body.conversation === "string" ? body.conversation : (order[0] ?? ""),
        sender_mri: typeof body.sender_mri === "string" ? body.sender_mri : "8:orgid:riley",
        sender: typeof body.sender === "string" ? body.sender : "Riley Carter",
        is_typing: body.is_typing === undefined ? true : Boolean(body.is_typing),
      });
      return Response.json({ ok: true }, { status: 200 });
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
    });
    return Response.json({ ok: msg !== null, message: msg }, { status: msg ? 200 : 404 });
  }
  if (req.method === "GET" && url.pathname === "/__test/conversations") {
    return Response.json(
      order.map((id) => {
        const c = store.get(id)!.conv;
        return { id: c.id, name: c.name, kind: c.kind };
      }),
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

seed();
seedMediaSamples();
seedGitLabSamples();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  websocket: {
    open(ws) {
      sockets.add(ws);
      // Greet exactly like the Rust backend does on a fresh connection.
      sendJson(ws, { event: "status", data: "connected" });
      sendJson(ws, { event: "realtime_status", data: "connected" });
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
  `[mock] teams-lite mock backend on ws://${server.hostname}:${server.port} (${store.size} conversations)` +
    (TEST_HOOKS ? " [test-hooks]" : "") +
    (LIVE_INTERVAL_MS <= 0 ? " [no-live-feed]" : ""),
);
