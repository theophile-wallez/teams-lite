import { describe, expect, it } from "vitest";
import type { AgentBackend, AgentCli, AgentStatus } from "./agent";
import {
  aboutMegabytes,
  agentCliAction,
  agentCliCheckedLabel,
  agentCliIsShadowed,
  agentCliLastChecked,
  agentClisInstalledHere,
  withAgentCliProgress,
} from "./agent-cli";

function cli(patch: Partial<AgentCli> = {}): AgentCli {
  return {
    installable: true,
    managed: false,
    version: null,
    latest: null,
    update_available: false,
    checked_ms: null,
    phase: "idle",
    received: 0,
    total: 0,
    error: "",
    download_bytes: 125_000_000,
    installed_bytes: null,
    publisher: "Anthropic",
    path: null,
    ...patch,
  };
}

function backend(patch: Partial<AgentBackend> = {}, cliPatch: Partial<AgentCli> = {}): AgentBackend {
  return {
    name: "claude",
    prefix: "@claude",
    available: false,
    enabled: true,
    model: null,
    models: [],
    cli: cli(cliPatch),
    ...patch,
  };
}

function status(backends: AgentBackend[]): AgentStatus {
  return {
    backends,
    conversations: [],
    tools: [],
    workspace: "/w",
    enabled: true,
    sandbox_conversation: "19:x",
  };
}

describe("agentCliAction", () => {
  it("offers an install where the machine lacks the CLI, with what it costs", () => {
    expect(agentCliAction(backend())).toEqual({
      kind: "install",
      label: "Install",
      cost: "about 130 MB from Anthropic",
    });
  });

  it("offers nothing where the machine cannot install it, or a backend too old to say", () => {
    expect(agentCliAction(backend({}, { installable: false }))).toEqual({ kind: "none" });
    expect(agentCliAction(backend({ cli: undefined }))).toEqual({ kind: "none" });
    expect(agentCliAction(backend({ cli: null }))).toEqual({ kind: "none" });
  });

  it("offers an update only for the copy this app installed AND runs", () => {
    const ours = backend({ available: true }, { managed: true, version: "2.1.311", latest: "2.1.318", update_available: true });
    expect(agentCliAction(ours)).toMatchObject({ kind: "update", label: "Update to 2.1.318" });
    // The user's own install, found first on PATH, is theirs to update — even from a status that
    // says a newer release exists for the app's shadowed copy.
    const theirs = backend({ available: true }, { managed: false, version: "2.1.311", latest: "2.1.318", update_available: true });
    expect(agentCliAction(theirs)).toEqual({ kind: "none" });
    // Current: nothing to press.
    const current = backend({ available: true }, { managed: true, version: "2.1.318", latest: "2.1.318" });
    expect(agentCliAction(current)).toEqual({ kind: "none" });
  });

  it("draws the bar while an install runs, whatever else is true", () => {
    expect(agentCliAction(backend({}, { phase: "downloading", received: 50, total: 200 }))).toEqual({
      kind: "busy",
      label: "Downloading… 25%",
      percent: 25,
    });
    // A download whose length is not known yet has no percent to claim.
    expect(agentCliAction(backend({}, { phase: "downloading", received: 50, total: 0 }))).toEqual({
      kind: "busy",
      label: "Downloading…",
      percent: null,
    });
    expect(agentCliAction(backend({}, { phase: "unpacking", installable: false }))).toMatchObject({
      kind: "busy",
      label: "Verifying…",
    });
  });
});

describe("the sentences", () => {
  it("rounds a size the way a person says it", () => {
    expect(aboutMegabytes(125_000_000)).toBe("about 130 MB");
    expect(aboutMegabytes(80_000_000)).toBe("about 80 MB");
    expect(aboutMegabytes(7_300_000)).toBe("about 7 MB");
    expect(aboutMegabytes(10_000)).toBe("about 1 MB");
  });

  it("names a copy that is on disk and not what runs", () => {
    expect(agentCliIsShadowed(backend({ available: true }, { version: "2.1.311", managed: false }))).toBe(true);
    expect(agentCliIsShadowed(backend({ available: true }, { version: "2.1.311", managed: true }))).toBe(false);
    expect(agentCliIsShadowed(backend({ available: true }, { version: null }))).toBe(false);
  });

  it("says when the backend last asked", () => {
    const now = 10 * 60 * 60_000;
    expect(agentCliCheckedLabel(null, now)).toBe("Not checked yet");
    expect(agentCliCheckedLabel(now - 10_000, now)).toBe("Checked just now");
    expect(agentCliCheckedLabel(now - 60_000, now)).toBe("Checked 1 minute ago");
    expect(agentCliCheckedLabel(now - 3 * 60 * 60_000, now)).toBe("Checked 3 hours ago");
  });
});

describe("the status", () => {
  it("folds a progress frame into the provider it names, and nothing else", () => {
    const before = status([backend(), backend({ name: "opencode" })]);
    const after = withAgentCliProgress(before, {
      provider: "opencode",
      phase: "downloading",
      received: 10,
      total: 100,
    });
    expect(after?.backends[1]?.cli).toMatchObject({ phase: "downloading", received: 10, total: 100 });
    expect(after?.backends[0]).toBe(before.backends[0]);
  });

  it("returns the SAME status for a frame that changes nothing, so nothing re-renders", () => {
    const before = status([backend()]);
    expect(withAgentCliProgress(before, { provider: "nobody", phase: "downloading", received: 1, total: 2 })).toBe(before);
    expect(withAgentCliProgress(before, { provider: "claude", phase: "exploding", received: 1, total: 2 })).toBe(before);
    expect(withAgentCliProgress(before, null)).toBe(before);
    expect(withAgentCliProgress(null, { provider: "claude", phase: "idle", received: 0, total: 0 })).toBeNull();
    const old = status([backend({ cli: undefined })]);
    expect(withAgentCliProgress(old, { provider: "claude", phase: "idle", received: 0, total: 0 })).toBe(old);
  });

  it("knows whether anything here was installed by this app, and when it was last checked", () => {
    expect(agentClisInstalledHere(status([backend()]))).toBe(false);
    const installed = status([
      backend({}, { version: "2.1.311", checked_ms: 5 }),
      backend({ name: "opencode" }, { version: "1.19.5", checked_ms: 9 }),
    ]);
    expect(agentClisInstalledHere(installed)).toBe(true);
    expect(agentCliLastChecked(installed)).toBe(9);
    expect(agentCliLastChecked(null)).toBeNull();
  });
});
