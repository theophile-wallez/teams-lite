// Browser WebSocket client to the teams-lite Rust backend.
//
// Ported from ui/src/client.ts (the terminal UI's client) with the same wire
// protocol and reconnect policy. The only differences: it targets the browser
// `WebSocket` global and is safe to construct during SSR (it only opens a socket
// when connect() is called on the client).
//
//   request  -> { id, method, params }
//   response <- { id, result } | { id, error }
//   event    <- { event, data }        (server push)

import type {
  AppSettings,
  Channel,
  Conversation,
  LinkMetadataResult,
  MailBody as MailBodyResult,
  MailFolder,
  MailPage,
  MessagePage,
  NotificationFeeds,
  PersonProfile,
  PresenceResult,
  ReadReceiptsResult,
  ReplyTo,
} from "./protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type EventHandler = (data: unknown) => void;

/** Where a production build looks for the local Rust backend. */
const PRODUCTION_WS_URL = "ws://127.0.0.1:8420";

/**
 * The backend URL to use when a caller does not name one.
 *
 * In a production build this is the local Rust backend — the whole point of
 * `teams --web`. In DEV there is deliberately **no default**: a dev server must
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
 * Resolved lazily (a function, not a module constant) so importing this module
 * stays side-effect-free — unit tests construct `Backend` with an explicit URL
 * and must not need the variable at all.
 */
export function defaultWsUrl(): string {
  const configured = (import.meta.env?.VITE_TEAMS_WS_URL as string | undefined)?.trim();
  if (configured) return configured;
  if (import.meta.env?.DEV) {
    throw new Error(
      "VITE_TEAMS_WS_URL is not set. A dev server must name its backend explicitly — " +
        "there is no default in dev, so that nothing can reach the real Teams account by " +
        `accident. Use the mock (bun run dev:mock, or VITE_TEAMS_WS_URL=ws://127.0.0.1:8455) ` +
        `for anything automated; pass VITE_TEAMS_WS_URL=${PRODUCTION_WS_URL} only for hands-on ` +
        "work against your own account.",
    );
  }
  return PRODUCTION_WS_URL;
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
  ): Promise<{ sent: boolean }> {
    return this.writeRequest<{ sent: boolean }>("send", {
      conversation,
      text,
      reply_to: replyTo,
      content_html: contentHtml,
    });
  }
  edit(conversation: string, messageId: string, text: string): Promise<{ edited: boolean }> {
    return this.writeRequest<{ edited: boolean }>("edit", {
      conversation,
      message_id: messageId,
      text,
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

  /** Fetch one person's directory card — name, job title, department, email, work
   *  location — for the card shown on hovering their name. `found` is false when
   *  the directory knows nobody by this MRI, so the caller keeps the name it has.
   *  Only person MRIs are accepted; the backend refuses a channel/team MRI. */
  profile(mri: string): Promise<PersonProfile> {
    return this.request<PersonProfile>("profile", { mri });
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
  // Every method here is a READ, so none uses `writeRequest`: the write token
  // exists to gate acts that other people see, and the mail surface has none. The
  // backend cannot send, reply to, delete or move a mail — the capability is absent
  // from the crate, not merely ungranted (see src/mail.rs).

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

  /** Read the non-secret app settings (GitLab host + whether a token is stored). */
  getSettings(): Promise<AppSettings> {
    return this.request<AppSettings>("get_settings");
  }
  /** Persist app settings (partial). Omit a field to leave it unchanged; pass
   *  `gitlabToken: ""` to clear the stored token. Returns the fresh non-secret
   *  view so the caller updates in one round-trip. */
  setSettings(patch: { gitlabHost?: string; gitlabToken?: string }): Promise<AppSettings> {
    const params: Record<string, string> = {};
    if (patch.gitlabHost !== undefined) params.gitlab_host = patch.gitlabHost;
    if (patch.gitlabToken !== undefined) params.gitlab_token = patch.gitlabToken;
    return this.request<AppSettings>("set_settings", params);
  }
  /** Enrich a GitLab link with metadata for a rich preview card. Resolves with
   *  `{ metadata: null }` when the link is not an enrichable GitLab resource (or
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
