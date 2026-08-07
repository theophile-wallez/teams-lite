// Reading an agent tag back out of a message body, so the thread draws the tag the
// composer drew.
//
// A tag carries no markup, on purpose: it goes out as the bare prefix the message
// addresses the agent with (see components/agent-tag-extension.ts), because that is what
// the backend's own trigger reads (`agent_policy::split_prefix`) and what every other
// client can render.
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
import type { RichNode } from "./rich-text";

/** The longest prompt the backend accepts — `agent_policy::MAX_PROMPT_CHARS`. Past it the
 *  message is a paste rather than a question, and nothing answered it. */
const MAX_PROMPT_CHARS = 4_000;

/** The punctuation the backend lets a prefix be followed by: "@claude: do it". */
const PREFIX_PUNCTUATION = [":", ","];

/**
 * The agents ONE MESSAGE could really have addressed — the list the address in its body is
 * marked against, and empty for a message that addressed nobody.
 *
 * Two rules hold whoever wrote it, because they are about the message rather than about
 * any machine:
 *
 * - **A deleted message tags nothing.** Its bubble is a placeholder, and the words behind
 *   it are only revealed on the reader's own ask.
 * - **The agent's own reply is not a trigger.** It is posted under a person's name, and it
 *   is free to write `@claude` in its own words — explaining how to summon one, quoting
 *   the request it was given. That is a gate rather than a nicety now that an address may
 *   sit anywhere: the backend refuses the same shapes by name
 *   (`agent_policy::is_agent_answer`), so a run cannot answer itself, and the chip must
 *   not claim one did.
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
 * Where an agent is ADDRESSED in `text`: which agent, and the span the address occupies.
 * Null when the text addresses none.
 *
 * A port of `agent_policy::split_prefix` and `address_in`, plus the two prompt rules
 * `trigger_for` applies around them, pinned to the Rust case for case by this module's
 * tests:
 *
 *   - the address may sit ANYWHERE — "@claude which port?" and "which port, @claude?" are
 *     one request written two ways — and the earliest one wins when a message holds
 *     several, because that is the agent the sentence turns to first;
 *   - it is a word of its own: it opens the text or follows whitespace (so
 *     `ping@claude.example` addresses nobody), and it ends the text or is followed by
 *     something that ends a word (so `@claudette` is another word);
 *   - it is matched without case, and the punctuation it is written with belongs to it —
 *     the `:` or `,` after a name, and the `,` that introduces one;
 *   - what is left is a real prompt: neither empty nor a paste.
 *
 * Every rule the MESSAGE carries rather than the text — who wrote it, whether the thread
 * is opted in, whether that provider is on — belongs to the caller, which is where the
 * answers live (see `agentCandidatesFor`). The agent's own ANSWER is one of those, and it
 * is load-bearing now that an address may sit anywhere: {@link agentTagsInMessage} refuses
 * one before it reads a word, the way `agent_policy::is_agent_answer` does on the backend.
 */
export function agentAddressInText(
  text: string,
  agents: readonly AgentCandidate[],
): { agent: AgentCandidate; start: number; end: number } | null {
  let found: { agent: AgentCandidate; start: number; end: number } | null = null;
  for (const agent of agents) {
    if (!agent.prefix) continue;
    const at = addressIn(text, agent.prefix);
    if (!at) continue;
    if (!found || at.start < found.start) found = { agent, ...at };
  }
  if (!found) return null;
  const prompt = promptWithout(text, found.start, found.end);
  if (prompt.length === 0 || [...prompt].length > MAX_PROMPT_CHARS) return null;
  return found;
}

/** The agent a body summons, or null when it summons none — {@link agentAddressInText}
 *  narrowed to the one question most callers ask. */
export function agentTagInText(
  text: string,
  agents: readonly AgentCandidate[],
): AgentCandidate | null {
  return agentAddressInText(text, agents)?.agent ?? null;
}

/**
 * The same tree with the agent address in it wrapped in an `agent` node, which the
 * renderer draws as the vendor's own chip (see components/rich-content.tsx).
 *
 * The decision is made on the whole text and the replacement on the one text node that
 * holds the address, which is what keeps it faithful to the backend: the address is found
 * in the MESSAGE, at the offset the backend found it at, not in whichever node happens to
 * carry those letters. So "as we said @claude is quick" is marked now — it is a request
 * now — while a `@claude` the backend skipped stays the words it is.
 *
 * When no single text node holds the address whole — a body where markup splits it in two
 * — the tree comes back untouched: a chip built out of an address we cannot see in one
 * piece would be a promise made on a guess.
 */
export function markAgentTag(
  nodes: RichNode[],
  agents: readonly AgentCandidate[],
): RichNode[] {
  if (agents.length === 0) return nodes;
  const { text, runs } = messageRuns(nodes);
  const found = agentAddressInText(text, agents);
  if (!found) return nodes;
  // Which text node the address begins in. The offsets come from one pass over the whole
  // body, so this is the node the BACKEND read the address out of.
  const run = runs.find(
    (candidate) =>
      found.start >= candidate.start && found.start < candidate.start + candidate.node.text.length,
  );
  if (!run) return nodes;
  const marked = markAddressInText(run.node.text, found.agent, found.start - run.start);
  if (!marked) return nodes;
  return replaceTextNode(nodes, run.node, marked) ?? nodes;
}

/** Whether `text` opens with `prefix`, ignoring case, as the backend compares them. */
function startsWithPrefix(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** The span `prefix` addresses an agent with, or null — `agent_policy::address_in`. */
function addressIn(text: string, prefix: string): { start: number; end: number } | null {
  for (let at = 0; at < text.length; at++) {
    // A word of its own: the text opens here, or whitespace does the separating.
    const before = text[at - 1];
    if (before !== undefined && !/\s/.test(before)) continue;
    if (!startsWithPrefix(text.slice(at), prefix)) continue;
    const rest = text.slice(at + prefix.length);
    let after = rest;
    while (after.length > 0 && PREFIX_PUNCTUATION.includes(after[0]!)) after = after.slice(1);
    // Punctuation ends the word by itself, so only an unpunctuated address is asked
    // whether what follows it ends one.
    if (after.length === rest.length && !endsAddress(rest)) continue;
    // A vocative comma belongs to the address it introduces: "do this, @claude".
    const lead = text.slice(0, at).trimEnd();
    return { start: lead.endsWith(",") ? lead.length - 1 : at, end: text.length - after.length };
  }
  return null;
}

/** Whether what follows an address really ends it — `agent_policy::ends_address`. A `?` or
 *  a `)` does, a letter or a digit does not, and a `.` does whichever its own next
 *  character says: a sentence may end on an address, while `@claude.example` stays an
 *  address of another kind. */
function endsAddress(rest: string): boolean {
  const next = rest[0];
  if (next === undefined) return true;
  if (/[\p{L}\p{N}_-]/u.test(next)) return false;
  if (next === ".") return !/[\p{L}\p{N}]/u.test(rest[1] ?? "");
  return true;
}

/** The words with the address cut out of them — `agent_policy::prompt_without`. The two
 *  halves close with ONE separator, a newline when either side carried one, so a request
 *  written over several lines stays on several lines. */
function promptWithout(text: string, start: number, end: number): string {
  const head = text.slice(0, start).trimEnd();
  const tail = text.slice(end).trimStart();
  if (head.length === 0 || tail.length === 0) return `${head}${tail}`.trim();
  const droppedBefore = text.slice(head.length, start);
  const droppedAfter = text.slice(end, text.length - tail.length);
  const seam =
    droppedBefore.includes("\n") || droppedAfter.includes("\n")
      ? "\n"
      : droppedBefore === "" && droppedAfter === ""
        ? ""
        : " ";
  return `${head}${seam}${tail}`.trim();
}

/** The block tags the backend turns into a line ending — `teams_read::BLOCK_TAGS`, minus
 *  the ones this app's own parser never produces. */
const BLOCK_TAGS = new Set([
  "p",
  "br",
  "hr",
  "blockquote",
  "pre",
  "li",
  "ul",
  "ol",
  "table",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
]);

/** One text node of a body, and where its text begins in the whole. */
type TextRun = { node: Extract<RichNode, { type: "text" }>; start: number };

/**
 * A body as ONE string, plus where each text node's own text sits in it.
 *
 * The string is built the way `teams_read::plain_text_from_html` builds the text the
 * backend reads a trigger out of, which is what makes an offset here mean the same thing
 * there: a block tag ends a line (one newline per break, never two), and everything else
 * contributes its characters. `nodeText` cannot be used for this — it glues two paragraphs
 * into one word, which was harmless while the address had to open the message and is a
 * wrong answer now that an address anywhere is read at an offset.
 */
function messageRuns(nodes: RichNode[]): { text: string; runs: TextRun[] } {
  let text = "";
  const runs: TextRun[] = [];
  const walk = (list: RichNode[]): void => {
    for (const node of list) {
      if (node.type === "text") {
        runs.push({ node, start: text.length });
        text += node.text;
        continue;
      }
      const block = BLOCK_TAGS.has(node.tag);
      if (block && text.length > 0 && !text.endsWith("\n")) text += "\n";
      if (node.tag === "customEmoji") text += node.attrs.code ?? "";
      else walk(node.children);
      if (block && text.length > 0 && !text.endsWith("\n")) text += "\n";
    }
  };
  walk(nodes);
  return { text, runs };
}

/** The tree with one text node replaced by the nodes that mark it, or null when that node
 *  is not in it (which cannot happen: the runs were read off this very tree). */
function replaceTextNode(
  nodes: RichNode[],
  target: RichNode,
  replacement: RichNode[],
): RichNode[] | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node === target) {
      const out = [...nodes];
      out.splice(i, 1, ...replacement);
      return out;
    }
    if (node.type === "text") continue;
    const children = replaceTextNode(node.children, target, replacement);
    if (!children) continue;
    const out = [...nodes];
    out[i] = { ...node, children };
    return out;
  }
  return null;
}

/** One text node split into what precedes the address, the address itself as an `agent`
 *  node, and what follows it — each part only when it holds something. */
function markAddressInText(
  text: string,
  agent: AgentCandidate,
  at: number,
): RichNode[] | null {
  // The vocative comma is part of the span the backend cut ("which port, @claude?"), but
  // it is the author's own punctuation and stays their text: only the prefix wears the
  // chip. So the span is re-entered from the left until the prefix itself starts.
  let start = at;
  while (start < text.length && !startsWithPrefix(text.slice(start), agent.prefix)) {
    if (!/[\s,:]/.test(text[start]!)) return null;
    start++;
  }
  if (!startsWithPrefix(text.slice(start), agent.prefix)) return null;
  const lead = text.slice(0, start);
  const rest = text.slice(start + agent.prefix.length);
  const out: RichNode[] = [];
  if (lead.length > 0) out.push({ type: "text", text: lead });
  out.push({
    type: "element",
    tag: "agent",
    attrs: { backend: agent.backend },
    // The prefix stays the node's text, so everything that does not know this tag —
    // the outbound serializer, a renderer without the case — still shows what was typed.
    children: [{ type: "text", text: text.slice(start, start + agent.prefix.length) }],
  });
  if (rest.length > 0) out.push({ type: "text", text: rest });
  return out;
}
