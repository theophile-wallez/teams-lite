import { useCallback, useEffect, useMemo } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import {
  WEEK_STARTS_ON,
  daysIn,
  formatRangeTitle,
  visibleRange,
  type CalendarViewMode,
} from "~/lib/calendar";
import { cn } from "~/lib/utils";
import { CalendarAgenda } from "./calendar-agenda";
import { CalendarEventDetails } from "./calendar-event-details";
import { useCalendarColors } from "./calendar-event";
import { CalendarMonth } from "./calendar-month";
import { CalendarTimeGrid } from "./calendar-time-grid";
import { useAppState, useController } from "./controller-context";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

// The calendar surface, in the same detail-pane slot as `MessagePane` and `MailPane`
// — so the two-column layout, the mobile slide-over and the back button behave
// identically whether the user is reading a chat, a mail or their week.
//
// Its chrome follows the reference design (shadcnuikit.com/dashboard/apps/calendar):
// a Today button and prev/next arrows on the left, the period as the heading, and a
// view switcher on the right. What that design has and this does NOT is the "New
// event" button, and the omission is the point: creating an event mails an invitation
// to every attendee, and this app cannot write to a calendar at all (see
// src/calendar.rs). A button that could only fail — or that someone later wires up
// without a consent gate — would be the wrong kind of complete.

const MODES: { value: CalendarViewMode; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
  { value: "day", label: "Day" },
  { value: "agenda", label: "Agenda" },
];

export function CalendarPane(props: { onBack?: () => void }) {
  const controller = useController();
  const mode = useAppState((s) => s.calendarMode);
  const anchorMs = useAppState((s) => s.calendarAnchorMs);
  const events = useAppState((s) => s.calendarEvents);
  const loading = useAppState((s) => s.calendarLoading);
  const error = useAppState((s) => s.calendarError);
  const calendars = useAppState((s) => s.calendars);
  const openEventId = useAppState((s) => s.openEventId);
  const colorOf = useCalendarColors();

  const anchor = useMemo(() => new Date(anchorMs), [anchorMs]);
  // "Today" as of this render. Recomputed per render rather than held in state: a
  // stale value would only ever mis-highlight one cell, and no timer is worth that.
  const today = useMemo(() => new Date(), [anchorMs, mode]);
  const range = useMemo(() => visibleRange(mode, anchor, WEEK_STARTS_ON), [mode, anchor]);
  const title = useMemo(() => formatRangeTitle(mode, anchor, WEEK_STARTS_ON), [mode, anchor]);

  const openEvent = useMemo(
    () => events.find((event) => event.id === openEventId) ?? null,
    [events, openEventId],
  );

  const onOpenEvent = useCallback((id: string) => controller.setOpenEvent(id), [controller]);
  const onCloseEvent = useCallback(() => controller.setOpenEvent(null), [controller]);
  // Picking a day zooms into it, which is what a day number in a grid means
  // everywhere. From the Day view it just moves the day.
  const onPickDay = useCallback(
    (day: Date) => {
      controller.setCalendarAnchor(day);
      if (mode === "month") controller.setCalendarMode("day");
    },
    [controller, mode],
  );

  // Keyboard navigation, the way every calendar does it: arrows step, T is today,
  // M/W/D/A switch views. Only while no dialog owns the keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (openEventId) return; // the details dialog handles Escape itself
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          controller.shiftCalendar(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          controller.shiftCalendar(1);
          break;
        case "t":
        case "T":
          controller.goToToday();
          break;
        case "m":
        case "M":
          controller.setCalendarMode("month");
          break;
        case "w":
        case "W":
          controller.setCalendarMode("week");
          break;
        case "d":
        case "D":
          controller.setCalendarMode("day");
          break;
        case "a":
        case "A":
          controller.setCalendarMode("agenda");
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, openEventId]);

  return (
    <section data-testid="calendar-pane" className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-5">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back to chats"
            data-testid="back-to-list"
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <ChevronLeft className="size-5" strokeWidth={1.6} />
          </button>
        )}

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="calendar-today"
            data-cuelume-press=""
            onClick={() => controller.goToToday()}
            className="rounded-lg bg-card px-2.5 py-1.5 text-[13px] font-medium text-text-dim shadow-chip transition-colors hover:text-foreground"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Previous"
            data-testid="calendar-prev"
            onClick={() => controller.shiftCalendar(-1)}
            className="grid size-8 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="Next"
            data-testid="calendar-next"
            onClick={() => controller.shiftCalendar(1)}
            className="grid size-8 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="size-4" strokeWidth={1.8} />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <h2
            data-testid="calendar-title"
            className="truncate text-sm font-semibold capitalize text-foreground md:text-base"
          >
            {title}
          </h2>
          <p className="truncate text-[11px] text-text-faint">
            {/* Says plainly what this surface is, and what it is not. */}
            Calendar · read-only
          </p>
        </div>

        {loading && (
          <Loader2
            data-testid="calendar-loading"
            className="size-3.5 shrink-0 animate-spin text-text-faint"
            strokeWidth={1.6}
          />
        )}

        <Tabs
          value={mode}
          onValueChange={(value) => controller.setCalendarMode(value as CalendarViewMode)}
          className="shrink-0"
        >
          <TabsList aria-label="Calendar view">
            {MODES.map((item) => (
              <TabsTrigger
                key={item.value}
                value={item.value}
                data-testid={`calendar-view-${item.value}`}
                className="flex-none"
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      {error && events.length === 0 ? (
        <p
          data-testid="calendar-error"
          className="px-6 py-8 text-center text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col", loading && "opacity-90")}>
          {mode === "month" ? (
            <CalendarMonth
              anchor={anchor}
              today={today}
              events={events}
              weekStartsOn={WEEK_STARTS_ON}
              colorOf={colorOf}
              onOpenEvent={onOpenEvent}
              onPickDay={onPickDay}
            />
          ) : mode === "agenda" ? (
            <CalendarAgenda
              range={range}
              today={today}
              events={events}
              onOpenEvent={onOpenEvent}
              onPickDay={onPickDay}
            />
          ) : (
            <CalendarTimeGrid
              days={daysIn(range)}
              today={today}
              events={events}
              colorOf={colorOf}
              onOpenEvent={onOpenEvent}
              onPickDay={onPickDay}
            />
          )}
        </div>
      )}

      <CalendarEventDetails
        event={openEvent}
        calendars={calendars}
        color={openEvent ? colorOf(openEvent.calendar_id) : "var(--primary)"}
        onClose={onCloseEvent}
      />
    </section>
  );
}
