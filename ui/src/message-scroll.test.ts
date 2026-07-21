import { afterEach, expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ChatMessage } from "./client";
import {
  captureHistoryScrollAnchor,
  historyMessageId,
  isPrefetchThresholdVisible,
  restoreHistoryScrollAnchor,
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

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => setup?.renderer.destroy());

function messageBox(item: ChatMessage): BoxRenderable {
  return new BoxRenderable(setup!.renderer, {
    id: historyMessageId(item.id),
    height: 1,
    width: "100%",
  });
}

async function renderHistory(messages: ChatMessage[]): Promise<ScrollBoxRenderable> {
  setup = await createTestRenderer({ width: 30, height: 10 });
  const scrollbox = new ScrollBoxRenderable(setup.renderer, {
    height: 10,
    width: 30,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  for (const item of messages) scrollbox.add(messageBox(item));
  setup.renderer.root.add(scrollbox);
  await setup!.renderOnce();
  return scrollbox;
}

test("prefetch threshold becomes visible with twenty older messages remaining", async () => {
  const initial = Array.from({ length: 40 }, (_, index) => message(index + 1));
  const scrollbox = await renderHistory(initial);

  expect(isPrefetchThresholdVisible(scrollbox, initial)).toBe(false);
  scrollbox.scrollTo(20);
  await setup!.renderOnce();
  expect(isPrefetchThresholdVisible(scrollbox, initial)).toBe(true);
});

test("prepending a page preserves the visible history position", async () => {
  const current = Array.from({ length: 40 }, (_, index) => message(index + 41));
  const scrollbox = await renderHistory(current);
  scrollbox.stickyScroll = false;
  scrollbox.scrollTo(15);
  const anchor = captureHistoryScrollAnchor(scrollbox);

  const older = Array.from({ length: 40 }, (_, index) => message(index + 1));
  for (const [index, item] of older.entries()) scrollbox.add(messageBox(item), index);
  await setup!.renderOnce();
  expect(scrollbox.scrollHeight).toBe(80);
  restoreHistoryScrollAnchor(scrollbox, anchor);

  expect(scrollbox.scrollTop).toBe(55);
});
