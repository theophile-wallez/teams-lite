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
  type AppSettings,
  type Channel,
  type ChatMessage,
  type Conversation,
  type GitLabLinkMetadata,
  type LiveStatus,
  type MessagePage,
  type Notification,
  type ReplyTo,
  type TypingName,
  type TypingSignal,
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

/** Which sidebar list is showing: normal chats or the team/channel tree. Channel
 *  messages are kept strictly out of the chat list, so this is a hard switch
 *  between two distinct sources. */
export type SidebarTab = "chats" | "channels";

export type AppState = {
  conversations: Conversation[];
  /** The team/channel tree (flat, pre-sorted; grouped for display by
   *  `groupChannelsByTeam`). Distinct from `conversations` — a channel never
   *  appears in the chat list. */
  channels: Channel[];
  /** The active sidebar tab (chats vs. channels). */
  sidebarTab: SidebarTab;
  /** Local per-channel favorite overrides (channel id → favorited), persisted to
   *  localStorage. Overrides the backend's Teams-sourced `is_favorite`; a channel
   *  absent here falls back to that value. Drives the sidebar's pinned Favorites
   *  section (see `channelIsFavorite`/`organizeChannels`). */
  channelFavorites: Record<string, boolean>;
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
  /** People currently typing, per conversation id (a key is present only while
   *  someone is typing there). Drives both the message-pane hint and the sidebar
   *  row preview. Keyed by MRI under the hood so repeats coalesce; each entry
   *  auto-expires. */
  typingByConversation: Record<string, TypingName[]>;
  /** User appearance preference (System follows the OS). */
  appearance: Appearance;
  /** Concrete theme currently applied to <html> (what CSS keys off). */
  resolvedTheme: ResolvedTheme;
  /** Non-secret app settings (GitLab host + whether a token is stored), loaded
   *  from the backend on start. Drives which links get rich previews. */
  settings: AppSettings;
};

const DRAFT_SAVE_DELAY_MS = 150;
// How long a "typing" signal lives without a refresh before we assume the person
// stopped. Teams re-sends `Control/Typing` every few seconds while someone keeps
// typing, so this is a safety net for a missed `Control/ClearTyping`.
const TYPING_TIMEOUT_MS = 8000;
// Where local channel-favorite overrides are persisted (client-only).
const CHANNEL_FAVORITES_KEY = "teams-lite:channel-favorites";

function initialState(): AppState {
  return {
    conversations: [],
    channels: [],
    sidebarTab: "chats",
    channelFavorites: {},
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
    typingByConversation: {},
    appearance: DEFAULT_APPEARANCE,
    resolvedTheme: "light",
    settings: { gitlab_host: "gitlab.com", gitlab_token_set: false },
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

  // Live typing presence per conversation: convId -> (senderMri -> {name, timer}).
  // Non-reactive; the reactive `typing` slice is derived for the open conversation
  // whenever this changes. Each entry self-expires via its timer.
  private typingByConv = new Map<
    string,
    Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>
  >();

  // Media proxy cache: hosted-content URL -> a promise of a blob object URL.
  // Deduplicates concurrent loads of the same image and makes re-mounts/re-opens
  // instant. The created object URLs are revoked on dispose.
  private mediaCache = new Map<string, Promise<string>>();
  private mediaObjectUrls: string[] = [];

  // GitLab link-enrichment cache: URL -> a promise of its metadata (or null when
  // not enrichable). Deduplicates concurrent/repeat lookups of the same link
  // across message re-renders and scrolling. A failed (transient) lookup is
  // evicted so a later render can retry, matching the media cache.
  private linkCache = new Map<string, Promise<GitLabLinkMetadata | null>>();

  // Live OS dark-mode query, watched only while appearance === "system".
  private darkQuery: MediaQueryList | null = null;
  private darkListener: ((e: MediaQueryListEvent) => void) | null = null;

  private refreshConversations = coalesce(() => this.loadConversations());
  private refreshChannels = coalesce(() => this.loadChannels());
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
    this.applyPersistedFavorites();
    this.wireEvents();

    try {
      this.set({ splashMessage: "connecting" });
      await this.backend.connect();
      this.set({ live: "connected" });
      // Chats and channels come from the same backend and share a background CSA
      // sync; load both before revealing the UI so switching tabs is instant.
      await Promise.all([this.refreshConversations(), this.refreshChannels()]);
      this.set({ ready: true });
      // The activity feed is best-effort and must never block startup.
      void this.refreshNotifications();
      // App settings (GitLab host/token state) are best-effort too — a failure
      // just leaves the defaults, so link previews target gitlab.com.
      void this.loadSettings();
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
    for (const byMri of this.typingByConv.values()) {
      for (const entry of byMri.values()) clearTimeout(entry.timer);
    }
    this.typingByConv.clear();
    for (const url of this.mediaObjectUrls) URL.revokeObjectURL(url);
    this.mediaObjectUrls = [];
    this.mediaCache.clear();
    this.linkCache.clear();
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
      // A message from a sender means they stopped typing — clear their hint.
      if (m.sender_mri) {
        this.clearTyping(m.conversation_id, m.sender_mri);
        this.publishTyping(m.conversation_id);
      }
      if (m.conversation_id === this.get().openId) {
        this.set({
          messages: this.messageCache.get(m.conversation_id)!.messages,
        });
      } else if (shouldNotify(m, this.get().openId)) {
        notifyMessage(m.sender, m.content);
      }
      // Refresh the list the message belongs to so its preview/order updates
      // immediately. A channel post bumps the Channels tab, never the chat list;
      // an unknown id (a chat, or a channel not yet synced) refreshes chats, and
      // a brand-new channel is picked up by the backend's `channels_changed`.
      if (this.get().channels.some((c) => c.id === m.conversation_id)) {
        void this.refreshChannels();
      } else {
        void this.refreshConversations();
      }
    });

    on("typing", (raw) => this.onTyping(raw as TypingSignal));

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
    on("channels_changed", () => void this.refreshChannels());
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

  // ---- typing presence -----------------------------------------------------

  /** Fold a live `typing` signal into per-conversation presence and refresh the
   *  open conversation's reactive slice. A `Control/Typing` (re)arms an expiry
   *  timer; a `Control/ClearTyping` removes the person immediately. */
  private onTyping(sig: TypingSignal): void {
    const convId = sig.conversation_id;
    const mri = sig.sender_mri;
    if (!convId || !mri) return;

    if (sig.is_typing) {
      let byMri = this.typingByConv.get(convId);
      if (!byMri) {
        byMri = new Map();
        this.typingByConv.set(convId, byMri);
      }
      const existing = byMri.get(mri);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => this.expireTyping(convId, mri), TYPING_TIMEOUT_MS);
      byMri.set(mri, { name: sig.sender || "Someone", timer });
    } else {
      this.clearTyping(convId, mri);
    }
    this.publishTyping(convId);
  }

  /** Remove one person's typing entry (they sent, stopped, or timed out). Pure:
   *  callers refresh reactive state so a batch of clears renders once. */
  private clearTyping(convId: string, mri: string): void {
    const byMri = this.typingByConv.get(convId);
    if (!byMri) return;
    const entry = byMri.get(mri);
    if (!entry) return;
    clearTimeout(entry.timer);
    byMri.delete(mri);
    if (byMri.size === 0) this.typingByConv.delete(convId);
  }

  private expireTyping(convId: string, mri: string): void {
    this.clearTyping(convId, mri);
    this.publishTyping(convId);
  }

  private typingNamesFor(convId: string): TypingName[] {
    const byMri = this.typingByConv.get(convId);
    if (!byMri) return [];
    return [...byMri.entries()].map(([mri, e]) => ({ mri, name: e.name }));
  }

  /** Publish a conversation's current typers into reactive state so the sidebar
   *  row (and, when open, the message pane) updates. Preserves the array
   *  references of other conversations so their rows don't re-render, and drops
   *  the key entirely when nobody is typing there. */
  private publishTyping(convId: string): void {
    const names = this.typingNamesFor(convId);
    const prev = this.get().typingByConversation;
    if (names.length === 0) {
      if (!(convId in prev)) return;
      const next = { ...prev };
      delete next[convId];
      this.set({ typingByConversation: next });
      return;
    }
    this.set({ typingByConversation: { ...prev, [convId]: names } });
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

  // ---- channels ------------------------------------------------------------

  /** Refresh the team/channel tree from the backend. Best-effort: a failure
   *  leaves the current tree untouched (channels are a secondary view). Seeds the
   *  warm draft cache from each channel row, exactly like `loadConversations`, so
   *  a channel opened before its first live event still restores its draft. */
  private async loadChannels(): Promise<void> {
    try {
      const channels = await this.backend.channels();
      for (const ch of channels) {
        if (!this.draftCache.has(ch.id)) this.draftCache.set(ch.id, ch.draft);
      }
      this.set({ channels });
    } catch {
      // ignore — the channel tree is non-critical; the last good tree stands.
    }
  }

  /** Switch the sidebar between the chat list and the channel tree. */
  setSidebarTab(tab: SidebarTab): void {
    if (this.get().sidebarTab !== tab) this.set({ sidebarTab: tab });
  }

  /** Load the persisted local channel-favorite overrides into state. Best-effort
   *  and SSR-safe: any failure (no localStorage, malformed JSON) leaves the empty
   *  default, so the backend's Teams-sourced `is_favorite` stands alone. */
  private applyPersistedFavorites(): void {
    try {
      const raw = localStorage.getItem(CHANNEL_FAVORITES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        const overrides: Record<string, boolean> = {};
        for (const [id, fav] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof fav === "boolean") overrides[id] = fav;
        }
        this.set({ channelFavorites: overrides });
      }
    } catch {
      /* ignore — favorites are non-critical */
    }
  }

  private persistFavorites(overrides: Record<string, boolean>): void {
    try {
      localStorage.setItem(CHANNEL_FAVORITES_KEY, JSON.stringify(overrides));
    } catch {
      /* ignore — a failed persist just doesn't survive reload */
    }
  }

  /** Toggle a channel's favorite state, pinning it into (or out of) the sidebar's
   *  Favorites section. Records a local override that wins over Teams' own
   *  `is_favorite`, updates reactive state, and persists it. */
  toggleChannelFavorite(id: string): void {
    const base = this.get().channels.find((c) => c.id === id)?.is_favorite ?? false;
    const overrides = this.get().channelFavorites;
    const current = overrides[id] ?? base;
    const next = { ...overrides, [id]: !current };
    this.set({ channelFavorites: next });
    this.persistFavorites(next);
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
      this.get().channels.find((c) => c.id === id)?.draft ??
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

  // ---- settings + GitLab link enrichment ----------------------------------

  /** Load the non-secret app settings from the backend into reactive state.
   *  Best-effort: on failure the defaults remain (host gitlab.com, no token). */
  private async loadSettings(): Promise<void> {
    try {
      const settings = await this.backend.getSettings();
      this.set({ settings });
    } catch {
      // ignore — settings are non-critical; defaults stand.
    }
  }

  /** Persist app settings (partial) and reflect the fresh non-secret view in
   *  state. Clears the link cache so previews re-evaluate against the new host /
   *  token. Rejects on failure so the caller (the settings form) can surface it. */
  async saveSettings(patch: { gitlabHost?: string; gitlabToken?: string }): Promise<AppSettings> {
    const settings = await this.backend.setSettings(patch);
    this.set({ settings });
    this.linkCache.clear();
    return settings;
  }

  /** Resolve rich metadata for a GitLab link (or null when not enrichable),
   *  going through the backend. Cached and de-duplicated per URL; a transient
   *  failure is evicted so a later render can retry. */
  enrichLink(url: string): Promise<GitLabLinkMetadata | null> {
    const cached = this.linkCache.get(url);
    if (cached) return cached;

    const pending = this.backend.enrichLink(url).then((res) => res.metadata ?? null);
    this.linkCache.set(url, pending);
    pending.catch(() => this.linkCache.delete(url));
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
   * React to a message with an emoji, or toggle our reaction off. The backend
   * toggles (clicking our current reaction removes it), applies it optimistically
   * on its side, and re-broadcasts the message, which reconciles into the cache
   * by id (see `wireEvents`) — so we only fire the request and surface failures,
   * exactly like `editMessage`.
   */
  async reactToMessage(messageId: string, key: string): Promise<boolean> {
    const id = this.get().openId;
    if (!id) return false;
    try {
      await this.backend.react(id, messageId, key);
      return true;
    } catch (e) {
      this.set({ status: `reaction failed: ${errText(e)}` });
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
