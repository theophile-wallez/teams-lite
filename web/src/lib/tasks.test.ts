import { describe, expect, test } from "vitest";
import { taskDueLabel, taskIsOverdue, taskSections, taskSourceHref, type Task } from "./tasks";

const base: Task = {
  id: "t1", title: "Review the doc", body: "", state: "open", due_date: "",
  source_conversation_id: "", source_message_id: "", source_mail_id: "",
  asked_by_mri: "", asked_by: "", created_at: 1, done_at: 0,
};
const task = (over: Partial<Task>): Task => ({ ...base, ...over });

describe("taskSections", () => {
  test("suggested comes first, because it is the only section that needs a decision", () => {
    const sections = taskSections(
      [task({ id: "a", state: "open" }), task({ id: "b", state: "suggested" })],
      "2026-08-05",
    );
    expect(sections[0].key).toBe("suggested");
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["b"]);
  });

  test("a task due today is in Today, and not repeated in Open", () => {
    const sections = taskSections([task({ id: "a", due_date: "2026-08-05" })], "2026-08-05");
    const today = sections.find((s) => s.key === "today")!;
    const open = sections.find((s) => s.key === "open")!;
    expect(today.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(open.tasks).toHaveLength(0);
  });

  test("an overdue task is in Today too, because it is what the day owes", () => {
    const sections = taskSections([task({ id: "a", due_date: "2026-08-01" })], "2026-08-05");
    expect(sections.find((s) => s.key === "today")!.tasks.map((t) => t.id)).toEqual(["a"]);
  });

  test("Open is soonest due first, and undated last", () => {
    const sections = taskSections(
      [task({ id: "none" }), task({ id: "late", due_date: "2026-09-01" }), task({ id: "soon", due_date: "2026-08-08" })],
      "2026-08-05",
    );
    expect(sections.find((s) => s.key === "open")!.tasks.map((t) => t.id)).toEqual(["soon", "late", "none"]);
  });

  test("dismissed rows are shown nowhere", () => {
    const sections = taskSections([task({ id: "a", state: "dismissed" })], "2026-08-05");
    expect(sections.flatMap((s) => s.tasks)).toHaveLength(0);
  });

  test("done rows are their own section, newest first", () => {
    const sections = taskSections(
      [task({ id: "old", state: "done", done_at: 1 }), task({ id: "new", state: "done", done_at: 2 })],
      "2026-08-05",
    );
    expect(sections.find((s) => s.key === "done")!.tasks.map((t) => t.id)).toEqual(["new", "old"]);
  });

  test("an empty list still yields the sections, so the panel can say it is empty", () => {
    expect(taskSections([], "2026-08-05").map((s) => s.key)).toEqual(["suggested", "today", "open", "done"]);
  });
});

describe("taskDueLabel", () => {
  test("names the near days rather than printing a date", () => {
    expect(taskDueLabel("2026-08-05", "2026-08-05")).toBe("Today");
    expect(taskDueLabel("2026-08-06", "2026-08-05")).toBe("Tomorrow");
    expect(taskDueLabel("2026-08-04", "2026-08-05")).toBe("Yesterday");
  });
  test("a far date is a date, and an absent one is nothing", () => {
    expect(taskDueLabel("2026-12-24", "2026-08-05")).toContain("24");
    expect(taskDueLabel("", "2026-08-05")).toBe("");
  });
});

describe("taskIsOverdue", () => {
  test("only a dated, unfinished task can be overdue", () => {
    expect(taskIsOverdue(task({ due_date: "2026-08-04" }), "2026-08-05")).toBe(true);
    expect(taskIsOverdue(task({ due_date: "2026-08-05" }), "2026-08-05")).toBe(false);
    expect(taskIsOverdue(task({ due_date: "" }), "2026-08-05")).toBe(false);
    expect(taskIsOverdue(task({ due_date: "2026-08-04", state: "done" }), "2026-08-05")).toBe(false);
  });
});

describe("taskSourceHref", () => {
  test("a message and a mail each jump to the route that already exists", () => {
    expect(taskSourceHref(task({ source_conversation_id: "19:c@thread.v2" })))
      .toBe(`/c/${encodeURIComponent("19:c@thread.v2")}`);
    expect(taskSourceHref(task({ source_mail_id: "AAMk123" }))).toBe("/m/AAMk123");
    expect(taskSourceHref(base)).toBeNull();
  });
});
