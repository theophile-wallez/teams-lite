// teams-lite — UI (OpenTUI + Solid, opencode model)
//
// Reactive terminal UI over the Rust backend (via the WebSocket Backend client).
// Layout:  [ conversations (select) | messages (scrollbox) + input ]
// - select gives keyboard + mouse navigation for free
// - scrollbox gives wheel scroll + sticky-to-bottom for free
// - input gives a text field with onSubmit (Enter) for sending
// - Ctrl+K opens a fuzzy conversation palette; Ctrl+P opens settings (theme
//   switch with live preview); Escape closes them
//
// The UI holds no business logic: it renders backend state and sends commands.

import { useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, createMemo, For, Show, onMount, type Accessor } from "solid-js";
import { Backend, type Conversation, type ChatMessage, type UpdateInfo } from "./client";
import { parseMessageContent, type MessageQuote } from "./message-content";
import { ensureServer } from "./server";
import { notifyMessage, shouldNotify } from "./notify";
import { coalesce } from "./singleflight";
import { Splash } from "./splash";
import { Spinner } from "./spinner";
import { Border } from "./border";
import { DialogSelect } from "./dialog-select";
import { SettingsDialog } from "./settings";
import { theme } from "./theme";

const backend = new Backend();

// The live renderer, captured in App() so event handlers can tear it down. We
// only need destroy(); typed loosely to avoid importing the core renderer type.
let appRenderer: { destroy: () => void } | null = null;

// ---- reactive state --------------------------------------------------------
const [conversations, setConversations] = createSignal<Conversation[]>([]);
const [openId, setOpenId] = createSignal<string | null>(null);
const [selectedIndex, setSelectedIndex] = createSignal(0);
const [hoveredId, setHoveredId] = createSignal<string | null>(null);
const [messages, setMessages] = createSignal<ChatMessage[]>([]);
const [loadingMessages, setLoadingMessages] = createSignal(false);
const [messagesError, setMessagesError] = createSignal<string | null>(null);
const [status, setStatus] = createSignal("connecting…");
const [live, setLive] = createSignal<"connecting" | "connected" | "disconnected">("connecting");
const [paletteOpen, setPaletteOpen] = createSignal(false);
const [settingsOpen, setSettingsOpen] = createSignal(false);
const [draft, setDraft] = createSignal("");

// Set once the backend's startup check reports a newer rolling build. Surfaced
// as a subtle status-bar notice; never interrupts the user.
const [update, setUpdate] = createSignal<UpdateInfo | null>(null);

// Per-conversation message cache for this session. Once a conversation has been
// loaded, re-opening it shows its messages INSTANTLY from here — no loading
// spinner, no blank state, no visible refetch. Live `message` and background
// `messages_updated` events keep each cached entry current, so the instant view
// is also up to date. Bounded to conversations actually opened this session.
const messageCache = new Map<string, ChatMessage[]>();

// Composer auto-grow: the textarea starts at 2 text rows and grows with newlines
// up to 21, then scrolls internally. The composer wraps it with 1 blank row of
// padding above and below (see Border usage below), so the input box reads as
// 4 rows tall at rest with the text sitting between the first and last row.
const COMPOSER_MIN_ROWS = 2;
const COMPOSER_MAX_ROWS = 21;
const [composerRows, setComposerRows] = createSignal(COMPOSER_MIN_ROWS);

/// Coerce whatever the textarea's onContentChange hands us into a plain string.
/// Depending on the binding version this can be a string, a StyledText-like
/// object with `.toString()`, or undefined — never assume it's a string.
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  const anyv = value as any;
  if (typeof anyv.plainText === "string") return anyv.plainText;
  if (typeof anyv.toString === "function") {
    const s = anyv.toString();
    return typeof s === "string" && s !== "[object Object]" ? s : "";
  }
  return "";
}

function recomputeComposerRows(value: string) {
  const lines = value.length === 0 ? 1 : value.split("\n").length;
  setComposerRows(Math.max(COMPOSER_MIN_ROWS, Math.min(COMPOSER_MAX_ROWS, lines)));
}

function convLabel(c: Conversation): string {
  if (c.name && c.name.length > 0) return c.name;
  if (c.kind === "notes") return "Notes";
  return "(untitled)";
}

// Sidebar preview line (the second row under a conversation title), mirroring
// the Teams desktop list: "You:" when we sent the last message, "FirstName:" in
// a group, and the bare snippet in a 1:1 / Notes where the sender is implicit.
// The body is already HTML-stripped and length-capped server-side.
function firstName(full: string): string {
  const head = full.trim().split(/\s+/)[0];
  return head || full;
}

function previewLine(c: Conversation): string {
  const body = c.last_message_preview ?? "";
  if (!body) return "";
  if (c.last_message_from_me) return `You: ${body}`;
  const isGroup = c.kind === "group" || c.kind === "unknown";
  if (isGroup && c.last_message_sender) return `${firstName(c.last_message_sender)}: ${body}`;
  return body;
}

// Hard-truncate to fit one sidebar row (the pane is only 34 cols wide), so a long
// title or preview can never wrap and blow out the fixed row height.
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

// ---- backend wiring --------------------------------------------------------
async function loadConversations() {
  try {
    const convs = await backend.conversations();
    setConversations(convs);
    setStatus(`${convs.length} conversations`);
  } catch (e: any) {
    setStatus(`error: ${e.message ?? e}`);
  }
}

// Every `message` and `conversations_changed` event asks for a conversation-list
// refresh. Coalesce them: the `conversations` request kicks a background sync
// that can itself emit `conversations_changed`, so a naive 1:1 mapping amplifies
// into a refresh -> sync -> event -> refresh storm that freezes the TUI. A
// single-flight refresh collapses any burst into one in-flight fetch plus one
// trailing pass, which — together with the backend only emitting the event on a
// real change — makes the loop settle instead of exploding.
const refreshConversations = coalesce(loadConversations);

async function openConversation(id: string) {
  setOpenId(id);
  setMessagesError(null);

  const cached = messageCache.get(id);
  if (cached) {
    // Already loaded this session: show it INSTANTLY. No blank state, no
    // spinner. The backend refresh below still runs, but invisibly.
    setMessages(cached);
    setLoadingMessages(false);
  } else {
    // Cold open (first time this session): nothing to show yet, so indicate
    // loading. The backend answers from the SQLite cache, so this is brief.
    setMessages([]);
    setLoadingMessages(true);
  }

  try {
    // Returns instantly from the SQLite cache; the network refresh (if any)
    // arrives later as a `messages_updated` (or `messages_error`) event.
    const res = await backend.open(id);
    messageCache.set(id, res.messages);
    // guard against a slower response for a conversation we've since left
    if (openId() === id) setMessages(res.messages);
  } catch (e: any) {
    // Only surface the error if we have nothing cached to fall back on.
    if (openId() === id && !cached) setMessagesError(e?.message ?? String(e));
    setStatus(`open error: ${e.message ?? e}`);
  } finally {
    if (openId() === id) setLoadingMessages(false);
  }
}

async function sendDraft() {
  const text = draft().trim();
  const id = openId();
  if (!text || !id) return;
  setDraft("");
  try {
    await backend.send(id, text);
    // the sent line will arrive via the live `message` event; no manual refresh
  } catch (e: any) {
    setStatus(`send failed: ${e.message ?? e}`);
  }
}

function wireEvents() {
  backend.on("message", (m: ChatMessage) => {
    // Keep the per-conversation cache warm so re-opening stays instant AND
    // current, even for a conversation we're not currently looking at.
    const cached = messageCache.get(m.conversation_id);
    if (cached && !cached.some((x) => x.id === m.id)) {
      messageCache.set(m.conversation_id, [...cached, m]);
    }
    // live message: if it belongs to the open conversation, append it
    if (m.conversation_id === openId()) {
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    } else if (shouldNotify(m, openId())) {
      // incoming message for a conversation we're not looking at: notify desktop
      notifyMessage(m.sender, m.content);
    }
    // bump the conversation list ordering (refetch is cheap enough here)
    refreshConversations();
  });
  // background network refresh of an open conversation finished with new data
  backend.on("messages_updated", (d: { conversation: string; messages: ChatMessage[] }) => {
    // reconcile the cache so a later re-open shows the refreshed set instantly
    messageCache.set(d.conversation, d.messages);
    if (d.conversation === openId()) {
      setMessages(d.messages);
      setMessagesError(null);
      setLoadingMessages(false);
    }
  });
  // background network refresh failed (e.g. auth could not be recovered)
  backend.on("messages_error", (d: { conversation: string; error: string }) => {
    if (d.conversation === openId()) {
      setMessagesError(d.error || "Couldn't load messages");
      setLoadingMessages(false);
    }
  });
  backend.on("conversations_changed", () => refreshConversations());
  backend.on("realtime_status", (s: string) => setLive(s as any));
  // A newer rolling build exists (checked once at startup by the backend).
  backend.on("update_available", (u: UpdateInfo) => setUpdate(u));
  backend.on("disconnected", () => setLive("disconnected"));
  // The client exhausted its reconnect retries: the backend is gone for good.
  backend.on("backend_lost", () => {
    setLive("disconnected");
    setStatus("backend lost — retries exhausted. Press Ctrl+C to quit.");
    // If the terminal is gone (e.g. the window was closed), there's no one to
    // press Ctrl+C. Tear the renderer down so index.tsx's onDestroy exits the
    // process instead of leaving it to linger as a background CPU spinner.
    if (!process.stdout.isTTY) appRenderer?.destroy();
  });
}

// ---- components ------------------------------------------------------------
function ConversationList() {
  const openConv = (id: string, index: number) => {
    setSelectedIndex(index);
    openConversation(id);
  };
  return (
    <box
      style={{
        width: 34,
        backgroundColor: theme().backgroundPanel,
        flexDirection: "column",
        paddingTop: 1,
      }}
    >
      <scrollbox
        style={{
          flexGrow: 1,
          backgroundColor: theme().backgroundPanel,
          verticalScrollbarOptions: {
            showArrows: false,
            // track blends into the sidebar so only the thumb (handle) shows
            trackOptions: { backgroundColor: theme().backgroundPanel, foregroundColor: theme().borderSubtle },
          },
        }}
        stickyScroll={false}
      >
        <For each={conversations()}>
          {(c, i) => {
            const isOpen = () => openId() === c.id;
            const isHovered = () => hoveredId() === c.id;
            const isSelected = () => selectedIndex() === i();
            const bg = () =>
              isOpen() ? theme().rowOpen : isHovered() ? theme().rowHovered : isSelected() ? theme().rowSelected : theme().rowIdle;
            // Unread threads read brighter; muted threads stay dim even when
            // unread (they shouldn't pull the eye), matching the Teams sidebar.
            const unread = () => !c.is_read;
            const titleFg = () =>
              isOpen() ? theme().text : c.is_muted ? theme().textMuted : unread() ? theme().text : theme().textDim;
            const previewFg = () =>
              isOpen() ? theme().textDim : unread() && !c.is_muted ? theme().textMuted : theme().textFaint;
            // The attention dot: only for unread, non-muted threads.
            const dot = () => (unread() && !c.is_muted ? "●" : " ");
            const preview = () => clip(previewLine(c), 29);
            return (
              <box
                style={{ width: "100%", height: 3, flexDirection: "row", alignItems: "center", paddingLeft: 1, backgroundColor: bg() }}
                onMouseDown={() => openConv(c.id, i())}
                onMouseOver={() => setHoveredId(c.id)}
                onMouseOut={() => setHoveredId((h) => (h === c.id ? null : h))}
              >
                <text content={dot()} style={{ fg: theme().unreadDot }} />
                <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
                  <text content={clip(convLabel(c), 29)} style={{ fg: titleFg() }} />
                  <text content={preview()} style={{ fg: previewFg() }} />
                </box>
              </box>
            );
          }}
        </For>
      </scrollbox>
    </box>
  );
}

// A top border made of the upper-half-block glyph (▀), used to give a box a
// half-cell of breathing room above it. The glyph's foreground (borderColor) is
// painted with the color BEHIND the box and its background is the box's own fill,
// so the border row shows the outer color on its top half and the box color on its
// bottom half — the finest vertical gap a terminal cell can express. Used both to
// separate stacked message bubbles (outer = the pane) and to inset a quoted reply
// inside its bubble (outer = the bubble). A terminal box shares one `horizontal`
// glyph across top and bottom, so this only ever decorates the top edge.
const TOP_HALF_GAP_BORDER = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: "▀",
  vertical: "",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
};

// The mirror of TOP_HALF_GAP_BORDER for the bottom edge, using the lower-half-block
// glyph (▄): with borderColor = the color behind the box and background = the box's
// own fill, the bottom border row shows the box color on its top half and the outer
// color on its bottom half — a half-cell gap below the box. A box can only carry one
// horizontal glyph (shared by its top and bottom edges), so a bubble that wants BOTH
// a top and a bottom half-gap nests two boxes: the outer draws the top ▀, the inner
// draws the bottom ▄.
const BOTTOM_HALF_GAP_BORDER = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: "▄",
  vertical: "",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
};

// A single chat message, rendered as a bubble. Mine align right with an accent
// background; everyone else's align left in a neutral grey. The sender name only
// appears on incoming bubbles, and only in group chats (in a 1:1 or the Notes
// chat the other party is implicit). My own messages never show a name — their
// right alignment already says they're mine.
//
// Each bubble carries a half-cell gap above AND below it, so stacked messages float
// with breathing room instead of touching. A box can only carry one horizontal
// border glyph (shared by top and bottom), so the bubble nests two boxes: the outer
// draws the ▀ top gap, the inner draws the ▄ bottom gap. Both are painted with the
// pane background, so each half-row reads as empty space. When the message is a
// reply, the quoted message is drawn as a nested box with the same half-cell inset —
// a shade lighter than the bubble on incoming messages, a shade darker on my own, so
// the quote reads as recessed either way.
export function MessageBubble(props: { message: ChatMessage; showSenderName: boolean }) {
  const mine = () => props.message.is_self === true;
  const parsed = createMemo(() => parseMessageContent(props.message.content));
  const bubbleBg = () => (mine() ? theme().bubbleMine : theme().bubbleIncoming);
  const quoteBg = () => (mine() ? theme().quoteMine : theme().quoteIncoming);
  // The sender name only renders on incoming bubbles in group chats. It matters for
  // the quote's top gap below: when a name sits above the quote it gets its own ▀
  // inset, but when the message opens straight with a quote the bubble's own ▀ top
  // already provides the gap, so a second one would stack into a full cell of dead
  // bubble color above the quote.
  const nameShown = () => !mine() && props.showSenderName;
  return (
    <box
      border={["top"]}
      borderColor={theme().background}
      customBorderChars={TOP_HALF_GAP_BORDER}
      style={{
        flexDirection: "column",
        alignSelf: mine() ? "flex-end" : "flex-start",
        maxWidth: "72%",
        marginBottom: 0,
        backgroundColor: bubbleBg(),
      }}
    >
      <box
        border={["bottom"]}
        borderColor={theme().background}
        customBorderChars={BOTTOM_HALF_GAP_BORDER}
        style={{
          flexDirection: "column",
          width: "100%",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: bubbleBg(),
        }}
      >
        <Show when={nameShown()}>
          <text content={props.message.sender} style={{ fg: theme().senderName }} />
        </Show>
        <Show when={parsed().quote}>
          {(quote: Accessor<MessageQuote>) => (
            <box
              border={nameShown() ? ["top"] : []}
              borderColor={bubbleBg()}
              customBorderChars={TOP_HALF_GAP_BORDER}
              style={{
                flexDirection: "column",
                marginBottom: 0,
                backgroundColor: quoteBg(),
              }}
            >
              <box
                border={["bottom"]}
                borderColor={bubbleBg()}
                customBorderChars={BOTTOM_HALF_GAP_BORDER}
                style={{
                  flexDirection: "column",
                  width: "100%",
                  paddingLeft: 1,
                  paddingRight: 1,
                  backgroundColor: quoteBg(),
                }}
              >
                <Show when={quote().sender.length > 0}>
                  <text content={quote().sender} style={{ fg: mine() ? theme().senderNameMine : theme().senderName }} />
                </Show>
                <text content={quote().text} style={{ fg: mine() ? theme().quoteTextMine : theme().quoteTextIncoming }} />
              </box>
            </box>
          )}
        </Show>
        <Show when={parsed().body.length > 0}>
          <text content={parsed().body} style={{ fg: theme().text }} />
        </Show>
      </box>
    </box>
  );
}

// A medium ASCII illustration shown above a load error. A "no signal" motif —
// enough presence to read as a real error state, not a stray line.
const ERROR_ART = [
  "     .------------------.     ",
  "     |  x            x  |     ",
  "     |                  |     ",
  "     |    /\\  /\\  /\\    |     ",
  "     |   /  \\/  \\/  \\   |     ",
  "     |                  |     ",
  "     '------------------'     ",
  "        \\____________/        ",
  "         (  no signal )       ",
].join("\n");

// A centered load-error block: a medium ASCII illustration on top, the error
// message underneath. Used both as the full-screen empty-conversation state and
// as the sticky banner above the composer when messages already exist.
function MessagesError(props: { message: string }) {
  return (
    <box style={{ flexDirection: "column", alignItems: "center" }}>
      <text content={ERROR_ART} style={{ fg: theme().textFaint }} />
      <box style={{ height: 1 }} />
      <text content="Couldn't load messages" style={{ fg: theme().error }} />
      <text content={props.message} style={{ fg: theme().textMuted }} />
    </box>
  );
}

function MessagePane() {
  const openConv = createMemo(() => {
    const id = openId();
    if (!id) return null;
    return conversations().find((x) => x.id === id) ?? null;
  });
  const title = createMemo(() => {
    const id = openId();
    if (!id) return " Messages ";
    const c = openConv();
    return ` ${c ? convLabel(c) : id} `;
  });
  // Only group chats show a sender name on incoming bubbles. In a 1:1 (or the
  // self "Notes" chat) the other party is implicit, and our own messages never
  // show a name because they're already right-aligned.
  const showSenderNames = createMemo(() => openConv()?.kind === "group");
  return (
    <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: theme().background, paddingTop: 1, paddingLeft: 1, paddingRight: 1 }}>
      <Show when={openId()}>
        <text content={title().trim()} style={{ fg: theme().textMuted }} />
      </Show>
      {/* paddingRight keeps message bubbles from butting against the scrollbar
          on the right; the left gap already comes from the pane's paddingLeft. */}
      <scrollbox style={{ flexGrow: 1, paddingRight: 1 }} stickyScroll stickyStart="bottom">
        <Show
          when={openId()}
          fallback={<text content="Select a conversation (↑/↓, Enter, or click)." style={{ fg: theme().textMuted }} />}
        >
          <Show
            when={messages().length > 0}
            fallback={
              // Empty conversation: an error (when the load failed) is centered
              // in the whole pane; otherwise the loading / "no messages" hint.
              <Show
                when={messagesError()}
                fallback={
                  <Show
                    when={loadingMessages()}
                    fallback={<text content="No messages yet." style={{ fg: theme().textMuted }} />}
                  >
                    <Spinner label="loading messages…" color={theme().textMuted} />
                  </Show>
                }
              >
                <box style={{ flexGrow: 1, justifyContent: "center", alignItems: "center" }}>
                  <MessagesError message={messagesError()!} />
                </box>
              </Show>
            }
          >
            <For each={messages()}>
              {(m) => <MessageBubble message={m} showSenderName={showSenderNames()} />}
            </For>
          </Show>
        </Show>
      </scrollbox>
      {/* When messages already exist but the refresh failed, keep the error
          pinned above the composer so it stays visible while scrolling. */}
      <Show when={openId() && messages().length > 0 && messagesError()}>
        <box style={{ flexDirection: "column", alignItems: "center", marginTop: 1 }}>
          <MessagesError message={messagesError()!} />
        </box>
      </Show>
      <Show when={openId()}>
        {/* flexShrink:0 protects the composer's full height: without it the
            scrollbox (flexGrow:1) squeezes the composer and its bottom rows get
            clipped, so the 4-row input renders as only 2. */}
        <box style={{ flexDirection: "column", marginTop: 1, flexShrink: 0 }}>
          {/* Accent bar drawn as the box's native left border (┃) in the theme's
              primary color, so it spans the composer's full height automatically.
              The inner box adds one blank row above and below the textarea so the
              text sits between the first and last row of the 4-row input. */}
          <Border>
            <box style={{ width: "100%", paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1, backgroundColor: theme().backgroundElement }}>
              <textarea
                style={{
                  // Pin focused/unfocused backgrounds to the same color so the
                  // composer never flashes a different shade when it takes focus.
                  // (The Solid reconciler constructs the textarea with only {id},
                  // leaving focusedBackgroundColor at its "transparent" default
                  // unless we set it explicitly.)
                  width: "100%",
                  height: composerRows(),
                  backgroundColor: theme().backgroundElement,
                  focusedBackgroundColor: theme().backgroundElement,
                }}
                focused={!paletteOpen() && !settingsOpen()}
                placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
                value={draft()}
                keyBindings={[
                  { name: "return", action: "submit" },
                  { name: "return", shift: true, action: "newline" },
                ]}
                onContentChange={(v: unknown) => {
                  const text = asText(v);
                  setDraft(text);
                  recomputeComposerRows(text);
                }}
                onSubmit={() => {
                  sendDraft();
                  setComposerRows(COMPOSER_MIN_ROWS);
                }}
              />
            </box>
          </Border>
        </box>
      </Show>
    </box>
  );
}

function StatusBar() {
  return (
    <box style={{ height: 1, flexDirection: "row", backgroundColor: theme().background, paddingLeft: 1 }}>
      <Show when={live() === "connecting"}>
        <Spinner color={theme().textMuted} />
        <text content=" " />
      </Show>
      <Show when={live() !== "connecting"}>
        <text content={live() === "connected" ? "🟢 " : "🔴 "} />
      </Show>
      <text content={status()} style={{ fg: theme().textMuted }} />
      {/* Push the update notice to the right edge; the spacer is harmless when
          there's no update to show. */}
      <box style={{ flexGrow: 1 }} />
      <Show when={update()}>
        {(u: Accessor<UpdateInfo>) => (
          <text
            content={`↑ update available (${u().latest}) — reinstall to update `}
            style={{ fg: theme().warning }}
          />
        )}
      </Show>
    </box>
  );
}

export function App() {
  // Capture the renderer so a fatal "backend lost" can tear it down (which, via
  // index.tsx's onDestroy, exits the process) when there's no terminal left to
  // quit from.
  appRenderer = useRenderer();

  const [ready, setReady] = createSignal(false);
  const [splashMsg, setSplashMsg] = createSignal("starting backend");

  onMount(async () => {
    wireEvents();
    try {
      // one command starts everything: bring up (or attach to) the backend…
      setSplashMsg("starting backend");
      await ensureServer();
      // …then connect and load the first data before revealing the UI
      setSplashMsg("connecting");
      await backend.connect();
      setLive("connected");
      await refreshConversations();
      setReady(true);
    } catch (e: any) {
      setStatus(`backend unreachable — ${e?.message ?? e}`);
      setSplashMsg(`failed: ${e?.message ?? e}`);
      setLive("disconnected");
      // reveal the (empty) UI anyway after a beat so the error is visible in-app
      setTimeout(() => setReady(true), 2500);
    }
  });

  // global keys: Ctrl+K palette, Escape closes it / leaves conversation.
  // We intentionally do NOT handle Ctrl+C here. OpenTUI's renderer owns Ctrl+C
  // by default (exitOnCtrlC: true) and runs destroy() on it, which restores the
  // terminal, exits the alternate screen, and — critically — disables mouse
  // tracking before the process ends. Calling process.exit(0) ourselves raced
  // that teardown and killed the process before the mouse-disable escape
  // sequence was flushed, which is what left the terminal emitting stray
  // "35;56;51M" SGR mouse reports on every mouse move after Ctrl+C.
  useKeyboard((e) => {
    // While a dialog is open (Ctrl+K conversation palette or Ctrl+P settings) it
    // owns every key — its own DialogSelect handler drives navigation, selection
    // and Escape-to-close — so we must NOT also treat Ctrl+K/Ctrl+P as global
    // toggles here (Ctrl+P is the dialog's own "move up" binding).
    if (paletteOpen() || settingsOpen()) return;
    if (e.ctrl && e.name === "k") {
      setPaletteOpen(true);
      return;
    }
    if (e.ctrl && e.name === "p") {
      setSettingsOpen(true);
      return;
    }
    if (e.name === "escape") {
      setOpenId(null);
      return;
    }

    // conversation-list navigation (only when not typing in an open
    // conversation's composer)
    const typing = openId() !== null;
    if (!typing) {
      const list = conversations();
      if (e.name === "down" || e.name === "j") {
        setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
      } else if (e.name === "up" || e.name === "k") {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.name === "return") {
        const c = list[selectedIndex()];
        if (c) openConversation(c.id);
      }
    }
  });

  return (
    <Show when={ready()} fallback={<Splash message={splashMsg()} />}>
      <box style={{ flexDirection: "column", width: "100%", height: "100%", backgroundColor: theme().background }}>
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <ConversationList />
          <MessagePane />
        </box>
        <StatusBar />
        <Show when={paletteOpen()}>
          <DialogSelect
            title="Go to conversation"
            placeholder="Search conversations…"
            current={openId() ?? undefined}
            options={conversations().map((c) => ({ title: convLabel(c), value: c.id }))}
            onSelect={(option) => {
              openConversation(option.value);
              setPaletteOpen(false);
            }}
            onClose={() => setPaletteOpen(false)}
          />
        </Show>
        <Show when={settingsOpen()}>
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Show>
      </box>
    </Show>
  );
}

