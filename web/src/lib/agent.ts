/**
 * The local agent, as the backend describes it (`agent_status` in src/bin/server.rs,
 * over src/agent.rs and src/agent_policy.rs).
 *
 * The feature answers an `@claude` message the USER wrote by running that CLI on the
 * machine the backend runs on, and streaming the answer into the thread. Two facts
 * shape everything here:
 *
 * - **A conversation is off until the user opts it in.** The sandbox channel is the
 *   single built-in exception. So this is not a display of a setting — it IS the
 *   consent gate, which is why `agent_set_mode` is a write request.
 * - **The CLI lives on the backend's machine, not in the browser.** A backend that has
 *   no `claude` on its PATH can never answer, so a UI must say that rather than offer a
 *   switch that would do nothing.
 */

/**
 * One model the backend offers for a provider (`agent_models::Choice`).
 *
 * Only `id` ever reaches the CLI. The rest is what lets a picker read as a list of
 * models rather than a list of strings — a phone user should not have to remember
 * which of `haiku` and `opus` is the big one, or what either of them can hold.
 *
 * The list is per machine, not per app: opencode's half is read from the catalogue
 * opencode itself keeps, filtered to the providers that machine authenticated. It is
 * a picker, never a limit — a model nobody listed is still typed in and saved.
 */
export type AgentModel = {
  /** What the CLI is given: "opus", "amazon-bedrock/anthropic.claude-opus-5". */
  id: string;
  /** The name a person reads: "Opus 5", "Claude Opus 5". */
  label: string;
  /** Who made it, as an id: "anthropic", "amazon-bedrock". */
  vendor: string;
  /** How that vendor is named to the user: "Anthropic". */
  vendor_label: string;
  /** The context window in tokens, or null when this machine holds no catalogue
   *  entry for the model. */
  context: number | null;
  /** The most tokens one answer may hold, on the same terms. */
  output: number | null;
};

/** One agent CLI the backend knows how to run — an AI provider, in the Settings pane. */
export type AgentBackend = {
  /** How it is named to the user: "claude", "opencode". */
  name: string;
  /** The prefix that summons it in a thread: "@claude". */
  prefix: string;
  /** Whether the backend's machine has that CLI on its PATH. */
  available: boolean;
  /** Whether the user left this provider on. Every installed one is on by default. */
  enabled: boolean;
  /** The model the user chose, or null to leave the CLI its own configured default. */
  model: string | null;
  /** The models this machine can offer — never a limit on what may be typed. */
  models: AgentModel[];
};

/** What one `agent_set_provider` call changes. Every half is optional, so a switch
 *  can be flipped without restating the model. */
export type AgentProviderPatch = {
  enabled?: boolean;
  /** A model name, or "" to go back to the CLI's own default. */
  model?: string;
  /** Make this provider the default one — see {@link agentDefaultProvider}. Only `true`
   *  is accepted: a machine has exactly one default, so it is moved by naming the other
   *  provider, never by clearing this one. */
  default?: true;
};

/** What one conversation does with a trigger the user writes in it. */
export type AgentMode = "off" | "reply";

/**
 * One named group of tools the user can grant the agent, as the backend offers it
 * (`agent::TOOL_GRANTS`).
 *
 * The stored allowlist is a flat list of tool names; a group is how that list is
 * *offered*, so the consent reads as a sentence ("it may read Grafana") instead of
 * thirty MCP tool names the user would have to spell. Every tool in every group reads —
 * the backend pins that, because those systems belong to the user's colleagues too, and
 * a thread transcript is untrusted text that travels with every prompt.
 */
export type AgentToolGrant = {
  /** Stable id of the switch. */
  key: string;
  /** What the switch says. */
  label: string;
  /** One line of why, under the switch. */
  detail: string;
  /** The tool names it adds to the allowlist. */
  tools: string[];
};

/** One conversation's stored mode. */
export type AgentConversationMode = {
  conversation: string;
  mode: AgentMode;
};

/** Everything `agent_status` reports. */
export type AgentStatus = {
  backends: AgentBackend[];
  /** The provider a surface offers when it offers ONE — see {@link agentDefaultProvider}.
   *  Absent on a backend too old to name one, which then reads as the first provider. */
  default_provider?: string;
  conversations: AgentConversationMode[];
  /** The tools an agent may use without being asked — read-only by default. */
  tools: string[];
  /** The groups of tools the user may switch on. Absent from an older backend, which
   *  is then offered no switch rather than a guessed one. */
  tool_grants?: AgentToolGrant[];
  /** Whether the agent runs on the user's OWN Claude Code configuration — every MCP
   *  server and tool their settings hold — instead of the allowlist above. Off in a
   *  fresh store, and absent on a backend too old to know the setting. */
  unrestricted?: boolean;
  /** The directory an agent runs in. */
  workspace: string;
  /** False on a read-only backend, which never answers whatever the modes say. */
  enabled: boolean;
  /** The one conversation that is opted in out of the box. */
  sandbox_conversation: string;
};

/** The mode one conversation is in. Anything the backend did not list is `off`, which
 *  is the default the backend itself applies. */
export function agentModeFor(
  status: AgentStatus | null,
  conversationId: string | null,
): AgentMode {
  if (!status || !conversationId) return "off";
  return status.conversations.find((c) => c.conversation === conversationId)?.mode ?? "off";
}

/** Whether the backend could answer at all: not read-only, and holding at least one
 *  provider that is both installed and switched on. */
export function agentRunnable(status: AgentStatus | null): boolean {
  return !!status && status.enabled && usableBackends(status).length > 0;
}

/** The providers this machine has a CLI for, in the order the backend listed them.
 *  Installed says nothing about whether the user left it on — see {@link usableBackends}. */
export function availableBackends(status: AgentStatus | null): AgentBackend[] {
  return status?.backends.filter((b) => b.available) ?? [];
}

/** The providers that would actually answer a trigger: installed AND enabled. This is
 *  what a hint may name, because a disabled provider ignores its own prefix. */
export function usableBackends(status: AgentStatus | null): AgentBackend[] {
  return availableBackends(status).filter((b) => b.enabled);
}

/**
 * The provider the machine names as its default, as a name (`claude`).
 *
 * Every enabled provider still answers its own prefix — the default changes none of that.
 * It answers the other question: which single one a surface with room for one row offers,
 * which is what a message's ⋯ menu has (see {@link defaultUsableBackends}).
 *
 * A backend too old to name one, and a name none of them carries, both read as the FIRST
 * provider — the order this app lists them in, and the one the backend's own
 * `agent_policy::DEFAULT_BACKEND` holds. There is always exactly one, so an unanswered
 * status must not leave a menu with no row.
 */
export function agentDefaultProvider(status: AgentStatus | null): string {
  const backends = status?.backends ?? [];
  const named = backends.find((backend) => backend.name === status?.default_provider);
  return (named ?? backends[0])?.name ?? "";
}

/**
 * The one provider a menu should offer: the default, when it would really answer.
 *
 * Two rules meet here, and the order between them is the whole of it. The default is a
 * preference, so it wins — one row, the vendor the user chose. But a row that summons
 * nothing is the lie {@link usableBackends} exists to prevent, so a default whose CLI this
 * machine lacks (or which the user switched off) hands the menu back to the providers that
 * would answer, rather than leaving the reader a row that does nothing.
 */
export function defaultUsableBackends(status: AgentStatus | null): AgentBackend[] {
  const usable = usableBackends(status);
  const preferred = agentDefaultProvider(status);
  const only = usable.filter((backend) => backend.name === preferred);
  return only.length > 0 ? only : usable;
}

/** The groups this backend offers. Empty before it has answered, and on a backend too
 *  old to name any — a switch nobody described must not be drawn. */
export function agentToolGrants(status: AgentStatus | null): AgentToolGrant[] {
  return status?.tool_grants ?? [];
}

/** Whether the agent runs on the user's own Claude Code configuration. False until the
 *  backend says otherwise: this app's own allowlist is the default, so an unanswered
 *  status must never read as the wider state. */
export function agentIsUnrestricted(status: AgentStatus | null): boolean {
  return status?.unrestricted === true;
}

/** Whether a group is granted: EVERY tool it names is in the allowlist.
 *
 *  All of them, not any: a half-granted group is a switch that reads "on" while the
 *  call the user wanted is still refused. */
export function agentGrantIsOn(status: AgentStatus | null, grant: AgentToolGrant): boolean {
  if (!status || grant.tools.length === 0) return false;
  return grant.tools.every((tool) => status.tools.includes(tool));
}

/**
 * The whole allowlist after switching one group on or off.
 *
 * `agent_set_tools` replaces the list rather than adding to it, so this has to compute
 * the full answer. Two things it is careful about:
 *
 * - **A tool no group names is kept.** The RPC takes any list, so the user may have
 *   granted something by hand; a switch here must not quietly take it back.
 * - **A tool another granted group also names is kept.** Groups overlap (a built-in
 *   read tool can appear in two), so turning one off removes only what nothing else
 *   still asks for.
 */
export function agentToolsWithGrant(
  status: AgentStatus,
  grant: AgentToolGrant,
  on: boolean,
): string[] {
  if (on) {
    const missing = grant.tools.filter((tool) => !status.tools.includes(tool));
    return [...status.tools, ...missing];
  }
  const keep = new Set(
    agentToolGrants(status)
      .filter((other) => other.key !== grant.key && agentGrantIsOn(status, other))
      .flatMap((other) => other.tools),
  );
  const dropped = new Set(grant.tools.filter((tool) => !keep.has(tool)));
  return status.tools.filter((tool) => !dropped.has(tool));
}

/**
 * How a provider is named to a person: "Claude", "OpenCode".
 *
 * `AgentBackend.name` is the RPC spelling and the word the reply signs itself with, so
 * it is lowercase everywhere it matters and must stay that way. A settings pane is the
 * one place that reads as a product name, so the capitals live here rather than in the
 * backend. A provider this app has never heard of keeps its own name — a machine may
 * hold a CLI a newer backend added.
 */
export function agentBackendLabel(name: string): string {
  switch (name) {
    case "claude":
      return "Claude";
    case "opencode":
      return "OpenCode";
    default:
      return name;
  }
}

/** A token count as a person reads it: 1000000 → "1M", 200000 → "200K". Exact
 *  multiples only get the short form, so an odd number is never rounded into a lie. */
export function formatTokens(count: number): string {
  if (count % 1_000_000 === 0) return `${count / 1_000_000}M`;
  if (count % 1_000 === 0) return `${count / 1_000}K`;
  return `${count}`;
}

/**
 * What one model holds: "1M context · 128K output".
 *
 * A limit the machine's catalogue does not state is dropped rather than shown as a
 * zero or a dash, so an empty string is the honest answer for a model this machine
 * knows by name and nothing else.
 */
export function agentModelLimits(model: AgentModel): string {
  const parts: string[] = [];
  if (model.context !== null) parts.push(`${formatTokens(model.context)} context`);
  if (model.output !== null) parts.push(`${formatTokens(model.output)} output`);
  return parts.join(" · ");
}

/**
 * The same, with the vendor in front — for the one place that has no vendor heading
 * above it to lean on.
 */
export function agentModelDetail(model: AgentModel): string {
  return [model.vendor_label, agentModelLimits(model)].filter((part) => part).join(" · ");
}

/** The offered model with that id, or null. Null covers both a model the user typed
 *  and one this machine's catalogue stopped listing — the pane shows the stored id
 *  either way rather than pretending nothing is set. */
export function agentModelNamed(backend: AgentBackend, id: string | null): AgentModel | null {
  if (!id) return null;
  return backend.models.find((model) => model.id === id) ?? null;
}

/** One line saying how to summon the agent, or why it cannot be summoned — the text a
 *  menu shows under the switch. Written for somebody holding a phone, so it names the
 *  prefix they have to type. */
export function agentHint(status: AgentStatus | null): string {
  if (!status) return "The backend has not said yet.";
  if (!status.enabled) return "This backend is read-only, so it never answers.";
  const installed = availableBackends(status);
  if (installed.length === 0) {
    const names = status.backends.map((b) => b.name).join(" or ");
    return `No agent is installed on this machine (${names}).`;
  }
  const usable = usableBackends(status);
  if (usable.length === 0) {
    const names = installed.map((b) => b.name).join(" and ");
    return `Every provider is switched off (${names}). Turn one on in Settings.`;
  }
  return `Write ${usable.map((b) => b.prefix).join(" or ")} to ask for an answer.`;
}
