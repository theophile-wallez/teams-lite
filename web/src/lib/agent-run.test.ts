import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_STALE_MS,
  AGENT_TRANSCRIPTS_KEPT,
  agentPhaseLabel,
  agentRunIsLive,
  agentRunIsStale,
  agentRunStartedAt,
  agentToolGlyph,
  agentTranscriptLabel,
  agentTranscriptOf,
  keepAgentTranscript,
  parseAgentFrame,
  withAgentFrame,
  withoutAgentRun,
  type AgentRun,
  type AgentTranscript,
} from "./agent-run";

/** A frame as `agent_stream_frame` in src/bin/server.rs builds it. */
function frame(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    run_id: "19:thread@thread.v2/1785773946196",
    conversation: "19:thread@thread.v2",
    message_id: "1785773946200",
    backend: "claude",
    phase: "writing",
    text: "the port is 19420",
    steps: [],
    activity: null,
    tools_used: 0,
    error: null,
    at: 1_000_000,
    ...over,
  };
}

describe("parseAgentFrame", () => {
  it("reads a whole frame", () => {
    const run = parseAgentFrame(
      frame({
        phase: "working",
        activity: { tool: "Read", target: "src/agent.rs", done: false },
        tools_used: 3,
      }),
    );
    expect(run).not.toBeNull();
    expect(run!.phase).toBe("working");
    expect(run!.activity).toEqual({ tool: "Read", target: "src/agent.rs", done: false });
    expect(run!.tools_used).toBe(3);
    expect(run!.message_id).toBe("1785773946200");
  });

  it("reads the transcript in the order the backend narrated it", () => {
    const run = parseAgentFrame(
      frame({
        steps: [
          { kind: "thought", text: "the port is a constant" },
          { kind: "tool", tool: "Grep", target: "DEFAULT_PORT", done: true },
          { kind: "thought", text: "that is 19420" },
        ],
      }),
    );
    expect(run!.steps).toEqual([
      { kind: "thought", text: "the port is a constant" },
      { kind: "tool", tool: "Grep", target: "DEFAULT_PORT", done: true },
      { kind: "thought", text: "that is 19420" },
    ]);
    expect(agentTranscriptOf(run!)?.steps).toHaveLength(3);
  });

  it("drops a step it cannot draw rather than guessing at it", () => {
    // A kind a later backend grew, an entry that is not an object, an empty thought (the
    // frame that opens one, before its first token): none of them is a row.
    const run = parseAgentFrame(
      frame({
        steps: [
          { kind: "screenshot", path: "/tmp/a.png" },
          "Grep",
          { kind: "thought", text: "" },
          { kind: "tool", tool: "", target: "x", done: false },
          { kind: "tool", tool: "Read", target: 12, done: "yes" },
        ],
      }),
    );
    // The one survivor: a tool with a name. Its target and its state fall back rather
    // than arriving as a number and a string.
    expect(run!.steps).toEqual([{ kind: "tool", tool: "Read", target: "", done: false }]);
    expect(parseAgentFrame(frame({ steps: "a transcript" }))!.steps).toEqual([]);
  });

  it("refuses anything that is not a frame", () => {
    expect(parseAgentFrame(null)).toBeNull();
    expect(parseAgentFrame("agent_stream")).toBeNull();
    // No conversation means nothing can be drawn from it.
    expect(parseAgentFrame(frame({ conversation: "" }))).toBeNull();
  });

  it("falls back rather than trusting a frame from an older backend", () => {
    // An unknown phase reads as thinking — a run that exists but says nothing yet —
    // rather than rendering a label nobody wrote.
    const run = parseAgentFrame(frame({ phase: "reticulating", text: 12, activity: { tool: "" } }));
    expect(run!.phase).toBe("thinking");
    expect(run!.text).toBe("");
    expect(run!.activity).toBeNull();
  });
});

describe("withAgentFrame", () => {
  const first = parseAgentFrame(frame())!;

  it("holds one run per conversation", () => {
    const runs = withAgentFrame({}, first);
    expect(Object.keys(runs)).toEqual([first.conversation]);
  });

  it("returns the same map when a frame repeats itself", () => {
    const runs = withAgentFrame({}, first);
    // The clock moved, nothing else did: not a change anybody can see.
    const again = withAgentFrame(runs, { ...first, at: first.at + 40 });
    expect(again).toBe(runs);
  });

  it("takes a frame whose transcript grew, and only then", () => {
    const reasoned = parseAgentFrame(
      frame({ steps: [{ kind: "thought", text: "the port" }] }),
    )!;
    const runs = withAgentFrame({}, reasoned);
    // The keepalive repeats the latest frame every 15 s: a transcript that says the same
    // thing must not re-render the panel under a reader.
    expect(withAgentFrame(runs, { ...reasoned, at: reasoned.at + 15_000 })).toBe(runs);
    const grown = parseAgentFrame(
      frame({ steps: [{ kind: "thought", text: "the port is 19420" }], at: 1_000_100 }),
    )!;
    expect(withAgentFrame(runs, grown)[grown.conversation]!.steps).toEqual(grown.steps);
    // And a call that FINISHED is news, even though the row's words did not change.
    const running = parseAgentFrame(
      frame({ steps: [{ kind: "tool", tool: "Grep", target: "PORT", done: false }] }),
    )!;
    const done = { ...running, steps: [{ ...running.steps[0], done: true }] } as typeof running;
    expect(withAgentFrame(withAgentFrame({}, running), done)[running.conversation]!.steps).toEqual(
      done.steps,
    );
  });

  it("takes a newer run over the one on screen", () => {
    const runs = withAgentFrame({}, { ...first, phase: "done" });
    const next = parseAgentFrame(
      frame({ run_id: "19:thread@thread.v2/1785773999999", phase: "thinking", at: 2_000_000 }),
    )!;
    expect(withAgentFrame(runs, next)[first.conversation]!.run_id).toBe(next.run_id);
  });

  it("ignores a late frame from a run the user already superseded", () => {
    const newer = parseAgentFrame(frame({ run_id: "…/newer", at: 2_000_000 }))!;
    const runs = withAgentFrame({}, newer);
    const late = parseAgentFrame(frame({ run_id: "…/older", at: 1_000_000 }))!;
    expect(withAgentFrame(runs, late)).toBe(runs);
  });
});

/**
 * THE RUN'S OWN START — what the loader counts from while a run has nothing to show yet.
 *
 * It is not on the wire: it is established once from the FIRST frame this page saw, and
 * carried. Which makes the two halves worth pinning separately — that a later frame cannot
 * restate it, and that a first frame which already carries work is refused rather than
 * counted from.
 */
describe("a run's start", () => {
  /** A frame as a run really OPENS: nothing written, nothing reasoned, nothing called. */
  const opening = (over: Record<string, unknown> = {}) =>
    parseAgentFrame(frame({ phase: "thinking", text: "", steps: [], tools_used: 0, ...over }))!;

  it("is the first frame's own clock", () => {
    const runs = withAgentFrame({}, opening({ at: 1_700_000_000_000 }));
    const run = runs[opening().conversation]!;
    expect(run.started_at).toBe(1_700_000_000_000);
    expect(agentRunStartedAt(run)).toBe(1_700_000_000_000);
  });

  it("is CARRIED by every later frame, so the loader's clock never restarts", () => {
    let runs = withAgentFrame({}, opening({ at: 1_700_000_000_000 }));
    // The run works, then writes. Every frame moves `at`; none of them may move the start,
    // or the elapsed time would reset to zero on each beat under the reader.
    runs = withAgentFrame(runs, {
      ...opening({ at: 1_700_000_004_000 }),
      steps: [{ kind: "tool", tool: "Grep", target: "DEFAULT_PORT", done: false }],
    });
    runs = withAgentFrame(runs, opening({ at: 1_700_000_009_000, text: "19420", phase: "writing" }));
    expect(runs[opening().conversation]!.started_at).toBe(1_700_000_000_000);
  });

  it("is REFUSED for a run that was already going when this page arrived", () => {
    // A live run repeats its latest frame every `AGENT_STREAM_KEEPALIVE`, so a page that
    // reloads mid-run lands on one of those within fifteen seconds. Counting from it would
    // put a number on screen that understates the wait by however long the run had been
    // going, so no number is put on screen at all.
    for (const already of [
      { text: "the port is 19420" },
      { steps: [{ kind: "thought", text: "the port is a constant" }] },
      { tools_used: 3 },
    ]) {
      const run = withAgentFrame({}, opening({ at: 1_700_000_000_000, ...already }))[
        opening().conversation
      ]!;
      expect(run.started_at).toBe(0);
      expect(agentRunStartedAt(run)).toBeUndefined();
    }
  });

  it("is refused for a backend too old to stamp its frames", () => {
    const run = withAgentFrame({}, opening({ at: 0 }))[opening().conversation]!;
    expect(run.started_at).toBe(0);
    expect(agentRunStartedAt(run)).toBeUndefined();
  });

  it("starts again for the NEXT run in the same thread", () => {
    const runs = withAgentFrame({}, opening({ at: 1_700_000_000_000 }));
    const next = withAgentFrame(
      runs,
      opening({ run_id: "19:thread@thread.v2/1785773999999", at: 1_700_000_060_000 }),
    );
    expect(next[opening().conversation]!.started_at).toBe(1_700_000_060_000);
  });
});

/**
 * WHICH GLYPH A TOOL CALL IS DRAWN WITH.
 *
 * The glyph is a claim about what a call DID, beside a name the row already spells in full —
 * so what is pinned here is mostly the FALLBACK, and that it is the narrow answer rather
 * than the neutral-sounding one.
 */
describe("agentToolGlyph", () => {
  it("knows the tools that leave something behind", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "TodoWrite"]) {
      expect(agentToolGlyph(tool)).toBe("write");
    }
  });

  it("knows the tools that start a program", () => {
    for (const tool of ["Bash", "BashOutput", "KillShell", "Task"]) {
      expect(agentToolGlyph(tool)).toBe("run");
    }
  });

  it("folds case, because the two CLIs spell their own tools", () => {
    // Claude Code writes `Read`, opencode writes `read`.
    expect(agentToolGlyph("read")).toBe("read");
    expect(agentToolGlyph("edit")).toBe("write");
    expect(agentToolGlyph("bash")).toBe("run");
    expect(agentToolGlyph("  Bash  ")).toBe("run");
  });

  it("reads anything it does not know, which is the NARROW answer and not the neutral one", () => {
    // `Read`, `Glob`, `Grep` is the allowlist out of the box, and every tool in every named
    // grant reads (`every_granted_tool_reads` in src/agent.rs pins that) — so an
    // unrecognised call really is a read in every configuration but the one the user widened
    // themselves. `run` is the tempting fallback and the wrong one: it claims a command
    // executed, and overstating what the agent did is the error every gate here exists to
    // prevent.
    for (const tool of [
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "mcp__grafana__query_prometheus",
      "somethingNobodyListed",
      "",
    ]) {
      expect(agentToolGlyph(tool)).toBe("read");
    }
  });

  it("never answers `think`, which is the header's own mark", () => {
    // The sparkle says the model is reasoning, and reasoning is not a tool call — so nothing
    // maps to it, however a tool is named.
    for (const tool of ["Think", "think", "Thinking", "sequentialthinking"]) {
      expect(agentToolGlyph(tool)).not.toBe("think");
    }
  });
});

describe("withoutAgentRun", () => {
  const run = parseAgentFrame(frame())!;

  it("drops the run it was asked to drop", () => {
    const runs = withAgentFrame({}, run);
    expect(withoutAgentRun(runs, run.conversation, run.run_id)).toEqual({});
  });

  it("leaves a run that started since", () => {
    const runs = withAgentFrame({}, { ...run, run_id: "…/newer" });
    expect(withoutAgentRun(runs, run.conversation, run.run_id)).toBe(runs);
  });
});

describe("a run's life", () => {
  const run = (over: Partial<AgentRun>): AgentRun => ({
    ...parseAgentFrame(frame())!,
    started_at: 0,
    ...over,
  });

  it("is live until it is done or failed", () => {
    expect(agentRunIsLive(run({ phase: "thinking" }))).toBe(true);
    expect(agentRunIsLive(run({ phase: "working" }))).toBe(true);
    expect(agentRunIsLive(run({ phase: "writing" }))).toBe(true);
    expect(agentRunIsLive(run({ phase: "done" }))).toBe(false);
    expect(agentRunIsLive(run({ phase: "error" }))).toBe(false);
    expect(agentRunIsLive(null)).toBe(false);
  });

  it("goes stale only while live, and only past the backend's own timeout", () => {
    const live = run({ phase: "writing", at: 0 });
    expect(agentRunIsStale(live, AGENT_RUN_STALE_MS - 1)).toBe(false);
    expect(agentRunIsStale(live, AGENT_RUN_STALE_MS + 1)).toBe(true);
    // A finished run is not stale, however old: what it holds is the answer.
    expect(agentRunIsStale(run({ phase: "done", at: 0 }), AGENT_RUN_STALE_MS * 10)).toBe(false);
  });
});

describe("agentPhaseLabel", () => {
  const run = (over: Partial<AgentRun>): AgentRun => ({
    ...parseAgentFrame(frame())!,
    started_at: 0,
    ...over,
  });

  it("names the tool and its target while a tool runs", () => {
    expect(
      agentPhaseLabel(
        run({ phase: "working", activity: { tool: "Read", target: "src/agent.rs", done: false } }),
      ),
    ).toBe("Read src/agent.rs");
    // A tool whose arguments have not arrived is named on its own, not left blank.
    expect(
      agentPhaseLabel(run({ phase: "working", activity: { tool: "Grep", target: "", done: false } })),
    ).toBe("Grep");
  });

  it("names the CLI everywhere else, because that is who is answering", () => {
    // Each CLI's own casing: Claude is a proper noun, opencode is lowercase.
    expect(agentPhaseLabel(run({ phase: "thinking" }))).toBe("Claude is thinking");
    expect(agentPhaseLabel(run({ phase: "writing" }))).toBe("Claude is writing");
    expect(agentPhaseLabel(run({ phase: "done" }))).toBe("Claude");
    expect(agentPhaseLabel(run({ backend: "opencode", phase: "thinking" }))).toBe(
      "opencode is thinking",
    );
  });

  it("names the CUSTOM AGENT the reader addressed, when they addressed one", () => {
    // "Claude is thinking" under a message somebody sent to `@bebou` reads as the wrong agent
    // having picked it up. The ADDRESS is what a frame carries; the label lives in the local
    // record, and the surfaces that hold it draw it beside this line.
    expect(agentPhaseLabel(run({ persona: "bebou", phase: "thinking" }))).toBe(
      "bebou is thinking",
    );
    expect(agentPhaseLabel(run({ persona: "bebou", phase: "writing" }))).toBe("bebou is writing");
    expect(agentPhaseLabel(run({ persona: "bebou", phase: "done" }))).toBe("bebou");
    // A tool call still names the tool: what is running is the same program either way.
    expect(
      agentPhaseLabel(
        run({
          persona: "bebou",
          phase: "working",
          activity: { tool: "Read", target: "src/agent.rs", done: false },
        }),
      ),
    ).toBe("Read src/agent.rs");
  });

  it("says what a folded transcript holds, counted from the run and not from the rows", () => {
    const thought = { kind: "thought", text: "the port is a constant" } as const;
    const call = { kind: "tool", tool: "Grep", target: "PORT", done: true } as const;
    expect(agentTranscriptLabel([thought], 0)).toBe("Reasoning");
    expect(agentTranscriptLabel([thought, call], 1)).toBe("Reasoning and 1 tool call");
    // A CLI that reports no reasoning (opencode) has only its calls to name.
    expect(agentTranscriptLabel([call], 2)).toBe("2 tool calls");
    // The rows are capped at 32 and the count is not, so a long run says what it did
    // rather than what it kept.
    expect(agentTranscriptLabel([call], 40)).toBe("40 tool calls");
  });

  it("is kept as a transcript once the run is over, and only when it worked something out", () => {
    const finished = run({
      phase: "done",
      message_id: "1785773946200",
      steps: [{ kind: "thought", text: "the port is a constant" }],
      tools_used: 2,
    });
    expect(agentTranscriptOf(finished)).toEqual({
      message_id: "1785773946200",
      backend: "claude",
      steps: finished.steps,
      tools_used: 2,
      at: finished.at,
    });
    // Nothing to disclose: a CLI that reports no reasoning, answering with no tool call.
    expect(agentTranscriptOf(run({ steps: [], tools_used: 0 }))).toBeNull();
    // And nothing to key it by: a run whose message was never echoed back.
    expect(agentTranscriptOf(run({ message_id: "" }))).toBeNull();
  });

  it("keeps the newest transcripts and lets the oldest go", () => {
    const transcript = (id: number): AgentTranscript => ({
      message_id: `m${id}`,
      backend: "claude",
      steps: [{ kind: "thought", text: `run ${id}` }],
      tools_used: 1,
      at: id,
    });
    let kept: Record<string, AgentTranscript> = {};
    for (let i = 1; i <= AGENT_TRANSCRIPTS_KEPT + 3; i += 1) {
      kept = keepAgentTranscript(kept, transcript(i));
    }
    expect(Object.keys(kept)).toHaveLength(AGENT_TRANSCRIPTS_KEPT);
    // The oldest three went; the newest is there. This app is left open for days on a
    // phone, and a transcript is up to 16 KiB of reasoning.
    expect(kept.m1).toBeUndefined();
    expect(kept.m3).toBeUndefined();
    expect(kept.m4).toBeDefined();
    expect(kept[`m${AGENT_TRANSCRIPTS_KEPT + 3}`]).toBeDefined();
    // A message that answered twice is one entry, not two.
    const again = keepAgentTranscript(kept, { ...transcript(99), message_id: "m4" });
    expect(Object.keys(again)).toHaveLength(AGENT_TRANSCRIPTS_KEPT);
  });

  it("says what went wrong when a run failed", () => {
    expect(agentPhaseLabel(run({ phase: "error", error: "claude exited 1" }))).toBe(
      "claude exited 1",
    );
    expect(agentPhaseLabel(run({ phase: "error", error: null }))).toBe("Claude could not answer");
  });
});
