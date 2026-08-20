import { useEffect, useRef, type MouseEventHandler, type PointerEventHandler } from "react";
import { PRESS_ECHO_GRACE_MS, usePressEcho } from "~/lib/press-echo";

/** How long a touch must stay still before it counts as a long press. Matches the
 *  message gestures, so one hold means one thing across the app. */
const LONG_PRESS_MS = 500;
/** Movement that turns a press into a scroll. */
const GESTURE_INTENT_PX = 8;
/** How long a click is swallowed after the finger lifts, so the hold that opened a menu
 *  does not also activate what is under it. One number with the window the browser's own
 *  echo of that hold arrives in (lib/press-echo.ts), because it is the same fact. */
const SUPPRESS_CLICK_MS = PRESS_ECHO_GRACE_MS;

/**
 * A still touch that opens something — the coarse-pointer way into an affordance a
 * mouse reveals on hover.
 *
 * A mouse is ignored outright: on a device with a pointer, hover is the way in, and a
 * held mouse button must keep meaning "select", not "open a menu". Movement cancels, so
 * scrolling a list never fires it (`useMessageGestures` does the same for a bubble,
 * where a horizontal drag also means Reply — this is the plain half of that).
 */
export function useLongPress(options: { enabled?: boolean; onLongPress: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const suppressClickUntil = useRef(0);
  /** Whether the hold fired on the press still in progress — `start` is cleared as it
   *  fires, so the release cannot ask that instead. */
  const fired = useRef(false);
  // See lib/press-echo.ts: without this the surface the hold opens is dismissed by the
  // browser's own compatibility pointerdown the moment the finger lifts.
  const echo = usePressEcho();
  const onLongPress = useRef(options.onLongPress);
  onLongPress.current = options.onLongPress;
  const enabled = options.enabled !== false;

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  useEffect(() => () => clear(), []);

  const onPointerDown: PointerEventHandler<HTMLElement> = (event) => {
    if (!enabled || event.isPrimary === false || event.pointerType === "mouse") return;
    clear();
    fired.current = false;
    start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    timer.current = setTimeout(() => {
      if (start.current?.pointerId !== event.pointerId) return;
      clear();
      fired.current = true;
      suppressClickUntil.current = Date.now() + SUPPRESS_CLICK_MS;
      echo.claim();
      onLongPress.current();
    }, LONG_PRESS_MS);
  };

  const onPointerMove: PointerEventHandler<HTMLElement> = (event) => {
    const pressed = start.current;
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    const moved = Math.max(
      Math.abs(event.clientX - pressed.x),
      Math.abs(event.clientY - pressed.y),
    );
    if (moved >= GESTURE_INTENT_PX) clear();
  };

  const onPointerUp: PointerEventHandler<HTMLElement> = (event) => {
    if (fired.current) {
      fired.current = false;
      // From the release, not from the hold: the echo lands when the finger lifts, however
      // long it stayed down.
      suppressClickUntil.current = Date.now() + SUPPRESS_CLICK_MS;
      echo.release();
    }
    if (start.current?.pointerId === event.pointerId) clear();
  };

  const onClickCapture: MouseEventHandler<HTMLElement> = (event) => {
    if (Date.now() > suppressClickUntil.current) return;
    // Only what the press really holds. A surface opened in a PORTAL sends its events up the
    // component tree, so without this the very menu a hold opened has its rows swallowed —
    // see the same test in use-message-gestures.ts, where it was reported.
    if (!event.currentTarget.contains(event.target as Node)) return;
    suppressClickUntil.current = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onClickCapture,
    },
  };
}
