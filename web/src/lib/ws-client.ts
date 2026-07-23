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
  Conversation,
  LinkMetadataResult,
  MessagePage,
  NotificationFeed,
  ReplyTo,
} from "./protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type EventHandler = (data: unknown) => void;

/** Default backend URL. Overridable via VITE_TEAMS_WS_URL for dev/mock setups. */
export const DEFAULT_WS_URL =
  (import.meta.env?.VITE_TEAMS_WS_URL as string | undefined) ?? "ws://127.0.0.1:8420";

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
  private firstFailureAt: number | null = null;
  private readonly giveUpMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(url: string = DEFAULT_WS_URL, opts: BackendOptions = {}) {
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
      onOpen?.();
    };
    ws.onerror = (e) => {
      if (!settled) {
        settled = true;
        onFail?.(e);
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

  // ---- typed API ----------------------------------------------------------

  conversations(): Promise<Conversation[]> {
    return this.request<Conversation[]>("conversations");
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
    return this.request<{ sent: boolean }>("send", {
      conversation,
      text,
      reply_to: replyTo,
      content_html: contentHtml,
    });
  }
  edit(conversation: string, messageId: string, text: string): Promise<{ edited: boolean }> {
    return this.request<{ edited: boolean }>("edit", { conversation, message_id: messageId, text });
  }
  /** React to a message with an emoji (Teams "emotion"), or toggle ours off.
   *  `key` is the emotion (e.g. "like", "heart"). The backend toggles — clicking
   *  our current reaction removes it — and re-broadcasts the message, so state
   *  reconciles via the `message` event; `reacted` is the resulting on/off. */
  react(conversation: string, messageId: string, key: string): Promise<{ reacted: boolean }> {
    return this.request<{ reacted: boolean }>("react", {
      conversation,
      message_id: messageId,
      key,
    });
  }
  /** Fetch the activity feed (reactions/mentions/replies directed at us). Not a
   *  chat — the backend fetches it fresh from Teams and decodes each entry. */
  notifications(limit?: number): Promise<NotificationFeed> {
    return this.request<NotificationFeed>("notifications", limit ? { limit } : {});
  }
  /** Fetch one hosted-content media object (inline image or shared file) through
   *  the backend, which attaches the session credentials the browser lacks. The
   *  bytes come back base64-encoded so they ride the same JSON WebSocket. */
  fetchMedia(url: string): Promise<{ content_type: string; data_base64: string }> {
    return this.request<{ content_type: string; data_base64: string }>("fetch_media", { url });
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
