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
 * It is read on EVERY message, not only on ours. Our own runs go out through the user's
 * account and arrive as ours, but a colleague in the thread may run teams-lite too, and
 * their agent's answer is an agent's answer: read as an ordinary message it hands the
 * reader the raw `— claude, via teams-lite` line the mark above the bubble exists to
 * replace, tucked against that colleague's own words as if they had written it. Whose
 * account it went out under is never guessed — the bubble names it beside the mark, from
 * the message's own sender ("Claude by <sender>"), so a reply from another machine is
 * attributed to that machine's owner and never to this one.
 *
 * A colleague could of course end a message with that italic line by hand and be drawn
 * under the CLI's mark. That is the same claim the user can make about their own
 * messages, it takes deliberate effort, and it hides nothing the reader cannot see: the
 * account that posted the words is still named beside the mark.
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

/** How a backend's name is written for a reader: each vendor's own casing. Claude is a
 *  proper noun; opencode is lowercase on purpose. Shared, because the mark's label and
 *  the status line under it must spell the same CLI the same way. */
export function agentDisplayName(backend: string): string {
  return backend === "claude" ? "Claude" : backend;
}

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
 * Whoever wrote it: a reply is recognised from the line it signs itself with and from
 * nothing else, so a colleague's teams-lite answering in this thread renders exactly as
 * ours does (see the note on authorship at the top of this module).
 *
 * A DELETED message is never one. Its own placeholder is the body — a ghost bubble the
 * reader can unveil when we cached the original — and an agent bubble must not replace
 * it.
 */
export function agentAuthorship(message: ChatMessage): AgentAuthorship | null {
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
