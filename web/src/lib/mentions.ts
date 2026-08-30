// @mentions in the composer: who can be mentioned, which of them a half-typed "@…"
// means, and how a mention's own text shrinks.
//
// An "@" offers three kinds of thing, and they are not the same kind: the PEOPLE this
// thread can notify, the CHANNEL itself where the conversation is one (which notifies
// everybody following it — see `channelMentionCandidate`), and the AGENTS this machine can
// summon (see `AgentCandidate`). The first two travel as a Teams mention pair and differ in
// what that pair says they NAME; the third travels as the plain prefix the backend's own
// trigger reads.
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
import { agentPersonas } from "./agent-persona";

/** What a mention names. Mirrors `teams_send::MentionKind`, and an ABSENT value is a
 *  person for the reason the wire's own default is: a person notifies one colleague,
 *  where a channel notifies everybody following it. */
export type MentionTargetKind = "person" | "channel";

/** Something a message can @mention: its MRI, and the name to show. */
export type MentionCandidate = {
  /** The person's MRI (`8:orgid:<guid>`) — what makes Teams notify them. For a CHANNEL
   *  it is the channel's own `19:…@thread.tacv2` thread id instead. */
  mri: string;
  name: string;
  /** Absent for a person, which is every candidate the roster answers with. */
  kind?: MentionTargetKind;
};

/** A mention as it will be sent: the span index in the body, who it names, the text that
 *  span shows (which the author may have shortened), and WHAT it names. Mirrors the Rust
 *  `teams_send::Mention`. */
export type OutboundMention = {
  itemid: number;
  mri: string;
  display_name: string;
  kind?: MentionTargetKind;
};

/**
 * The CHANNEL itself as something the reader can @mention, or `null` where there is no
 * channel to name.
 *
 * A channel mention notifies whoever follows the channel — as loudly as each of them
 * asked Teams to be notified (`store::ChannelAlerts`) — so it is the widest thing this
 * app lets one press reach, and the rules that keep it honest are all here and in
 * `teams_send::parse_mentions`:
 *
 *   * only in a CHANNEL. A chat has no channel to name, and the backend refuses one there
 *     whatever a page offers.
 *   * the mri IS the conversation, which is what the backend checks it against. Measured
 *     on this tenant, 176 of 177 real channel mentions name the very thread their message
 *     was posted in — so nothing here is invented, and a mention of ANOTHER channel is a
 *     shape this app neither offers nor accepts.
 *   * the name is the channel's own. A row showing a thread id is a row nobody can pick,
 *     which is the rule that already keeps an unnamed colleague out of the list.
 */
export function channelMentionCandidate(input: {
  conversationId: string | null;
  name: string;
  isChannel: boolean;
}): MentionCandidate | null {
  const mri = input.conversationId?.trim() ?? "";
  const name = input.name.trim();
  if (!input.isChannel || !mri || !name) return null;
  // The ID'S OWN SHAPE, checked here rather than trusted from the caller: this is the one
  // function that decides whether the row is offered, and it must answer the way the
  // backend does or the page would draw a control whose press the backend refuses — which
  // is what this app draws nothing instead of. `19:…@thread.tacv2` is what a channel is
  // (`teams_read::is_channel_thread_id`), and a channel POST's own deep-link id carries a
  // `;messageid=` suffix that is not part of the channel, so only the part before it counts.
  if (!/^19:[^;]*@thread\.tacv2$/.test(mri.split(";")[0] ?? "")) return null;
  return { mri, name, kind: "channel" };
}

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
 * The mention targets a query offers, best match first, capped at
 * {@link MAX_MENTION_SUGGESTIONS}.
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
 * a tag becomes on the wire is the plain prefix the backend's own trigger reads wherever
 * it stands in the message (`agent_policy::split_prefix`), which is what the user would
 * otherwise have typed by hand.
 */
export type AgentCandidate = {
  /** The backend name (`claude`, `opencode`): the mark it wears and the palette it uses. */
  backend: string;
  /** How it is named to a reader — each vendor's own casing, or a custom agent's label. */
  name: string;
  /** The prefix that summons it wherever a message writes it, as the BACKEND spelled it. */
  prefix: string;
  /** The CUSTOM AGENT this row is, by address (`bebou`), or null for the provider itself.
   *
   *  It is what makes a persona's row draw its own face rather than the vendor's mark — and
   *  the reason `backend` still names the provider: a persona IS that provider wearing a
   *  name, so the palette, the chip and the fallback artwork are the vendor's. */
  persona?: string | null;
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
  const providers = candidatesFrom(status, conversationId, usableBackends);
  // The user's own CUSTOM AGENTS follow the providers — see {@link personaCandidates} for
  // why they are here and not in the list below, and why they come second.
  if (providers.length === 0) return providers;
  return [...providers, ...personaCandidates(status, usableBackends(status))];
}

/**
 * The custom agents that would really answer, as rows of the "@" list.
 *
 * Each is offered on exactly the terms its own PROVIDER is: a persona whose CLI this machine
 * lacks — or whose provider the user switched off — is not offered, because `@bebou` would
 * then summon nothing, which is the lie this whole list exists to avoid. `usable` is passed
 * in rather than recomputed so the two halves of one list cannot disagree about which
 * providers are live.
 *
 * They come SECOND, after the providers, even though the user made them: `@claude` and
 * `@opencode` are a fixed short list a reader learns once, and the personas grow. A menu
 * whose first row moves as agents are added is one that has to be read every time.
 */
function personaCandidates(
  status: AgentStatus | null,
  usable: readonly AgentBackend[],
): AgentCandidate[] {
  return agentPersonas(status)
    .filter((persona) => usable.some((backend) => backend.name === persona.backend))
    .map((persona) => ({
      backend: persona.backend,
      name: persona.label,
      prefix: persona.prefix,
      persona: persona.name,
    }));
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

/**
 * The two lists above, minus the one line they differ in: which backends to draw from.
 *
 * PROVIDERS only, deliberately. The composer adds the user's own custom agents on top
 * ({@link agentCandidatesFor}) because that list is what the reader is looking at while they
 * type; a message's ⋯ menu must NOT — it is a column of actions on one message, and the rule
 * that keeps it to one row is the same rule that keeps a row per vendor out of it. A machine
 * with six personas would otherwise turn that menu into a directory of programs before the
 * reader has said what they want.
 */
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
    persona: null,
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
  return candidates.filter((agent) =>
    // The label, the address, and the provider behind it: "@Beb", "@bebou" and — for a
    // provider's own row — "@cl" all find what the reader means. A persona is deliberately
    // NOT found by its provider's name: typing "@claude" would then offer every persona
    // that runs on Claude, which buries the provider's own row under the user's own agents.
    [agent.name, agent.persona ?? agent.backend].some((word) => fold(word).startsWith(needle)),
  );
}

/** One row of the list an "@" opens: somebody to notify, the CHANNEL to notify, or an
 *  agent to summon. A channel is its own kind rather than a person carrying a flag,
 *  because the row must not be drawn as a person: an avatar seeded from a thread id is
 *  tinted initials for a colleague who does not exist, which is the wrong-face rule the
 *  chess engine's own seat already follows. */
export type MentionOption =
  | { kind: "person"; person: MentionCandidate }
  | { kind: "channel"; channel: MentionCandidate }
  | { kind: "agent"; agent: AgentCandidate };

/** A stable key for one row, per kind, so two lists never collide on one id. */
export function mentionOptionKey(option: MentionOption): string {
  if (option.kind === "person") return `person:${option.person.mri}`;
  if (option.kind === "channel") return `channel:${option.channel.mri}`;
  // A custom agent is keyed on its own address, not on the provider behind it: several
  // personas share one provider, and keying on that would collapse them into one row.
  const { agent } = option;
  return agent.persona ? `persona:${agent.persona}` : `agent:${agent.backend}`;
}

/**
 * Everything one "@…" offers: the agents first, then the people — with the CHANNEL at the
 * front of those, where the caller put it.
 *
 * Agents lead because there are at most two of them, and they are offered EVERYWHERE an
 * "@" is. The backend reads an address wherever it stands (`agent_policy::split_prefix`),
 * so a tag mid-sentence summons the agent exactly as one at the front does — and the rule
 * that keeps a row honest was never the position: it is that a row is drawn only for
 * something it would really reach, which for an agent is `agentCandidatesFor`.
 *
 * The total is capped like the people-only list was, so the menu stays a menu.
 */
export function mentionOptions(input: {
  /** Everything an "@" can NOTIFY, in the order it should be offered — the people, and the
   *  CHANNEL at the front where there is one. Not `people`: a list that may hold the channel
   *  is not a list of people, and the name would be the quiet kind of lie this file's own
   *  `MentionOption` split exists to avoid. */
  targets: readonly MentionCandidate[];
  agents: readonly AgentCandidate[];
  query: string;
  limit?: number;
}): MentionOption[] {
  const limit = input.limit ?? MAX_MENTION_SUGGESTIONS;
  const agents = matchAgentCandidates(input.agents, input.query);
  const targets = matchMentionCandidates(
    input.targets,
    input.query,
    Math.max(0, limit - agents.length),
  );
  return [
    ...agents.map((agent): MentionOption => ({ kind: "agent", agent })),
    // A candidate carries WHAT it is (see `MentionCandidate.kind`), so the CHANNEL keeps
    // its place in the matched order rather than being sorted to the front here: the
    // caller puts it first in the list it passes, and `matchMentionCandidates` is stable,
    // so a bare "@" offers it above the people and one typed letter ranks it by name like
    // everybody else.
    ...targets.map((candidate): MentionOption =>
      candidate.kind === "channel"
        ? { kind: "channel", channel: candidate }
        : { kind: "person", person: candidate },
    ),
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
      // The kind travels with it, or the channel's own row would be deduped back into a
      // person and drawn with a face seeded from a thread id.
      out.push({ mri: candidate.mri, name: candidate.name, kind: candidate.kind });
      continue;
    }
    if (!known.name && candidate.name) known.name = candidate.name;
  }
  return out;
}
