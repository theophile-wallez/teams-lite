import { describe, expect, it } from "vitest";
import type { AgentAccount, AgentAuth, AgentBackend } from "./agent";
import {
  CLAUDE_METHODS,
  agentAccountKind,
  claudeAccountApplies,
  claudeAccountLine,
  claudeMachineOutranksAccount,
  claudeMethodNeeds,
  claudeSignedInWithAccount,
  cloudInUse,
  cloudSummary,
  isOpencodeProviderId,
  opencodeBedrockKeyWins,
  opencodeCloudLabels,
  opencodeProviderLabel,
} from "./agent-auth";

function auth(patch: Partial<AgentAuth> = {}): AgentAuth {
  return { claude_method: "machine", anthropic_key: false, bedrock: null, vertex: null, foundry: null, ...patch };
}

const SIGNED_IN = {
  logged_in: true,
  method: "claude.ai",
  provider: "firstParty",
  email: "ada@example.com",
  organization: "Ada Lovelace",
  plan: "max",
};

function account(patch: Partial<AgentAccount> = {}): AgentAccount {
  return { account: null, error: "", checked_ms: 1, signin: null, ...patch };
}

describe("Claude Code's way in", () => {
  it("offers every method once, the machine's own setup last", () => {
    expect(CLAUDE_METHODS.map((m) => m.method)).toEqual(["claude_ai", "api_key", "bedrock", "vertex", "foundry", "machine"]);
  });

  it("names what a method still needs, and nothing once it is there", () => {
    expect(claudeMethodNeeds("claude_ai", auth())).toBeNull();
    expect(claudeMethodNeeds("machine", auth())).toBeNull();
    expect(claudeMethodNeeds("api_key", auth())).toBe("key");
    expect(claudeMethodNeeds("api_key", auth({ anthropic_key: true }))).toBeNull();
    expect(claudeMethodNeeds("bedrock", auth())).toBe("bedrock");
    expect(claudeMethodNeeds("bedrock", auth({ bedrock: { region: "eu-west-3", kind: "api_key" } }))).toBeNull();
    // A backend too old to say needs everything, which is the safe reading: no method is saved
    // that the backend would then refuse.
    expect(claudeMethodNeeds("foundry", undefined)).toBe("foundry");
  });

  it("offers the Claude account where it is what decides", () => {
    expect(claudeAccountApplies("claude_ai")).toBe(true);
    expect(claudeAccountApplies("machine")).toBe(true);
    expect(claudeAccountApplies("machine", { ...SIGNED_IN, logged_in: false, method: "none" })).toBe(true);
    expect(claudeAccountApplies("machine", SIGNED_IN)).toBe(true);
    expect(claudeAccountApplies("bedrock")).toBe(false);
    expect(claudeAccountApplies("api_key")).toBe(false);
  });

  it("does not offer an account the machine's own setup would never use", () => {
    // A provider flag or a key in the machine's environment ranks above the account there, so a
    // sign-in would complete and never take effect.
    const onBedrock = { ...SIGNED_IN, method: "third_party", provider: "bedrock", email: null };
    expect(claudeMachineOutranksAccount(onBedrock)).toBe(true);
    expect(claudeAccountApplies("machine", onBedrock)).toBe(false);
    expect(claudeAccountApplies("machine", { ...SIGNED_IN, method: "api_key" })).toBe(false);
    // Choosing the account explicitly clears those, so it is offered there whatever the machine says.
    expect(claudeAccountApplies("claude_ai", onBedrock)).toBe(true);
    expect(claudeMachineOutranksAccount(null)).toBe(false);
  });

  it("calls only a Claude account login signed in to one", () => {
    expect(claudeSignedInWithAccount(SIGNED_IN)).toBe(true);
    expect(claudeSignedInWithAccount({ ...SIGNED_IN, method: "api_key" })).toBe(false);
    expect(claudeSignedInWithAccount({ ...SIGNED_IN, logged_in: false })).toBe(false);
    expect(claudeSignedInWithAccount(null)).toBe(false);
  });
});

describe("the line that says how Claude Code signs in", () => {
  it("names the account and its plan", () => {
    expect(claudeAccountLine(account({ account: SIGNED_IN }))).toBe("Signed in as ada@example.com · Claude Max");
    expect(claudeAccountLine(account({ account: { ...SIGNED_IN, plan: null } }))).toBe("Signed in as ada@example.com");
  });

  it("says which provider a cloud run goes through", () => {
    const through = (provider: string) =>
      claudeAccountLine(account({ account: { ...SIGNED_IN, method: "third_party", provider, email: null } }));
    expect(through("bedrock")).toBe("Runs through Amazon Bedrock.");
    expect(through("vertex")).toBe("Runs through Google Vertex AI.");
    expect(through("foundry")).toBe("Runs through Microsoft Foundry.");
  });

  it("tells waiting, failing and absent apart", () => {
    expect(claudeAccountLine(account({ checked_ms: null }))).toBe("Checking how Claude Code signs in…");
    expect(claudeAccountLine(account({ error: "it hung" }))).toBe("Could not ask Claude Code how it signs in: it hung");
    expect(claudeAccountLine(account())).toBe("Claude Code is not on this machine.");
    expect(claudeAccountLine(account({ account: { ...SIGNED_IN, logged_in: false, method: "none" } }))).toBe(
      "Not signed in.",
    );
    expect(claudeAccountLine(undefined)).toContain("cannot say");
  });
});

describe("cloud accounts", () => {
  it("summarizes what each is set up with, and never a secret", () => {
    expect(cloudSummary("bedrock", auth())).toBeNull();
    expect(cloudSummary("bedrock", auth({ bedrock: { region: "eu-west-3", kind: "api_key" } }))).toBe(
      "eu-west-3 · Bedrock API key",
    );
    expect(
      cloudSummary(
        "bedrock",
        auth({ bedrock: { region: "us-east-1", kind: "access_key", access_key_id_tail: "WXYZ", session_token: true } }),
      ),
    ).toBe("us-east-1 · access key …WXYZ with a session token");
    expect(cloudSummary("bedrock", auth({ bedrock: { region: "us-east-1", kind: "profile", profile: "work" } }))).toBe(
      "us-east-1 · profile work",
    );
    expect(
      cloudSummary("vertex", auth({ vertex: { project: "p-1234", region: "global", service_account: null } })),
    ).toBe("p-1234 · global · Application Default Credentials");
    expect(cloudSummary("foundry", auth({ foundry: { resource: "my-res" } }))).toBe("my-res");
  });

  it("knows which one Claude Code runs on", () => {
    expect(cloudInUse("bedrock", auth({ claude_method: "bedrock" }))).toBe(true);
    expect(cloudInUse("vertex", auth({ claude_method: "bedrock" }))).toBe(false);
  });

  it("names the clouds opencode reaches — Foundry is not one of them", () => {
    expect(
      opencodeCloudLabels(
        auth({
          bedrock: { region: "eu-west-3", kind: "api_key" },
          vertex: { project: "p-1234", region: "global", service_account: null },
          foundry: { resource: "r" },
        }),
      ),
    ).toEqual(["Amazon Bedrock", "Google Vertex AI"]);
  });
});

describe("opencode", () => {
  it("says when its own Bedrock key outranks the cloud account", () => {
    const keys = [{ provider: "amazon-bedrock", kind: "api" }];
    // A cloud account with a Bedrock API key puts its token in the environment, which opencode reads first.
    expect(opencodeBedrockKeyWins(auth({ bedrock: { region: "us-east-1", kind: "api_key" } }), keys)).toBe(false);
    // One with an access key or a profile does not, so opencode's own key is what it uses.
    expect(opencodeBedrockKeyWins(auth({ bedrock: { region: "us-east-1", kind: "access_key" } }), keys)).toBe(true);
    expect(opencodeBedrockKeyWins(auth({ bedrock: { region: "us-east-1", kind: "profile" } }), [])).toBe(false);
    expect(opencodeBedrockKeyWins(auth(), keys)).toBe(false);
  });

  it("accepts a provider id as opencode spells one", () => {
    for (const id of ["anthropic", "amazon-bedrock", "fireworks-ai", "x.ai"]) expect(isOpencodeProviderId(id)).toBe(true);
    for (const id of ["", "Anthropic", "../x", "-x", "a b"]) expect(isOpencodeProviderId(id)).toBe(false);
  });

  it("names a provider by its label, and an unknown one by its id", () => {
    expect(opencodeProviderLabel("amazon-bedrock")).toBe("Amazon Bedrock");
    expect(opencodeProviderLabel("fireworks-ai")).toBe("fireworks-ai");
  });

  it("draws an account block only for a CLI on the machine", () => {
    const backend = (patch: Partial<AgentBackend>): AgentBackend => ({
      name: "claude",
      prefix: "@claude",
      available: true,
      enabled: true,
      model: null,
      models: [],
      account: account(),
      ...patch,
    });
    expect(agentAccountKind(backend({}))).toBe("claude");
    expect(agentAccountKind(backend({ name: "opencode" }))).toBe("opencode");
    expect(agentAccountKind(backend({ available: false }))).toBeNull();
    expect(agentAccountKind(backend({ account: undefined }))).toBeNull();
  });
});
