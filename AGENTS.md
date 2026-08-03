# teams-lite — agent guidelines

## Sending messages (MANDATORY)

- **Never send a message without the user's explicit consent for that exact
  message.** Sends go out through the user's *personal* Teams account, so every
  send is a real, visible action performed as them — this applies to channels and
  to one-to-one/group chats alike.
- This covers anything that posts to Teams on the user's behalf — new messages,
  replies, reactions, edits, deletions — whether triggered through the UI, the backend
  `server`, a script, or a direct API/WebSocket call.
- **A deletion is the one outward action nothing takes back.** `delete`
  (`teams_send::delete_message`, `DELETE …/conversations/{id}/messages/{id}`) removes a
  message from the thread for everybody in it, on every device, and no later call
  restores it — an edit rewrites, a reaction toggles off, a deletion is final. It is an
  `OUTWARD_METHODS` entry, the UI asks for a second explicit confirmation before it
  calls, and the backend refuses a message that is not the user's own before the
  network (Teams itself would let a team owner delete a colleague's channel post; this
  app never offers that). The local row is FLAGGED, never dropped: Teams keeps the
  message and marks it, which is what the "You deleted this message" placeholder — and
  its Reveal of the cached body — is built on. `examples/message_delete_probe.rs` pins
  that server-side shape against the real tenant — it posts to the sandbox channel and
  removes what it posted, and it is the only sanctioned way to try the call live:

      . bin/broker-env.sh && teams_lite_export_broker_bus && \
        cargo run --example message_delete_probe
- **Marking a conversation read counts.** `mark_read` publishes the user's own
  consumption horizon (`PUT …/properties?name=consumptionhorizon`, in
  `src/teams_readstate.rs`): the unread marker clears on every device they are signed
  in on, and the sender is shown a read receipt saying their message was read. It is
  an `OUTWARD_METHODS` entry for that reason, and the hook blocks the endpoint on a
  command line too. Reading horizons (`GET …/consumptionhorizons`, which is how "seen
  by" works) stays open. **Ghost mode** — a setting, off by default — makes a read
  local: the marker clears in this app only, and Teams is never told.
- **The one standing exception is the designated sandbox chat**
  `19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2`, at this address:

      https://theophile-remote.taild26c06.ts.net:8443/c/19%3A21d2695ae8ff4e25ace9c662e5c326cb%40thread.v2

  Sending there is pre-authorized — it is the only place a send is allowed without
  asking first. Treat every other channel and chat as off-limits absent explicit
  consent. (That URL is the tailnet front of the always-on web unit; the same
  conversation on this machine's own front is
  `http://127.0.0.1:19440/c/19%3A21d2695ae8ff4e25ace9c662e5c326cb%40thread.v2`.
  One chat, two doors.)
- **A chat feature that must be exercised against the real account is exercised in
  that chat and nowhere else.** One thread, chosen once, so a mistake lands where a
  mistake is harmless. The mock comes first — `cd web && bun run preview` exercises
  send, edit, delete and react with nothing leaving the machine — and prod is only for
  what the mock cannot show.
- **`cd web && bun run sandbox` is the only sanctioned way to type into the live
  app.** It opens the URL above, reads the open conversation id out of the app's own
  state (`[data-testid="composer-shell"]`'s `data-conversation-id`) and refuses every
  keystroke unless it is the sandbox thread — the live counterpart of the MOCK
  sentinel in `web/scripts/preview.ts`. Add `--local` when the tailnet name does not
  resolve on this machine: it is the same chat through `127.0.0.1:19440`, which is
  what `tailscale serve` proxies 8443 to. Never click through the sidebar of a live
  app, and never drive a live page with the browser MCP tools: neither can prove
  which conversation a keystroke lands in.
- Reading, searching, drafting, and showing a proposed message to the user for
  review are always fine. Only the actual send requires a green light.
- Outside the sandbox chat, consent is per-message and never standing: approval
  to send one message is not permission to send others. When in doubt, draft it and
  ask first.
- The one feature that posts on its own is the local agent (§ The local agent). It
  is not an exception to the rule above: it answers only a message the USER wrote,
  only in a conversation the user opted in, and the sandbox channel is the only one
  opted in out of the box.

## The local agent (`@claude` in a thread)

The user can summon a coding agent that runs on this machine from any Teams client —
their phone included — by writing `@claude <prompt>` or `@opencode <prompt>` in a
thread. The backend runs that CLI, posts one message, and EDITS it as the answer
arrives, so everybody in the thread watches the reply being written.

`src/agent.rs` runs the CLI, `src/agent_policy.rs` decides whether a message asked for
one, `src/agent_markdown.rs` turns the answer into the HTML a Teams message renders,
and `agent_reply` in `src/bin/server.rs` posts and streams it.

**In teams-lite itself the answer is drawn being written.** The edited message is the
lowest common denominator — one HTML body, once a second, for clients we do not write.
This app is on the same machine as the CLI, so `agent_reply` also broadcasts the whole
run on the local `agent_stream` event (`agent_stream_local`, over `agent::Progress`):
the answer so far, the model's reasoning, the tool that is running, the phase. The web
UI renders it word by word under the CLI's own mark (`web/src/components/agent-reply.tsx`
and `agent-logo.tsx`, over `web/src/lib/agent-run.ts` and `agent-markdown.ts` — a port
of the Rust markdown subset, pinned to it case for case by its tests). Four rules hold
that surface together:

- **The stream is an overlay on the posted message, never a message of its own.** The
  row in the history IS the Teams message; only its body is replaced while a run is
  live. So there is nothing to reconcile, nothing to clean up when a frame is lost, and
  a reply this app never watched being written renders identically from the message
  alone.
- **A reply is recognised from the line it signs itself with**, not from a flag
  (`web/src/lib/agent-message.ts`). That line exists for honesty about authorship and
  is required above; reading it back is what makes every reply ever posted render as
  one — including the ones answered from a phone while this app was closed, which is
  most of them.
- **The answer sits on the LEFT.** The message is genuinely the user's — it went out
  through their account and a colleague sees their name on it — but they did not write
  it, and putting it beside the things they did write is the one place this app would be
  lying to the person it belongs to.
- **The terminal frame goes out after the final edit.** A finished run stops being an
  overlay, so the message it falls back to has to already hold the whole answer.

`web/mock/server.ts` reproduces that flow (`simulateMockAgentRun`) with no CLI and no
tenant, which is what makes the surface reviewable — `cd web && bun run preview --
--out /tmp/reply --agent-reply` walks one run through every phase (`--agent` captures the
menu instead), and `web/e2e/agent.spec.ts` pins it.

Five rules hold it together. Each one is load-bearing, and each is pinned by a test:

- **Only the user may summon it.** The trigger requires the message to be ours
  (`from_me`). A prefix written by anybody else is ignored — the agent runs a program
  with the user's files in reach, so a trigger a colleague could type is remote code
  execution with a friendly syntax. Never relax this to "a mention of the app", and
  never to "an allowlist of colleagues".
- **A conversation must be opted in.** The default is `off` everywhere. The sandbox
  channel is the single built-in exception, because § Sending messages pre-authorizes
  it. Anything else needs `agent_set_mode`, a write-token-gated `MACHINE_METHODS`
  entry — which is the consent gate for this whole feature, and the reason it is not a
  standing licence to post. The user turns one thread on from that thread's own header
  (`web/src/components/agent-menu.tsx`, over `web/src/lib/agent.ts`), never from a
  global list of ids: the consent belongs where they can see who reads the thread. The
  switch stays off and disabled until `agent_status` answers, because `off` is what the
  backend defaults to and a hopeful switch would misstate where a machine posts.
- **The tool allowlist is read-only until the user widens it.** `Read`, `Glob`, `Grep`
  and nothing else (`agent::DEFAULT_TOOLS`), and Claude Code is pinned to
  `--permission-mode default` so anything outside the list is refused rather than
  prompted for. Widening the list is `agent_set_tools`, gated the same way — and it is
  *offered* as named read-only groups (`agent::TOOL_GRANTS`, switched on from the same
  thread menu), because a consent the user can only give through a hand-crafted RPC is a
  consent they cannot give. Every tool in every group reads: the child loads the user's
  own MCP servers, so a group spelled `mcp__grafana` would hand over `update_dashboard`,
  `create_incident` and `grafana_api_request` with it. `every_granted_tool_reads` pins
  the shape — three segments, never a whole server, and a verb that reads. The RPC still
  accepts any list, which is the deliberate escape hatch for a tool no group names.
- **The user may hand it their own configuration, and only they may.**
  `agent_set_unrestricted` (a `MACHINE_METHODS` entry, off in a fresh store) switches the
  child to `agent::Permissions::OwnConfig`: this app then passes NEITHER
  `--allowed-tools` NOR `--permission-mode`, so the CLI resolves every MCP server, every
  tool and the permission mode from `~/.claude/settings.json` — the run the user gets in
  their own terminal, which is what they asked for. Three things about it, all
  load-bearing:
  - **The app still never spells an escalation.** No `bypassPermissions`, no
    `--dangerously-skip-permissions`, no opencode `--auto`, in either mode
    (`no_mode_ever_spells_an_escalation`). What the setting opens is what the user's own
    settings open, so editing those settings takes it back. A flag written here would
    keep deciding after they changed their mind.
  - **It accepts a real risk, and the menu says so.** The thread transcript travels with
    every prompt, and the people in the thread never agreed to be able to steer a program
    on that machine. With the user's own config that program can write files and run
    commands, and it can read the 0600 write token and post to any chat around every gate
    above. That is why the setting is off by default, why it is per machine and asked for
    from the thread's own menu, and why the backend prints one `UNRESTRICTED` line at
    startup. Never make it the default, never turn it on for the user, and never widen it
    to a per-thread automatic.
  - **The narrow state is what an unanswered status means.** `agentIsUnrestricted` is
    false until the backend reports `true`, exactly like the mode switch: a hopeful
    `true` would tell the user their own configuration is in force while the allowlist
    is.
- **The child never inherits the write token.** `TEAMS_LITE_WRITE_TOKEN` is removed
  from its environment: an agent holding it could `send` to any chat directly, around
  every gate above. A read-only backend never answers at all.

Four more things worth knowing before touching it:

- **The providers live in Settings, and the model with them.** Settings › AI providers
  (`web/src/components/ai-providers-settings.tsx`) shows every CLI in
  `agent_policy::BACKENDS`, says which ones this machine actually holds
  (`agent::is_available`, so a missing CLI is stated instead of offering a dead switch),
  and lets the user turn one off or choose the model it runs — `agent_set_provider`, a
  third write-token-gated `MACHINE_METHODS` entry, because it decides which program a
  chat message starts and which model reads the thread. Two defaults are deliberate and
  run opposite ways: a **conversation** is off until the user names it, and a
  **provider** the machine holds is on out of the box (`agent_policy::Providers`) — the
  first is consent to post, the second is only which installed CLI answers once that
  consent exists. A disabled provider ignores its own prefix everywhere, and says so in
  the journal. A model is a free-form name (an alias, a full id, or opencode's
  `provider/model`) rather than a fixed list, because `opencode models` depends on the
  providers that machine authenticated — but it is shape-checked
  (`agent_policy::is_valid_model`) at the RPC and again in `agent::model_of`, so it can
  never arrive at the CLI as another flag.
- **The CLI has to be on the backend's own PATH, and a service has almost none.** The
  systemd user manager's PATH holds neither `~/.local/bin` (where `claude` installs
  itself) nor `~/.bun/bin`, so the always-on service found no program, dropped every
  trigger with one journal line, and the thread stayed silent — a broken feature with no
  visible cause. The unit therefore carries `Environment=PATH=@AGENT_PATH@`
  (`bin/teams-lite-service.sh` substitutes it, and a test in `agent::tests` pins both
  halves), and every backend says at startup which CLIs it resolved and to where.
- **The thread transcript travels with the prompt, and it is DATA.** The appended
  system prompt says so explicitly, because the people in a thread never agreed to be
  able to steer an agent on the user's machine. Keep that instruction, keep the
  transcript bounded, and never move it out of its `<thread>` delimiter.
- **The reply signs itself.** The message is posted under the user's name, so the last
  line says a machine wrote it (`— claude, via teams-lite`). That is honesty about
  authorship, not decoration.

`examples/agent_stream_probe.rs` drives the whole chain against the real tenant —
pinned to the sandbox channel, and the only sanctioned way to try it live:

```
. bin/broker-env.sh && teams_lite_export_broker_bus && \
  cargo run --example agent_stream_probe -- "your prompt" [claude|opencode] [model]
```

It also pins the fact the streaming rests on: a send returns no `id`, only
`{"OriginalArrivalTime": …}` — and a Teams message id IS its arrival time in epoch
ms, which is what the edits address.

## Mail is READ-ONLY (MANDATORY — no exception, not even a sandbox)

The app reads the user's Outlook mailbox over Microsoft Graph (`src/mail.rs`). It
must never write to it.

- **Never send, reply to, forward, delete, move, or mark-as-read a mail.** There is
  no sandbox mailbox and no pre-authorized recipient: unlike the Teams sandbox
  channel, mail has *no* standing exception at all. A mail leaves the user's personal
  address, reaches people who never agreed to be part of a test, and cannot be
  recalled.
- The broker token this app already holds carries **`Mail.ReadWrite` and
  `Mail.Send`** (verified — see `examples/graph_mail_scopes.rs`). So nothing at the
  API level stops a send. What stops it is that **no code names the endpoint**:
  `src/mail.rs` issues GET requests only, and two tests enforce that mechanically —
  one scans the module for any other verb, the other scans the whole crate for the
  Graph mail-send endpoint. Do not weaken, skip, or work around either.
- Reading, searching, and rendering mail are fine and are what the feature is for.
  If mail *sending* is ever wanted, it is a deliberate feature: its own consent gate,
  its own entry in `OUTWARD_METHODS`, its own write-lock coverage — never a quiet
  addition to the read path.
- Mail bodies are sanitized server-side and stripped of every remote reference, so
  **displaying a mail makes no network request**. That is a privacy guarantee (a
  remote image is a read receipt for its sender), not an optimization: never add a
  "load remote images" action, and never let a body reach a browser unsanitized.

## The calendar is READ-ONLY (MANDATORY — no exception, not even a sandbox)

The app reads the user's Teams/Outlook calendar over Microsoft Graph
(`src/calendar.rs`). It must never write to it.

- **Never create, update, move, delete, cancel, forward, accept, decline or
  tentatively accept an event** — and never dismiss or snooze a reminder. Like mail,
  the calendar has *no* sandbox and *no* pre-authorized target. It is worse than mail
  in one respect: a single create mails an invitation to **every attendee** (one real
  meeting in this tenant has 777), and a single response mails the organizer. Neither
  can be recalled.
- The same broker token carries the consent, so nothing at the API level stops it.
  What stops it is that **no code names the endpoints**: `src/calendar.rs` issues GET
  requests only, and two tests enforce it mechanically — one scans the module for any
  other verb, the other scans the whole crate for `/accept`, `/decline`,
  `/tentativelyAccept`, `/cancel`, `/forward`, `/snoozeReminder` and
  `/dismissReminder`. Do not weaken, skip, or work around either.
- Reading, rendering and navigating the calendar are fine and are what the feature is
  for. `join_url` and `web_link` are links the **user** clicks — never something the
  app follows, prefetches or opens on their behalf.
- There is deliberately no "New event" button, and no drag, resize or context menu on an
  event, even though the reference design the views follow
  (`github.com/vmnog/calendarcn`, itself after Notion Calendar) has all of them. Take
  its *look* — the tinted blocks with a coloured rail, the measured month cells, the
  time-zone gutter, the now badge, the anchored details panel — and none of its editing.
  The header says `Read-only` for the same reason. If responding to invitations is ever
  wanted, it is a deliberate feature: its own consent gate, its own entry in
  `OUTWARD_METHODS`, its own write-lock coverage — never a quiet addition to the read
  path.

## The trackers are READ-ONLY (MANDATORY)

The app enriches a tracker link pasted into a chat into a rich preview card
(`src/link_preview.rs`, over `src/gitlab.rs` and `src/linear.rs`). It reads those
trackers. It must never write to them.

- **Never create, edit, comment on, assign, move or close an issue, a merge request
  or a project** — in either tracker. A comment posted from here reaches everyone
  watching the issue, under the user's name, and looks like they wrote it.
- The credentials carry the consent: a Linear personal API key has **full write
  access**, and a GitLab token has whatever scopes the user granted it. So nothing
  at the API level stops a write. What stops it is that **no code names a write**:
  `gitlab` issues GET requests only, `linear` sends GraphQL **queries** only, and a
  test in `linear::tests` scans that module's own source for `mutation`. Do not
  weaken, skip, or work around it.
- **The Linear endpoint is a constant** (`linear::API_URL`), never derived from the
  link being enriched, so the key can only ever reach Linear. GitLab's host IS
  configurable, so it is *pinned* instead: a URL whose host is not the configured one
  is never enriched and never sees the token. Both rails exist to stop the same thing
  — a token leaving for an attacker-supplied host — so never widen either.
- `set_settings` (which stores those credentials, and the GitLab host the token is
  pinned to) is a `MACHINE_METHODS` entry: it needs the write token and is refused
  read-only. `get_settings` stays open because it returns no token, only whether one
  is set. A token is **write-only from the UI's side** — never send a raw one back to
  a client, and never log one.
- Reading, enriching and rendering a link are fine and are what the feature is for.
  If writing to a tracker is ever wanted, it is a deliberate feature: its own consent
  gate, its own entry in `OUTWARD_METHODS`, its own write-lock coverage — never a
  quiet addition to the read path.

## Automation safety (MANDATORY — read before driving the UI)

**This section exists because of a real incident.** An agent was screenshotting a
UI change. It started the mock backend, pointed `vite dev` at it, and drove the
app with an ad-hoc `playwright-core` script that typed into the composer and
pressed Enter. It then restarted `vite dev` *without* `VITE_TEAMS_WS_URL`; the app
silently reconnected to the real backend on `127.0.0.1:19420`. The next scripted
keypress **posted three messages to two real 1:1 chats with the user's
colleagues.** Nothing in the chain was able to notice, and the mistake was
invisible until the screenshots came back full of real conversations.

The rules below are therefore not style preferences. They are the guardrails that
make that failure impossible, and they are enforced mechanically by two `PreToolUse`
hooks: `.claude/hooks/guard-live-automation.sh` on every `Bash` command, and
`.claude/hooks/guard-prod-chat-target.sh` on every browser MCP tool.

**Reading the real backend is allowed. Writing to it is not.** Inspecting real
conversations, history and DB rows is useful and encouraged — guessing is worse.
What must never happen is a write: `send`/`edit`/`delete`/`react` post to real people as the
user. Two independent mechanisms enforce that split:

- **The write lock (backend).** The backend mints a capability token per process
  and publishes it 0600 at `$XDG_RUNTIME_DIR/teams-lite/write-token`, for the
  user's own frontend only (`web/write-token.ts` serves it to the browser page).
  Outward-facing RPCs must present it, so a
  client that merely found the socket — an ad-hoc script, an automated driver —
  reads everything and writes nothing. `TEAMS_LITE_READ_ONLY=1` refuses writes
  outright, token or not. **Never read that token file, pass it to a script, or
  weaken the lock to get a write through.** Fetching a secret you were not handed
  is precisely the line this draws.
- **The hook (harness).** Blocks, before execution, any command that would write:
  ad-hoc browser drivers, scripts calling `send`/`edit`/`delete`/`react`/`mark_read` against
  `127.0.0.1:19420` or `19421` (and the 19440 / 19441 relays in front of them), a
  consumption-horizon PUT straight to Teams (which bypasses the backend's gate
  entirely), a presence publish straight to the presence service (same reason — see
  § The user's own status), dev servers with no declared backend, a production web server with no
  declared backend, a send-capable backend started by tooling — including `systemctl
  --user start` on the always-on service's units, and including the `teams` command
  itself, which is that backend plus the real app on 19440 in one word. It reads the
  *contents* of what a command runs, including an untracked `examples/*.rs` a `cargo
  run --example` names. Searching, stopping and inspecting stay allowed on purpose: a
  `grep` whose pattern names a launcher runs nothing, and a guard that fired on it
  would only teach its next reader to phrase around the guard.

- **Never hand-roll browser automation.** `web/scripts/preview.ts` is the only
  sanctioned way to drive the web UI: it starts its own mock, points the dev
  server at it, and asserts the `MOCK` sentinel badge before it types — and again
  immediately before every keystroke. Use `cd web && bun run preview -- --out
  /tmp/shot`, or import `withPreview` / `typeInComposer` / `openFirstConversation`
  from it. For the mail surface: `bun run preview -- --out /tmp/mail --mail`, or
  `openMailTab` / `openFirstMail` / `openMailAt` from the same file. For the calendar:
  `bun run preview -- --out /tmp/cal --calendar`, or `openCalendarTab` /
  `openCalendarView` / `openFirstEvent`. For the team → channel tree:
  `bun run preview -- --out /tmp/chan --channels`, or `openChannelsTab` /
  `toggleTeamSection` from the same file. For the settings pane:
  `bun run preview -- --out /tmp/set --settings`, or `openSettings` from the same
  file. To review a detail too small to read in a
  1200px page — a 16px icon, a chip, a badge — crop to it and raise the pixel
  density: `bun run preview -- --out /tmp/chip --element
  '[data-testid="message-file"]' --dpr 4`.
  `web/scripts/scroll-probe.ts` is what a diagnostic built on top of it looks like
  (it measures history scroll smoothness frame by frame): a tracked script that
  drives the app *through* `withPreview`, never around it.
- **Never type into the composer without proof the backend is fake.** The proof is
  `[data-testid="backend-badge"][data-backend="mock"]`, which comes from the
  backend's own `backend_info` sentinel (only `web/mock/server.ts` emits it). No
  badge means *unproven*, which means live.
- **One chat, and only one, may be typed into for real.** When a chat feature can
  only be shown against the real account, the target is the sandbox chat named in
  § Sending messages and nothing else, driven by `cd web && bun run sandbox`
  (`web/scripts/sandbox-live.ts`). That script is the live twin of `preview.ts`: it
  hard-codes the sandbox thread and its URL, hands out no raw `page` to navigate
  away with, and re-reads `[data-testid="composer-shell"]`'s `data-conversation-id`
  — the app's own state, not our assumption — immediately before every keystroke and
  again before Enter. It types nothing at all in any other conversation, so a wrong
  assumption ends in a thrown error rather than in a colleague's chat.
- **The browser MCP tools may look at the live app; they may never type in it.**
  `guard-prod-chat-target.sh` reads the URL of every `*_navigate` / `preview_open`
  call, and once the target is a live front (19420 / 19421 / 19440 / 19441, or a
  `*.ts.net` name) it allows only the calls that observe a page — snapshot,
  screenshot, console, network log, wait, hover, close — and blocks everything else:
  click, type, press, fill, drag, upload, evaluate, and any tool either server grows
  tomorrow. Reading prod stays normal work; typing in it is not possible. The same
  block applies when *no* navigation has been seen in the session, because a browser
  whose page nobody declared is exactly the "unproven means live" case. Declare it
  with a navigate; do not phrase around the block.
- **A dev server must name its backend.** Use `bun run dev:mock` (mock on 19455,
  app on 19445). `bun run dev` is the *user's* shortcut to their live account — not
  yours to start. A bare `vite dev` refuses to run at all: there is no default
  backend in dev (see `defaultWsUrl` in `web/src/lib/ws-client.ts`).
- **Start the backend read-only, or let the user start it.**
  `TEAMS_LITE_READ_ONLY=1` refuses `send`/`edit`/`delete`/`react` at the dispatch choke
  point (`src/bin/server.rs`) *and* binds **19430** instead of 19420, so it never
  competes for the port the user's own backend owns. The two run side by side on
  the same SQLite store (WAL): the user's always-on service keeps 19420 and their
  hands-on dev backend 19421, while you read real data on `ws://127.0.0.1:19430` —
  point a client at it with
  `VITE_TEAMS_WS_URL=ws://127.0.0.1:19430`. `TEAMS_LITE_PORT` overrides either
  default.
- **The always-on service is the user's to start.** `bin/teams-lite-service.sh
  install` and `status` are yours; `systemctl --user enable --now teams-lite.target`
  is theirs, because that backend signs in as them and can post. See § The always-on
  service.
- **Check the port before running the E2E suite.** `reuseExistingServer` is on
  outside CI, so anything already listening on the suite's mock port gets adopted
  and the specs send through it. `e2e/global-setup.ts` aborts when the answer is not the
  mock — but NOT when the answer is a mock another run left behind, which
  `reuseExistingServer` then adopts: its code is not the code under test, and a stale one
  serving an older `agent_status` reads exactly like a bug in the app. That check cannot
  live in `global-setup.ts` either, because the suite starts its own server first, so the
  check cannot tell ours from a squatter. Pass explicit free ports whenever another
  session may be running one: `E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468`.
- **Screenshots are not proof of the target.** Before trusting a captured UI, look
  at *what it shows*: the mock's fixtures are in English with names like "Lucas
  Silva". Real conversations mean you were live all along.
- **A cargo example that posts must pin the sandbox channel.** An example holds a
  broker token and talks to Teams directly, so no port rule and no write token stands
  between it and a colleague's chat — the only thing that does is what the file names.
  Hard-code the conversation as a const and name no other (see
  `examples/agent_stream_probe.rs`); the hook refuses to run any other shape,
  including a target taken from an argument.

**If a guardrail blocks you, fix the setup — never route around the guardrail.**
Rewriting a command to slip past the hook, disabling the sentinel, or asserting
"it's obviously the mock" is precisely the reasoning that sent those three
messages. And when you touch this area, leave the guardrails *stronger* than you
found them: every gap you notice (a new automation entry point, a new write RPC
missing from `OUTWARD_METHODS`, a helper that types without re-asserting) is a bug
to fix in the same change, not a note for later.

## Push notifications (outward, and gated like one)

The app is an installable web app and the backend sends Web Push, so the user's
phone is notified while the app is closed (`src/push.rs`, `src/push_policy.rs`,
`web/public/sw.js`, `web/src/lib/push.ts`). Reaching a device the user is holding is
an outward action, so it is gated on purpose:

- **`push_subscribe` / `push_unsubscribe` / `push_test` are `MACHINE_METHODS`.** They
  post nothing to Teams, so they are not in `OUTWARD_METHODS` — but they decide which
  devices this machine sends message previews to, so they need the write token and
  are refused read-only. The hook blocks a script that names them against a live
  port, exactly as it does `send`.
- **A subscription may only point at a browser vendor's push service**
  (`push::is_supported_endpoint`: Apple, Mozilla, Google, Microsoft). A subscription
  is a URL a *client* supplies and the backend then POSTs message text to it, which
  without that list is an exfiltration channel with a friendly name. Never widen it
  to "any https URL", and never add an endpoint override.
- **A read-only backend never pushes.** `deliver_push` refuses before the network,
  not only at the dispatch gate — live delivery never passes through the gate, and a
  screenshot script must not buzz the user's phone.
- **The payload is encrypted to the device** (RFC 8291, verified against the RFC's
  own test vector). That is a privacy guarantee, not an implementation detail: the
  push service forwards a colleague's words without being able to read them. Never
  move notification text into a place the service can see (a `Topic` header, a query
  parameter, a plaintext fallback).
- **The VAPID key pair must stay stable.** It lives in the store under
  `push_vapid_private`; every device's subscription embeds the public half, so
  regenerating it silently stops every phone that opted in.
- **The service worker is push-only.** No `fetch` handler, no precache: the app is a
  live client of a local backend, and a cached shell that boots a build the user
  replaced is worse than a page that says the machine is unreachable.
- **Two backends share one store**, so every notification is claimed in
  `push_deliveries` before it is sent — otherwise the service (19420) and the dev
  backend (19421) both push and the phone buzzes twice.
- The delivery policy lives in `src/push_policy.rs` and is deliberately narrower than
  "every live message": chats always, channels per the user's own Teams setting for
  that channel, never a system line, never our own message, never a replayed frame.
  Widening it is a product decision, not a cleanup.
- **A channel follows the user's own notification setting** (`store::ChannelAlerts`,
  derived from CSA in `teams_read::channel_alerts`): silent when they muted the
  channel *or its whole team*, an @mention only at Teams' default (matched on the MRI
  in `Message::mentions`, never on a display name), and every post — with or without
  thread replies — when they asked Teams for that. The setting is stored as the
  decision, not as the three raw CSA signals, and the sidebar reads the same field to
  dim a muted channel. A **chat**'s `is_muted` is NOT yet wired into any notification
  path: it only dims the sidebar row, so a muted chat still pushes.

## The channel sidebar mirrors Teams, and mirrors it READ-ONLY

The team → channel tree reads four pieces of the user's own Teams arrangement, and
`examples/channel_pin_recon.rs` and `examples/team_order_recon.rs` measure every one of
them against the real tenant. Read those before touching this area: CSA names two of
these fields after something they are not.

- **`isFavorite` on a channel is Teams' Show/Hide switch**, not a favorites list. It is
  true on most channels and on every General (41 of 75 here), so it groups NOTHING:
  `store::ChannelRow::is_shown` keeps a channel inside its team, and a hidden one goes
  under that team's own "Hidden channels" entry. There is no Favorites section, because
  Teams has none.
- **`isPinned` is the real pin**, and the only flag that lifts a channel out of its team
  — into the sidebar's top Pinned section.
- **`isCollapsed` on a team is that team's fold state in the user's own client**, and it
  tracks that client live. It decides how a section OPENS
  (`ChannelRow::team_collapsed`, denormalized onto every channel of the team because
  there is no teams table).
- **The order is CSA's array order**, which is the only order the payload states — no
  team and no channel carries a rank — and it IS the user's own: verified against their
  client, and it moves when they re-arrange. Read the **v1** aggregator; v2 answers 200
  with a different, non-client order. General is the one correction we make: CSA puts it
  LAST in a team.

**A fold, a pin or a hide made HERE stays here.** Each is a local override that wins
over the Teams-sourced value from then on, and nothing writes any of them back:
publishing a setting to the user's account is an outward action and would need its own
consent gate and its own `OUTWARD_METHODS` entry, exactly like a send.

## The user's own status (outward, and gated like one)

The app can hold the user's Teams status green — the **Always available** setting, off
by default (`src/teams_presence.rs`, `set_always_available` in `src/bin/server.rs`).
Reading other people's presence is the older half of that module and stays open; the
publish is gated, because a green dot is a claim about where the user is that every
colleague reads.

- **`set_always_available` is an `OUTWARD_METHODS` entry**, in both directions: it
  needs the write token, a read-only backend refuses it, and the hook blocks a script
  or a `curl` that names the presence write on a command line. Turning the setting
  *off* is the same outward call, so it is behind the same gate.
- **The mechanism is an endpoint registration, and that is on purpose.**
  `PUT {presence}/v1/me/endpoints/` with `{id, availability: "Available", activity:
  "Available", deviceType: "Web"}` reports one running client of ours; `DELETE
  …/endpoints/{id}` takes it back. Verified against the tenant in both directions.
  The service accepts no other availability on an endpoint, so a registration says
  exactly one thing: "this device is present and available".
- **Never reach for the manual status** (`PUT …/v1/me/forceavailability/`). The
  service accepts it and refuses every matching DELETE, so this app could set it and
  never take it back — a setting whose off switch cannot undo its on switch is not a
  setting. A test in `teams_presence::tests` scans the crate for that endpoint, and
  the automation hook refuses any command that names it. Do not weaken either.
- **A registration expires after 300 s** (measured), so `spawn_presence_heartbeat`
  refreshes it every 120 s while the setting is on, and the first tick restores the
  state after a restart. One endpoint id lives in the store, so the always-on service
  and the user's dev backend refresh ONE registration rather than two.
- **A read-only backend never publishes.** `publish_presence` refuses before the
  network, not only at the dispatch gate — the heartbeat never passes through that
  gate, and a screenshot backend must not tell the user's colleagues they are around.

## Language policy (MANDATORY)

- **All artifacts are in English.** This includes: UI strings, labels, button text,
  placeholders, status messages, log lines, code comments, identifiers, commit
  messages, and any string literal in the source (Rust or TypeScript).
- **Never write French (or any non-English language) in the code or UI**, even if
  the conversation with the user happens in French.
- The only place another language is allowed is direct chat with the user — never
  in committed files.
- If you find existing non-English strings in the codebase, treat it as a bug and
  translate them to English.

## Project shape

- Backend: Rust (`src/`, binary `server` in `src/bin/server.rs`) — auth broker over
  D-Bus, real-time trouter client, local-first SQLite store, send, name resolution,
  Web Push to the user's own devices (`src/push.rs` + `src/push_policy.rs`), the
  READ-ONLY Outlook mail surface (`src/mail.rs` + `src/mail_html.rs`), the
  READ-ONLY Teams/Outlook calendar (`src/calendar.rs`), presence — reading everybody's
  and, only when the user asks for it, publishing their own (`src/teams_presence.rs`,
  see § The user's own status), the READ-ONLY rich link
  previews for the trackers the user works in (`src/link_preview.rs` dispatching to
  `src/gitlab.rs` and `src/linear.rs`) and the local agent that answers an `@claude`
  message (`src/agent.rs`, `src/agent_policy.rs`, `src/agent_markdown.rs` — see
  § The local agent).
  Exposed over a local WebSocket (`ws://127.0.0.1:19420`).
- One front-end, talking to the backend only through that WebSocket. Local-first is
  enforced server-side; the front-end touches neither the network nor SQLite directly.
  - Web app (`web/`): TypeScript + Bun + React + TanStack Start (SSR built with Vite),
    WebSocket client in `web/src/lib/ws-client.ts`. Served by a plain Bun fetch server
    (`web/server.ts`). `web/mock/server.ts` is a backend mock used by the E2E suite. It
    is also an installable web app (`web/public/manifest.webmanifest`, the icons
    generated by `web/scripts/generate-app-icons.ts`), which is what lets a phone
    receive push notifications through `web/public/sw.js`.
  - There was a terminal UI (OpenTUI + Solid, in `ui/`) until 2026-08-03. It is gone,
    and the web app is the only client: do not re-add a second front-end, and read a
    comment that names one as history rather than as a place to keep in sync.
- The `teams` command (`launcher/`): TypeScript + Bun, no dependencies. It spawns or
  attaches to the backend (`launcher/src/backend.ts`), serves the web app and opens
  the browser (`launcher/src/launch.ts`), so one command starts everything — the
  opencode model. `launcher/build.ts` compiles it into ONE binary that embeds the Bun
  runtime, the release backend and the built web app; that binary is what `install.sh`
  downloads and what `.github/workflows/build.yml` publishes as the rolling `latest`
  release. It is the launcher, not a second interface: it renders nothing itself.

## Ports

Every port lives in one 194xx block. It was picked because nothing registers those
numbers and they sit **below** the ephemeral range (`net.ipv4.ip_local_port_range`
starts at 32768), so an outbound connection can never borrow one first and a listener
can never lose a race to it.

| Port      | What                                              | Where the default lives |
| --------- | ------------------------------------------------- | ----------------------- |
| **19420** | Backend, send-capable — the always-on service      | `src/bin/server.rs` `DEFAULT_PORT` |
| **19421** | Backend, send-capable — the user's hands-on dev one | `bin/teams-dev-server.sh` |
| **19430** | Backend, read-only (`TEAMS_LITE_READ_ONLY=1`)      | `src/bin/server.rs` `READ_ONLY_PORT` |
| **19440** | Web app, production — the always-on service, and `teams` | `web/server.ts`, `launcher/src/launch.ts` |
| **19441** | Web UI, `vite dev`                                 | `web/vite.config.ts` `DEV_PORT` |
| 19455 / 19445 | `bun run dev:mock` — mock backend / app        | `web/package.json` |
| 19456 / 19446 | `bun run preview` — mock backend / app         | `web/scripts/preview.ts` |
| 19457 / 19447 | E2E — mock backend / app                       | `web/playwright.config.ts` |
| 8443      | Tailnet HTTPS front for the web UI (`tailscale serve`) | `bin/teams-lite-service.sh` |

**The x420/x440 pair is the service; x421/x441 is the user's dev pair.** They are two
send-capable backends on one SQLite store, so they must never share a port: the service
holds 19420 for weeks, and `bin/teams-dev-server.sh` plus `bun run dev` step aside to
19421/19441 so both can run at once. Read-only is the exception that keeps its own
19430 — and `teams-dev-server.sh` deliberately does not pin `TEAMS_LITE_PORT` when
`TEAMS_LITE_READ_ONLY=1`, because an explicit port would drag it off 19430.

`TEAMS_LITE_PORT` overrides a backend's, `PORT` a web server's,
`E2E_MOCK_PORT` / `E2E_WEB_PORT` the suite's. Change a default in code and this table
in the same commit — and check `.claude/hooks/guard-live-automation.sh`, which matches
19420, 19421, 19440 and 19441 by number.

## The always-on service

The user runs teams-lite as a permanent background service, reachable from their
phone. `bin/teams-lite-service.sh` owns it and `packaging/systemd/` holds the units.

- **It runs staged artifacts, not the checkout.** `install`/`update` build, then copy
  the release binary and the web bundle into `~/.local/share/teams-lite/service`, with
  the commit recorded in `VERSION`. That is deliberate: a `git pull`, a rebuild, or an
  E2E run (which rewrites `web/dist` with its mock's URL baked in) would otherwise
  change what the service serves at a moment nobody chose.
- **`VERSION` names the commit that was BUILT, and the script reads `HEAD` once.** The
  build takes about a minute, and a hook, another session's push or the user's own
  `git pull` can fast-forward the checkout inside it. A second read at staging time
  therefore wrote a `VERSION` naming a commit the binary did not hold — and nothing
  healed it, because the auto-update hook compares `VERSION` with `HEAD`, read the two
  as equal and never rebuilt. The service served a backend from before a feature while
  `VERSION` named the commit that added it, so a new RPC answered `unknown method` in
  the user's own app while every test passed. `BUILD_REV` pins the commit before the
  build, `build_artifacts` builds again when the tree moved under it, and
  `update::tests::the_installer_stages_the_commit_it_built` pins both halves.
- **Re-staging is automatic; starting is not.** `.claude/hooks/sync-service-to-master.sh`
  (a `PostToolUse` hook on `Bash`) fires after a git command that can move master. It
  fast-forwards the checkout, compares `VERSION`'s commit with `HEAD`, and on a gap runs
  `update` in a detached background job — because staging by hand is a step nobody
  remembers, and the failure is invisible: every test passes while the phone serves a
  commit from days ago. It acts **only when a unit is already active** and **only from a
  clean `master`**, so it can neither bring the send-capable backend up nor promote a
  working tree. `.claude/hooks/sync-service-to-master.test.py` pins both refusals.
- **What is yours:** `install`, `update`, `units`, `status`, `logs`, `stop`,
  `uninstall`, and every `systemctl --user status|cat|show` /
  `journalctl --user -u …`. Diagnosing the service is normal work.
- **What is the user's:** `systemctl --user enable --now teams-lite.target`. That
  backend is send-capable, so the hook blocks every start/restart/enable spelling —
  including the service script's own `start` subcommand.
- **Two things it must never lose.** `TEAMS_NO_IDLE_EXIT=1` in the backend unit (or
  the process exits seconds after every start, since a service has no owning
  frontend), and `HOST=127.0.0.1` on the web unit (it serves the write token and
  relays WebSockets to the send-capable backend, so a public bind would hand the
  account to anything that can reach the port).
- **The broker bus moves.** It lives at `/proc/<container-leader>/root/run/user/0/bus`
  and that PID changes on every Intune container boot, so `bin/broker-env.sh` resolves
  it at each start and `teams-lite-broker-bus.path` restarts the backend when
  `rootless.json` changes. Without that the backend stays up, unauthenticated, and
  silent.
- **The keyring re-locks, and that is repaired automatically.** The container's login
  keyring locks itself every ~18 hours; the broker then answers every token call with
  `NoReply`, and the app shows nothing. `bin/teams-lite-broker-check.sh` reads the
  keyring's own `Locked` property — the cause, not a symptom — and three triggers share
  one rate-limited `teams-lite-broker-repair.service` (3/hour): the backend on that
  signature, `teams-lite-broker-health.timer` every 15 min, and the app's own
  **Repair sign-in** button (`repair_broker`, a `MACHINE_METHODS` entry). **Restarting
  the container is not yours to do** — it takes the user's sign-in down for a minute,
  so the hook blocks `intune-container stop|start|restart` and
  `teams-lite-broker-check.sh --repair`. `intune-container status|doctor` and the bare
  check stay open, because diagnosing is the normal way to answer "why is it empty".
- **Tailscale, never Funnel.** `tailscale serve` is tailnet-only, behind Tailscale's
  own authenticated HTTPS. `tailscale funnel` would publish the user's Teams account
  to the internet, send included.

## Conventions

- Conventional commits. No AI attribution / Co-Authored-By lines.
- De-risk before building: prove the risky piece with a spike, then implement.
- Verify against the real tenant when possible; don't over-promise.

## Git workflow

- Every new session/task MUST start from a dedicated git worktree created off
  `master`, never work directly on `master` or in the main checkout, so an
  in-progress session can't leave `master` in a broken state and parallel
  sessions never collide. Create it with a branch off `master`, for example:
  `git worktree add .worktrees/<task-name> -b <branch> master`.
- Once the branch is merged into `master`, delete its worktree to keep the
  checkout clean: `git worktree remove .worktrees/<task-name>` (and prune the
  branch once it is no longer needed).
- Before treating a task as done, run the tests that cover the parts you changed
  as a hard gate: only merge into `master` when they are green. Match the test
  scope to the change scope — do not run everything by reflex:
  - Backend (`src/`, Rust): `cargo test`.
  - Web app (`web/`): `bun run test` (unit) plus `bun run typecheck`; add
    `bun run test:e2e` when behavior or flows change.
  - The `teams` command: `bun test` plus `bun run typecheck` (run in `launcher/`).
  - The automation guard (`.claude/hooks/`): `python3
    .claude/hooks/guard-live-automation.test.py` whenever you touch the hook, a
    launcher name, or a port. It pins both halves — what must block, and the ordinary
    work that must not. Run `python3 .claude/hooks/guard-prod-chat-target.test.py`
    alongside it when you touch the browser-MCP guard, and `python3
    .claude/hooks/sync-service-to-master.test.py` when you touch the service
    auto-update hook or `teams-lite-service.sh`.
  - A change that only touches a frontend does not need `cargo test`, and a
    backend-only change does not need the frontend suites. When a change spans
    both (e.g. a protocol or WebSocket contract), run the suites on both sides.
- If the tests you ran fail, do not merge. Leave the worktree and branch intact
  and report what failed.
- This is a convention the agent follows, not an enforced guarantee — the
  authoritative check that keeps `master` green belongs in CI or a pre-push hook.

## Working style (MANDATORY)

- **Act autonomously.** For every prompt, drive the task to completion without
  waiting for hand-holding. Investigate, decide, implement, and verify on your own.
- **Always write clean code.** Favor clear naming, small focused units, and proper
  separation of concerns over quick hacks.
- **Choose the professional solution.** When you spot a problem, fix it properly.
  Never take a shortcut just because it is easier or faster.
- **Address root causes, not symptoms.** If a proper fix requires more work, do the
  work rather than patching around the issue.
