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

## Highlights

- **⚡ Real-time messaging** — incoming messages appear on their own in under half a second.
- **⌨️ Keyboard-first** — navigate the whole app with the keyboard; a `Ctrl+K` command palette jumps to any conversation with fuzzy search.
- **💬 Clean chat view** — your messages align right, others align left, sender names show only where they matter (group chats).
- **🔔 Desktop notifications** — get a native Linux notification when a message lands in a conversation you're not looking at.
- **📴 Local-first** — conversations open instantly from a local cache, then refresh from the network in the background.
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
- **[Rust](https://rustup.rs/)** (stable toolchain) to build the backend.
- **[Bun](https://bun.sh/)** to run the terminal UI.
- **`notify-send`** (from `libnotify`) for desktop notifications — optional, but
  recommended.

## Getting started

```bash
# 1. Clone
git clone https://github.com/theophile-wallez/teams-lite.git
cd teams-lite

# 2. Build the backend (produces target/release/server)
cargo build --release --bin server

# 3. Install the UI dependencies
cd ui
bun install

# 4. Launch — one command starts everything
bun run src/index.tsx
```

The UI owns the backend: it spawns the Rust server, waits for it to come up,
connects, and shuts it down cleanly on exit. If a server is already running,
teams-lite simply attaches to it.

## Keyboard shortcuts

| Key                | Action                                             |
| ------------------ | -------------------------------------------------- |
| `Ctrl + K`         | Open the command palette (fuzzy jump to a chat)    |
| `↑` / `↓`, `j`/`k` | Move through the conversation list                 |
| `Enter`            | Open the selected conversation / send a message    |
| `Shift + Enter`    | New line in the message composer                   |
| `Esc`              | Close the palette, or leave the open conversation  |
| `Ctrl + C`         | Quit                                               |

## How it works

teams-lite follows a decoupled server/client model (the same shape as
[opencode](https://opencode.ai)): a Rust backend does all the real work and
exposes it over a local WebSocket, while a terminal UI renders state and sends
commands. The UI never touches the network or the database directly.

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
