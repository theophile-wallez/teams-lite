// Pure task grouping and labeling. No Date.now(), no real-time clock, no imports from
// the store — `today` is a parameter (YYYY-MM-DD), which is what makes every test
// deterministic. The component supplies the real day.

/** The four backend states a task can be in. `dismissed` is stored but never shown. */
export type TaskState = "suggested" | "open" | "done" | "dismissed";

/** One task row, mirroring the Rust backend's `store::TaskRow` field for field. */
export type Task = {
  id: string;
  title: string;
  body: string;
  state: TaskState;
  due_date: string; // 'YYYY-MM-DD' or ''
  source_conversation_id: string;
  source_message_id: string;
  source_mail_id: string;
  asked_by_mri: string; // an MRI, or ''
  asked_by: string;     // the resolved display name, or ''
  created_at: number;   // epoch ms
  done_at: number;      // epoch ms; 0 when not done
};

/** The writable subset of a task, for creating or patching. `id` absent means insert,
 *  present means patch. Only the fields present are written. */
export type TaskPatch = Partial<Omit<Task, "created_at" | "done_at" | "asked_by">> & { id?: string };

/** One section of the task panel: its key, display label, and the tasks that belong in it. */
export type TaskSection = {
  key: "suggested" | "today" | "open" | "done";
  label: string;
  tasks: Task[];
};

/** Groups tasks into the four sections the panel renders, in the order they appear.
 *  Returns all four sections always, even when empty, so the panel can say "nothing here"
 *  against a stable shape. A task appears in exactly one section: a dated task due today
 *  or overdue belongs to Today and is not repeated in Open. `dismissed` appears nowhere. */
export function taskSections(tasks: Task[], today: string): TaskSection[] {
  const suggested: Task[] = [];
  const todayTasks: Task[] = [];
  const open: Task[] = [];
  const done: Task[] = [];

  for (const task of tasks) {
    if (task.state === "dismissed") {
      // dismissed rows are shown nowhere
      continue;
    }
    if (task.state === "done") {
      done.push(task);
    } else if (task.state === "suggested") {
      suggested.push(task);
    } else if (task.due_date !== "" && task.due_date <= today) {
      // due today or overdue: goes to Today, not Open
      todayTasks.push(task);
    } else {
      open.push(task);
    }
  }

  // Done: newest first (highest done_at)
  done.sort((a, b) => b.done_at - a.done_at);

  // Open: soonest due first, undated last. An empty due_date string sorts BEFORE every
  // real date in a naive comparison, which would put undated tasks first — that is the
  // bug to avoid.
  open.sort((a, b) => {
    if (a.due_date === "" && b.due_date === "") return 0;
    if (a.due_date === "") return 1;  // a is undated, so it goes last
    if (b.due_date === "") return -1; // b is undated, so a goes first
    return a.due_date.localeCompare(b.due_date); // both dated: soonest first
  });

  return [
    { key: "suggested", label: "Suggested", tasks: suggested },
    { key: "today", label: "Today", tasks: todayTasks },
    { key: "open", label: "Open", tasks: open },
    { key: "done", label: "Done", tasks: done },
  ];
}

/** Whether a task is overdue: it has a due date, that date is in the past, and it is not
 *  yet done. Tasks due today are not overdue. */
export function taskIsOverdue(task: Task, today: string): boolean {
  return task.due_date !== "" && task.due_date < today && task.state !== "done";
}

/** The label for a task's due date: "Today" / "Tomorrow" / "Yesterday" for the near days,
 *  the formatted date for a far one, and an empty string when there is no date. */
export function taskDueLabel(dueDate: string, today: string): string {
  if (dueDate === "") return "";
  if (dueDate === today) return "Today";

  // Compare day strings directly for Tomorrow and Yesterday. These are fixed-width
  // YYYY-MM-DD strings, so we can derive the adjacent days without Date arithmetic
  // (which can shift a label by a day under a timezone).
  const todayDate = new Date(today + "T00:00:00");
  const tomorrow = new Date(todayDate);
  tomorrow.setDate(todayDate.getDate() + 1);
  const yesterday = new Date(todayDate);
  yesterday.setDate(todayDate.getDate() - 1);

  const tomorrowStr = tomorrow.toISOString().split("T")[0];
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  if (dueDate === tomorrowStr) return "Tomorrow";
  if (dueDate === yesterdayStr) return "Yesterday";

  // Far date: format it with Intl so it reads in the user's locale. We construct the Date
  // from the YYYY-MM-DD string at midnight UTC, which keeps the day number stable across
  // timezones (the label cannot shift a day).
  const date = new Date(dueDate + "T00:00:00Z");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The href this task jumps to when clicked: the conversation or the mail it came from,
 *  or null when it has no source (a manually created task). */
export function taskSourceHref(task: Task): string | null {
  if (task.source_conversation_id !== "") {
    return `/c/${encodeURIComponent(task.source_conversation_id)}`;
  }
  if (task.source_mail_id !== "") {
    return `/m/${task.source_mail_id}`;
  }
  return null;
}
