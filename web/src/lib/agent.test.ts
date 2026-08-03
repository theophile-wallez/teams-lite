import { describe, expect, it } from "vitest";
import {
  agentHint,
  agentModeFor,
  agentRunnable,
  availableBackends,
  type AgentStatus,
} from "./agent";

const SANDBOX = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    backends: [
      { name: "claude", prefix: "@claude", available: true },
      { name: "opencode", prefix: "@opencode", available: false },
    ],
    conversations: [{ conversation: SANDBOX, mode: "reply" }],
    tools: ["Read", "Glob", "Grep"],
    workspace: "/home/u/GitHub/teams-lite",
    enabled: true,
    sandbox_conversation: SANDBOX,
    ...over,
  };
}

describe("agentModeFor", () => {
  it("reads the mode the backend stored for that conversation", () => {
    expect(agentModeFor(status(), SANDBOX)).toBe("reply");
  });

  // The default is the one thing that must never drift: a conversation nobody named
  // is off, because being listed is the consent.
  it("is off for a conversation the backend did not list", () => {
    expect(agentModeFor(status(), "19:somebody-else@unq.gbl.spaces")).toBe("off");
  });

  it("is off before the backend has answered, and with no conversation open", () => {
    expect(agentModeFor(null, SANDBOX)).toBe("off");
    expect(agentModeFor(status(), null)).toBe("off");
  });
});

describe("agentRunnable", () => {
  it("is true when the machine holds at least one CLI", () => {
    expect(agentRunnable(status())).toBe(true);
  });

  it("is false when no CLI is installed", () => {
    const none = status({
      backends: [{ name: "claude", prefix: "@claude", available: false }],
    });
    expect(agentRunnable(none)).toBe(false);
  });

  // A read-only backend refuses the reply at its own dispatch gate, so a switch would
  // arm a conversation that still stays silent.
  it("is false on a read-only backend, whatever it holds", () => {
    expect(agentRunnable(status({ enabled: false }))).toBe(false);
  });

  it("is false before the backend has answered", () => {
    expect(agentRunnable(null)).toBe(false);
  });
});

describe("availableBackends", () => {
  it("keeps only the CLIs the machine has", () => {
    expect(availableBackends(status()).map((b) => b.name)).toEqual(["claude"]);
  });
});

describe("agentHint", () => {
  it("names the prefix to type when the agent can run", () => {
    expect(agentHint(status())).toContain("@claude");
  });

  it("says the machine has no agent installed, and which ones it looked for", () => {
    const none = status({
      backends: [
        { name: "claude", prefix: "@claude", available: false },
        { name: "opencode", prefix: "@opencode", available: false },
      ],
    });
    expect(agentHint(none)).toBe("No agent is installed on this machine (claude or opencode).");
  });

  it("says a read-only backend never answers", () => {
    expect(agentHint(status({ enabled: false }))).toContain("read-only");
  });

  it("says nothing is known before the backend answers", () => {
    expect(agentHint(null)).toContain("not said yet");
  });
});
