import { describe, expect, it } from "vitest";
import {
  BROADCAST_HINT,
  BROADCAST_LABEL,
  broadcastOffered,
  chatThreadRootOf,
  chatThreads,
  replyTargetTime,
} from "./chat-threads";
import type { ChatMessage } from "./protocol";

/** A message, with the fields these rules read and nothing else. */
function msg(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    conversation_id: "19:c@thread.v2",
    seq: Number(over.id.replace(/\D/g, "")) || 1,
    compose_time: Number(over.id.replace(/\D/g, "")) || 1,
    sender: "Ada Lovelace",
    sender_mri: "8:orgid:ada",
    content: "<p>hello</p>",
    ...over,
  };
}

/** Teams' own reply blockquote, addressing the message that arrived at `time`. */
function reply(time: number, body: string): string {
  return (
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${time}">` +
    `<strong itemprop="mri" itemid="8:orgid:ada">Ada Lovelace</strong>` +
    `<span itemprop="time" itemid="${time}"></span>` +
    `<p itemprop="preview">quoted</p></blockquote><p>${body}</p>`
  );
}

describe("replyTargetTime", () => {
  it("reads the message a reply answers off its own quote", () => {
    expect(replyTargetTime(msg({ id: "2", content: reply(1, "yes") }))).toBe(1);
  });

  it("reads NOTHING off a forward — it is nobody's reply", () => {
    // Teams sends a forward with no author, no time and no id: the message it holds was said
    // somewhere else, so filing one under a thread would put a stranger's words in a
    // conversation they were never part of.
    const forwarded =
      `<blockquote itemtype="http://schema.skype.com/Forward"><p>said elsewhere</p></blockquote>`;
    expect(replyTargetTime(msg({ id: "2", content: forwarded }))).toBeNull();
  });

  it("reads NOTHING off a plain-text body, where a blockquote is characters somebody typed", () => {
    expect(
      replyTargetTime(msg({ id: "2", message_type: "Text", content: reply(1, "yes") })),
    ).toBeNull();
  });

  it("reads nothing off an ordinary message", () => {
    expect(replyTargetTime(msg({ id: "2" }))).toBeNull();
  });
});

describe("chatThreads", () => {
  it("groups a reply under the message it answers", () => {
    const root = msg({ id: "1" });
    const answer = msg({ id: "2", content: reply(1, "yes") });
    const model = chatThreads([root, answer]);
    expect(model.threads).toHaveLength(1);
    expect(model.threads[0]!.rootId).toBe("1");
    expect(model.threads[0]!.replies.map((m) => m.id)).toEqual(["2"]);
    expect(model.threadOf.get("2")).toBe("1");
    // A chat message has no title, so the panel names the thread by its opening words.
    expect(model.threads[0]!.subject).toBe("");
  });

  it("leaves a message nobody answered out of the threads entirely", () => {
    // A thread is a root plus at least one reply. A root with none has nothing to disclose,
    // which is the rule `threadReplies` already holds for the foot row.
    expect(chatThreads([msg({ id: "1" }), msg({ id: "2" })]).threads).toEqual([]);
  });

  it("does NOT fold a reply whose parent is not loaded", () => {
    // The history pages a screen at a time, so the parent is very often not here yet. Folding
    // against a parent that is nowhere would take the reply out of the running history and put
    // it in no thread — a message the reader can no longer reach from anywhere.
    const orphan = msg({ id: "9", content: reply(1, "yes"), thread_only: true });
    const model = chatThreads([orphan]);
    expect(model.threads).toEqual([]);
    expect(model.folded.size).toBe(0);
    expect(model.threadOf.size).toBe(0);
  });

  it("puts a reply to a REPLY in the root's own thread", () => {
    // One level deep, which is Slack's shape and a channel's already: a tree would draw a
    // column of nested quotes nobody can follow on a 390px screen.
    const root = msg({ id: "1" });
    const first = msg({ id: "2", content: reply(1, "a") });
    const second = msg({ id: "3", content: reply(2, "b") });
    const model = chatThreads([root, first, second]);
    expect(model.threads).toHaveLength(1);
    expect(model.threads[0]!.rootId).toBe("1");
    expect(model.threads[0]!.replies.map((m) => m.id)).toEqual(["2", "3"]);
    expect(model.threadOf.get("3")).toBe("1");
  });

  it("folds ONLY a reply whose author asked for it", () => {
    // The reply is really in the conversation — every stock client draws it inline — so the
    // flag is what says its author unticked "Also send to the chat". A reply with no flag is a
    // broadcast, which is what every reply this app ever sent is.
    const root = msg({ id: "1" });
    const folded = msg({ id: "2", content: reply(1, "a"), thread_only: true });
    const broadcast = msg({ id: "3", content: reply(1, "b") });
    const model = chatThreads([root, folded, broadcast]);
    expect([...model.folded]).toEqual(["2"]);
    // Both are in the thread either way: what the flag decides is the running history.
    expect(model.threads[0]!.replies.map((m) => m.id)).toEqual(["2", "3"]);
  });

  it("survives a quote that names its own message, and a cycle", () => {
    // The ids come out of somebody else's client, so a loop must cost a walk rather than the
    // tab.
    const itself = msg({ id: "1", compose_time: 1, content: reply(1, "me") });
    expect(chatThreads([itself]).threads).toEqual([]);
    const a = msg({ id: "1", compose_time: 1, content: reply(2, "a") });
    const b = msg({ id: "2", compose_time: 2, content: reply(1, "b") });
    expect(() => chatThreads([a, b])).not.toThrow();
  });

  it("names the thread a reply to a message lands in", () => {
    const root = msg({ id: "1" });
    const answer = msg({ id: "2", content: reply(1, "yes") });
    const model = chatThreads([root, answer]);
    // Answering the ROOT stays in its thread, and so does answering a reply.
    expect(chatThreadRootOf(model, root)).toBe("1");
    expect(chatThreadRootOf(model, answer)).toBe("1");
    // A message in no thread IS a root: the reply that starts one lands in itself.
    expect(chatThreadRootOf(chatThreads([]), msg({ id: "7" }))).toBe("7");
  });
});

describe("broadcastOffered", () => {
  it("is offered on a CHAT reply and nowhere else", () => {
    expect(broadcastOffered({ isChannel: false, replying: true })).toBe(true);
    // A channel reply is filed by ADDRESS, so it is out of the channel's column whatever this
    // app does — broadcasting one would mean posting a SECOND message to the channel root.
    expect(broadcastOffered({ isChannel: true, replying: true })).toBe(false);
    // A top-level message belongs to no thread, which is why the backend refuses the flag on
    // one: it would hide the message with nothing able to say where it went.
    expect(broadcastOffered({ isChannel: false, replying: false })).toBe(false);
  });

  it("says the reply reaches the same people either way", () => {
    // The one thing a reader must not conclude from unticking it is that somebody will not see
    // their words — the reply is in the conversation for every client there is.
    expect(BROADCAST_HINT).toMatch(/either way/i);
    expect(BROADCAST_LABEL).toMatch(/chat/i);
  });
});
