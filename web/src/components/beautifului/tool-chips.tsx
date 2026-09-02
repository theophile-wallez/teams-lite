"use client";

import { FadeArc } from "../loading-ui/fade-arc";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS — beautifului.dev's own, MIT.
 *
 * Fetched from their registry:
 *     npx shadcn add https://www.beautifului.dev/r/tool-chips.json
 * which publishes `components/primitives/ToolChips.tsx`. This is that file's ROW: the
 * 16px glyph slot, the glyph per tool kind, the label at 12.5px medium, and the target
 * in a hairlined `bg-field` chip at 11.5px — every size, radius and colour in it is
 * theirs.
 *
 * The pristine copy sits beside this one at `tool-chips.vendor.txt`, so re-fetching the
 * registry item and diffing the two shows exactly what this app changed. That is the rule
 * `task-rows.tsx` already holds, and `web/src/vendor/desksprite.ts` before it: keep the
 * drawing, mark every divergence, and never let a demo drive real data.
 *
 * FIVE MARKED PATCHES, and each says what it prevents.
 *
 *   PATCH 1 — a REAL `running`, and the glyph IS the finished state.
 *   PATCH 2 — the scripted demo is GONE.
 *   PATCH 3 — the ROW is exported; the widget's own shell is not.
 *   PATCH 4 — the file-diff chips and their hover portal are GONE.
 *   PATCH 5 — the DOM states which row is in which state.
 *
 * The tokens it draws with (`text-ink`, `text-ink-3`, `bg-field`, `rounded-chip`,
 * `shadow-hairline`) are THEIR names, and app.css maps every one onto this app's own — so
 * a row follows the appearance setting with nothing in this file knowing about it. Their
 * `foundation.json` is deliberately NOT installed: it is a second palette, which is the
 * mistake § Project shape bans in another vocabulary.
 * ───────────────────────────────────────────────────────── */

/**
 * PATCH 4 — THE FILE-DIFF CHIPS AND THEIR HOVER PORTAL ARE GONE, and `createPortal` /
 * `react-dom` with them.
 *
 * Their widget ends with a row of `file +74 −41` chips, each opening a fixed-position diff
 * preview on hover. An `AgentStep` of kind `tool` carries `{tool, target, done}` and
 * nothing else (`agent_step_json` in src/bin/server.rs): there is no diff on the wire at
 * all, so those chips would need data the backend does not send — and inventing it is
 * exactly what this app refuses to do everywhere else. Their `detail` lines went the same
 * way and for the same reason, which also takes the row's own expansion: a control that
 * changes nothing reads as a bug.
 *
 * If the wire ever grows a diff per call, drawing it is a deliberate feature with a recon
 * behind it — not a quiet un-deletion of this block.
 */

/** The glyph a call's KIND is drawn with. Their four, their paths, their names. */
export type ToolChipGlyph = "think" | "write" | "run" | "read";

const GLYPHS: Record<ToolChipGlyph, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </g>
  ),
  run: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 17l6-5-6-5M12 19h8" />
    </g>
  ),
  read: (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </g>
  ),
};

/**
 * PATCH 3 — THE ROW IS EXPORTED; THE WIDGET'S OWN SHELL IS NOT.
 *
 * Their default export is a self-contained widget: a collapsed run header, its own list of
 * rows, and the diff chips PATCH 4 removed. This app's transcript INTERLEAVES reasoning and
 * tool calls in the order they happened — that order is the whole of what `agent::Step`
 * carries over a pair of lists, since the reasoning that led to a call sits above it and the
 * reasoning that followed it below — so the PANEL owns the list and this file owns one row.
 * The header their shell drew is `thinking-state.tsx`'s, which is where the panel's own comes
 * from.
 *
 * PATCH 2 — THE SCRIPTED DEMO IS GONE: `STEP_MS`, the `step` counter that revealed one row
 * every 700 ms, and the `ROWS` / `DIFFS` / `DIFF_LINES` sample data. A timer that reveals
 * rows is right for a gallery and a lie on a surface reporting a real run — the rows are the
 * caller's now, and nothing here animates on its own except the entry, which is theirs.
 */
export function ToolChipRow(props: {
  glyph: ToolChipGlyph;
  /** What was called — `Grep`, `Read`. */
  label: string;
  /** What it was pointed at, or "" for a tool that takes nothing. */
  chip?: string;
  /** PATCH 1 — A REAL `running`, AND THE GLYPH IS THE FINISHED STATE.
   *
   *  Their rows have no status at all: every one in the demo had already finished. A
   *  transcript's whole job is to say whether the wait the reader is in is THIS call's
   *  fault, so the row takes one — and the two marks share the 16px slot their glyph
   *  stands in, which is where a status belongs.
   *
   *  `running` draws the app's OWN loader (`FadeArc`), not a second spinner shape: it is
   *  "the app's one loader, and the one turn every spinner in it makes", and beautifului's
   *  sibling `thinking-state` ships a bordered-circle spinner that would put two of them a
   *  centimetre apart inside one bubble. `done` draws the tool's own glyph, which says what
   *  the call WAS where a generic tick would only say that it ended. */
  running?: boolean;
  /** Whether this row ARRIVED rather than being one the panel opened with. Their widget
   *  staggers every row by `i * 80ms` off its own index, which in a remounted panel replays
   *  the whole list as a cascade; the caller already decides which rows animate in and which
   *  ride its own collapse, and it does it for a stated reason. */
  entering?: boolean;
  /** PATCH 5 — THE DOM STATES WHICH ROW IS IN WHICH STATE. Theirs carry `aria-expanded`
   *  and nothing else, so neither a spec nor a capture could read a row without inferring
   *  it from a colour. These are the two the row this replaces already published, so every
   *  assertion and every capture keeps meaning what it meant. */
  testId?: string;
  className?: string;
}) {
  const { running = false } = props;
  return (
    <span
      data-testid={props.testId ?? "tool-chip-row"}
      data-done={!running}
      className={`flex h-7 min-w-0 max-w-full items-center gap-2 self-start text-left${
        props.className ? ` ${props.className}` : ""
      }`}
      style={
        props.entering
          ? { animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }
          : undefined
      }
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
        {running ? (
          <FadeArc className="size-3.5" aria-hidden />
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill={props.glyph === "think" ? "currentColor" : "none"}
            stroke="currentColor"
            aria-hidden
          >
            {GLYPHS[props.glyph]}
          </svg>
        )}
      </span>
      <span className="shrink-0 text-[12.5px] font-medium text-ink">{props.label}</span>
      {props.chip ? (
        <span className="inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-1.5 font-mono text-[11.5px] text-ink-2 shadow-hairline">
          {props.chip}
        </span>
      ) : null}
    </span>
  );
}
