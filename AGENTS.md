# teams-lite — agent guidelines

## Sending messages (MANDATORY)

- **Never send a message without the user's explicit consent for that exact
  message.** Sends go out through the user's *personal* Teams account, so every
  send is a real, visible action performed as them — this applies to channels and
  to one-to-one/group chats alike.
- This covers anything that posts to Teams on the user's behalf — new messages,
  replies, reactions, edits — whether triggered through the UI, the backend
  `server`, a script, or a direct API/WebSocket call.
- **The one standing exception is the designated sandbox channel**
  `19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2`
  (`http://localhost:4321/c/19%3A21d2695ae8ff4e25ace9c662e5c326cb%40thread.v2`).
  Sending there is pre-authorized — it is the only place a send is allowed without
  asking first. Treat every other channel and chat as off-limits absent explicit
  consent.
- Reading, searching, drafting, and showing a proposed message to the user for
  review are always fine. Only the actual send requires a green light.
- Outside the sandbox channel, consent is per-message and never standing: approval
  to send one message is not permission to send others. When in doubt, draft it and
  ask first.

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

## Automation safety (MANDATORY — read before driving the UI)

**This section exists because of a real incident.** An agent was screenshotting a
UI change. It started the mock backend, pointed `vite dev` at it, and drove the
app with an ad-hoc `playwright-core` script that typed into the composer and
pressed Enter. It then restarted `vite dev` *without* `VITE_TEAMS_WS_URL`; the app
silently reconnected to the real backend on `127.0.0.1:8420`. The next scripted
keypress **posted three messages to two real 1:1 chats with the user's
colleagues.** Nothing in the chain was able to notice, and the mistake was
invisible until the screenshots came back full of real conversations.

The rules below are therefore not style preferences. They are the guardrails that
make that failure impossible, and they are enforced mechanically by
`.claude/hooks/guard-live-automation.sh` (a `PreToolUse` hook).

**Reading the real backend is allowed. Writing to it is not.** Inspecting real
conversations, history and DB rows is useful and encouraged — guessing is worse.
What must never happen is a write: `send`/`edit`/`react` post to real people as the
user. Two independent mechanisms enforce that split:

- **The write lock (backend).** The backend mints a capability token per process
  and publishes it 0600 at `$XDG_RUNTIME_DIR/teams-lite/write-token`, for the
  user's own frontends only (`web/write-token.ts` serves it to the browser page,
  `ui/src/client.ts` reads it directly). Outward-facing RPCs must present it, so a
  client that merely found the socket — an ad-hoc script, an automated driver —
  reads everything and writes nothing. `TEAMS_LITE_READ_ONLY=1` refuses writes
  outright, token or not. **Never read that token file, pass it to a script, or
  weaken the lock to get a write through.** Fetching a secret you were not handed
  is precisely the line this draws.
- **The hook (harness).** Blocks, before execution, any command that would write:
  ad-hoc browser drivers, scripts calling `send`/`edit`/`react` against
  `127.0.0.1:8420`, dev servers with no declared backend, and a send-capable
  backend started by tooling.

- **Never hand-roll browser automation.** `web/scripts/preview.ts` is the only
  sanctioned way to drive the web UI: it starts its own mock, points the dev
  server at it, and asserts the `MOCK` sentinel badge before it types — and again
  immediately before every keystroke. Use `cd web && bun run preview -- --out
  /tmp/shot`, or import `withPreview` / `typeInComposer` / `openFirstConversation`
  from it. For the mail surface: `bun run preview -- --out /tmp/mail --mail`, or
  `openMailTab` / `openFirstMail` / `openMailAt` from the same file.
- **Never type into the composer without proof the backend is fake.** The proof is
  `[data-testid="backend-badge"][data-backend="mock"]`, which comes from the
  backend's own `backend_info` sentinel (only `web/mock/server.ts` emits it). No
  badge means *unproven*, which means live.
- **A dev server must name its backend.** Use `bun run dev:mock` (mock on 8455,
  app on 4455). `bun run dev` is the *user's* shortcut to their live account — not
  yours to start. A bare `vite dev` refuses to run at all: there is no default
  backend in dev (see `defaultWsUrl` in `web/src/lib/ws-client.ts`).
- **Start the backend read-only, or let the user start it.**
  `TEAMS_LITE_READ_ONLY=1` refuses `send`/`edit`/`react` at the dispatch choke
  point (`src/bin/server.rs`) *and* binds **8430** instead of 8420, so it never
  competes for the port the user's own backend owns. The two run side by side on
  the same SQLite store (WAL): the user keeps `teams-back` + `teams-web` on 8420
  while you read real data on `ws://127.0.0.1:8430` — point a client at it with
  `VITE_TEAMS_WS_URL=ws://127.0.0.1:8430`. `TEAMS_LITE_PORT` overrides either
  default.
- **Check the port before running the E2E suite.** Its mock defaults to 8420 — the
  real backend's port — and `reuseExistingServer` is on outside CI, so a running
  dev backend gets "reused" and the specs send for real. `e2e/global-setup.ts`
  aborts the run in that case; use `E2E_MOCK_PORT=8455 E2E_WEB_PORT=4455`.
- **Screenshots are not proof of the target.** Before trusting a captured UI, look
  at *what it shows*: the mock's fixtures are in English with names like "Lucas
  Silva". Real conversations mean you were live all along.

**If a guardrail blocks you, fix the setup — never route around the guardrail.**
Rewriting a command to slip past the hook, disabling the sentinel, or asserting
"it's obviously the mock" is precisely the reasoning that sent those three
messages. And when you touch this area, leave the guardrails *stronger* than you
found them: every gap you notice (a new automation entry point, a new write RPC
missing from `OUTWARD_METHODS`, a helper that types without re-asserting) is a bug
to fix in the same change, not a note for later.

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
  and the READ-ONLY Outlook mail surface (`src/mail.rs` + `src/mail_html.rs`).
  Exposed over a local WebSocket (`ws://127.0.0.1:8420`).
- Two front-ends, both talking to the backend only through that WebSocket. Local-first
  is enforced server-side; neither front-end touches the network or SQLite directly.
  - Terminal UI (`ui/`): TypeScript + Bun + OpenTUI + Solid — keyboard-first TUI, client
    in `ui/src/client.ts`. Architecture mirrors opencode: the UI process spawns/owns the
    backend as a child process (`ui/src/server.ts`), so one command (`teams`) starts
    everything.
  - Web UI (`web/`): TypeScript + Bun + React + TanStack Start (SSR built with Vite),
    WebSocket client in `web/src/lib/ws-client.ts`. Served by a plain Bun fetch server
    (`web/server.ts`) and launched via `teams --web`, which opens it in the browser
    against the same local backend. `web/mock/server.ts` is a backend mock used by the
    E2E suite.

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
  - Terminal UI (`ui/`): `bun test` (run in `ui/`).
  - Web app (`web/`): `bun run test` (unit) plus `bun run typecheck`; add
    `bun run test:e2e` when behavior or flows change.
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
