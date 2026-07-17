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

import { useKeyboard } from "@opentui/solid";
import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import type { SelectOption } from "@opentui/core";
import { Backend, type Conversation, type ChatMessage } from "./client";
import { ensureServer } from "./server";
import { Splash } from "./splash";

const backend = new Backend();

// ---- reactive state --------------------------------------------------------
const [conversations, setConversations] = createSignal<Conversation[]>([]);
const [openId, setOpenId] = createSignal<string | null>(null);
const [messages, setMessages] = createSignal<ChatMessage[]>([]);
const [loadingMessages, setLoadingMessages] = createSignal(false);
const [status, setStatus] = createSignal("connecting…");
const [live, setLive] = createSignal<"connecting" | "connected" | "disconnected">("connecting");
const [paletteOpen, setPaletteOpen] = createSignal(false);
const [paletteQuery, setPaletteQuery] = createSignal("");
const [draft, setDraft] = createSignal("");

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
  if (c.id.startsWith("48:")) return "Notes";
  return "(sans titre)";
}

// ---- backend wiring --------------------------------------------------------
async function refreshConversations() {
  try {
    const convs = await backend.conversations();
    setConversations(convs);
    setStatus(`${convs.length} conversations`);
  } catch (e: any) {
    setStatus(`error: ${e.message ?? e}`);
  }
}

async function openConversation(id: string) {
  setOpenId(id);
  setMessages([]);
  setLoadingMessages(true);
  try {
    // returns instantly from the SQLite cache; the network refresh (if any)
    // arrives later as a `messages_updated` event.
    const res = await backend.open(id);
    // guard against a slower response for a conversation we've since left
    if (openId() === id) setMessages(res.messages);
  } catch (e: any) {
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
    // live message: if it belongs to the open conversation, append it
    if (m.conversation_id === openId()) {
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    }
    // bump the conversation list ordering (refetch is cheap enough here)
    refreshConversations();
  });
  // background network refresh of an open conversation finished with new data
  backend.on("messages_updated", (d: { conversation: string; messages: ChatMessage[] }) => {
    if (d.conversation === openId()) {
      setMessages(d.messages);
      setLoadingMessages(false);
    }
  });
  backend.on("conversations_changed", () => refreshConversations());
  backend.on("realtime_status", (s: string) => setLive(s as any));
  backend.on("disconnected", () => setLive("disconnected"));
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
  const options = createMemo<SelectOption[]>(() =>
    conversations().map((c) => ({
      name: convLabel(c),
      value: c.id,
      description: "",
    })),
  );
  return (
    <box
      style={{
        width: 34,
        backgroundColor: "#141414",
        paddingTop: 1,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <select
        style={{ height: "100%", backgroundColor: "#141414" }}
        focused={!paletteOpen()}
        options={options()}
        onSelect={(_i, opt) => {
          if (opt?.value) openConversation(String(opt.value));
        }}
      />
    </box>
  );
}

function MessagePane() {
  const title = createMemo(() => {
    const id = openId();
    if (!id) return " Messages ";
    const c = conversations().find((x) => x.id === id);
    return ` ${c ? convLabel(c) : id} `;
  });
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
              <text
                content={loadingMessages() ? "loading messages…" : "No messages yet."}
                style={{ fg: "gray" }}
              />
            }
          >
            <For each={messages()}>
              {(m) => (
                <box style={{ flexDirection: "row", marginBottom: 0 }}>
                  <text content={`${m.sender}: `} style={{ fg: "green" }} />
                  <text content={plain(m.content)} />
                </box>
              )}
            </For>
          </Show>
        </Show>
      </scrollbox>
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
  const dot = createMemo(() =>
    live() === "connected" ? "🟢" : live() === "connecting" ? "⏳" : "🔴",
  );
  return (
    <box style={{ height: 1, flexDirection: "row", backgroundColor: "#0A0A0A", paddingLeft: 1 }}>
      <text content={`${dot()} ${status()}`} style={{ fg: "gray" }} />
    </box>
  );
}

export function App() {
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

  // global keys: Ctrl+K palette, Escape closes it / leaves conversation, Ctrl+C quits
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
    if (e.ctrl && e.name === "c") process.exit(0);
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

