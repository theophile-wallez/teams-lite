import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_STALE_MS,
  AGENT_TRANSCRIPTS_KEPT,
  agentPhaseLabel,
  agentRunIsLive,
  agentRunIsStale,
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
  const run = (over: Partial<AgentRun>): AgentRun => ({ ...parseAgentFrame(frame())!, ...over });

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
  const run = (over: Partial<AgentRun>): AgentRun => ({ ...parseAgentFrame(frame())!, ...over });

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
