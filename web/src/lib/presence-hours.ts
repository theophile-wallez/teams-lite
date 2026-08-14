import type { AppSettings, AvailableHours } from "./protocol";

/**
 * The pure half of the "Always available" HOURS (see `SETTING_AVAILABLE_HOURS` in
 * src/bin/server.rs): what a pair of hours means, what the slider does with them, and what
 * the pane says about the status they buy.
 *
 * Whether the user is green right now is decided by the BACKEND — it holds the clock and the
 * zone the heartbeat acts on, and `available_now` is its answer. Nothing here re-derives it:
 * this module turns a window into two controls and one sentence.
 */

/** Minutes in a day, which is the slider's own range. */
export const MINUTES_PER_DAY = 24 * 60;

/** The slider's step. A quarter of an hour is what a work window is really set to, and 96
 *  stops across a phone's width is a target a thumb can land on; a per-minute slider is 1440
 *  stops nobody can aim at, and the time fields beside it are there for the exact minute. */
export const HOURS_STEP_MINUTES = 15;

/** `"08:00"` -> minutes since midnight, or null when it is not an hour (mirrors
 *  `parse_hhmm` in src/teams_presence.rs, which is what decides whether it can be stored). */
export function minutesFromHhmm(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Minutes since midnight -> `"08:00"`, the spelling the wire and an `<input type="time">`
 *  both take. */
export function hhmmFromMinutes(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

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

/**
 * Where a window's two ends sit on the slider, and whether it CROSSES MIDNIGHT.
 *
 * The two thumbs are always ordered, because a slider's thumbs cannot pass each other — so a
 * night shift (22:00-06:00) is the same two positions with the fill on the OUTSIDE, which is
 * what `wrapped` tells the caller to draw. Reading it the other way round — refusing to draw
 * a wrapped window — would leave the reader with a slider that does not show their own hours.
 *
 * `null` for anything that is not a pair of hours: the slider then has nothing to stand for
 * and the pane draws its default span instead.
 */
export function hoursSlider(
  hours: AvailableHours | null,
): { values: [number, number]; wrapped: boolean } | null {
  if (!hours) return null;
  const from = minutesFromHhmm(hours.from);
  const to = minutesFromHhmm(hours.to);
  if (from === null || to === null || from === to) return null;
  const wrapped = from > to;
  return { values: wrapped ? [to, from] : [from, to], wrapped };
}

/**
 * The window two thumb positions stand for, keeping the mode they were drawn in.
 *
 * Dragging a night shift keeps it a night shift: the thumbs are ordered, so only `wrapped`
 * says which of the two is the START. Without it, one drag would silently turn 22:00-06:00
 * into 06:00-22:00 — the same two numbers meaning the opposite half of the day.
 */
export function hoursFromSlider(values: number[], wrapped: boolean): AvailableHours {
  const [low = 0, high = MINUTES_PER_DAY] = [...values].sort((a, b) => a - b);
  return wrapped
    ? { from: hhmmFromMinutes(high), to: hhmmFromMinutes(low) }
    : { from: hhmmFromMinutes(low), to: hhmmFromMinutes(high) };
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

/**
 * The zone the window is kept in, as the pane names it: the stored one, or this MACHINE's
 * own — which is what an install that never set one keeps, and the only honest label for it,
 * since the backend never tells the page which zone that is.
 */
export const MACHINE_ZONE_LABEL = "This machine's zone";

/** The zone the pane offers to switch to, when the reader is somewhere else.
 *
 *  It comes from the BROWSER (`Intl`), which is where the reader is — the point of the whole
 *  setting is that the person travels and the machine does not. `null` when it is already the
 *  stored one, because a control that changes nothing reads as a bug. */
export function suggestedZone(stored: string | null, browserZone: string | null): string | null {
  if (!browserZone || browserZone === stored) return null;
  return browserZone;
}

/** Every zone this browser can name, for the picker — `Intl.supportedValuesOf` where it
 *  exists, and otherwise just the names the pane already has to be able to draw.
 *
 *  Read from the browser rather than published by the backend: it is 400-odd names that would
 *  otherwise ride on every settings answer, and the browser holds the same IANA database the
 *  backend validates against. */
export function zoneOptions(stored: string | null, browserZone: string | null): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const names = new Set<string>(supported.length > 0 ? supported : []);
  for (const name of [stored, browserZone]) if (name) names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b));
}
