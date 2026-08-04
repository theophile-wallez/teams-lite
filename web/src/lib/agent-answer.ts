// "Answer with <agent>": the message menu's way of pointing one of this machine's agent
// CLIs at one message of the thread.
//
// It is the same feature as the composer's own tag, reached from the other end — the
// message instead of the keyboard — and it keeps every rule that one has:
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

/** One "Answer with …" the user picked: which agent, plus a token that changes on every
 *  pick, so the composer applies each one exactly once. */
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
};

/** The words that follow the tag in the composer.
 *
 *  A half-written draft IS the request, and it is kept: the user asking for an answer
 *  must not lose the sentence they were typing. An empty composer gets
 *  {@link ANSWER_REQUEST}, because the prefix alone asks nothing. */
export function answerRequest(existing: string): string {
  return existing.trim() === "" ? ANSWER_REQUEST : "";
}
