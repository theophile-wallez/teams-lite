import type { AppSettings, AvailableHours } from "./protocol";

/**
 * The pure half of the "Always available" HOURS (see `SETTING_AVAILABLE_HOURS` in
 * src/bin/server.rs): what a pair of `<input type="time">` fields means, and what the
 * pane says about the status they buy.
 *
 * The window itself is decided by the BACKEND — it holds the clock and the zone the
 * heartbeat acts on, and `available_now` is its answer. Nothing here re-derives it: this
 * module turns two fields into one call, and one answer into one sentence.
 */

/** What the two fields currently amount to.
 *
 *  `incomplete` is a real state and not an error: a reader who has typed one end has not
 *  yet said anything the backend could store, and a half window has two readings (all day
 *  from 8, or 8 until whenever), which is why the backend refuses one. */
export type HoursDraft =
  | { kind: "hours"; hours: AvailableHours }
  | { kind: "all-day" }
  | { kind: "incomplete" };

/** Read the two fields. Whitespace is not an hour, and neither is one end on its own. */
export function hoursDraft(from: string, to: string): HoursDraft {
  const start = from.trim();
  const end = to.trim();
  if (start && end) return { kind: "hours", hours: { from: start, to: end } };
  if (!start && !end) return { kind: "all-day" };
  return { kind: "incomplete" };
}

/** The window as the pane spells it, with an en dash: `08:00 – 19:00`. */
export function hoursLabel(hours: AvailableHours): string {
  return `${hours.from} – ${hours.to}`;
}

/**
 * What the pane says under the switch — the one line that tells the user what every
 * colleague can see right now.
 *
 * The four states are four different facts, and the last two are the whole point of the
 * hours: inside them the status is green and says when it stops, outside them Teams is
 * deciding again and the line says when this app takes over. `available_now` is the
 * backend's own answer, so a machine in another time zone is described correctly rather
 * than by this browser's clock.
 */
export function availabilityLine(settings: AppSettings): string {
  if (!settings.always_available) {
    return "Off — Teams decides your status, as it does without this app";
  }
  const from = settings.available_from;
  const to = settings.available_to;
  if (!from || !to) {
    return "On, all day — green while teams-lite runs, even with every window closed";
  }
  return settings.available_now
    ? `On — green until ${to}, then Teams decides your status again`
    : `On — nothing published until ${from}, so Teams decides your status until then`;
}
