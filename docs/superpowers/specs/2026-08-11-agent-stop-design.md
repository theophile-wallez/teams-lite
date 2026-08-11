# Stop a live agent run

Let the user interrupt a local agent run (`@claude` / opencode) while it is still
answering, from any client watching the live bubble — phone included. The half-written
answer is kept, marked "stopped by you", and the run is torn down cleanly.

## Why this shape

A run is spawned by `agent_reply` (`src/bin/server.rs`) as a fire-and-forget
`tokio::spawn`, and the CLI child lives in a local variable inside `agent::run_once`
(`src/agent.rs`), spawned `.kill_on_drop(true)`. **Nothing stores a handle to it**, so
there is no way to abort a run today. The only kills that exist are the internal,
time-based ones (`RUN_IDLE_TIMEOUT`, `RUN_MAX_DURATION`). A Stop is the user-driven analog
of those.

The clean lever is to cancel the `run` future: dropping `agent::run` kills the child via
`kill_on_drop`, and the existing `drop(progress)` at the end of that future already closes
the three consumer loops (`edits`, `local`, `alive`). So a stop reuses the exact
finalization path a normal finish takes — one final Teams edit, one terminal
`agent_stream` frame — and only the body differs.

## Mechanism

### Registry on `Ctx`

Mirror `gitlab_refreshing` / `CallingPlane.connection`:

```rust
agent_runs_inflight: Arc<Mutex<HashMap<String, CancellationToken>>>  // keyed by run_id
```

- `run_id = "{conversation}/{trigger_id}"` — the identity every `agent_stream` frame
  already carries, so the client needs no new id.
- Insert a fresh `CancellationToken` in `agent_reply` where the run is recorded
  (beside `begin_agent_run` / `publish_agent_run_marker`).
- Remove it on **every** exit path (beside `finish_agent_run` /
  `remove_agent_run_marker`), so a finished run leaves no stale token.

### Cancellable run

In `agent_run_to_completion`, wrap the `run` future in a `tokio::select!` against
`token.cancelled()`. On cancel:

- the `agent::run` future is dropped → the CLI child dies via `kill_on_drop`;
- `drop(progress)` still fires (as it does on a normal finish), closing the consumer
  loops;
- a `stopped` flag is carried out so the finalization body is the stopped one.

### Stopped message body

Read the latest streamed answer from the watch channel (`progress.borrow().text` — the
same text `agent_stream_edits` renders mid-run) and finalize through the normal path:
build `final_body`, one `agent_edit`, one terminal `agent_stream` frame `phase:"done"`.

New `agent_policy::stopped_body(backend, partial, people)`:

- body = the partial answer, then a `<p><em>stopped by you</em></p>` note, then the
  **done** signature `— <backend>, via teams-lite`.
- `agentAuthorship` (web) strips only the trailing signature line, so the note stays in
  the visible body and the reply reads as **done** — not `pending` (which would leave a
  permanent `agent-stalled` bubble) and not the `interrupted_html` "backend restarted —
  ask again" shape (which would be a lie for a user-initiated stop).
- Empty partial (stopped during thinking) → body is just the note. That is the fallback.

The terminal frame carries the transcript, so the folded transcript outlives the run per
the existing rule (`AGENT_TRANSCRIPTS_KEPT`).

## RPC — `agent_stop`

- Dispatch arm: look up `run_id` in the registry, `token.cancel()`, return
  `{ "stopped": bool }`. It does **not** edit anything itself — the run's own
  finalization does, which avoids a double-edit race between the stopper and the run.
- Added to `MACHINE_METHODS` (`[&str; 19]` → `[&str; 20]`) with a `machine_effect` arm.
  It is write-token gated and refused read-only, consistent with `agent_set_mode` and
  with `restart_backend` / `update_apply` (which also cut a live run).
- **Known limitation, stated honestly:** the registry is per-process, so `agent_stop`
  cancels only a run owned by the backend the page is connected to. The agent path is
  single-backend in the real deployment (phone → 19440 → 19420), so this is the normal
  case; a run owned by the other install (19422) returns `stopped:false`. No pid-signal
  fallback: killing by signal would trip `repair_abandoned_agent_runs` and post the wrong
  "backend restarted" body.

## Frontend

- A `data-testid="agent-stop"` button inside `AgentStream` (rendered by both
  `AgentPendingBubble` and `message-bubble.tsx`, so one button covers phone and desktop),
  shown only while `agentRunIsLive(run)`, wearing a square-stop glyph from hugeicons.
- `ws-client.agentStop(conversation, runId)` → `writeRequest("agent_stop", { conversation,
  run_id })`; a `store.stopAgentRun` controller wrapper with the busy/error + cue pattern
  `setAgentMode` uses. Local "stopping…" busy state on the button.
- The overlay tears down when the terminal frame arrives — the same
  `onSettled` → `forgetAgentRun` path a normal finish takes. The button does not remove
  the run itself.

## Mock, tests, capture

- Mock: an `agent_stop` RPC arm sets an abort flag keyed by run id; `simulateMockAgentRun`
  checks it between steps/bursts and jumps to the stopped terminal frame + edit.
  `MOCK_AGENT_STEP_MS` is env-overridable, so the button is clickable mid-run.
- Backend tests (`cargo test`): `stopped_body` (done signature, note present, partial
  kept, empty-partial fallback); `write_class("agent_stop") == Machine`; the
  `MACHINE_METHODS` count; the `machine_effect` arm.
- Web (`bun run test` / `typecheck`, `bun run test:e2e`): in `web/e2e/agent.spec.ts`,
  opt in → `@claude` → wait for `agent-stream` → click `agent-stop` → assert the overlay
  is gone, the stored bubble is **not** `agent-stalled`, and it carries the note with a
  done signature.
- Capture: extend the `--agent-reply` preview for the button in both themes.

## Out of scope (YAGNI)

No cross-process stop, no "resume", no per-message stop history, no separate "stopping…"
server state — the overlay's own live → done transition covers it.
