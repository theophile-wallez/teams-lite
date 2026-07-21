# teams-lite — agent guidelines

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
  D-Bus, real-time trouter client, local-first SQLite store, send, name resolution.
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

- Do task work on a dedicated branch off `master`, never directly on `master`,
  so an in-progress session can't leave `master` in a broken state.
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
- If the tests you ran fail, do not merge. Leave the branch intact and report
  what failed.
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
