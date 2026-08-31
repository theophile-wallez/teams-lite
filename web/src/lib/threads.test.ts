import { describe, it, expect } from "vitest";
import {
  channelLayoutOf,
  groupThreads,
  PANEL_HEADING_CHARS,
  REPLIER_FACES,
  replyCountLabel,
  replyHeading,
  threadPanelHeading,
  threadReplies,
  threadReplyQuotes,
  threadRootOf,
} from "./threads";
import { formatMessageTime } from "./message-time";
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

describe("channelLayoutOf", () => {
  it("is the channel's own choice, and anything unrecognised is POSTS", () => {
    expect(channelLayoutOf("conversation")).toBe("conversation");
    // Every one of these is a channel this app must keep drawing exactly as it did before
    // the layout was read at all: an ABSENT modality is 54 of this tenant's 70 channels, and
    // a word nobody measured must never opt a channel into the other surface.
    for (const unknown of [
      undefined,
      null,
      "",
      "posts",
      "Conversational",
      "PostReply",
      "something-new-in-2027",
    ]) {
      expect(channelLayoutOf(unknown)).toBe("posts");
    }
  });
});

describe("threadReplies", () => {
  const thread = (replies: ChatMessage[]) => ({
    rootId: "a",
    subject: "",
    lead: post("a", 1),
    replies,
  });

  it("says nothing at all about a post nobody has answered", () => {
    // Not "0 replies": a post with no thread under it has nothing to disclose, and a control
    // that opens an empty panel is a control that changes nothing.
    expect(threadReplies(thread([]))).toBeNull();
  });

  it("counts every reply and names the newest moment", () => {
    const now = Date.parse("2026-08-31T12:00:00Z");
    const replies = [
      post("a1", 2, { sender: "Ada", sender_mri: "8:orgid:ada", compose_time: now - 7_200_000 }),
      post("a2", 3, { sender: "Grace", sender_mri: "8:orgid:grace", compose_time: now - 60_000 }),
    ];
    const summary = threadReplies(thread(replies), now)!;
    expect(summary.count).toBe(2);
    expect(summary.label).toBe("2 replies");
    // The newest reply is the LAST one, because a thread's replies arrive in seq order — read
    // off the list rather than re-sorted.
    expect(summary.lastReply).toBe(formatMessageTime(now - 60_000, now));
  });

  it("stacks one face per PERSON, keyed on the identity and never on the name", () => {
    // Measured on this tenant, 273 of one group chat's 899 messages arrive with a blank
    // sender — so two DIFFERENT colleagues both unnamed would stack as one person if the name
    // were the key, and an authorless post (a recording, a thread activity) is nobody at all.
    const replies = [
      post("r1", 2, { sender: "Ada Lovelace", sender_mri: "8:orgid:ada" }),
      post("r2", 3, { sender: "", sender_mri: "8:orgid:ada" }),
      post("r3", 4, { sender: "Grace Hopper", sender_mri: "8:orgid:grace" }),
      post("r4", 5, { sender: "", sender_mri: "" }),
      post("r5", 6, { sender: "Alan Turing", sender_mri: "8:orgid:alan" }),
      post("r6", 7, { sender: "Katherine", sender_mri: "8:orgid:katherine" }),
    ];
    const summary = threadReplies(thread(replies))!;
    expect(summary.count).toBe(6);
    expect(summary.repliers.map((r) => r.id)).toEqual(["r1", "r3", "r5"]);
    expect(summary.repliers).toHaveLength(REPLIER_FACES);
  });

  it("falls back to the NAME only where there is no identity to key on", () => {
    const replies = [
      post("r1", 2, { sender: "Ada Lovelace", sender_mri: "" }),
      post("r2", 3, { sender: "Ada Lovelace", sender_mri: "" }),
    ];
    expect(threadReplies(thread(replies))!.repliers.map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("threadPanelHeading", () => {
  const thread = (over: { subject?: string; sender?: string } = {}) => ({
    rootId: "a",
    subject: over.subject ?? "",
    lead: post("a", 1, { sender: over.sender ?? "Ada Lovelace" }),
    replies: [],
  });

  it("names a titled announcement by its TITLE", () => {
    expect(threadPanelHeading(thread({ subject: "  Release 4.2  " }), "the body")).toBe(
      "Release 4.2",
    );
  });

  it("takes an untitled post's opening words, on one line", () => {
    expect(threadPanelHeading(thread(), "Deploy   is\nstuck again")).toBe("Deploy is stuck again");
    const long = "x".repeat(PANEL_HEADING_CHARS + 20);
    const heading = threadPanelHeading(thread(), long);
    expect(heading).toBe(`${"x".repeat(PANEL_HEADING_CHARS)}…`);
    expect(heading.length).toBeLessThanOrEqual(PANEL_HEADING_CHARS + 1);
  });

  it("names the author of a post with no words at all", () => {
    // A post whose whole content is a picture or a card: the header still has to say which
    // thread this is, and who wrote it is the only thing left that does.
    expect(threadPanelHeading(thread({ sender: "Ada Lovelace" }), "   ")).toBe("Ada Lovelace");
    expect(threadPanelHeading(thread({ sender: "" }), "")).toBe("Thread");
  });
});
