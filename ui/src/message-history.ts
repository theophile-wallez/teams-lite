import type { ChatMessage, MessagePage } from "./client";
import type { ScrollBoxRenderable } from "@opentui/core";

export const HISTORY_PREFETCH_MESSAGES = 20;

export function historyMessageId(messageId: string): string {
  return `history-message-${messageId}`;
}

export function prefetchThresholdMessage(messages: ChatMessage[]): ChatMessage | undefined {
  if (messages.length === 0) return undefined;
  return messages[messages.length > HISTORY_PREFETCH_MESSAGES ? HISTORY_PREFETCH_MESSAGES : 0];
}

export function isPrefetchThresholdVisible(
  scrollbox: ScrollBoxRenderable,
  messages: ChatMessage[],
): boolean {
  const threshold = prefetchThresholdMessage(messages);
  if (!threshold) return false;
  const bubble = scrollbox.content.findDescendantById(historyMessageId(threshold.id));
  return bubble !== undefined && bubble.y + bubble.height >= scrollbox.viewport.y;
}

export type HistoryScrollAnchor = {
  scrollHeight: number;
  scrollTop: number;
};

export function captureHistoryScrollAnchor(scrollbox: ScrollBoxRenderable): HistoryScrollAnchor {
  return { scrollHeight: scrollbox.scrollHeight, scrollTop: scrollbox.scrollTop };
}

export function restoreHistoryScrollAnchor(
  scrollbox: ScrollBoxRenderable,
  anchor: HistoryScrollAnchor,
): void {
  scrollbox.scrollTo(anchor.scrollTop + scrollbox.scrollHeight - anchor.scrollHeight);
}

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) => a.seq - b.seq || a.compose_time - b.compose_time || a.id.localeCompare(b.id),
  );
}

export function appendLiveMessage(
  current: MessagePage | undefined,
  message: ChatMessage,
): MessagePage {
  return {
    messages: mergeMessages(current?.messages ?? [], [message]),
    // With no loaded history, older messages may exist until an open proves otherwise.
    has_more: current?.has_more ?? true,
  };
}

export function mergeOlderHistoryPage(
  current: MessagePage | undefined,
  incoming: MessagePage,
): MessagePage {
  return {
    messages: mergeMessages(current?.messages ?? [], incoming.messages),
    has_more: incoming.has_more,
  };
}

export function mergeRefreshedHistoryPage(
  current: MessagePage | undefined,
  incoming: MessagePage,
): MessagePage {
  const currentOldest = current?.messages[0];
  const incomingOldest = incoming.messages[0];
  const currentExtendsFurtherBack =
    currentOldest !== undefined &&
    (incomingOldest === undefined || currentOldest.seq < incomingOldest.seq);
  return {
    messages: mergeMessages(current?.messages ?? [], incoming.messages),
    has_more: currentExtendsFurtherBack ? current!.has_more : incoming.has_more,
  };
}
