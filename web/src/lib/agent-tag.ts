// Reading an agent tag back out of a message body, so the thread draws the tag the
// composer drew.
//
// A tag carries no markup, on purpose: it goes out as the bare prefix the message opens
// with (see components/agent-tag-extension.ts), because that is what the backend's own
// trigger reads (`agent_policy::split_prefix`) and what every other client can render.
// So the chip cannot be restored from the body — there is nothing in it to restore — it
// has to be recognised from the words, the way the backend recognises them. That is the
// same choice lib/agent-message.ts makes for a reply's signature, for the same reason: a
// message read back covers every message ever sent, including the ones written from a
// phone while this app was closed.
//
// It answers ONE question — did this body really address an agent? — and marks nothing
// unless the answer is yes. A chip on a message that addressed nobody is the lie the
// composer refuses to tell when it decides which rows an "@" offers (see
// `mentionOptions`), and a sent message cannot be taken back.
//
// WHOSE agent decides which gates apply, and that split is the whole of
// `agentTagsInMessage`. On a message of ours the chip says a program started on THIS
// machine, so every condition that would have to hold for that is checked. On a
// colleague's it says only that they addressed an agent — their own teams-lite decides
// whether one ran, and this app cannot know and must not pretend to.

import type { AgentStatus } from "./agent";
import { agentAuthorship, agentDisplayName } from "./agent-message";
import { agentCandidatesFor, type AgentCandidate } from "./mentions";
import type { ChatMessage } from "./protocol";
import { nodeText, type RichNode } from "./rich-text";

/** The longest prompt the backend accepts — `agent_policy::MAX_PROMPT_CHARS`. Past it the
 *  message is a paste rather than a question, and nothing answered it. */
const MAX_PROMPT_CHARS = 4_000;

/** The punctuation the backend lets a prefix be followed by: "@claude: do it". */
const PREFIX_PUNCTUATION = [":", ","];

/**
 * The agents ONE MESSAGE could really have addressed — the list its body's opening prefix
 * is marked against, and empty for a message that addressed nobody.
 *
 * Two rules hold whoever wrote it, because they are about the message rather than about
 * any machine:
 *
 * - **A deleted message tags nothing.** Its bubble is a placeholder, and the words behind
 *   it are only revealed on the reader's own ask.
 * - **The agent's own reply is not a trigger.** It is posted under a person's name and it
 *   opens with the answer.
 *
 * Then the sender decides the rest.
 *
 * **Our own message.** The chip says a program started on THIS machine, so every gate the
 * composer applies before it OFFERS a tag applies here too (`agentCandidatesFor`): this
 * backend can answer at all, the CLI is installed, the user left that provider on, and
 * THIS conversation is opted in. That keeps the consent gate where it belongs — the
 * thread's own menu — and it is why a prefix the user typed in a thread nobody opted in
 * stays plain words.
 *
 * **A colleague's message.** None of those gates are about their machine, so none of them
 * apply: the backend's trigger requires `from_me` (`agent_policy::trigger_for`), so their
 * `@claude` ran nothing HERE, and it is their own teams-lite that decides whether one ran
 * there. So the chip is marked from the prefix alone ({@link addressableAgents}) and it
 * claims only what they wrote: this message addresses that agent. It never says a stranger
 * started a program on the user's machine — nothing on a colleague's bubble names this
 * machine, and the answer that follows is attributed to the account it went out under
 * (`AgentSignature`), which is theirs.
 */
export function agentTagsInMessage(
  message: ChatMessage,
  status: AgentStatus | null,
): AgentCandidate[] {
  if (message.deleted === true) return [];
  if (agentAuthorship(message)) return [];
  if (message.is_self === true) return agentCandidatesFor(status, message.conversation_id);
  return addressableAgents(status);
}

/**
 * Every agent a message can ADDRESS, from the backend's own list of CLIs — the vocabulary
 * of prefixes, with none of the gates {@link agentCandidatesFor} applies.
 *
 * Those gates answer "would this machine run it?", which is the wrong question about
 * somebody else's message: a colleague's own teams-lite may hold a CLI this one does not,
 * and may have been opted into a thread this one is not. What is left is the only thing
 * both machines agree on — how an agent is addressed — and the backend is still where that
 * comes from, so there is one spelling of `@claude` in this app and not two.
 *
 * **Never offer these in the composer.** They are read off a message that was already
 * sent; a tag is offered only from `agentCandidatesFor`, where the consent lives.
 */
function addressableAgents(status: AgentStatus | null): AgentCandidate[] {
  return (status?.backends ?? []).map((backend) => ({
    backend: backend.name,
    name: agentDisplayName(backend.name),
    prefix: backend.prefix,
  }));
}

/**
 * The agent a body summons, or null when it summons none.
 *
 * A port of `agent_policy::split_prefix` and the two prompt rules `trigger_for` applies
 * around it, pinned to it case for case by this module's tests:
 *
 *   - the prefix OPENS the text (a `@claude` mid-sentence is somebody talking ABOUT the
 *     agent, not to it);
 *   - it is matched without case, and must end there or be followed by whitespace or one
 *     of `:` `,` — so `@claudette` is another word;
 *   - what is left is a real prompt: neither empty nor a paste.
 *
 * Every rule the MESSAGE carries rather than the text — who wrote it, whether the thread
 * is opted in, whether that provider is on — belongs to the caller, which is where the
 * answers live (see `agentCandidatesFor`).
 */
export function agentTagInText(
  text: string,
  agents: readonly AgentCandidate[],
): AgentCandidate | null {
  const opening = text.trimStart();
  for (const agent of agents) {
    if (!agent.prefix) continue;
    if (!startsWithPrefix(opening, agent.prefix)) continue;
    const rest = opening.slice(agent.prefix.length);
    const next = rest[0];
    // `@claudette …`: a different word that merely starts the same way.
    if (next !== undefined && !/\s/.test(next) && !PREFIX_PUNCTUATION.includes(next)) continue;
    const prompt = trimPromptEdge(rest);
    if (prompt.length === 0 || [...prompt].length > MAX_PROMPT_CHARS) return null;
    return agent;
  }
  return null;
}

/**
 * The same tree with the body's opening agent prefix wrapped in an `agent` node, which
 * the renderer draws as the vendor's own chip (see components/rich-content.tsx).
 *
 * The decision is made on the whole text and the replacement on one text node, which is
 * what keeps it faithful to the backend: the prefix has to open the MESSAGE, not the node
 * it happens to sit in. When no single text node holds the prefix whole — a body where
 * markup splits it in two, or one that opens with an emoji the parser turned into a
 * character — the tree comes back untouched: a chip built out of a prefix we cannot see
 * in one piece would be a promise made on a guess.
 */
export function markAgentTag(
  nodes: RichNode[],
  agents: readonly AgentCandidate[],
): RichNode[] {
  if (agents.length === 0) return nodes;
  const agent = agentTagInText(nodeText(nodes), agents);
  if (!agent) return nodes;
  return markOpeningPrefix(nodes, agent) ?? nodes;
}

/** Whether `text` opens with `prefix`, ignoring case, as the backend compares them. */
function startsWithPrefix(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** What the backend keeps of the text behind the prefix: the punctuation that may follow
 *  it is part of the address, not of the question. */
function trimPromptEdge(rest: string): string {
  let prompt = rest;
  while (prompt.length > 0 && PREFIX_PUNCTUATION.includes(prompt[0]!)) prompt = prompt.slice(1);
  return prompt.trim();
}

/** Mark the prefix in the first text of the tree, or null when that text does not carry
 *  it. Nodes with no text at all are stepped over — an empty span, and the `<img>` the
 *  backend's own plain-text pass sees nothing of either. */
function markOpeningPrefix(nodes: RichNode[], agent: AgentCandidate): RichNode[] | null {
  const out = [...nodes];
  for (let i = 0; i < out.length; i++) {
    const node = out[i]!;
    if (node.type === "text") {
      if (node.text.trim().length === 0) continue;
      const marked = markPrefixInText(node.text, agent);
      if (!marked) return null;
      out.splice(i, 1, ...marked);
      return out;
    }
    if (nodeText([node]).trim().length === 0) continue;
    const children = markOpeningPrefix(node.children, agent);
    if (!children) return null;
    out[i] = { ...node, children };
    return out;
  }
  return null;
}

/** One text node split into what precedes the prefix, the prefix itself as an `agent`
 *  node, and the words after it — each part only when it holds something. */
function markPrefixInText(text: string, agent: AgentCandidate): RichNode[] | null {
  const body = text.trimStart();
  if (!startsWithPrefix(body, agent.prefix)) return null;
  const lead = text.slice(0, text.length - body.length);
  const rest = body.slice(agent.prefix.length);
  const out: RichNode[] = [];
  if (lead.length > 0) out.push({ type: "text", text: lead });
  out.push({
    type: "element",
    tag: "agent",
    attrs: { backend: agent.backend },
    // The prefix stays the node's text, so everything that does not know this tag —
    // the outbound serializer, a renderer without the case — still shows what was typed.
    children: [{ type: "text", text: body.slice(0, agent.prefix.length) }],
  });
  if (rest.length > 0) out.push({ type: "text", text: rest });
  return out;
}
