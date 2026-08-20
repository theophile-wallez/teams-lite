// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PRESS_ECHO_GRACE_MS, claimPressEcho, releasePressEcho } from "./press-echo";

/**
 * The echo is what a browser sends after a hold's finger lifts. WebKit's carries a
 * `pointerdown` with `pointerType: "mouse"`, which every Radix layer reads as "a pointer went
 * down outside me" — so the menu a hold had just opened dismissed itself the instant the
 * reader let go. What is asserted here is the shape of the guard: the echo reaches nothing
 * while a hold owns the moment, a genuine new touch always does (it is how a reader closes a
 * menu), and the guard lets go on its own.
 */
function heard(event: PointerEvent): boolean {
  let seen = false;
  const listener = () => {
    seen = true;
  };
  // Where Radix listens: the document, in the bubble phase.
  document.addEventListener("pointerdown", listener);
  document.documentElement.dispatchEvent(event);
  document.removeEventListener("pointerdown", listener);
  return seen;
}

function pointerdown(pointerType: "mouse" | "touch"): PointerEvent {
  return new PointerEvent("pointerdown", { pointerType, bubbles: true, cancelable: true });
}

describe("press echo", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is heard by the layers when no hold is in flight", () => {
    expect(heard(pointerdown("mouse"))).toBe(true);
  });

  it("swallows the browser's mouse echo while the finger is still down", () => {
    claimPressEcho();
    expect(heard(pointerdown("mouse"))).toBe(false);
    releasePressEcho();
    vi.advanceTimersByTime(PRESS_ECHO_GRACE_MS + 1);
  });

  it("swallows it for a grace after the release, and then stops", () => {
    claimPressEcho();
    releasePressEcho();

    // The echo lands up to ~350 ms after the finger lifts.
    vi.advanceTimersByTime(PRESS_ECHO_GRACE_MS - 1);
    expect(heard(pointerdown("mouse"))).toBe(false);

    vi.advanceTimersByTime(2);
    expect(heard(pointerdown("mouse"))).toBe(true);
  });

  it("never swallows a real touch, which is how a reader dismisses what is open", () => {
    claimPressEcho();
    expect(heard(pointerdown("touch"))).toBe(true);
    releasePressEcho();
    vi.advanceTimersByTime(PRESS_ECHO_GRACE_MS + 1);
  });

  it("counts holds, so one release cannot uncover another's echo", () => {
    claimPressEcho();
    claimPressEcho();
    releasePressEcho();
    expect(heard(pointerdown("mouse"))).toBe(false);

    releasePressEcho();
    vi.advanceTimersByTime(PRESS_ECHO_GRACE_MS + 1);
    expect(heard(pointerdown("mouse"))).toBe(true);
  });

  it("ignores a release nothing claimed", () => {
    releasePressEcho();
    expect(heard(pointerdown("mouse"))).toBe(true);
  });
});
