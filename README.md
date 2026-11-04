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
      your user, on the container's own bus. teams-lite finds that bus itself, on
      every connection, from the container's own state (through the
      [`intune-container`](https://github.com/magicabdel/intune-container) crate), so
      it follows the container across a restart with nothing to configure. No `sudo`,
      no privileges.
    - **Neither, in the container image** — the image boots an Intune container of its
      own and enrolls it from the app (or imports an existing enrollment), so the host
      needs no Intune install. It does need: an **x86_64** machine (or node); Docker (or
      Kubernetes) on **cgroup v2** — the unified hierarchy, which older distributions'
      defaults such as Ubuntu 20.04 and RHEL 8 do not use; a kernel that permits
      **unprivileged user namespaces** (Ubuntu 23.10 and later restrict them by default —
      [one sysctl](#in-a-container-docker) lifts that); a container allowed to run a systemd
      (three security options unconfined, or a privileged pod) and never under
      `no-new-privileges`; and, for the first start, about 1.7 GB from `ghcr.io` and 8 GiB of
      disk. See [In a container](#in-a-container-docker).
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
master publishes a rolling `latest` build — so the app watches for a newer commit every
two minutes and, when one is published, offers it as a button at the bottom of the sidebar:
press it to download the new build (it shows the progress), press it again to install it
and restart onto it. You do not have to restart the app to be offered an update, which is
what it used to take. Nothing downloads on its own, and re-running the
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
| `teams-lite.target`              | one handle for the backend and the web server          |

Nothing in that list watches the Intune container. The backend follows the container's bus and
checks its sign-in keyring itself (see [When sign-in breaks](#when-sign-in-breaks)), so the
units an older install used for that — a `.path`, a health timer and a repair unit — are
removed by the next `update`, which also restarts the backend onto the build that no longer
needs them. `install` and `units` remove them too, except while the backend that is RUNNING
is still an older build that relies on them: they restart nothing, so they keep the three it
lives by, say so, and leave the restart to you
(`systemctl --user try-restart teams-lite-backend.service`). And `units`, which stages
nothing, refuses outright in front of a staged backend older than the units it writes —
`update` is the command for that machine, and `status` says so.

```bash
bin/teams-lite-service.sh status      # units, ports, staged commit, Intune, tailscale
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
- **A broken sign-in never takes it down.** If the identity broker is down, the backend
  starts anyway and serves the history it has already stored, and keeps asking — every
  attempt looks for the broker's bus again, so a laptop that comes back, or an Intune
  container that restarts, heals itself with no restart of teams-lite. If the backend
  itself dies, systemd brings it back, backing off from 5 s to 5 min rather than giving up.
- **Local overrides** go in `~/.config/teams-lite/backend.env` and `web.env`; an
  update leaves both alone. Audio calling is not one of them: every install registers this
  machine with Teams as a device your calls ring on, like every other client you are
  signed in on, and no setting anywhere turns that off — a window that could not call
  would offer you a disabled handset and no way to mend it.
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

  `units` rewrites every unit, the service's own included, so it needs the service staged
  first (`install` above) — and from a build recent enough to find the identity broker
  itself; on an older one it refuses and asks for `update`.

  It shares your message store — as the dev backend already does — and answers on
  `http://127.0.0.1:19442`. For your phone, give it a port of its own:
  `tailscale serve --bg --https=8444 http://127.0.0.1:19442`.

#### When sign-in breaks

On a **containerized-Intune** host the container's login keyring re-locks on its own,
roughly every eighteen hours. The identity broker then answers no token call at all, and
nothing else looks wrong: the socket stays up, the backend stays `active (running)`, the
live dot stays green — and nothing new arrives or leaves. The app keeps showing what it had
already stored, and no more.

teams-lite handles that itself now:

- **It says so.** A banner in the sidebar names the cause instead of leaving an empty
  list, on every tab, with a **Repair sign-in** button. For a failure a container
  restart cannot fix — an expired sign-in that needs you at a browser — the button stays
  visible but inert and says why. While a repair runs the banner says **Repairing…** until
  it ends, whatever the broker looks like in the minute the container is down.
- **It repairs itself.** Three triggers ask for one repair: the backend when a token call
  fails with that signature, a keyring check the backend runs every 15 minutes, and the
  button. The 15-minute check matters most: with nobody in Mail or the Calendar the
  backend makes no broker calls at all, so an outage at 03:00 would otherwise wait for you
  to notice. Automatic repairs are limited to three an hour across the whole machine, so
  several teams-lite installs sharing one store share one budget; a press of the button is
  never refused for that.
- **It never restarts the container on a guess, or twice.** Every trigger first asks whether
  a repair is already running anywhere on the machine, and follows it rather than starting
  another; then it reads the keyring's actual `Locked` property, and the repair reads it again
  before it touches anything and once more after it holds the container's lock — so a button
  pressed on a healthy system restarts nothing, and says why: the keyring is unlocked, the
  container is not running (start it with `intune-container start` if it does not come back),
  or intune-container is not set up on this machine.
- **It goes through the `intune-container` crate, not your shell.** The repair is the
  teams-lite binary itself, run as a short-lived systemd unit of your own user
  (`teams-lite-intune-repair.service`, so it outlives any restart of the backend that asked
  for it). It stops the container and boots it again under the same lock every
  `intune-container` command takes, and the backend stays up throughout and follows the
  container to its new bus on its own. It never updates the container's image while it does:
  a new image would mean deleting the old one and downloading the whole thing with the
  container already stopped, so that waits for your own next `intune-container start`. Its
  log is `journalctl --user -t teams-lite-broker-repair`; the unit ends `failed` when the
  restart did not unlock the keyring, or when nothing was restarted because nothing could be
  told.

To look, or to repair by hand:

```bash
cargo run --example intune_status         # where is the broker, is the keyring locked? (read-only)
intune-container status                   # is the container running?
intune-container doctor                   # the whole Intune stack
intune-container stop && intune-container start   # the manual repair
```

`intune_status` runs from a source checkout and changes nothing: it finds the container the
way the backend does, reads one property, and exits 0 when the keyring is unlocked, 1 when it
is locked and 2 when it cannot tell.

A bare `intune-container start` does **not** fix it: on a running container it
short-circuits and never re-runs the session setup that unlocks the keyring.

### In a container (Docker)

The same app, built from this checkout into one image — no Rust, Bun, systemd units or
intune-container on the host. **By default the container is self-contained**: it boots its own
Intune container inside itself, and the device's enrollment lives in a volume of its own.

```bash
docker compose -f packaging/docker/compose.yaml build
docker compose -f packaging/docker/compose.yaml up -d
```

Or skip the build: every push to `master` publishes the image to
`ghcr.io/theophile-wallez/teams-lite` (`latest`, and `build-<sha>` per commit), built for uid
1000 — `export TEAMS_LITE_IMAGE=ghcr.io/theophile-wallez/teams-lite:latest`, then
`docker compose -f packaging/docker/compose.yaml pull` instead of `build`. (A fork's CI publishes
under the fork's own owner instead.)

Then open <http://127.0.0.1:19443>. The **first start downloads the Intune container's image,
`ghcr.io/magicabdel/intune-container:latest`** (about 1.7 GB, into the `intune` volume — leave it
8 GiB of disk), and the app says "Setting up the Intune container…" while it runs. That image is the
[intune-container](https://github.com/magicabdel/intune-container) project's, **not Microsoft's** —
by that project's own Dockerfile, a third-party Ubuntu base carrying Microsoft's Intune agent and
identity broker, plus a virtual display. It becomes this install's identity broker and the keyring holding its enrollment, so it is
worth knowing that it is a moving `latest` tag, taken as it stands on the day of the first start
and never updated after that. It runs beside any other install on its own ports (backend 19423, web
19443, published on `127.0.0.1` only), and is always on. Read where it stands with
`docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status`, and its
log with `… logs -f`.

**Enroll it — once.** Either:

- **From the app.** Once the container is up, the sidebar's banner offers **Enroll this device**,
  and the Intune portal's own window opens in the page: sign in with your work account and follow
  its steps (if it shows a number, enter it in your Authenticator app). Close the portal once it
  says the device is registered.
- **Import an existing enrollment.** On the machine that is already enrolled, make a backup —
  this stops that machine's Intune container and starts it again, about a minute:

  ```bash
  intune-container backup -o enrollment-backup.tar.gz
  ```

  Keep the archive **outside this checkout** (it holds the device's keys) and point compose at it,
  then uncomment the import bind and the `TEAMS_LITE_INTUNE_IMPORT` line in
  `packaging/docker/compose.yaml` and start it:

  ```bash
  export TEAMS_LITE_INTUNE_BACKUP=/path/to/enrollment-backup.tar.gz
  docker compose -f packaging/docker/compose.yaml up -d
  ```

  It is imported once, on the first start that finds no device registration, and never over one.
  **Then stop using that enrollment on the machine it came from** (`intune-container stop`, and
  leave it stopped): this is a move, not a copy — two live copies of one device are untested, and
  Intune may revoke both. Once it is imported, delete the archive and comment the bind out again.

**On Ubuntu 23.10 or later (24.04 LTS included)** the host has to allow unprivileged user
namespaces, which Ubuntu restricts by default — the Intune container cannot boot otherwise, and the
container's log says so at every start until it is done:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-teams-lite-userns.conf
```

Things to know:

- **The `intune` volume is the enrollment.** `docker compose … down -v` (or a `docker volume rm`)
  deletes it, and only a new enrollment or a backup brings it back. A plain stop is safe: the
  container powers its Intune container off cleanly first, and in the rare case that poweroff takes
  longer than its twenty seconds, the log says so rather than claiming a clean stop.
- **Pick its uid once.** The image is built for uid 1000 unless you say otherwise, and in this mode
  that uid owns the Intune state: an image rebuilt for another uid finds the volume owned by the old
  one and cannot boot it. To bring your existing history along by binding your host store (the
  compose file shows how), build for your own uid first — `export TEAMS_LITE_UID=$(id -u)
  TEAMS_LITE_GID=$(id -g)` — since the container never re-owns a host directory.
- **It is packaging, not a sandbox.** Booting a systemd inside a container takes three security
  options (`seccomp`, `systempaths` and `apparmor` unconfined); the container stays unprivileged and
  gains no capability. It needs a network and an IPC namespace of its own: it refuses to start in
  the host's IPC namespace (`--ipc host`), in the host's network namespace where the kernel lets it
  tell (`--network host`, on a recent kernel), and wherever another Intune container already holds
  its display. Host networking is unsupported in this mode either way — use the host-broker file
  below instead. (The host's network is recognised as the kernel's INITIAL network namespace,
  which under a microVM runtime such as Kata is the guest's own: there, and only there, declare it
  with `TEAMS_LITE_NETNS_IS_OWN=1` — the compose file shows where. Untested.)
- **Repairs itself, does not update itself.** A locked Intune keyring is repaired by the container
  on its own; a new teams-lite version is a rebuilt image.
- **Installs the `@claude` agent's CLIs from the app, and keeps them current.** Neither is in the
  image (Claude Code is Anthropic's, all rights reserved), so Settings › AI providers offers an
  **Install** for each: it downloads the CLI from its vendor, checks it (Anthropic's signed release
  manifest; GitHub's digest for opencode), keeps it on the data volume with its login and sessions,
  and updates the copies it installed on its own unless you switch that off. Sign one in with
  `docker exec -it teams-lite teams-lite-agent claude auth login`, or give the container an
  `ANTHROPIC_API_KEY`. ripgrep is in the image for opencode's searches.

**Already enrolled on this machine?** `packaging/docker/compose.host-broker.yaml` reaches the
host's own identity broker instead, the way the image first worked:

```bash
export TEAMS_LITE_UID=$(id -u) TEAMS_LITE_GID=$(id -g)   # it must run as you
docker compose -f packaging/docker/compose.host-broker.yaml build
docker compose -f packaging/docker/compose.host-broker.yaml up -d
```

That one shares the host's PID and network namespaces, runs as your uid and mounts
`~/.local/share/intune-container` read-only — and it cannot repair a locked keyring itself (run
`intune-container stop && intune-container start` on the host, or keep a teams-lite installed on the
host, which repairs it on its own). On a classic Intune host, swap that mount for your session bus
as the file's comments show. The two files are one container: run one at a time, and a switch keeps
the store.

To check that the self-contained boot works on your machine without enrolling anything — a
throwaway container that boots an Intune container, waits for its identity broker and stops it:

```bash
docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  --security-opt apparmor=unconfined --entrypoint teams-lite-intune-selftest teams-lite:local
```

See AGENTS.md § Running teams-lite in a container image.

### On Kubernetes (Helm)

The same image, as a one-pod StatefulSet with its store and its Intune state on persistent
volumes. **Untested on a real cluster**: the chart renders, lints and validates against the
Kubernetes API schemas, and the self-contained boot was proven under Docker, but no pod has run on
Kubernetes yet.

**By default the pod is self-contained** (`broker.mode=embedded`): it boots its own Intune
container, so it runs on any **x86_64 node on cgroup v2** whose kernel permits unprivileged user
namespaces (on an Ubuntu 23.10+ node, the sysctl above, set on the node), of a cluster that admits
privileged pods:

```bash
kubectl create namespace teams-lite
kubectl label namespace teams-lite pod-security.kubernetes.io/enforce=privileged   # the pod is privileged
helm install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite
kubectl -n teams-lite logs -f teams-lite-0                       # the first start downloads ~1.7 GB
kubectl -n teams-lite port-forward svc/teams-lite 19443:19443     # then http://127.0.0.1:19443
```

Then enroll it from the app (**Enroll this device**) — or, **before** enrolling it, import an
existing enrollment from a Secret, handed to the release you just installed with an **upgrade** (a
second `helm install` of the same name is refused):

```bash
intune-container backup -o enrollment-backup.tar.gz     # on the enrolled machine
kubectl -n teams-lite create secret generic teams-lite-enrollment --from-file=enrollment-backup.tar.gz
version=$(helm -n teams-lite get metadata teams-lite -o json | jq -r .version)   # the chart it runs
helm upgrade teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite \
  --version "${version:?no installed chart version}" \
  --reuse-values --set broker.embedded.import.secretName=teams-lite-enrollment
```

**Keep the `--version`**: with none, `oci://…` is the NEWEST chart (CI publishes one on every push),
and `--reuse-values` renders it against the OLD chart's defaults rather than its own — an error that
has nothing to do with the import as soon as a key moved, and a new image in the middle of the
move where it renders. Pinned to the version the release runs, the upgrade changes that one value.
`${version:?…}` stops the command when the version could not be read, rather than run it with an
empty `--version` (which helm reads as "the newest"); `helm get metadata` is Helm 3.13 or later.

The upgrade replaces the pod, and the new one imports the archive at boot — **only while it holds
no device registration**, so a pod you already enrolled from the app ignores it (its logs say so).
To import from the very first start instead, create the Secret first and pass the same `--set` to
the `helm install` itself. Then stop that enrollment on the machine it came from: this is a move,
not a copy. Once it is imported, drop it (`--set broker.embedded.import.secretName=""` on the next
upgrade, pinned the same way) and delete the Secret: it is the device's keys.

**To reach the enrolled machine's own broker instead** (a host mode), the cluster must run
directly on that machine — k3s (or k0s, kubeadm) on your workstation; not kind, k3d or minikube's
docker driver, whose nodes are containers of their own — and the mode has to be named:

```bash
helm install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite \
  --set broker.mode=intuneContainer \
  --set hostUser.uid=$(id -u) --set hostUser.gid=$(id -g) \
  --set broker.intuneContainer.stateDir=$HOME/.local/share/intune-container
```

Anything that can reach the web port can send as you, so it ships as a ClusterIP Service, no
Ingress, and a NetworkPolicy that lets no other pod in. To reach it from your phone, use the
Tailscale operator: `--set ingress.enabled=true --set ingress.className=tailscale
--set 'ingress.tls[0].hosts[0]=teams-lite' --set 'networkPolicy.allowNamespaces[0]=tailscale'`.
To reach it from anywhere without a VPN client, the chart runs a sign-in in front of it —
oauth2-proxy beside the app in the pod (`auth.oauth2Proxy`), OpenID Connect against your provider,
letting in only the addresses you list — and publishes it through your Gateway with an HTTPRoute
(`httpRoute`); it refuses a public route with no sign-in in front. The chart's README has
[the whole walk-through](packaging/helm/teams-lite/README.md#publishing-it-a-sign-in-in-front-and-a-gateway-api-route).
`helm uninstall` keeps both volume claims; deleting the `intune-…` one unenrolls the pod. Every
value — the user-namespace opt-in instead of privileged, the microVM-runtime declaration
(`broker.embedded.vmIsolated`), the classic Intune `sessionBus` mode, the trade-offs `hostNetwork`
makes in a host mode — is in
[the chart's README](packaging/helm/teams-lite/README.md). CI publishes two GHCR packages, the image
and the chart, and a new package starts out private: make both public once in their package
settings, or `helm registry login ghcr.io` and add an `imagePullSecrets` entry.

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
#   stops on Ctrl+C. Sign-in needs nothing from it: the backend finds the Identity
#   Broker's D-Bus itself, containerized Intune included, so sign-in works from source
#   with nothing exported first. This pair uses ports of its own — backend 19421, app
#   19441 — so it runs happily alongside the always-on service on 19420/19440. See
#   bin/teams-dev-server.sh:
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
