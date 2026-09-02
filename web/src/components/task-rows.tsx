// TASK ROWS — what a long piece of work is doing, while it does it.
//
// A numbered stack of steps, each with a title, a value at its right, and its own sub-steps carrying
// a value apiece. A step that is running says so; one that has finished trades its number for a
// mark; one that failed says which one it was. It is after the "Task Rows" pattern at
// beautifului.dev (§ 06 — "Live agent task status: running, failed, completed"), which publishes no
// source, so the shape is theirs and every line here is this app's own.
//
// **IT DRAWS WHAT IT IS GIVEN AND DECIDES NOTHING.** Every state and every value arrives as a prop.
// That is the split `message-bubble.tsx` holds against `message-pane.tsx` and `chess-board.tsx`
// against `use-chess-game.ts`, and it is what lets the one caller's mapping
// (`reviewRunRows`, over the backend's own frames) be unit-tested with no browser and no
// AI review anywhere near it — the rows are the drawing, the meaning is upstream.
//
// **THERE IS ONE PRESENTATION, NOT TWO.** The reference offers a switch between "Capsules" and
// "List" shapes; a switch is how a gallery lets somebody choose, and an app that drew both would be
// asking the reader to pick a look for a thing they are only waiting on. The list is the one taken,
// because the surface that needs it is a DOCUMENT page: a column of prose and code, whose rows read
// as part of it rather than as tiles floating over it.
//
// **NOTHING HERE IS A PERCENTAGE.** There is no bar and no proportion in the vocabulary at all, and
// that is deliberate rather than missing: a caller with a real fraction is welcome to put it in a
// `value`, and one without must not be handed a component that invites it to invent one. The one
// caller today measures bytes and counts, and cannot know either total in advance.

import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "~/lib/utils";

/** What one step of the work is doing.
 *
 *  FOUR rather than a boolean, and each one is a different sentence for the reader: `pending` has not
 *  started, `running` is where they are waiting, `done` happened, and `failed` is the one that needs
 *  them. Collapsing `pending` and `running` is what makes a list of steps unreadable — it is the
 *  reason § A SEALED chat gives for its own four outcomes. */
export type TaskState = "pending" | "running" | "done" | "failed";

/** One sub-step: a line of its own under a row, with its own value. */
export type TaskStep = {
  id: string;
  label: string;
  /** The fact this step produced, or `null` while there is none. NEVER a placeholder: a dash or a
   *  zero standing in for a number nobody has yet is a claim, and a blank is not. */
  value?: string | null;
  state: TaskState;
};

/** One row: a numbered piece of work, with a value and its own steps. */
export type TaskRow = {
  id: string;
  title: string;
  value?: string | null;
  state: TaskState;
  steps: TaskStep[];
};

/** How long a row takes to arrive, and the gap between one row and the next.
 *
 *  A stagger rather than one movement, because the rows are a SEQUENCE and arriving together says
 *  they are a block. It is short: this appears at the moment somebody pressed a button, so anything
 *  slower than the press feels like the app hesitating. */
const ROW_SECONDS = 0.22;
const ROW_STAGGER = 0.05;

/** The stack, drawn.
 *
 *  `label` names the whole of it for a screen reader, and the region is polite-live: a reader who is
 *  not looking at it is told when a step finishes, and never interrupted mid-sentence to hear it. */
export function TaskRows(props: {
  rows: TaskRow[];
  label: string;
  className?: string;
  "data-testid"?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <ol
      data-testid={props["data-testid"] ?? "task-rows"}
      aria-label={props.label}
      // POLITE, and it is the only honest setting: an assertive region would cut across whatever the
      // reader is being read at every stage of a run that lasts minutes.
      aria-live="polite"
      className={cn("flex flex-col gap-1", props.className)}
    >
      {props.rows.map((row, index) => (
        <motion.li
          key={row.id}
          data-testid="task-row"
          data-task-id={row.id}
          // The STATE is on the element, so a spec and a capture read what the row is rather than
          // inferring it from a colour — the sentinel discipline `data-path` and
          // `data-conversation-id` already hold on this page's neighbours.
          data-state={row.state}
          // Only compositable properties move, which is the budget § A COMPANION measured: transform
          // and opacity, never height or a filter.
          initial={reduced ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: reduced ? 0 : ROW_SECONDS,
            delay: reduced ? 0 : index * ROW_STAGGER,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="flex flex-col"
        >
          <div className="flex items-baseline gap-2.5">
            <TaskMarker state={row.state} index={index + 1} />
            <p
              className={cn(
                "min-w-0 flex-1 text-[13px] leading-6",
                // The RUNNING row is the one the reader is waiting in front of, so it is the one
                // sentence at full contrast. A finished row steps back rather than going grey-on-grey:
                // it is still the record of what happened.
                row.state === "running" && "font-medium text-foreground",
                row.state === "done" && "text-text-dim",
                row.state === "pending" && "text-text-faint",
                row.state === "failed" && "font-medium text-destructive",
              )}
            >
              {row.title}
            </p>
            {row.value && (
              <span
                data-testid="task-row-value"
                className="shrink-0 text-[11px] tabular-nums text-text-faint"
              >
                {row.value}
              </span>
            )}
          </div>
          {/* The steps are INDENTED under their row's own marker, so the column of numbers reads as
              the outline it is. A row whose steps are all pending draws them anyway: the point of the
              list is that the reader can see what is still to come. */}
          <ol className="ml-[26px] flex flex-col">
            {row.steps.map((step) => (
              <li
                key={step.id}
                data-testid="task-step"
                data-task-id={step.id}
                data-state={step.state}
                className="flex items-baseline gap-2"
              >
                <StepDot state={step.state} />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-[12px] leading-5",
                    step.state === "running" && "text-text-dim",
                    step.state === "done" && "text-text-faint",
                    step.state === "pending" && "text-text-faint/70",
                    step.state === "failed" && "text-destructive",
                  )}
                >
                  {step.label}
                </span>
                {step.value && (
                  <span
                    data-testid="task-step-value"
                    className={cn(
                      "shrink-0 text-[11px] tabular-nums",
                      // A running step's value is the one number on screen that MOVES, so it is the
                      // one that keeps the reader's eye — the rest is record.
                      step.state === "running" ? "text-text-dim" : "text-text-faint/80",
                    )}
                  >
                    {step.value}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </motion.li>
      ))}
    </ol>
  );
}

/** A row's leading mark: its NUMBER while there is still something to do, and a terminal mark once
 *  there is not.
 *
 *  That swap is the reference's own ("rows 2 and 3 display leading index numbers, while row 1 shows a
 *  terminal status chip instead") and it earns its place: a number is an ordinal — where this row
 *  stands in a sequence the reader is walking down — and an ordinal on a row that is over is a
 *  position nobody needs, where whether it WORKED is the thing they are scanning for. The box is one
 *  size in every state, so the swap changes the ink and never the layout. */
function TaskMarker(props: { state: TaskState; index: number }) {
  const reduced = useReducedMotion();
  if (props.state === "done") {
    return (
      <span className="grid size-4 shrink-0 translate-y-1 place-items-center" aria-hidden>
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="size-4 text-primary"
          strokeWidth={2}
        />
      </span>
    );
  }
  if (props.state === "failed") {
    return (
      <span className="grid size-4 shrink-0 translate-y-1 place-items-center" aria-hidden>
        <HugeiconsIcon icon={Alert02Icon} className="size-4 text-destructive" strokeWidth={2} />
      </span>
    );
  }
  if (props.state === "running") {
    return (
      // The number stays, and a RING travels round it. It is the same fact the agent bubble's own
      // edge carries (§ The local agent: a light on the hairline says which message is live) at the
      // size a row has — and it is drawn on the marker rather than as a spinner beside the words, so
      // nothing in the sentence moves.
      <span
        className="relative grid size-4 shrink-0 translate-y-1 place-items-center"
        aria-hidden
      >
        {!reduced && (
          <motion.span
            className="absolute inset-0 rounded-full border border-primary/70 border-t-transparent"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
          />
        )}
        {/* Under reduced motion the ring is drawn STILL and complete rather than removed: a running
            row must still be told apart from a pending one, and the ink is what says so. */}
        {reduced && <span className="absolute inset-0 rounded-full border border-primary/70" />}
        <span className="text-[9px] font-medium tabular-nums text-primary">{props.index}</span>
      </span>
    );
  }
  return (
    <span
      className="grid size-4 shrink-0 translate-y-1 place-items-center text-[9px] font-medium tabular-nums text-text-faint/70"
      aria-hidden
    >
      {props.index}
    </span>
  );
}

/** A step's own mark. Smaller than a row's and never a number: a step is one of two or three under a
 *  row the reader is already counting, so numbering it again would be a second ordinal for the same
 *  place in the list. */
function StepDot(props: { state: TaskState }) {
  const reduced = useReducedMotion();
  return (
    <span className="grid size-3.5 shrink-0 translate-y-[3px] place-items-center" aria-hidden>
      {props.state === "failed" ? (
        <span className="size-1.5 rounded-full bg-destructive" />
      ) : props.state === "done" ? (
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="size-3 text-primary/70"
          strokeWidth={2}
        />
      ) : props.state === "running" ? (
        // It BREATHES rather than turning: two moving marks in one row — the row's ring and this —
        // read as two things happening, and only one of them is.
        <motion.span
          className="size-1.5 rounded-full bg-primary"
          animate={reduced ? undefined : { opacity: [1, 0.35, 1] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      ) : (
        <span className="size-1.5 rounded-full bg-border" />
      )}
    </span>
  );
}
