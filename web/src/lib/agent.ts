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

/** One agent CLI the backend knows how to run. */
export type AgentBackend = {
  /** How it is named to the user: "claude", "opencode". */
  name: string;
  /** The prefix that summons it in a thread: "@claude". */
  prefix: string;
  /** Whether the backend's machine has that CLI on its PATH. */
  available: boolean;
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
  conversations: AgentConversationMode[];
  /** The tools an agent may use without being asked — read-only by default. */
  tools: string[];
  /** The groups of tools the user may switch on. Absent from an older backend, which
   *  is then offered no switch rather than a guessed one. */
  tool_grants?: AgentToolGrant[];
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
 *  CLI it can actually run. */
export function agentRunnable(status: AgentStatus | null): boolean {
  return !!status && status.enabled && status.backends.some((b) => b.available);
}

/** The backends this machine can run, in the order the backend listed them. */
export function availableBackends(status: AgentStatus | null): AgentBackend[] {
  return status?.backends.filter((b) => b.available) ?? [];
}

/** The groups this backend offers. Empty before it has answered, and on a backend too
 *  old to name any — a switch nobody described must not be drawn. */
export function agentToolGrants(status: AgentStatus | null): AgentToolGrant[] {
  return status?.tool_grants ?? [];
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

/** One line saying how to summon the agent, or why it cannot be summoned — the text a
 *  menu shows under the switch. Written for somebody holding a phone, so it names the
 *  prefix they have to type. */
export function agentHint(status: AgentStatus | null): string {
  if (!status) return "The backend has not said yet.";
  if (!status.enabled) return "This backend is read-only, so it never answers.";
  const runnable = availableBackends(status);
  if (runnable.length === 0) {
    const names = status.backends.map((b) => b.name).join(" or ");
    return `No agent is installed on this machine (${names}).`;
  }
  return `Write ${runnable.map((b) => b.prefix).join(" or ")} to ask for an answer.`;
}
