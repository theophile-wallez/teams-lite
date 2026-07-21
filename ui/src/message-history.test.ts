import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./client";
import {
  appendLiveMessage,
  HISTORY_PREFETCH_MESSAGES,
  mergeOlderHistoryPage,
  mergeRefreshedHistoryPage,
  mergeMessages,
  prefetchThresholdMessage,
} from "./message-history";

function message(seq: number): ChatMessage {
  return {
    id: `m${seq}`,
    conversation_id: "c1",
    seq,
    compose_time: seq,
    sender: "Alice",
    content: `message ${seq}`,
  };
}

describe("message history pagination", () => {
  test("prefetches when twenty older loaded messages remain", () => {
    const messages = Array.from({ length: 40 }, (_, index) => message(index + 1));

    expect(HISTORY_PREFETCH_MESSAGES).toBe(20);
    expect(prefetchThresholdMessage(messages)?.id).toBe("m21");
  });

  test("uses the oldest message when fewer than twenty are loaded", () => {
    expect(prefetchThresholdMessage([message(1), message(2)])?.id).toBe("m1");
    expect(prefetchThresholdMessage([])).toBeUndefined();
  });

  test("prepends older pages without duplicates and keeps chronological order", () => {
    const current = [message(41), message(42), message(43)];
    const incoming = [message(39), message(40), message(41)];

    expect(mergeMessages(current, incoming).map((item) => item.seq)).toEqual([
      39, 40, 41, 42, 43,
    ]);
  });

  test("a newest-page refresh preserves a deeper cache and its completed state", () => {
    const current = {
      messages: Array.from({ length: 80 }, (_, index) => message(index + 1)),
      has_more: false,
    };
    const refresh = {
      messages: Array.from({ length: 40 }, (_, index) => message(index + 41)),
      has_more: true,
    };

    const merged = mergeRefreshedHistoryPage(current, refresh);
    expect(merged.messages).toHaveLength(80);
    expect(merged.has_more).toBe(false);
  });

  test("an older page advances the end-of-history state", () => {
    const current = { messages: [message(41), message(42)], has_more: true };
    const older = { messages: [message(39), message(40)], has_more: false };

    const merged = mergeOlderHistoryPage(current, older);
    expect(merged.messages.map((item) => item.seq)).toEqual([39, 40, 41, 42]);
    expect(merged.has_more).toBe(false);
  });

  test("an empty older page marks history complete", () => {
    const current = { messages: [message(1), message(2)], has_more: true };

    const merged = mergeOlderHistoryPage(current, { messages: [], has_more: false });
    expect(merged.messages).toEqual(current.messages);
    expect(merged.has_more).toBe(false);
  });

  test("a live message initializes history before the first open response", () => {
    const live = appendLiveMessage(undefined, message(41));
    const opened = mergeRefreshedHistoryPage(live, {
      messages: [message(39), message(40)],
      has_more: false,
    });

    expect(opened.messages.map((item) => item.seq)).toEqual([39, 40, 41]);
    expect(opened.has_more).toBe(false);
  });
});
