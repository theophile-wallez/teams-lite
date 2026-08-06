// A comment on a DIFF LINE: which line the reader picked, where GitLab files it, and which
// threads already hang on the file on screen.
//
// A mirror of the position half of `src/gitlab_mr_write.rs` (the backend spells the wire
// `position` and computes its line codes; nothing here touches the network), plus the one
// decision this surface cannot get from anywhere else: **a diff renderer counts lines, and
// GitLab counts them twice.**
//
// `@pierre/diffs` reports a selection as a line number on a SIDE — 42 on the additions side,
// 8 on the deletions side — which is what a reader sees in the gutter. GitLab addresses the
// same line by its place in BOTH files at once, and states only the side the line is really
// on: an added line has no old line, a removed one has no new line, and a context line has
// both. The two are reconciled by walking the patch itself ([`patchLines`]), which is the
// only thing that knows what happened to each line — so a click on a line number becomes a
// position, and nothing here has to guess.
//
// Everything in this file is pure: no DOM, no network, no React, and nothing from
// `@pierre/diffs`. That is the same split `gitlab-diff.ts` makes and for the same reason: the
// renderer is a 728 KB lazy chunk, and the rules that decide where a comment goes have to be
// testable without loading it.

import type { GitLabDiffFile } from "./gitlab-diff";
import type { GitLabDiscussion, GitLabDiscussionList, GitLabNote } from "./gitlab-mr";

/** Which side of a diff a line sits on. Mirrors `gitlab_mr_write::LineSide`, and closed for
 *  its reason: it decides which line numbers the position may state. */
export type DiffLineSide = "old" | "new" | "both";

/** One line of a patch, as GitLab addresses one. Mirrors `gitlab_mr_write::AnchorLine`, plus
 *  the one field that stays on this side: `row`, which is only ever used to put two picked
 *  lines in the order the reader sees them. */
export type PatchLine = {
  /** Where the line sits in the old file — for an added line, the line it follows. */
  old: number;
  /** Where it sits in the new file — for a removed line, the line it followed. */
  new: number;
  side: DiffLineSide;
  /** Its place in the rendered patch, counted from zero. A drag runs in either direction,
   *  so this is what says which of two lines is the first. */
  row: number;
};

/** The three commits a position is resolved against. Mirrors `gitlab_mr::DiffRefs`. */
export type DiffRefs = { base_sha: string; head_sha: string; start_sha: string };

/** One line, as the `position` param carries it. */
export type WireAnchorLine = { old: number; new: number; side: DiffLineSide };

/** The `position` the backend takes — primitives only, so it spells the GitLab shape and the
 *  line codes inside it, and this page can never hand GitLab a field it does not know it is
 *  sending. Mirrors what `gitlab_diff_anchor` in src/bin/server.rs reads. */
export type WireDiffPosition = {
  refs: DiffRefs;
  new_path?: string;
  old_path?: string;
  /** The line the thread hangs under — the LAST of a range, which is where GitLab draws one. */
  line: WireAnchorLine;
  /** The FIRST line, only when the comment is about several. */
  start?: WireAnchorLine;
};

/** `@pierre/diffs`' own two words for a side, which is what a selection and an annotation are
 *  reported and drawn in. Kept apart from {@link DiffLineSide}: this one is about a COLUMN of
 *  a rendered diff, that one is about a file. */
export type PierreSide = "additions" | "deletions";

/** A selection as `@pierre/diffs` reports one. Its own `SelectedLineRange`, mirrored here so
 *  the rules below are testable without importing the renderer. `end` may sit ABOVE `start`:
 *  `start` is where the drag began, not where the range begins. */
export type PierreLineRange = {
  start: number;
  side?: PierreSide;
  end: number;
  endSide?: PierreSide;
};

/** What the reader picked: the file, and the two ends in reading order. One line is both. */
export type DiffCommentTarget = {
  /** The file's own path, as the tree and the diff pane key it. */
  path: string;
  first: PatchLine;
  last: PatchLine;
};

// ---- reading a patch --------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Every line of a patch that is drawn, with its place in each file.
 *
 * The walk is git's own and GitLab's: a context line advances both counters, a removal
 * advances the old one, an addition the new one — and each line records the counters as they
 * stood AT it, which is exactly what a line code is built from. That symmetry is the whole
 * reason this is one function: two walks, one for the display and one for the position, would
 * disagree on the first patch with a removal in it.
 *
 * Nothing before the first `@@` is a line of the file: the header this app wrote (see
 * `gitlab_mr::unified_patch`) carries `--- a/…` and `+++ b/…`, which are neither a removal nor
 * an addition. So the walk starts at the first hunk — and after that a `--- x` really IS a
 * removed line whose content begins with two dashes, which is why the header is recognised by
 * position and never by its shape.
 */
export function patchLines(patch: string | null | undefined): PatchLine[] {
  const lines: PatchLine[] = [];
  if (!patch) return lines;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const rows = patch.split("\n");
  // A patch ends with a newline, so the split leaves one empty string behind it. That is the
  // terminator and not a line — counted as one it would put a phantom context row at the foot
  // of every file, one line past the end of the code. An empty string INSIDE the patch is a
  // different thing and is kept below.
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  for (const raw of rows) {
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // "\ No newline at end of file" is a note about the line above it, not a line.
    if (raw.startsWith("\\")) continue;
    const mark = raw[0];
    if (mark === "-") {
      lines.push({ old: oldLine, new: newLine, side: "old", row: lines.length });
      oldLine += 1;
    } else if (mark === "+") {
      lines.push({ old: oldLine, new: newLine, side: "new", row: lines.length });
      newLine += 1;
    } else {
      // Everything else inside a hunk is a line that did not change. A space is the ordinary
      // spelling; an EMPTY string and a line whose leading space somebody stripped are the
      // same thing, and both are counted — skipping one would put every number below it out by
      // one, which is a comment quietly filed against the wrong line. A patch here covers one
      // file (the backend writes one per file), so there is no second `diff --git` to mistake
      // for code.
      lines.push({ old: oldLine, new: newLine, side: "both", row: lines.length });
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
}

/** A patch's lines, reachable by the number a reader sees in either gutter.
 *
 *  TWO maps rather than one keyed by side, because a line's number is unique per FILE: no two
 *  lines share a new-file number, and none share an old-file one. So a lookup cannot be wrong,
 *  whichever side the renderer reported — which matters because a context line is drawn in
 *  both columns of a split diff and in one row of a unified one. */
export type PatchLineIndex = { byOld: Map<number, PatchLine>; byNew: Map<number, PatchLine> };

export function patchLineIndex(patch: string | null | undefined): PatchLineIndex {
  const byOld = new Map<number, PatchLine>();
  const byNew = new Map<number, PatchLine>();
  for (const line of patchLines(patch)) {
    if (line.side === "old" || line.side === "both") byOld.set(line.old, line);
    if (line.side === "new" || line.side === "both") byNew.set(line.new, line);
  }
  return { byOld, byNew };
}

/** The line one gutter number names, or `null` when the patch holds none.
 *
 *  The side is a HINT and not a key: it says which gutter the reader was in, so it decides
 *  which map is asked first — and the other is still asked, because a renderer reporting a
 *  context line under either side is reporting the same line. `null` is a real answer: a
 *  reader can drag past the end of a hunk. */
export function patchLineAt(
  index: PatchLineIndex,
  lineNumber: number,
  side?: PierreSide,
): PatchLine | null {
  const first = side === "deletions" ? index.byOld : index.byNew;
  const second = side === "deletions" ? index.byNew : index.byOld;
  return first.get(lineNumber) ?? second.get(lineNumber) ?? null;
}

/**
 * What a reader's selection means: the file, and its two ends in READING order.
 *
 * The order is the load-bearing half. `@pierre/diffs` reports `start` as the line the drag
 * began on, so dragging upwards hands over a range whose start is below its end — and GitLab
 * hangs a thread on the LAST line of a range, so a pair left in pointer order would file the
 * comment at the top of the block and describe the span backwards.
 */
export function diffCommentTarget(
  file: GitLabDiffFile | null | undefined,
  range: PierreLineRange | null | undefined,
): DiffCommentTarget | null {
  if (!file || !range) return null;
  const index = patchLineIndex(file.patch);
  const anchor = patchLineAt(index, range.start, range.side);
  const other = patchLineAt(index, range.end, range.endSide ?? range.side);
  if (!anchor || !other) return null;
  const [first, last] = anchor.row <= other.row ? [anchor, other] : [other, anchor];
  return { path: file.path, first, last };
}

/** The `position` one target sends, or `null` when it cannot be placed.
 *
 *  `null` on a diff whose three commits this page never read: a line number with no diff to
 *  resolve it against is not an address, and offering the composer anyway would end in a
 *  refusal the reader could do nothing about (see [[diffCommentsAvailable]]). */
export function diffCommentPosition(
  file: GitLabDiffFile | null | undefined,
  refs: DiffRefs | null | undefined,
  target: DiffCommentTarget | null | undefined,
): WireDiffPosition | null {
  if (!file || !refs || !target) return null;
  const wire = (line: PatchLine): WireAnchorLine => ({
    old: line.old,
    new: line.new,
    side: line.side,
  });
  const position: WireDiffPosition = { refs, line: wire(target.last) };
  // A rename is the one case with two paths; every other file has one, under both names.
  // A DELETED file has only ever had the one, which is `path` here (see `gitlab_mr::DiffFile`).
  if (file.change === "deleted") position.old_path = file.path;
  else {
    position.new_path = file.path;
    position.old_path = file.old_path ?? file.path;
  }
  if (file.change === "new") delete position.old_path;
  // A range of one line is a line: GitLab's own answers carry no `line_range` for one, so
  // writing one would describe the comment as something it is not.
  if (target.first.row !== target.last.row) position.start = wire(target.first);
  return position;
}

/** Whether a comment can be put on this file at all.
 *
 *  Two ways it cannot, and each is honest rather than hidden: a file with no patch has no line
 *  to point at (a binary file, a pure rename, one GitLab did not expand — see
 *  `diffFileState`), and a diff whose commits this page has not read cannot be positioned
 *  against. A gutter control drawn in either case would collect a comment and then lose it. */
export function diffCommentsAvailable(
  file: GitLabDiffFile | null | undefined,
  refs: DiffRefs | null | undefined,
): boolean {
  return !!file?.patch && !!refs;
}

// ---- what the reader is told ------------------------------------------------

/** The number one line wears in the gutter: its new-file one, or its old-file one when that
 *  is the only file it is in. */
export function diffLineNumber(line: PatchLine): number {
  return line.side === "old" ? line.old : line.new;
}

/** What the composer says it is about: one line, or a span.
 *
 *  The numbers are the ones the reader just dragged over in the gutter, so a span that crosses
 *  a removal reads as what they saw rather than as a pair of numbers from two files. */
export function diffCommentTargetLabel(target: DiffCommentTarget): string {
  const first = diffLineNumber(target.first);
  const last = diffLineNumber(target.last);
  if (target.first.row === target.last.row) return `Line ${first}`;
  // An en dash, and the pair in reading order — which `diffCommentTarget` has already put
  // right whichever way the reader dragged.
  return `Lines ${first}–${last}`;
}

/** The hint the gutter control wears. It says the GESTURE, because the drag is the half
 *  nobody discovers by looking: a control that only said "comment" would leave a reader
 *  commenting on one line at a time for ever. */
export const DIFF_COMMENT_HINT =
  "Comment on this line — drag down the line numbers to cover several";

// ---- the threads already on the file ---------------------------------------

/** One thread hanging on one line of the file on screen. */
export type DiffThread = {
  /** GitLab's own discussion id — what a REPLY is posted to. */
  discussionId: string;
  /** The column the thread is drawn against, in the renderer's own vocabulary. */
  side: PierreSide;
  /** The line it hangs under, in that column's own numbers. */
  lineNumber: number;
  /** Every note of it, in GitLab's order — the conversation as it happened. */
  notes: GitLabNote[];
  /** Whether a thread that CAN be resolved has been. A standalone comment is neither. */
  resolved: boolean;
  /** The first line, when the thread is about several — for the span it names. */
  fromLine?: number;
};

/**
 * The threads on one file, keyed to the line each hangs on.
 *
 * Matched on the file's own paths and never on the anchor alone: a merge request touches many
 * files and a line number is only unique inside one of them, so a comment drawn on the wrong
 * file would attribute somebody's objection to code they never read.
 *
 * A position that names NO line is left out. GitLab allows a comment on a whole file, and this
 * page has no line to hang one on — it is still in the merge request's own comments panel,
 * which is where a comment about no particular line belongs.
 */
export function diffThreadsFor(
  file: GitLabDiffFile | null | undefined,
  notes: GitLabDiscussionList | null | undefined,
): DiffThread[] {
  if (!file) return [];
  const threads: DiffThread[] = [];
  for (const discussion of notes?.discussions ?? []) {
    const thread = diffThreadOf(file, discussion);
    if (thread) threads.push(thread);
  }
  return threads;
}

function diffThreadOf(file: GitLabDiffFile, discussion: GitLabDiscussion): DiffThread | null {
  // The position is the FIRST note's: a reply carries the thread's own anchor, and GitLab
  // reports it on every note, so reading one keeps the thread in one place.
  const notes = discussion.notes.filter((note) => !note.system);
  const position = notes[0]?.position;
  if (!position) return null;
  const paths = [file.path, file.old_path].filter(Boolean);
  const named = [position.new_path, position.old_path].filter(Boolean);
  if (!named.some((path) => paths.includes(path))) return null;
  const side: PierreSide = position.new_line != null ? "additions" : "deletions";
  const lineNumber = position.new_line ?? position.old_line;
  if (lineNumber == null) return null;
  const start = position.line_range?.start;
  const fromLine = side === "additions" ? start?.new_line : start?.old_line;
  return {
    discussionId: discussion.id,
    side,
    lineNumber,
    notes,
    resolved: notes.some((note) => note.resolvable && note.resolved),
    // A span whose start is the anchor is not a span. `??` is not enough here: GitLab sends a
    // range's start on the other side when the reader dragged across a removal.
    fromLine: fromLine != null && fromLine !== lineNumber ? fromLine : undefined,
  };
}

/** What one thread says it is about, above its notes. Mirrors {@link diffCommentTargetLabel},
 *  which is the same sentence for a comment not yet written. */
export function diffThreadLabel(thread: DiffThread): string {
  if (thread.fromLine == null) return `Line ${thread.lineNumber}`;
  const [first, last] =
    thread.fromLine <= thread.lineNumber
      ? [thread.fromLine, thread.lineNumber]
      : [thread.lineNumber, thread.fromLine];
  return `Lines ${first}–${last}`;
}

/** What one card hanging under a line of the diff IS: a thread that is already there, or the
 *  box for the comment being written. A closed pair, so the renderer's slot can be handed one
 *  thing and the surface decides which of the two it draws. */
export type DiffAnnotationCard =
  | { kind: "thread"; thread: DiffThread }
  | { kind: "composer"; target: DiffCommentTarget };

/** Where an annotation for one PICKED range hangs: the anchor line, in the renderer's own
 *  words. A context line is drawn on the additions side — it has a row there in both layouts,
 *  and in a split diff that is the column a reader has just been reading. */
export function diffCommentAnchor(target: DiffCommentTarget): {
  side: PierreSide;
  lineNumber: number;
} {
  return {
    side: target.last.side === "old" ? "deletions" : "additions",
    lineNumber: diffLineNumber(target.last),
  };
}
