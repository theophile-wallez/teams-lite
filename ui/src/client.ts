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

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };
type EventHandler = (data: any) => void;

const DEFAULT_URL = "ws://127.0.0.1:8420";

export class Backend {
  private ws: WebSocket | null = null;
  private url: string;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<EventHandler>>();
  private reconnectDelay = 500;

  constructor(url = DEFAULT_URL) {
    this.url = url;
  }

  /// Connect and keep the connection alive (auto-reconnect with backoff).
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        this.reconnectDelay = 500;
        settled = true;
        resolve();
      };
      ws.onerror = (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      ws.onclose = () => {
        // fail all pending, then try to reconnect
        for (const p of this.pending.values()) p.reject(new Error("connection closed"));
        this.pending.clear();
        this.emit("disconnected", {});
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
          this.connect().catch(() => {});
        }, this.reconnectDelay);
      };
      ws.onmessage = (m) => this.onMessage(String(m.data));
    });
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
  open(conversation: string): Promise<{ messages: ChatMessage[] }> {
    return this.request("open", { conversation });
  }
  backfill(conversation: string): Promise<{ messages: ChatMessage[] }> {
    return this.request("backfill", { conversation });
  }
  send(conversation: string, text: string): Promise<{ sent: boolean }> {
    return this.request("send", { conversation, text });
  }

  // ---- events -------------------------------------------------------------

  /// Subscribe to a server event ("message", "status", "conversations_changed",
  /// "realtime_status", "disconnected"). Returns an unsubscribe function.
  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data: any) {
    this.handlers.get(event)?.forEach((h) => h(data));
  }
}
