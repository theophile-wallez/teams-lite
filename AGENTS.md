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
- UI: TypeScript + Bun + OpenTUI + Solid (`ui/`) — talks to the backend only through
  the WebSocket (`ui/src/client.ts`). Local-first is enforced server-side; the UI
  never touches the network or SQLite directly.
- Architecture mirrors opencode: the UI process spawns/owns the backend as a child
  process (`ui/src/server.ts`), so one command (`teams`) starts everything.

## Conventions

- Conventional commits. No AI attribution / Co-Authored-By lines.
- De-risk before building: prove the risky piece with a spike, then implement.
- Verify against the real tenant when possible; don't over-promise.
