"use client";

import { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — beautifului.dev's own, MIT.
 *
 * Fetched from their registry:
 *     npx shadcn add https://www.beautifului.dev/r/loading-state.json
 * which publishes `components/primitives/LoadingState.tsx`. This is that file: the 3×3
 * pixel grid and the chevron wavefront driving across it, the shimmering label beside it,
 * and the elapsed time in mono tabular figures. Every delay table, every duration and the
 * whole gradient are theirs.
 *
 * The pristine copy sits beside this one at `loading-state.vendor.txt`, so re-fetching the
 * registry item and diffing the two shows exactly what this app changed. That is the rule
 * `task-rows.tsx` already holds: keep the drawing, mark every divergence, and never let a
 * demo drive real data.
 *
 * FOUR MARKED PATCHES, and each says what it prevents.
 *
 *   PATCH 1 — the `Surfer` variant, its video and its third-party URL are GONE.
 *   PATCH 2 — the elapsed time comes from the RUN, not from the MOUNT.
 *   PATCH 3 — the label is the CALLER's.
 *   PATCH 4 — the DOM states it, and a hidden tab stops the clock.
 *
 * The tokens it draws with (`bg-ink`, `text-ink-3`, `var(--ink)` / `var(--ink-3)` read out of
 * a gradient) are THEIR names, and app.css maps every one onto this app's own. Their
 * `foundation.json` is deliberately NOT installed: it is a second palette, which is the
 * mistake § Project shape bans in another vocabulary.
 * ───────────────────────────────────────────────────────── */

/**
 * PATCH 1 — THE `Surfer` VARIANT IS GONE, and with it the `<video>`, the Vercel Blob URL it
 * played from, the `videoOk` state and the card it fell back to.
 *
 * Two reasons, and either alone settles it. It fetches a meme from somebody else's host,
 * and displaying this app makes NO network request to a third party — that is the read
 * receipt § Mail strips out of every message body, in another costume. And an autoplaying
 * video inside a virtualized chat history is not a loader: it is a mounted media element per
 * conversation, decoding frames behind whatever the reader has scrolled to.
 */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3),
    c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

type LoaderPattern = { delays: (number | null)[]; dur: number; round: boolean };

/** Theirs falls back with `PATTERNS[variant] ?? PATTERNS.Drive`, which this project's own
 *  `noUncheckedIndexedAccess` reads as two possible `undefined`s rather than one. The
 *  default is named instead — the same three patterns, the same numbers. */
const DRIVE: LoaderPattern = { delays: chevron, dur: 650, round: false };

const PATTERNS: Record<string, LoaderPattern> = {
  Drive: DRIVE,
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

function LoaderGrid({
  delays,
  dur,
  round,
}: {
  delays: (number | null)[];
  dur: number;
  round: boolean;
}) {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {delays.map((delay, index) => (
        <span
          key={index}
          className={`size-[4px] bg-ink ${round ? "rounded-full" : "rounded-[1px]"}`}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null ? "none" : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * PATCH 2 — THE ELAPSED TIME COMES FROM THE RUN, NOT FROM THE MOUNT.
 *
 * Theirs counts up from mount, which is the same thing in a gallery and not here: this
 * loader sits in a VIRTUALIZED history, so it is unmounted whenever its row scrolls away
 * and mounted again when it comes back — and a run's elapsed time would then reset to zero
 * under the reader, twice a scroll. It reads the wall clock against a moment the RUN owns
 * instead.
 *
 * `undefined` draws NOTHING rather than a zero: a run whose start this page cannot state is
 * one it must not put a number on (see `agentRunStartedAt`). That is the rule the review
 * page's own rows already hold — "a number nobody has yet draws NOTHING".
 *
 * PATCH 4 (half) — A HIDDEN TAB STOPS THE CLOCK. Theirs ticks ten times a second for as
 * long as it is mounted, whether or not anybody can see it. That is the rule this app's
 * chess clock already holds for itself, and this app is left open for days on a phone.
 */
function useElapsedSince(sinceMs: number | undefined): { ms: number; text: string | null } {
  const [, tick] = useState(0);
  const running = typeof sinceMs === "number" && sinceMs > 0;
  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setInterval(() => tick((n) => n + 1), 100);
    };
    start();
    if (typeof document === "undefined") return stop;
    document.addEventListener("visibilitychange", start);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", start);
    };
  }, [running]);
  if (!running) return { ms: 0, text: null };
  const ms = Math.max(0, Date.now() - sinceMs);
  const total = ms / 1000;
  const text = total < 60 ? `${total.toFixed(1)}s` : `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
  return { ms, text };
}

export default function LoadingState({
  /** PATCH 3 — THE LABEL IS THE CALLER's, and it may FOLLOW THE CLOCK. Theirs defaults to
   *  "Churning", which is a word about ice cream and not about whatever the caller is really
   *  waiting on.
   *
   *  A function is passed the elapsed milliseconds, which is what lets a label turn its own
   *  wording over as a long wait grows (`agentWaitingLabel`). It has to be resolved HERE
   *  rather than by the caller because the clock this hook keeps is the only one: a caller
   *  ticking its own interval to re-render a string would be a second timer for one moment,
   *  and this loader is mounted per conversation. */
  label,
  /** When the work started, in epoch ms — or `undefined` for work whose start is not known,
   *  which draws no time at all (PATCH 2). */
  sinceMs,
  variant = "Drive",
  /** PATCH 4 — THE DOM STATES IT. Theirs carries `role="status"` and nothing else, so
   *  neither a spec nor a capture could find the loader or read its label. */
  testId = "loading-state",
  labelTestId,
  /** Whether this loader is its own live region. Theirs always is, which is right for a
   *  loader standing on its own — and wrong where the caller is ALREADY one: nested live
   *  regions announce the same line twice, which is the same defect `thinking-state.tsx`'s
   *  own PATCH 6 removes from its header. The panel this is drawn in is `role="status"` for
   *  as long as a run is live, so it passes `false`; the vendor's behaviour is the default. */
  announce = true,
  /** The STABLE sentence assistive tech is given for the label, where the visible one turns
   *  over. Without it a live region re-announces every new wording — one sentence every few
   *  seconds for as long as the wait lasts — which is noise rather than news: the FACT does
   *  not change, only the word for it. Theirs has no such split, because its label is a
   *  constant. */
  ariaLabel,
  className,
}: {
  label: string | ((elapsedMs: number) => string);
  sinceMs?: number;
  variant?: string;
  testId?: string;
  labelTestId?: string;
  announce?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const elapsed = useElapsedSince(sinceMs);
  const words = typeof label === "function" ? label(elapsed.ms) : label;
  const { delays, dur, round } = PATTERNS[variant] ?? DRIVE;

  return (
    <div
      data-testid={testId}
      role={announce ? "status" : undefined}
      className={`flex min-w-0 items-center gap-2.5${className ? ` ${className}` : ""}`}
    >
      <LoaderGrid delays={delays} dur={dur} round={round} />
      <span
        data-testid={labelTestId}
        aria-label={ariaLabel}
        // `beautifului-shimmer`: see the note beside the same class in `thinking-state.tsx`.
        className="beautifului-shimmer min-w-0 truncate bg-clip-text text-[13px] font-medium text-transparent"
        style={{
          backgroundImage:
            "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
          backgroundSize: "200% 100%",
          animation: "shimmer-text 1.4s linear infinite",
        }}
      >
        {words}
      </span>
      {elapsed.text ? (
        <span
          data-testid="loading-state-elapsed"
          className="shrink-0 font-mono text-[12px] text-ink-3 tabular-nums"
        >
          {elapsed.text}
        </span>
      ) : null}
    </div>
  );
}
