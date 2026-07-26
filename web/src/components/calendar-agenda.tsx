import { useMemo } from "react";
import { CalendarDays } from "lucide-react";
import {
  dayKey,
  daysIn,
  eventsForDay,
  formatAgendaDay,
  formatEventTime,
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

export function CalendarAgenda(props: {
  range: DayRange;
  today: Date;
  events: CalendarEvent[];
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
          <CalendarDays className="size-6" strokeWidth={1.4} />
        </span>
        <p className="text-sm text-text-dim">Nothing scheduled in this window.</p>
      </div>
    );
  }

  return (
    <div data-testid="calendar-agenda" className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-6">
      <ol className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        {groups.map((group) => (
          <li key={dayKey(group.day)} data-testid="calendar-agenda-day" data-day={dayKey(group.day)}>
            <button
              type="button"
              onClick={() => props.onPickDay(group.day)}
              className={cn(
                "mb-1.5 rounded-md px-1 text-left text-[13px] font-semibold transition-colors hover:text-primary",
                isSameDay(group.day, props.today) ? "text-primary" : "text-foreground",
              )}
            >
              {formatAgendaDay(group.day, props.today)}
            </button>
            <ul className="flex flex-col">
              {group.events.map((event) => (
                <li key={event.id}>
                  <AgendaRow
                    event={event}
                    color={colorOf(event.calendar_id)}
                    onOpen={props.onOpenEvent}
                  />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One event as a two-column row: its time, then its title and place. Wide enough to
 *  carry the detail a month-grid chip cannot. */
function AgendaRow(props: {
  event: CalendarEvent;
  color: string;
  onOpen: (id: string) => void;
}) {
  const { event } = props;
  const declined = event.response === "declined" || event.is_cancelled;

  return (
    <button
      type="button"
      data-testid="calendar-event"
      data-event-id={event.id}
      onClick={() => props.onOpen(event.id)}
      style={{ ["--event-color" as string]: props.color }}
      className={cn(
        "group/row flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-row-hovered",
        declined && "opacity-60",
      )}
    >
      <span
        aria-hidden
        className="mt-1 h-8 w-[3px] shrink-0 rounded-full bg-[var(--event-color)]"
      />
      <span className="w-[124px] shrink-0 pt-0.5 text-[12px] tabular-nums text-text-dim">
        {formatEventTime(event)}
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
          <span className="truncate text-[12px] text-text-faint">
            {event.location || "Microsoft Teams Meeting"}
          </span>
        )}
      </span>
    </button>
  );
}
