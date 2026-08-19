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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
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
 * **"Custom time" is a ROW that opens a DIALOG, and that is not decoration.** The native
 * picker used to sit inline in this menu, and it could not be used at all: pressing it opens
 * the browser's OWN calendar, which is not in the document — so Radix read the press as an
 * interaction outside the popover and dismissed the menu, taking the half-filled field with
 * it. A dialog is dismissed by a press it can really see, and by Escape; the picker inside it
 * survives. It is also the shape the reference has, where the row opens a small window.
 *
 * The picker is the NATIVE one either way, bounded by `min`/`max` so the browser's own
 * calendar cannot offer a moment the backend would refuse; `scheduleRefusal` mirrors
 * `teams_send::parse_scheduled_time` for a value typed straight in.
 */
export function ScheduleSendMenu(props: {
  /** Whether there is anything to schedule. The Send button's own answer. */
  canSend: boolean;
  /** Queue the composer's current snapshot for `at` (epoch ms). */
  onSchedule: (at: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // The custom-time dialog is a sibling of the popover, never a child: rendered inside it, it
  // would be unmounted the moment the menu closed to make room for it.
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const presets = schedulePresets(now);

  /** An hour ahead, on the minute: legal, and nobody's real answer — so the reader edits it
   *  rather than pressing past it. */
  const seedCustom = () => {
    const seed = new Date(Date.now() + 60 * 60 * 1000);
    seed.setSeconds(0, 0);
    setCustom(datetimeLocalValue(seed));
    setError(null);
  };

  const schedule = (at: number) => {
    const refusal = scheduleRefusal(at, Date.now());
    if (refusal) {
      setError(refusal);
      return;
    }
    setError(null);
    props.onSchedule(at);
    // Whether it left is reported at the composer — the banner above it, or the failure
    // sentence beside the words — so both surfaces close rather than holding a second copy.
    setOpen(false);
    setCustomOpen(false);
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setError(null);
        }}
      >
        <PopoverTrigger asChild>
          {/* The two halves are the SAME width, and the rule between them is INSET rather than
            an edge: a 24px chevron whose border ran the full height of a 32px Send put the two
            glyphs 28px apart with nothing but a hairline between them, so a press aimed at one
            landed on the other. Slack's own shape — equal halves, a short rule standing in
            whitespace — and the target grows with the gap rather than instead of it. */}
          <button
            type="button"
            aria-label="Send later"
            title="Send later"
            data-testid="composer-schedule"
            data-cuelume-press=""
            disabled={!props.canSend}
            className="relative grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-r-full bg-primary text-primary-foreground transition-all before:absolute before:left-0 before:h-4 before:w-px before:bg-primary-foreground/25 hover:brightness-110 active:brightness-95 disabled:cursor-default disabled:bg-element disabled:text-text-faint disabled:before:bg-border-subtle"
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
              className="flex min-h-11 w-full items-center truncate rounded-md px-2 text-left text-sm transition-colors hover:bg-accent"
            >
              {presetRowLabel(preset, now)}
            </button>
          ))}
          <div className="my-1.5 border-t border-border-subtle" />
          <button
            type="button"
            data-testid="composer-schedule-custom-open"
            onClick={() => {
              seedCustom();
              setOpen(false);
              setCustomOpen(true);
            }}
            className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm transition-colors hover:bg-accent"
          >
            Custom time
          </button>
          <p className="px-2 pt-2 text-xs text-text-faint">{SCHEDULE_HINT}</p>
        </PopoverContent>
      </Popover>

      {/* Any other moment. A DIALOG rather than a field in the menu above, because the
        browser's own calendar is not in the document: a press on it read as a press outside
        the popover, which dismissed the menu and the half-filled field with it. */}
      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="max-w-sm" data-testid="composer-schedule-custom-dialog">
          <DialogHeader>
            <DialogTitle>Send at a custom time</DialogTitle>
            <DialogDescription>{SCHEDULE_HINT}</DialogDescription>
          </DialogHeader>
          <label htmlFor="composer-schedule-custom" className="text-sm text-text-dim">
            Date and time
          </label>
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
            className="min-h-11 w-full rounded-md bg-element px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {error && (
            <div
              role="alert"
              data-testid="composer-schedule-error"
              className="text-xs text-destructive"
            >
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="composer-schedule-custom-cancel"
              onClick={() => setCustomOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="composer-schedule-confirm"
              onClick={() => schedule(parseDatetimeLocal(custom))}
            >
              Schedule
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
