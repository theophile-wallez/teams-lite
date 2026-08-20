import { animate, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect, useRef, type MouseEventHandler, type PointerEventHandler } from "react";
import { PRESS_ECHO_GRACE_MS, usePressEcho } from "~/lib/press-echo";

/** Time a touch must stay still before it opens the message actions menu. */
const LONG_PRESS_MS = 500;
/** Movement that changes a press into a scroll or swipe. */
const GESTURE_INTENT_PX = 8;
/** Inward movement that selects Reply. */
const REPLY_THRESHOLD_PX = 52;
/** Maximum visual travel: enough to show intent without losing the bubble. */
const MAX_SWIPE_PX = 72;

interface ActiveGesture {
  pointerId: number;
  startX: number;
  startY: number;
  axis: "pending" | "horizontal" | "vertical";
  longPressFired: boolean;
}

interface MessageGesturesOptions {
  enabled: boolean;
  mine: boolean;
  onLongPress: () => void;
  onReply: () => void;
}

/**
 * Mobile message gestures. A still touch opens the actions menu; a horizontal
 * drag towards the conversation centre starts a reply. `touch-action: pan-y` on
 * the returned target leaves vertical history scrolling with the browser.
 */
export function useMessageGestures(options: MessageGesturesOptions) {
  const x = useMotionValue(0);
  const reduceMotion = useReducedMotion();
  const active = useRef<ActiveGesture | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickUntil = useRef(0);
  const settleAnimation = useRef<ReturnType<typeof animate> | null>(null);
  // The browser's own echo of the hold, which would otherwise dismiss the menu the hold
  // opens the instant the finger lifts (see lib/press-echo.ts).
  const echo = usePressEcho();
  const onLongPress = useRef(options.onLongPress);
  const onReply = useRef(options.onReply);
  onLongPress.current = options.onLongPress;
  onReply.current = options.onReply;

  const clearLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const settle = () => {
    settleAnimation.current?.stop();
    if (reduceMotion) {
      x.set(0);
      return;
    }
    settleAnimation.current = animate(x, 0, {
      type: "spring",
      stiffness: 700,
      damping: 46,
      mass: 0.55,
    });
  };

  const finishPointer = (target: HTMLElement, pointerId: number) => {
    try {
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch {
      // Synthetic test events do not register an active browser pointer.
    }
  };

  const onPointerDown: PointerEventHandler<HTMLElement> = (event) => {
    if (!options.enabled || event.isPrimary === false || event.pointerType === "mouse") return;

    clearLongPress();
    settleAnimation.current?.stop();
    x.set(0);
    active.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: "pending",
      longPressFired: false,
    };
    longPressTimer.current = setTimeout(() => {
      const gesture = active.current;
      if (!gesture || gesture.pointerId !== event.pointerId || gesture.axis !== "pending") return;
      gesture.longPressFired = true;
      suppressClickUntil.current = Date.now() + PRESS_ECHO_GRACE_MS;
      echo.claim();
      onLongPress.current();
    }, LONG_PRESS_MS);
  };

  const onPointerMove: PointerEventHandler<HTMLElement> = (event) => {
    const gesture = active.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.longPressFired) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (gesture.axis === "pending") {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < GESTURE_INTENT_PX) return;
      clearLongPress();
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
      if (gesture.axis === "horizontal") {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic test events do not register an active browser pointer.
        }
      }
    }

    if (gesture.axis !== "horizontal") return;
    event.preventDefault();
    const inward = options.mine ? Math.min(0, dx) : Math.max(0, dx);
    x.set(Math.sign(inward) * Math.min(Math.abs(inward), MAX_SWIPE_PX));
  };

  const onPointerUp: PointerEventHandler<HTMLElement> = (event) => {
    const gesture = active.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    clearLongPress();
    finishPointer(event.currentTarget, event.pointerId);
    active.current = null;

    if (gesture.longPressFired) {
      // Re-armed from the RELEASE rather than from the hold: a reader who held for three
      // seconds gets the browser's echo — its compatibility click, and the pointerdown
      // WebKit sends with it — now, long after a window measured from the hold expired.
      suppressClickUntil.current = Date.now() + PRESS_ECHO_GRACE_MS;
      echo.release();
      return;
    }
    if (gesture.axis === "horizontal") {
      suppressClickUntil.current = Date.now() + PRESS_ECHO_GRACE_MS;
      const inwardDistance = options.mine ? -x.get() : x.get();
      settle();
      if (inwardDistance >= REPLY_THRESHOLD_PX) onReply.current();
      return;
    }
    settle();
  };

  const onPointerCancel: PointerEventHandler<HTMLElement> = (event) => {
    const gesture = active.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    clearLongPress();
    finishPointer(event.currentTarget, event.pointerId);
    active.current = null;
    if (gesture.longPressFired) {
      suppressClickUntil.current = Date.now() + PRESS_ECHO_GRACE_MS;
      echo.release();
    }
    settle();
  };

  const onClickCapture: MouseEventHandler<HTMLElement> = (event) => {
    if (Date.now() > suppressClickUntil.current) return;
    // What the hold must not activate is what was UNDER the finger. The menu it opened is
    // rendered in a PORTAL, and a portal's events travel up the COMPONENT tree rather than
    // the DOM one — so every tap inside that menu arrived here too and was swallowed for the
    // window's whole length: the reader held a bubble, the reaction row appeared, and their
    // tap on it did nothing. That is the reported bug, and this containment test is the whole
    // of it — a click the bubble does not really hold is not the hold's to cancel.
    if (!event.currentTarget.contains(event.target as Node)) return;
    suppressClickUntil.current = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(
    () => () => {
      clearLongPress();
      settleAnimation.current?.stop();
    },
    [],
  );

  // Keep the indicator fixed while its parent bubble moves away from it.
  const indicatorX = useTransform(x, (value) => -value);
  const indicatorOpacity = useTransform(
    x,
    options.mine ? [-REPLY_THRESHOLD_PX, -14, 0] : [0, 14, REPLY_THRESHOLD_PX],
    options.mine ? [1, 0.25, 0] : [0, 0.25, 1],
  );
  const indicatorScale = useTransform(
    x,
    options.mine ? [-REPLY_THRESHOLD_PX, -14, 0] : [0, 14, REPLY_THRESHOLD_PX],
    options.mine ? [1, 0.8, 0.65] : [0.65, 0.8, 1],
  );

  return {
    x,
    indicatorX,
    indicatorOpacity,
    indicatorScale,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
    },
  };
}
