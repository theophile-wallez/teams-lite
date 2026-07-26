import { useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  WEEK_STARTS_ON,
  addMonths,
  dayKey,
  eventTouchesDay,
  formatAgendaDay,
  isSameDay,
  isSameMonth,
  monthGridDays,
  startOfDay,
  startOfMonth,
  weekdayLabels,
} from "~/lib/calendar";
import { calendarColor, calendarLabel, type CalendarEvent, type CalendarInfo } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { EventChip, useCalendarColors } from "./calendar-event";
import { useAppState, useController } from "./controller-context";

// The Calendar tab's sidebar: a mini month for jumping around, the calendar list with
// its colour swatches, and what is left of today.
//
// This is the reference design's left rail, adapted to this app's 320px column instead
// of a full-width dashboard shell. The calendar checkboxes are the one control here
// that costs anything: switching a calendar on may need a window the backend has not
// read for it yet, which is why the default is the primary calendar alone (a mailbox
// here carries six).

export function CalendarSidebar() {
  const controller = useController();
  const calendars = useAppState((s) => s.calendars);
  const visible = useAppState((s) => s.visibleCalendarIds);
  const events = useAppState((s) => s.calendarEvents);
  const loading = useAppState((s) => s.calendarLoading);
  const error = useAppState((s) => s.calendarError);
  const anchorMs = useAppState((s) => s.calendarAnchorMs);
  const anchor = useMemo(() => new Date(anchorMs), [anchorMs]);

  if (error && calendars.length === 0) {
    return (
      <p data-testid="calendar-sidebar-error" className="px-4 py-6 text-center text-[13px] text-destructive">
        {error}
      </p>
    );
  }

  if (calendars.length === 0) {
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-6 text-[13px] text-text-faint">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={1.6} />
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
        onPick={(day) => controller.setCalendarAnchor(day)}
      />

      <section className="flex flex-col gap-1">
        <h3 className="px-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
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
          <p className="px-1 pt-1 text-[11px] text-text-faint">
            No calendar shown — pick at least one.
          </p>
        )}
      </section>

      <UpNext events={events} loading={loading} />
    </div>
  );
}

/** The mini month picker. Its own local month, so browsing ahead in it does not move
 *  the main view until a day is actually clicked — the behaviour every calendar's
 *  date picker has. */
function MiniMonth(props: {
  anchor: Date;
  events: CalendarEvent[];
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
  const days = useMemo(() => monthGridDays(month, WEEK_STARTS_ON), [month]);
  const labels = useMemo(() => weekdayLabels(WEEK_STARTS_ON), []);
  const today = new Date();

  // Which days have anything on them, so the picker can show density dots.
  const busy = useMemo(() => {
    const keys = new Set<string>();
    for (const day of days) {
      if (props.events.some((event) => eventTouchesDay(event, day))) keys.add(dayKey(day));
    }
    return keys;
  }, [days, props.events]);

  return (
    <section data-testid="calendar-mini-month" className="flex flex-col gap-1.5 pt-1">
      <header className="flex items-center gap-1 px-1">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium capitalize text-foreground">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </h3>
        <button
          type="button"
          aria-label="Previous month"
          data-testid="calendar-mini-prev"
          onClick={() => setOffset((o) => o - 1)}
          className="grid size-6 place-items-center rounded-md text-text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="Next month"
          data-testid="calendar-mini-next"
          onClick={() => setOffset((o) => o + 1)}
          className="grid size-6 place-items-center rounded-md text-text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="size-3.5" strokeWidth={1.8} />
        </button>
      </header>

      <div className="grid grid-cols-7 gap-y-0.5">
        {labels.map((label) => (
          <span
            key={label}
            className="truncate text-center text-[10px] font-medium uppercase text-text-faint"
          >
            {label.slice(0, 2)}
          </span>
        ))}
        {days.map((day) => {
          const outside = !isSameMonth(day, month);
          const selected = isSameDay(day, props.anchor);
          const isToday = isSameDay(day, today);
          return (
            <button
              key={dayKey(day)}
              type="button"
              data-testid="calendar-mini-day"
              data-day={dayKey(day)}
              data-selected={selected ? "true" : undefined}
              onClick={() => props.onPick(day)}
              className={cn(
                "relative mx-auto grid size-7 place-items-center rounded-full text-[11px] tabular-nums transition-colors",
                selected
                  ? "bg-primary font-semibold text-primary-foreground"
                  : isToday
                    ? "font-semibold text-primary hover:bg-accent"
                    : outside
                      ? "text-text-faint hover:bg-accent hover:text-foreground"
                      : "text-text-dim hover:bg-accent hover:text-foreground",
              )}
            >
              {day.getDate()}
              {busy.has(dayKey(day)) && !selected && (
                <span
                  aria-hidden
                  className="absolute bottom-0.5 size-1 rounded-full bg-primary/60"
                />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** One calendar's visibility toggle: a colour swatch that becomes a checkmark. */
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
      className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-row-hovered"
    >
      <span
        aria-hidden
        style={props.checked ? { backgroundColor: color, borderColor: color } : { borderColor: color }}
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded border-[1.5px]",
          props.checked ? "text-white" : "text-transparent",
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          props.checked ? "text-foreground" : "text-text-faint",
        )}
      >
        {calendarLabel(props.calendar)}
      </span>
      {props.calendar.is_default && (
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-faint">
          Main
        </span>
      )}
    </button>
  );
}

/** What is left of today (or the next day that has anything), so the sidebar answers
 *  "what now" without the user reading the grid. */
function UpNext(props: { events: CalendarEvent[]; loading: boolean }) {
  const colorOf = useCalendarColors();
  const controller = useController();
  const now = new Date();

  const next = useMemo(() => {
    const nowMs = now.getTime();
    const todayStart = startOfDay(now).getTime();
    const upcoming = props.events
      .filter((event) => {
        // Anything still running or still to come today, and anything later.
        const end = Date.parse(event.end);
        return Number.isFinite(end) ? end > nowMs : Date.parse(event.start) >= todayStart;
      })
      .slice(0, 4);
    return upcoming;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is per-render on purpose
  }, [props.events]);

  if (next.length === 0) return null;

  return (
    <section data-testid="calendar-up-next" className="flex flex-col gap-1 pb-2">
      <h3 className="flex items-center gap-1.5 px-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
        Up next
        {props.loading && <Loader2 className="size-3 animate-spin" strokeWidth={1.6} />}
      </h3>
      {next.map((event) => (
        <div key={event.id} className="flex flex-col">
          <span className="px-1.5 text-[10px] text-text-faint">
            {formatAgendaDay(new Date(Date.parse(event.start) || Date.now()), now)}
          </span>
          <EventChip
            event={event}
            color={colorOf(event.calendar_id)}
            onOpen={(id) => controller.setOpenEvent(id)}
            className="py-1"
          />
        </div>
      ))}
    </section>
  );
}
