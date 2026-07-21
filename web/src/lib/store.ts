// teams-lite web — application store + controller.
//
// The controller owns the backend WebSocket client and mirrors the terminal
// UI's business logic (ui/src/app.tsx): local-first opens with a per-session
// message cache, coalesced conversation refreshes, durable drafts, live-message
// fan-in, and infinite history. React components stay dumb: they read fine-
// grained slices from the TanStack Store and call controller methods.
//
// State lives in a TanStack Store so components subscribe to just the slice they
// use (selector-based), which keeps re-renders cheap under a stream of live
// messages. Non-reactive caches (per-conversation messages, drafts, timers) are
// plain fields — they must not trigger renders on their own.

import { Store } from "@tanstack/store";
import { Backend, DEFAULT_WS_URL } from "./ws-client";
import {
  appendLiveMessage,
  mergeOlderHistoryPage,
  mergeRefreshedHistoryPage,
  replyToPayload,
  shouldNotify,
  type ChatMessage,
  type Conversation,
  type LiveStatus,
  type MessagePage,
  type ReplyTo,
  type UpdateInfo,
} from "./protocol";
import { coalesce } from "./singleflight";
import { ensureNotificationPermission, notifyMessage } from "./notify";
import { DEFAULT_THEME_ID, isThemeId } from "./theme-list.gen";

export type PendingReply = { message: ChatMessage; marker: string | null };

export type AppState = {
  conversations: Conversation[];
  openId: string | null;
  messages: ChatMessage[];
  loadingMessages: boolean;
  loadingOlder: boolean;
  hasMoreOlder: boolean;
  olderError: string | null;
  messagesError: string | null;
  status: string;
  live: LiveStatus;
  ready: boolean;
  splashMessage: string;
  fatal: string | null;
  update: UpdateInfo | null;
  draft: string;
  replyingTo: PendingReply | null;
  themeId: string;
};

const THEME_STORAGE_KEY = "teams-theme";
const DRAFT_SAVE_DELAY_MS = 150;

function initialState(): AppState {
  return {
    conversations: [],
    openId: null,
    messages: [],
    loadingMessages: false,
    loadingOlder: false,
    hasMoreOlder: false,
    olderError: null,
    messagesError: null,
    status: "connecting…",
    live: "connecting",
    ready: false,
    splashMessage: "connecting",
    fatal: null,
    update: null,
    draft: "",
    replyingTo: null,
    themeId: DEFAULT_THEME_ID,
  };
}

export class TeamsController {
  readonly store = new Store<AppState>(initialState());
  private backend: Backend;
  private started = false;
  private disposers: Array<() => void> = [];

  // Per-conversation message cache: re-opening a conversation is instant and
  // stays current as live/refresh events reconcile into it.
  private messageCache = new Map<string, MessagePage>();
  // Warm draft cache keyed by conversation (SQLite remains the durable source).
  private draftCache = new Map<string, string>();
  private draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private refreshConversations = coalesce(() => this.loadConversations());

  constructor(url: string = DEFAULT_WS_URL) {
    this.backend = new Backend(url);
  }

  private set(patch: Partial<AppState>): void {
    this.store.setState((s) => ({ ...s, ...patch }));
  }
  private get(): AppState {
    return this.store.state;
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.applyPersistedTheme();
    this.wireEvents();

    try {
      this.set({ splashMessage: "connecting" });
      await this.backend.connect();
      this.set({ live: "connected" });
      await this.refreshConversations();
      this.set({ ready: true });
    } catch (e) {
      const msg = errText(e);
      this.set({
        status: `backend unreachable — ${msg}`,
        splashMessage: `failed: ${msg}`,
        live: "disconnected",
      });
      // Reveal the (empty) UI anyway after a beat so the error is visible.
      setTimeout(() => this.set({ ready: true }), 2500);
    }
    // Best-effort: ask for notification permission after connect (a user
    // gesture may be required; the browser handles that).
    void ensureNotificationPermission();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    for (const t of this.draftSaveTimers.values()) clearTimeout(t);
    this.draftSaveTimers.clear();
    this.backend.close();
    this.started = false;
  }

  private wireEvents(): void {
    const on = (event: string, handler: (data: unknown) => void) => {
      this.disposers.push(this.backend.on(event, handler));
    };

    on("message", (raw) => {
      const m = raw as ChatMessage;
      const cached = this.messageCache.get(m.conversation_id);
      this.messageCache.set(m.conversation_id, appendLiveMessage(cached, m));
      if (m.conversation_id === this.get().openId) {
        this.set({
          messages: this.messageCache.get(m.conversation_id)!.messages,
        });
      } else if (shouldNotify(m, this.get().openId)) {
        notifyMessage(m.sender, m.content);
      }
      void this.refreshConversations();
    });

    on("messages_updated", (raw) => {
      const d = raw as { conversation: string; messages: ChatMessage[]; has_more: boolean };
      const history = mergeRefreshedHistoryPage(this.messageCache.get(d.conversation), d);
      this.messageCache.set(d.conversation, history);
      if (d.conversation === this.get().openId) {
        this.set({
          messages: history.messages,
          hasMoreOlder: history.has_more,
          messagesError: null,
          loadingMessages: false,
        });
      }
    });

    on("messages_error", (raw) => {
      const d = raw as { conversation: string; error: string };
      if (d.conversation === this.get().openId) {
        this.set({ messagesError: d.error || "Couldn't load messages", loadingMessages: false });
      }
    });

    on("conversations_changed", () => void this.refreshConversations());
    on("realtime_status", (s) => this.set({ live: s as LiveStatus }));
    on("update_available", (u) => this.set({ update: u as UpdateInfo }));
    on("disconnected", () => this.set({ live: "disconnected" }));
    on("backend_lost", () =>
      this.set({
        live: "disconnected",
        fatal: "Backend lost — the teams-lite server is no longer reachable.",
        status: "backend lost — retries exhausted",
      }),
    );
  }

  // ---- conversations -------------------------------------------------------

  private async loadConversations(): Promise<void> {
    try {
      const convs = await this.backend.conversations();
      for (const conv of convs) {
        if (!this.draftCache.has(conv.id)) this.draftCache.set(conv.id, conv.draft);
      }
      this.set({ conversations: convs, status: `${convs.length} conversations` });
    } catch (e) {
      this.set({ status: `error: ${errText(e)}` });
    }
  }

  async openConversation(id: string): Promise<void> {
    const previousId = this.get().openId;
    if (previousId && previousId !== id) this.flushDraft(previousId);

    const nextDraft =
      this.draftCache.get(id) ??
      this.get().conversations.find((c) => c.id === id)?.draft ??
      "";
    this.draftCache.set(id, nextDraft);

    const cached = this.messageCache.get(id);
    this.set({
      openId: id,
      replyingTo: null,
      messagesError: null,
      olderError: null,
      loadingOlder: false,
      draft: nextDraft,
      messages: cached?.messages ?? [],
      hasMoreOlder: cached?.has_more ?? false,
      loadingMessages: !cached,
    });

    try {
      const res = await this.backend.open(id);
      const history = mergeRefreshedHistoryPage(this.messageCache.get(id), res);
      this.messageCache.set(id, history);
      if (this.get().openId === id) {
        this.set({ messages: history.messages, hasMoreOlder: history.has_more });
      }
    } catch (e) {
      if (this.get().openId === id && !cached) this.set({ messagesError: errText(e) });
      this.set({ status: `open error: ${errText(e)}` });
    } finally {
      if (this.get().openId === id) this.set({ loadingMessages: false });
    }
  }

  closeConversation(): void {
    const id = this.get().openId;
    if (id) this.flushDraft(id);
    this.set({ openId: null, replyingTo: null });
  }

  async loadOlderMessages(): Promise<void> {
    const conversation = this.get().openId;
    if (!conversation) return;
    const s = this.get();
    if (s.loadingOlder || !s.hasMoreOlder) return;
    const oldest = s.messages[0];
    if (!oldest) return;

    this.set({ loadingOlder: true, olderError: null });
    try {
      const page = await this.backend.backfill(conversation, oldest.seq);
      if (this.get().openId !== conversation) return;
      const history = mergeOlderHistoryPage(this.messageCache.get(conversation), page);
      this.messageCache.set(conversation, history);
      this.set({ messages: history.messages, hasMoreOlder: history.has_more });
    } catch (e) {
      if (this.get().openId === conversation) {
        this.set({ olderError: errText(e), status: `history error: ${errText(e)}` });
      }
    } finally {
      if (this.get().openId === conversation) this.set({ loadingOlder: false });
    }
  }

  // ---- composer + drafts ---------------------------------------------------

  setDraftText(text: string): void {
    this.set({ draft: text });
    const id = this.get().openId;
    if (!id) return;
    this.draftCache.set(id, text);
    this.scheduleDraftSave(id, text);
  }

  private persistDraft(id: string, text: string): void {
    void this.backend.setDraft(id, text).catch((e) => {
      if (this.draftCache.get(id) === text) this.set({ status: `draft save failed: ${errText(e)}` });
    });
  }

  private scheduleDraftSave(id: string, text: string): void {
    const pending = this.draftSaveTimers.get(id);
    if (pending) clearTimeout(pending);
    this.draftSaveTimers.set(
      id,
      setTimeout(() => {
        this.draftSaveTimers.delete(id);
        this.persistDraft(id, text);
      }, DRAFT_SAVE_DELAY_MS),
    );
  }

  private flushDraft(id: string): void {
    const pending = this.draftSaveTimers.get(id);
    if (!pending) return;
    clearTimeout(pending);
    this.draftSaveTimers.delete(id);
    this.persistDraft(id, this.draftCache.get(id) ?? "");
  }

  startReply(message: ChatMessage): void {
    this.set({ replyingTo: { message, marker: null } });
  }

  /** Set the status-bar text (transient feedback such as "Copied"). */
  setStatus(text: string): void {
    this.set({ status: text });
  }

  cancelReply(): void {
    this.set({ replyingTo: null });
  }

  /**
   * Edit one of our own messages in place. The backend replaces the message
   * over the network and broadcasts the new content as a live `message` event,
   * which reconciles into the cache by id (see `wireEvents`), so we only need to
   * fire the request and surface failures.
   */
  async editMessage(messageId: string, text: string): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    const clean = text.trim();
    if (!clean) return false;
    try {
      await this.backend.edit(id, messageId, clean);
      return true;
    } catch (e) {
      this.set({ status: `edit failed: ${errText(e)}` });
      return false;
    }
  }

  async sendDraft(text: string): Promise<void> {
    const id = this.get().openId;
    if (!id) return;
    const clean = text.trim();
    if (!clean) return;

    // When replying, the backend builds the outgoing HTML as
    // paragraph(before) + quote + paragraph(after) and ignores the plain `text`
    // (see src/teams_send.rs). So the composed reply body goes into `after`.
    const reply = this.get().replyingTo;
    const replyTo: ReplyTo | undefined = reply
      ? replyToPayload(reply.message, "", clean)
      : undefined;

    const pending = this.draftSaveTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      this.draftSaveTimers.delete(id);
    }

    try {
      await this.backend.setDraft(id, "");
      await this.backend.send(id, clean, replyTo);
    } catch (e) {
      this.set({ status: `send failed: ${errText(e)}` });
      return;
    }

    this.draftCache.set(id, "");
    if (this.get().openId === id) this.set({ draft: "", replyingTo: null });
    this.persistDraft(id, "");
  }

  // ---- theme ---------------------------------------------------------------

  private applyPersistedTheme(): void {
    if (typeof document === "undefined") return;
    let id = DEFAULT_THEME_ID;
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemeId(stored)) id = stored;
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute("data-theme", id);
    this.set({ themeId: id });
  }

  setTheme(id: string): void {
    if (!isThemeId(id)) return;
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", id);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, id);
      } catch {
        /* ignore */
      }
    }
    this.set({ themeId: id });
  }

  /** Preview a theme without persisting (for live hover in the picker). */
  previewTheme(id: string): void {
    if (!isThemeId(id) || typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", id);
  }

  /** Revert a preview back to the committed theme. */
  revertPreview(): void {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute("data-theme", this.get().themeId);
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
