import { describe, expect, it } from "vitest";
import {
  threadDigestTruncated,
  threadsAcross,
  threadsRowLabel,
} from "./threads-view";
import type { Channel, ChatMessage, Conversation } from "./protocol";

const CHAT = "19:c@thread.v2";
const CHANNEL = "19:abc@thread.tacv2";

function msg(over: Partial<ChatMessage> & { id: string; seq: number }): ChatMessage {
  return {
    conversation_id: CHAT,
    compose_time: over.seq,
    sender: "Ada Lovelace",
    sender_mri: "8:orgid:ada",
    content: "<p>hello</p>",
    ...over,
  };
}

function reply(time: number, body: string): string {
  return (
    `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${time}">` +
    `<strong itemprop="mri" itemid="8:orgid:ada">Ada Lovelace</strong>` +
    `<span itemprop="time" itemid="${time}"></span>` +
    `<p itemprop="preview">quoted</p></blockquote><p>${body}</p>`
  );
}

describe("threadsAcross", () => {
  it("lists a chat thread the reader replied in", () => {
    const rows = threadsAcross([
      msg({ id: "1", seq: 1 }),
      msg({ id: "2", seq: 2, content: reply(1, "yes"), is_self: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe(CHAT);
    expect(rows[0]!.thread.rootId).toBe("1");
    expect(rows[0]!.replies.count).toBe(1);
    expect(rows[0]!.lastReplyMs).toBe(2);
  });

  it("lists a thread the reader OPENED even when only colleagues answered", () => {
    const rows = threadsAcross([
      msg({ id: "1", seq: 1, is_self: true }),
      msg({ id: "2", seq: 2, content: reply(1, "yes") }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("leaves out a thread the reader wrote in nowhere", () => {
    // Slack's own rule for its All Threads: it lists the threads you are FOLLOWING, which is
    // the ones you took part in. Two colleagues talking in a group chat is not the reader's to
    // be handed a list of.
    expect(
      threadsAcross([msg({ id: "1", seq: 1 }), msg({ id: "2", seq: 2, content: reply(1, "y") })]),
    ).toEqual([]);
  });

  it("reads a CHANNEL's threads off the address Teams put on them", () => {
    // A channel is TOLD the shape of its threads. Reading a channel with the chat derivation
    // would find no quote on a reply into a thread and list nothing at all.
    const rows = threadsAcross([
      msg({ id: "1", seq: 1, conversation_id: CHANNEL, thread_root_id: "1", is_self: true }),
      msg({ id: "2", seq: 2, conversation_id: CHANNEL, thread_root_id: "1" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe(CHANNEL);
    expect(rows[0]!.replies.count).toBe(1);
  });

  it("orders the rows by the NEWEST reply, whichever conversation it is in", () => {
    const rows = threadsAcross([
      msg({ id: "1", seq: 1, is_self: true }),
      msg({ id: "2", seq: 2, content: reply(1, "old") }),
      msg({ id: "10", seq: 10, conversation_id: CHANNEL, thread_root_id: "10", is_self: true }),
      msg({ id: "11", seq: 11, conversation_id: CHANNEL, thread_root_id: "10" }),
    ]);
    expect(rows.map((r) => r.thread.rootId)).toEqual(["10", "1"]);
  });

  it("puts the digest back in seq order before deriving", () => {
    // The digest answers NEWEST FIRST (`ORDER BY seq DESC`), and both derivations walk a
    // history in the order it was written: taken as it arrives, a thread's replies would be
    // listed backwards and its "last reply" would be its first.
    const rows = threadsAcross([
      msg({ id: "3", seq: 3, content: reply(1, "second"), is_self: true }),
      msg({ id: "2", seq: 2, content: reply(1, "first") }),
      msg({ id: "1", seq: 1 }),
    ]);
    expect(rows[0]!.thread.replies.map((m) => m.id)).toEqual(["2", "3"]);
    expect(rows[0]!.lastReplyMs).toBe(3);
  });
});

describe("threadsRowLabel", () => {
  const channels = [{ id: CHANNEL, name: "Incidents", team_name: "Engineering" } as Channel];
  const conversations = [{ id: CHAT, name: "Ada Lovelace", kind: "one_on_one" } as Conversation];

  it("names a channel and a chat through the app's own two namers", () => {
    expect(threadsRowLabel(CHANNEL, conversations, channels)).toContain("Incidents");
    expect(threadsRowLabel(CHAT, conversations, channels)).toContain("Ada");
  });

  it("never shows an id — a row nobody can read is worse than a generic word", () => {
    expect(threadsRowLabel("19:nowhere@thread.v2", conversations, channels)).toBe("Conversation");
  });
});

describe("threadDigestTruncated", () => {
  it("claims nothing where no bound was named", () => {
    // A backend too old to say: a list that says it is complete when nobody told it so is
    // worse than one that says nothing.
    expect(threadDigestTruncated([msg({ id: "1", seq: 1 })], null)).toBe(false);
  });

  it("says the list is the newest once the digest filled its bound", () => {
    expect(threadDigestTruncated([msg({ id: "1", seq: 1 })], 2)).toBe(false);
    expect(
      threadDigestTruncated([msg({ id: "1", seq: 1 }), msg({ id: "2", seq: 2 })], 2),
    ).toBe(true);
  });
});
