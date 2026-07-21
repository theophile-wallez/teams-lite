// WebSocket client to the teams-lite Rust backend.
//
// Protocol (see src/bin/server.rs):
//   request  -> { id, method, params }
//   response <- { id, result } | { id, error }
//   event    <- { event, data }        (no id, server push)
//
// The UI only talks to the backend through this — it never touches the network
// or the SQLite store directly (local-first is enforced server-side).

// Mirrors the Rust `ConversationKind` (see src/store.rs). "unknown" is the safe
// fallback for legacy rows or a chat type the backend doesn't map yet.
export type ConversationKind = "one_on_one" | "group" | "notes" | "unknown";

export type Conversation = {
  id: string;
  name: string;
  last_message_time: number;
  kind: ConversationKind;
  // Sidebar-fidelity fields, sourced from the CSA `users/me` sync (see
  // src/teams_read.rs). The preview is already HTML-stripped server-side.
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

export type ChatMessage = {
  id: string;
  conversation_id: string;
  seq: number;
  compose_time: number;
  sender: string;
  content: string;
  is_self?: boolean;
};

export type MessagePage = {
  messages: ChatMessage[];
  has_more: boolean;
};

// Payload of the server-pushed "update_available" event: a newer rolling build
// exists. `current`/`latest` are short commit SHAs; `url` is the release page.
export type UpdateInfo = {
  current: string;
  latest: string;
  url: string;
};

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };
type EventHandler = (data: any) => void;

const DEFAULT_URL = "ws://127.0.0.1:8420";

// After this long of *continuous* connection failure we stop retrying and
// declare the backend lost. Bounding this is critical: an unbounded reconnect
// loop keeps the event loop alive forever, so a UI whose backend died (or whose
// terminal was closed) would never exit — it would linger as a background CPU
// spinner. Once we give up there are no timers left, so the process can drain
// and exit (e.g. after OpenTUI's signal-triggered destroy).
const RECONNECT_GIVE_UP_MS = 30_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_INITIAL_DELAY_MS = 500;

/// Tunables for the reconnect policy. Defaults suit production; tests inject
/// tiny values to exercise the give-up path quickly.
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
  private reconnecting = false; // single-flight guard: only one reconnect chain
  private closed = false; // close() called — stop all activity
  private firstFailureAt: number | null = null; // start of the current failure streak
  private readonly giveUpMs: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(url = DEFAULT_URL, opts: BackendOptions = {}) {
    this.url = url;
    this.giveUpMs = opts.giveUpMs ?? RECONNECT_GIVE_UP_MS;
    this.initialDelayMs = opts.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    this.reconnectDelay = this.initialDelayMs;
  }

  /// Connect and keep the connection alive (auto-reconnect with capped backoff).
  /// The returned promise resolves on the first successful open and rejects on
  /// the first failure; background reconnection continues regardless.
  connect(): Promise<void> {
    return new Promise((resolve, reject) => this.openSocket(resolve, reject));
  }

  /// Stop everything: cancel any pending reconnect, drop the socket, and fail
  /// outstanding requests. After this the instance is inert (no timers), so the
  /// process can exit. Idempotent.
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

  /// Open a fresh socket. `onOpen`/`onFail` are only used for the initial
  /// connect() promise; reconnects pass neither.
  private openSocket(onOpen?: () => void, onFail?: (e: unknown) => void): void {
    if (this.closed) return;
    // Drop any previous socket's handlers first so old closures can't fire or
    // leak — this is what kept a dead-backend UI spinning and growing in RAM.
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
      // fail all pending, then try to reconnect (bounded)
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      this.emit("disconnected", {});
      this.scheduleReconnect();
    };
    ws.onmessage = (m) => this.onMessage(String(m.data));
  }

  /// Detach and close the current socket without leaving live handlers behind.
  private teardownSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {}
    this.ws = null;
  }

  /// Schedule a single reconnect attempt with capped exponential backoff. Gives
  /// up (and emits `backend_lost`) after RECONNECT_GIVE_UP_MS of continuous
  /// failure so we never spin forever against a dead backend.
  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    if (this.firstFailureAt === null) this.firstFailureAt = Date.now();

    if (Date.now() - this.firstFailureAt >= this.giveUpMs) {
      // Stop retrying — leave no timers so the process can exit.
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
    let msg: any;
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

  private request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("not connected"));
      }
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 30000);
    });
  }

  // ---- typed API ----------------------------------------------------------

  conversations(): Promise<Conversation[]> {
    return this.request<Conversation[]>("conversations");
  }
  open(conversation: string): Promise<MessagePage> {
    return this.request("open", { conversation });
  }
  backfill(conversation: string, beforeSeq: number): Promise<MessagePage> {
    return this.request("backfill", { conversation, before_seq: beforeSeq });
  }
  setDraft(conversation: string, text: string): Promise<{ saved: boolean }> {
    return this.request("set_draft", { conversation, text });
  }
  send(conversation: string, text: string): Promise<{ sent: boolean }> {
    return this.request("send", { conversation, text });
  }

  // ---- events -------------------------------------------------------------

  /// Subscribe to an event. Server-pushed: "message", "status",
  /// "conversations_changed", "realtime_status", "update_available". Client-side
  /// connection state: "disconnected" (each drop) and "backend_lost" (retries
  /// exhausted — fatal). Returns an unsubscribe function.
  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: any) {
    this.handlers.get(event)?.forEach((h) => h(data));
  }
}
