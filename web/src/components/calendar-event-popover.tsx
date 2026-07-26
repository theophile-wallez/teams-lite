import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CalendarEvent, CalendarInfo } from "~/lib/protocol";
import { CalendarEventDetails } from "./calendar-event-details";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

// Where an event's details appear.
//
// The reference design opens them BESIDE the event that was clicked rather than in a
// modal over the grid, and that is the better behaviour here too: the row the user is
// reasoning about stays visible, and the surrounding week is still legible while they
// read. So on a wide screen this is a popover pinned to the event's own rectangle.
//
// On a narrow one it is a dialog: a 320px panel next to a full-width event has nowhere
// to go, and a collision-shifted popover over the thing it describes is just a modal
// that lies about being one.
//
// The anchor is a fixed-position stand-in measured from the event element rather than
// the element itself. Events are recycled by every view switch, month step and live
// reconciliation; making each one a Radix trigger would put a popover subtree inside
// every cell of the grid. One measured anchor keeps that cost at zero and lets the
// panel survive the event being re-rendered underneath it.

/** Below this the details are a dialog, not a popover — matches Tailwind's `md`. */
const DESKTOP_QUERY = "(min-width: 768px)";

/** `useLayoutEffect` in the browser, `useEffect` on the server (where there is no
 *  layout to read and React warns about the former). */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Rect = { top: number; left: number; width: number; height: number };

export function CalendarEventPopover(props: {
  event: CalendarEvent | null;
  calendars: CalendarInfo[];
  color: string;
  /** The pane the events live in, so the lookup can be scoped to it. */
  paneRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const desktop = useIsDesktop();
  const rect = useEventRect(props.event?.id ?? null, props.paneRef, desktop);
  const open = !!props.event;

  if (!props.event) return null;

  const panel = (
    <CalendarEventDetails
      event={props.event}
      calendars={props.calendars}
      color={props.color}
      onClose={props.onClose}
    />
  );

  // No rectangle yet (a first paint, or an event that is scrolled out of the grid):
  // fall back to the dialog rather than pinning the panel to the top-left corner.
  if (!desktop || !rect) {
    return (
      <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
        <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">Event details</DialogTitle>
          {panel}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open onOpenChange={(next) => !next && props.onClose()}>
      {/* Portaled to the body on purpose. The stand-in is positioned in VIEWPORT
          coordinates, and the detail pane it would otherwise live in carries a
          `translate-x` for the mobile slide — a transform makes that pane the
          containing block for fixed children, which would offset the anchor by the
          sidebar's width and defeat the popover's own collision handling. */}
      {createPortal(
        <PopoverAnchor
          aria-hidden
          className="pointer-events-none fixed"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />,
        document.body,
      )}
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[min(32rem,80vh)] w-80 flex-col overflow-hidden p-0"
        // The grid keeps the keyboard: arrows still page the calendar while a panel is
        // open, and Escape (which Radix handles) closes it.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {panel}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The viewport rectangle of the event element with this id, tracked while it moves.
 *
 * Re-measured on scroll (captured, so an inner scroller counts) and on resize, which
 * is what keeps the panel beside its event when the hour grid is scrolled. Measurement
 * is deferred to an animation frame so it never runs more than once per painted frame.
 */
function useEventRect(
  eventId: string | null,
  paneRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  const measure = useCallback(() => {
    if (!eventId || !enabled) {
      setRect(null);
      return;
    }
    const pane = paneRef.current;
    const element = pane?.querySelector<HTMLElement>(
      `[data-testid="calendar-event"][data-event-id="${CSS.escape(eventId)}"]`,
    );
    if (!element) {
      setRect(null);
      return;
    }
    const box = element.getBoundingClientRect();
    setRect((current) =>
      current &&
      current.top === box.top &&
      current.left === box.left &&
      current.width === box.width &&
      current.height === box.height
        ? current
        : { top: box.top, left: box.left, width: box.width, height: box.height },
    );
  }, [eventId, enabled, paneRef]);

  // Before paint, so the panel's first frame is already in the right place. Falls back
  // to a plain effect where there is no layout to read (SSR).
  useIsomorphicLayoutEffect(measure, [measure]);

  useEffect(() => {
    if (!eventId || !enabled) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [eventId, enabled, measure]);

  return rect;
}

/** Whether the viewport is wide enough for a side panel. Defaults to true so SSR and
 *  the first client paint agree with the desktop layout the CSS assumes. */
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return desktop;
}
