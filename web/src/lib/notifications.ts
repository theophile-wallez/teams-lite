// Pure presentation helpers for the activity feed (the notifications panel).
//
// The backend passes Teams' raw activity fields through untouched; all phrasing,
// emoji mapping, and time formatting lives here so it is testable without a DOM
// and stays out of the wire protocol. Nothing here touches the DOM or network.

import type { Notification } from "./protocol";

/** Teams reaction subtype -> emoji. Unknown subtypes fall back to a neutral
 *  reaction glyph so a newly-added Teams reaction never renders blank. */
const REACTION_EMOJI: Record<string, string> = {
  like: "👍",
  heart: "❤️",
  laugh: "😂",
  surprised: "😮",
  sad: "😢",
  angry: "😡",
  handshake: "🤝",
  confused: "😕",
};

export function reactionEmoji(subtype: string): string {
  return REACTION_EMOJI[subtype.toLowerCase()] ?? "👍";
}

/** The emojis offered in the hover reaction picker, in Teams' canonical order.
 *  A subset of `REACTION_EMOJI` (the six classic reactions) so it stays DRY and
 *  consistent with inbound reactions; a received reaction outside this set still
 *  renders as a chip via `reactionEmoji()`. */
export const REACTION_PICKER: ReadonlyArray<{ key: string; emoji: string }> = [
  "like",
  "heart",
  "laugh",
  "surprised",
  "sad",
  "angry",
].map((key) => ({ key, emoji: REACTION_EMOJI[key]! }));

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
 *  "mentioned you", "replied to you". */
export function activityVerb(n: Notification): string {
  const type = n.activity_type.toLowerCase();
  if (type.includes("reaction")) return `reacted with ${reactionEmoji(n.activity_subtype)}`;
  if (type.includes("mention")) return "mentioned you";
  if (type.includes("reply")) return "replied to you";
  return "sent you an activity";
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
