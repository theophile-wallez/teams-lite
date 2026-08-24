import { describe, expect, it } from "vitest";

import type { ChatMessage, SealStatus } from "./protocol";
import {
  SEAL_COMPOSER_HINT,
  sealCanBeUsed,
  sealHoldsKey,
  sealIsLocked,
  sealIsOn,
  sealIsReadable,
  sealKeyDisagrees,
  sealLockedAction,
  sealLockedMessage,
  sealMenuLabel,
  sealPassphraseGroups,
  sealStateOf,
} from "./seal";

const CHAT = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "1",
    conversation_id: CHAT,
    seq: 1,
    compose_time: 1_700_000_000_000,
    sender: "Ada Lovelace",
    content: "<p>hello</p>",
    ...over,
  } as ChatMessage;
}

function status(over: Partial<SealStatus["conversations"][number]> = {}): SealStatus {
  return {
    conversations: [
      {
        conversation: CHAT,
        sealing: true,
        current_key_id: "0a1b2c3d",
        keys: [{ key_id: "0a1b2c3d", is_current: true, added_ms: 1 }],
        ...over,
      },
    ],
  };
}

describe("a message's own seal", () => {
  it("treats a message from an older backend as an ordinary one", () => {
    // The field is absent before this feature existed, and every message ever stored is one
    // of those. Reading absence as anything but "ordinary" would draw a padlock on the whole
    // history.
    expect(sealStateOf(message())).toBeNull();
    expect(sealIsReadable(message())).toBe(true);
    expect(sealIsLocked(message())).toBe(false);
  });

  it("says an OPENED message out loud, and still reads it", () => {
    // A padlock beside a message the reader CAN read is how they learn the chat is sealed.
    const opened = message({ seal: "opened" });
    expect(sealIsReadable(opened)).toBe(true);
    expect(sealIsLocked(opened)).toBe(false);
    expect(sealLockedMessage(opened)).toBe("");
    expect(sealLockedAction(opened)).toBeNull();
  });

  it("gives each failure its own sentence, because the next move differs", () => {
    const locked = message({ seal: "locked", seal_key_id: "0a1b2c3d", content: "" });
    const newer = message({ seal: "newer", content: "" });
    const damaged = message({ seal: "damaged", content: "" });
    for (const m of [locked, newer, damaged]) {
      expect(sealIsLocked(m)).toBe(true);
      expect(sealLockedMessage(m)).not.toBe("");
    }
    const said = [locked, newer, damaged].map(sealLockedMessage);
    expect(new Set(said).size).toBe(3);
    // Only a missing passphrase is something the reader can act on here.
    expect(sealLockedAction(locked)).toBe("add-passphrase");
    expect(sealLockedAction(newer)).toBeNull();
    expect(sealLockedAction(damaged)).toBeNull();
  });

  it("never puts a key or a ciphertext in what it says", () => {
    const locked = message({ seal: "locked", seal_key_id: "0a1b2c3d", content: "" });
    expect(sealLockedMessage(locked)).not.toContain("0a1b2c3d");
  });
});

describe("whether a conversation is sealed", () => {
  it("is false until the backend has answered", () => {
    // The reading every unanswered capability takes here: a hopeful `true` would tell the
    // reader their next message is encrypted while it goes out in the clear.
    expect(sealIsOn(null, CHAT)).toBe(false);
    expect(sealHoldsKey(null, CHAT)).toBe(false);
    expect(sealIsOn(status(), null)).toBe(false);
    expect(sealIsOn({ conversations: [] }, CHAT)).toBe(false);
  });

  it("tells sealing OFF apart from holding no key at all", () => {
    // A chat that stopped being sealed keeps its keys, so its history stays readable. The two
    // states earn different words.
    const off = status({ sealing: false, current_key_id: "" });
    expect(sealIsOn(off, CHAT)).toBe(false);
    expect(sealHoldsKey(off, CHAT)).toBe(true);
    expect(sealMenuLabel(off, CHAT)).toBe("Encryption off");
    expect(sealMenuLabel(status(), CHAT)).toBe("Encryption on");
    expect(sealMenuLabel({ conversations: [] }, CHAT)).toBe("Encrypt this chat");
  });
});

describe("where it may be used", () => {
  it("refuses a channel and the chat with oneself", () => {
    // A channel's history is drawn as threads, and the backend refuses to seal one — so
    // offering it would be a control that reports a refusal. Notes has nobody to share a
    // passphrase with.
    expect(sealCanBeUsed("group", CHAT)).toBe(true);
    expect(sealCanBeUsed("one_on_one", CHAT)).toBe(true);
    expect(sealCanBeUsed("notes", "48:notes")).toBe(false);
    expect(sealCanBeUsed(undefined, "19:abc@thread.tacv2;messageid=1755")).toBe(false);
    expect(sealCanBeUsed("group", null)).toBe(false);
  });
});

describe("the warning that stops two people sealing past each other", () => {
  it("fires when the thread's messages carry a key this machine does not hold", () => {
    // THE sharpest failure: both set a different passphrase, every message each posts is
    // unreadable to the other, and without this neither is told.
    const theirs = [message({ seal: "locked", seal_key_id: "99999999", content: "" })];
    expect(sealKeyDisagrees(status(), CHAT, theirs)).toBe(true);
  });

  it("stays quiet when every locked message is under a key this machine holds", () => {
    // A key this machine holds but is not CURRENT still opens what it sealed, so a locked
    // message under it is a message this machine can read — not a disagreement.
    const rotated = status({
      keys: [
        { key_id: "0a1b2c3d", is_current: true, added_ms: 2 },
        { key_id: "99999999", is_current: false, added_ms: 1 },
      ],
    });
    const theirs = [message({ seal: "locked", seal_key_id: "99999999", content: "" })];
    expect(sealKeyDisagrees(rotated, CHAT, theirs)).toBe(false);
  });

  it("stays quiet where this machine is not sealing, and where nothing is locked", () => {
    const theirs = [message({ seal: "locked", seal_key_id: "99999999", content: "" })];
    expect(sealKeyDisagrees(status({ sealing: false }), CHAT, theirs)).toBe(false);
    expect(sealKeyDisagrees(status(), CHAT, [message({ seal: "opened" })])).toBe(false);
    expect(sealKeyDisagrees(status(), CHAT, [message()])).toBe(false);
    expect(sealKeyDisagrees(null, CHAT, theirs)).toBe(false);
  });
});

describe("what the reader is told", () => {
  it("names the one part of a message that is NOT sealed", () => {
    // A picture's bytes go to Microsoft's own object store, so nothing here can seal them —
    // and a message that looked sealed while carrying a readable screenshot would be a lie.
    expect(SEAL_COMPOSER_HINT).toContain("Pictures");
  });

  it("draws a generated passphrase in the groups it was made in", () => {
    expect(sealPassphraseGroups("abcd-efgh-jkmn-pqrs-tuvw")).toEqual([
      "abcd",
      "efgh",
      "jkmn",
      "pqrs",
      "tuvw",
    ]);
    expect(sealPassphraseGroups("")).toEqual([]);
  });
});
