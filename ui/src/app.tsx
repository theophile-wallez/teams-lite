// teams-lite — UI (OpenTUI + Solid, opencode model)
//
// Reactive terminal UI over the Rust backend (via the WebSocket Backend client).
// Layout:  [ conversations (select) | messages (scrollbox) + input ]
// - select gives keyboard + mouse navigation for free
// - scrollbox gives wheel scroll + sticky-to-bottom for free
// - input gives a text field with onSubmit (Enter) for sending
// - Ctrl+K opens a fuzzy palette; Escape closes it
//
// The UI holds no business logic: it renders backend state and sends commands.

import { useKeyboard, useRenderer } from "@opentui/solid";
import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import { Backend, type Conversation, type ChatMessage } from "./client";
import { ensureServer } from "./server";
import { notifyMessage, shouldNotify } from "./notify";
import { coalesce } from "./singleflight";
import { Splash } from "./splash";
import { Spinner } from "./spinner";

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
const [paletteQuery, setPaletteQuery] = createSignal("");
const [draft, setDraft] = createSignal("");

// Per-conversation message cache for this session. Once a conversation has been
// loaded, re-opening it shows its messages INSTANTLY from here — no loading
// spinner, no blank state, no visible refetch. Live `message` and background
// `messages_updated` events keep each cached entry current, so the instant view
// is also up to date. Bounded to conversations actually opened this session.
const messageCache = new Map<string, ChatMessage[]>();

// Composer auto-grow: starts at 3 rows, grows with newlines up to 23, then the
// textarea scrolls internally.
const COMPOSER_MIN_ROWS = 3;
const COMPOSER_MAX_ROWS = 23;
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

// strip HTML for terminal display
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function convLabel(c: Conversation): string {
  if (c.name && c.name.length > 0) return c.name;
  if (c.kind === "notes") return "Notes";
  return "(untitled)";
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

// ---- palette (cmd+K) fuzzy filtering ---------------------------------------
function fuzzyScore(hay: string, q: string): number | null {
  if (!q) return 0;
  hay = hay.toLowerCase();
  q = q.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] === q[qi]) {
      score += i === last + 1 ? 5 : 1;
      if (i === 0) score += 3;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

const paletteMatches = createMemo(() => {
  const q = paletteQuery();
  return conversations()
    .map((c) => ({ c, s: fuzzyScore(convLabel(c), q) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => (b.s! - a.s!))
    .slice(0, 12)
    .map((x) => x.c);
});

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
        backgroundColor: "#141414",
        flexDirection: "column",
        paddingTop: 1,
      }}
    >
      <scrollbox
        style={{
          flexGrow: 1,
          backgroundColor: "#141414",
          verticalScrollbarOptions: {
            showArrows: false,
            // track blends into the sidebar so only the thumb (handle) shows
            trackOptions: { backgroundColor: "#141414", foregroundColor: "#3a3a3a" },
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
              isOpen() ? "#2a2a2a" : isHovered() ? "#242424" : isSelected() ? "#1e1e1e" : "#141414";
            const fg = () => (isOpen() ? "#ffffff" : "#c0c0c0");
            return (
              <box
                style={{ width: "100%", height: 3, flexDirection: "row", justifyContent: "flex-start", alignItems: "center", paddingLeft: 1, backgroundColor: bg() }}
                onMouseDown={() => openConv(c.id, i())}
                onMouseOver={() => setHoveredId(c.id)}
                onMouseOut={() => setHoveredId((h) => (h === c.id ? null : h))}
              >
                <text content={convLabel(c)} style={{ fg: fg() }} />
              </box>
            );
          }}
        </For>
      </scrollbox>
    </box>
  );
}

// A single chat message, rendered as a bubble. Mine align right with an accent
// background; everyone else's align left in a neutral grey. The sender name only
// appears on incoming bubbles, and only in group chats (in a 1:1 or the Notes
// chat the other party is implicit). My own messages never show a name — their
// right alignment already says they're mine.
export function MessageBubble(props: { message: ChatMessage; showSenderName: boolean }) {
  const mine = () => props.message.is_self === true;
  return (
    <box
      style={{
        flexDirection: "column",
        alignSelf: mine() ? "flex-end" : "flex-start",
        maxWidth: "72%",
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: mine() ? "#2b5278" : "#1e1e1e",
      }}
    >
      <Show when={!mine() && props.showSenderName}>
        <text content={props.message.sender} style={{ fg: "#7fb0e0" }} />
      </Show>
      <text content={plain(props.message.content)} style={{ fg: "#e8e8e8" }} />
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
      <text content={ERROR_ART} style={{ fg: "#5b5b5b" }} />
      <box style={{ height: 1 }} />
      <text content="Couldn't load messages" style={{ fg: "#d08770" }} />
      <text content={props.message} style={{ fg: "#7a5a4a" }} />
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
    <box style={{ flexGrow: 1, flexDirection: "column", backgroundColor: "#0A0A0A", paddingTop: 1, paddingLeft: 1, paddingRight: 1 }}>
      <Show when={openId()}>
        <text content={title().trim()} style={{ fg: "#808080" }} />
      </Show>
      <scrollbox style={{ flexGrow: 1 }} stickyScroll stickyStart="bottom">
        <Show
          when={openId()}
          fallback={<text content="Select a conversation (↑/↓, Enter, or click)." style={{ fg: "gray" }} />}
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
                    fallback={<text content="No messages yet." style={{ fg: "gray" }} />}
                  >
                    <Spinner label="loading messages…" color="gray" />
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
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          <textarea
            style={{ height: composerRows(), backgroundColor: "#1E1E1E" }}
            focused={!paletteOpen()}
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
          <box style={{ flexDirection: "row", height: 1 }}>
            <text content=" Send " style={{ fg: "#0A0A0A", bg: "#808080" }} />
            <text content="  Enter to send · Shift+Enter new line" style={{ fg: "#5b5b5b" }} />
          </box>
        </box>
      </Show>
    </box>
  );
}

function Palette() {
  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <box
        style={{
          width: 64,
          height: 16,
          flexDirection: "column",
          backgroundColor: "#141414",
          paddingTop: 1,
          paddingLeft: 2,
          paddingRight: 2,
        }}
      >
        <text content="Go to conversation" style={{ fg: "#808080" }} />
        <box style={{ height: 1 }} />
        <input
          style={{ height: 1, backgroundColor: "#0A0A0A" }}
          focused={true}
          placeholder="Search…"
          value={paletteQuery()}
          onInput={(v) => setPaletteQuery(v)}
          onSubmit={() => {
            const first = paletteMatches()[0];
            if (first) {
              openConversation(first.id);
              setPaletteOpen(false);
              setPaletteQuery("");
            }
          }}
        />
        <box style={{ height: 1 }} />
        <For each={paletteMatches()}>
          {(c) => <text content={`  ${convLabel(c)}`} style={{ fg: "#c0c0c0" }} />}
        </For>
      </box>
    </box>
  );
}

function StatusBar() {
  return (
    <box style={{ height: 1, flexDirection: "row", backgroundColor: "#0A0A0A", paddingLeft: 1 }}>
      <Show when={live() === "connecting"}>
        <Spinner color="gray" />
        <text content=" " />
      </Show>
      <Show when={live() !== "connecting"}>
        <text content={live() === "connected" ? "🟢 " : "🔴 "} />
      </Show>
      <text content={status()} style={{ fg: "gray" }} />
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
    if (e.ctrl && e.name === "k") {
      setPaletteOpen((v) => !v);
      setPaletteQuery("");
      return;
    }
    if (e.name === "escape") {
      if (paletteOpen()) setPaletteOpen(false);
      else setOpenId(null);
      return;
    }

    // conversation-list navigation (only when not typing in the palette or an
    // open conversation's composer)
    const typing = paletteOpen() || openId() !== null;
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
      <box style={{ flexDirection: "column", width: "100%", height: "100%", backgroundColor: "#0A0A0A" }}>
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <ConversationList />
          <MessagePane />
        </box>
        <StatusBar />
        <Show when={paletteOpen()}>
          <Palette />
        </Show>
      </box>
    </Show>
  );
}

