import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CalendarDaysIcon, MapPinIcon, Video01Icon } from "@hugeicons/core-free-icons";
import {
  dayKey,
  daysIn,
  eventSpan,
  eventsForDay,
  formatAgendaDay,
  formatEventTime,
  formatEventTimeRange,
  isDeclined,
  isPast,
  isSameDay,
  type DayRange,
} from "~/lib/calendar";
import { eventTitle, type CalendarEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useCalendarColors } from "./calendar-event";

// The agenda: a linear list of what is coming, grouped by day. The view that answers
// "what is next" without geometry — and the one that stays usable on a phone, where a
// seven-column hour grid does not.
//
// Days with nothing in them are omitted rather than listed as empty rows: a fortnight
// of "no events" headers is noise, and the gap between two dates says the same thing.
// Each day keeps a date rail on the left (the number over the weekday, today in the
// accent), so scanning down the list never loses which day a row belongs to.

export function CalendarAgenda(props: {
  range: DayRange;
  today: Date;
  events: CalendarEvent[];
  openEventId: string | null;
  onOpenEvent: (id: string) => void;
  onPickDay: (day: Date) => void;
}) {
  const colorOf = useCalendarColors();
  const groups = useMemo(
    () =>
      daysIn(props.range)
        .map((day) => ({ day, events: eventsForDay(props.events, day) }))
        .filter((group) => group.events.length > 0),
    [props.range, props.events],
  );

  if (groups.length === 0) {
    return (
      <div
        data-testid="calendar-agenda-empty"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
          <HugeiconsIcon icon={CalendarDaysIcon} className="size-6" strokeWidth={1.4} />
        </span>
        <p className="text-sm text-text-dim">Nothing scheduled in this window.</p>
      </div>
    );
  }

  return (
    <div data-testid="calendar-agenda" className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-6">
      <ol className="mx-auto flex w-full max-w-3xl flex-col">
        {groups.map((group) => {
          const today = isSameDay(group.day, props.today);
          return (
            <li
              key={dayKey(group.day)}
              data-testid="calendar-agenda-day"
              data-day={dayKey(group.day)}
              data-today={today ? "true" : undefined}
              className="flex gap-3 border-b border-border-subtle py-3 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => props.onPickDay(group.day)}
                aria-label={`Open ${formatAgendaDay(group.day, props.today)}`}
                className="flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-lg py-1 transition-colors hover:bg-accent"
              >
                <span
                  className={cn(
                    "grid size-7 place-items-center rounded-lg text-[15px] font-semibold tabular-nums",
                    today ? "bg-primary text-primary-foreground" : "text-foreground",
                  )}
                >
                  {group.day.getDate()}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-text-faint">
                  {group.day.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
              </button>

              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span
                  className={cn(
                    "px-2 text-[11px] font-semibold uppercase tracking-wide",
                    today ? "text-primary" : "text-text-faint",
                  )}
                >
                  {formatAgendaDay(group.day, props.today)}
                </span>
                <ul className="flex flex-col">
                  {group.events.map((event) => (
                    <li key={event.id}>
                      <AgendaRow
                        event={event}
                        color={colorOf(event.calendar_id)}
                        selected={props.openEventId === event.id}
                        past={isPast(event, props.today)}
                        onOpen={props.onOpenEvent}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One event as a two-column row: its time, then its title and place. Wide enough to
 *  carry the detail a month-grid item cannot. */
function AgendaRow(props: {
  event: CalendarEvent;
  color: string;
  selected: boolean;
  past: boolean;
  onOpen: (id: string) => void;
}) {
  const { event } = props;
  const declined = isDeclined(event);

  return (
    <button
      type="button"
      data-testid="calendar-event"
      data-event-id={event.id}
      data-selected={props.selected ? "true" : undefined}
      onClick={() => props.onOpen(event.id)}
      style={{ ["--event-color" as string]: props.color }}
      className={cn(
        "calendar-event group/row flex w-full items-start gap-3 rounded-lg px-2 py-1.5 text-left transition-colors",
        props.selected ? "bg-[var(--event-fill)]" : "hover:bg-row-hovered",
        declined && "opacity-60",
        props.past && !props.selected && "opacity-70",
      )}
    >
      <span aria-hidden className="mt-1 h-8 w-[3px] shrink-0 rounded-full bg-[var(--event-color)]" />
      <span className="w-[124px] shrink-0 pt-0.5 text-[12px] tabular-nums text-text-dim">
        {/* A same-day meeting reads as a compact range on one line; anything that
            spans days keeps its dates, which is what makes the list unambiguous. */}
        {eventSpan(event).banded || event.is_all_day
          ? formatEventTime(event)
          : formatEventTimeRange(event)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-[13px] font-medium text-foreground",
            declined && "line-through",
          )}
        >
          {eventTitle(event)}
        </span>
        {(event.location || event.join_url) && (
          <span className="flex min-w-0 items-center gap-1 truncate text-[12px] text-text-faint">
            {event.join_url ? (
              <HugeiconsIcon
                icon={Video01Icon}
                className="size-3 shrink-0"
                strokeWidth={1.8}
                aria-hidden
              />
            ) : (
              <HugeiconsIcon
                icon={MapPinIcon}
                className="size-3 shrink-0"
                strokeWidth={1.8}
                aria-hidden
              />
            )}
            <span className="truncate">{event.location || "Microsoft Teams Meeting"}</span>
          </span>
        )}
      </span>
    </button>
  );
}
