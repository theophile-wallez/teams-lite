"use client";

import { useState } from "react";

/* ─────────────────────────────────────────────────────────
 * TASK ROWS — beautifului.dev § 06, MIT.
 *
 * Fetched from their own registry:
 *     npx shadcn add https://www.beautifului.dev/r/task-rows.json
 * which publishes `components/primitives/TaskRows.tsx`. This is that file: the
 * capsules, the spinner ring, the badges, the status pill, the chevron, the
 * `0fr → 1fr` expansion and every number and curve in it are theirs.
 *
 * `/tmp` is not a home for a vendored file, so the pristine copy lives beside
 * this one at `task-rows.vendor.txt` — re-fetch the registry item and diff the
 * two to see exactly what this app changed.
 *
 * FOUR MARKED PATCHES, and each says what it prevents. The rule is the one
 * `web/src/vendor/desksprite.ts` already holds for a vendored engine: keep the
 * drawing, mark every divergence, and never let a demo drive real data.
 *
 *   PATCH 1 — a REAL `failed`, and a REAL `pending`.
 *   PATCH 2 — the scripted demo is GONE.
 *   PATCH 3 — `open` comes from the row.
 *   PATCH 4 — the DOM states which row is in which state.
 *
 * The tokens it draws with (`--line`, `--ink-3`, `bg-surface`, `text-ink-2`,
 * `bg-green-tint`, `rounded-card`, …) are THEIR names, and app.css maps every
 * one onto this app's own so the component follows the appearance setting —
 * the seam `@pierre/diffs` already has, where the vendor keeps its vocabulary
 * and this app decides what the colours are. Their `foundation.json` is
 * deliberately NOT installed: it is a second palette, which is the mistake
 * § Project shape bans in another vocabulary.
 * ───────────────────────────────────────────────────────── */

/* PATCH 2 — THE SCRIPTED DEMO IS GONE: `TICKS`, `useTick`, the `row2` state it
 * drove and the `TASK_ROWS` sample data. It flipped row 2 to Failed 3.9 s after
 * mount and resolved it at 5.3 s, which is exactly right for a gallery and a lie
 * on a surface reporting a real run — and a timer that can draw "Failed" over
 * work that is going fine is not something to leave one prop away. The states
 * are inputs now (PATCH 1), so nothing here animates on its own except the
 * entry, the ring and the expansion, which are all theirs. */

function SpinnerRing({ active, children }: { active?: boolean; children?: React.ReactNode }) {
  const size = 24,
    stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        className="absolute inset-0"
        style={active ? { animation: "spin 1.1s linear infinite" } : undefined}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        {active && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * 0.28} ${c * 0.72}`}
          />
        )}
      </svg>
      <span className="relative text-[10.5px] font-semibold tabular-nums text-ink">{children}</span>
    </span>
  );
}

function Badge({ tone, children }: { tone: "red" | "green"; children: React.ReactNode }) {
  return (
    <span
      className={`flex size-5.5 shrink-0 items-center justify-center rounded-full text-white
        ${tone === "red" ? "bg-red" : "bg-green"}`}
      style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {children}
    </span>
  );
}

const XIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3.5"
    strokeLinecap="round"
  >
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
const CheckIcon = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/* One detail line shown when a task row is expanded. */
export type TaskDetail = { label: string; meta: string };

/* PATCH 1 — A REAL `failed`, AND A REAL `pending`.
 *
 * Theirs is `"done" | "running" | "sequence"`, where `sequence` is the canned
 * animation PATCH 2 removed — so a real failure had no way in at all, and a step
 * that has not STARTED had none either (their pending look is the inactive ring,
 * which only the demo ever reached).
 *
 * Both are what this surface is for: a reading that stopped has to say WHERE it
 * stopped, and the steps still to come have to be visible, or a reader cannot
 * tell how much is left. The four are drawn exactly as their own three were —
 * inactive ring, active ring, green check, red cross. */
export type TaskRowStatus = "pending" | "running" | "done" | "failed";

/* A single task row.
 *  - "pending" → the ring, still (nothing has started)
 *  - "running" → the ring, sweeping, showing `step`
 *  - "done"    → green check badge + completed pill
 *  - "failed"  → red cross badge + failed pill
 */
export type TaskRow = {
  key: string;
  label: string;
  amount: string;
  status: TaskRowStatus;
  step?: number;
  details: TaskDetail[];
  /* PATCH 3 — `open` COMES FROM THE ROW.
   *
   * Theirs opened `row.key === "index" && tick === 2` — the demo's own second
   * row, at the moment its script said so. A caller with real rows could not
   * open any of them, and the row a reader is waiting in front of is exactly the
   * one whose detail they want. A manual press still wins from then on, which is
   * their own `manualOpen` rule unchanged. */
  defaultOpen?: boolean;
};

export type TaskRowsLabels = {
  completed: string;
  failed: string;
};

const DEFAULT_LABELS: TaskRowsLabels = {
  completed: "Completed",
  failed: "Failed",
};

export default function TaskRows({
  variant = "Capsules",
  rows,
  labels,
  className,
  onToggleRow,
  /* PATCH 4 — the DOM STATES which row is in which state. Their rows carry
   * `aria-expanded` and nothing else, so neither a spec nor a capture can read a
   * row's state without inferring it from a colour. `data-testid` / `data-state`
   * is the sentinel discipline `data-conversation-id` and `data-path` already
   * hold on this page's neighbours. */
  testId = "task-rows",
}: {
  variant?: string;
  rows: TaskRow[];
  labels?: Partial<TaskRowsLabels>;
  className?: string;
  onToggleRow?: (key: string, open: boolean) => void;
  testId?: string;
}) {
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});
  const copy = { ...DEFAULT_LABELS, ...labels };

  const badgeFor = (row: TaskRow) => {
    if (row.status === "done") return <Badge tone="green">{CheckIcon}</Badge>;
    if (row.status === "failed") return <Badge tone="red">{XIcon}</Badge>;
    if (row.status === "running") return <SpinnerRing active>{row.step}</SpinnerRing>;
    return <SpinnerRing>{row.step}</SpinnerRing>;
  };

  const pillFor = (row: TaskRow) => {
    if (row.status === "done")
      return (
        <span className="inline-flex h-5.5 items-center rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green">
          {copy.completed}
        </span>
      );
    if (row.status === "failed")
      return (
        <span
          className="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-red-tint px-2 text-[11.5px] font-medium text-red"
          style={{ animation: "fade-in 200ms ease-out both" }}
        >
          {copy.failed}
        </span>
      );
    return null;
  };

  const list = variant === "List";
  return (
    <div
      data-testid={testId}
      className={`flex w-full max-w-110 flex-col ${
        list
          ? "gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card"
          : "min-h-[196px] gap-2"
      }${className ? ` ${className}` : ""}`}
    >
      {rows.map((row, i) => {
        const open = manualOpen[row.key] ?? row.defaultOpen ?? false;
        return (
          <div
            key={row.key}
            data-testid="task-row"
            data-task-id={row.key}
            data-state={row.status}
            className={`self-stretch overflow-hidden transition-[border-radius,background-color] duration-300 hover:bg-inset ${
              list ? "border-b border-line last:border-0" : "bg-surface shadow-card"
            }`}
            style={{
              borderRadius: list ? 0 : open ? 14 : 22,
              animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
            }}
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                setManualOpen((current) => ({ ...current, [row.key]: !open }));
                onToggleRow?.(row.key, !open);
              }}
              className="flex h-11 w-full items-center gap-2.5 px-2.5 text-left"
            >
              <span className="flex size-6 shrink-0 items-center justify-center">
                {badgeFor(row)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                {row.label}
              </span>
              <span data-testid="task-row-value" className="text-[12.5px] text-ink-2 tabular-nums">
                {row.amount}
              </span>
              {pillFor(row)}
              <span
                aria-hidden="true"
                className="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-transform duration-300"
                  style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {/* dropdown detail — same expandable grammar as Chain of Thought */}
            <div
              className="grid transition-[grid-template-rows,opacity] duration-300"
              style={{
                gridTemplateRows: open ? "1fr" : "0fr",
                opacity: open ? 1 : 0,
                transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
              }}
            >
              <div className="overflow-hidden">
                <div className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
                  <span aria-hidden className="mx-auto h-full w-px bg-line" />
                  <div className="flex flex-col gap-1.5">
                    {row.details.map((d, j) => (
                      <div
                        key={d.label}
                        data-testid="task-step"
                        className="flex items-center justify-between"
                        style={
                          open
                            ? {
                                animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both`,
                              }
                            : undefined
                        }
                      >
                        <span className="text-[12px] text-ink-2">{d.label}</span>
                        <span
                          data-testid="task-step-value"
                          className="font-mono text-[11.5px] text-ink-3 tabular-nums"
                        >
                          {d.meta}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
