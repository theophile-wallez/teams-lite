// Browser WebSocket client to the teams-lite Rust backend.
//
// It targets the browser `WebSocket` global and is safe to construct during SSR (it
// only opens a socket when connect() is called on the client).
//
//   request  -> { id, method, params }
//   response <- { id, result } | { id, error }
//   event    <- { event, data }        (server push)

import type { AgentMode, AgentProviderPatch, AgentStatus } from "./agent";
import type { AgentPersonaPatch } from "./agent-persona";
import { BACKEND_WS_ROUTE } from "./backend-route";
import type { CallPreparation, CallStatus, MeetingAddress } from "./call";
import type { ChessEngineState } from "./chess-engine";
import type { ChessSoundsState } from "./chess-sound";
import type { SendImage } from "./composer-image";
import type { DiffDepth, GitLabDiff } from "./gitlab-diff";
import type { WireDiffPosition } from "./gitlab-diff-comment";
import type {
  GitLabDiscussionList,
  GitLabJobLog,
  GitLabPipelineView,
  MergeOutcome,
  MergeRequestDetail,
  MergeRequestKey,
  MergeRequestList,
  MergeRequestScope,
  MergeRequestState,
  PostedNote,
} from "./gitlab-mr";
import type { OutboundMention } from "./mentions";
import type {
  AddressPeopleResult,
  AppSettings,
  BackendRestartResult,
  CalendarInfo,
  CalendarViewResult,
  Channel,
  Conversation,
  CustomEmoji,
  GitLabApprovalResult,
  LinearWorkspaceResult,
  LinkMetadataResult,
  MailBody as MailBodyResult,
  MailFolder,
  MailPage,
  MembersResult,
  ChatMessage,
  MessagePage,
  NotificationFeeds,
  PersonOverride,
  PersonProfile,
  PresenceResult,
  PresenceSchedule,
  ReactionPick,
  ReadReceiptsResult,
  ReplyTo,
  SealSetResult,
  SealStatus,
  SettingsPatch,
  SigninState,
  UpdateCheckResult,
  UpdateProgress,
  WriteLock,
} from "./protocol";
import { parseWriteLock } from "./protocol";
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

/**
 * The words the backend's "that is not my write token" refusal carries
 * (`WRITE_TOKEN_REFUSAL` in src/bin/server.rs, pinned there by a test that names this
 * function).
 *
 * It is matched on the phrase rather than on the whole sentence because that sentence
 * tells a human what to do about it and will be reworded; and it deliberately does NOT
 * match a read-only backend's refusal, which names no token because there is none.
 */
export function isWriteTokenRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("needs the write token");
}

/** How a meeting travels to `call_prepare` and `call_join` (`meeting_address` in
 *  src/bin/server.rs): the link a calendar event carried, or the meeting's own thread.
 *
 *  Exactly ONE of the two names is ever sent. The backend reads the link first, so a body
 *  carrying both would silently pick one — and the one it picked would not always be the
 *  one the button the user pressed was drawn from. */
function meetingParams(meeting: MeetingAddress): Record<string, string> {
  return meeting.kind === "link"
    ? { join_url: meeting.joinUrl }
    : { meeting_thread: meeting.thread };
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
  // How to read that token again, when the backend says the one we hold is not its
  // own (see `retryWithAFreshToken`).
  private writeTokenSource: (() => Promise<string | null>) | null = null;
  // Told once when a refusal survived a fresh token (see `setWriteRefusedHandler`).
  private onWriteRefused: (() => void) | undefined;
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
   *
   * A refusal that names the token is RETRIED once, with a freshly read one. See
   * {@link retryWithAFreshToken} for why that is both necessary and safe.
   */
  private async writeRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const presented = this.writeToken;
    try {
      return await this.request<T>(method, { ...params, write_token: presented ?? undefined });
    } catch (e) {
      const fresh = await this.retryWithAFreshToken(e, presented);
      if (fresh === null) {
        // A refusal a fresh token could not heal is the proof that this page holds no
        // token this backend accepts — which is a state about the whole app, not about
        // the button that was pressed. Tell the caller once so it can say so where a
        // person can read it, and never from here: this class knows no UI.
        if (isWriteTokenRefusal(e)) this.onWriteRefused?.();
        throw e;
      }
      return await this.request<T>(method, { ...params, write_token: fresh });
    }
  }

  /**
   * The token to retry a refused write with, or null to let the failure stand.
   *
   * The backend mints its token per PROCESS, so a restart — an update, a re-stage of
   * the always-on service, a crash — invalidates the one this page was handed. Nothing
   * about that is visible from here: reads keep answering, the socket is up, and the
   * only symptom is that every write comes back refused until somebody reloads. A page
   * left open on a phone for days is the normal way to meet it, and the failure it
   * produces — a message that does not leave, over and over — is the one this app can
   * least afford.
   *
   * The page re-reads the token on every reconnect for that reason, and this is the
   * second half: a refusal is the only proof that what it holds is stale, because a
   * restart the socket never noticed leaves the reconnect path unused.
   *
   * Three rails keep it honest:
   *
   *  - **Only that refusal.** The backend says so in words it pins for us
   *    (`WRITE_TOKEN_REFUSAL` in src/bin/server.rs). A read-only backend refuses in
   *    different words on purpose: it has no token, so re-reading one would loop.
   *  - **Only a token that CHANGED.** Presenting the same value again would be a
   *    second identical refusal, so the failure stands and reaches the user.
   *  - **Once.** Retrying is safe because the refusal happens at the backend's
   *    dispatch gate, before any network call: nothing was posted, so nothing can be
   *    posted twice. That is the whole reason this may retry at all — and it is why it
   *    must never be widened to a failure that could have reached Teams.
   */
  private async retryWithAFreshToken(error: unknown, presented: string | null): Promise<string | null> {
    if (!isWriteTokenRefusal(error)) return null;
    const source = this.writeTokenSource;
    if (!source) return null;
    let fresh: string | null = null;
    try {
      fresh = await source();
    } catch {
      return null; // the app's own server is unreachable: the refusal stands
    }
    if (!fresh || fresh === presented) return null;
    this.writeToken = fresh;
    return fresh;
  }

  /**
   * Hand this client the write token published by the backend for the user's own
   * frontends (fetched from the app's own server — see `web/write-token.ts`).
   * Passing `null` clears it, which leaves the client read-only.
   */
  setWriteToken(token: string | null): void {
    this.writeToken = token;
  }

  /**
   * Teach this client how to re-read the token, for {@link retryWithAFreshToken}.
   *
   * The fetch itself stays with the caller: it is an HTTP call to the app's own server,
   * which this class knows nothing about (see `loadWriteToken` in lib/store.ts).
   */
  setWriteTokenSource(source: (() => Promise<string | null>) | null): void {
    this.writeTokenSource = source;
  }

  /**
   * Be told when a write was refused for the token and a fresh one did not help — the
   * moment the page learns it cannot act at all (see `refreshWriteLock` in lib/store.ts).
   */
  setWriteRefusedHandler(handler: (() => void) | null): void {
    this.onWriteRefused = handler ?? undefined;
  }

  /**
   * Where this page stands with the write lock, asked with the token it holds.
   *
   * A plain READ — the one question that must not be gated behind the very token it is
   * about, so `write_lock_status` is open (see `write_lock_state` in src/bin/server.rs).
   * The answer never carries a token, in either direction: this presents the one the page
   * was handed, exactly as a write would, and gets back only where that leaves it.
   */
  async writeLockStatus(): Promise<WriteLock> {
    return parseWriteLock(
      await this.request<unknown>("write_lock_status", {
        write_token: this.writeToken ?? undefined,
      }),
    );
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
    images: SendImage[] = [],
    mentions?: OutboundMention[],
    scheduledTime?: number,
    subject?: string,
  ): Promise<{ sent: boolean }> {
    return this.writeRequest<{ sent: boolean }>("send", {
      conversation,
      text,
      reply_to: replyTo,
      content_html: contentHtml,
      // The post's TITLE, where a channel post has one — `properties.subject` on the
      // message, never words in its body (see lib/post-subject.ts). Absent means untitled,
      // which is every message this app sent before the field existed.
      subject: subject || undefined,
      // When Teams is to DELIVER it, in epoch milliseconds — absent means now. The
      // service holds the message until then, so this is one ordinary send with one more
      // field in it rather than a queue on this machine.
      scheduled_time: scheduledTime,
      // Who the message @mentions. The body's mention spans carry only an index; this
      // list is what tells Teams whom each index names, so they are notified.
      mentions: mentions && mentions.length > 0 ? mentions : undefined,
      // The pictures the message carries, in the order the composer holds them: that is
      // the order the backend uploads them in, and the order they appear in the body.
      images:
        images.length > 0
          ? images.map((image) => ({
              name: image.name,
              content_type: image.contentType,
              width: image.width,
              height: image.height,
              data_base64: image.dataBase64,
            }))
          : undefined,
    });
  }
  /** Rewrite one of our own messages. `contentHtml` is the same optional rich body a
   *  {@link send} carries and is used INSTEAD of escaping `text`: a message whose body is
   *  markup — a game of chess keeping its record in one message (see lib/chess-wire.ts) —
   *  cannot be rewritten as escaped plain text without becoming a different message. `text`
   *  travels either way, for a client that shows no HTML. */
  edit(
    conversation: string,
    messageId: string,
    text: string,
    contentHtml?: string,
  ): Promise<{ edited: boolean }> {
    return this.writeRequest<{ edited: boolean }>("edit", {
      conversation,
      message_id: messageId,
      text,
      content_html: contentHtml,
    });
  }
  /** Delete one of our own messages. Teams removes it from the thread for everybody,
   *  on every device, and nothing brings it back — the one outward call in this client
   *  that cannot be undone, which is why the UI confirms before calling it.
   *
   *  The backend flags the local row and re-broadcasts it, so the bubble becomes the
   *  "You deleted this message" placeholder through the `message` event. It refuses a
   *  message that is not ours before reaching the network. */
  /** Every message Teams is still HOLDING for this account, soonest first — an ordinary
   *  READ, and it makes no network request on the backend either: a scheduled send comes
   *  back in the ordinary history, so the store already holds all of them. */
  scheduledMessages(): Promise<{ messages: ChatMessage[] }> {
    return this.request<{ messages: ChatMessage[] }>("scheduled_messages");
  }
  deleteMessage(conversation: string, messageId: string): Promise<{ deleted: boolean }> {
    return this.writeRequest<{ deleted: boolean }>("delete", {
      conversation,
      message_id: messageId,
    });
  }
  /** React to a message with an emoji (Teams "emotion"), or toggle ours off.
   *  The pick is either an emotion key (e.g. "like", "heart", or an existing custom
   *  reaction verbatim) or one of the user's own emoji by name, whose key the backend
   *  mints once it has uploaded the art (see {@link ReactionPick}). The backend
   *  toggles — clicking our current reaction removes it — and re-broadcasts the
   *  message, so state reconciles via the `message` event; `reacted` is the resulting
   *  on/off. */
  react(
    conversation: string,
    messageId: string,
    pick: ReactionPick,
  ): Promise<{ reacted: boolean }> {
    return this.writeRequest<{ reacted: boolean }>("react", {
      conversation,
      message_id: messageId,
      ...pick,
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

  /** Start signing in again through the identity broker's own window — the remedy for the
   *  failure a container restart cannot fix (see src/signin.rs and SIGN-IN.md).
   *
   *  A WRITE request: it authenticates as the user. It answers with the first state rather
   *  than with the outcome, because most sign-ins finish with nobody typing anything and the
   *  rest take as long as a person does. */
  startSignin(): Promise<{ started: boolean; reason?: string; signin: SigninState }> {
    return this.writeRequest("signin_start", {});
  }

  /** How the sign-in is going. OPEN, like `write_lock_status`: it publishes no pixels and no
   *  keystrokes, only which phase the flow is in — and a page must be able to ask that
   *  without holding the token the rest of this needs. */
  signinStatus(): Promise<SigninState> {
    return this.request<SigninState>("signin_status", {});
  }

  /** One frame of the sign-in window, as a PNG.
   *
   *  A WRITE request even though it reads: its answer is a picture of a sign-in page, which
   *  is not something a client that merely found this socket may have. */
  signinFrame(): Promise<{ width: number; height: number; png: string }> {
    return this.writeRequest("signin_frame", {});
  }

  /** Send one keystroke, or one click, into the sign-in window.
   *
   *  One character per call, deliberately — the backend refuses more (`parse_key` in
   *  src/signin.rs), because a whole password in one field is what this design avoids. */
  signinInput(
    input: { char: string } | { key: string } | { x: number; y: number; button?: string },
  ): Promise<{ sent: boolean }> {
    return this.writeRequest("signin_input", input as Record<string, unknown>);
  }

  /** Close the sign-in window, which is how a flow is ended. */
  cancelSignin(): Promise<{ closed: boolean }> {
    return this.writeRequest("signin_cancel", {});
  }

  /** Ask GitHub, now, whether a newer build than this one has been published — Settings ›
   *  This app, rather than waiting up to two minutes for the poll.
   *
   *  An ordinary READ: it changes nothing on this machine and publishes nothing about the
   *  user, and it is the same request the backend already makes on a timer. The update ROW
   *  follows the `update_available` event this may publish; the answer here is what the
   *  BUTTON says, including the two the events cannot carry — that there is nothing new, and
   *  that GitHub could not be reached. */
  updateCheck(): Promise<UpdateCheckResult> {
    return this.request<UpdateCheckResult>("update_check", {});
  }
  /** Restart the backend, through whatever runs it.
   *
   *  A WRITE request, though it posts nothing to Teams: it takes the process every open page
   *  is talking to down (a `MACHINE_METHODS` entry in src/bin/server.rs). It answers
   *  `restarted: false` with a count while a local agent is mid-reply — the user's second
   *  press passes `force` — and this socket goes down a moment after an accepted one, so the
   *  page's own reconnect is what says the restart really happened. */
  restartBackend(force = false): Promise<BackendRestartResult> {
    return this.writeRequest<BackendRestartResult>("restart_backend", { force });
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

  /**
   * Every message of one conversation that carries a game of CHESS — what the head-to-head score
   * is counted over (see lib/chess-series.ts).
   *
   * An ordinary READ, and it makes no network request on the backend either: a game IS its
   * messages, so the store already holds all of them. It exists because the history loads a page at
   * a time — a score counted off the loaded page would count the games that happen to be on screen
   * and grow as the reader scrolled back.
   */
  chessMessages(conversation: string): Promise<{ messages: ChatMessage[] }> {
    return this.request<{ messages: ChatMessage[] }>("chess_messages", { conversation });
  }

  /**
   * Every message of one conversation that carries a COMPANION's record — the same read as
   * {@link chessMessages}, for a sharper reason (see src/store.rs on `pet_messages`).
   *
   * There the read buys a SCORE; here it is a correctness rail. Every act EDITS its author's one
   * ledger message, so that message keeps the `seq` it was first posted at and pages out of the loaded
   * window while the creature is alive — at which point the app drew no pet of the reader's own, hid
   * Feed, Play and Nap, and OFFERED THEM A SPAWN: a second arrival message everybody in the thread
   * reads, and one every reader's fold absorbs and ignores whole, so the creature became unreachable.
   */
  petMessages(conversation: string): Promise<{ messages: ChatMessage[] }> {
    return this.request<{ messages: ChatMessage[] }>("pet_messages", { conversation });
  }

  // ---- the chess ENGINE ----------------------------------------------------------------
  //
  // Stockfish is 7.3 MB the BACKEND fetches, verifies against a digest it pins and caches on this
  // machine (see src/chess_engine.rs): this page never fetches it, and never learns where it is.

  /** Whether the engine is on this machine, what fetching it costs, and how far a fetch has got. A
   *  READ: it names no path, publishes nothing about the user, and a page cannot offer a game
   *  against an engine without it. */
  engineStatus(): Promise<ChessEngineState> {
    return this.request<ChessEngineState>("chess_engine_status", {});
  }
  /** Fetch it. A WRITE: it spends the user's bandwidth and 7 MB of their disk. Idempotent — a
   *  second press, or a second window, joins the download in flight rather than starting another. */
  engineDownload(): Promise<ChessEngineState> {
    return this.writeRequest<ChessEngineState>("chess_engine_download", {});
  }
  /** Delete it. A WRITE, and the only one here that takes something away — it answers with what it
   *  freed. */
  engineForget(): Promise<ChessEngineState & { freed?: number }> {
    return this.writeRequest<ChessEngineState & { freed?: number }>("chess_engine_forget", {});
  }

  // ---- the board's own SOUNDS -----------------------------------------------------------
  //
  // chess.com's twelve recordings, which the BACKEND fetches once and serves from this app's own
  // origin (see src/chess_sound.rs): this page never asks chess.com for anything.

  /** Where the recordings stand, and what STARTS the one fetch this feature makes. A READ: it names
   *  no path and publishes nothing about the user. The fetch rides on it because 64 KB is not a
   *  decision to put to a reader — see `Ctx::chess_sound_status` for what bounds it. */
  chessSoundStatus(): Promise<ChessSoundsState> {
    return this.request<ChessSoundsState>("chess_sound_status", {});
  }
  /** Delete them. A WRITE, and it answers with what it freed. */
  chessSoundForget(): Promise<ChessSoundsState & { freed?: number }> {
    return this.writeRequest<ChessSoundsState & { freed?: number }>("chess_sound_forget", {});
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
  // Six methods, and the split between them is the consent design: reading state is
  // open, and every step that rings a person, opens the microphone or hands out the
  // media credentials is a write request. There is nothing here that turns calling on:
  // the backend registers as a device the user's calls ring on at startup, the way every
  // other Teams client they signed in on does. See `./call.ts` and NATIVE-CALLING.md.

  /** Whether this machine can take calls, and what call it is in. A read: it carries
   *  no SDP and no credentials. */
  callStatus(): Promise<CallStatus> {
    return this.request<CallStatus>("call_status", {});
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
      | { meeting: MeetingAddress; subject?: string },
  ): Promise<CallPreparation> {
    const params =
      "conversation" in target
        ? { conversation: target.conversation }
        : "meeting" in target
          ? { ...meetingParams(target.meeting), subject: target.subject }
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
   *  arrive and their microphone is opened to all of them.
   *
   *  The meeting travels in whichever shape the user reached it by — a calendar link, or the
   *  thread out of the chat list — and the backend parses it again. */
  callJoin(
    callId: string,
    meeting: MeetingAddress,
    sdp: string,
  ): Promise<{ call_id: string }> {
    return this.writeRequest<{ call_id: string }>("call_join", {
      call_id: callId,
      ...meetingParams(meeting),
      sdp,
    });
  }
  /** Answer the ringing call with our own SDP. Outward: it opens the user's microphone
   *  to whoever is on the other end. */
  callAccept(callId: string, sdp: string): Promise<{ call_id: string }> {
    return this.writeRequest<{ call_id: string }>("call_accept", { call_id: callId, sdp });
  }
  /**
   * Answer a media offer the service made mid-call.
   *
   * This is how a colleague's camera and a colleague's shared screen arrive: the service
   * renegotiates on its own, its offer already carries the sections, and this posts the
   * answer back (NATIVE-CALLING.md § 10.3a). Outward for what it CAN carry rather than what
   * it usually does — the same method's SDP is what would offer the user's own camera.
   *
   * `modalities` says what the answer really carries; the backend refuses a name that is not
   * one of the four the service knows.
   */
  callAnswerMedia(
    callId: string,
    sdp: string,
    modalities: string[],
  ): Promise<{ call_id: string }> {
    return this.writeRequest<{ call_id: string }>("call_answer_media", {
      call_id: callId,
      sdp,
      modalities,
    });
  }
  /**
   * Ask the meeting's media server to put one person's stream on one of our sections.
   *
   * It publishes nothing about the user — it is a request to RECEIVE — so it is not outward.
   * `sourceId` comes from the roster and `mid` / `streamMsid` from this page's own peer
   * connection, which is why nothing but the caller can assemble one.
   */
  callSubscribe(request: {
    callId: string;
    mid: string;
    sourceId: number;
    streamMsid: string;
    fmtParams?: string;
  }): Promise<{ call_id: string; source_id: number }> {
    return this.writeRequest<{ call_id: string; source_id: number }>("call_subscribe", {
      call_id: request.callId,
      mid: request.mid,
      source_id: request.sourceId,
      stream_msid: request.streamMsid,
      ...(request.fmtParams ? { fmt_params: request.fmtParams } : {}),
    });
  }
  /**
   * OFFER new media on a call that is already up: the user's camera, or their screen.
   *
   * The sharpest calling method after placing a call — it puts their face, or whatever else
   * is on their screen, in front of everybody in the meeting. `sending` says which captures
   * are live so the backend can publish it to every client; `modalities` says what the SDP
   * carries, and a name outside the four the service knows is refused.
   */
  callOfferMedia(
    callId: string,
    sdp: string,
    modalities: string[],
    sending: string[],
  ): Promise<{ call_id: string; answer_sdp: string | null }> {
    return this.writeRequest<{ call_id: string; answer_sdp: string | null }>("call_offer_media", {
      call_id: callId,
      sdp,
      modalities,
      sending,
    });
  }
  /**
   * Ask the meeting to make this endpoint the presenter of its content-sharing session.
   *
   * A meeting shows ONE screen at a time, so a share is a session before it is a track: the
   * service rejects an `applicationsharing-video` section from an endpoint that never asked
   * for one (measured 2026-08-06). Outward, because everybody in the meeting is told that
   * this endpoint is about to show them something.
   */
  callStartSharing(callId: string): Promise<{ call_id: string; can_stop: boolean }> {
    return this.writeRequest<{ call_id: string; can_stop: boolean }>("call_start_sharing", {
      call_id: callId,
    });
  }
  /** Give the sharing session back. Outward for the same reason, and never skipped: a share
   *  this app could start and not stop is one it would not make. */
  callStopSharing(callId: string): Promise<{ call_id: string; told_service: boolean }> {
    return this.writeRequest<{ call_id: string; told_service: boolean }>("call_stop_sharing", {
      call_id: callId,
    });
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
  /** Stop a run this backend is streaming, mid-answer, by the `run_id` its frames carry.
   *
   *  A WRITE request: it kills a program the machine is running for the user (a
   *  `MACHINE_METHODS` entry in src/bin/server.rs, refused read-only). `stopped` is false
   *  when this backend does not own the run — it finished already, or it is streaming on
   *  the other install — which the caller reports rather than pretends away. The reply
   *  itself is finalized with the answer so far by the run's own path, not by this call. */
  agentStop(runId: string): Promise<{ stopped: boolean }> {
    return this.writeRequest<{ stopped: boolean }>("agent_stop", { run_id: runId });
  }
  /** Create or change one of the user's CUSTOM AGENTS (see lib/agent-persona.ts). The name
   *  is the key: an unknown one creates, a known one edits.
   *
   *  A WRITE request: a row here decides what a later `@bebou` does in a thread the user
   *  opted in — which CLI starts, which model reads it, what instruction leads the prompt (a
   *  `MACHINE_METHODS` entry in src/bin/server.rs, refused read-only). Returns the whole
   *  status, like the four setters above, so the pane draws the backend's own answer. */
  agentPersonaSave(patch: AgentPersonaPatch): Promise<AgentStatus> {
    return this.writeRequest<AgentStatus>("agent_persona_save", { ...patch });
  }
  /** Forget one custom agent. `@bebou` is a plain word again from the next message on; a
   *  reply it already posted still draws under its own name, which is read out of that
   *  message's own signature rather than out of this list.
   *
   *  A WRITE request, gated like the save above. */
  agentPersonaRemove(name: string): Promise<AgentStatus> {
    return this.writeRequest<AgentStatus>("agent_persona_remove", { name });
  }
  /** Which conversations this machine seals, and which passphrases it holds for each — by
   *  key id, never a key (see lib/seal.ts).
   *
   *  An open READ, like `get_settings` and for its reason: the answer carries no secret, and
   *  the page needs it before the user has done anything in order to draw a padlock at all. */
  sealStatus(): Promise<SealStatus> {
    return this.request<SealStatus>("seal_status", {});
  }
  /** Seal a conversation under a passphrase — the user's, or one the BACKEND invents when
   *  none is given, which is the only time a passphrase crosses this socket.
   *
   *  A WRITE request: it decides that every message this machine posts to that chat leaves
   *  encrypted, and it writes a secret to the store (a `MACHINE_METHODS` entry in
   *  src/bin/server.rs, refused read-only). Additive on the backend — every key already held
   *  is kept and stops being current — so a rotation costs nothing that is already in the
   *  thread. Answers with the whole fresh status, like the agent setters, plus whether that
   *  passphrase really opens what the thread already holds. */
  sealSet(conversation: string, passphrase?: string): Promise<SealSetResult> {
    // Omitted rather than sent empty: absent is what the backend reads as "generate one", and
    // an empty string is a passphrase it would refuse.
    const params: Record<string, string> = { conversation };
    if (passphrase !== undefined) params.passphrase = passphrase;
    return this.writeRequest<SealSetResult>("seal_set", params);
  }
  /** Stop sealing NEW messages here, and KEEP every key, so the messages already in the
   *  thread stay readable. A WRITE request, gated like the one above.
   *
   *  `stopped` is false when nothing was sealing — which the caller reports rather than
   *  pretends away, the reading `agent_stop` already takes. */
  sealOff(conversation: string): Promise<SealStatus & { stopped: boolean }> {
    return this.writeRequest<SealStatus & { stopped: boolean }>("seal_off", { conversation });
  }
  /** Drop one passphrase. Every message it opened becomes unreadable on this machine FOR
   *  GOOD — the one act in this feature nothing takes back, which is why the UI asks twice.
   *
   *  A WRITE request, gated like the two above. */
  sealForget(
    conversation: string,
    keyId: string,
  ): Promise<SealStatus & { forgotten: boolean }> {
    return this.writeRequest<SealStatus & { forgotten: boolean }>("seal_forget", {
      conversation,
      key_id: keyId,
    });
  }
  /** The passphrase behind one key, for the user's own press and nothing else.
   *
   *  It is what lets somebody who joins the chat in March be GIVEN something without rotating
   *  the whole thread — and it is a WRITE request rather than a read for exactly that reason:
   *  the answer is the secret itself (`MACHINE_METHODS`, refused read-only). */
  sealReveal(conversation: string, keyId: string): Promise<{ passphrase: string }> {
    return this.writeRequest<{ passphrase: string }>("seal_reveal", {
      conversation,
      key_id: keyId,
    });
  }

  /** One custom agent's face, or empty strings when it has none. An open read, and kept out
   *  of the status for the reason emoji art is kept out of the pack: a list is asked for on
   *  every connect and ten faces is megabytes. */
  agentPersonaAvatar(name: string): Promise<{ content_type: string; data_base64: string }> {
    return this.request<{ content_type: string; data_base64: string }>("agent_persona_avatar", {
      name,
    });
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

  /** Fetch one picture a merge request's description or comment points at — a screenshot
   *  somebody pasted, which GitLab keeps as a project upload. It travels through the backend
   *  because GitLab serves an upload to a session or a token and answers a browser 404
   *  (measured), and because nothing on that page may be fetched by the browser at all. The
   *  upload is named by its three parts, never by a URL: the backend spells the endpoint. */
  gitlabUpload(upload: {
    project: string;
    secret: string;
    filename: string;
  }): Promise<{ content_type: string; data_base64: string }> {
    return this.request<{ content_type: string; data_base64: string }>("gitlab_mr_upload", {
      project_path: upload.project,
      secret: upload.secret,
      filename: upload.filename,
    });
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

  // ---- custom emoji --------------------------------------------------------

  /** The user's custom emoji pack, without the art bytes (those are fetched per name
   *  through {@link customEmojiImage}). */
  customEmoji(): Promise<{ emoji: CustomEmoji[] }> {
    return this.request<{ emoji: CustomEmoji[] }>("custom_emoji");
  }

  /** The art for one custom emoji, or empty strings when there is none. */
  customEmojiImage(name: string): Promise<{ content_type: string; data_base64: string }> {
    return this.request<{ content_type: string; data_base64: string }>("custom_emoji_image", {
      name,
    });
  }

  /** The pack with its art, for export. */
  customEmojiExport(): Promise<{
    emoji: Array<{
      name: string;
      alias_of: string;
      content_type: string;
      data_base64: string;
      width: number;
      height: number;
    }>;
  }> {
    return this.request("custom_emoji_export");
  }

  /** Add one emoji to the pack. Exactly one of `alias_of`, `url`, `media_url` or
   *  `data_base64` must be present. Returns `{ added: true }` on success, or throws
   *  with the backend's own reason. */
  customEmojiAdd(params: {
    name: string;
    alias_of?: string;
    data_base64?: string;
    url?: string;
    media_url?: string;
    source: string;
  }): Promise<{ added: boolean }> {
    return this.writeRequest<{ added: boolean }>("custom_emoji_add", params);
  }

  /** Remove one emoji from the pack. Returns `{ removed: true }` when it existed,
   *  `false` when it was already gone. */
  customEmojiRemove(name: string): Promise<{ removed: boolean }> {
    return this.writeRequest<{ removed: boolean }>("custom_emoji_remove", { name });
  }

  /** Import a pack of emoji, adding all that pass. Returns the count added. */
  customEmojiImport(emoji: Array<{
    name: string;
    alias_of: string;
    content_type: string;
    data_base64: string;
    width: number;
    height: number;
  }>): Promise<{ added: number }> {
    return this.writeRequest<{ added: number }>("custom_emoji_import", { emoji });
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
  /** Read the Linear workspace this machine's key belongs to: how its issues are addressed,
   *  and which team keys an identifier can really name (see lib/tracker-ref.ts).
   *
   *  A read, so it needs no write token — it carries no key, only what a reader needs to turn
   *  `STMN-3439` into a link. The backend caches it for hours, so asking on every connect
   *  costs no request. */
  linearWorkspace(): Promise<LinearWorkspaceResult> {
    return this.request<LinearWorkspaceResult>("linear_workspace");
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
    if (patch.emojiAutoImport !== undefined) params.emoji_auto_import = patch.emojiAutoImport;
    if (patch.sealedPushWords !== undefined) params.sealed_push_words = patch.sealedPushWords;
    return this.writeRequest<AppSettings>("set_settings", params);
  }
  /** Turn "Always available" on or off — and say which HOURS it keeps — which publishes
   *  the user's OWN presence: inside those hours the backend registers this machine as an
   *  endpoint reporting Available (and refreshes it on a heartbeat), outside them it
   *  removes that registration and hands the status back to whatever Teams computes.
   *
   *  `schedule.hours` is both ends or `null` for all day, and `schedule.zone` is an IANA name
   *  or `null` for the backend machine's own; the backend refuses a half window and a zone it
   *  cannot resolve. What
   *  it publishes is what the pair says about the minute the call arrives, so turning the
   *  setting on at 03:00 with 08:00-19:00 set changes nothing visible until the morning.
   *
   *  Its own call rather than a `setSettings` field, because it is outward — every
   *  colleague reads the green dot — so it is gated like a send and a read-only
   *  backend refuses it (see OUTWARD_METHODS in src/bin/server.rs). Returns the fresh
   *  settings view, so the switch only moves once Teams was actually told. */
  setAlwaysAvailable(enabled: boolean, schedule: PresenceSchedule): Promise<AppSettings> {
    return this.writeRequest<AppSettings>("set_always_available", {
      enabled,
      from: schedule.hours?.from ?? null,
      to: schedule.hours?.to ?? null,
      zone: schedule.zone,
    });
  }
  /** Enrich a tracker link with metadata for a rich preview card. Resolves with
   *  `{ metadata: null }` when no integration recognizes the link (or the resource
   *  is private); rejects only on a transient backend/network failure. */
  enrichLink(url: string): Promise<LinkMetadataResult> {
    return this.request<LinkMetadataResult>("enrich_link", { url });
  }
  /** Who has approved a merge request, and whether the user's own approval is among
   *  them. A READ, so it is ungated like `enrichLink`: it is what lets a message's own
   *  menu offer the right half of the toggle rather than guessing. Resolves with
   *  `{ approval: null }` when the link is not a merge request on the configured host,
   *  or the token cannot see it. */
  gitlabApprovals(url: string): Promise<GitLabApprovalResult> {
    return this.request<GitLabApprovalResult>("gitlab_approvals", { url });
  }
  /** Give the user's own approval to a merge request, or take it back.
   *
   *  THE one write this app makes to a tracker (see src/gitlab_approval.rs): it acts
   *  under their GitLab account, everybody watching the merge request is told, and a
   *  project rule may act on it. So it is gated like a send and a read-only backend
   *  refuses it (OUTWARD_METHODS in src/bin/server.rs) — and it exists only because
   *  `approved: false` is GitLab's own undo of `approved: true`. Returns the state
   *  GitLab reports afterwards, so the menu shows what really happened. */
  gitlabSetApproval(url: string, approved: boolean): Promise<GitLabApprovalResult> {
    return this.writeRequest<GitLabApprovalResult>("gitlab_set_approval", { url, approved });
  }

  // ---- the merge-request page ---------------------------------------------
  //
  // Five reads and four writes, and the split is the whole safety story of the page:
  // reading a tracker is what it is for, and writing to one is the user's own click.
  //
  // Every read answers from the backend's durable cache first and refreshes behind the
  // page (see `gitlab_cached` in src/bin/server.rs), so none of these is slow twice — and
  // the fresh copy arrives as a `gitlab_list_updated` / `gitlab_mr_updated` event rather
  // than by asking again. `refresh: true` is the user's own Reload: it waits for GitLab.

  /** The merge requests that are NOT merged. `scope` and `state` are closed sets on the
   *  backend, which is what stops this page ever asking for merged ones. */
  gitlabMergeRequests(
    scope: MergeRequestScope,
    state: MergeRequestState,
    refresh = false,
  ): Promise<MergeRequestList> {
    return this.request<MergeRequestList>("gitlab_mr_list", { scope, state, refresh });
  }

  /** One merge request in full. */
  gitlabMergeRequest(
    key: MergeRequestKey,
    refresh = false,
  ): Promise<MergeRequestDetail> {
    return this.request<MergeRequestDetail>("gitlab_mr_detail", {
      project_path: key.projectPath,
      iid: key.iid,
      refresh,
    });
  }

  /** Its comment thread — discussions in GitLab's own order, each note saying whether the
   *  user themselves wrote it. */
  gitlabMergeRequestNotes(
    key: MergeRequestKey,
    refresh = false,
  ): Promise<GitLabDiscussionList> {
    return this.request<GitLabDiscussionList>("gitlab_mr_notes", {
      project_path: key.projectPath,
      iid: key.iid,
      refresh,
    });
  }

  /** Its head pipeline and jobs. THE live read: the page repeats it while CI runs, and the
   *  backend's own window is seconds, so two open pages cost one request between them. */
  gitlabMergeRequestPipeline(
    key: MergeRequestKey,
    refresh = false,
  ): Promise<GitLabPipelineView> {
    return this.request<GitLabPipelineView>("gitlab_mr_pipeline", {
      project_path: key.projectPath,
      iid: key.iid,
      refresh,
    });
  }

  /** ONE job's log, for the page a job card opens.
   *
   *  The biggest read on this surface (up to 1 MiB) and the one whose freshness swings widest:
   *  the backend polls it like the pipeline while the job runs, and caches it for a day the
   *  moment the job stops — because a finished job's log never changes again, and a retry is a
   *  new job with a new id. Nothing here says which of the two it is: the ANSWER does (see
   *  `GitLabTtl` in src/bin/server.rs), so a page cannot ask for the wrong one. */
  gitlabJobLog(
    key: MergeRequestKey,
    jobId: number,
    refresh = false,
  ): Promise<GitLabJobLog> {
    return this.request<GitLabJobLog>("gitlab_mr_job_log", {
      project_path: key.projectPath,
      iid: key.iid,
      job_id: jobId,
      refresh,
    });
  }

  /** What the merge request CHANGED, for the Changes section.
   *
   *  `depth` picks between the two reads GitLab offers, and the difference is measured
   *  (`examples/merge_request_diff_recon.rs`): `listed` is one page of the modern `/diffs`
   *  endpoint and carries whatever GitLab chose to expand, `raw` is the older
   *  `/changes?access_raw_diffs=true` and expands everything at half a megabyte on a large
   *  merge request. So `listed` is what opening the section costs and `raw` is the reader's
   *  own ask — see `canExpandDiff` in lib/gitlab-diff.ts. Both are closed names on the
   *  backend, so this can never widen into a third endpoint. */
  gitlabMergeRequestDiff(
    key: MergeRequestKey,
    depth: DiffDepth = "listed",
    refresh = false,
  ): Promise<GitLabDiff> {
    return this.request<GitLabDiff>("gitlab_mr_diff", {
      project_path: key.projectPath,
      iid: key.iid,
      depth,
      refresh,
    });
  }

  /** MERGE the branch.
   *
   *  The one write in this app that no later call takes back, which is why `sha` is
   *  required: it is the head commit the PAGE drew, and GitLab refuses a merge whose sha is
   *  not the branch's head — so a merge request that moved since the reader looked is
   *  refused rather than landed. Gated like a send (OUTWARD_METHODS in src/bin/server.rs),
   *  and the UI asks for a second explicit confirmation before it calls. */
  gitlabMerge(
    key: MergeRequestKey,
    options: { sha: string; squash: boolean; removeSourceBranch?: boolean },
  ): Promise<{ merge: MergeOutcome }> {
    return this.writeRequest<{ merge: MergeOutcome }>("gitlab_mr_merge", {
      project_path: key.projectPath,
      iid: key.iid,
      sha: options.sha,
      squash: options.squash,
      ...(options.removeSourceBranch === undefined
        ? {}
        : { remove_source_branch: options.removeSourceBranch }),
    });
  }

  /** Comment on it — a new comment, a reply into the thread `discussionId` names, or a new
   *  thread on the DIFF LINE `position` names.
   *
   *  Everybody watching the merge request is told, under the user's own name, so it is
   *  gated like a send and only ever called from their own Enter. The position travels as
   *  primitives — a file, two line numbers and a side — because the BACKEND spells GitLab's
   *  own shape and computes the line codes inside it (see `gitlab_diff_anchor` in
   *  src/bin/server.rs): nothing here can hand GitLab a field this app does not know it is
   *  sending. */
  gitlabComment(
    key: MergeRequestKey,
    body: string,
    discussionId?: string,
    position?: WireDiffPosition,
  ): Promise<{ note: PostedNote }> {
    return this.writeRequest<{ note: PostedNote }>("gitlab_mr_comment", {
      project_path: key.projectPath,
      iid: key.iid,
      body,
      ...(discussionId ? { discussion_id: discussionId } : {}),
      ...(position ? { position } : {}),
    });
  }

  /** Rewrite one of the user's OWN comments.
   *
   *  The backend re-reads whose note it is before it writes, exactly as the deletion does. It
   *  is not fully reversible — an edit can be edited back, but the words that were there are
   *  gone — which is where a Teams message edit sits, so it is offered the same way. */
  gitlabEditComment(
    key: MergeRequestKey,
    noteId: number,
    body: string,
  ): Promise<{ note: PostedNote }> {
    return this.writeRequest<{ note: PostedNote }>("gitlab_mr_edit_comment", {
      project_path: key.projectPath,
      iid: key.iid,
      note_id: noteId,
      body,
    });
  }

  /** Resolve one thread, or open it again — each direction the other's undo.
   *
   *  What comes back is what GITLAB says the thread is now, never an echo of the ask: a
   *  thread whose notes cannot be resolved can answer 200 and change nothing. */
  gitlabResolveThread(
    key: MergeRequestKey,
    discussionId: string,
    resolved: boolean,
  ): Promise<{ discussion_id: string; resolved: boolean }> {
    return this.writeRequest<{ discussion_id: string; resolved: boolean }>(
      "gitlab_mr_resolve_thread",
      {
        project_path: key.projectPath,
        iid: key.iid,
        discussion_id: discussionId,
        resolved,
      },
    );
  }

  /** Delete one of the user's OWN comments — the undo that makes the comment above
   *  acceptable. The backend re-reads whose note it is before it deletes, so a colleague's
   *  comment is refused there rather than trusted from here. */
  gitlabDeleteComment(key: MergeRequestKey, noteId: number): Promise<{ deleted: number }> {
    return this.writeRequest<{ deleted: number }>("gitlab_mr_delete_comment", {
      project_path: key.projectPath,
      iid: key.iid,
      note_id: noteId,
    });
  }

  /** Close it, or reopen it. Each direction is the other's undo. */
  gitlabSetMergeRequestState(
    key: MergeRequestKey,
    change: "close" | "reopen",
  ): Promise<{ state: string }> {
    return this.writeRequest<{ state: string }>("gitlab_mr_set_state", {
      project_path: key.projectPath,
      iid: key.iid,
      change,
    });
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
