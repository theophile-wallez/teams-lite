import { describe, expect, it } from "vitest";
import {
  agentGrantIsOn,
  agentHint,
  agentIsUnrestricted,
  agentModeFor,
  agentRunnable,
  agentToolGrants,
  agentToolsWithGrant,
  availableBackends,
  usableBackends,
  type AgentBackend,
  type AgentStatus,
  type AgentToolGrant,
} from "./agent";

const SANDBOX = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/** One provider, installed and enabled unless the test says otherwise — the state a
 *  fresh backend reports. */
function backend(over: Partial<AgentBackend> = {}): AgentBackend {
  return {
    name: "claude",
    prefix: "@claude",
    available: true,
    enabled: true,
    model: null,
    models: ["opus", "sonnet"],
    ...over,
  };
}

const FILES: AgentToolGrant = {
  key: "files",
  label: "Read files",
  detail: "Its workspace.",
  tools: ["Read", "Glob", "Grep"],
};
const GRAFANA: AgentToolGrant = {
  key: "grafana",
  label: "Read Grafana",
  detail: "Dashboards and queries.",
  tools: ["mcp__grafana__list_datasources", "mcp__grafana__query_prometheus"],
};

function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    backends: [
      backend(),
      backend({ name: "opencode", prefix: "@opencode", available: false, models: [] }),
    ],
    conversations: [{ conversation: SANDBOX, mode: "reply" }],
    tools: ["Read", "Glob", "Grep"],
    tool_grants: [FILES, GRAFANA],
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
      backends: [backend({ available: false })],
    });
    expect(agentRunnable(none)).toBe(false);
  });

  // A read-only backend refuses the reply at its own dispatch gate, so a switch would
  // arm a conversation that still stays silent.
  it("is false on a read-only backend, whatever it holds", () => {
    expect(agentRunnable(status({ enabled: false }))).toBe(false);
  });

  // The user switched every provider off in Settings: the CLI is there, and nothing
  // answers. Arming a conversation would be as silent as a missing CLI.
  it("is false when every installed provider is switched off", () => {
    const off = status({ backends: [backend({ enabled: false })] });
    expect(agentRunnable(off)).toBe(false);
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

describe("usableBackends", () => {
  it("keeps only the providers that are installed AND switched on", () => {
    const mixed = status({
      backends: [
        backend(),
        backend({ name: "opencode", prefix: "@opencode", enabled: false }),
        backend({ name: "ghost", prefix: "@ghost", available: false }),
      ],
    });
    expect(availableBackends(mixed).map((b) => b.name)).toEqual(["claude", "opencode"]);
    expect(usableBackends(mixed).map((b) => b.name)).toEqual(["claude"]);
  });
});

describe("the tool grants", () => {
  it("offers nothing before the backend answered, and nothing on a backend that names none", () => {
    expect(agentToolGrants(null)).toEqual([]);
    expect(agentToolGrants(status({ tool_grants: undefined }))).toEqual([]);
  });

  it("reads a group as on only when EVERY tool it names is allowed", () => {
    expect(agentGrantIsOn(status(), FILES)).toBe(true);
    expect(agentGrantIsOn(status(), GRAFANA)).toBe(false);
    // Half of it is not it: the switch would read "on" while the call the user wanted
    // is still refused.
    const half = status({ tools: ["Read", "Glob", "Grep", "mcp__grafana__list_datasources"] });
    expect(agentGrantIsOn(half, GRAFANA)).toBe(false);
    expect(agentGrantIsOn(null, GRAFANA)).toBe(false);
  });

  it("adds every tool of a group it grants, and keeps what was already allowed", () => {
    expect(agentToolsWithGrant(status(), GRAFANA, true)).toEqual([
      "Read",
      "Glob",
      "Grep",
      "mcp__grafana__list_datasources",
      "mcp__grafana__query_prometheus",
    ]);
  });

  it("grants no tool twice", () => {
    const already = status({ tools: ["Read", "mcp__grafana__list_datasources"] });
    expect(agentToolsWithGrant(already, GRAFANA, true)).toEqual([
      "Read",
      "mcp__grafana__list_datasources",
      "mcp__grafana__query_prometheus",
    ]);
  });

  it("takes a group back, and leaves alone what no group named", () => {
    // `Bash` stands for a tool the user granted by hand through the RPC. A switch here
    // must not quietly take it away.
    const wide = status({
      tools: ["Read", "Glob", "Grep", "Bash", ...GRAFANA.tools],
    });
    expect(agentToolsWithGrant(wide, GRAFANA, false)).toEqual(["Read", "Glob", "Grep", "Bash"]);
  });

  it("keeps a tool another granted group still asks for", () => {
    // Two groups overlap on `Read`: turning one off must not disarm the other.
    const overlapping: AgentToolGrant = {
      key: "notes",
      label: "Read notes",
      detail: "Overlaps on Read.",
      tools: ["Read"],
    };
    const both = status({ tool_grants: [FILES, overlapping], tools: ["Read", "Glob", "Grep"] });
    expect(agentToolsWithGrant(both, FILES, false)).toEqual(["Read"]);
  });

  it("can end at no tool at all, which is a legitimate answer", () => {
    const only = status({ tool_grants: [FILES] });
    expect(agentToolsWithGrant(only, FILES, false)).toEqual([]);
  });
});

describe("agentIsUnrestricted", () => {
  // The narrow state is the default, so anything short of an explicit `true` reads as
  // "this app decides". A hopeful `true` would tell the user their own configuration is
  // in force when the allowlist is.
  it("is false until the backend says otherwise", () => {
    expect(agentIsUnrestricted(null)).toBe(false);
    expect(agentIsUnrestricted(status())).toBe(false);
    expect(agentIsUnrestricted(status({ unrestricted: undefined }))).toBe(false);
    expect(agentIsUnrestricted(status({ unrestricted: false }))).toBe(false);
  });

  it("is true when the backend reports the user's own configuration", () => {
    expect(agentIsUnrestricted(status({ unrestricted: true }))).toBe(true);
  });
});

describe("agentHint", () => {
  it("names the prefix to type when the agent can run", () => {
    expect(agentHint(status())).toContain("@claude");
  });

  // Never tell somebody to type a prefix that a setting of theirs will drop.
  it("names only the providers that are switched on", () => {
    const mixed = status({
      backends: [backend(), backend({ name: "opencode", prefix: "@opencode", enabled: false })],
    });
    expect(agentHint(mixed)).toContain("@claude");
    expect(agentHint(mixed)).not.toContain("@opencode");
  });

  it("says so when the CLI is installed but every provider is off", () => {
    const off = status({ backends: [backend({ enabled: false })] });
    expect(agentHint(off)).toContain("switched off");
    expect(agentHint(off)).toContain("claude");
  });

  it("says the machine has no agent installed, and which ones it looked for", () => {
    const none = status({
      backends: [
        backend({ available: false }),
        backend({ name: "opencode", prefix: "@opencode", available: false }),
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
