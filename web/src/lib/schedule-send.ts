// Scheduling a send: WHICH moments the composer offers, and how one is spelled.
//
// The whole delivery is Teams' own — the backend adds `properties.scheduledsendtime` to
// the one POST a send already makes and the service holds the message until then (see
// `teams_send::parse_scheduled_time`). So nothing here waits for anything, nothing is
// queued on this machine, and a scheduled message goes out with the app closed.
//
// This file is the pure half: the presets, the words for a moment, and the same bound the
// backend enforces. Everything in it is unit-tested.

/** The hour a "morning" preset means, in the reader's own timezone. */
export const SCHEDULE_MORNING_HOUR = 9;

/** The hour a "this evening" preset means. */
export const SCHEDULE_EVENING_HOUR = 18;

/**
 * The furthest ahead a message may be scheduled — 120 days, Slack's own ceiling and the
 * one `teams_send::MAX_SCHEDULE_AHEAD_MS` enforces.
 *
 * Both sides state it: the picker cannot offer a moment the backend would refuse, because
 * a control that collects a time and then reports a refusal is worse than one that never
 * offered it.
 */
export const MAX_SCHEDULE_AHEAD_MS = 120 * 24 * 60 * 60 * 1000;

/** One row of the schedule menu: a moment, and how it reads. */
export type SchedulePreset = {
  /** Stable across renders, so React keys and test selectors do not move. */
  key: string;
  label: string;
  /** Epoch milliseconds — what travels to the backend. */
  at: number;
};

/** `date` at `hour` o'clock sharp, in the reader's own timezone. */
function atHour(date: Date, hour: number): Date {
  const out = new Date(date);
  out.setHours(hour, 0, 0, 0);
  return out;
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

/** Days from `date` to the next Monday. Never 0: "Monday" said on a Monday means the next
 *  one, which is what a reader deferring work to the start of a week means by it. */
function daysToNextMonday(date: Date): number {
  const monday = 1;
  return (monday - date.getDay() + 7) % 7 || 7;
}

/**
 * The moments the menu offers, soonest first — Slack's own set: this evening, tomorrow
 * morning, Monday morning.
 *
 * Two rules, and both are what keep the menu honest rather than tidy:
 *  - a preset already in the PAST is dropped, not shifted. "This evening" at 20:00 is a
 *    moment that has gone, and the backend would refuse it.
 *  - a preset that lands on the same moment as another is dropped, because two rows that
 *    do one thing ask the reader to compare them to learn nothing (a Sunday's "tomorrow
 *    morning" IS Monday morning).
 */
export function schedulePresets(now: Date): SchedulePreset[] {
  const candidates: SchedulePreset[] = [
    {
      key: "evening",
      label: "This evening",
      at: atHour(now, SCHEDULE_EVENING_HOUR).getTime(),
    },
    {
      key: "tomorrow",
      label: "Tomorrow morning",
      at: atHour(addDays(now, 1), SCHEDULE_MORNING_HOUR).getTime(),
    },
    {
      key: "monday",
      label: "Monday morning",
      at: atHour(addDays(now, daysToNextMonday(now)), SCHEDULE_MORNING_HOUR).getTime(),
    },
  ];
  const seen = new Set<number>();
  return candidates.filter((preset) => {
    if (preset.at <= now.getTime() || seen.has(preset.at)) return false;
    seen.add(preset.at);
    return true;
  });
}

/**
 * How a scheduled moment reads: the day named the way a person would, then the time.
 *
 * "Today" / "Tomorrow" rather than a date, because those are the two the reader is
 * choosing between most of the time, and a bare date makes them count days.
 */
export function scheduleLabel(at: number, now: Date = new Date()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const midnight = atHour(now, 0).getTime();
  const days = Math.floor((atHour(when, 0).getTime() - midnight) / (24 * 60 * 60 * 1000));
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) {
    return `${when.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  }
  return `${when.toLocaleDateString(undefined, { day: "numeric", month: "long" })} at ${time}`;
}

/**
 * Why this moment cannot be scheduled, or null when it can — the same two bounds
 * `teams_send::parse_scheduled_time` enforces, stated before the send rather than by it.
 */
export function scheduleRefusal(at: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(at)) return "Pick a date and a time.";
  if (at <= now) return "That moment has already passed.";
  if (at - now > MAX_SCHEDULE_AHEAD_MS) return "A message can be scheduled at most 120 days ahead.";
  return null;
}

/**
 * What the banner above the composer says about what is queued for THIS conversation, or
 * null when nothing is.
 *
 * It is DERIVED from the queue rather than set by the send that made one, and that is the
 * whole of why it is right: a message is in no thread, so this line and the list it links to
 * are the only things on screen accounting for the words — and a line set by an event went
 * stale the moment the message was cancelled from the list, and was missing altogether when
 * the app was simply reopened with something already waiting.
 *
 * `moments` are the scheduled times queued in the open conversation, in any order.
 */
export function scheduledBanner(moments: number[], now: Date = new Date()): string | null {
  const next = moments.filter((at) => Number.isFinite(at)).sort((a, b) => a - b)[0];
  if (next === undefined) return null;
  if (moments.length === 1) return scheduledBannerLabel(next, now);
  // The COUNT first, then the soonest: with several queued, "how many" is the fact the
  // reader is missing, and the next moment is what tells them whether to hurry.
  return `${moments.length} messages scheduled — the next ${scheduleLabel(next, now)}.`;
}

/**
 * What a scheduled send really costs, said on the control BEFORE it is pressed — the rule
 * `RECORD_HINT` follows for a recording.
 *
 * Teams holds the message and nobody in the conversation sees it until it goes out; it can
 * be cancelled or taken back into the composer from the list until then, which is the half
 * a reader needs before they trust a queue at all.
 */
export const SCHEDULE_HINT =
  "Nobody sees it until then. Cancel or edit it from the scheduled list.";

/**
 * What ONE row of the schedule menu reads: the moment itself, capitalised — "Tomorrow at
 * 09:00", "Monday at 09:00".
 *
 * One label rather than a name beside a time. The row used to carry both ("Tomorrow
 * morning" and "tomorrow at 09:00 AM"), which is the same fact stated twice and wide enough
 * to wrap the row onto two lines; Slack's own menu names the moment and stops.
 */
export function presetRowLabel(preset: SchedulePreset, now: Date = new Date()): string {
  const when = scheduleLabel(preset.at, now);
  return when.charAt(0).toUpperCase() + when.slice(1);
}

/** How a queued message's own row states when it goes — Slack's "Send tomorrow at 9:00". */
export function scheduledRowLabel(at: number, now: Date = new Date()): string {
  return `Send ${scheduleLabel(at, now)}`;
}

/** What the banner above the composer says once a message is queued: the same sentence the
 *  note carried, which is the one thing on screen accounting for words that left the box. */
export function scheduledBannerLabel(at: number, now: Date = new Date()): string {
  return `Your message will be sent ${scheduleLabel(at, now)}.`;
}

/** The value a native `<input type="datetime-local">` wants: local time, minute
 *  precision, no timezone. Built by hand because `toISOString` is UTC, which would offer
 *  the reader a moment several hours from the one they picked. */
export function datetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Read one back. `new Date(value)` on a datetime-local string is local time in every
 *  browser that matters, which is what the picker meant. NaN for anything unparseable —
 *  the field can be empty, or half typed. */
export function parseDatetimeLocal(value: string): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}
