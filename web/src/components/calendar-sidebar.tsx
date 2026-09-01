import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
} from "@hugeicons/core-free-icons";
import {
  WEEK_STARTS_ON,
  addDays,
  addMonths,
  dayKey,
  daysIn,
  eventTouchesDay,
  formatAgendaDay,
  isPast,
  isSameDay,
  isSameMonth,
  isWeekend,
  isoWeekNumber,
  monthGridDays,
  startOfDay,
  startOfMonth,
  visibleRange,
  weekdayLabels,
  weeksOf,
  withoutDeclined,
} from "~/lib/calendar";
import { calendarColor, calendarLabel, type CalendarEvent, type CalendarInfo } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { EventItem, useCalendarColors } from "./calendar-event";
import { useAppState, useController } from "./controller-context";
import { FadeArc } from "./loading-ui/fade-arc";

// The Calendar tab's sidebar: the mini month for jumping around, the calendar list
// with its colour swatches, and what is still to come.
//
// This is the reference design's left rail (github.com/vmnog/calendarcn), adapted to
// this app's 320px column instead of a full-width dashboard shell — the demo's shell
// and this app's shell are the same shape, so its sidebar becomes ours and its main
// section becomes the pane on the right.
//
// Two touches from that design are worth naming. The mini month HIGHLIGHTS THE DAYS
// THE MAIN VIEW IS SHOWING, so the rail says where you are rather than only where you
// clicked. And the calendar list toggles with an eye rather than a checkbox, because
// what it controls is visibility, not membership — Outlook's own wording.
//
// The calendar toggles are the one control here that costs anything: switching a
// calendar on may need a window the backend has not read for it yet, which is why the
// default is the primary calendar alone (a mailbox here carries six).

export function CalendarSidebar() {
  const controller = useController();
  const calendars = useAppState((s) => s.calendars);
  const visible = useAppState((s) => s.visibleCalendarIds);
  const allEvents = useAppState((s) => s.calendarEvents);
  const loading = useAppState((s) => s.calendarLoading);
  const error = useAppState((s) => s.calendarError);
  const anchorMs = useAppState((s) => s.calendarAnchorMs);
  const mode = useAppState((s) => s.calendarMode);
  const settings = useAppState((s) => s.calendarSettings);

  const anchor = useMemo(() => new Date(anchorMs), [anchorMs]);
  const events = useMemo(
    () => withoutDeclined(allEvents, settings.showDeclined),
    [allEvents, settings.showDeclined],
  );
  // The window the pane is showing, so the mini month can shade it.
  const inView = useMemo(() => {
    const keys = new Set<string>();
    for (const day of daysIn(visibleRange(mode, anchor, WEEK_STARTS_ON))) keys.add(dayKey(day));
    return keys;
  }, [mode, anchor]);

  if (error && calendars.length === 0) {
    return (
      <p
        data-testid="calendar-sidebar-error"
        className="px-4 py-6 text-center text-[13px] text-destructive"
      >
        {error}
      </p>
    );
  }

  if (calendars.length === 0) {
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-6 text-[13px] text-text-faint">
        <FadeArc className="size-3.5" />
        Loading calendars…
      </p>
    );
  }

  return (
    <div
      data-testid="calendar-sidebar"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3"
    >
      <MiniMonth
        anchor={anchor}
        events={events}
        inView={mode === "month" ? null : inView}
        showWeekNumbers={settings.showWeekNumbers}
        onPick={(day) => controller.setCalendarAnchor(day)}
      />

      <section className="flex flex-col gap-0.5">
        <h3 className="px-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
          Calendars
        </h3>
        {calendars.map((calendar) => (
          <CalendarToggle
            key={calendar.id}
            calendar={calendar}
            checked={visible.includes(calendar.id)}
            onToggle={() => controller.toggleCalendarVisible(calendar.id)}
          />
        ))}
        {visible.length === 0 && (
          <p className="px-1.5 pt-1 text-[11px] text-text-faint">
            No calendar shown — pick at least one.
          </p>
        )}
      </section>

      <UpNext events={events} loading={loading} />
    </div>
  );
}

/** The mini month picker. Its own month, so browsing ahead in it does not move the main
 *  view until a day is actually clicked — the behaviour every calendar's date picker
 *  has. */
function MiniMonth(props: {
  anchor: Date;
  events: CalendarEvent[];
  /** Days the main view is showing, shaded as a block. Null in Month view, where the
   *  whole grid is "in view" and shading it would say nothing. */
  inView: Set<string> | null;
  showWeekNumbers: boolean;
  onPick: (day: Date) => void;
}) {
  const [offset, setOffset] = useState(0);
  // Reset to follow the main view whenever that moves to a different month.
  const anchorMonthKey = `${props.anchor.getFullYear()}-${props.anchor.getMonth()}`;
  const [trackedMonth, setTrackedMonth] = useState(anchorMonthKey);
  if (trackedMonth !== anchorMonthKey) {
    setTrackedMonth(anchorMonthKey);
    setOffset(0);
  }

  const month = useMemo(() => addMonths(startOfMonth(props.anchor), offset), [props.anchor, offset]);
  const weeks = useMemo(() => weeksOf(monthGridDays(month, WEEK_STARTS_ON)), [month]);
  const labels = useMemo(() => weekdayLabels(WEEK_STARTS_ON), []);
  const today = new Date();

  // Which days have anything on them, so the picker can show density dots.
  const busy = useMemo(() => {
    const keys = new Set<string>();
    for (const week of weeks) {
      for (const day of week) {
        if (props.events.some((event) => eventTouchesDay(event, day))) keys.add(dayKey(day));
      }
    }
    return keys;
  }, [weeks, props.events]);

  const columns = `${props.showWeekNumbers ? "18px " : ""}repeat(7, minmax(0, 1fr))`;

  return (
    <section data-testid="calendar-mini-month" className="flex flex-col gap-1.5 pt-1">
      <header className="flex items-center gap-1 px-1">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold capitalize text-foreground">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </h3>
        {offset !== 0 && (
          <button
            type="button"
            data-testid="calendar-mini-reset"
            onClick={() => setOffset(0)}
            className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-accent"
          >
            Back
          </button>
        )}
        <button
          type="button"
          aria-label="Previous month"
          data-testid="calendar-mini-prev"
          onClick={() => setOffset((o) => o - 1)}
          className="grid size-6 place-items-center rounded-md text-text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ChevronLeftIcon} className="size-3.5" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          data-testid="calendar-mini-next"
          onClick={() => setOffset((o) => o + 1)}
          className="grid size-6 place-items-center rounded-md text-text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ChevronRightIcon} className="size-3.5" strokeWidth={1.8} />
        </button>
      </header>

      <div className="grid gap-y-0.5" style={{ gridTemplateColumns: columns }}>
        {props.showWeekNumbers && <span aria-hidden />}
        {labels.map((label) => (
          <span
            key={label}
            className="truncate text-center text-[10px] font-medium uppercase text-text-faint"
          >
            {label.slice(0, 2)}
          </span>
        ))}
        {weeks.map((week) => (
          <MiniWeek
            key={dayKey(week[0]!)}
            days={week}
            month={month}
            today={today}
            anchor={props.anchor}
            inView={props.inView}
            busy={busy}
            showWeekNumbers={props.showWeekNumbers}
            onPick={props.onPick}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One week of the mini month.
 *
 * A fragment rather than a row element, so all six weeks share the section's single
 * grid — which is what lets the "in view" shading run continuously across a week
 * instead of stopping at a row boundary.
 */
function MiniWeek(props: {
  days: Date[];
  month: Date;
  today: Date;
  anchor: Date;
  inView: Set<string> | null;
  busy: Set<string>;
  showWeekNumbers: boolean;
  onPick: (day: Date) => void;
}) {
  return (
    <>
      {props.showWeekNumbers && (
        <span className="grid place-items-center text-[9px] tabular-nums text-text-faint">
          {isoWeekNumber(props.days[0]!)}
        </span>
      )}
      {props.days.map((day) => {
        const key = dayKey(day);
        const outside = !isSameMonth(day, props.month);
        const selected = isSameDay(day, props.anchor);
        const isToday = isSameDay(day, props.today);
        const shown = props.inView?.has(key) ?? false;
        // Round only where the shaded run actually begins and ends, so a week that
        // continues into the next row reads as one band.
        const opensRun = shown && !props.inView?.has(dayKey(addDays(day, -1)));
        const closesRun = shown && !props.inView?.has(dayKey(addDays(day, 1)));
        return (
          <button
            key={key}
            type="button"
            data-testid="calendar-mini-day"
            data-day={key}
            data-selected={selected ? "true" : undefined}
            data-in-view={shown ? "true" : undefined}
            onClick={() => props.onPick(day)}
            className={cn(
              "relative grid h-7 place-items-center text-[11px] tabular-nums transition-colors",
              // The shaded band marks the window on screen; it is a background on the
              // grid cell, so consecutive days join up.
              shown && "bg-primary/10",
              opensRun && "rounded-l-md",
              closesRun && "rounded-r-md",
            )}
          >
            <span
              className={cn(
                "grid size-6 place-items-center rounded-full transition-colors",
                selected
                  ? "bg-primary font-semibold text-primary-foreground"
                  : isToday
                    ? "font-semibold text-primary hover:bg-accent"
                    : outside
                      ? "text-text-faint hover:bg-accent hover:text-foreground"
                      : cn(
                          "hover:bg-accent hover:text-foreground",
                          isWeekend(day) ? "text-text-faint" : "text-text-dim",
                        ),
              )}
            >
              {day.getDate()}
            </span>
            {props.busy.has(key) && !selected && (
              <span aria-hidden className="absolute bottom-0 size-1 rounded-full bg-primary/60" />
            )}
          </button>
        );
      })}
    </>
  );
}

/** One calendar's visibility toggle: its colour, its name, and an eye. */
function CalendarToggle(props: {
  calendar: CalendarInfo;
  checked: boolean;
  onToggle: () => void;
}) {
  const color = calendarColor(props.calendar);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      data-testid="calendar-toggle"
      data-calendar-id={props.calendar.id}
      data-cuelume-toggle=""
      onClick={props.onToggle}
      className="group/calendar flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-row-hovered"
    >
      <span
        aria-hidden
        style={{ backgroundColor: color }}
        className={cn("size-3 shrink-0 rounded-[3px] transition-opacity", !props.checked && "opacity-35")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          props.checked ? "text-foreground" : "text-text-faint",
        )}
      >
        {calendarLabel(props.calendar)}
      </span>
      {props.calendar.is_default && (
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-faint">Main</span>
      )}
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-md text-text-faint transition-opacity",
          props.checked ? "opacity-0 group-hover/calendar:opacity-100" : "opacity-100",
        )}
      >
        {props.checked ? (
          <HugeiconsIcon icon={EyeIcon} className="size-3.5" strokeWidth={1.8} />
        ) : (
          <HugeiconsIcon icon={EyeOffIcon} className="size-3.5" strokeWidth={1.8} />
        )}
      </span>
    </button>
  );
}

/** What is left of today (or the next day that has anything), so the sidebar answers
 *  "what now" without the user reading the grid. */
function UpNext(props: { events: CalendarEvent[]; loading: boolean }) {
  const colorOf = useCalendarColors();
  const controller = useController();
  const openEventId = useAppState((s) => s.openEventId);
  const now = new Date();

  const next = useMemo(() => {
    const nowMs = now.getTime();
    const todayStart = startOfDay(now).getTime();
    return props.events
      .filter((event) => {
        // Anything still running or still to come today, and anything later.
        const end = Date.parse(event.end);
        return Number.isFinite(end) ? end > nowMs : Date.parse(event.start) >= todayStart;
      })
      .slice(0, 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is per-render on purpose
  }, [props.events]);

  if (next.length === 0) return null;

  return (
    <section data-testid="calendar-up-next" className="flex flex-col gap-1 pb-2">
      <h3 className="flex items-center gap-1.5 px-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
        Up next
        {props.loading && (
          <FadeArc className="size-3" />
        )}
      </h3>
      {next.map((event) => (
        <div key={event.id} className="flex flex-col">
          <span className="px-1.5 text-[10px] text-text-faint">
            {formatAgendaDay(new Date(Date.parse(event.start) || Date.now()), now)}
          </span>
          <EventItem
            event={event}
            color={colorOf(event.calendar_id)}
            selected={openEventId === event.id}
            past={isPast(event, now)}
            onOpen={(id) => controller.setOpenEvent(id)}
            className="py-1"
          />
        </div>
      ))}
    </section>
  );
}
