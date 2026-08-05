import { describe, expect, it } from "vitest";
import { ANSWER_REQUEST, answerRequest } from "./agent-answer";

/** `agent_policy::split_prefix` in TypeScript: the backend a body summons, or null.
 *  Written out here rather than imported because it is the RUST rule this feature has to
 *  satisfy — a draft that does not pass it is a message that starts no program. */
function summons(body: string, prefix: string): boolean {
  const trimmed = body.trimStart();
  if (!trimmed.toLowerCase().startsWith(prefix)) return false;
  const rest = trimmed.slice(prefix.length);
  if (rest !== "" && !/^[\s:,]/.test(rest)) return false;
  return rest.replace(/^[\s:,]+/, "").trim() !== "";
}

describe("answerRequest", () => {
  it("seeds a request into an empty composer, so the draft really summons the agent", () => {
    expect(answerRequest("")).toBe(ANSWER_REQUEST);
    expect(answerRequest("   \n ")).toBe(ANSWER_REQUEST);
    // The whole point: a bare prefix asks nothing, and the backend refuses it.
    expect(summons("@claude", "@claude")).toBe(false);
    expect(summons(`@claude ${answerRequest("")}`, "@claude")).toBe(true);
    expect(summons(`@opencode ${answerRequest("")}`, "@opencode")).toBe(true);
  });

  it("keeps a half-written draft as the request instead of talking over it", () => {
    expect(answerRequest("what did they mean?")).toBe("");
    expect(summons("@claude what did they mean?", "@claude")).toBe(true);
  });

  it("seeds the row's OWN request when it has one, under the same rule", () => {
    // "Review with <agent>" names the merge request it is about; the composer applies it
    // exactly where it applies "Answer this message.", and no further.
    const review = "Review this merge request: !42 https://gitlab.com/a/b/-/merge_requests/42";
    expect(answerRequest("", review)).toBe(review);
    expect(summons(`@claude ${answerRequest("", review)}`, "@claude")).toBe(true);
    // The user's own sentence still wins: whose words go out never depends on the row.
    expect(answerRequest("does the migration run twice?", review)).toBe("");
  });
});
