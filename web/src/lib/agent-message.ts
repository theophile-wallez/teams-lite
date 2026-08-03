/**
 * Recognising a message the local agent wrote, from the message itself.
 *
 * The reply is posted through the user's own account (that is the whole feature: an
 * answer in the thread, readable by everyone in it), so nothing on the wire marks it as
 * a machine's. What marks it is the line the backend signs it with — `— claude, via
 * teams-lite` — which exists for honesty about authorship and is required by
 * AGENTS.md § The local agent. This module reads that signature back.
 *
 * That is a deliberate choice over a side channel. A stored flag would only cover
 * messages this app saw being written; the signature covers every reply ever posted,
 * including the ones already in the history and the ones answered while this app was
 * closed — which is most of them, since the point of the feature is answering from a
 * phone.
 *
 * The four shapes are `agent_policy::thinking_html`, `reply_html` (streaming and
 * finished) and `failure_html` in src/agent_policy.rs. The patterns tolerate the
 * whitespace Teams inserts when it stores a body, because it does (`</p>\r\n<p>` for
 * our `</p><p>`), and nothing else — a body that merely mentions the agent stays an
 * ordinary message.
 */

import type { ChatMessage } from "./protocol";

/** The agent CLIs whose signature is recognised — `agent_policy::BACKENDS`. Closed on
 *  purpose: it is what makes "a message signed by a name we know" different from "a
 *  message containing a dash and the words via teams-lite". */
export const AGENT_BACKENDS = ["claude", "opencode"] as const;

export type AgentBackendName = (typeof AGENT_BACKENDS)[number];

/** What the signature says about a message. */
export type AgentAuthorship = {
  /** Which CLI wrote it. */
  backend: AgentBackendName;
  /** The message with the signature line removed — the answer itself. Empty while the
   *  reply is still only a placeholder. */
  bodyHtml: string;
  /** True while the answer is still being written (the placeholder, or a streamed
   *  body signed "is writing…"). The backend's last edit is what clears it, so this is
   *  also what a reader sees for a run that died mid-answer. */
  pending: boolean;
  /** Why the run failed, when it did. */
  failure: string | null;
};

/** One trailing `<p><em>…</em></p>`, allowing the whitespace Teams stores. */
const SIGNATURE = /<p>\s*<em>\s*([^<]*?)\s*<\/em>\s*<\/p>\s*$/i;
/** A backend name, as a signature spells it. */
const NAME = "[a-z0-9][a-z0-9._-]{0,23}";
const SIGNED = new RegExp(`^—\\s*(${NAME}),\\s*via teams-lite$`, "i");
const WRITING = new RegExp(`^(${NAME}) is (?:writing|thinking)…?$`, "i");
const FAILED = new RegExp(`^(${NAME}) could not answer:\\s*(.*)$`, "i");

/**
 * Read a message's agent signature, or null when it has none.
 *
 * Only a message of OURS can be one: the backend posts as the user, so a signature on
 * somebody else's message was typed by them and means nothing. That check is first
 * because it is also the cheap one — most messages in a thread are not ours.
 */
export function agentAuthorship(message: ChatMessage): AgentAuthorship | null {
  if (message.is_self !== true) return null;
  if (message.deleted === true) return null;
  const content = message.content ?? "";
  const signature = SIGNATURE.exec(content);
  if (!signature) return null;
  const line = signature[1] ?? "";
  const bodyHtml = content.slice(0, signature.index).trimEnd();

  const signed = SIGNED.exec(line);
  if (signed) {
    const backend = knownBackend(signed[1]);
    return backend && { backend, bodyHtml, pending: false, failure: null };
  }
  const writing = WRITING.exec(line);
  if (writing) {
    const backend = knownBackend(writing[1]);
    return backend && { backend, bodyHtml, pending: true, failure: null };
  }
  const failed = FAILED.exec(line);
  if (failed) {
    const backend = knownBackend(failed[1]);
    return (
      backend && {
        backend,
        bodyHtml,
        pending: false,
        failure: (failed[2] ?? "").trim() || `${backend} could not answer`,
      }
    );
  }
  return null;
}

/** The backend a signature names, when we know it. */
function knownBackend(name: string | undefined): AgentBackendName | null {
  const lower = (name ?? "").toLowerCase();
  return AGENT_BACKENDS.find((backend) => backend === lower) ?? null;
}
