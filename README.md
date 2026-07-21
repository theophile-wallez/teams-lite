<div align="center">

```
   ████████╗███████╗ █████╗ ███╗   ███╗███████╗   ██╗     ██╗████████╗███████╗
   ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║██╔════╝   ██║     ██║╚══██╔══╝██╔════╝
      ██║   █████╗  ███████║██╔████╔██║███████╗   ██║     ██║   ██║   █████╗
      ██║   ██╔══╝  ██╔══██║██║╚██╔╝██║╚════██║   ██║     ██║   ██║   ██╔══╝
      ██║   ███████╗██║  ██║██║ ╚═╝ ██║███████║   ███████╗██║   ██║   ███████╗
      ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝   ╚══════╝╚═╝   ╚═╝   ╚══════╝
```

### A fast, keyboard-first Microsoft Teams client that lives in your terminal.

No Electron. No browser. Just messages — in real time, on Linux.

![Platform](https://img.shields.io/badge/platform-Linux-1e1e1e?style=flat-square)
![Backend](https://img.shields.io/badge/backend-Rust-b7410e?style=flat-square)
![UI](https://img.shields.io/badge/UI-Bun%20%2B%20OpenTUI%20%2B%20Solid-000000?style=flat-square)
![Interface](https://img.shields.io/badge/interface-keyboard--first-2b5278?style=flat-square)
![Realtime](https://img.shields.io/badge/realtime-%3C500ms-2ea043?style=flat-square)
![Vibe-coded](https://img.shields.io/badge/100%25-vibe--coded-ff69b4?style=flat-square)

</div>

---

## What is teams-lite?

**teams-lite** is a lightweight, native Microsoft Teams messaging client for Linux.
It talks to Teams directly — real-time messages, conversation history, sending,
and desktop notifications — without spinning up a heavyweight desktop app.

It is built for people who live in the terminal and want their chat to be as
fast and as keyboard-driven as the rest of their workflow: open it, hit `Ctrl+K`,
type a name, and you're in the conversation.

> **Heads up:** teams-lite is an independent, unofficial client. It is not
> affiliated with or endorsed by Microsoft.

> **Vibe-coded:** this project is 100% vibe-coded — built end-to-end with AI
> coding agents, guided by intuition and momentum rather than a formal spec.
> Treat it accordingly: it's a fun, fast-moving experiment, not battle-tested
> production software. Read the code before you trust it.

## Highlights

- **⚡ Real-time messaging** — incoming messages appear on their own in under half a second.
- **⌨️ Keyboard-first** — navigate the whole app with the keyboard; a `Ctrl+K` command palette jumps to any conversation with fuzzy search.
- **💬 Clean chat view** — your messages align right, others align left, sender names show only where they matter (group chats).
- **🔔 Desktop notifications** — get a native Linux notification when a message lands in a conversation you're not looking at.
- **📴 Local-first** — conversations open instantly from a local cache, then refresh from the network in the background.
- **🌐 Terminal or browser** — the same fast client, two front-ends: a keyboard-first TUI, or a modern web UI (`teams --web`) that opens in your browser and talks to the same local backend.
- **🔐 Compliant sign-in** — authenticates silently through the Microsoft Identity Broker, so it satisfies your tenant's "compliant device" policies. No passwords are stored, and no raw tokens are ever logged.
- **🪶 Tiny footprint** — a Rust backend and a terminal UI. That's it.

## A look at the interface

```
┌────────────────────────────┬──────────────────────────────────────────────┐
│  Alice Martin              │  Design sync                                   │
│  Design sync           ◀   │                                                │
│  Platform team             │              Sounds good, shipping it today. ▐ │
│  Notes                     │  ▐ Nice — I'll review the PR after lunch.       │
│  Bob (Backend)             │              Perfect, thanks!                ▐ │
│  ...                       │                                                │
│                            │  ┌──────────────────────────────────────────┐ │
│                            │  │ Write a message… (Enter to send)          │ │
│                            │  └──────────────────────────────────────────┘ │
├────────────────────────────┴──────────────────────────────────────────────┤
│ 🟢 588 conversations                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Requirements

teams-lite signs in the same way the official Teams client does on a managed
Linux machine — through the **Microsoft Identity Broker** — so it needs:

- **Linux** with the **Microsoft Identity Broker** available on the session D-Bus
  (`com.microsoft.identity.broker1`). This ships with the Intune / Microsoft
  Entra sign-in components (e.g. the Intune Company Portal). Your work account
  must already be signed in on the device.
- **`notify-send`** (from `libnotify`) for desktop notifications — optional, but
  recommended.

Building from source additionally needs [Rust](https://rustup.rs/) and
[Bun](https://bun.sh/); the prebuilt binary needs neither.

## Getting started

Install the latest build and run it — that's the whole setup:

```bash
curl -fsSL https://raw.githubusercontent.com/theophile-wallez/teams-lite/master/install.sh | sh
teams
```

`teams` is a single, self-contained binary: it bundles the terminal UI, the
OpenTUI native library, **and** the Rust backend. On first launch it unpacks the
backend to `~/.cache/teams-lite`, starts it, connects, and shuts it down cleanly
on exit. If a server is already running, it simply attaches to it.

The installer drops the binary in `~/.teams-lite/bin` (override with
`TEAMS_LITE_HOME`) and links it onto your `PATH` when it can.

## Web UI (`teams --web`)

Prefer a browser? Run:

```bash
teams --web
```

This starts the backend (or attaches to a running one), serves a modern web
client locally, and opens it in your browser — the same idea as
`opencode web`. The web UI is a [TanStack Start](https://tanstack.com/start)
app (server-side rendered, React 19, Tailwind + shadcn-style components) and
talks to the **same** local backend over the same WebSocket, so it is just as
local-first as the terminal UI: your data never leaves your machine.

It ships **inside** the single `teams` binary — no extra install, no Node, no
`node_modules`. The whole web bundle is embedded and unpacked to
`~/.cache/teams-lite/web` on first launch.

| Flag             | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `--port <n>`     | Port to serve the web UI on (default `4321`)            |
| `--host <h>`     | Host/interface to bind (default `127.0.0.1`)            |
| `--no-open`      | Don't open the browser automatically                    |

Everything is served on `127.0.0.1` by default, so it stays on your machine.

## Build from source

For development, or to build the binary yourself:

```bash
# 1. Clone
git clone https://github.com/theophile-wallez/teams-lite.git
cd teams-lite

# 2. Install dependencies (terminal UI + web UI)
cd ui && bun install && cd ..
cd web && bun install && cd ..

# 3a. Run straight from source (spawns the debug/release backend it finds)
cargo build --release --bin server
cd ui && bun run start            # terminal UI
#   …or the web UI in dev (Vite + HMR), against a mock backend:
cd web && bun run dev             # then, in another shell: bun run mock

# 3b. …or produce the single `teams` binary (backend + web UI embedded)
cargo build --release --bin server
cd ui && bun run build            # -> ui/dist/teams   (also builds & embeds web/)
./ui/dist/teams --web             # run the browser UI from the binary
```

The `teams` binary embeds the terminal UI, the Rust backend, **and** the web UI.
`bun run build` builds the web app and bundles it in automatically; set
`TEAMS_SKIP_WEB=1` to skip it for a faster terminal-only build.

Every push to `master` builds this binary in CI and publishes it as the rolling
`latest` release that `install.sh` downloads.

## Testing

```bash
cargo test                       # Rust backend
cd ui  && bun test               # terminal UI (deterministic subset runs in CI)
cd web && bun run test           # web unit tests (Vitest)
cd web && bun run test:e2e       # web end-to-end (Playwright, headless Chromium)
```

The web E2E suite boots the backend **mock** (`web/mock/server.ts`) and the SSR
server, then drives a real browser through the whole app — connecting, opening
conversations, sending/replying/copying, infinite history, the command palette,
the theme picker, keyboard navigation, and live incoming messages. Pull requests
run Rust, UI, web unit, typecheck, and E2E via `.github/workflows/ci.yml`.


## Keyboard shortcuts

Both the terminal and web UIs share the same shortcuts:

| Key                | Action                                             |
| ------------------ | -------------------------------------------------- |
| `Ctrl + K`         | Open the command palette (fuzzy jump to a chat)    |
| `Ctrl + P`         | Open the theme picker (live preview, 34 themes)    |
| `↑` / `↓`, `j`/`k` | Move through the conversation list                 |
| `Enter`            | Open the selected conversation / send a message    |
| `Shift + Enter`    | New line in the message composer                   |
| `Esc`              | Close the palette, or leave the open conversation  |
| `Ctrl + C`         | Quit                                               |

## How it works

teams-lite follows a decoupled server/client model (the same shape as
[opencode](https://opencode.ai)): a Rust backend does all the real work and
exposes it over a local WebSocket, while a front-end renders state and sends
commands. The front-end never touches the network or the database directly.

There are two interchangeable front-ends, both speaking the same WebSocket
protocol to the same backend: the **terminal UI** (OpenTUI + Solid, shown
below) and the **web UI** (`teams --web` — TanStack Start SSR, served locally
and opened in your browser). Whichever you run, the backend and the local-first
store are identical.

```
        ┌───────────────────────────┐        ws://127.0.0.1:8420        ┌──────────────────────┐
        │      UI  (Bun process)     │  ─────────── JSON RPC ─────────▶  │   Backend (Rust)     │
        │  OpenTUI + Solid terminal  │                                   │                      │
        │  • renders conversations   │  ◀──────── live events ─────────  │  • auth broker (D-Bus)│
        │  • command palette         │                                   │  • real-time client   │
        │  • spawns & owns backend ──┼───────────── child process ─────▶ │  • local SQLite store │
        └───────────────────────────┘                                   │  • send / name lookup │
                                                                          └──────────┬───────────┘
                                                                                     │
                                                                          Microsoft Teams services
```

- **Auth broker** — mints device-compliant access tokens via the machine's
  Primary Refresh Token, refreshing silently before they expire.
- **Real-time** — a long-lived connection delivers new messages the moment they
  arrive and re-authenticates itself on reconnect.
- **Local-first store** — a local SQLite database serves history instantly;
  network refreshes happen in the background and stream in as updates.

## Privacy & security

- Everything runs on your machine. The backend listens only on `127.0.0.1`.
- Sign-in goes through the OS-level Microsoft Identity Broker — teams-lite never
  sees or stores your password.
- No raw tokens are ever written to logs or sent to the UI.

## Project status

teams-lite is young and focused on doing one thing well: fast, real-time 1:1 and
group messaging. Expect rough edges, and expect it to get better.

## License

No license has been chosen yet, so all rights are reserved by default. If you'd
like to use, distribute, or contribute to teams-lite, please open an issue to
start the conversation.
