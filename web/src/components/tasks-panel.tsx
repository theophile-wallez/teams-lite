// The task list: what the user was asked to do, beside the thread they were asked in.
//
// ONE `<aside>`, in two shapes, and no new primitive. Wide, it is a 22rem column with a
// left border, so opening it NARROWS the message pane instead of covering it — the whole
// point of the panel is to be read beside a conversation. Narrow, it is a full-screen
// sheet, because a 22rem column on a 390px phone is the phone. Where the two meet is
// `WIDE_QUERY`, and the arithmetic behind that number is written down there.
//
// It is deliberately not a dialog and not a portal. There is no sheet or drawer in
// components/ui, and Radix's `Dialog` would trap the focus inside the panel and mark the
// rest of the page inert — which is exactly wrong for a surface whose job is to sit next
// to a thread the user keeps reading and typing in. So it is a plain flex sibling of the
// detail pane, mounted only while it is open.
//
// What is POLICY lives in lib/tasks.ts (which section a task belongs to, whether it is
// overdue, how a due date reads, where its source is). That module is pure and takes the
// day as a parameter; the clock lives here, in the component, and nowhere else.
//
// Every write goes out and comes back before the row changes (see `saveTask` in
// lib/store.ts): the backend refuses a state outside the four, a malformed due date and
// every write at all when this page holds a token it does not accept — so a refusal is
// reported HERE, beside the control that was pressed, and never swallowed into a cue. It
// is the rule § Sending messages states for the composer and § The trackers for the
// approval menu: an action that failed must never be left looking like it worked.

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckListIcon,
  CheckmarkSquare02Icon,
  Loading02Icon,
  SparklesIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { dayKey, eventsForDay, formatEventTime, withoutDeclined } from "~/lib/calendar";
import {
  taskDueLabel,
  taskIsOverdue,
  taskSections,
  taskSourceHref,
  type Task,
} from "~/lib/tasks";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { useAppState, useController } from "./controller-context";

/**
 * The width at which the panel stops being a full-screen sheet and becomes a side column.
 *
 * It is spelled TWICE and the two MUST agree: here, and as the `lg:` prefixes on the
 * aside's own classes below. Tailwind's prefix is compiled from the literal, so neither can
 * be derived from the other — the only thing holding them together is that they are ten
 * lines apart. Change one, change the other: this query is what decides whether following a
 * task's source closes the panel (see `TaskRow`), and a mismatch would leave a tap opening
 * a thread behind a sheet that covers it.
 *
 * `lg` (64rem) rather than `md` (48rem), and the arithmetic is the reason: at 768px the
 * sidebar's 320px plus this column's 22rem leave about 96px of message pane, which is
 * covering the thread rather than sitting beside it — and being read beside the thread is
 * the whole point of the wide shape. At 1024px it leaves ~352px, which is a column.
 */
const WIDE_QUERY = "(min-width: 64rem)";

/** One row of section chrome: the label above its tasks. */
const SECTION_LABEL =
  "px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-text-faint";

export function TasksPanel() {
  const controller = useController();
  const tasks = useAppState((s) => s.tasks);
  const tasksLoaded = useAppState((s) => s.tasksLoaded);
  const loadError = useAppState((s) => s.tasksError);
  const scan = useAppState((s) => s.taskScan);
  const calendarEvents = useAppState((s) => s.calendarEvents);
  const showDeclined = useAppState((s) => s.calendarSettings.showDeclined);
  // Why a task did not move, for the person who clicked. Local to the panel: it is about
  // one click rather than about the app, so it goes when the panel closes.
  const [writeError, setWriteError] = useState<string | null>(null);

  // Today, as of this render. Recomputed rather than held in state, like the calendar
  // pane's own: a stale value can only ever mis-sort one section, and no timer is worth
  // that. `dayKey` is the same local YYYY-MM-DD the calendar identifies a day by.
  const now = new Date();
  const today = dayKey(now);
  const sections = taskSections(tasks, today);

  // Today's meetings, read exactly as the calendar pane reads them: the events this app
  // has already synced, with the declined ones dropped by the user's own setting. A pure
  // read of state that exists — no RPC of its own — which has one honest consequence: a
  // session that never opened the Calendar tab has no events loaded, so this is empty
  // until it does. That is the right trade for a panel that must never sync anything.
  const todayEvents = eventsForDay(withoutDeclined(calendarEvents, showDeclined), now);

  // Said of the TASKS, and only of them: today's meetings still list themselves under
  // Today, because "no tasks" and "you are in three meetings" are both true and the panel
  // must not swallow the second to state the first.
  //
  // And only once the list has really been READ. `tasks` is empty for the round trip after
  // the panel opens and empty again when a first read failed, and announcing an empty plate
  // in either case states something this page does not know — the same rule that keeps
  // every write non-optimistic.
  const noTasks = tasksLoaded && sections.every((section) => section.tasks.length === 0);

  // Every row's write funnels through here, so no control can forget to report a refusal.
  const write = (run: Promise<void>) => {
    setWriteError(null);
    void run.catch((e: unknown) => setWriteError(failureText(e)));
  };

  // One line for both failures, because they never coexist: a first read that failed leaves
  // nothing to write to. The write is the more recent of the two, so it wins.
  const errorLine = writeError ?? loadError;

  return (
    <aside
      data-testid="tasks-panel"
      aria-label="Tasks"
      // The `lg:` half is the side column; everything below it is the sheet. Keep it in
      // step with WIDE_QUERY above.
      className="fixed inset-0 z-40 flex flex-col border-border bg-background lg:relative lg:inset-auto lg:z-auto lg:w-[22rem] lg:shrink-0 lg:border-l"
    >
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border-subtle px-4 pt-[env(safe-area-inset-top)]">
        <h2 className="flex-1 truncate text-[15px] font-bold tracking-tight text-foreground">
          Tasks
        </h2>
        {/* Provider-neutral on purpose: WHICH CLI reads the messages is the user's own
            setting (Settings › AI providers), so naming one here would go stale the day
            they change it. */}
        <button
          type="button"
          data-testid="tasks-scan"
          data-running={scan.running ? "true" : undefined}
          data-cuelume-press=""
          disabled={scan.running}
          title="Read the messages and mail that arrived since the last scan, with an agent CLI on this machine"
          onClick={() => void controller.scanTasks()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-card px-2.5 py-1.5 text-[12px] font-medium text-text-dim shadow-chip transition-colors hover:text-foreground disabled:opacity-70"
        >
          <HugeiconsIcon
            icon={scan.running ? Loading02Icon : SparklesIcon}
            className={cn("size-3.5", scan.running && "animate-spin")}
            strokeWidth={1.8}
          />
          {scan.running ? "Scanning…" : "Scan for tasks"}
        </button>
        <button
          type="button"
          aria-label="Close tasks"
          title="Close (Esc)"
          data-testid="tasks-close"
          data-cuelume-press=""
          onClick={() => controller.closeTasksPanel()}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.8} />
        </button>
      </header>

      {/* What happened, beside the control it happened to — never in the status line,
          which is eleven truncated pixels at the foot of a sidebar a phone does not show
          at all. The region is always in the DOM and empty most of the time: a live region
          that appears with its own text is one a screen reader never announces. `polite`
          because a scan is something the user started and is waiting on. */}
      <div role="status" aria-live="polite" className="shrink-0">
        {scan.error && (
          <p
            data-testid="tasks-scan-error"
            className="border-b border-border-subtle px-4 py-2 text-[12px] leading-snug text-destructive"
          >
            {scan.error}
          </p>
        )}
        {/* `found: 0` conflates three outcomes — a fresh store whose watermark was planted
            at the moment it was created, a sweep with nothing unread to read, and a model
            that read something and found no ask in it — and the RPC answers with a count
            alone, so nothing here can tell them apart. It says the one thing that is true
            of all three. Do not invent the distinction; it would need a backend field. */}
        {!scan.error && !scan.running && scan.found !== null && (
          <p
            data-testid="tasks-scan-found"
            className="border-b border-border-subtle px-4 py-2 text-[12px] leading-snug text-text-dim"
          >
            {scan.found === 0
              ? "Nothing new to do."
              : `Found ${scan.found} ${scan.found === 1 ? "task" : "tasks"} to look at.`}
          </p>
        )}
        {errorLine && (
          <p
            data-testid="tasks-error"
            className="border-b border-border-subtle px-4 py-2 text-[12px] leading-snug text-destructive"
          >
            {errorLine}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {noTasks && (
          <p data-testid="tasks-empty" className="px-4 py-8 text-center text-[13px] text-text-faint">
            No tasks yet. A scan reads the messages and mail that arrived since the last one.
          </p>
        )}
        {sections.map((section) => {
          // Today carries the day's meetings as well, so it has something to show even
          // with no task due. Every other empty section is left out entirely: four labels
          // with nothing under them say less than one line saying so.
          const events = section.key === "today" ? todayEvents : [];
          if (section.tasks.length === 0 && events.length === 0) return null;
          return (
            <section key={section.key} data-testid="tasks-section" data-section={section.key}>
              <h3 className={SECTION_LABEL}>{section.label}</h3>
              {events.map((event) => (
                // The calendar stays READ-ONLY here as everywhere: a meeting is context for
                // the day, so it is stated and nothing more — no join, and no link the app
                // follows on the user's behalf.
                <div
                  key={event.id}
                  data-testid="task-event"
                  className="flex items-baseline gap-2 px-4 py-1.5 text-[13px]"
                >
                  <span className="shrink-0 tabular-nums text-[11px] text-text-faint">
                    {formatEventTime(event)}
                  </span>
                  <span className="min-w-0 truncate text-text-dim">{event.subject}</span>
                </div>
              ))}
              <ul>
                {section.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} today={today} onWrite={write} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * One task.
 *
 * A SUGGESTION shows Accept and Dismiss and no checkbox, because it is a decision rather
 * than a task yet: ticking off something nobody agreed to is a task list that fills
 * itself. Everything else shows the checkbox, which is the only thing on the row that
 * moves a state the user already owns.
 */
function TaskRow(props: { task: Task; today: string; onWrite: (run: Promise<void>) => void }) {
  const controller = useController();
  const navigate = useNavigate();
  const { task, today, onWrite } = props;
  const suggested = task.state === "suggested";
  const done = task.state === "done";
  const due = taskDueLabel(task.due_date, today);
  const overdue = taskIsOverdue(task, today);
  const href = taskSourceHref(task);

  // A real link, so it reads as one and a keyboard reaches it — but the navigation is the
  // router's typed one, which is how every other jump in this app is made.
  const followSource = (event: React.MouseEvent) => {
    event.preventDefault();
    if (task.source_conversation_id) {
      void navigate({
        to: "/c/$conversationId",
        params: { conversationId: task.source_conversation_id },
      });
    } else {
      void navigate({ to: "/m/$mailId", params: { mailId: task.source_mail_id } });
    }
    // Below `lg` this panel IS the screen, so the thread would open behind it and the tap
    // would look like it did nothing. Wide, the conversation appears in the pane beside
    // the panel, which is the arrangement the panel exists for — so it stays open.
    if (!window.matchMedia(WIDE_QUERY).matches) controller.closeTasksPanel();
  };

  return (
    <li
      data-testid="task-row"
      data-task-id={task.id}
      data-task-state={task.state}
      className="group/task flex items-start gap-2.5 px-4 py-2 transition-colors hover:bg-accent/50"
    >
      {!suggested && (
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
          data-testid="task-check"
          data-cuelume-press=""
          onClick={() => onWrite(controller.saveTask({ id: task.id, state: done ? "open" : "done" }))}
          className={cn(
            "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md transition-colors",
            done ? "text-primary" : "text-text-faint hover:text-foreground",
          )}
        >
          <HugeiconsIcon
            icon={done ? CheckmarkSquare02Icon : SquareIcon}
            className="size-[18px]"
            strokeWidth={1.8}
          />
        </button>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className={cn(
            "text-[13px] leading-snug",
            done ? "text-text-faint line-through" : "text-foreground",
          )}
        >
          {task.title}
        </p>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-text-faint">
          {due && (
            // Tinted only when it is past: a date is information, a missed one is a
            // signal, and colouring both would make neither read as one.
            <span
              data-testid="task-due"
              data-overdue={overdue ? "true" : undefined}
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 font-medium",
                overdue ? "bg-destructive/12 text-destructive" : "bg-element text-text-dim",
              )}
            >
              {due}
            </span>
          )}
          {task.asked_by && (
            // Their face and the name this app knows them by — the backend resolves both
            // through the same store read every other surface uses, so a nickname the
            // user gave them holds here too.
            <span className="flex min-w-0 items-center gap-1">
              <Avatar
                seed={task.asked_by_mri || task.asked_by}
                label={task.asked_by}
                fallback="person"
                photo={task.asked_by_mri ? { kind: "user", id: task.asked_by_mri } : undefined}
                className="size-4 text-[8px]"
              />
              <span className="truncate">{task.asked_by}</span>
            </span>
          )}
          {href && (
            <a
              href={href}
              data-testid="task-source"
              data-cuelume-press=""
              title="Open where this was asked"
              onClick={followSource}
              className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 font-medium text-text-dim transition-colors hover:bg-element hover:text-foreground"
            >
              Source
              <HugeiconsIcon icon={ArrowUpRight01Icon} className="size-3" strokeWidth={2} />
            </a>
          )}
        </div>
      </div>

      {suggested && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="task-accept"
            data-cuelume-press=""
            onClick={() => onWrite(controller.acceptTask(task.id))}
            className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Accept
          </button>
          <button
            type="button"
            data-testid="task-dismiss"
            data-cuelume-press=""
            onClick={() => onWrite(controller.dismissTask(task.id))}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-text-dim transition-colors hover:bg-element hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * The control that opens the panel, in the sidebar header beside the app's other global
 * controls — the bell, the appearance switch, Settings.
 *
 * It lives in this file rather than in the sidebar's because the panel and the way in are
 * one feature: the keyboard's `t` (bound in app.tsx) and this button call the same
 * action, and nothing else in the app may open it.
 */
export function TasksToggle() {
  const controller = useController();
  const open = useAppState((s) => s.tasksPanelOpen);
  return (
    <button
      type="button"
      aria-label="Tasks"
      aria-pressed={open}
      title="Tasks (t)"
      data-testid="tasks-toggle"
      data-open={open ? "true" : undefined}
      data-cuelume-press=""
      onClick={() => controller.toggleTasksPanel()}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg transition-colors",
        open ? "bg-accent text-foreground" : "text-text-dim hover:bg-accent hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={CheckListIcon} className="size-4" strokeWidth={1.4} />
    </button>
  );
}

/** A refused write in the words the backend used, which is the useful half — it names
 *  which rail refused (a state outside the four, a blanked title, a token this backend
 *  does not accept). */
function failureText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
