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
  type Notification,
  type ReplyTo,
  type UpdateInfo,
} from "./protocol";
import { coalesce } from "./singleflight";
import { ensureNotificationPermission, notifyMessage } from "./notify";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  coerceAppearance,
  resolveTheme,
  type Appearance,
  type ResolvedTheme,
} from "./appearance";

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
  /** Activity feed (reactions/mentions/replies), newest-first. */
  notifications: Notification[];
  /** Count the bell badges (Teams' unread count, cleared locally when seen). */
  notificationsUnread: number;
  /** A pending request to scroll the open conversation to a specific message
   *  (set when a notification is opened). The pane consumes it, paging older if
   *  needed, then clears it. `nonce` lets the same target retrigger. */
  pendingScroll: { convId: string; messageId: string; nonce: number } | null;
  /** User appearance preference (System follows the OS). */
  appearance: Appearance;
  /** Concrete theme currently applied to <html> (what CSS keys off). */
  resolvedTheme: ResolvedTheme;
};

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
    notifications: [],
    notificationsUnread: 0,
    pendingScroll: null,
    appearance: DEFAULT_APPEARANCE,
    resolvedTheme: "light",
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

  // Media proxy cache: hosted-content URL -> a promise of a blob object URL.
  // Deduplicates concurrent loads of the same image and makes re-mounts/re-opens
  // instant. The created object URLs are revoked on dispose.
  private mediaCache = new Map<string, Promise<string>>();
  private mediaObjectUrls: string[] = [];

  // Live OS dark-mode query, watched only while appearance === "system".
  private darkQuery: MediaQueryList | null = null;
  private darkListener: ((e: MediaQueryListEvent) => void) | null = null;

  private refreshConversations = coalesce(() => this.loadConversations());
  private refreshNotifications = coalesce(() => this.loadNotifications());

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

    this.applyPersistedAppearance();
    this.wireEvents();

    try {
      this.set({ splashMessage: "connecting" });
      await this.backend.connect();
      this.set({ live: "connected" });
      await this.refreshConversations();
      this.set({ ready: true });
      // The activity feed is best-effort and must never block startup.
      void this.refreshNotifications();
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
    this.detachDarkQuery();
    for (const t of this.draftSaveTimers.values()) clearTimeout(t);
    this.draftSaveTimers.clear();
    for (const url of this.mediaObjectUrls) URL.revokeObjectURL(url);
    this.mediaObjectUrls = [];
    this.mediaCache.clear();
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
    on("notifications_changed", () => void this.refreshNotifications());
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

  // ---- notifications (activity feed) --------------------------------------

  // Local "seen" high-water mark (epoch ms). The badge counts unread entries
  // strictly newer than this, so opening the panel clears the badge even though
  // a refetch still reports the same server-side unread — and a genuinely new
  // activity (larger timestamp) re-badges it. Local only: Teams has no
  // mark-read method we call yet.
  private notificationsSeenAt = 0;

  /** Refresh the activity feed. Best-effort: a failure leaves the current feed
   *  untouched and never surfaces a fatal error (the panel just shows stale or
   *  empty state). Called on startup and on every `notifications_changed`. */
  private async loadNotifications(): Promise<void> {
    try {
      const feed = await this.backend.notifications();
      this.set({ notifications: feed.items });
      this.recomputeUnread();
    } catch {
      // ignore — notifications are non-critical
    }
  }

  private recomputeUnread(): void {
    const unread = this.get().notifications.filter(
      (n) => !n.is_read && n.timestamp > this.notificationsSeenAt,
    ).length;
    if (unread !== this.get().notificationsUnread) this.set({ notificationsUnread: unread });
  }

  /** Clear the bell badge once the user has opened the panel, by marking every
   *  current entry as seen. The badge re-appears when a newer activity arrives. */
  markNotificationsSeen(): void {
    const latest = this.get().notifications.reduce((max, n) => Math.max(max, n.timestamp), 0);
    this.notificationsSeenAt = Math.max(this.notificationsSeenAt, latest);
    this.recomputeUnread();
  }

  /** Force a feed refresh, e.g. when the user opens the panel. Coalesced with
   *  the live-event refresh so rapid opens don't stack network calls. */
  reloadNotifications(): void {
    void this.refreshNotifications();
  }

  private scrollNonce = 0;

  /** Ask the open pane to scroll to a specific message once it is loaded (the
   *  pane pages older until it appears, then highlights it). Used when a
   *  notification is opened so the user lands on the reacted-to message, not the
   *  bottom of the chat. A no-op target id clears any pending request. */
  requestScrollToMessage(convId: string, messageId: string): void {
    if (!messageId) {
      if (this.get().pendingScroll) this.set({ pendingScroll: null });
      return;
    }
    this.scrollNonce += 1;
    this.set({ pendingScroll: { convId, messageId, nonce: this.scrollNonce } });
  }

  /** Clear a consumed (or abandoned) scroll request, guarded by nonce so a newer
   *  request set in the meantime is never dropped. */
  clearScrollTarget(nonce: number): void {
    if (this.get().pendingScroll?.nonce === nonce) this.set({ pendingScroll: null });
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

  // ---- media (hosted-content proxy) ---------------------------------------

  /** Resolve a Teams hosted-content URL (inline image or shared file) to a local
   *  blob object URL, fetching the bytes through the backend proxy. Cached and
   *  deduplicated per URL; a failed load is evicted so a later retry can refetch.
   *  The returned object URL stays valid until the controller is disposed. */
  loadMedia(url: string): Promise<string> {
    const cached = this.mediaCache.get(url);
    if (cached) return cached;

    const pending = (async () => {
      const res = await this.backend.fetchMedia(url);
      const blob = new Blob([base64ToArrayBuffer(res.data_base64)], {
        type: res.content_type || "application/octet-stream",
      });
      const objectUrl = URL.createObjectURL(blob);
      this.mediaObjectUrls.push(objectUrl);
      return objectUrl;
    })();

    this.mediaCache.set(url, pending);
    pending.catch(() => this.mediaCache.delete(url));
    return pending;
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

  /**
   * Send the current draft. In plain mode `text` carries the message; in rich
   * mode `html` carries the already-normalized Teams-safe HTML (from the TipTap
   * editor) and `text` is empty. When replying, the backend prepends the quote
   * blockquote; the rich HTML (or plain `after` text) becomes the reply body.
   */
  async sendDraft(text: string, html?: string): Promise<void> {
    const id = this.get().openId;
    if (!id) return;
    const clean = text.trim();
    const richHtml = html?.trim() || undefined;
    if (!clean && !richHtml) return;

    // When replying, the backend builds the outgoing HTML as
    // quote + body. For plain sends the body is paragraph(after); for rich sends
    // it is the normalized HTML, so the reply body goes into `after`/html.
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
      await this.backend.send(id, clean, replyTo, richHtml);
    } catch (e) {
      this.set({ status: `send failed: ${errText(e)}` });
      return;
    }

    this.draftCache.set(id, "");
    if (this.get().openId === id) this.set({ draft: "", replyingTo: null });
    this.persistDraft(id, "");
  }

  // ---- appearance (Light / Dark / System) ---------------------------------

  private systemPrefersDark(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  /** Apply a resolved theme to <html> so the whole palette repaints. */
  private paintTheme(theme: ResolvedTheme): void {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  /** Watch the OS dark-mode query while (and only while) following the system. */
  private attachDarkQuery(): void {
    if (this.darkQuery || typeof window === "undefined" || !window.matchMedia) return;
    this.darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.darkListener = () => {
      if (this.get().appearance !== "system") return;
      const theme = this.systemPrefersDark() ? "dark" : "light";
      this.paintTheme(theme);
      this.set({ resolvedTheme: theme });
    };
    this.darkQuery.addEventListener("change", this.darkListener);
  }

  private detachDarkQuery(): void {
    if (this.darkQuery && this.darkListener) {
      this.darkQuery.removeEventListener("change", this.darkListener);
    }
    this.darkQuery = null;
    this.darkListener = null;
  }

  private applyPersistedAppearance(): void {
    let pref: Appearance = DEFAULT_APPEARANCE;
    try {
      pref = coerceAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY));
    } catch {
      /* ignore */
    }
    const theme = resolveTheme(pref, this.systemPrefersDark());
    this.paintTheme(theme);
    this.set({ appearance: pref, resolvedTheme: theme });
    if (pref === "system") this.attachDarkQuery();
  }

  /** Commit and persist an appearance preference. */
  setAppearance(pref: Appearance): void {
    const theme = resolveTheme(pref, this.systemPrefersDark());
    this.paintTheme(theme);
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, pref);
    } catch {
      /* ignore */
    }
    this.set({ appearance: pref, resolvedTheme: theme });
    if (pref === "system") this.attachDarkQuery();
    else this.detachDarkQuery();
  }

  /** Preview an appearance without persisting (live hover in the picker). */
  previewAppearance(pref: Appearance): void {
    this.paintTheme(resolveTheme(pref, this.systemPrefersDark()));
  }

  /** Revert a preview back to the committed appearance. */
  revertAppearance(): void {
    this.paintTheme(this.get().resolvedTheme);
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Decode a base64 string (as returned by the backend media proxy) to an
 *  ArrayBuffer, suitable for constructing a Blob. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buffer;
}
