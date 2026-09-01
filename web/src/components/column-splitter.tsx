import { useCallback, useEffect, useRef, type RefObject } from "react";
import { cn } from "~/lib/utils";

// The handle between two columns of a full-screen page: press it and the column beside it
// follows the pointer.
//
// **The drag writes a CSS VARIABLE, not React state, and that is the whole reason this is a
// component of its own.** The column it sizes is one of two beside a virtualized feed of
// highlighted code, so a `setState` per `pointermove` would re-render the page — and the feed with
// it — sixty times a second while the reader drags. Instead the host declares the width as a custom
// property on the element it and the columns share, this handle writes that property straight onto
// the DOM while the pointer is down, and the STORE is written once, at the end. React then renders
// the value that is already on screen, so there is no flash at the commit and no frame spent on the
// way there.
//
// Five rails hold the gesture, and every one of them is a bug this app has already had somewhere
// else (§ A COMPANION in a conversation, whose vendored engine states each in full):
//
//   - the grabbing `pointerId` is remembered, and every later handler is gated on it. Without it a
//     second finger's `pointermove` moves the column the first one is holding.
//   - only a PRIMARY press of button 0 starts a drag, so a right-click and a second touch start
//     nothing.
//   - `pointercancel` ends it as a CANCEL and puts the column back where it was. A gesture the
//     browser took away did not happen, so it must not leave behind a width nobody chose.
//   - a `pointerup` whose `button` is not 0 is ignored: right-clicking mid-drag fires one for the
//     same pointer.
//   - a release that never arrives is ended by the next PRIMARY press anywhere, from a
//     capture-phase listener — a mouse let go outside the window delivers no `pointerup` at all,
//     and a handle still holding the pointer would move the column on the reader's next click. It
//     is deliberately NOT keyed on the pointer id, because every touch gets a fresh one.
//
// **The target is deliberately NOT grown to 44 px**, which is the floor every other control in this
// app clears, and what is on either side of it is the reason: the file tree's own rows to one side,
// and the diff's line-NUMBER gutter to the other — and that gutter is the target of the comment
// gesture this whole page rests on (§ A comment on a diff LINE). A thumb-sized box here would steal
// presses from both. It is not a control a thumb needs either: it is drawn only where the page
// really has two columns to divide, which is a width no phone has (`diffColumnsAreResizable`), and
// that is the same argument which hides the unified/split toggle below `SPLIT_MIN_WIDTH`. What
// stands in for the touch target is the KEYBOARD — it is a real `separator`, it takes focus, and the
// arrows move it.

/** How far the arrows move the handle, and how far with Shift held.
 *
 *  A column is a couple of hundred pixels wide, so a 1 px step would be a control nobody could use
 *  — and the coarse step is what makes crossing that distance a press rather than a hold. */
const KEYBOARD_STEP = 16;
const KEYBOARD_COARSE_STEP = 64;

export type ColumnSplitterProps = {
  /** The element that DECLARES the width as a custom property — the one this writes during a drag.
   *  It is passed rather than found, so the contract between the host's layout and this gesture is
   *  explicit: sniffing for it in the DOM would break the day the host moved the declaration. */
  host: RefObject<HTMLElement | null>;
  /** The custom property's name, which the host and this must spell the same. */
  variable: string;
  /** The width right now, from the store: where a drag starts and what the keyboard moves. */
  width: number;
  /** The bounds the drag is held inside, computed by the page from the same constants
   *  `resolveDiffColumnWidths` uses — so the live drag and the drawn result cannot disagree about
   *  what is allowed. */
  min: number;
  max: number;
  /** Which way the column grows as the pointer moves right. The files column is `start` (it is left
   *  of the handle, so rightwards is wider); the occurrences panel is `end`. */
  side: "start" | "end";
  /** The width the reader settled on. Called ONCE per gesture, at the end — never per frame. */
  onCommit: (width: number) => void;
  /** What the handle is for, in words, since a one-pixel rule says nothing on its own. */
  label: string;
  testId: string;
};

export function ColumnSplitter(props: ColumnSplitterProps) {
  const handle = useRef<HTMLDivElement | null>(null);
  /** The pointer that owns this drag, the width it began from, where it began, and the last width
   *  it reached. One object, so a drag can never be half-started. */
  const drag = useRef<{ id: number; from: number; startedAt: number; latest: number } | null>(null);

  // Every handler below is registered on the document ONCE and reads the current props out of a
  // ref, which is the rule `DiffFeed` already follows for the callbacks it hands the renderer: a
  // new closure per render would re-register four document listeners on every keystroke elsewhere
  // in the page.
  const live = useRef(props);
  live.current = props;

  /** Draw a width without telling React. This is the whole of what happens per frame. */
  const paint = useCallback((width: number) => {
    const host = live.current.host.current;
    host?.style.setProperty(live.current.variable, `${width}px`);
  }, []);

  const clamp = useCallback((width: number) => {
    const { min, max } = live.current;
    return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
  }, []);

  /** End the drag: commit what the reader settled on, or put the column back for a gesture that was
   *  taken away. ONE ending for every way out, which is the rule the microphone's own release
   *  follows — a release wired per ending misses one. */
  const end = useCallback(
    (outcome: "commit" | "cancel") => {
      const held = drag.current;
      if (!held) return;
      drag.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      if (outcome === "cancel") {
        paint(held.from);
        return;
      }
      // The property is left where the drag put it and the store is told once, so React renders a
      // number that is already on screen and nothing moves at the handover.
      if (held.latest !== held.from) live.current.onCommit(held.latest);
    },
    [paint],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // A right-click and a second finger start nothing.
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      drag.current = {
        id: event.pointerId,
        from: live.current.width,
        startedAt: event.clientX,
        latest: live.current.width,
      };
      // The cursor and the text selection belong to the whole document while a drag is on: without
      // this, dragging across the code selects it and the cursor flickers between two shapes.
      document.body.style.setProperty("cursor", "col-resize");
      document.body.style.setProperty("user-select", "none");
      handle.current?.focus({ preventScroll: true });
    },
    [],
  );

  // The move, the release, and every way the gesture can be lost — on the DOCUMENT rather than on
  // the handle, because a pointer that has left a nine-pixel box is still dragging it.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const held = drag.current;
      // Gated on the id: a second finger is not this drag.
      if (!held || event.pointerId !== held.id) return;
      const travelled = event.clientX - held.startedAt;
      const width = clamp(held.from + (live.current.side === "start" ? travelled : -travelled));
      held.latest = width;
      paint(width);
    };
    const onUp = (event: PointerEvent) => {
      const held = drag.current;
      if (!held || event.pointerId !== held.id) return;
      // Right-clicking mid-drag fires a `pointerup` for the same pointer. It is not the release.
      if (event.button !== 0) return;
      end("commit");
    };
    const onCancel = (event: PointerEvent) => {
      const held = drag.current;
      if (!held || event.pointerId !== held.id) return;
      end("cancel");
    };
    const onLostRelease = (event: PointerEvent) => {
      const held = drag.current;
      if (!held || !event.isPrimary || event.pointerId === held.id) return;
      end("cancel");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("pointerdown", onLostRelease, true);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("pointerdown", onLostRelease, true);
    };
  }, [clamp, end, paint]);

  // A width the page re-resolved under us — the window narrowed, or the other panel opened — is
  // drawn while no drag is on. During one the pointer is the authority.
  useEffect(() => {
    if (!drag.current) paint(props.width);
  }, [paint, props.width]);

  const nudge = useCallback(
    (delta: number) => {
      const width = clamp(live.current.width + delta);
      if (width === live.current.width) return;
      paint(width);
      live.current.onCommit(width);
    },
    [clamp, paint],
  );

  return (
    <div
      ref={handle}
      data-testid={props.testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={props.width}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      title={props.label}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        const step = event.shiftKey ? KEYBOARD_COARSE_STEP : KEYBOARD_STEP;
        const grows = props.side === "start" ? 1 : -1;
        if (event.key === "ArrowLeft") nudge(-step * grows);
        else if (event.key === "ArrowRight") nudge(step * grows);
        else return;
        // The arrows belong to the handle while it has focus: without this they scroll the column
        // behind it, which is the one thing a reader resizing it is not asking for.
        event.preventDefault();
      }}
      className={cn(
        // One pixel of ink, and it IS the rule between the two columns — the columns beside it draw
        // no border of their own, so nothing here is a second line.
        "relative z-10 w-px shrink-0 cursor-col-resize touch-none self-stretch bg-border-subtle",
        "transition-colors hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none",
        // The hit area, grown with a pseudo-element so the ink stays one pixel — the technique the
        // dialog's close and the slider's thumb already use. Four pixels either side: enough that a
        // pointer finds it without aiming, small enough that the line numbers a centimetre to its
        // right still belong to the comment gesture. The module header says why it is not 44.
        "after:absolute after:inset-y-0 after:-inset-x-1 after:content-['']",
      )}
    />
  );
}
