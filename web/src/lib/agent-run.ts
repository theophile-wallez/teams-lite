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

/**
 * One entry of the run's transcript (`agent::Step`, over `agent_step_json`).
 *
 * The ORDER is what this carries that a pair of lists would not: the reasoning that led
 * to a call sits above it, and the reasoning that followed it below. A kind this app does
 * not know is dropped rather than guessed at, which is what lets the backend grow one.
 */
export type AgentStep =
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: string; target: string; done: boolean };

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
  /** How the answer was arrived at: the reasoning and the tool calls, in order. Empty
   *  on a backend that reports no reasoning and has called nothing. */
  steps: AgentStep[];
  /** The call in flight, or the last one that ran — the newest tool step, carried apart
   *  because it is what the run is doing NOW. */
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
    steps: parseSteps(f.steps),
    activity: parseActivity(f.activity),
    tools_used: typeof f.tools_used === "number" ? f.tools_used : 0,
    error: typeof f.error === "string" && f.error ? f.error : null,
    at: typeof f.at === "number" ? f.at : 0,
  };
}

const PHASES = new Set<AgentPhase>(["thinking", "working", "writing", "done", "error"]);

/** The transcript, entry by entry. An entry of a kind this app has no row for is
 *  dropped: it is a step the backend grew and this build cannot draw. */
function parseSteps(raw: unknown): AgentStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: AgentStep[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const step = entry as Record<string, unknown>;
    if (step.kind === "thought") {
      const text = typeof step.text === "string" ? step.text : "";
      if (text) steps.push({ kind: "thought", text });
      continue;
    }
    if (step.kind === "tool") {
      const tool = parseActivity(step);
      if (tool) steps.push({ kind: "tool", ...tool });
    }
  }
  return steps;
}

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
    a.tools_used === b.tools_used &&
    a.error === b.error &&
    a.message_id === b.message_id &&
    a.activity?.tool === b.activity?.tool &&
    a.activity?.target === b.activity?.target &&
    a.activity?.done === b.activity?.done &&
    sameSteps(a.steps, b.steps)
  );
}

/** Whether two transcripts hold the same entries in the same order. Compared entry by
 *  entry rather than by a joined string: a thought that happens to spell a tool row
 *  would collide, and the reveal keys off the shape. */
function sameSteps(a: AgentStep[], b: AgentStep[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((step, i) => {
    const other = b[i];
    if (!other || step.kind !== other.kind) return false;
    if (step.kind === "thought") return other.kind === "thought" && step.text === other.text;
    return (
      other.kind === "tool" &&
      step.tool === other.tool &&
      step.target === other.target &&
      step.done === other.done
    );
  });
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

/**
 * What this app watched a run work out, kept after the run itself is over.
 *
 * The Teams message holds the answer and never the reasoning, so this is the ONLY place a
 * finished run's transcript exists: in this page's memory, keyed by the message the run
 * wrote into, for as long as the page is open. A reply this app never watched being
 * written therefore has no panel at all — which is honest, and is why the panel is a
 * disclosure rather than part of the message.
 */
export type AgentTranscript = {
  /** The message the run wrote into — what a kept transcript is keyed by. */
  message_id: string;
  backend: string;
  steps: AgentStep[];
  tools_used: number;
  /** The run's last frame's clock, so the oldest kept transcript is the one dropped. */
  at: number;
};

/** The transcript of a run worth keeping, or null when the run worked nothing out — a CLI
 *  that reports no reasoning, answering with no tool call, has nothing to disclose. */
export function agentTranscriptOf(run: AgentRun): AgentTranscript | null {
  if (!run.steps.length || !run.message_id) return null;
  return {
    message_id: run.message_id,
    backend: run.backend,
    steps: run.steps,
    tools_used: run.tools_used,
    at: run.at,
  };
}

/**
 * How many finished transcripts a page keeps.
 *
 * One is up to 16 KiB of reasoning (`MAX_THINKING_BYTES` in src/agent.rs) plus its rows,
 * and this app is left open for days on a phone — so the newest are kept and the rest are
 * let go. Deep enough that scrolling back through a session's answers still finds their
 * work, which is what the panel is for.
 */
export const AGENT_TRANSCRIPTS_KEPT = 40;

/** Add one transcript to the kept ones, dropping the oldest past
 *  {@link AGENT_TRANSCRIPTS_KEPT}. Ordered by the run's own clock rather than by insertion,
 *  because a message id says nothing about when its run happened. */
export function keepAgentTranscript(
  kept: Record<string, AgentTranscript>,
  transcript: AgentTranscript,
): Record<string, AgentTranscript> {
  const next: Record<string, AgentTranscript> = { ...kept, [transcript.message_id]: transcript };
  const ids = Object.keys(next);
  if (ids.length <= AGENT_TRANSCRIPTS_KEPT) return next;
  const oldestFirst = ids.sort((a, b) => (next[a]?.at ?? 0) - (next[b]?.at ?? 0));
  for (const id of oldestFirst.slice(0, ids.length - AGENT_TRANSCRIPTS_KEPT)) delete next[id];
  return next;
}

/**
 * What a FOLDED transcript says it holds — the label of the row that stands in for it
 * once the answer has started arriving, and the only thing a kept one ever says.
 *
 * The calls are counted from `tools_used` rather than from the rows, because the
 * transcript keeps only its newest ones (`MAX_TOOL_CALLS` in src/agent.rs) while the
 * count survives: a run that greped forty times says forty, and shows the last
 * thirty-two.
 */
export function agentTranscriptLabel(steps: AgentStep[], toolsUsed: number): string {
  const tools = toolsUsed > 0 ? `${toolsUsed} tool call${plural(toolsUsed)}` : "";
  const reasoned = steps.some((step) => step.kind === "thought");
  if (reasoned) return tools ? `Reasoning and ${tools}` : "Reasoning";
  return tools || "Reasoning";
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
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
