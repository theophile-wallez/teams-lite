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
// Methods: ping | conversations | open | backfill | set_draft | send
// Events:  status | realtime_status | message | conversations_changed
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
/** How often to inject a live incoming message. */
const LIVE_INTERVAL_MS = 7_000;
/** Delay before echoing a sent message, simulating the real-time round trip. */
const SEND_ECHO_DELAY_MS = 150;

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
 *  plain `text` is ignored (the web UI puts the composed body in `after`). */
function composeContent(text: string, reply: ReplyTo | undefined): string {
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
      scheduleSendEcho(id, text, replyTo);
      return { sent: true };
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

/** ~150ms after a `send`, echo the message back as the backend's trouter would,
 *  then clear the draft (matches src/bin/server.rs behavior on a successful send). */
function scheduleSendEcho(convId: string, text: string, replyTo: ReplyTo | undefined): void {
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
      content: composeContent(text, replyTo),
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
// Boot.
// ---------------------------------------------------------------------------

seed();

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
  fetch(req, server) {
    // Upgrade WebSocket handshakes; anything else gets a plain hello.
    if (server.upgrade(req)) return undefined;
    return new Response("teams-lite mock backend");
  },
});

startLiveFeed();

console.log(
  `[mock] teams-lite mock backend on ws://${server.hostname}:${server.port} (${store.size} conversations)`,
);
