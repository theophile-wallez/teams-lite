import { useCallback, useEffect, useMemo, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Loading02Icon,
  LockIcon,
} from "@hugeicons/core-free-icons";
import {
  WEEK_STARTS_ON,
  daysIn,
  formatRangeSubtitle,
  formatRangeTitle,
  visibleRange,
  withoutDeclined,
  workdaysOnly,
  type CalendarViewMode,
} from "~/lib/calendar";
import type { CalendarSettings } from "~/lib/store";
import { cn } from "~/lib/utils";
import { CalendarAgenda } from "./calendar-agenda";
import { CalendarEventPopover } from "./calendar-event-popover";
import { useCalendarColors } from "./calendar-event";
import { CalendarMonth } from "./calendar-month";
import { CalendarTimeGrid } from "./calendar-time-grid";
import { CalendarViewMenu } from "./calendar-view-menu";
import { useAppState, useController } from "./controller-context";

// The calendar surface, in the same detail-pane slot as `MessagePane` and `MailPane`
// — so the two-column layout, the mobile full-screen page and the back button behave
// identically whether the user is reading a chat, a mail or their week.
//
// Its chrome follows the reference design (github.com/vmnog/calendarcn, itself after
// Notion Calendar): the period as a bold heading with the week or day beside it in
// muted type, then a view menu, Today, and prev/next. What that design has and this
// does NOT is the "New event" button, and the omission is the point: creating an event
// mails an invitation to every attendee, and this app cannot write to a calendar at
// all (see src/calendar.rs). A button that could only fail — or that someone later
// wires up without a consent gate — would be the wrong kind of complete.
//
// The pane owns three things the views do not: which window is loaded (through the
// controller), which event's panel is open, and the keyboard. Everything else is
// geometry, and lives in `lib/calendar`.

/** How long the grid takes to slide when the period changes. Short enough to read as
 *  "the same calendar moved", not as a page transition. */
const STEP_ANIMATION_MS = 180;

export function CalendarPane(props: { onBack?: () => void }) {
  const controller = useController();
  const mode = useAppState((s) => s.calendarMode);
  const anchorMs = useAppState((s) => s.calendarAnchorMs);
  const allEvents = useAppState((s) => s.calendarEvents);
  const loading = useAppState((s) => s.calendarLoading);
  const error = useAppState((s) => s.calendarError);
  const calendars = useAppState((s) => s.calendars);
  const settings = useAppState((s) => s.calendarSettings);
  const openEventId = useAppState((s) => s.openEventId);
  const colorOf = useCalendarColors();
  const paneRef = useRef<HTMLElement>(null);

  const anchor = useMemo(() => new Date(anchorMs), [anchorMs]);
  // "Today" as of this render. Recomputed per render rather than held in state: a
  // stale value would only ever mis-highlight one cell, and no timer is worth that.
  const today = useMemo(() => new Date(), [anchorMs, mode]);
  const range = useMemo(() => visibleRange(mode, anchor, WEEK_STARTS_ON), [mode, anchor]);
  const title = useMemo(() => formatRangeTitle(mode, anchor, WEEK_STARTS_ON), [mode, anchor]);
  const subtitle = useMemo(() => formatRangeSubtitle(mode, anchor, WEEK_STARTS_ON), [mode, anchor]);

  // The "Declined events" setting is applied ONCE, here: every view then draws the
  // same set, and nothing downstream has to remember the rule.
  const events = useMemo(
    () => withoutDeclined(allEvents, settings.showDeclined),
    [allEvents, settings.showDeclined],
  );
  // The "Weekends" setting shapes a WEEK: five columns instead of seven. It never
  // applies to the Day view, where the day is the one the user asked for — a Saturday
  // picked from the mini month must draw that Saturday, not an empty grid.
  const gridDays = useMemo(
    () => (mode === "week" ? workdaysOnly(daysIn(range), settings.showWeekends) : daysIn(range)),
    [mode, range, settings.showWeekends],
  );

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
      if (mode === "month" || mode === "agenda") controller.setCalendarMode("day");
    },
    [controller, mode],
  );

  // Keyboard navigation, the way every calendar does it: arrows (or J/K) step, T is
  // today, M/W/D/A switch views. Only while no dialog owns the keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      // A floating surface owns the keyboard while it has the focus — the view menu's
      // own arrow keys, and Escape inside the details panel, are Radix's to handle.
      if (target?.closest('[role="dialog"],[role="menu"]')) return;
      switch (e.key) {
        case "ArrowLeft":
        case "j":
        case "J":
          e.preventDefault();
          controller.shiftCalendar(-1);
          break;
        case "ArrowRight":
        case "k":
        case "K":
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
  }, [controller]);

  // Which way the period last moved, so the grid slides in from the side it came from.
  const direction = useStepDirection(anchorMs, mode);

  return (
    <section
      ref={paneRef}
      data-testid="calendar-pane"
      className="flex min-w-0 flex-1 flex-col bg-background"
      // A click on the grid's background (not on an event) puts the panel away, the
      // way it does in every calendar.
      //
      // "The grid's background" is this pane's own DOM subtree, and the details panel is
      // NOT in it: it is portaled to the body, and so is anything it opens in turn. A
      // React event bubbles out of a portal to its React parent all the same, so this
      // handler sees those clicks — and the earlier test, which only asked whether the
      // click was on an event chip, closed the panel from a control INSIDE the panel. It
      // cost the footer's "Open in" its menu: the trigger opened it, this closed the
      // panel under it, and the menu went with the subtree.
      onClick={(e) => {
        if (!openEventId) return;
        const target = e.target as HTMLElement;
        if (!paneRef.current?.contains(target)) return;
        if (target.closest('[data-testid="calendar-event"]')) return;
        onCloseEvent();
      }}
    >
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-5">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back to chats"
            data-testid="back-to-list"
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
          </button>
        )}

        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2
            data-testid="calendar-title"
            className="truncate text-[17px] font-bold capitalize tracking-tight text-foreground"
          >
            {title}
          </h2>
          {subtitle && (
            <span
              data-testid="calendar-subtitle"
              className="shrink-0 truncate text-[12px] text-text-faint"
            >
              {subtitle}
            </span>
          )}
          {/* Says plainly what this surface is, and what it is not. Not decoration:
              the one thing a user must be able to trust about this screen is that
              looking at it cannot change anyone's calendar. */}
          <span
            data-testid="calendar-read-only"
            // Hidden on a phone, where the period itself would otherwise be truncated
            // to a letter. The details panel still says it on every screen.
            className="hidden shrink-0 items-center gap-1 rounded-md bg-element px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-faint sm:flex"
          >
            <HugeiconsIcon icon={LockIcon} className="size-2.5" strokeWidth={2.2} aria-hidden />
            Read-only
          </span>
          {loading && (
            <HugeiconsIcon
              icon={Loading02Icon}
              data-testid="calendar-loading"
              className="size-3.5 shrink-0 animate-spin text-text-faint"
              strokeWidth={1.6}
            />
          )}
        </div>

        <CalendarViewMenu
          mode={mode}
          settings={settings}
          onSelectMode={(next) => controller.setCalendarMode(next)}
          onToggleSetting={(key: keyof CalendarSettings) => controller.toggleCalendarSetting(key)}
        />

        <button
          type="button"
          data-testid="calendar-today"
          data-cuelume-press=""
          onClick={() => controller.goToToday()}
          className="shrink-0 rounded-lg bg-card px-2.5 py-1.5 text-[13px] font-medium text-text-dim shadow-chip transition-colors hover:text-foreground"
        >
          Today
        </button>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label="Previous"
            data-testid="calendar-prev"
            onClick={() => controller.shiftCalendar(-1)}
            className="grid size-8 place-items-center rounded-lg text-text-faint transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={ChevronLeftIcon} className="size-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="Next"
            data-testid="calendar-next"
            onClick={() => controller.shiftCalendar(1)}
            className="grid size-8 place-items-center rounded-lg text-text-faint transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={ChevronRightIcon} className="size-4" strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {error && events.length === 0 ? (
        <p
          data-testid="calendar-error"
          className="px-6 py-8 text-center text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : (
        <div
          // Keyed on the window, so stepping a period remounts the view and plays the
          // slide. Reduced-motion users get the same content with no movement (the
          // `motion-reduce` variants below).
          key={`${mode}:${anchorMs}`}
          style={{ animationDuration: `${STEP_ANIMATION_MS}ms` }}
          className={cn(
            "flex min-h-0 flex-1 flex-col animate-in fade-in",
            direction > 0 && "slide-in-from-right-4",
            direction < 0 && "slide-in-from-left-4",
            "motion-reduce:animate-none",
          )}
        >
          {mode === "month" ? (
            <CalendarMonth
              anchor={anchor}
              today={today}
              events={events}
              weekStartsOn={WEEK_STARTS_ON}
              showWeekends={settings.showWeekends}
              showWeekNumbers={settings.showWeekNumbers}
              colorOf={colorOf}
              openEventId={openEventId}
              onOpenEvent={onOpenEvent}
              onPickDay={onPickDay}
            />
          ) : mode === "agenda" ? (
            <CalendarAgenda
              range={range}
              today={today}
              events={events}
              openEventId={openEventId}
              onOpenEvent={onOpenEvent}
              onPickDay={onPickDay}
            />
          ) : (
            <CalendarTimeGrid
              days={gridDays}
              today={today}
              events={events}
              colorOf={colorOf}
              openEventId={openEventId}
              onOpenEvent={onOpenEvent}
              onPickDay={onPickDay}
            />
          )}
        </div>
      )}

      <CalendarEventPopover
        event={openEvent}
        calendars={calendars}
        color={openEvent ? colorOf(openEvent.calendar_id) : "var(--primary)"}
        paneRef={paneRef}
        onClose={onCloseEvent}
      />
    </section>
  );
}

/**
 * Which way the calendar last moved: `1` forward, `-1` back, `0` for anything that is
 * not a step (a view switch, or the first render).
 *
 * Derived from a ref rather than held in state: the render that needs it is the one the
 * anchor change already triggered, so storing it would only mean rendering twice per
 * step. Re-entrant by construction — a second render with the same anchor reads the
 * value back unchanged.
 */
function useStepDirection(anchorMs: number, mode: CalendarViewMode): number {
  const previous = useRef({ anchorMs, mode, direction: 0 });
  if (previous.current.anchorMs !== anchorMs || previous.current.mode !== mode) {
    previous.current = {
      anchorMs,
      mode,
      direction: previous.current.mode !== mode ? 0 : Math.sign(anchorMs - previous.current.anchorMs),
    };
  }
  return previous.current.direction;
}
