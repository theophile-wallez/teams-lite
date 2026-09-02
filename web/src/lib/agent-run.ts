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
  /** The CUSTOM AGENT answering, by address (`bebou`), or null for a plain provider run.
   *
   *  It rides on every frame so the LIVE bubble draws its face from the first one: the
   *  posted message's own signature carries it once the run ends, and a bubble that wore the
   *  vendor's mark until then would swap faces in front of the reader for no reason. */
  persona: string | null;
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

/**
 * A run as the store holds it: the latest frame, plus the one thing no frame carries.
 *
 * A run IS its latest state — see the module note on why frames are whole — so everything
 * here but `started_at` is the newest frame verbatim.
 */
export type AgentRun = AgentStreamFrame & {
  /**
   * When the run began, in epoch ms, or `0` for a run whose beginning this page cannot
   * state (see {@link withAgentFrame}).
   *
   * It is what the loader counts from while a run has nothing to show yet, and it is
   * deliberately NOT on the wire: it is established once, here, from the first frame's own
   * clock, and carried forward — so it survives the remount the virtualized history forces
   * on the bubble every time the row scrolls away and back.
   */
  started_at: number;
};

import { agentDisplayName } from "./agent-message";
import type { ToolChipGlyph } from "~/components/beautifului/tool-chips";

/** The phases in which a run is still going. A finished or failed run stops being an
 *  overlay: what the thread holds is then the answer.
 *
 *  Takes the phase alone, so a raw frame answers as well as a stored run does. */
export function agentRunIsLive(run: { phase: AgentPhase } | null | undefined): boolean {
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
export function parseAgentFrame(raw: unknown): AgentStreamFrame | null {
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
    persona: typeof f.persona === "string" && f.persona ? f.persona : null,
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
  frame: AgentStreamFrame,
): Record<string, AgentRun> {
  const current = runs[frame.conversation];
  // A late frame from a run the user has already superseded is not news.
  if (current && current.run_id !== frame.run_id && current.at > frame.at) return runs;
  if (current && current.run_id === frame.run_id && sameRun(current, frame)) return runs;
  // The run's own start, established ONCE and then carried: a later frame must not restate
  // it, or the loader's clock would reset on every beat.
  const started_at =
    current && current.run_id === frame.run_id ? current.started_at : runBeganAt(frame);
  return { ...runs, [frame.conversation]: { ...frame, started_at } };
}

/**
 * When a run began, from the FIRST frame of it this page saw — or `0`, which means this page
 * cannot say.
 *
 * The first frame of a run carries nothing: no answer, no transcript, no call. So a first
 * frame that already carries WORK is not the beginning of anything — it is a run that was
 * already going when this page arrived, which is the ordinary case for a page that connected
 * mid-run (a live run repeats its latest frame every `AGENT_STREAM_KEEPALIVE`, so a reload
 * lands on one within fifteen seconds). Counting from that frame would put a number on
 * screen that understates the wait by however long the run had been going, and this app's own
 * rule for that is not to put a number on screen at all.
 *
 * It is deliberately not read off the ids either. A Teams message id IS its arrival time in
 * epoch ms, so both `message_id` and the trigger inside `run_id` really would date the run on
 * the tenant — and neither is one on the mock, where an id is `<conversation>#<seq>`. A
 * surface no capture can draw and no spec can find is one that ships broken.
 */
function runBeganAt(frame: AgentStreamFrame): number {
  if (frame.at <= 0) return 0; // a backend too old to stamp its frames
  const empty = !frame.text && frame.steps.length === 0 && frame.tools_used === 0;
  return empty ? frame.at : 0;
}

/** Whether two frames of the same run say the same thing (`at` aside — a frame that
 *  only moved the clock is not a change anybody can see). */
function sameRun(a: AgentStreamFrame, b: AgentStreamFrame): boolean {
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
export function agentTranscriptOf(run: AgentStreamFrame): AgentTranscript | null {
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

/**
 * The words a WAIT is drawn with, and how long each one stands.
 *
 * A run that has reported nothing yet has one line to fill, and "is thinking" for ten
 * minutes reads as an app that has stopped rather than a model that is working. So the word
 * turns over as the wait grows — the flavour a terminal spinner has, in this app's voice.
 *
 * THE FIRST WORD IS THE PLAIN ONE, deliberately: a reader meeting this line in its first
 * seconds is owed the fact rather than the character, and every wait short enough to be
 * ordinary shows nothing but "thinking". The rest are for a wait long enough to need them.
 *
 * None of them claims the agent DID anything — no "reading", no "running", no "searching".
 * This is the state where nothing has been reported, so a word that named an action would be
 * the glyph fallback's mistake in prose: overstating what the agent did.
 */
export const AGENT_WAITING_WORDS = [
  "thinking",
  "pondering",
  "mulling it over",
  "musing",
  "noodling",
  "percolating",
  "brewing",
  "simmering",
  "ruminating",
  "cogitating",
  "puzzling",
  "weighing it up",
  "wondering",
  "deliberating",
  "reflecting",
  "considering",
] as const;

/** How long one word stands before the next. Long enough to read twice without feeling
 *  stuck, short enough that a minute of waiting is visibly not a frozen app. */
export const AGENT_WAITING_ROTATE_MS = 4_000;

/**
 * What a waiting run says it is doing: who is working, and a word that turns over.
 *
 * `elapsedMs` is how long the wait has run — `0` (or a wait whose start this page cannot
 * state) holds the first word, which is the plain one. It is keyed on the CLOCK and on
 * nothing else, which is what keeps a capture of this line the same picture every run: at
 * the moment a capture is taken the wait is inside its first bucket, so the word is
 * `thinking` by construction rather than by luck. Two runs waiting side by side therefore
 * show the same word, which is a thing nobody compares.
 */
export function agentWaitingLabel(name: string, elapsedMs: number): string {
  const bucket = elapsedMs > 0 ? Math.floor(elapsedMs / AGENT_WAITING_ROTATE_MS) : 0;
  const word = AGENT_WAITING_WORDS[bucket % AGENT_WAITING_WORDS.length] ?? AGENT_WAITING_WORDS[0];
  return `${name} is ${word}`;
}

/**
 * The label for a phase, written for somebody watching a thread rather than a terminal.
 *
 * WHO is named is whoever the reader addressed: the custom agent when they wrote `@bebou`,
 * and the CLI otherwise (named the way it names itself — see {@link agentDisplayName}). The
 * persona's ADDRESS is used rather than its label, because this is read off the run's own
 * frames and the label lives in the local record; a surface that holds that record draws the
 * label beside this line anyway (`AgentSignature`).
 *
 * It matters more here than it looks: this is the line under a live bubble, and "Claude is
 * thinking" over a message the reader sent to Bebou reads as the wrong agent having picked it
 * up.
 */
/**
 * The moment the loader counts from, or `undefined` for a run whose start this page cannot
 * state (see {@link withAgentFrame}).
 *
 * One place, so the loader is never handed a `0` to render as "0.0s" — a zero is a claim
 * about the wait and a blank is not, which is the rule the reading's own progress rows hold
 * ("a number nobody has yet draws NOTHING").
 */
export function agentRunStartedAt(run: AgentRun): number | undefined {
  return run.started_at > 0 ? run.started_at : undefined;
}

/**
 * Which of beautifului's four glyphs a tool call is drawn with (see `ToolChipRow`).
 *
 * The row already NAMES the call, so the glyph is a hint about its KIND — and a hint is
 * exactly the thing that must not overstate. Three rules:
 *
 * - **Only an exact name is classified.** Both CLIs spell their own tools
 *   (`Read`/`read`, `Edit`/`edit`), so the match folds case and nothing else. No verb is
 *   guessed at inside an MCP tool's name: that would be this app inferring what somebody
 *   else's server does from how they named it.
 * - **Anything else is a READ, and that is the narrow answer rather than the neutral one.**
 *   An unrecognised call really is a read in every configuration but one: the allowlist is
 *   `Read`, `Glob`, `Grep` out of the box (`agent::DEFAULT_TOOLS`), and every tool in every
 *   named grant reads — `every_granted_tool_reads` pins exactly that. `run` would be the
 *   tempting fallback and it is the wrong one, because it claims a command executed, and
 *   overstating what the agent did is the error this whole feature's gates exist to prevent.
 * - **The cost is stated rather than hidden:** under `agent_set_unrestricted` the user's own
 *   config can reach a tool that writes, and a tool this app does not know is drawn as a
 *   read. It costs a glyph, never a row: the name beside it is the CLI's own.
 *
 * `think` is theirs and nothing maps to it: it is the sparkle, which is what the transcript's
 * own HEADER wears (`ThinkingHeader`), and reasoning is not a tool call.
 */
export function agentToolGlyph(tool: string): ToolChipGlyph {
  const name = tool.trim().toLowerCase();
  if (WRITE_TOOLS.has(name)) return "write";
  if (RUN_TOOLS.has(name)) return "run";
  return "read";
}

/** The tools that leave something behind. */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "todowrite"]);

/** The tools that start a program. */
const RUN_TOOLS = new Set(["bash", "bashoutput", "killshell", "killbash", "task"]);

export function agentPhaseLabel(run: AgentRun): string {
  const name = run.persona ?? agentDisplayName(run.backend);
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
