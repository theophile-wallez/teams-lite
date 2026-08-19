import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import {
  MAX_SCHEDULE_AHEAD_MS,
  presetRowLabel,
  SCHEDULE_HINT,
  datetimeLocalValue,
  parseDatetimeLocal,
  scheduleRefusal,
  schedulePresets,
} from "~/lib/schedule-send";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * "Send later" — the chevron ATTACHED to the Send button, and the short menu it opens.
 *
 * Slack's own shape, and the attachment is the point: the two controls answer one question
 * — now, or then — so they are one pill split in two rather than two buttons the reader has
 * to tell apart. The chevron carries no glyph of its own meaning, which is why it is a
 * chevron and not a clock: what it does is disclose the choice beside Send.
 *
 * The menu is a header, the moments, a rule, and a custom time (`schedulePresets` decides
 * which moments, and drops one that has passed or that duplicates another). A press SENDS —
 * it is not "set a time, then press Send" — and where the words went is then said by the
 * banner above the composer, because a scheduled message appears in no thread.
 *
 * The custom time is the NATIVE picker, bounded by `min`/`max` so the browser's own calendar
 * cannot offer a moment the backend would refuse; `scheduleRefusal` mirrors
 * `teams_send::parse_scheduled_time` for a value typed straight in.
 */
export function ScheduleSendMenu(props: {
  /** Whether there is anything to schedule. The Send button's own answer. */
  canSend: boolean;
  /** Queue the composer's current snapshot for `at` (epoch ms). */
  onSchedule: (at: number) => void;
}) {
  const [open, setOpen] = useState(false);
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
    // Whether it left is reported at the composer — the banner above it, or the failure
    // sentence beside the words — so the menu closes rather than holding a second copy.
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // An hour ahead, on the minute: legal, and nobody's real answer — so the reader
          // edits it rather than pressing past it.
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
          className="grid h-8 w-6 shrink-0 cursor-pointer place-items-center rounded-r-full border-l border-primary-foreground/25 bg-primary text-primary-foreground transition-all hover:brightness-110 active:brightness-95 disabled:cursor-default disabled:border-border-subtle disabled:bg-element disabled:text-text-faint"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5" strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2" data-testid="composer-schedule-menu">
        <div className="px-2 pb-1 pt-1 text-xs font-semibold text-text-dim">Schedule message</div>
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            data-testid="composer-schedule-preset"
            data-schedule-key={preset.key}
            data-schedule-at={preset.at}
            onClick={() => schedule(preset.at)}
            className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
          >
            {presetRowLabel(preset, now)}
          </button>
        ))}
        <div className="my-1.5 border-t border-border-subtle" />
        <label
          htmlFor="composer-schedule-custom"
          className="block px-2 pb-1 text-sm text-foreground"
        >
          Custom time
        </label>
        <div className="flex items-center gap-2 px-2">
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
        {error && (
          <div
            role="alert"
            data-testid="composer-schedule-error"
            className="px-2 pt-2 text-xs text-destructive"
          >
            {error}
          </div>
        )}
        <p className="px-2 pt-2 text-xs text-text-faint">{SCHEDULE_HINT}</p>
      </PopoverContent>
    </Popover>
  );
}
