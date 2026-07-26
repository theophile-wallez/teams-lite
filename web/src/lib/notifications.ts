// Pure presentation helpers for the activity feed (the notifications panel).
//
// The backend passes Teams' raw activity fields through untouched; all phrasing
// and time formatting lives here so it is testable without a DOM and stays out of
// the wire protocol. Reaction keys are resolved to emoji by teams-emoji.ts, the
// single place that knows Microsoft's reaction catalog. Nothing here touches the
// DOM or network.

import { reactionEmoji } from "./teams-emoji";
import type { Notification } from "./protocol";

/** Whether this activity is a reaction (drives the leading reaction glyph). */
export function isReaction(n: Notification): boolean {
  return n.activity_type.toLowerCase().includes("reaction");
}

/** The reaction emoji shown as the row's leading glyph, or null when the
 *  activity isn't a reaction (the actor's avatar leads instead). */
export function leadingEmoji(n: Notification): string | null {
  return isReaction(n) ? reactionEmoji(n.activity_subtype) : null;
}

/** Actor display name, with a safe fallback when Teams omitted it. */
export function actorLabel(n: Notification): string {
  return n.actor_name.trim() || "Someone";
}

/** A short human phrase for what happened, e.g. "reacted with 😂",
 *  "mentioned you", "replied to you". The Following feed (activity in threads we
 *  follow, `activityType: "threads"`) is phrased "replied" — it is a reply in a
 *  thread, not directed at us, so it never claims "…to you". */
export function activityVerb(n: Notification): string {
  const type = n.activity_type.toLowerCase();
  if (type.includes("reaction")) return `reacted with ${reactionEmoji(n.activity_subtype)}`;
  if (type.includes("mention")) return "mentioned you";
  if (type.includes("reply")) return "replied to you";
  if (type.includes("thread")) return "replied";
  return "sent you an activity";
}

/** The source conversation's title (e.g. "[Run] Engine merge requests"), shown
 *  as context in the Mentions/Following tabs; "" when Teams omitted it. */
export function sourceContext(n: Notification): string {
  return n.source_thread_topic.trim();
}

/** The full headline for a notification row: "Clément DELBARRE reacted with 😂". */
export function notificationHeadline(n: Notification): string {
  return `${actorLabel(n)} ${activityVerb(n)}`;
}

/** Compact relative time: "now", "5m", "3h", "2d", then a short date. */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (!ts) return "";
  const diffMs = Math.max(0, now - ts);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
