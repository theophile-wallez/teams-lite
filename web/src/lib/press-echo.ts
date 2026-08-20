/**
 * The browser's own ECHO of a hold, swallowed while the hold owns the moment.
 *
 * A hold opens something — the message actions menu, a chat row's Teams settings, what an
 * update brings — from a timer, WHILE the finger is still down. Every browser then sends a
 * compatibility mouse sequence once that finger lifts, and WebKit's carries a
 * **`pointerdown` of its own** (`pointerType: "mouse"`, at the point the finger was). Every
 * Radix layer listens for exactly that on the document and reads it as "a pointer went down
 * outside me", so the surface the hold had just opened dismissed itself the moment the
 * reader let go: on a phone the menu was a flash nobody could act on, and the "…" was left
 * behind holding the focus Radix restored to it. That is the whole of the reported bug —
 * "I cannot long press a message to react to it".
 *
 * Chromium's compatibility sequence carries `mousedown`/`click` and NO pointerdown, which is
 * why every test in this repo passed while a real iPhone got nothing: the engine the app is
 * read on is the one engine the suite cannot drive. `web/e2e/mobile.spec.ts` therefore sends
 * that pointerdown itself.
 *
 * So the echo is stopped where it arrives, once, for every hold in the app rather than at
 * each surface a hold can open: a capture listener on the document runs before anything
 * else sees the event, and only a `pointerType: "mouse"` pointerdown is stopped — a real new
 * touch still dismisses what is open, which is how a reader closes a menu. The window is the
 * hold itself plus a grace, because the echo lands up to ~350 ms after the finger lifts.
 */

import { useEffect, useRef } from "react";

/** How long after the finger lifts the browser's echo can still arrive. */
export const PRESS_ECHO_GRACE_MS = 700;

let holds = 0;
let graceUntil = 0;
let listening = false;
let graceTimer: ReturnType<typeof setTimeout> | null = null;

function owned(): boolean {
  return holds > 0 || Date.now() < graceUntil;
}

/** The two events the echo opens with. Both are needed, and for different reasons — measured
 *  in `web/e2e/mobile.spec.ts` on both surfaces a hold opens something on:
 *  - `pointerdown`, which every Radix layer dismisses on when it lands outside;
 *  - `mousedown`, whose DEFAULT is what moves focus to the element under the finger — so the
 *    menu lost focus to the row behind it and was dismissed as "focus went outside me", half a
 *    second after the reader let go, with no pointer event involved at all. */
const ECHO_EVENTS = ["pointerdown", "mousedown"] as const;

function swallow(event: Event): void {
  if (!owned()) return;
  // A genuine new touch is how a reader dismisses what is open — only the mouse sequence the
  // browser synthesizes for a touch it has already delivered is the echo.
  if (event instanceof PointerEvent && event.pointerType !== "mouse") return;
  event.stopPropagation();
  event.stopImmediatePropagation();
  // The focus move is a DEFAULT action, so stopping the event is not enough to keep it.
  if (event.cancelable) event.preventDefault();
}

function listen(): void {
  if (listening) return;
  for (const type of ECHO_EVENTS) document.addEventListener(type, swallow, true);
  listening = true;
}

function stopListening(): void {
  if (!listening) return;
  for (const type of ECHO_EVENTS) document.removeEventListener(type, swallow, true);
  listening = false;
}

/** A hold has fired: from now until the finger lifts, plus a grace, the browser's echo of
 *  it belongs to it and reaches nothing. */
export function claimPressEcho(): void {
  if (typeof document === "undefined") return;
  holds += 1;
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = null;
  graceUntil = 0;
  listen();
}

/** The finger lifted (or the surface went away mid-hold). The grace starts here rather than
 *  at the hold, because a reader who holds for three seconds still gets the echo on
 *  release — a window measured from the hold itself had long expired by then. */
export function releasePressEcho(): void {
  if (holds === 0) return;
  holds -= 1;
  if (holds > 0) return;
  graceUntil = Date.now() + PRESS_ECHO_GRACE_MS;
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = setTimeout(() => {
    graceTimer = null;
    graceUntil = 0;
    stopListening();
  }, PRESS_ECHO_GRACE_MS);
}

/**
 * The pair above, balanced: one claim per hold, released on the finger lifting and again if
 * the component goes away mid-hold — a surface unmounted while held would otherwise leave
 * the echo swallowed for good. Used by both hold hooks, so the counting lives once.
 */
export function usePressEcho(): { claim: () => void; release: () => void } {
  const held = useRef(false);
  const release = useRef(() => {
    if (!held.current) return;
    held.current = false;
    releasePressEcho();
  }).current;
  const claim = useRef(() => {
    if (held.current) return;
    held.current = true;
    claimPressEcho();
  }).current;
  useEffect(() => () => release(), [release]);
  return { claim, release };
}
