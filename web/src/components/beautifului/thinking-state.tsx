"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * THINKING — beautifului.dev's own, MIT.
 *
 * Fetched from their registry:
 *     npx shadcn add https://www.beautifului.dev/r/thinking-state.json
 * which publishes `components/primitives/ThinkingState.tsx`. This is that file's HEADER
 * (the sparkle, the shimmering label, the chevron), its TRACE (the measured guide rail and
 * the row list hanging off it) and its `Reasoning` ROW — every size, curve, gradient and
 * offset in them is theirs.
 *
 * The pristine copy sits beside this one at `thinking-state.vendor.txt`, so re-fetching the
 * registry item and diffing the two shows exactly what this app changed. That is the rule
 * `task-rows.tsx` already holds: keep the drawing, mark every divergence, and never let a
 * demo drive real data.
 *
 * SIX MARKED PATCHES, and each says what it prevents.
 *
 *   PATCH 1 — the scripted demo is GONE.
 *   PATCH 2 — three of the four VARIANTS are gone.
 *   PATCH 3 — `working` and `expanded` come from the CALLER.
 *   PATCH 4 — the rail is OBSERVED, not measured on a render.
 *   PATCH 5 — the COLLAPSE is the caller's; only the TRACE is theirs.
 *   PATCH 6 — no `role="status"`, and no fade on the settled label.
 *
 * The tokens it draws with (`rounded-control`, `hover:bg-hover-2`, `bg-line`, `text-ink-2`,
 * `var(--ink)` / `var(--ink-2)` / `var(--ink-3)` read straight out of an SVG fill) are THEIR
 * names, and app.css maps every one onto this app's own. Their `foundation.json` is
 * deliberately NOT installed: it is a second palette, which is the mistake § Project shape
 * bans in another vocabulary.
 * ───────────────────────────────────────────────────────── */

/**
 * PATCH 1 — THE SCRIPTED DEMO IS GONE: `STAGES`, `useSequence`, the `stage` counter that
 * drove `working` / `autoExpanded` / how many rows were `visible`, the `settledRef` that
 * fired `onSettled` off it, and the `minHeight: 176` that reserved room for the script to
 * play into.
 *
 * It flipped a trace from "Thinking" to "Thought for 4 seconds" 4 s after mount whatever
 * was really happening, which is right for a gallery and a lie on a surface reporting a run
 * that can take an hour (`agent::RUN_IDLE_TIMEOUT`). A run's own phase is the input now
 * (PATCH 3), so nothing here animates on its own except the rail, the chevron and a row
 * entering — all three theirs.
 *
 * PATCH 2 — THREE OF THE FOUR VARIANTS ARE GONE. `VARIANTS` and its sample rows with them.
 *
 * The transcript's rows are REASONING and TOOL CALLS, and those are two components rather
 * than two variants of one: a call is `tool-chips.tsx`'s row. So `Coding` is a second
 * drawing of something already drawn, `Search` is a web-search trace this app has none of
 * (`Dot`, `TONES` and their `animated-underline` go with it), and `Steps` is a checklist a
 * run does not publish. What is left is `Reasoning`, which is the one the model's own
 * reasoning is: prose that wraps.
 */

/**
 * The header of a trace: what is being worked out, and the fold.
 *
 * PATCH 3 — `working` AND `expanded` COME FROM THE CALLER. Theirs are derived from the
 * demo's clock, so a caller with a real run could not say one was still going — and the
 * fold policy here is the panel's own (open for the run, folded once when it ends, the
 * reader's from then on), held per message because this component is remounted when the run
 * is let go and again on every pass of a virtualized history.
 *
 * PATCH 6 — NO `role="status"`, AND NO FADE ON THE SETTLED LABEL. Theirs wraps the label in
 * a `role="status"` span; the panel that draws this header is already one live region while
 * the run is live, and two of them announce the same line twice. And their settled label
 * carries `fade-in 350ms` on mount — in a virtualized history that replays every time the
 * row scrolls back into view, which is the defect the panel's own `entering` rule exists to
 * avoid. The shimmer stays, because it runs for as long as the state it reports does.
 */
export function ThinkingHeader(props: {
  label: string;
  /** Whether something is still arriving. Their `working`: it shimmers the label and fills
   *  the sparkle with the brighter ink. */
  working: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** A header with NOTHING behind it is not a control: a run whose CLI reports no reasoning
   *  and has called nothing has only this line to show. Theirs is always a button, because
   *  the demo always had a trace. */
  disabled?: boolean;
  /** Their button is `w-fit`; here it shares its row with a Stop button, so the width is
   *  the caller's. */
  className?: string;
  testId?: string;
  labelTestId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      disabled={props.disabled}
      aria-expanded={props.disabled ? undefined : props.expanded}
      onClick={props.onToggle}
      className={`-mx-1.5 flex items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-100${
        props.disabled ? "" : " hover:bg-hover-2"
      }${props.className ? ` ${props.className}` : ""}`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill={props.working ? "var(--ink-2)" : "var(--ink-3)"}
        className="shrink-0"
        aria-hidden
      >
        <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
      </svg>
      {props.working ? (
        <span
          data-testid={props.labelTestId}
          // `beautifului-shimmer` is the app's own hook for `prefers-reduced-motion`: the
          // sweep is what paints these words at all, so app.css puts the ink back rather
          // than freezing a bright stripe across them.
          className="beautifului-shimmer min-w-0 truncate bg-clip-text text-[13px] font-medium text-transparent"
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
            backgroundSize: "200% 100%",
            animation: "shimmer-text 1.4s linear infinite",
          }}
        >
          {props.label}
        </span>
      ) : (
        <span
          data-testid={props.labelTestId}
          className="min-w-0 truncate text-[13px] font-medium text-ink-2"
        >
          {props.label}
        </span>
      )}
      {props.disabled ? null : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-3)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 transition-transform duration-300"
          style={{ transform: props.expanded ? "rotate(180deg)" : "rotate(0)" }}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      )}
    </button>
  );
}

/** `useLayoutEffect` in the browser, `useEffect` on the server (where there is no layout to
 *  read and React warns about the hook) — the shape `rich-editor.tsx` and
 *  `calendar-event-popover.tsx` already carry in this app. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The trace itself: the guide rail, and the rows hanging off it.
 *
 * PATCH 4 — THE RAIL IS OBSERVED, NOT MEASURED ON A RENDER. Their `useLayoutEffect` reads
 * `offsetHeight` with the demo's own clock in its dependency list, which is enough when a
 * row either exists or does not. Here the last row GROWS: a thought is revealed word by
 * word inside its own component and re-renders nothing above it, so a height measured on
 * this component's renders would stop a third of the way down the reasoning it is meant to
 * run beside. A `ResizeObserver` is the mechanism that cannot go stale, and it is the one
 * `useEdgePaths` already uses for the pipeline graph's own geometry.
 *
 * PATCH 5 — THE COLLAPSE IS THE CALLER'S; ONLY THE TRACE IS THEIRS. Their wrapper is a
 * single `grid 0fr → 1fr` transition that moves the height and the opacity at one speed in
 * both directions. This panel's two rules are argued where they are spelled — a close
 * shorter than the open, and an opacity quicker than the height and LED by it, so the rows
 * are only legible inside a box with room for them — so the caller keeps its own collapse
 * and this draws what is inside it.
 */
export function ThinkingTrace(props: { children: React.ReactNode; className?: string }) {
  const trace = useRef<HTMLDivElement | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  useIsomorphicLayoutEffect(() => {
    const el = trace.current;
    if (!el) return;
    const read = () => setRailHeight(el.offsetHeight);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`relative mt-1 ml-[5px] pl-4${props.className ? ` ${props.className}` : ""}`}>
      <span
        aria-hidden
        data-testid="thinking-rail"
        className="absolute left-[3px] w-px bg-line"
        style={{
          top: -8,
          height: railHeight ? railHeight - 2 : 0,
          transition: "height 500ms cubic-bezier(0.23,1,0.32,1)",
        }}
      />
      <div ref={trace} className="flex flex-col gap-1 py-1">
        {props.children}
      </div>
    </div>
  );
}

/**
 * One stretch of reasoning — their `Reasoning` row: prose that wraps, at 12.5px in the
 * dimmer ink, inside the row shell every variant of theirs shares.
 *
 * `entering` is the caller's (PATCH 3 again): theirs staggers every row by `i * 120ms` off
 * the demo's index, which in a remounted panel replays the whole trace as a cascade and
 * delays the newest line by as many beats as there are rows above it. The panel already
 * decides which rows animate in and which ride its own collapse, and it does it for a
 * stated reason.
 */
export function ThinkingReasoning(props: {
  children: React.ReactNode;
  entering?: boolean;
  testId?: string;
}) {
  return (
    <div
      data-testid={props.testId}
      className="flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left"
      style={
        props.entering
          ? { animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }
          : undefined
      }
    >
      <span className="min-w-0 truncate whitespace-normal break-words text-[12.5px] leading-relaxed text-ink-2">
        {props.children}
      </span>
    </div>
  );
}
