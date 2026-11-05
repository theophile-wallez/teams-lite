/**
 * Signing an agent CLI in from Settings › AI providers — the page's pure half
 * (src/agent_auth.rs is the backend's, components/agent-auth.tsx draws it).
 *
 * Nothing here holds a secret: the backend publishes whether a key is set and never the key, and
 * every sentence below is built from that.
 */

import type {
  AgentAccount,
  AgentAuth,
  AgentBackend,
  BedrockKind,
  ClaudeAccount,
  ClaudeMethod,
  OpencodeCredential,
} from "./agent";

/** One way Claude Code can sign in, as the picker offers it. */
export type ClaudeMethodOption = {
  method: ClaudeMethod;
  label: string;
  /** What choosing it means, in one line. */
  detail: string;
};

/** The ways in, in the order a reader looks for them: their own account first, the machine's
 *  own setup last — it is the default, and the one nobody has to choose. */
export const CLAUDE_METHODS: readonly ClaudeMethodOption[] = [
  {
    method: "claude_ai",
    label: "Claude account",
    detail: "Your Claude Pro, Max, Team or Enterprise plan, signed in on claude.com.",
  },
  {
    method: "api_key",
    label: "Anthropic API key",
    detail: "Billed to the Anthropic Console organization the key belongs to.",
  },
  {
    method: "bedrock",
    label: "Amazon Bedrock",
    detail: "Claude through your AWS account, billed by AWS.",
  },
  {
    method: "vertex",
    label: "Google Vertex AI",
    detail: "Claude through your Google Cloud project, billed by Google.",
  },
  {
    method: "foundry",
    label: "Microsoft Foundry",
    detail: "Claude through your Azure resource, billed by Microsoft.",
  },
  {
    method: "machine",
    label: "This machine's own setup",
    detail: "Whatever Claude Code is already set up to use where the app runs.",
  },
];

export function claudeMethodOption(method: ClaudeMethod): ClaudeMethodOption {
  return CLAUDE_METHODS.find((option) => option.method === method) ?? CLAUDE_METHODS[5]!;
}

/** The cloud accounts, by the method that runs on each. */
export type CloudKind = "bedrock" | "vertex" | "foundry";

export const CLOUD_LABELS: Record<CloudKind, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
};

/** Whether a method needs something set up before Claude Code can run on it — the section of the
 *  form that collects it — or nothing more. */
export function claudeMethodNeeds(method: ClaudeMethod, auth: AgentAuth | undefined): "key" | CloudKind | null {
  switch (method) {
    case "api_key":
      return auth?.anthropic_key ? null : "key";
    case "bedrock":
    case "vertex":
    case "foundry":
      return auth?.[method] ? null : method;
    default:
      return null;
  }
}

/** Whether a Claude account signs Claude Code in now: the only state Sign out undoes. */
export function claudeSignedInWithAccount(account: ClaudeAccount | null | undefined): boolean {
  return Boolean(account?.logged_in && account.method === "claude.ai");
}

/** Whether the Claude account sign-in is worth offering under a method: it is what that method
 *  runs on, or the machine's own setup when nothing ranks above the account there.
 *
 *  Under the machine's own setup a run keeps whatever the environment says, so a provider flag or
 *  a key there OUTRANKS the account — a sign-in would complete and never take effect. The account
 *  is offered only where the status says nothing ranks above it ("none" or "claude.ai"), and
 *  {@link claudeMachineOutranksAccount} names what does otherwise. */
export function claudeAccountApplies(method: ClaudeMethod, account?: ClaudeAccount | null): boolean {
  if (method === "claude_ai") return true;
  if (method !== "machine") return false;
  return !claudeMachineOutranksAccount(account);
}

/** Whether the machine's own setup signs Claude Code in some way that ranks above a Claude account. */
export function claudeMachineOutranksAccount(account: ClaudeAccount | null | undefined): boolean {
  if (!account?.logged_in) return false;
  return account.method !== "claude.ai" && account.method !== "none";
}

function capitalized(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

const PROVIDER_LABELS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  mantle: "Amazon Bedrock (Mantle)",
  anthropicAws: "Claude Platform on AWS",
  anthropicGoogleCloud: "Claude Platform on Google Cloud",
  gateway: "a Claude apps gateway",
};

/** The one line that says how Claude Code signs in right now — what a run will use. */
export function claudeAccountLine(account: AgentAccount | null | undefined): string {
  if (!account) return "This backend cannot say how Claude Code signs in.";
  const status = account.account;
  if (!status) {
    if (account.error) return `Could not ask Claude Code how it signs in: ${account.error}`;
    return account.checked_ms ? "Claude Code is not on this machine." : "Checking how Claude Code signs in…";
  }
  if (!status.logged_in) return "Not signed in.";
  switch (status.method) {
    case "claude.ai": {
      const who = status.email ?? "a Claude account";
      const plan = status.plan ? ` · Claude ${capitalized(status.plan)}` : "";
      return `Signed in as ${who}${plan}`;
    }
    case "api_key":
      return "Signed in with an Anthropic API key.";
    case "api_key_helper":
      return "Signed in with an API key its own settings fetch.";
    case "oauth_token":
      return "Signed in with a long-lived token from the environment.";
    case "third_party": {
      const through = PROVIDER_LABELS[status.provider] ?? status.provider;
      return `Runs through ${through}.`;
    }
    default:
      return "Signed in.";
  }
}

// ---- opencode ------------------------------------------------------------------------------------

/** The providers opencode is most often given a key for, as models.dev names them. "Other" takes
 *  any id, because the list is a convenience and never a limit. */
export const OPENCODE_KEY_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "amazon-bedrock", label: "Amazon Bedrock (API key)" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "google", label: "Google AI Studio" },
  { id: "mistral", label: "Mistral" },
  { id: "groq", label: "Groq" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "xai", label: "xAI" },
];

/** A provider id as opencode spells one — the backend's `agent_auth::is_provider_id`. */
export function isOpencodeProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

export function opencodeProviderLabel(id: string): string {
  return OPENCODE_KEY_PROVIDERS.find((provider) => provider.id === id)?.label.replace(" (API key)", "") ?? id;
}

export function opencodeCredentialKind(credential: OpencodeCredential): string {
  switch (credential.kind) {
    case "api":
      return "API key";
    case "oauth":
      return "Signed in";
    case "wellknown":
      return "Token";
    default:
      return credential.kind;
  }
}

/** The opencode providers a cloud account here hands it, for the line that says so. */
export function opencodeCloudLabels(auth: AgentAuth | undefined): string[] {
  const out: string[] = [];
  if (auth?.bedrock) out.push("Amazon Bedrock");
  if (auth?.vertex) out.push("Google Vertex AI");
  return out;
}

/**
 * Whether opencode's OWN `amazon-bedrock` key outranks the Bedrock cloud account here.
 *
 * opencode reads a bearer token before the AWS credential chain, and takes one from its own
 * `auth.json` when the environment carries none (v1.19.5 `provider.ts`). A cloud account set up
 * with a Bedrock API key puts its token in the environment, which wins; one set up with an access
 * key or a profile does not, so a key under Provider keys is what opencode really uses — and the
 * page says so rather than claiming the cloud account answers.
 */
export function opencodeBedrockKeyWins(auth: AgentAuth | undefined, credentials: OpencodeCredential[]): boolean {
  if (!auth?.bedrock || auth.bedrock.kind === "api_key") return false;
  return credentials.some((credential) => credential.provider === "amazon-bedrock");
}

// ---- cloud accounts ------------------------------------------------------------------------------

export const BEDROCK_KINDS: readonly { kind: BedrockKind; label: string }[] = [
  { kind: "api_key", label: "Bedrock API key" },
  { kind: "access_key", label: "Access key" },
  { kind: "profile", label: "AWS profile" },
];

/** One line naming what a cloud account is set up with — never a secret. */
export function cloudSummary(kind: CloudKind, auth: AgentAuth | undefined): string | null {
  if (kind === "bedrock") {
    const bedrock = auth?.bedrock;
    if (!bedrock) return null;
    const how =
      bedrock.kind === "api_key"
        ? "Bedrock API key"
        : bedrock.kind === "profile"
          ? `profile ${bedrock.profile ?? ""}`.trim()
          : `access key …${bedrock.access_key_id_tail ?? ""}${bedrock.session_token ? " with a session token" : ""}`;
    return `${bedrock.region} · ${how}`;
  }
  if (kind === "vertex") {
    const vertex = auth?.vertex;
    if (!vertex) return null;
    const how = vertex.service_account ?? "Application Default Credentials";
    return `${vertex.project} · ${vertex.region} · ${how}`;
  }
  const foundry = auth?.foundry;
  return foundry ? foundry.resource : null;
}

/** Whether the cloud account a method runs on is the one Claude Code uses now — which is why
 *  removing it is refused until Claude Code is moved. */
export function cloudInUse(kind: CloudKind, auth: AgentAuth | undefined): boolean {
  return auth?.claude_method === kind;
}

/** The account block a backend shows: Claude Code's sign-in, opencode's keys, or none. */
export function agentAccountKind(backend: AgentBackend): "claude" | "opencode" | null {
  if (!backend.available || !backend.account) return null;
  if (backend.name === "claude") return "claude";
  if (backend.name === "opencode") return "opencode";
  return null;
}
