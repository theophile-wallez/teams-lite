import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_STALE_MS,
  agentPhaseLabel,
  agentRunIsLive,
  agentRunIsStale,
  parseAgentFrame,
  withAgentFrame,
  withoutAgentRun,
  type AgentRun,
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
    thinking: "",
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
    expect(agentPhaseLabel(run({ phase: "thinking" }))).toBe("claude is thinking");
    expect(agentPhaseLabel(run({ phase: "writing" }))).toBe("claude is writing");
    expect(agentPhaseLabel(run({ phase: "done" }))).toBe("claude, via teams-lite");
    expect(agentPhaseLabel(run({ backend: "opencode", phase: "thinking" }))).toBe(
      "opencode is thinking",
    );
  });

  it("says what went wrong when a run failed", () => {
    expect(agentPhaseLabel(run({ phase: "error", error: "claude exited 1" }))).toBe(
      "claude exited 1",
    );
    expect(agentPhaseLabel(run({ phase: "error", error: null }))).toBe("claude could not answer");
  });
});
