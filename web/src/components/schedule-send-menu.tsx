import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import {
  MAX_SCHEDULE_AHEAD_MS,
  SCHEDULE_HINT,
  datetimeLocalValue,
  parseDatetimeLocal,
  scheduleLabel,
  scheduleRefusal,
  schedulePresets,
} from "~/lib/schedule-send";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * "Send later", the way Slack offers it: a control beside Send that opens a short list of
 * moments plus a picker for any other one.
 *
 * It reaches the same `send` as the button next to it — one POST, with the moment in it,
 * and Teams holds the message until then (see `web/src/lib/schedule-send.ts` and
 * `teams_send::parse_scheduled_time`). So there is no gate of its own to add and no queue
 * on this machine: `send` is already an `OUTWARD_METHODS` entry, and the consent is this
 * press on a moment the reader picked.
 *
 * Four things about the surface, and each is pinned by a test:
 *
 * - **A press SENDS.** It is not a two-step "set a time, then press Send": picking a
 *   moment is the whole action, exactly as pressing Send is, and the composer then says
 *   where the words went — because they leave the box and the message is NOT in the thread
 *   yet, so that line is the only thing on screen that accounts for them.
 * - **The custom time is the NATIVE picker** (`<input type="datetime-local">`), bounded by
 *   `min` and `max` so the browser's own calendar cannot even offer a moment the backend
 *   would refuse. A date-picker component would be a second calendar in an app that needs
 *   none — and this one works with a phone's own wheel, which is where this app is read.
 * - **The bound is stated on BOTH sides.** `scheduleRefusal` mirrors
 *   `teams_send::parse_scheduled_time`, so a moment that has passed while the menu was
 *   open is refused here rather than by a round trip.
 * - **What this app cannot do is said before the press** (`SCHEDULE_HINT`): Teams holds the
 *   message and teams-lite lists nothing that is held, so cancelling is done over there.
 *   The rule `RECORD_HINT` follows — a control that hides its one limitation is worse than
 *   one that names it.
 */
export function ScheduleSendMenu(props: {
  /** Whether there is anything to schedule. Same answer as the Send button's own. */
  canSend: boolean;
  /** Queue the composer's current snapshot for `at` (epoch ms). */
  onSchedule: (at: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // The moment the picker holds. Seeded when the menu opens, so it is always a legal one.
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const presets = schedulePresets(now);

  const schedule = (at: number) => {
    const refusal = scheduleRefusal(at, Date.now());
    if (refusal) {
      setError(refusal);
      return;
    }
    setError(null);
    props.onSchedule(at);
    // Whether it left is reported at the COMPOSER, beside the words that are still in the
    // box — the rule § Sending messages states for a send — so the menu closes rather
    // than holding a second copy of that sentence.
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // An hour ahead, on the minute: a legal default that is nobody's real answer,
          // so the reader edits it rather than pressing past it.
          const seed = new Date(now.getTime() + 60 * 60 * 1000);
          seed.setSeconds(0, 0);
          setCustom(datetimeLocalValue(seed));
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Send later"
          title="Send later"
          data-testid="composer-schedule"
          data-cuelume-press=""
          disabled={!props.canSend}
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
        >
          <HugeiconsIcon icon={Clock01Icon} className="size-4" strokeWidth={1.6} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-2"
        data-testid="composer-schedule-menu"
        // The picker is a form field, so the menu must not take the keyboard from it.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-1 pb-1.5 text-xs font-semibold text-text-dim">Send later</div>
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            data-testid="composer-schedule-preset"
            data-schedule-key={preset.key}
            data-schedule-at={preset.at}
            onClick={() => schedule(preset.at)}
            className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
          >
            <span>{preset.label}</span>
            <span className="shrink-0 text-xs text-text-faint">
              {scheduleLabel(preset.at, now)}
            </span>
          </button>
        ))}
        <div className="mt-1.5 border-t border-border-subtle pt-2">
          <label
            htmlFor="composer-schedule-custom"
            className="block px-1 pb-1 text-xs font-semibold text-text-dim"
          >
            Custom time
          </label>
          <div className="flex items-center gap-2 px-1">
            <input
              id="composer-schedule-custom"
              data-testid="composer-schedule-custom"
              type="datetime-local"
              value={custom}
              min={datetimeLocalValue(now)}
              max={datetimeLocalValue(new Date(now.getTime() + MAX_SCHEDULE_AHEAD_MS))}
              onChange={(event) => {
                setCustom(event.target.value);
                setError(null);
              }}
              className="min-w-0 flex-1 rounded-md bg-element px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              data-testid="composer-schedule-confirm"
              onClick={() => schedule(parseDatetimeLocal(custom))}
            >
              Schedule
            </Button>
          </div>
        </div>
        {error && (
          <div
            role="alert"
            data-testid="composer-schedule-error"
            className="px-1 pt-2 text-xs text-destructive"
          >
            {error}
          </div>
        )}
        <p className="px-1 pt-2 text-xs text-text-faint">{SCHEDULE_HINT}</p>
      </PopoverContent>
    </Popover>
  );
}
