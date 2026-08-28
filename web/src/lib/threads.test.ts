import { describe, it, expect } from "vitest";
import {
  groupThreads,
  replyCountLabel,
  replyHeading,
  threadReplyQuotes,
  threadRootOf,
} from "./threads";
import type { ChatMessage } from "./protocol";

// A minimal channel post; overrides fill in the thread linkage under test.
function post(id: string, seq: number, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    conversation_id: "19:chan@thread.tacv2",
    seq,
    compose_time: seq,
    sender: "Someone",
    content: `msg ${id}`,
    ...over,
  };
}

describe("groupThreads", () => {
  it("groups a root post with its replies even when threads interleave", () => {
    // seq order: rootA, rootB, replyA1, replyB1, replyA2 — as the flat page arrives.
    const messages = [
      post("a", 1, { thread_root_id: "a", thread_subject: "About cats" }),
      post("b", 2, { thread_root_id: "b", thread_subject: "About dogs" }),
      post("a1", 3, { thread_root_id: "a" }),
      post("b1", 4, { thread_root_id: "b" }),
      post("a2", 5, { thread_root_id: "a" }),
    ];

    const { threads } = groupThreads(messages);

    expect(threads.map((t) => t.rootId)).toEqual(["a", "b"]);
    expect(threads[0]!.subject).toBe("About cats");
    expect(threads[0]!.lead.id).toBe("a");
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(threads[1]!.lead.id).toBe("b");
    expect(threads[1]!.replies.map((r) => r.id)).toEqual(["b1"]);
  });

  it("orders threads by the earliest loaded post in each", () => {
    const messages = [
      post("b", 1, { thread_root_id: "b" }),
      post("a", 2, { thread_root_id: "a" }),
    ];
    expect(groupThreads(messages).threads.map((t) => t.rootId)).toEqual(["b", "a"]);
  });

  it("maps each reply id back to its thread root", () => {
    const { replyRootOf } = groupThreads([
      post("a", 1, { thread_root_id: "a" }),
      post("a1", 2, { thread_root_id: "a" }),
    ]);
    expect(replyRootOf.get("a1")).toBe("a");
    expect(replyRootOf.has("a")).toBe(false); // the root is not a reply
  });

  it("stands in the earliest post as lead when the root isn't on the page", () => {
    // Only replies loaded (root scrolled off / not yet paged in).
    const { threads } = groupThreads([
      post("a1", 3, { thread_root_id: "a" }),
      post("a2", 4, { thread_root_id: "a" }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.lead.id).toBe("a1");
    expect(threads[0]!.subject).toBe("");
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["a2"]);
  });

  it("treats a post without thread linkage as its own single-post thread", () => {
    // e.g. a system event, or a chat message that carries no thread_root_id.
    const { threads } = groupThreads([post("x", 1)]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.rootId).toBe("x");
    expect(threads[0]!.lead.id).toBe("x");
    expect(threads[0]!.replies).toEqual([]);
  });
});

// Where a reply LANDS, and what it says about itself. Teams files a channel reply by the
// thread's ADDRESS rather than by a quote in the body, so getting this wrong is not a
// cosmetic mistake: the answer to an announcement opens a second, untitled thread beside it.
describe("threadRootOf", () => {
  it("is the thread a post already belongs to", () => {
    expect(threadRootOf(post("a1", 2, { thread_root_id: "a" }))).toBe("a");
  });

  it("is the post ITSELF when it carries no root — a post with none IS one", () => {
    // Both shapes reach this: a root post whose `thread_root_id` equals its own id, and a
    // post the tenant tagged with nothing at all.
    expect(threadRootOf(post("a", 1, { thread_root_id: "a" }))).toBe("a");
    expect(threadRootOf(post("a", 1))).toBe("a");
  });
});

describe("threadReplyQuotes", () => {
  it("does not quote the thread's own root: the thread IS the context", () => {
    expect(threadReplyQuotes(post("a", 1, { thread_root_id: "a" }))).toBe(false);
    expect(threadReplyQuotes(post("a", 1))).toBe(false);
  });

  it("quotes another REPLY, which is the only thing that says which one is answered", () => {
    expect(threadReplyQuotes(post("a1", 2, { thread_root_id: "a" }))).toBe(true);
  });
});

describe("replyHeading", () => {
  const root = post("a", 1, {
    thread_root_id: "a",
    thread_subject: "Token TTL",
    sender: "Ada Lovelace",
  });

  it("names the THREAD in a titled channel thread, which is what the reader recognises", () => {
    expect(replyHeading(root, "a")).toBe("Replying in “Token TTL”");
  });

  it("names the PERSON everywhere else", () => {
    // A chat has no threads at all…
    expect(replyHeading(root, null)).toBe("Replying to Ada Lovelace");
    // …a reply inside a thread carries no subject (only the root does)…
    expect(replyHeading(post("a1", 2, { thread_root_id: "a", sender: "Grace" }), "a")).toBe(
      "Replying to Grace",
    );
    // …and an untitled thread has no title to name.
    expect(replyHeading(post("b", 1, { thread_root_id: "b", sender: "Grace" }), "b")).toBe(
      "Replying to Grace",
    );
  });
});

describe("replyCountLabel", () => {
  it("never says 1 replies", () => {
    expect(replyCountLabel(1)).toBe("1 reply");
    expect(replyCountLabel(0)).toBe("0 replies");
    expect(replyCountLabel(7)).toBe("7 replies");
  });
});
