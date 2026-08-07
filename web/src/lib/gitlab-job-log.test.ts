import { describe, expect, it } from "vitest";
import {
  allSectionIds,
  emptyJobLogReason,
  filterLogLines,
  formatBytes,
  jobLogIsLive,
  jobLogSummary,
  jobLogTruncation,
  jobLogUnreadable,
  parseJobLog,
  sectionLabel,
  stripAnsi,
  visibleLogLines,
} from "./gitlab-job-log";

// The shapes below are the ones `examples/job_trace_recon.rs` measured against this instance,
// spelled out here: the marker with its carriage return and erase, a nested section a project's
// own `.gitlab-ci.yml` emitted, a progress line rewritten in place, and SGR colour.

const ESC = "\x1b";
/** One line of a log the way the runner writes it: the marker, a carriage return, the erase, and
 *  then the section's own heading. */
const marker = (kind: "start" | "end", at: number, name: string, rest = "") =>
  `section_${kind}:${at}:${name}\r${ESC}[0K${rest}`;

const REAL_LOG = [
  marker("start", 1_000, "prepare_executor", `${ESC}[0;mPreparing the "docker" executor`),
  "Using Docker executor with image node:22",
  marker("end", 1_004, "prepare_executor"),
  marker("start", 1_004, "step_script", `${ESC}[32;1m$ pnpm install${ESC}[0;m`),
  marker("start", 1_006, "pnpm_section", "Installing 812 packages"),
  `Progress: 12%\rProgress: 64%\r${ESC}[0KProgress: 100%`,
  marker("end", 1_020, "pnpm_section"),
  `${ESC}[31;1mERROR: two tests failed${ESC}[0;m`,
  marker("end", 1_030, "step_script"),
  "Job failed: exit code 1",
  "",
].join("\n");

describe("parseJobLog", () => {
  it("reads the sections the runner wrote, including a nested one", () => {
    const doc = parseJobLog(REAL_LOG);
    expect(doc.sections.map((section) => section.name)).toEqual([
      "prepare_executor",
      "step_script",
      "pnpm_section",
    ]);
    const [prepare, step, pnpm] = doc.sections;
    // A section a project's own CI emitted inside `step_script` is a CHILD of it: a flat parse
    // would draw its lines as the parent's, which is what nesting is measured to really do here.
    expect(pnpm!.parent).toBe(step!.id);
    expect([prepare!.depth, step!.depth, pnpm!.depth]).toEqual([0, 0, 1]);
    // The two markers' own timestamps are the duration, which is what a folded section says.
    expect([prepare!.seconds, step!.seconds, pnpm!.seconds]).toEqual([4, 26, 14]);
    // A parent counts the lines of its children too.
    expect(step!.lines).toBeGreaterThan(pnpm!.lines);
  });

  it("takes the marker off before resolving the carriage return that follows it", () => {
    // The whole of one bug: the runner writes the marker, then `\r`, then the erase, then the
    // heading — so a parse that collapsed the rewrite first would erase the marker with it and
    // find no sections at all.
    const doc = parseJobLog(REAL_LOG);
    expect(doc.sections).toHaveLength(3);
    const opening = doc.lines.find((line) => line.opens === doc.sections[0]!.id);
    expect(opening).toBeDefined();
    // The heading written after the marker is the opening line's own text — and no marker of it
    // survives into what a reader sees.
    expect(opening!.plain).toBe('Preparing the "docker" executor');
    expect(doc.lines.every((line) => !line.plain.includes("section_start"))).toBe(true);
    expect(doc.lines.every((line) => !line.plain.includes("section_end"))).toBe(true);
  });

  it("shows only what a rewritten line ended up showing", () => {
    const doc = parseJobLog(REAL_LOG);
    const progress = doc.lines.find((line) => line.plain.startsWith("Progress"));
    // A progress bar is one line rewritten dozens of times; what a terminal would be showing is
    // the last of them, and the earlier percentages are noise nobody can read after the fact.
    expect(progress!.plain).toBe("Progress: 100%");

    // A line that ENDS by returning to its own start still shows what it wrote.
    expect(parseJobLog("done\r\n").lines[0]!.plain).toBe("done");
    // A line the runner really wrote keeps its row even when it ends up showing nothing: that
    // blank line is what the job printed. Only a line that carried nothing but a MARKER is
    // dropped, because that one is bookkeeping and is drawn as the fold instead.
    expect(parseJobLog(`${ESC}[0K\n`).lines).toHaveLength(1);
    expect(parseJobLog(`${ESC}[0K\n`).lines[0]!.plain).toBe("");
  });

  it("numbers the lines the log's own way and keeps the colours for the renderer", () => {
    const doc = parseJobLog(REAL_LOG);
    expect(doc.lines.map((line) => line.number)).toEqual(
      doc.lines.map((_, index) => index + 1),
    );
    const failure = doc.lines.find((line) => line.plain.includes("two tests failed"));
    // The ANSI stays in `text` — this app renders it — and `plain` is what a search matches.
    expect(failure!.text).toContain(`${ESC}[31;1m`);
    expect(failure!.plain).toBe("ERROR: two tests failed");
    // A line only a marker travelled on is bookkeeping, not a row: it is drawn as the fold.
    expect(doc.lines.some((line) => line.plain === "" && line.opens === undefined)).toBe(false);
  });

  it("is empty for a job that wrote nothing", () => {
    for (const nothing of [null, undefined, ""]) {
      expect(parseJobLog(nothing)).toEqual({ lines: [], sections: [] });
    }
  });

  it("closes a section a runner left open, and states no duration for it", () => {
    // A job cancelled mid-section: `step_script` is never closed, and a child is still open
    // inside it. Neither may claim a duration, and neither may swallow the lines below.
    const doc = parseJobLog(
      [
        marker("start", 1_000, "step_script", "$ long-build"),
        marker("start", 1_002, "inner_section", "working"),
        "cancelled",
        "",
      ].join("\n"),
    );
    expect(doc.sections.map((section) => section.seconds)).toEqual([null, null]);
    expect(doc.lines.at(-1)!.section).toBe(doc.sections[1]!.id);

    // A parent that closes while a child is open closes the child with it, or every line after
    // it would belong to a section the runner has already finished.
    const closed = parseJobLog(
      [
        marker("start", 1_000, "step_script", "$ build"),
        marker("start", 1_001, "inner_section", "working"),
        marker("end", 1_009, "step_script"),
        "after",
        "",
      ].join("\n"),
    );
    expect(closed.lines.at(-1)!.section).toBe(null);
    expect(closed.sections[0]!.seconds).toBe(9);
    expect(closed.sections[1]!.seconds).toBe(8);
  });

  it("keeps two runs of one section apart", () => {
    // `restore_cache` runs once per cache key, so a name is not an identity — the fold state
    // keys on the id, and two folds must not move together.
    const doc = parseJobLog(
      [
        marker("start", 1, "restore_cache", "first"),
        marker("end", 2, "restore_cache"),
        marker("start", 3, "restore_cache", "second"),
        marker("end", 4, "restore_cache"),
        "",
      ].join("\n"),
    );
    expect(doc.sections).toHaveLength(2);
    expect(new Set(allSectionIds(doc)).size).toBe(2);
  });

  it("reads a `section_start:` somebody's build printed as their own words", () => {
    // The marker is anchored to the start of the line, because a log that talks ABOUT the syntax
    // is a log about the syntax — the rule a mention inside a code span already follows.
    const doc = parseJobLog("echo section_start:1:fake\n");
    expect(doc.sections).toHaveLength(0);
    expect(doc.lines[0]!.plain).toBe("echo section_start:1:fake");
  });
});

describe("visibleLogLines", () => {
  it("leaves a folded section its opening line and takes the rest", () => {
    const doc = parseJobLog(REAL_LOG);
    const step = doc.sections.find((section) => section.name === "step_script")!;
    const rows = visibleLogLines(doc, new Set([step.id]));
    expect(rows.length).toBeLessThan(doc.lines.length);
    // The row that says what was folded is still there.
    expect(rows.some((line) => line.opens === step.id)).toBe(true);
    // And everything inside is gone — the nested section's own opening line included, because a
    // child left visible under a folded parent is a row with nothing above it to place it.
    const nested = doc.sections.find((section) => section.name === "pnpm_section")!;
    expect(rows.some((line) => line.opens === nested.id)).toBe(false);
    expect(rows.some((line) => line.plain.includes("two tests failed"))).toBe(false);
    // What is outside the fold is untouched.
    expect(rows.some((line) => line.plain === "Job failed: exit code 1")).toBe(true);
  });

  it("folds a child without touching its parent's other lines", () => {
    const doc = parseJobLog(REAL_LOG);
    const nested = doc.sections.find((section) => section.name === "pnpm_section")!;
    const rows = visibleLogLines(doc, new Set([nested.id]));
    expect(rows.some((line) => line.opens === nested.id)).toBe(true);
    expect(rows.some((line) => line.plain === "Progress: 100%")).toBe(false);
    expect(rows.some((line) => line.plain.includes("two tests failed"))).toBe(true);
  });

  it("gives back the very same array when nothing is folded", () => {
    const doc = parseJobLog(REAL_LOG);
    expect(visibleLogLines(doc, new Set())).toBe(doc.lines);
  });
});

describe("filterLogLines", () => {
  it("keeps the matching lines and their own numbers", () => {
    const doc = parseJobLog(REAL_LOG);
    const found = filterLogLines(doc.lines, "ERROR");
    expect(found).toHaveLength(1);
    // The line keeps the number it has in the log, which is how a reader gets back to it.
    expect(found[0]!.number).toBe(
      doc.lines.find((line) => line.plain.includes("two tests failed"))!.number,
    );
    // Case-insensitive, because nobody remembers whether the runner shouted.
    expect(filterLogLines(doc.lines, "error")).toHaveLength(1);
    // The ESCAPES are never matched: a query for `31` must not find every red line.
    expect(filterLogLines(doc.lines, "31;1m")).toHaveLength(0);
  });

  it("gives everything back for an empty query", () => {
    const doc = parseJobLog(REAL_LOG);
    expect(filterLogLines(doc.lines, "   ")).toBe(doc.lines);
  });
});

describe("what the page says about a log", () => {
  it("names a section in the runner's own vocabulary", () => {
    expect(sectionLabel("step_script")).toBe("Step script");
    expect(sectionLabel("upload_artifacts_on_failure")).toBe("Upload artifacts on failure");
    // A project's own name is opened out the same way rather than left bare beside prose.
    expect(sectionLabel("unit_tests_section")).toBe("Unit tests section");
    expect(sectionLabel("")).toBe("");
  });

  it("states the size in units a reader thinks in", () => {
    expect(formatBytes(0)).toBe(null);
    expect(formatBytes(null)).toBe(null);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(11_151)).toBe("11 KB");
    expect(formatBytes(147_598)).toBe("144 KB");
    expect(formatBytes(510_000)).toBe("498 KB");
    expect(formatBytes(4 * 1024 * 1024)).toBe("4.0 MB");
    expect(jobLogSummary({ lines: 4_238, bytes: 510_000 })).toBe("4,238 lines · 498 KB");
    expect(jobLogSummary({ lines: 1 })).toBe("1 line");
  });

  it("says a cut log is showing its END, and how big the whole of it is", () => {
    expect(jobLogTruncation(null)).toBe(null);
    expect(jobLogTruncation({ truncated: false, bytes: 10 })).toBe(null);
    const notice = jobLogTruncation({ truncated: true, bytes: 4 * 1024 * 1024 });
    expect(notice).toContain("4.0 MB");
    // What is on screen is the END: that is the half a reader opening a red job came for, and
    // saying "part of" would leave them looking for which part.
    expect(notice).toContain("end");
  });

  it("tells a log that is MISSING from one that is empty", () => {
    // Two requests: the job, then its trace. Only the second can fail on its own — GitLab answers
    // 404 for a trace file it has dropped — so an empty log has two meanings, and stating the
    // wrong one is this app claiming something it was never told.
    expect(jobLogUnreadable({ trace_error: "GitLab has no log there" })).toBe(
      "GitLab has no log there",
    );
    expect(jobLogUnreadable({})).toBe(null);
    expect(jobLogUnreadable(null)).toBe(null);
    // A reason with nothing in it says nothing: the page then falls back to what it can say about
    // the job itself.
    expect(jobLogUnreadable({ trace_error: "   " })).toBe(null);
  });

  it("says WHY a log is empty, because the reader's next move depends on it", () => {
    // Measured: every empty log on this instance belonged to a `manual` or `created` job.
    expect(emptyJobLogReason({ status: "manual" })).toContain("not been started");
    expect(emptyJobLogReason({ status: "created" })).toContain("not started running");
    expect(emptyJobLogReason({ status: "skipped" })).toContain("skipped");
    expect(emptyJobLogReason({ status: "canceled" })).toContain("cancelled");
    // An ERASED log will never arrive, whatever the job's state says — so that answer wins.
    expect(emptyJobLogReason({ status: "success", erased_at: "2026-08-06T09:00:00Z" })).toContain(
      "erased",
    );
    expect(emptyJobLogReason({ status: "success" })).toContain("wrote nothing");
  });

  it("follows a log exactly while its job has not finished", () => {
    expect(jobLogIsLive({ complete: false })).toBe(true);
    expect(jobLogIsLive({ complete: true })).toBe(false);
    // A payload that says nothing is read as still running: a page that stopped polling on a
    // missing field would freeze a live log with no way back.
    expect(jobLogIsLive({})).toBe(true);
    // Nothing at all is not a log to follow.
    expect(jobLogIsLive(null)).toBe(false);
  });

  it("strips every escape it is asked to and leaves the words", () => {
    expect(stripAnsi(`${ESC}[32;1mgreen${ESC}[0;m`)).toBe("green");
    expect(stripAnsi(`${ESC}[38;5;208m256${ESC}[0m`)).toBe("256");
    expect(stripAnsi(`${ESC}[38;2;10;20;30mtrue${ESC}[0m`)).toBe("true");
    expect(stripAnsi("plain")).toBe("plain");
    // A stray two-byte escape costs its own two bytes and not the rest of the line.
    expect(stripAnsi(`a${ESC}cb`)).toBe("ab");
  });
});
