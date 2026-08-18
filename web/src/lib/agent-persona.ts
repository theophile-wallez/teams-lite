/**
 * The user's own CUSTOM AGENTS, as the backend describes them (`agent_persona` in
 * src/agent_persona.rs, published inside `agent_status`).
 *
 * `@claude` summons a CLI. `@bebou` summons the same CLI wearing a face, a name and a
 * standing instruction the user wrote — so a thread can hold a review bot, a French boomer
 * aunt and an ordinary assistant, each addressed by who it is rather than by which program
 * runs it. Everything a page needs to know about one is here, and three of those facts
 * shape every surface that draws one:
 *
 * - **A persona is an ADDRESS, not a program.** It points at a provider, which is what
 *   really runs; the page never sees a command and cannot name one. So every gate the
 *   composer already applies before it offers `@claude` applies unchanged (see
 *   `agentCandidatesFor` in lib/mentions.ts), and a persona is offered exactly where its
 *   own provider would be.
 * - **The PREPROMPT never shows.** It leads the prompt on the backend and appears in no
 *   message body. It travels to the page for one reason — the pane that edits one has to
 *   show what is there — and nothing else may draw it.
 * - **A persona is LOCAL.** There is no upstream and nothing travels: a colleague's own
 *   `@bebou` is a word here, exactly as `@natacha` is on a machine that never made one.
 *   What DOES arrive from a thread is the line a reply signs itself with, which is how a
 *   persona's answer draws under its own name (see lib/agent-message.ts) — that is read
 *   back out of the message, never out of this list.
 */

import type { AgentStatus } from "./agent";

/** One of the user's custom agents. Mirrors `agent_personas_json` in src/bin/server.rs. */
export type AgentPersona = {
  /** The ADDRESS, without its `@`, lowercase: `bebou`. Also the key it is saved under. */
  name: string;
  /** The name a reader sees — the backend resolves it, so this is never empty. */
  label: string;
  /** What summons it in a message: `@bebou`. Stated by the backend, so no surface here
   *  assembles an address out of a name. */
  prefix: string;
  /** The provider that really runs: `claude`, `opencode`. */
  backend: string;
  /** The model it overrides the provider's with, or null to inherit. */
  model: string | null;
  /** What leads every prompt it answers. Shown ONLY in the pane that edits it. */
  preprompt: string;
  /** Whether it has a face of its own — so a surface asks for bytes only when there are
   *  some, and draws the provider's mark otherwise. */
  has_avatar: boolean;
  added_ms: number;
  updated_ms: number;
};

/** What one `agent_persona_save` call writes. The name is the key: an unknown one creates,
 *  a known one edits. */
export type AgentPersonaPatch = {
  name: string;
  backend: string;
  label?: string;
  /** A model name, or "" to inherit the provider's. */
  model?: string;
  preprompt?: string;
  /** THREE answers, not two: absent LEAVES the face alone, `""` clears it, and base64
   *  bytes replace it. An edit of a preprompt must not silently delete the picture. */
  avatar_base64?: string;
};

/** How many custom agents one machine may hold, as this app OFFERS them.
 *
 *  Not a backend limit — the store would take any number — but the "@" list is a menu of
 *  at most {@link MAX_MENTION_SUGGESTIONS} rows shared with the people of the thread, and
 *  a machine with forty personas would push every colleague out of it. Past this the pane
 *  says so rather than growing a list nobody can use. */
export const MAX_PERSONAS = 12;

/** The custom agents the backend reports, in its own order (by name). Empty on a backend
 *  too old to publish any, which then behaves exactly as it did before the feature. */
export function agentPersonas(status: AgentStatus | null): AgentPersona[] {
  return status?.personas ?? [];
}

/** The persona with that address, or null. Matched without case, as the backend matches an
 *  address. */
export function agentPersonaNamed(
  status: AgentStatus | null,
  name: string | null | undefined,
): AgentPersona | null {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  return agentPersonas(status).find((persona) => persona.name.toLowerCase() === wanted) ?? null;
}

/**
 * Whether `name` is an address the backend would store — a port of
 * `agent_persona::is_valid_name`, pinned to it by this module's tests.
 *
 * The charset is not a whim: the name becomes part of a `@…` word the backend has to find
 * in a sentence and see END, so it holds only characters that carry a word. A `.` would
 * make `@bebou.` ambiguous with a sentence ending on an address, and a space would make
 * the address two words.
 *
 * It is here so the dialog can refuse a name AS IT IS TYPED rather than after a round
 * trip. The backend still checks — this is a courtesy, never the check.
 */
export function isValidPersonaName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,23}$/.test(name);
}

/** The longest label the backend keeps — `agent_persona::MAX_LABEL_CHARS`. */
export const MAX_PERSONA_LABEL_CHARS = 40;

/** The longest preprompt the backend keeps — `agent_persona::MAX_PREPROMPT_CHARS`. */
export const MAX_PERSONA_PREPROMPT_CHARS = 4_000;

/**
 * What a name typed into the dialog becomes: lowercased, with the `@` a reader naturally
 * types dropped and spaces turned into `-`.
 *
 * A courtesy of exactly the same kind as the check above: somebody typing "Review Bot"
 * means `review-bot`, and refusing them a space teaches them the charset one keystroke at
 * a time. What cannot be repaired — an accent, a `.` — still fails {@link
 * isValidPersonaName}, which is what the dialog says.
 */
export function personaNameFrom(typed: string): string {
  return typed.trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "-");
}

/** Why a name cannot be used, or null — the page's half of `agent_persona::check_name`.
 *
 *  A NAME COLLISION IS A REFUSAL rather than a preference: `@claude` resolves to the
 *  provider before any persona, so one named after a provider would be a row the user can
 *  see, edit and never summon — with a preprompt they believe leads every `@claude` run.
 *  `editing` is the persona being changed, whose own name is of course not taken. */
export function personaNameProblem(
  status: AgentStatus | null,
  name: string,
  editing?: string | null,
): string | null {
  if (!name) return "Give your agent a name — it is what you type after the @.";
  if (!isValidPersonaName(name)) {
    return "Lowercase letters, digits, - and _ only, up to 24 characters.";
  }
  const provider = (status?.backends ?? []).find((backend) => backend.name === name);
  if (provider) return `${provider.prefix} already summons ${provider.name}.`;
  const taken = agentPersonas(status).some(
    (persona) => persona.name === name && persona.name !== editing,
  );
  if (taken) return `You already have a custom agent called @${name}.`;
  return null;
}

/**
 * The provider a persona really runs, when this machine could really run it.
 *
 * Null covers the two shapes a page must not draw as working: a provider this backend does
 * not know, and one the user switched off or has no CLI for. It is the same question
 * `usableBackends` answers for a plain provider, asked about the agent behind a persona —
 * and it is why a persona is not offered where its provider is not.
 */
export function personaBackend(status: AgentStatus | null, persona: AgentPersona) {
  return (status?.backends ?? []).find((backend) => backend.name === persona.backend) ?? null;
}
