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
});
