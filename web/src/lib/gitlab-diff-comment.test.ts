import { describe, expect, it } from "vitest";
import {
  diffCommentAnchor,
  diffCommentPosition,
  diffCommentTarget,
  diffCommentTargetLabel,
  diffCommentsAvailable,
  diffThreadLabel,
  diffThreadsFor,
  noteWasEdited,
  patchLineAt,
  patchLineIndex,
  patchLines,
  threadResolution,
  threadResolveAction,
  type DiffRefs,
} from "./gitlab-diff-comment";
import type { GitLabDiffFile } from "./gitlab-diff";
import type { GitLabDiscussionList, GitLabNote } from "./gitlab-mr";

// The patch the backend writes: the `diff --git` header over the hunks GitLab sent (see
// `gitlab_mr::unified_patch`). Its shape matters to these tests — the header carries lines
// that begin with `-` and `+`, and none of them is a line of the file.
const PATCH = [
  "diff --git a/src/server/health.ts b/src/server/health.ts",
  "--- a/src/server/health.ts",
  "+++ b/src/server/health.ts",
  "@@ -6,7 +6,9 @@ import type { Server } from \"./types\";",
  " ",
  "-export function health(server: Server) {",
  "-  return server.ready ? 200 : 503;",
  "+export function health(server: Server): number {",
  "+  if (server.draining) return 503;",
  "+  if (!server.ready) return 503;",
  "+  return 200;",
  " }",
  " ",
].join("\n");

const FILE: GitLabDiffFile = {
  path: "src/server/health.ts",
  change: "changed",
  patch: PATCH,
  additions: 4,
  deletions: 2,
  binary: false,
  collapsed: false,
  generated: false,
};

const REFS: DiffRefs = { base_sha: "aa11", head_sha: "bb22", start_sha: "cc33" };

describe("patchLines", () => {
  it("counts a line's place in both files, the way git and GitLab do", () => {
    const lines = patchLines(PATCH);
    // The hunk opens at old 6 / new 6 with one context line.
    expect(lines[0]).toEqual({ old: 6, new: 6, side: "both", row: 0 });
    // Two removals: each advances the OLD counter alone, and each still carries the place it
    // holds in the new file — which is what a line code is built from.
    expect(lines[1]).toEqual({ old: 7, new: 7, side: "old", row: 1 });
    expect(lines[2]).toEqual({ old: 8, new: 7, side: "old", row: 2 });
    // Four additions: the NEW counter alone advances, and the old one stays where the
    // removals left it.
    expect(lines[3]).toEqual({ old: 9, new: 7, side: "new", row: 3 });
    expect(lines[6]).toEqual({ old: 9, new: 10, side: "new", row: 6 });
    // And the context resumes with both.
    expect(lines[7]).toEqual({ old: 9, new: 11, side: "both", row: 7 });
    expect(lines).toHaveLength(9);
  });

  it("reads nothing before the first hunk, so the header is never a line", () => {
    // `--- a/x` and `+++ b/x` open with the marks of a removal and an addition. Read as
    // lines they would shift every number in the file by one.
    expect(patchLines(PATCH)[0]?.old).toBe(6);
    expect(patchLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n")).toEqual([]);
    expect(patchLines(undefined)).toEqual([]);
    expect(patchLines("")).toEqual([]);
  });

  it("skips the no-newline note, which is about a line rather than one", () => {
    const lines = patchLines("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n");
    expect(lines.map((line) => line.side)).toEqual(["old", "new"]);
  });

  it("counts a context line whose leading space was stripped", () => {
    // Dropping it instead would put every number below it out by one — a comment filed
    // against the wrong line, with nothing on screen to say so.
    const lines = patchLines("@@ -1,2 +1,3 @@\nimport x\n a\n+b\n");
    expect(lines.map((line) => [line.side, line.new])).toEqual([
      ["both", 1],
      ["both", 2],
      ["new", 3],
    ]);
  });

  it("reads a bare empty line as the context line it is", () => {
    // Some producers drop the leading space on an empty context line. Dropping the line
    // instead would put every number below it out by one.
    const lines = patchLines("@@ -1,3 +1,3 @@\n a\n\n+b\n");
    expect(lines.map((line) => [line.side, line.new])).toEqual([
      ["both", 1],
      ["both", 2],
      ["new", 3],
    ]);
  });

  it("reads the newline a patch ends with as a terminator, not as a line", () => {
    // Every real patch ends with one, so counting the empty string behind it would put a
    // phantom context row at the foot of every file — one line past the end of the code.
    expect(patchLines("@@ -1,1 +1,2 @@\n a\n+b\n")).toHaveLength(2);
    expect(patchLines("@@ -1,1 +1,2 @@\n a\n+b")).toHaveLength(2);
  });

  it("handles a hunk with no line count, which is one line long", () => {
    expect(patchLines("@@ -1 +1 @@\n-a\n+b\n").map((line) => line.side)).toEqual(["old", "new"]);
  });
});

describe("patchLineAt", () => {
  const index = patchLineIndex(PATCH);

  it("finds a line by the number of either gutter", () => {
    expect(patchLineAt(index, 8, "additions")?.side).toBe("new");
    expect(patchLineAt(index, 8, "deletions")?.side).toBe("old");
  });

  it("finds a context line whichever side the renderer reported", () => {
    // A context line is drawn in both columns of a split diff and in one row of a unified
    // one, so the side it arrives under is not something this app may depend on.
    const fromNew = patchLineAt(index, 11, "additions");
    const fromOld = patchLineAt(index, 9, "deletions");
    expect(fromNew).toEqual(fromOld);
    expect(fromNew?.side).toBe("both");
  });

  it("answers null for a line the patch does not hold", () => {
    // A reader can drag past the end of a hunk, and a line nobody can address is a real
    // answer rather than a case to smooth over.
    expect(patchLineAt(index, 900, "additions")).toBeNull();
  });
});

describe("diffCommentTarget", () => {
  it("puts the two ends in reading order, whichever way the reader dragged", () => {
    const down = diffCommentTarget(FILE, { start: 8, side: "additions", end: 10 });
    const up = diffCommentTarget(FILE, { start: 10, side: "additions", end: 8 });
    expect(down).toEqual(up);
    // GitLab hangs a thread on the LAST line of a range, so the pair left in pointer order
    // would file an upward drag's comment at the top of the block.
    expect(down?.first.new).toBe(8);
    expect(down?.last.new).toBe(10);
  });

  it("reads one line as a range of one", () => {
    const target = diffCommentTarget(FILE, { start: 9, side: "additions", end: 9 });
    expect(target?.first).toEqual(target?.last);
    expect(diffCommentTargetLabel(target!)).toBe("Line 9");
  });

  it("names both numbers of a span, in the order they are read", () => {
    const target = diffCommentTarget(FILE, { start: 10, side: "additions", end: 8 })!;
    expect(diffCommentTargetLabel(target)).toBe("Lines 8–10");
  });

  it("crosses the two sides of one drag", () => {
    // From a removed line down to an added one: the ends are in two files, and the row order
    // is what tells them apart.
    const target = diffCommentTarget(FILE, {
      start: 7,
      side: "deletions",
      end: 9,
      endSide: "additions",
    })!;
    expect([target.first.side, target.last.side]).toEqual(["old", "new"]);
    expect(diffCommentTargetLabel(target)).toBe("Lines 7–9");
  });

  it("is nothing at all without a range, a file, or a line the patch holds", () => {
    expect(diffCommentTarget(FILE, null)).toBeNull();
    expect(diffCommentTarget(null, { start: 8, end: 8 })).toBeNull();
    expect(diffCommentTarget(FILE, { start: 800, end: 801, side: "additions" })).toBeNull();
  });
});

describe("diffCommentPosition", () => {
  const target = (start: number, end: number) =>
    diffCommentTarget(FILE, { start, end, side: "additions" })!;

  it("states only the side its anchor line is on", () => {
    const added = diffCommentPosition(FILE, REFS, target(9, 9))!;
    expect(added.line).toEqual({ old: 9, new: 9, side: "new" });
    expect(added.start).toBeUndefined();
    expect(added.refs).toBe(REFS);
    expect(added.new_path).toBe("src/server/health.ts");
    expect(added.old_path).toBe("src/server/health.ts");
  });

  it("names both ends of a span and the last of them as the anchor", () => {
    const span = diffCommentPosition(FILE, REFS, target(8, 10))!;
    expect(span.line.new).toBe(10);
    expect(span.start?.new).toBe(8);
  });

  it("gives an added file no old path, and a deleted one no new path", () => {
    const added = diffCommentPosition({ ...FILE, change: "new" }, REFS, target(9, 9))!;
    expect(added.new_path).toBe("src/server/health.ts");
    expect(added.old_path).toBeUndefined();

    const deleted = diffCommentPosition({ ...FILE, change: "deleted" }, REFS, target(9, 9))!;
    expect(deleted.old_path).toBe("src/server/health.ts");
    expect(deleted.new_path).toBeUndefined();
  });

  it("carries both names of a renamed file", () => {
    const moved = diffCommentPosition(
      { ...FILE, change: "renamed", old_path: "src/server/healthz.ts" },
      REFS,
      target(9, 9),
    )!;
    expect(moved.old_path).toBe("src/server/healthz.ts");
    expect(moved.new_path).toBe("src/server/health.ts");
  });

  it("is nothing without the commits the diff was read at", () => {
    // A line number with no diff to resolve it against is not an address, and a comment sent
    // anyway would be refused by GitLab with nothing the reader could do about it.
    expect(diffCommentPosition(FILE, null, target(9, 9))).toBeNull();
    expect(diffCommentsAvailable(FILE, null)).toBe(false);
    expect(diffCommentsAvailable(FILE, REFS)).toBe(true);
  });

  it("is not offered on a file with no patch", () => {
    // A binary file, a pure rename and one GitLab did not expand have no line to point at.
    for (const file of [
      { ...FILE, patch: undefined, binary: true },
      { ...FILE, patch: undefined, change: "renamed" as const },
      { ...FILE, patch: undefined, collapsed: true },
    ]) {
      expect(diffCommentsAvailable(file, REFS)).toBe(false);
    }
  });
});

describe("diffCommentAnchor", () => {
  it("hangs a removed line's composer in the deletions column and everything else in the other", () => {
    const removed = diffCommentTarget(FILE, { start: 7, end: 7, side: "deletions" })!;
    expect(diffCommentAnchor(removed)).toEqual({ side: "deletions", lineNumber: 7 });

    const context = diffCommentTarget(FILE, { start: 11, end: 11, side: "additions" })!;
    expect(diffCommentAnchor(context)).toEqual({ side: "additions", lineNumber: 11 });
  });
});

describe("diffThreadsFor", () => {
  const note = (position: GitLabNote["position"], over: Partial<GitLabNote> = {}): GitLabNote => ({
    id: 1,
    author: { name: "Ada Lovelace", username: "ada" },
    body: "This drains twice.",
    system: false,
    created_at: "2026-08-06T09:00:00.000Z",
    resolvable: false,
    resolved: false,
    mine: false,
    position,
    ...over,
  });
  const list = (...discussions: GitLabDiscussionList["discussions"]): GitLabDiscussionList => ({
    discussions,
    truncated: false,
  });

  it("hangs a thread on the line and column its anchor names", () => {
    const threads = diffThreadsFor(
      FILE,
      list({
        id: "d-1",
        individual_note: false,
        notes: [note({ new_path: FILE.path, new_line: 9 })],
      }),
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ discussionId: "d-1", side: "additions", lineNumber: 9 });
    expect(diffThreadLabel(threads[0]!)).toBe("Line 9");
  });

  it("draws a removed line's thread in the deletions column", () => {
    const threads = diffThreadsFor(
      FILE,
      list({
        id: "d-2",
        individual_note: false,
        notes: [note({ old_path: FILE.path, old_line: 7 })],
      }),
    );
    expect(threads[0]).toMatchObject({ side: "deletions", lineNumber: 7 });
  });

  it("names the span of a thread about several lines", () => {
    const threads = diffThreadsFor(
      FILE,
      list({
        id: "d-3",
        individual_note: false,
        notes: [
          note({
            new_path: FILE.path,
            new_line: 10,
            line_range: { start: { new_line: 8, old_line: 9 }, end: { new_line: 10 } },
          }),
        ],
      }),
    );
    expect(threads[0]?.fromLine).toBe(8);
    expect(diffThreadLabel(threads[0]!)).toBe("Lines 8–10");
  });

  it("leaves out a comment on another file, and one about no line at all", () => {
    // A line number is unique only inside one file, so a thread drawn on the wrong file would
    // attribute somebody's objection to code they never read.
    const threads = diffThreadsFor(
      FILE,
      list(
        { id: "other", individual_note: false, notes: [note({ new_path: "src/other.ts", new_line: 9 })] },
        { id: "whole-file", individual_note: false, notes: [note({ new_path: FILE.path })] },
        { id: "plain", individual_note: true, notes: [note(undefined)] },
      ),
    );
    expect(threads).toEqual([]);
  });

  it("keeps a thread's own notes and drops what GitLab wrote itself", () => {
    const threads = diffThreadsFor(
      FILE,
      list({
        id: "d-4",
        individual_note: false,
        notes: [
          note({ new_path: FILE.path, new_line: 9 }, { id: 1, resolvable: true, resolved: true }),
          note({ new_path: FILE.path, new_line: 9 }, { id: 2, body: "Fixed." }),
          note(undefined, { id: 3, system: true, body: "changed this line in version 2" }),
        ],
      }),
    );
    expect(threads[0]?.notes.map((n) => n.id)).toEqual([1, 2]);
    expect(threads[0]?.resolved).toBe(true);
  });

  it("is empty with no file and with no comments", () => {
    expect(diffThreadsFor(null, list())).toEqual([]);
    expect(diffThreadsFor(FILE, null)).toEqual([]);
  });

  it("carries whether GitLab would accept a resolution at all", () => {
    // A standalone comment has no such state, and GitLab answers 400 for one — so the control
    // is not drawn rather than drawn dead.
    const threads = diffThreadsFor(
      FILE,
      list({
        id: "plain",
        individual_note: true,
        notes: [note({ new_path: FILE.path, new_line: 9 }, { resolvable: false })],
      }),
    );
    expect(threads[0]?.resolvable).toBe(false);
    expect(threadResolveAction(threads[0]!)).toBeNull();
  });
});

describe("threadResolution", () => {
  const note = (over: Partial<GitLabNote> = {}): GitLabNote => ({
    id: 1,
    author: { name: "Ada Lovelace", username: "ada" },
    body: "…",
    system: false,
    created_at: "2026-08-06T09:00:00.000Z",
    resolvable: true,
    resolved: false,
    mine: false,
    ...over,
  });

  it("is resolved only when every note that CAN be is", () => {
    // GitLab marks the notes rather than the thread, so reading "resolved" off the first would
    // call a thread settled while an objection under it still stands.
    expect(threadResolution([note({ resolved: true }), note({ id: 2, resolved: false })])).toEqual({
      resolvable: true,
      resolved: false,
    });
    expect(threadResolution([note({ resolved: true }), note({ id: 2, resolved: true })])).toEqual({
      resolvable: true,
      resolved: true,
    });
    // A note that cannot be resolved never keeps a thread open.
    expect(
      threadResolution([note({ resolved: true }), note({ id: 2, resolvable: false })]),
    ).toEqual({ resolvable: true, resolved: true });
  });

  it("is neither for a conversation GitLab does not resolve", () => {
    expect(threadResolution([note({ resolvable: false })])).toEqual({
      resolvable: false,
      resolved: false,
    });
    expect(threadResolution([])).toEqual({ resolvable: false, resolved: false });
  });

  it("offers the direction the thread is not in, and says what it costs", () => {
    const open = threadResolveAction({ resolvable: true, resolved: false })!;
    expect(open.label).toBe("Resolve");
    expect(open.resolved).toBe(true);
    expect(open.hint).toContain("everybody watching");

    const settled = threadResolveAction({ resolvable: true, resolved: true })!;
    expect(settled.label).toBe("Reopen");
    expect(settled.resolved).toBe(false);
  });
});

describe("noteWasEdited", () => {
  const at = (created: string, updated?: string): GitLabNote => ({
    id: 1,
    author: { name: "Ada Lovelace", username: "ada" },
    body: "…",
    system: false,
    created_at: created,
    updated_at: updated,
    resolvable: false,
    resolved: false,
    mine: true,
  });

  it("is the two timestamps differing, and nothing else", () => {
    expect(noteWasEdited(at("2026-08-06T09:00:00Z", "2026-08-06T09:30:00Z"))).toBe(true);
    expect(noteWasEdited(at("2026-08-06T09:00:00Z", "2026-08-06T09:00:00Z"))).toBe(false);
  });

  it("says nothing when GitLab said nothing", () => {
    // A mark nobody can justify is worse than no mark: an absent timestamp is "not known to be
    // edited", never "edited".
    expect(noteWasEdited(at("2026-08-06T09:00:00Z"))).toBe(false);
    expect(noteWasEdited(at("", "2026-08-06T09:30:00Z"))).toBe(false);
  });
});
