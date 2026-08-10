import type { ChatMessage } from "./protocol";

/**
 * When the history says WHEN something was said.
 *
 * A stamp on every message is noise — a burst of ten replies over two minutes
 * carries one fact between them, not ten — so the history marks the START of a
 * block instead, the way Instagram's own threads do: one small centred line above
 * the first message of a stretch, and nothing above the rest of it.
 *
 * A block begins for one of two reasons, and both are the reader's question rather
 * than a round number:
 *
 *  - **The DAY changed.** 23:55 and 00:10 are ten minutes apart and belong to two
 *    different days, which is the one case a reader cannot work out from the words.
 *  - **The two messages are more than {@link TIME_MARK_GAP_MS} apart** — one
 *    conversation stopped and another started.
 *
 * A mark needs the message BEFORE it, so the oldest loaded row never carries one:
 * the history pages older on its own as the reader scrolls up, and a mark drawn on
 * whatever happens to be at the top would be taken away again by the page that
 * arrives above it. What that costs is a thread whose whole loaded page sits inside
 * one hour of one day — a conversation being had right now, where the answer is
 * "just now" — and that is the cheaper of the two.
 */

/** How long a silence has to be for the next message to open a new block. An hour:
 *  below it, a slow exchange over lunch would be cut into stamped fragments. */
export const TIME_MARK_GAP_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** A message, as much of one as a mark is decided from. */
type Timed = Pick<ChatMessage, "id" | "compose_time">;

/**
 * Every mark a history earns, by the message that carries it.
 *
 * Taken over the messages AS DRAWN, in runs: a chat is one run, and a channel is one
 * per thread — a reply's "previous" is the reply above it inside its own thread, not
 * whatever the flat page happened to interleave.
 *
 * It is a pass over the history rather than a decision per bubble because the pane
 * re-renders on every frame of a live run and on every scroll that mounts a row,
 * while a mark only changes when the messages do — the reason `trackerProjects` is
 * computed there too. Formatting a date is the expensive half, and it happens here
 * only for the few messages that really open a block.
 */
export function messageTimeMarks(
  runs: readonly (readonly Timed[])[],
  now: number = Date.now(),
): Map<string, string> {
  const marks = new Map<string, string>();
  for (const run of runs) {
    for (let i = 1; i < run.length; i++) {
      const mark = messageTimeMark(run[i], run[i - 1], now);
      if (mark) marks.set(run[i]!.id, mark);
    }
  }
  return marks;
}

/** The mark this message earns above it, or `null` when the message before it
 *  already answered "when". `previous` is the message drawn immediately above —
 *  which inside a channel thread is the previous reply, not the previous row of
 *  the flat history. */
export function messageTimeMark(
  message: Pick<ChatMessage, "compose_time"> | undefined,
  previous: Pick<ChatMessage, "compose_time"> | undefined,
  now: number = Date.now(),
): string | null {
  if (!message || !previous) return null;
  const at = new Date(message.compose_time);
  const before = new Date(previous.compose_time);
  // A row stored without a usable time says nothing about when it was sent, and a
  // mark computed from it would be a claim this app cannot make.
  if (!isRealDate(at) || !isRealDate(before)) return null;
  const opensABlock =
    at.toDateString() !== before.toDateString() ||
    message.compose_time - previous.compose_time >= TIME_MARK_GAP_MS;
  return opensABlock ? formatMessageTime(message.compose_time, now) : null;
}

/**
 * The mark's own words: always a time, and only as much date as the reader needs to
 * place it — nothing for today, "Yesterday" for yesterday, the weekday inside the
 * last week, then the date itself. The viewer's own locale and zone format all of
 * it; the wire carries epoch ms.
 */
export function formatMessageTime(ms: number, now: number = Date.now()): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(now);
  // Stepped by calendar day rather than by 24 hours: a day is 23 or 25 hours long
  // twice a year, and "Yesterday" must not go missing on those two.
  yesterday.setDate(yesterday.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  if (now - ms > 0 && now - ms < WEEK_MS) {
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  const sameYear = at.getFullYear() === today.getFullYear();
  const day = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

function isRealDate(d: Date): boolean {
  return d.getTime() > 0 && !Number.isNaN(d.getTime());
}
