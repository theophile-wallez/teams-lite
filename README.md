<div align="center">

```
   ████████╗███████╗ █████╗ ███╗   ███╗███████╗   ██╗     ██╗████████╗███████╗
   ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║██╔════╝   ██║     ██║╚══██╔══╝██╔════╝
      ██║   █████╗  ███████║██╔████╔██║███████╗   ██║     ██║   ██║   █████╗
      ██║   ██╔══╝  ██╔══██║██║╚██╔╝██║╚════██║   ██║     ██║   ██║   ██╔══╝
      ██║   ███████╗██║  ██║██║ ╚═╝ ██║███████║   ███████╗██║   ██║   ███████╗
      ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝   ╚══════╝╚═╝   ╚═╝   ╚══════╝
```

### A fast, keyboard-first Microsoft Teams client for Linux.

No Electron. A Rust backend and one web app. Just messages — in real time.

![Platform](https://img.shields.io/badge/platform-Linux-1e1e1e?style=flat-square)
![Backend](https://img.shields.io/badge/backend-Rust-b7410e?style=flat-square)
![UI](https://img.shields.io/badge/UI-Bun%20%2B%20React%20%2B%20TanStack%20Start-000000?style=flat-square)
![Interface](https://img.shields.io/badge/interface-keyboard--first-2b5278?style=flat-square)
![Realtime](https://img.shields.io/badge/realtime-%3C500ms-2ea043?style=flat-square)
![Vibe-coded](https://img.shields.io/badge/100%25-vibe--coded-ff69b4?style=flat-square)

</div>

---

## What is teams-lite?

**teams-lite** is a lightweight Microsoft Teams client for Linux. A Rust backend
talks to Teams directly — real-time messages, conversation history, sending,
notifications — and a local web app renders it in the browser you already have,
instead of shipping a second one inside a desktop app.

It is built for people who want their chat to be as fast and as keyboard-driven as
the rest of their workflow: run `teams`, hit `Ctrl+K`, type a name, and you're in
the conversation.

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
- **🔔 Notifications** — a desktop notification when a message lands in a conversation you're not looking at, and Web Push to your phone while the app is closed.
- **📴 Local-first** — conversations open instantly from a local cache, then refresh from the network in the background.
- **🌐 One command** — `teams` starts the backend, serves the app on `127.0.0.1` and opens it in your browser. Nothing leaves your machine.
- **📬 Your mail, read-only** — a Mail tab next to Chats and Channels: the same account's Outlook mailbox over Microsoft Graph, cached locally like everything else. Bodies are sanitized server-side and **no remote image is ever loaded**, so reading a message tells its sender nothing. It cannot send, reply, delete or move — by construction, not by configuration.
- **🗓️ Your calendar, read-only** — a Calendar tab with month, week, day and agenda views over the same account's Teams/Outlook calendar. Recurring meetings, multi-day events, overlapping meetings and every calendar you subscribe to, colour-coded and cached locally. It cannot create, move, cancel or answer an invitation — by construction, not by configuration: creating an event would mail every attendee, and answering one would mail the organizer.
- **🔗 Rich link previews** — paste a **Linear** issue, project or document, or a **GitLab** merge request, issue or project, and the link becomes a card: title, state, who owns it, labels, a merge request's live CI status, a project's progress. Add a token per tracker in Settings; both are read-only, so a preview can never change an issue.
- **🔐 Compliant sign-in** — authenticates silently through the Microsoft Identity Broker, so it satisfies your tenant's "compliant device" policies. No passwords are stored, and no raw tokens are ever logged.
- **🪶 Tiny footprint** — a Rust backend and one web app. That's it.

## What is in the app

A sidebar with four tabs, and a pane that shows whatever you opened:

| Tab          | What it holds                                                 |
| ------------ | ------------------------------------------------------------- |
| **Chats**    | your 1:1 and group conversations, newest first                 |
| **Channels** | your teams, each expanding into the channels you show          |
| **Mail**     | the same account's Outlook mailbox — read-only                 |
| **Calendar** | month, week, day and agenda views — read-only                  |

Settings sits in its own pane, reached from the sidebar: a token per tracker,
notifications for this device, ghost mode, and the local agent.

## Requirements

teams-lite signs in the same way the official Teams client does on a managed
Linux machine — through the **Microsoft Identity Broker** — so it needs:

- **Linux** with the **Microsoft Identity Broker** available on the session D-Bus
  (`com.microsoft.identity.broker1`). This ships with the Intune / Microsoft
  Entra sign-in components (e.g. the Intune Company Portal). Your work account
  must already be signed in on the device. Both Intune deployments are supported
  automatically:
    - **Classic Intune** — the broker runs as your user on the host session bus;
      teams-lite talks to it directly.
    - **Containerized Intune** — the broker runs inside a rootless container as
      your user, on the container's own bus; the `teams` launcher points D-Bus at
      that bus and teams-lite connects directly. No `sudo`, no privileges.
- **A browser.** Any current Chrome, Edge or Firefox renders the app; the same page
  installs as a web app, which is what lets a phone be notified while it is closed.

Building from source additionally needs [Rust](https://rustup.rs/) and
[Bun](https://bun.sh/); the prebuilt binary needs neither.

## Getting started

Install the latest build and run it — that's the whole setup:

```bash
curl -fsSL https://raw.githubusercontent.com/theophile-wallez/teams-lite/master/install.sh | sh
teams
```

`teams` is a single, self-contained binary. It bundles the Rust backend **and** the
web app, so one command starts everything — the same idea as `opencode web`:

1. it starts the backend, or attaches to one that is already running,
2. it serves the app on `127.0.0.1:19440`,
3. it opens your browser there.

On first launch it unpacks the backend to `~/.cache/teams-lite` and the web bundle
to `~/.cache/teams-lite/web`. No extra install, no Node, no `node_modules`.

The installer drops the binary in `~/.teams-lite/bin` (override with
`TEAMS_LITE_HOME`) and links it onto your `PATH` when it can.

**Staying up to date takes two clicks.** There is no version number — every push to
master publishes a rolling `latest` build — so the app checks once at startup whether a
newer commit is published and, if it is, offers it as a button at the bottom of the
sidebar: press it to download the new build (it shows the progress), press it again to
install it and restart onto it. Nothing downloads on its own, and re-running the
installer above still works exactly as before.

The app itself is a [TanStack Start](https://tanstack.com/start) app (server-side
rendered, React 19, Tailwind + shadcn-style components). It reaches the backend over
the same local WebSocket everything else does, so your data never leaves your
machine.

| Flag             | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `--port <n>`     | Port to serve the app on (default `19440`)                |
| `--host <h>`     | Host/interface to bind (default `127.0.0.1`)             |
| `--no-open`      | Don't open the browser automatically                     |
| `--dev`          | Serve through Vite instead, so edits hot-reload           |
| `--help`         | Print the flags and exit                                 |

Everything is served on `127.0.0.1` by default, so it stays on your machine.
`--web` is still accepted and does nothing: it used to pick the browser over a
terminal UI, and the terminal UI is gone.

### From another device (phone, tablet) over Tailscale

The app is usable from a phone without opening the backend to the network. Put a
[Tailscale](https://tailscale.com) proxy in front of the app server — the backend
itself keeps listening on loopback only:

```bash
# on the machine running teams-lite
tailscale serve --bg --https=8443 http://127.0.0.1:19440
# then open https://<machine>.<tailnet>.ts.net:8443 on the phone
```

The page notices it was not served from the backend's own machine and asks the
web server to relay the WebSocket instead of dialling `127.0.0.1:19420` — which,
from a phone, would be the phone. That relay lives in `web/server.ts` (and as a
Vite proxy in dev), so exactly one port is ever exposed, over Tailscale's own
authenticated HTTPS.

Two things worth knowing before you do it:

- **Anything on your tailnet that can reach that port gets your Teams account**,
  send included: the page fetches the backend's write token from the same server.
  Keep it `tailscale serve` (tailnet-only) — never `tailscale funnel`, which
  publishes it to the whole internet.
- A backgrounded mobile tab has its timers frozen and its socket dropped; the app
  reconnects when you come back to it rather than showing "backend lost".

### Notifications on the phone (install it as an app)

The app is installable, and an installed one can be notified while it
is **closed** — that is the difference between a bookmark and something you can
actually rely on for messages.

On iPhone or iPad:

1. Open the tailnet HTTPS address in Safari (`https://<machine>.<tailnet>.ts.net:8443`).
2. Tap **Share → Add to Home Screen**. iOS only offers Web Push to a Home Screen
   web app, never to a Safari tab.
3. Open teams-lite **from the new icon**, then go to **Settings → Notifications** and
   turn on *This device*. iOS asks for permission at that tap — it refuses to ask any
   other way, which is why there is a switch rather than a prompt on startup.
4. Use **Send a test notification** to prove the whole chain before trusting it.

Android and desktop Chrome, Edge or Firefox work the same way (install optional).

What you get, and what you do not:

- A notification for a **chat** message, and for a **channel** post that @mentions
  you. Channel chatter that is not about you stays silent, as it does in Teams.
- Nothing for your own messages, for system lines ("call ended", "member added"), or
  for a message that is already several minutes old when it reaches the backend.
- Delivery needs the backend running, which is what the systemd service below is
  for. A laptop with the service stopped notifies nobody.
- The notification text is **encrypted to your device** (RFC 8291): Apple or Google
  forward bytes they cannot read. They do see that a message arrived, and when.

### Always on (systemd service)

`teams` lives as long as the shell you started it from. To keep the app reachable from
your phone at any hour — including after a reboot, with no session open — install it
as a pair of **systemd user services**:

```bash
bin/teams-lite-service.sh install     # build, stage, write the units
bin/teams-lite-service.sh tailscale   # publish it on your tailnet over HTTPS
systemctl --user enable --now teams-lite.target   # start it (and at every boot)
```

| Unit                             | What it runs                                          |
| -------------------------------- | ----------------------------------------------------- |
| `teams-lite-backend.service`     | the Rust backend on `ws://127.0.0.1:19420`            |
| `teams-lite-web.service`         | the production SSR server on `127.0.0.1:19440`        |
| `teams-lite-app.service`         | *optional* — the released `teams` build, 19422 / 19442  |
| `teams-lite-broker-bus.path`     | restarts the backend when the Intune container moves   |
| `teams-lite-broker-health.timer` | checks the sign-in keyring every 15 minutes            |
| `teams-lite-broker-repair.service` | restarts the Intune container when that keyring locked |
| `teams-lite.target`              | one handle for all of the above                        |

```bash
bin/teams-lite-service.sh status      # units, ports, staged commit, broker, tailscale
bin/teams-lite-service.sh logs -f     # both journals, interleaved
bin/teams-lite-service.sh update      # rebuild, restage, restart what is running
bin/teams-lite-service.sh uninstall   # remove the units (keeps your data)
```

Worth knowing:

- **It runs a promoted copy, not your working tree.** `install` and `update` build,
  then stage the release binary and the web bundle into
  `~/.local/share/teams-lite/service` with the commit recorded next to them. Your
  checkout can then be rebuilt, switched or tested without changing what the service
  serves — and it never picks up the `web/dist` an E2E run leaves behind, which is
  built to dial a mock.
- **`update` restarts only what is already running**, so it never starts a service you
  chose to keep down.
- **It survives a reboot** thanks to lingering (`loginctl enable-linger`, which
  `status` checks) — no session needed. The `tailscale serve` mapping persists on its
  own, in tailscaled's state.
- **It retries forever, slowly.** If the identity broker is down, the backend fails to
  start and systemd backs off from 5 s to 5 min rather than giving up — so a laptop
  that comes back, or an Intune container that restarts, heals itself.
- **Local overrides** go in `~/.config/teams-lite/backend.env` and `web.env`; an
  update leaves both alone. Audio calling is not one of them: it is a setting
  (Settings › Audio calls), off until you turn it on, because turning it on registers
  this machine with Teams as a device your calls ring on.
- **The dev stack has ports of its own** — backend 19421, Vite 19441 — so
  `bun run dev:server` + `bun run dev` work while the service keeps running on
  19420/19440. Both are send-capable backends over one SQLite store, so they get
  separate ports rather than fighting for one.
- **You can run the RELEASED build at the same time**, on 19422 / 19442, and it is the
  only install that updates itself from inside the app (the button in the sidebar).
  The service above follows your checkout; this one follows CI, which is how you find
  out that the published build is broken before anybody else does:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/theophile-wallez/teams-lite/master/install.sh | sh
  bin/teams-lite-service.sh units                       # writes teams-lite-app.service
  systemctl --user enable --now teams-lite-app.service   # start it (and at every boot)
  ```

  It shares your message store — as the dev backend already does — and answers on
  `http://127.0.0.1:19442`. For your phone, give it a port of its own:
  `tailscale serve --bg --https=8444 http://127.0.0.1:19442`.

#### When sign-in breaks

On a **containerized-Intune** host the container's login keyring re-locks on its own,
roughly every eighteen hours. The identity broker then answers no token call at all, and
nothing else looks wrong: the socket stays up, the backend stays `active (running)`, the
live dot stays green — and the app has no chats, mail or calendar.

teams-lite handles that itself now:

- **It says so.** A banner in the sidebar names the cause instead of leaving an empty
  list, on every tab, with a **Repair sign-in** button. For a failure a container
  restart cannot fix — an expired sign-in that needs you at a browser — the button stays
  visible but inert and says why.
- **It repairs itself.** Three triggers share one rate-limited unit
  (`teams-lite-broker-repair.service`, at most three times an hour): the backend when a
  token call fails with that signature, `teams-lite-broker-health.timer` every 15
  minutes, and the button. The health timer matters most: with nobody in Mail or the
  Calendar the backend makes no broker calls at all, so an outage at 03:00 would
  otherwise wait for you to notice.
- **It never restarts the container on a guess.** Every trigger checks the keyring's
  actual `Locked` property first, and the repair unit checks again as its own
  `ExecCondition` — so a button pressed on a healthy system does nothing.

To look, or to repair by hand:

```bash
bin/teams-lite-broker-check.sh            # is the keyring locked?
intune-container doctor                   # the whole Intune stack
intune-container stop && intune-container start   # the manual repair
```

A bare `intune-container start` does **not** fix it: on a running container it
short-circuits and never re-runs the session setup that unlocks the keyring.

### Dev mode (`teams --dev`)

Working on the app? Use:

```bash
teams --dev
```

It does everything plain `teams` does — starts (or attaches to) the backend,
holds it alive, opens the browser, honors `--port`/`--host`/`--no-open` — but
serves the app through Vite's dev server, so your edits **hot-reload** in the
browser instead of running the pre-built SSR bundle. It runs against the repo's
`web/` sources, so it only works from a source checkout (`bun run`), not from
the compiled single-file binary. The backend it spawns runs with idle-exit
disabled (`TEAMS_NO_IDLE_EXIT`), so closing or reloading the browser tab won't
take the backend down between hot reloads.

## Build from source

For development, or to build the binary yourself:

```bash
# 1. Clone
git clone https://github.com/theophile-wallez/teams-lite.git
cd teams-lite

# 2. Install dependencies (the app + the `teams` command)
cd web && bun install && cd ..
cd launcher && bun install && cd ..

# 3a. Run straight from source (spawns the debug/release backend it finds)
cargo build --release --bin server
cd launcher && bun run start      # the whole thing, as `teams` would
#   …or the app alone in dev (Vite + HMR), against a mock backend:
cd web && bun run dev:mock        # mock on 19455, app on 19445
#
#   …or drive the REAL backend + web dev server yourself, two terminals from web/.
#   `dev:server` runs the backend from source with idle-exit disabled
#   (TEAMS_NO_IDLE_EXIT) so it stays up across browser reloads/inactivity and only
#   stops on Ctrl+C, and it bridges D-Bus to the Identity Broker the same way the
#   production launcher does (so sign-in works from source, incl. containerized
#   Intune). This pair uses ports of its own — backend 19421, app 19441 — so it runs
#   happily alongside the always-on service on 19420/19440. See bin/teams-dev-server.sh:
cd web
bun run dev:server                # terminal 1  (real backend on 19421, kept alive)
bun run dev                       # terminal 2  (Vite HMR on 19441, against :19421)

# 3b. …or produce the single `teams` binary (backend + app embedded)
cargo build --release --bin server
cd launcher && bun run build      # -> launcher/dist/teams (also builds & embeds web/)
./launcher/dist/teams             # run it
```

`bun run build` builds the web app and bundles it in automatically, so the binary
carries the Rust backend and the app together.

Every push to `master` builds this binary in CI and publishes it as the rolling
`latest` release that `install.sh` downloads.

## Testing

```bash
cargo test                       # Rust backend
cd web && bun run test           # app unit tests (Vitest)
cd web && bun run typecheck      # app types
cd web && bun run test:e2e       # app end-to-end (Playwright, headless Chromium)
cd launcher && bun test          # the `teams` command line
```

The web E2E suite boots the backend **mock** (`web/mock/server.ts`) and the SSR
server, then drives a real browser through the whole app — connecting, opening
conversations, sending/replying/copying, infinite history, the command palette,
the appearance picker, keyboard navigation, and live incoming messages. Pull requests
run Rust, the launcher, web unit, typecheck, and E2E via
`.github/workflows/ci.yml`.


## Keyboard shortcuts

`Cmd` works everywhere `Ctrl` does, so a Mac keyboard needs no translation.

| Key                | Action                                             |
| ------------------ | -------------------------------------------------- |
| `Ctrl + K`         | Open the command palette (fuzzy jump to a chat)    |
| `Ctrl + P`         | Open Settings (appearance, tokens, notifications)  |
| `↑` / `↓`, `j`/`k` | Move through the conversation or mail list         |
| `Enter`            | Open the selected row / send a message             |
| `Shift + Enter`    | New line in the message composer                   |
| `Esc`              | Cancel a reply, or leave what you opened           |

## How it works

teams-lite follows a decoupled server/client model (the same shape as
[opencode](https://opencode.ai)): a Rust backend does all the real work and
exposes it over a local WebSocket, while the app renders state and sends
commands. The app never touches the network or the database directly.

Three processes, all on your machine. The `teams` command owns the other two: it
spawns the backend as a child and serves the app, so one command is the whole
stack. The browser page talks to the backend directly when it runs on this machine,
and through the app server's relay when it does not (a phone on the tailnet), which
is why exactly one port is ever exposed.

```
   ┌──────────────────────────┐                            ┌───────────────────────┐
   │ Browser page             │      ws (JSON RPC)         │ Backend (Rust)        │
   │ React + TanStack Start   │ ─────────────────────────▶ │ • auth broker (D-Bus) │
   │ • conversations, mail    │ ◀─────── live events ───── │ • real-time client    │
   │ • command palette        │                            │ • local SQLite store  │
   └────────────┬─────────────┘                            │ • send / name lookup  │
                │                                          └───────────┬───────────┘
                │ HTTP: SSR, assets, and the                           │
                │ WebSocket relay when remote                          ▼
   ┌────────────┴─────────────┐                            Microsoft Teams services
   │ teams (Bun)              │
   │ • serves the app         │ ── spawns as a child ──▶ the backend above
   │ • owns its lifecycle     │
   └──────────────────────────┘
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
- No raw tokens are ever written to logs or sent to the app.
- Push notifications carry message text through Apple's or Google's push service, so
  that text is encrypted to the subscribed device and unreadable in transit (RFC
  8291). A subscription may only point at one of those services' own hosts, and
  registering one needs the backend's write token — a client that merely found the
  socket cannot aim your messages anywhere.

## Project status

teams-lite is young and focused on doing one thing well: fast, real-time 1:1 and
group messaging. Expect rough edges, and expect it to get better.

## License

No license has been chosen yet, so all rights are reserved by default. If you'd
like to use, distribute, or contribute to teams-lite, please open an issue to
start the conversation.
