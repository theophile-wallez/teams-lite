// Presenting a person's Teams presence: what to call it, and how to colour it.
//
// The backend passes Teams' own `availability` / `activity` strings through
// verbatim (see src/teams_presence.rs) because Teams keeps adding activities. So
// everything here degrades gracefully: an activity we don't know falls back to the
// availability's label and tone, and an availability we don't know is humanized
// ("InSomeNewState" -> "In some new state") in the neutral tone — never blank.
//
// Pure (no DOM, no network): the same helpers back the badge, the card and the
// unit tests.

import type { PersonPresence } from "./protocol";

/** The visual families Teams colours presence by. `oof` is its distinct
 *  out-of-office badge; `unknown` covers both "still loading" and "the service has
 *  no answer". */
export type PresenceTone = "available" | "busy" | "away" | "offline" | "oof" | "unknown";

/** Availability -> tone, in Teams' own vocabulary: Available/AvailableIdle are
 *  green, Busy/BusyIdle/DoNotDisturb red, Away/BeRightBack amber, Offline/OffWork
 *  grey. */
const TONES: Record<string, PresenceTone> = {
  Available: "available",
  AvailableIdle: "available",
  Busy: "busy",
  BusyIdle: "busy",
  DoNotDisturb: "busy",
  Away: "away",
  BeRightBack: "away",
  Offline: "offline",
  OffWork: "offline",
  OutOfOffice: "oof",
  PresenceUnknown: "unknown",
};

/** Activity -> the label Teams shows, when it says more than the availability
 *  does ("In a meeting" rather than just "Busy"). */
const ACTIVITY_LABELS: Record<string, string> = {
  Available: "Available",
  Away: "Away",
  BeRightBack: "Be right back",
  Busy: "Busy",
  DoNotDisturb: "Do not disturb",
  InACall: "In a call",
  InAConferenceCall: "In a conference call",
  InAMeeting: "In a meeting",
  Presenting: "Presenting",
  OffWork: "Off work",
  OutOfOffice: "Out of office",
  Offline: "Offline",
  OnThePhone: "On the phone",
  UrgentInterruptionsOnly: "Urgent interruptions only",
  Focusing: "Focusing",
  Inactive: "Away",
};

/** Availability -> its own label, used when the activity adds nothing. */
const AVAILABILITY_LABELS: Record<string, string> = {
  Available: "Available",
  AvailableIdle: "Available",
  Away: "Away",
  BeRightBack: "Be right back",
  Busy: "Busy",
  BusyIdle: "Busy",
  DoNotDisturb: "Do not disturb",
  Offline: "Offline",
  OffWork: "Off work",
  OutOfOffice: "Out of office",
  PresenceUnknown: "Unknown",
};

/** The colour family for a presence — what the badge is tinted with. Someone whose
 *  calendar has them out of office gets Teams' out-of-office badge, but only while
 *  they are not actively in something: "in a meeting" still reads as busy. */
export function presenceTone(presence: PersonPresence | null | undefined): PresenceTone {
  if (!presence) return "unknown";
  const tone = TONES[presence.availability] ?? "unknown";
  if (presence.out_of_office && (tone === "offline" || tone === "unknown")) return "oof";
  return tone;
}

/** The human label for a presence, preferring the finer activity ("In a meeting")
 *  over the coarse availability ("Busy"). Falls back to "Out of office" for someone
 *  whose calendar says so while Teams reports nothing more useful, and to
 *  "Unknown" when we know nothing at all. */
export function presenceLabel(presence: PersonPresence | null | undefined): string {
  if (!presence) return "Unknown";
  const { availability, activity } = presence;
  const fromActivity =
    activity && activity !== availability
      ? (ACTIVITY_LABELS[activity] ?? humanizeCamel(activity))
      : undefined;
  const fromAvailability = availability
    ? (AVAILABILITY_LABELS[availability] ?? humanizeCamel(availability))
    : undefined;
  const label = fromActivity ?? fromAvailability ?? ACTIVITY_LABELS[activity];

  if (!label || label === "Unknown" || label === "Presence unknown") {
    return presence.out_of_office ? "Out of office" : "Unknown";
  }
  // Teams shows out-of-office instead of the state only when that state carries
  // less information (offline / off work); otherwise the live state wins.
  if (presence.out_of_office && (label === "Offline" || label === "Off work")) {
    return "Out of office";
  }
  return label;
}

/** True when we have nothing meaningful to show for this presence (still loading,
 *  or a person the service does not know). */
export function presenceIsUnknown(presence: PersonPresence | null | undefined): boolean {
  return presenceTone(presence) === "unknown";
}

/** "Last seen 20 min ago" / "Last seen yesterday" for someone who is away, or null
 *  when there is nothing worth saying (no timestamp, they are reachable, or it was
 *  so long ago the figure is just noise). `now` is injectable so this stays pure. */
export function lastSeenLabel(
  presence: PersonPresence | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!presence?.last_active_ms) return null;
  const tone = presenceTone(presence);
  if (tone !== "offline" && tone !== "oof") return null;
  const elapsed = now - presence.last_active_ms;
  if (elapsed < 0) return null;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 2) return "Last seen just now";
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Last seen yesterday";
  if (days < 7) return `Last seen ${days} days ago`;
  return null;
}

/** Split a CamelCase Teams token into words ("InSomeNewState" -> "In some new
 *  state") so a state Teams adds tomorrow still reads like a label. */
function humanizeCamel(token: string): string {
  const words = token.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
