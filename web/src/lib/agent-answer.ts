// "Answer with <agent>": the message menu's way of pointing one of this machine's agent
// CLIs at one message of the thread.
//
// It is the same feature as the composer's own tag, reached from the other end — the
// message instead of the keyboard — and it keeps every rule that one has:
//
// The same shape carries "Review with <agent>", the row a message offers when it names a
// merge request (see lib/merge-request.ts): one pick, one tag at the front of the draft,
// one request seeded — what changes between the two rows is the sentence, never the rules.
//
//   - **It DRAFTS, it never sends.** Picking it starts a reply to that message and puts
//     the tag at the front of the composer; the send is the user's own Enter, because a
//     message posted under their name needs their consent for that exact message
//     (AGENTS.md § Sending messages).
//   - **It is offered only where an agent would really answer.** The rows come from
//     `agentCandidatesFor`, which is the backend's own state: a usable CLI, a provider
//     the user left on, and THIS conversation opted in. The consent gate stays in the
//     thread's own menu; this only reflects it.
//   - **The tag goes to the START of the message**, because that is the only place the
//     backend reads it from (`agent_policy::split_prefix`).

/** What the composer says after the tag when the user had written nothing.
 *
 *  A bare prefix summons nothing — `agent_policy::split_prefix` refuses an empty prompt,
 *  so "@claude" alone would post a message that starts no program at all. The request
 *  therefore comes seeded, and the reply the draft carries is what says which message
 *  "this" names (the backend reads it back out of the quote: `agent_policy::answering`). */
export const ANSWER_REQUEST = "Answer this message.";

/** What the composer says after the tag when the pick already knows what to ask, and the
 *  user had written nothing: a review names the merge request it is about (see
 *  `reviewRequest` in lib/merge-request.ts). Same shape as {@link ANSWER_REQUEST} and
 *  same rule — it seeds an EMPTY composer only. */
export type RequestSeed = string;

/** One "Answer with …" or "Review with …" the user picked: which agent, what to ask it,
 *  plus a token that changes on every pick, so the composer applies each one exactly
 *  once. */
export type AgentAnswer = {
  token: number;
  /** The conversation it was asked in. A request belongs to its thread and is spent there:
   *  the composer drops one that does not name the open conversation, and the pane forgets
   *  it when the thread changes. Both halves matter, because the composer keys its editor
   *  per conversation — without them, walking away and back would write the tag into a
   *  chat nobody asked in, or a second time over a draft already dealt with. */
  conversation: string;
  /** The backend name (`claude`, `opencode`) — the mark the chip wears. */
  backend: string;
  /** The prefix that summons it, as the BACKEND spelled it. */
  prefix: string;
  /** What to ask for, when the pick knows: the menu row that points an agent at a merge
   *  request names that merge request. Absent means {@link ANSWER_REQUEST} — "answer
   *  this message", which the reply's own quote resolves. */
  request?: RequestSeed;
};

/** The words that follow the tag in the composer.
 *
 *  A half-written draft IS the request, and it is kept: the user asking for an answer
 *  must not lose the sentence they were typing. An empty composer gets `seed` — the
 *  row's own request, or {@link ANSWER_REQUEST} — because the prefix alone asks nothing.
 *
 *  One rule for both entry points on purpose: "Answer with" and "Review with" differ in
 *  what they ask, never in whose words win. */
export function answerRequest(existing: string, seed: RequestSeed = ANSWER_REQUEST): string {
  return existing.trim() === "" ? seed : "";
}
