// Browser WebSocket client to the teams-lite Rust backend.
//
// It targets the browser `WebSocket` global and is safe to construct during SSR (it
// only opens a socket when connect() is called on the client).
//
//   request  -> { id, method, params }
//   response <- { id, result } | { id, error }
//   event    <- { event, data }        (server push)

import type { AgentMode, AgentProviderPatch, AgentStatus } from "./agent";
import { BACKEND_WS_ROUTE } from "./backend-route";
import type { CallPreparation, CallStatus } from "./call";
import type { SendImage } from "./composer-image";
import type { OutboundMention } from "./mentions";
import type {
  AddressPeopleResult,
  AppSettings,
  CalendarInfo,
  CalendarViewResult,
  Channel,
  Conversation,
  LinkMetadataResult,
  MailBody as MailBodyResult,
  MailFolder,
  MailPage,
  MembersResult,
  MessagePage,
  NotificationFeeds,
  PersonOverride,
  PersonProfile,
  PresenceResult,
  ReadReceiptsResult,
  ReplyTo,
  SettingsPatch,
  UpdateProgress,
} from "./protocol";
import type { PushStatus, SubscriptionPayload } from "./push";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type EventHandler = (data: unknown) => void;

/** Where the local Rust backend listens, for a process with no page to ask. */
const PRODUCTION_WS_URL = "ws://127.0.0.1:19420";

/** Hosts that mean "the machine this page came from is also the backend's". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Whether `url` names a loopback address — i.e. is only meaningful to a client
 *  running on the same machine as the backend. */
function pointsAtLoopback(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The backend endpoint on the origin that served this page — `loc` is normally
 * `globalThis.location` — or null when there is no page (SSR).
 *
 * A page opened from another device cannot dial `ws://127.0.0.1:19420` itself, even
 * though that is where the backend listens: "localhost" only means the backend for
 * a browser running on the same machine as it. Open the app from a phone — over
 * Tailscale, say — and 127.0.0.1 is the phone; over an `https:` origin the browser
 * refuses a plaintext `ws://` as mixed content before it even resolves. Going
 * through the server that served the page fixes both at once, and keeps the
 * backend's own socket on loopback where it belongs (`bind_addr()` in
 * `src/bin/server.rs` binds 127.0.0.1 and nothing else): the app's server is the
 * only thing that bridges it.
 */
export function backendUrlForPage(
  loc: { protocol: string; host: string } | null | undefined,
): string | null {
  if (!loc?.host) return null;
  if (loc.protocol !== "http:" && loc.protocol !== "https:") return null;
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${BACKEND_WS_ROUTE}`;
}

/**
 * Whether a page on `loc` has to go through the relay to reach `configured`.
 *
 * Only one case does: a configured backend on loopback, opened from somewhere that
 * is not this machine. Everything else keeps the URL it was given — the mock stays
 * the mock, an explicitly remote backend stays that one — so the safety catch below
 * keeps meaning exactly what it says.
 */
export function needsRelay(
  configured: string,
  loc: { hostname: string } | null | undefined,
): boolean {
  if (!loc?.hostname) return false;
  return pointsAtLoopback(configured) && !isLoopbackHost(loc.hostname);
}

/** `configured`, or the relay on this page's own origin when that address cannot
 *  work from where the page is running (see {@link needsRelay}). */
function reachableFromThisPage(configured: string): string {
  if (!needsRelay(configured, globalThis.location)) return configured;
  return backendUrlForPage(globalThis.location) ?? configured;
}

/**
 * The backend URL to use when a caller does not name one.
 *
 * In a production build this is the local Rust backend — the whole point of
 * `teams`. In DEV there is deliberately **no default**: a dev server must
 * state its target through `VITE_TEAMS_WS_URL`, or this throws.
 *
 * That asymmetry is a safety catch, not pedantry. A dev server that silently
 * falls back to the real backend means any tooling driving the UI — a screenshot
 * script, an E2E-style driver, an agent poking at a component — is one forgotten
 * environment variable away from typing into the user's real Teams account and
 * posting to a real colleague. It happened: three test phrases went out to two
 * 1:1 chats because a restarted `vite dev` lost its `VITE_TEAMS_WS_URL`. Failing
 * loudly at startup costs one variable; the silent fallback costs a real message.
 *
 * Either way, a page opened from ANOTHER DEVICE goes through the relay instead:
 * whatever this machine calls "the backend", a loopback address does not name it
 * from a phone (see {@link needsRelay} and {@link backendUrlForPage}). That is what
 * makes the app usable over Tailscale without exposing the backend's own port.
 *
 * Resolved lazily (a function, not a module constant) so importing this module
 * stays side-effect-free — unit tests construct `Backend` with an explicit URL
 * and must not need the variable at all.
 */
export function defaultWsUrl(): string {
  const configured = (import.meta.env?.VITE_TEAMS_WS_URL as string | undefined)?.trim();
  if (configured) return reachableFromThisPage(configured);
  if (import.meta.env?.DEV) {
    throw new Error(
      "VITE_TEAMS_WS_URL is not set. A dev server must name its backend explicitly — " +
        "there is no default in dev, so that nothing can reach the real Teams account by " +
        `accident. Use the mock (bun run dev:mock, or VITE_TEAMS_WS_URL=ws://127.0.0.1:19455) ` +
        `for anything automated; pass VITE_TEAMS_WS_URL=${PRODUCTION_WS_URL} only for hands-on ` +
        "work against your own account.",
    );
  }
  return reachableFromThisPage(PRODUCTION_WS_URL);
}

const RECONNECT_GIVE_UP_MS = 30_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_INITIAL_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

export type BackendOptions = {
  giveUpMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export class Backend {
  private ws: WebSocket | null = null;
  private url: string;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private closed = false;
  // Whether a socket has ever opened. Lets `onopen` tell the FIRST connect apart
  // from a reconnect, so it emits `reconnected` only on the latter — the signal
  // the store uses to re-sync state that may have drifted while we were away.
  private everConnected = false;
  // The backend's write-lock capability token, when the app's server gave us one.
  private writeToken: string | null = null;
  private firstFailureAt: number | null = null;
  private readonly giveUpMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(url: string = defaultWsUrl(), opts: BackendOptions = {}) {
    this.url = url;
    this.giveUpMs = opts.giveUpMs ?? RECONNECT_GIVE_UP_MS;
    this.initialDelayMs = opts.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    this.reconnectDelay = this.initialDelayMs;
  }

  /** Connect and keep alive (auto-reconnect with capped backoff). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => this.openSocket(resolve, reject));
  }

  /**
   * Reconnect right now, with a fresh give-up window.
   *
   * The backoff stops retrying after {@link RECONNECT_GIVE_UP_MS} of failures,
   * which is right for a backend that died and wrong for a phone that was merely
   * asleep. A backgrounded mobile tab has its timers frozen: the socket closes
   * when the OS suspends it, no retry ever runs, and the first one to run after it
   * wakes is already minutes past the deadline — so a returning tab would show
   * "backend lost" without a single real attempt. Callers use this on the moments
   * that mean "in use again" (see `watchWakeups` in `store.ts`).
   *
   * A no-op while connected, or after {@link close}.
   */
  retryNow(): void {
    if (this.closed || this.connected) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.firstFailureAt = null;
    this.reconnectDelay = this.initialDelayMs;
    this.openSocket();
  }

  /** Stop everything: cancel reconnect, drop the socket, fail pending requests. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.teardownSocket();
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }

  private openSocket(onOpen?: () => void, onFail?: (e: unknown) => void): void {
    if (this.closed) return;
    if (typeof WebSocket === "undefined") {
      onFail?.(new Error("WebSocket unavailable (SSR)"));
      return;
    }
    this.teardownSocket();

    const ws = new WebSocket(this.url);
    this.ws = ws;
    let settled = false;

    ws.onopen = () => {
      this.reconnectDelay = this.initialDelayMs;
      this.firstFailureAt = null;
      this.reconnecting = false;
      settled = true;
      // A reopen (not the first connect) means we dropped and came back: the
      // backend is live again but our state may have drifted while offline.
      // Signal it so the store can reconcile; the first connect stays silent.
      if (this.everConnected) this.emit("reconnected", {});
      this.everConnected = true;
      onOpen?.();
    };
    ws.onerror = () => {
      // A browser WebSocket error is an opaque Event with no failure detail (the
      // reason is deliberately hidden), so reject with an actionable message
      // instead of the raw Event — which would stringify to "[object Event]".
      if (!settled) {
        settled = true;
        onFail?.(new Error(`could not connect to ${this.url}`));
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      this.emit("disconnected", {});
      this.scheduleReconnect();
    };
    ws.onmessage = (m) => this.onMessage(String(m.data));
  }

  private teardownSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    if (this.firstFailureAt === null) this.firstFailureAt = Date.now();

    if (Date.now() - this.firstFailureAt >= this.giveUpMs) {
      this.emit("backend_lost", {});
      return;
    }

    this.reconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelayMs);
      this.openSocket();
    }, this.reconnectDelay);
  }

  private onMessage(raw: string) {
    let msg: { event?: string; data?: unknown; id?: number; error?: string; result?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.event === "string") {
      this.emit(msg.event, msg.data);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("not connected"));
      }
      // Clear the timeout whenever the request settles, so a resolved/rejected
      // request never leaves a lingering timer alive.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * A request for an outward-facing method (`send`/`edit`/`react`), carrying the
   * backend's write token.
   *
   * The backend refuses these without it — reading is open to any local client,
   * writing is not, because a write posts to real people as the user (see the
   * write lock in `src/bin/server.rs`). Only the app's own server hands us the
   * token; if we have none, the request goes out anyway so the backend's own
   * refusal message surfaces in the UI rather than a silently different failure.
   */
  private writeRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return this.request<T>(method, { ...params, write_token: this.writeToken ?? undefined });
  }

  /**
   * Hand this client the write token published by the backend for the user's own
   * frontends (fetched from the app's own server — see `web/write-token.ts`).
   * Passing `null` clears it, which leaves the client read-only.
   */
  setWriteToken(token: string | null): void {
    this.writeToken = token;
  }

  // ---- typed API ----------------------------------------------------------

  conversations(): Promise<Conversation[]> {
    return this.request<Conversation[]>("conversations");
  }
  /** Fetch the team/channel tree (a flat, pre-sorted list grouped client-side by
   *  {@link groupChannelsByTeam}). Local-first like `conversations`: answers from
   *  the cache, then a background sync may push `channels_changed`. */
  channels(): Promise<Channel[]> {
    return this.request<Channel[]>("channels");
  }
  open(conversation: string): Promise<MessagePage> {
    return this.request<MessagePage>("open", { conversation });
  }
  backfill(conversation: string, beforeSeq: number): Promise<MessagePage> {
    return this.request<MessagePage>("backfill", { conversation, before_seq: beforeSeq });
  }
  setDraft(conversation: string, text: string): Promise<{ saved: boolean }> {
    return this.request<{ saved: boolean }>("set_draft", { conversation, text });
  }
  send(
    conversation: string,
    text: string,
    replyTo?: ReplyTo,
    contentHtml?: string,
    image?: SendImage,
    mentions?: OutboundMention[],
  ): Promise<{ sent: boolean }> {
    return this.writeRequest<{ sent: boolean }>("send", {
      conversation,
      text,
      reply_to: replyTo,
      content_html: contentHtml,
      // Who the message @mentions. The body's mention spans carry only an index; this
      // list is what tells Teams whom each index names, so they are notified.
      mentions: mentions && mentions.length > 0 ? mentions : undefined,
      image: image
        ? {
            name: image.name,
            content_type: image.contentType,
            width: image.width,
            height: image.height,
            data_base64: image.dataBase64,
          }
        : undefined,
    });
  }
  edit(conversation: string, messageId: string, text: string): Promise<{ edited: boolean }> {
    return this.writeRequest<{ edited: boolean }>("edit", {
      conversation,
      message_id: messageId,
      text,
    });
  }
  /** Delete one of our own messages. Teams removes it from the thread for everybody,
   *  on every device, and nothing brings it back — the one outward call in this client
   *  that cannot be undone, which is why the UI confirms before calling it.
   *
   *  The backend flags the local row and re-broadcasts it, so the bubble becomes the
   *  "You deleted this message" placeholder through the `message` event. It refuses a
   *  message that is not ours before reaching the network. */
  deleteMessage(conversation: string, messageId: string): Promise<{ deleted: boolean }> {
    return this.writeRequest<{ deleted: boolean }>("delete", {
      conversation,
      message_id: messageId,
    });
  }
  /** React to a message with an emoji (Teams "emotion"), or toggle ours off.
   *  `key` is the emotion (e.g. "like", "heart"). The backend toggles — clicking
   *  our current reaction removes it — and re-broadcasts the message, so state
   *  reconciles via the `message` event; `reacted` is the resulting on/off. */
  react(conversation: string, messageId: string, key: string): Promise<{ reacted: boolean }> {
    return this.writeRequest<{ reacted: boolean }>("react", {
      conversation,
      message_id: messageId,
      key,
    });
  }
  /** Mark a conversation or channel read up to its newest message — what the app
   *  calls when the user opens an unread thread.
   *
   *  A WRITE, and gated like one: unless Ghost mode is on, the backend publishes our
   *  read position to Teams, which clears the marker on every device the user owns
   *  and shows the sender a read receipt. `ghost` in the reply says which happened,
   *  so the caller knows whether the thread is read only here. */
  markRead(conversation: string): Promise<{ read: boolean; ghost: boolean }> {
    return this.writeRequest<{ read: boolean; ghost: boolean }>("mark_read", { conversation });
  }
  /** Mute or unmute one chat IN MICROSOFT TEAMS — the "…" menu's Mute item.
   *
   *  A WRITE, and gated like one: Teams keeps a mute as the conversation's own `alerts`
   *  property, so the setting lands on every device the user is signed in on and their
   *  phone stops notifying them about the thread. The reply carries the value the
   *  backend published, so the row follows the account rather than this browser.
   *
   *  The chat's PIN and HIDE have no counterpart here: neither write round-trips through
   *  the tenant, so both stay local to this app (see `ChatPrefs` in lib/protocol.ts). */
  setChatMuted(conversation: string, muted: boolean): Promise<{ muted: boolean }> {
    return this.writeRequest<{ muted: boolean }>("set_chat_muted", { conversation, muted });
  }
  /** Ask the backend to repair sign-in: it starts a systemd unit that restarts the
   *  Intune container, because the container's login keyring re-locks and the broker
   *  then answers no token call at all.
   *
   *  A WRITE request, though it posts nothing to Teams: it restarts a service on the
   *  user's machine, so the backend gates it on the same capability token and refuses
   *  it outright when read-only (see `MACHINE_METHODS` in src/bin/server.rs).
   *
   *  Resolves as soon as the unit is ENQUEUED. The repair itself takes about a minute
   *  and drops this socket on the way; recovery is the page's own reconnect. */
  repairBroker(): Promise<{ started: boolean; reason?: string }> {
    return this.writeRequest<{ started: boolean; reason?: string }>("repair_broker", {});
  }

  /** Start downloading the new build. Answers with the phase this leaves us in, and
   *  the progress then arrives as `update_progress` events (see {@link UpdateProgress}).
   *
   *  A WRITE request: it spends the user's bandwidth on their machine. Idempotent — a
   *  second page, or a second click, joins the download in flight. */
  updateDownload(): Promise<UpdateProgress> {
    return this.writeRequest<UpdateProgress>("update_download", {});
  }
  /** Install what was downloaded and restart the app onto it.
   *
   *  A WRITE request, and the heaviest one here: it replaces the binary the user's whole
   *  Teams account runs through. It answers `restarting`, and this socket goes down a
   *  moment later — the page's own reconnect is what shows the app coming back. */
  updateApply(): Promise<UpdateProgress> {
    return this.writeRequest<UpdateProgress>("update_apply", {});
  }

  /** What the backend can do about push notifications, and which devices it already
   *  notifies. A read: the page needs the VAPID public key before it can subscribe,
   *  and `supported: false` means this backend never pushes (read-only mode). */
  pushStatus(): Promise<PushStatus> {
    return this.request<PushStatus>("push_status", {});
  }
  /** Register THIS device for push notifications. Idempotent — the page calls it on
   *  every launch so a rotated subscription heals itself.
   *
   *  A WRITE request, though it posts nothing to Teams: it decides which devices the
   *  machine sends message previews to (a `MACHINE_METHODS` entry in
   *  src/bin/server.rs). */
  pushSubscribe(payload: SubscriptionPayload): Promise<PushStatus> {
    return this.writeRequest<PushStatus>("push_subscribe", { ...payload });
  }
  /** Forget one device's subscription — the user turning notifications off. */
  pushUnsubscribe(endpoint: string): Promise<PushStatus & { removed: boolean }> {
    return this.writeRequest<PushStatus & { removed: boolean }>("push_unsubscribe", { endpoint });
  }
  /** Push a test notification to every subscribed device, so the user can prove the
   *  chain works without waiting for somebody to write to them. */
  pushTest(): Promise<{ delivered: number; failed: number; errors: string[] }> {
    return this.writeRequest<{ delivered: number; failed: number; errors: string[] }>(
      "push_test",
      {},
    );
  }
  // ---- audio calling ------------------------------------------------------
  // Seven methods, and the split between them is the consent design: reading state
  // is open, and every step that rings a person, opens the microphone or hands out
  // the media credentials is a write request. See `./call.ts` and NATIVE-CALLING.md.

  /** Whether this machine can take calls, and what call it is in. A read: it carries
   *  no SDP and no credentials. */
  callStatus(): Promise<CallStatus> {
    return this.request<CallStatus>("call_status", {});
  }
  /** Turn calling on or off.
   *
   *  A WRITE request, and the consent gate for the whole feature: ON registers this
   *  machine with Teams as a device the user's calls ring on, OFF unregisters it so they
   *  stop being offered here (a `MACHINE_METHODS` entry, refused read-only). */
  setCalling(enabled: boolean): Promise<CallStatus> {
    return this.writeRequest<CallStatus>("set_calling", { enabled });
  }
  /** Reserve the one call this machine holds, and get what one `RTCPeerConnection`
   *  needs.
   *
   *  Two shapes, one per direction: a conversation starts an outgoing call, a call id
   *  prepares to answer the one that is ringing (and returns its offer). A WRITE
   *  request because it hands out the relay credentials the backend holds. */
  callPrepare(
    target:
      | { conversation: string }
      | { callId: string }
      | { joinUrl: string; subject?: string },
  ): Promise<CallPreparation> {
    const params =
      "conversation" in target
        ? { conversation: target.conversation }
        : "joinUrl" in target
          ? { join_url: target.joinUrl, subject: target.subject }
          : { call_id: target.callId };
    return this.writeRequest<CallPreparation>("call_prepare", params);
  }
  /** Place the call: one POST carrying our offer. This is what makes a device buzz in
   *  somebody's pocket, so it is an `OUTWARD_METHODS` entry and carries out one click. */
  callPlace(callId: string, sdp: string): Promise<{ call_id: string }> {
    return this.writeRequest<{ call_id: string }>("call_place", { call_id: callId, sdp });
  }
  /** Join a meeting: the same one POST, with the meeting's own thread instead of
   *  somebody to ring. Outward, because everybody already in the meeting sees the user
   *  arrive and their microphone is opened to all of them. */
  callJoin(callId: string, joinUrl: string, sdp: string): Promise<{ call_id: string }> {
    return this.writeRequest<{ call_id: string }>("call_join", {
      call_id: callId,
      join_url: joinUrl,
      sdp,
    });
  }
  /** Answer the ringing call with our own SDP. Outward: it opens the user's microphone
   *  to whoever is on the other end. */
  callAccept(callId: string, sdp: string): Promise<{ call_id: string }> {
    return this.writeRequest<{ call_id: string }>("call_accept", { call_id: callId, sdp });
  }
  /** End the call, or decline it while it is still ringing. Outward either way: the
   *  other side is told. */
  callHangup(callId: string): Promise<{ call_id: string; told_service: boolean }> {
    return this.writeRequest<{ call_id: string; told_service: boolean }>("call_hangup", {
      call_id: callId,
    });
  }
  /** Publish whether the user can be heard. The page has already stopped sending audio;
   *  this is the half the other side sees, which is why it is outward. */
  callMute(callId: string, muted: boolean): Promise<{ call_id: string; muted: boolean }> {
    return this.writeRequest<{ call_id: string; muted: boolean }>("call_mute", {
      call_id: callId,
      muted,
    });
  }

  /** What the local agent can do on the backend's machine: which CLIs it holds, which
   *  conversations are opted in, what an agent may run and where. A read. */
  agentStatus(): Promise<AgentStatus> {
    return this.request<AgentStatus>("agent_status", {});
  }
  /** Opt one conversation in or out of agent replies.
   *
   *  A WRITE request, and the consent gate for the whole feature: it decides where this
   *  machine posts an answer under the user's name (a `MACHINE_METHODS` entry in
   *  src/bin/server.rs, refused read-only). Returns the whole status, so a caller never
   *  has to guess what the store now holds. */
  agentSetMode(conversation: string, mode: AgentMode): Promise<AgentStatus> {
    return this.writeRequest<AgentStatus>("agent_set_mode", { conversation, mode });
  }
  /** Replace what an agent may do without being asked.
   *
   *  A WRITE request too, and the other half of the consent: it decides what a program
   *  this machine runs on a chat message may reach (`MACHINE_METHODS`, refused
   *  read-only). The WHOLE list, never an add — what an agent may do should be readable
   *  in one place, and a caller that widens it has to say what the full answer is. */
  agentSetTools(tools: string[]): Promise<AgentStatus> {
    return this.writeRequest<AgentStatus>("agent_set_tools", { tools });
  }
  /** Enable or disable one AI provider, and/or choose the model it runs.
   *
   *  A WRITE request: it decides which program a chat message starts on the backend's
   *  machine, and which model reads the thread (a `MACHINE_METHODS` entry in
   *  src/bin/server.rs, refused read-only). Returns the whole status, so the pane draws
   *  the backend's own answer rather than a local guess. */
  agentSetProvider(provider: string, patch: AgentProviderPatch): Promise<AgentStatus> {
    return this.writeRequest<AgentStatus>("agent_set_provider", { provider, ...patch });
  }
  /** Run the agent on the user's OWN Claude Code configuration instead of this app's
   *  allowlist — every MCP server and tool their settings hold, and their own permission
   *  mode.
   *
   *  A WRITE request, and the sharpest of them: it is what turns a chat message into a
   *  program that may write on that machine (a `MACHINE_METHODS` entry, refused
   *  read-only). Off in a fresh store. */
  agentSetUnrestricted(unrestricted: boolean): Promise<AgentStatus> {
    return this.writeRequest<AgentStatus>("agent_set_unrestricted", { unrestricted });
  }
  /** Fetch the notifications panel's three activity streams — Activity, Mentions
   *  and Following — in one round-trip. None is a chat: the backend fetches them
   *  fresh from Teams (concurrently) and decodes each entry. */
  notifications(limit?: number): Promise<NotificationFeeds> {
    return this.request<NotificationFeeds>("notifications", limit ? { limit } : {});
  }
  /** Fetch a conversation's read receipts ("seen by"): every OTHER member's read
   *  position. Best-effort on the backend — a thread with receipts disabled or
   *  too many members resolves to an empty list, never an error. The positions
   *  then refresh live via the `read_receipt` event. */
  readReceipts(conversation: string): Promise<ReadReceiptsResult> {
    return this.request<ReadReceiptsResult>("read_receipts", { conversation });
  }
  /** The people a message in this conversation can @mention, most relevant first.
   *  Best-effort on the backend — a roster it cannot read leaves a shorter list (in a
   *  channel, the people who have written there), never an error. */
  members(conversation: string): Promise<MembersResult> {
    return this.request<MembersResult>("members", { conversation });
  }
  /** Fetch one hosted-content media object (inline image or shared file) through
   *  the backend, which attaches the session credentials the browser lacks. The
   *  bytes come back base64-encoded so they ride the same JSON WebSocket. */
  fetchMedia(url: string): Promise<{ content_type: string; data_base64: string }> {
    return this.request<{ content_type: string; data_base64: string }>("fetch_media", { url });
  }

  /** Fetch a real profile photo — a person (`kind: "user"`, `id` = their MRI) or a
   *  Teams "team" group (`kind: "team"`, `id` = its AAD group id) — through the
   *  backend, which holds the credentials the browser lacks. `found` is false when
   *  the subject has no photo set, so the caller can fall back to initials and
   *  negative-cache the miss. Bytes come back base64-encoded over the same JSON WS. */
  fetchAvatar(
    kind: "user" | "team",
    id: string,
  ): Promise<{ found: boolean; content_type?: string; data_base64?: string }> {
    return this.request<{ found: boolean; content_type?: string; data_base64?: string }>(
      "fetch_avatar",
      { kind, id },
    );
  }

  /** Fetch the icon of an ORGANISATION that mails the user, for a sender the Teams
   *  directory cannot name. The backend holds every rail on that request (it is the
   *  only one aimed at a server nobody here configured — see `src/sender_icon.rs`) and
   *  answers `found: false` for a domain that serves none, which is most of the tail. */
  senderIcon(
    domain: string,
  ): Promise<{ found: boolean; content_type?: string; data_base64?: string }> {
    return this.request<{ found: boolean; content_type?: string; data_base64?: string }>(
      "sender_icon",
      { domain },
    );
  }

  /** Fetch one person's directory card — name, job title, department, email, work
   *  location — for the card shown on hovering their name. `found` is false when
   *  the directory knows nobody by this MRI, so the caller keeps the name it has.
   *  Only person MRIs are accepted; the backend refuses a channel/team MRI. */
  profile(mri: string): Promise<PersonProfile> {
    return this.request<PersonProfile>("profile", { mri });
  }

  /** Resolve a batch of MAIL ADDRESSES to the people behind them, so a message can
   *  show a real face for a sender or a recipient it names only by address. An
   *  address the directory does not know — an external sender, a distribution list,
   *  a shared mailbox — is simply absent from `people`. */
  peopleByAddress(addresses: string[]): Promise<AddressPeopleResult> {
    return this.request<AddressPeopleResult>("people_by_address", { addresses });
  }

  // ---- the name and face the USER gave somebody ---------------------------
  //
  // Microsoft Teams holds neither: a colleague's display name and photo are theirs
  // to set. These are LOCAL overrides, stored on this machine only, and nothing ever
  // publishes them back — see `person_overrides` in src/store.rs.
  //
  // Reading one is open; setting one carries the write token, because what it decides
  // is the name and the face this app puts on somebody's messages.

  /** What the user chose for one person, and what Teams itself calls them, so a
   *  surface can show both. `display_name` is empty when they overrode only the
   *  picture, and `has_avatar` false when they overrode only the name. */
  personOverride(mri: string): Promise<PersonOverride> {
    return this.request<PersonOverride>("person_override", { mri });
  }

  /** Every override the user set, newest change first, without the avatar bytes. */
  personOverrides(): Promise<{ overrides: PersonOverride[] }> {
    return this.request<{ overrides: PersonOverride[] }>("person_overrides");
  }

  /** Rename one person, or with an empty `name`, put their real name back. The
   *  picture they were given is left alone. */
  setPersonName(mri: string, name: string): Promise<{ saved: boolean }> {
    return this.writeRequest<{ saved: boolean }>("set_person_name", { mri, name });
  }

  /** Give one person a face, or with `null`, take it back. The name they were given
   *  is left alone. `data_base64` is the raw image; the backend caps its size and
   *  accepts only PNG, JPEG, GIF and WebP. */
  setPersonAvatar(
    mri: string,
    avatar: { content_type: string; data_base64: string } | null,
  ): Promise<{ saved: boolean }> {
    return this.writeRequest<{ saved: boolean }>("set_person_avatar", {
      mri,
      content_type: avatar?.content_type ?? "",
      data_base64: avatar?.data_base64 ?? "",
    });
  }

  /** Read live presence ("Available", "In a meeting", "Offline", …) for one or
   *  more people. Volatile: the backend never caches it, so the caller decides how
   *  long an answer is good for. Someone the service has no answer for is simply
   *  absent from `presences`. */
  presence(mris: string[]): Promise<PresenceResult> {
    return this.request<PresenceResult>("presence", { mris });
  }

  // ---- mail (read-only) ---------------------------------------------------
  //
  // Nothing here reaches the mailbox, so none of these uses `writeRequest`: the
  // write token exists to gate acts that other people see, and the mail surface has
  // none. The backend cannot send, reply to, delete or move a mail — the capability
  // is absent from the crate, not merely ungranted (see src/mail.rs). The one method
  // that writes at all is {@link mailMarkRead}, and it writes the backend's own
  // mirror.

  /** The mailbox's folders, in sidebar order. Local-first on the backend: answers
   *  from its cache, then a background sync may push `mail_folders_changed`. */
  mailFolders(): Promise<MailFolder[]> {
    return this.request<MailFolder[]>("mail_folders");
  }

  /** A folder's newest page of mail. Local-first: returns the cached page at once,
   *  and the backend reconciles it against the server in the background, pushing
   *  `mail_list_updated` when anything moved (new mail, read elsewhere, deleted
   *  elsewhere). Opening a folder also puts it under the backend's live poll. */
  mailList(folder: string, limit?: number): Promise<MailPage> {
    return this.request<MailPage>("mail_list", { folder, ...(limit ? { limit } : {}) });
  }

  /** The page of mail older than `before` (an ISO timestamp from the oldest row
   *  currently shown) — the scroll-up path. */
  mailBackfill(folder: string, before: string, limit?: number): Promise<MailPage> {
    return this.request<MailPage>("mail_backfill", {
      folder,
      before,
      ...(limit ? { limit } : {}),
    });
  }

  /** One mail's sanitized body. Cached by the backend after the first read, so
   *  re-opening a mail costs no network. The HTML contains no remote references —
   *  rendering it never phones home — and is still displayed inside a sandboxed
   *  iframe (see `MailBody`). */
  mailBody(id: string): Promise<MailBodyResult> {
    return this.request<MailBodyResult>("mail_body", { id });
  }

  /** Clear one mail's unread marker, HERE ONLY. The backend writes its own mirror
   *  and tells Graph nothing, so Outlook keeps the mail unread on every other client
   *  and its sender is shown nothing — which is why this is a plain request and not
   *  a `writeRequest`: nobody but the user sees it.
   *
   *  `read` is false when the backend refused to record it (a read-only backend
   *  never touches the user's markers), so a caller must not paint the marker clear
   *  before it comes back true. */
  mailMarkRead(id: string): Promise<{ read: boolean; moved: boolean }> {
    return this.request<{ read: boolean; moved: boolean }>("mail_mark_read", { id });
  }

  /** One attachment's bytes, base64 over this same socket (the browser holds no
   *  Graph token, so it cannot fetch them itself). */
  mailAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ content_type: string; name: string; data_base64: string }> {
    return this.request("mail_attachment", {
      message_id: messageId,
      attachment_id: attachmentId,
    });
  }

  // ---- calendar (read-only) -----------------------------------------------
  //
  // Read-only for the same reason mail is, only more sharply: creating an event
  // mails an invitation to every attendee and answering one mails the organizer.
  // Neither this client nor the backend has any path that could (see
  // src/calendar.rs). `join_url` and `web_link` on an event are links the user
  // clicks — nothing here joins or answers anything.

  /** The mailbox's calendars, default first. Local-first on the backend: answers
   *  from its cache, then a background sync may push `calendars_changed`. */
  calendars(): Promise<CalendarInfo[]> {
    return this.request<CalendarInfo[]>("calendars");
  }

  /** Every event overlapping `[start, end)` (ISO 8601 UTC), restricted to
   *  `calendarIds` when given.
   *
   *  Local-first: a window whose months the backend has already read answers from
   *  SQLite with no network at all, and a background refresh may then push
   *  `calendar_view_updated`. A window it has never read waits for the network,
   *  because an unsynced week and a free week are indistinguishable on a grid. */
  calendarView(start: string, end: string, calendarIds?: string[]): Promise<CalendarViewResult> {
    return this.request<CalendarViewResult>("calendar_view", {
      start,
      end,
      ...(calendarIds && calendarIds.length > 0 ? { calendars: calendarIds } : {}),
    });
  }

  /** Read the non-secret app settings (GitLab host, whether each integration's token
   *  is stored, and whether Ghost mode is on). A read, so it needs no write token —
   *  the view carries no token, and the UI needs it before the user has done anything. */
  getSettings(): Promise<AppSettings> {
    return this.request<AppSettings>("get_settings");
  }
  /** Persist app settings (partial). Omit a field to leave it unchanged; pass a
   *  token as `""` to clear the stored one. Returns the fresh non-secret view so
   *  the caller updates in one round-trip.
   *
   *  Gated by the write token: these are the integration credentials this machine
   *  holds, and the GitLab host decides where its token may be sent (see
   *  MACHINE_METHODS in src/bin/server.rs). */
  setSettings(patch: SettingsPatch): Promise<AppSettings> {
    const params: Record<string, string | boolean> = {};
    if (patch.gitlabHost !== undefined) params.gitlab_host = patch.gitlabHost;
    if (patch.gitlabToken !== undefined) params.gitlab_token = patch.gitlabToken;
    if (patch.linearToken !== undefined) params.linear_token = patch.linearToken;
    if (patch.ghostMode !== undefined) params.ghost_mode = patch.ghostMode;
    if (patch.senderIcons !== undefined) params.sender_icons = patch.senderIcons;
    return this.writeRequest<AppSettings>("set_settings", params);
  }
  /** Turn "Always available" on or off, which publishes the user's OWN presence:
   *  on registers this machine as an endpoint reporting Available (the backend then
   *  refreshes it on a heartbeat), off removes that registration and hands the status
   *  back to whatever Teams computes.
   *
   *  Its own call rather than a `setSettings` field, because it is outward — every
   *  colleague reads the green dot — so it is gated like a send and a read-only
   *  backend refuses it (see OUTWARD_METHODS in src/bin/server.rs). Returns the fresh
   *  settings view, so the switch only moves once Teams was actually told. */
  setAlwaysAvailable(enabled: boolean): Promise<AppSettings> {
    return this.writeRequest<AppSettings>("set_always_available", { enabled });
  }
  /** Enrich a tracker link with metadata for a rich preview card. Resolves with
   *  `{ metadata: null }` when no integration recognizes the link (or the resource
   *  is private); rejects only on a transient backend/network failure. */
  enrichLink(url: string): Promise<LinkMetadataResult> {
    return this.request<LinkMetadataResult>("enrich_link", { url });
  }

  // ---- events -------------------------------------------------------------

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: unknown) {
    this.handlers.get(event)?.forEach((h) => h(data));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
