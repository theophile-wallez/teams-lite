/**
 * A local agent run, as the backend narrates it on the `agent_stream` event
 * (`agent_stream_local` / `agent_stream_frame` in src/bin/server.rs, over
 * src/agent.rs).
 *
 * The feature already works without any of this: the backend posts one Teams message
 * and EDITS it about once a second, which is the only thing a Teams client somebody
 * else is running can be told. This event exists because we are not somebody else's
 * client — the CLI runs on this machine, and the app talking to it can show the answer
 * being written instead of jumping a paragraph at a time, name the file being read, and
 * say when the model is reasoning rather than typing.
 *
 * So: the Teams message stays the record, and a run is a transient overlay on it. Every
 * frame carries the WHOLE state (the text so far, not a delta), because frames are
 * coalesced on the way out and a dropped one must cost nothing.
 */

/** What the run is doing. The first three come from `agent::Phase`; the last two are
 *  terminal and only `agent_reply` can send them, because only it knows the outcome. */
export type AgentPhase = "thinking" | "working" | "writing" | "done" | "error";

/** One tool call, as it happens. `target` is empty until the call's arguments arrive
 *  (and for a tool that takes none), which is why the label falls back to the tool's
 *  own name rather than waiting. */
export type AgentActivity = {
  tool: string;
  target: string;
  done: boolean;
};

/** One `agent_stream` frame, exactly as it arrives. */
export type AgentStreamFrame = {
  /** The REQUEST this run answers — the trigger message's id, prefixed by the
   *  conversation. Stable for the whole run, and different for the next question in
   *  the same thread. */
  run_id: string;
  conversation: string;
  /** The posted Teams message the run is writing into. */
  message_id: string;
  /** Which CLI is answering: "claude", "opencode". */
  backend: string;
  phase: AgentPhase;
  /** The answer so far, as Markdown. */
  text: string;
  /** The tail of the model's reasoning, when it reports any. */
  thinking: string;
  activity: AgentActivity | null;
  tools_used: number;
  error: string | null;
  /** When the backend sent the frame (epoch ms). */
  at: number;
};

/** A run as the store holds it: the latest frame, and nothing else. A run IS its
 *  latest state — see the module note on why frames are whole. */
export type AgentRun = AgentStreamFrame;

import { agentDisplayName } from "./agent-message";

/** The phases in which a run is still going. A finished or failed run stops being an
 *  overlay: what the thread holds is then the answer. */
export function agentRunIsLive(run: AgentRun | null | undefined): boolean {
  return !!run && run.phase !== "done" && run.phase !== "error";
}

/**
 * How long a run may go without a frame before the UI stops believing in it.
 *
 * A run ends with a `done`/`error` frame, so this only catches the case where that
 * frame never comes: the backend was killed mid-run, or the socket dropped and came
 * back.
 *
 * It counts MISSED FRAMES, not run time: a live run repeats its latest frame every
 * 15 seconds while it is quiet (`AGENT_STREAM_KEEPALIVE` in src/bin/server.rs), so eight
 * missed beats is a backend that is gone and nothing else. A run itself has no such
 * budget — a question that needs an hour of tool calls gets it (`agent::RUN_IDLE_TIMEOUT`)
 * — and this window must never be read as one: it used to sit just past a ten-minute cap
 * on the whole run, and raising that cap without the keepalive would have made the bubble
 * give up on runs that were still writing.
 */
export const AGENT_RUN_STALE_MS = 2 * 60 * 1000;

/** Whether a run is too old to be believed (see {@link AGENT_RUN_STALE_MS}). */
export function agentRunIsStale(run: AgentRun, nowMs: number): boolean {
  return agentRunIsLive(run) && nowMs - run.at > AGENT_RUN_STALE_MS;
}

/**
 * Read one wire frame into a run, or null when the frame is not one.
 *
 * Defensive on purpose: this is the only place the event's shape is trusted, so a
 * frame from an older backend (or a mock that grew a typo) degrades to "no run"
 * instead of a bubble rendering `undefined`.
 */
export function parseAgentFrame(raw: unknown): AgentRun | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const conversation = typeof f.conversation === "string" ? f.conversation : "";
  const messageId = typeof f.message_id === "string" ? f.message_id : "";
  if (!conversation) return null;
  const phase = PHASES.has(f.phase as AgentPhase) ? (f.phase as AgentPhase) : "thinking";
  return {
    run_id: typeof f.run_id === "string" && f.run_id ? f.run_id : `${conversation}/${messageId}`,
    conversation,
    message_id: messageId,
    backend: typeof f.backend === "string" ? f.backend : "claude",
    phase,
    text: typeof f.text === "string" ? f.text : "",
    thinking: typeof f.thinking === "string" ? f.thinking : "",
    activity: parseActivity(f.activity),
    tools_used: typeof f.tools_used === "number" ? f.tools_used : 0,
    error: typeof f.error === "string" && f.error ? f.error : null,
    at: typeof f.at === "number" ? f.at : 0,
  };
}

const PHASES = new Set<AgentPhase>(["thinking", "working", "writing", "done", "error"]);

function parseActivity(raw: unknown): AgentActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const tool = typeof a.tool === "string" ? a.tool : "";
  if (!tool) return null;
  return {
    tool,
    target: typeof a.target === "string" ? a.target : "",
    done: a.done === true,
  };
}

/**
 * Fold a frame into the runs held per conversation, returning the new map (or the old
 * one when nothing changed, so a subscriber does not re-render for a repeat).
 *
 * One run per conversation, and the newest wins. A thread cannot have two runs going —
 * the backend claims each trigger before it starts (see `agent_live_message`) — but it
 * CAN have a finished one still on screen when the user asks again, and the new
 * question is what they are waiting for.
 *
 * A run that ended is kept, not dropped: the bubble it was writing into holds the same
 * text, and dropping the run the instant it finished would swap one for the other while
 * the reveal was still catching up (see `useSmoothReveal`). The UI decides when to let
 * go; this only records.
 */
export function withAgentFrame(
  runs: Record<string, AgentRun>,
  frame: AgentRun,
): Record<string, AgentRun> {
  const current = runs[frame.conversation];
  // A late frame from a run the user has already superseded is not news.
  if (current && current.run_id !== frame.run_id && current.at > frame.at) return runs;
  if (current && current.run_id === frame.run_id && sameRun(current, frame)) return runs;
  return { ...runs, [frame.conversation]: frame };
}

/** Whether two frames of the same run say the same thing (`at` aside — a frame that
 *  only moved the clock is not a change anybody can see). */
function sameRun(a: AgentRun, b: AgentRun): boolean {
  return (
    a.phase === b.phase &&
    a.text === b.text &&
    a.thinking === b.thinking &&
    a.tools_used === b.tools_used &&
    a.error === b.error &&
    a.message_id === b.message_id &&
    a.activity?.tool === b.activity?.tool &&
    a.activity?.target === b.activity?.target &&
    a.activity?.done === b.activity?.done
  );
}

/** Forget one conversation's run — what the UI calls once a finished run's text is
 *  fully revealed and the posted message can take over. */
export function withoutAgentRun(
  runs: Record<string, AgentRun>,
  conversation: string,
  runId: string,
): Record<string, AgentRun> {
  const current = runs[conversation];
  // Only the run the caller meant: a new one may have started in between.
  if (!current || current.run_id !== runId) return runs;
  const next = { ...runs };
  delete next[conversation];
  return next;
}

/** The label for a phase, written for somebody watching a thread rather than a
 *  terminal. The CLI is named the way it names itself (see {@link agentDisplayName}),
 *  because it is the CLI that is answering. */
export function agentPhaseLabel(run: AgentRun): string {
  const name = agentDisplayName(run.backend);
  switch (run.phase) {
    case "working": {
      const activity = run.activity;
      if (!activity) return "Working";
      return activity.target ? `${activity.tool} ${activity.target}` : activity.tool;
    }
    case "writing":
      return `${name} is writing`;
    case "error":
      return run.error ?? `${name} could not answer`;
    case "done":
      return name;
    default:
      return `${name} is thinking`;
  }
}
