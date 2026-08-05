// @mentions in the composer: who can be mentioned, which of them a half-typed "@…"
// means, and how a mention's own text shrinks.
//
// An "@" offers two kinds of thing, and they are not the same kind: the PEOPLE this
// thread can notify, and the AGENTS this machine can summon (see `AgentCandidate`). One
// travels as a Teams mention pair; the other travels as the plain prefix the backend's
// own trigger reads.
//
// Everything here is pure — no editor, no DOM, no network — so the rules that decide
// whether the suggestion list opens, who it offers and what Backspace does to a mention
// are unit-tested directly. The editor side (the nodes, the popup, the keys) lives in
// components/mention-extension.ts, components/agent-tag-extension.ts and
// components/mention-suggestions.tsx.

import {
  agentModeFor,
  defaultUsableBackends,
  usableBackends,
  type AgentBackend,
  type AgentStatus,
} from "./agent";
import { agentDisplayName } from "./agent-message";

/** Somebody a message can @mention: their MRI, and the name to show. */
export type MentionCandidate = {
  /** The person's MRI (`8:orgid:<guid>`) — what makes Teams notify them. */
  mri: string;
  name: string;
};

/** A mention as it will be sent: the span index in the body, who it names, and the
 *  text that span shows (which the author may have shortened). Mirrors the Rust
 *  `teams_send::Mention`. */
export type OutboundMention = {
  itemid: number;
  mri: string;
  display_name: string;
};

/** How many suggestions the list shows at once. A menu, not a directory: past this
 *  the user is faster typing another letter than reading. */
export const MAX_MENTION_SUGGESTIONS = 8;

/** How long a half-typed query may get before "@" stops meaning a mention. Long
 *  enough for "Charlotte Dub", short enough that a sentence starting with an email
 *  address does not keep the list open. */
const MAX_QUERY_LENGTH = 32;

/** How many words a query may span. A name is two words far more often than three,
 *  and each extra word is another sentence the list would stay open over. */
const MAX_QUERY_WORDS = 2;

/** An active `@…` query in the text before the cursor. */
export type MentionQuery = {
  /** What was typed after the "@" (may be empty: "@" alone opens the list). */
  query: string;
  /** Offset of the "@" itself, so the editor knows what to replace. */
  at: number;
};

/**
 * The `@…` the cursor sits in, or `null` when it sits in ordinary text.
 *
 * `text` is the plain text of the current block up to the cursor. A mention starts at
 * the beginning of a block or after whitespace — never inside a word — so an email
 * address or a handle glued to a word ("a@b.com") is text, not a mention. The query
 * may hold one space, because "Charlotte Dub" is how a person is found by surname.
 */
export function mentionQueryBefore(text: string): MentionQuery | null {
  const at = text.lastIndexOf("@");
  if (at < 0) return null;
  const before = text[at - 1];
  if (before !== undefined && !/\s/.test(before)) return null;
  const query = text.slice(at + 1);
  if (query.length > MAX_QUERY_LENGTH) return null;
  if (/[\n\r]/.test(query)) return null;
  // An "@" the author is done with: two words typed past it are a sentence, not a
  // name being looked up.
  if (query.trim().split(/\s+/).filter(Boolean).length > MAX_QUERY_WORDS) return null;
  // A query that ends in a space only stays a query while it holds a word, so "@ "
  // (a lone at-sign and a space) closes the list.
  if (query.length > 0 && query.trim().length === 0) return null;
  return { query, at };
}

/** Fold a name for comparison: no case, no diacritics, single spaces. So "Théo"
 *  matches a typed "theo", which is what somebody on a US keyboard types. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The people a query offers, best match first, capped at {@link MAX_MENTION_SUGGESTIONS}.
 *
 * Ranked by how the match reads, not by string distance: a name that STARTS with what
 * was typed comes before one whose surname does, which comes before a mere substring.
 * Ties keep the caller's order, which is the backend's own relevance (the people who
 * wrote most recently first). An empty query offers everybody, in that same order.
 */
export function matchMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit: number = MAX_MENTION_SUGGESTIONS,
): MentionCandidate[] {
  const needle = fold(query);
  const scored: { candidate: MentionCandidate; score: number; index: number }[] = [];
  candidates.forEach((candidate, index) => {
    if (!candidate.mri || !candidate.name) return;
    if (needle.length === 0) {
      scored.push({ candidate, score: 0, index });
      return;
    }
    const name = fold(candidate.name);
    let score: number;
    if (name.startsWith(needle)) score = 0;
    else if (name.split(" ").some((word) => word.startsWith(needle))) score = 1;
    else if (name.includes(needle)) score = 2;
    else return;
    scored.push({ candidate, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.candidate);
}

/**
 * What a mention's text becomes when Backspace lands on it, or `null` when there is
 * nothing left to drop and the mention itself goes.
 *
 * This is Teams' behaviour, and it is the reason a mention's label is editable at all:
 * mentioning "John De Doe" and pressing Backspace twice leaves "John" — still a
 * mention, still notifying John, just addressing him the way people in the thread
 * actually do. One word per keystroke, from the end.
 */
export function shortenMentionLabel(label: string): string | null {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return null;
  return words.slice(0, -1).join(" ");
}

// ---- agents ---------------------------------------------------------------

/**
 * An agent CLI this machine can run, as the composer offers it. Not a person: a program.
 *
 * Tagging one is NOT a Teams mention, and must never become one. There is nobody to
 * notify, so the pair a mention needs (an indexed span plus an entry naming an MRI) would
 * be blue text that pings nobody — the exact failure `serializeTeamsMessage` refuses. What
 * a tag becomes on the wire is the plain prefix the backend's own trigger reads
 * (`agent_policy::split_prefix`), which is what the user would otherwise have typed by
 * hand.
 */
export type AgentCandidate = {
  /** The backend name (`claude`, `opencode`): the mark it wears and the palette it uses. */
  backend: string;
  /** How it is named to a reader — each vendor's own casing. */
  name: string;
  /** The prefix a message must open with to summon it, as the BACKEND spelled it. */
  prefix: string;
};

/**
 * The agents the open conversation could really summon, in the backend's own order.
 *
 * Three things must hold, and each of them is somebody's decision rather than our guess:
 * this backend can answer at all (a read-only one never does), the CLI is installed and
 * the user left that provider on ({@link usableBackends}), and THIS conversation is opted
 * in ({@link agentModeFor}). A tag offered without them would summon nobody — the same
 * lie as a mention that notifies nobody — so the list names none.
 */
export function agentCandidatesFor(
  status: AgentStatus | null,
  conversationId: string | null,
): AgentCandidate[] {
  return candidatesFrom(status, conversationId, usableBackends);
}

/**
 * The same list narrowed to the machine's DEFAULT provider — what a message's ⋯ menu
 * offers.
 *
 * The composer's own "@" offers every usable agent, because the user is typing there and
 * the list is what they are reading. A message menu is the other case: it is a column of
 * actions on one message, and a row per vendor asks the reader to choose a program before
 * they have said what they want. So it names the one the user chose in Settings (see
 * {@link defaultUsableBackends}, which is also what keeps a default this machine cannot
 * run from emptying the menu).
 *
 * Every gate {@link agentCandidatesFor} applies still applies: this narrows the list, and
 * never widens it.
 */
export function defaultAgentCandidatesFor(
  status: AgentStatus | null,
  conversationId: string | null,
): AgentCandidate[] {
  return candidatesFrom(status, conversationId, defaultUsableBackends);
}

/** The two lists above, minus the one line they differ in: which backends to draw from. */
function candidatesFrom(
  status: AgentStatus | null,
  conversationId: string | null,
  backends: (status: AgentStatus | null) => AgentBackend[],
): AgentCandidate[] {
  if (!status?.enabled) return [];
  if (agentModeFor(status, conversationId) !== "reply") return [];
  return backends(status).map((backend) => ({
    backend: backend.name,
    name: agentDisplayName(backend.name),
    prefix: backend.prefix,
  }));
}

/** The agents a query offers, matched on the name they are written with and on the
 *  prefix that summons them — so "@Cla", "@cl" and "@claude" all find the same one. */
export function matchAgentCandidates(
  candidates: readonly AgentCandidate[],
  query: string,
): AgentCandidate[] {
  const needle = fold(query);
  if (needle.length === 0) return [...candidates];
  return candidates.filter(
    (agent) => fold(agent.name).startsWith(needle) || fold(agent.backend).startsWith(needle),
  );
}

/** One row of the list an "@" opens: somebody to notify, or an agent to summon. */
export type MentionOption =
  | { kind: "person"; person: MentionCandidate }
  | { kind: "agent"; agent: AgentCandidate };

/** A stable key for one row, per kind, so two lists never collide on one id. */
export function mentionOptionKey(option: MentionOption): string {
  return option.kind === "agent" ? `agent:${option.agent.backend}` : `person:${option.person.mri}`;
}

/**
 * Everything one "@…" offers: the agents first, then the people.
 *
 * Agents lead because there are at most two of them and they are what an "@" at the
 * start of a message usually means — and they are offered ONLY there
 * (`atMessageStart`). That is not a style choice: the backend summons an agent from the
 * prefix the message OPENS with (`agent_policy::split_prefix`), so a tag anywhere else
 * runs nothing, and a chip that looks like it summoned a program while nothing ran is
 * worse than plain text.
 *
 * The total is capped like the people-only list was, so the menu stays a menu.
 */
export function mentionOptions(input: {
  people: readonly MentionCandidate[];
  agents: readonly AgentCandidate[];
  query: string;
  /** Whether the "@" being typed opens the message (nothing but space before it). */
  atMessageStart: boolean;
  limit?: number;
}): MentionOption[] {
  const limit = input.limit ?? MAX_MENTION_SUGGESTIONS;
  const agents = input.atMessageStart ? matchAgentCandidates(input.agents, input.query) : [];
  const people = matchMentionCandidates(
    input.people,
    input.query,
    Math.max(0, limit - agents.length),
  );
  return [
    ...agents.map((agent): MentionOption => ({ kind: "agent", agent })),
    ...people.map((person): MentionOption => ({ kind: "person", person })),
  ];
}

/** De-duplicate candidates by MRI, keeping the first (most relevant) of each and the
 *  first non-empty name. Used where two sources of people meet. */
export function dedupeCandidates(candidates: readonly MentionCandidate[]): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.mri) continue;
    const known = out.find((person) => person.mri.toLowerCase() === candidate.mri.toLowerCase());
    if (!known) {
      out.push({ mri: candidate.mri, name: candidate.name });
      continue;
    }
    if (!known.name && candidate.name) known.name = candidate.name;
  }
  return out;
}
