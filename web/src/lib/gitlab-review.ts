// The AI reading of a merge request's diff, and every decision the view of it makes.
//
// A mirror of `src/gitlab_review.rs` (the backend runs the agent, holds the answer to the diff it
// was about, and stores it; this page never reaches a model), plus the pure rules the surface is
// built from — whether a reading is still ABOUT the diff on screen, what order the groups are drawn
// in, and which files a group holds.
//
// Everything here is pure: no DOM, no network, no React, and nothing from `@pierre/diffs`. That is
// the split `gitlab-diff.ts` already holds and for its reason.
//
// **THE READING IS A PAGE, and that reverses what this file said when it shipped.** It was a second
// VIEW of one read — a control in the diff page's header, on the argument the Pipelines page makes
// for its graph beside its job list ("JOBS are a second view of one read, not a second surface").
// That argument held while the view was a MAP: a list of headings over the same file names the tree
// was already showing, with a press that took the reader to the feed. It stops holding the moment
// the reading became a DOCUMENT — its own prose, its own code (the real patches, in flow, under the
// paragraph that explains them) and its own conversation. Those are different content read a
// different way, which is the definition of a second surface rather than a second view, so it is
// `/mr/<id>/review` and the three things a URL gives are the point: it survives a reload, it can be
// sent to whoever is being asked to review, and the browser's own Back leaves it.
//
// What that costs is one more tab in a strip of four, and the strip APPENDS rather than inserts so
// no tab a reader has learned moves (see `MERGE_REQUEST_PAGES`).
//
// **A READING CAN GO STALE, and saying so is the whole of what makes it trustworthy.** It is a
// reading of one COMMIT: the backend stores the `head_sha` it read, and if the branch has moved
// since then the grouping is about files that may no longer be there. Nothing here hides that or
// throws the reading away — a stale reading is still the best account of the branch anybody has —
// but the view says it, and the reader can ask again.

import type { GitLabDiff, GitLabDiffFile } from "./gitlab-diff";

/** One file inside a theme, and what the reading said about that file. Mirrors
 *  `gitlab_review::ReviewFile`. */
export type GitLabReviewFile = {
  path: string;
  note?: string;
};

/** One theme. Mirrors `gitlab_review::ReviewTheme`. */
export type GitLabReviewTheme = {
  title: string;
  summary: string;
  files: GitLabReviewFile[];
};

/** A whole reading. Mirrors `gitlab_review::Review`. */
export type GitLabReview = {
  head_sha: string;
  headline: string;
  themes: GitLabReviewTheme[];
  /** Every changed file no theme claimed — never hidden, because a grouped view of a diff is a
   *  claim about the whole diff (see the Rust module). */
  unplaced: string[];
  provider: string;
  model?: string;
  generated_ms: number;
  /** Whether the diff the model was handed was cut, and how many files never reached it. */
  truncated: boolean;
  files_unseen: number;
};

/**
 * Whether the reading is of a DIFFERENT commit from the one on screen.
 *
 * `false` when either sha is missing rather than `true`: a reading whose commit nothing can compare
 * is not KNOWN to be stale, and marking it stale on a missing field would put a warning on every
 * reading made against a merge request whose `diff_refs` this page never read. It is the reading
 * `mergeVerdict` takes for a status nobody recognises, inverted for the direction that is safe here
 * — the cost of a missed warning is a reader trusting a slightly old grouping, and the cost of a
 * false one is a warning on every reading, which is a warning nobody reads.
 */
export function reviewIsStale(
  review: GitLabReview | null | undefined,
  headSha: string | null | undefined,
): boolean {
  if (!review?.head_sha || !headSha) return false;
  return review.head_sha !== headSha;
}

/** What the panel says under the headline: which machine read it, and when.
 *
 *  The PROVIDER and the MODEL both, because a reader deciding how much to trust a machine's reading
 *  of their branch is owed the name of the machine — and the two are different facts, since one CLI
 *  runs several models. */
export function reviewAttribution(review: GitLabReview): string {
  return review.model ? `${review.provider} · ${review.model}` : review.provider;
}

/** What a reading could NOT see, when it could not see something. `null` when it read the whole
 *  diff.
 *
 *  Only the CUT is reported here. A file no theme claimed is not something the reading missed — it
 *  is something it SAW and did not group, and it is drawn in a group of its own rather than
 *  mentioned in a sentence, because the reader still has to review it. */
export function reviewLimits(review: GitLabReview): string | null {
  if (!review.truncated) return null;
  const files = `${review.files_unseen} ${review.files_unseen === 1 ? "file" : "files"}`;
  return `This branch was too large to read whole: ${files} never reached the model, so nothing here is about them.`;
}

// ---- the DOCUMENT: how much of each patch is drawn in flow -------------------
//
// The reading draws the REAL PATCH of every file it names, under the prose about it — which is
// what makes it a read-through rather than an index. Three things follow, and the last two are
// why there are budgets here at all:
//
//   - **The code is the diff's, never the model's.** A model asked to quote the change would
//     paraphrase it, and a paraphrased patch is invented code presented as somebody's branch.
//     So the page renders the patch the read already holds and the model only ever NAMES files —
//     the rule `from_answer` holds for a path, applied to the code itself.
//   - **A patch is not a paragraph.** Measured on this instance, one file's patch runs to 900
//     lines and a theme can hold several. Drawn whole, the document that was meant to be readable
//     would be the diff feed with headings in it — while the FEED, one press away on the strip, is
//     the surface built for reading a patch at length: it virtualizes, and this does not.
//   - **AND NOTHING HERE VIRTUALIZES, which is what makes the second budget a correctness rule
//     rather than a taste.** Every shown patch is a mounted `FileDiff` with a shadow root and a
//     highlighter of its own, all of them at once. A reading of a 149-file branch can name forty
//     small files, and forty of those on one first paint is a page that hangs before a word of the
//     prose is legible — so the DOCUMENT has a ceiling as well as each file.
//
// Both budgets are the reader's to overrule, per file, from then on.

/** The most lines of patch text a file may hold and still open with its code SHOWN.
 *
 *  A screen and a half: enough that an ordinary change — a handler, a chart value, a test — is
 *  read without a press, and small enough that a 900-line file is a decision the reader makes. */
export const REVIEW_PATCH_OPEN_LINES = 80;

/** The most patches the document opens SHOWN, over the whole reading.
 *
 *  Twelve, which is more code than anybody reads in one pass and few enough to mount at once. Past
 *  it the patches are folded and say so, and the count of what folded is stated — a document that
 *  quietly stopped showing code would read as a reading that ran out of things to say. */
export const REVIEW_PATCHES_SHOWN = 12;

/** What one file's patch is worth drawing, or `null` when there is nothing to draw at all.
 *
 *  Four of the five states a file arrives in carry no patch (§ The DIFF is a PAGE) — a binary
 *  file, a pure rename, one GitLab collapsed — and those have no code, no fold and no count. The
 *  header note says which state it is, exactly as it does in the feed. */
export type ReviewPatch = {
  /**
   * How many lines the patch's own TEXT holds.
   *
   * The patch's lines rather than the renderer's rows, which is what a reader is really being
   * warned about — and it is countable here, with no `@pierre/diffs` anywhere near this file,
   * which is the split this module exists to keep. The two differ by the git header this app's
   * backend writes and by whatever context the renderer lets the reader open, so the number is
   * named for what it counts.
   */
  lines: number;
  /** Whether the document opens with this code SHOWN. False for a patch over
   *  {@link REVIEW_PATCH_OPEN_LINES}, and for every patch past {@link REVIEW_PATCHES_SHOWN}
   *  however short it is. */
  shown: boolean;
};

/** How many lines of text a patch holds, or 0 for a file that carries none. */
export function patchTextLineCount(patch: string | null | undefined): number {
  if (!patch) return 0;
  // A trailing newline terminates the last line rather than starting an empty one — the trap
  // `patchTextLines` already states for its own walk.
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  if (body.length === 0) return 0;
  let lines = 1;
  for (let at = 0; at < body.length; at += 1) if (body.charCodeAt(at) === 10) lines += 1;
  return lines;
}

/** One file of a group: the real changed file, whatever the reading said about it, and how much of
 *  its code the document opens with. */
export type ReviewGroupFile = {
  file: GitLabDiffFile;
  note?: string;
  /** `null` for a file that carries no patch at all. */
  patch: ReviewPatch | null;
};

/** One group as the view draws it: a theme, or the leftovers.
 *
 *  The two are ONE type because they are drawn the same way — a heading, some prose, and the files
 *  under it — and because the leftovers are not a footnote: a reviewer has to read those files too,
 *  so they are a group at the END rather than a sentence at the bottom. */

export type ReviewGroup = {
  /** `null` for the leftovers, which are not a theme the model stated. */
  title: string | null;
  summary: string;
  files: ReviewGroupFile[];
  /** Whether this is the group of files nothing claimed. The view marks it, because "the reading
   *  did not place these" is a different claim from "these belong together". */
  unplaced: boolean;
};

/** The prose the leftovers carry. It says what the group IS rather than apologising for it: these
 *  are changed files, they still need reading, and the grouping simply had nothing to say. */
export const UNPLACED_SUMMARY =
  "The reading did not place these files under any theme. They are part of the branch and still need reviewing.";

export const UNPLACED_TITLE = "Not grouped";

/**
 * The groups to draw, in order: the themes as the reading stated them, then the leftovers.
 *
 * Every file is resolved against the DIFF, so a group holds the real changed file — its patch, its
 * stat and what happened to it — rather than a path the model typed. A path the diff no longer holds
 * is dropped here as well as in Rust, and that second check is not redundant: a stored reading
 * outlives the diff it was made from, so a branch that moved can leave a reading naming a file the
 * page is not drawing. Dropping it is what stops the view from drawing a heading over nothing.
 *
 * A theme left with no files at all is dropped whole, for the reason the Rust parse drops one.
 *
 * **The patch budgets are spent HERE**, because this is the one walk that goes through the document
 * in the order a reader meets it — and "how many patches has this page already opened" is a fact
 * about the document rather than about any one file. A component asking per file could only answer
 * the per-file half.
 */
export function reviewGroups(
  review: GitLabReview | null | undefined,
  diff: GitLabDiff | null | undefined,
): ReviewGroup[] {
  if (!review || !diff) return [];
  const byPath = new Map(diff.files.map((file) => [file.path, file]));
  const groups: ReviewGroup[] = [];
  // The FIRST theme to name a file gets it. The Rust parse already holds a fresh answer to that
  // rule, and this is the same answer for a payload from anywhere else — an older backend, a store
  // row somebody edited. It is not belt-and-braces: a file drawn under two headings is a file
  // reviewed twice, and it would make `reviewCoverage` claim to account for more files than the diff
  // holds.
  const claimed = new Set<string>();
  // How many patches the document has opened so far, across every group.
  let shown = 0;
  const entryFor = (file: GitLabDiffFile, note?: string): ReviewGroupFile => {
    const lines = patchTextLineCount(file.patch);
    let patch: ReviewPatch | null = null;
    if (lines > 0) {
      // Both budgets, in the one place they can be spent together: short enough to read, AND
      // inside the document's own ceiling. A long patch does not spend the ceiling — it was never
      // going to be mounted — so a document of long files still opens twelve of its short ones.
      const fits = lines <= REVIEW_PATCH_OPEN_LINES;
      const room = shown < REVIEW_PATCHES_SHOWN;
      patch = { lines, shown: fits && room };
      if (patch.shown) shown += 1;
    }
    return { file, ...(note ? { note } : {}), patch };
  };
  for (const theme of review.themes) {
    const files = theme.files
      .map((entry): ReviewGroupFile | null => {
        const file = byPath.get(entry.path);
        if (!file || claimed.has(entry.path)) return null;
        claimed.add(entry.path);
        return entryFor(file, entry.note);
      })
      .filter((entry): entry is ReviewGroupFile => entry !== null);
    if (files.length === 0) continue;
    groups.push({ title: theme.title, summary: theme.summary, files, unplaced: false });
  }
  // The leftovers come from the DIFF rather than from the stored list, so a file added by a push
  // since the reading was made turns up here instead of being invisible: a group of "everything no
  // theme claimed" is only honest if it is computed against what is on screen now.
  const leftovers = diff.files.filter((file) => !claimed.has(file.path));
  if (leftovers.length > 0) {
    groups.push({
      title: UNPLACED_TITLE,
      summary: UNPLACED_SUMMARY,
      // The leftovers get the same budget rather than a rule of their own: the reading had nothing
      // to say about them, so their code is the only thing on the page that speaks for them.
      files: leftovers.map((file) => entryFor(file)),
      unplaced: true,
    });
  }
  return groups;
}

/** How many of the document's patches are FOLDED, and how many it holds in all.
 *
 *  Drawn once, at the top: a document that quietly stopped showing code past its twelfth patch
 *  would read as a reading that ran out of things to say, and the reader would not know there was a
 *  press to make. `null` when every patch the reading holds is shown. */
export function reviewFoldedPatches(
  groups: ReviewGroup[],
): { folded: number; total: number } | null {
  let folded = 0;
  let total = 0;
  for (const group of groups) {
    for (const entry of group.files) {
      if (!entry.patch) continue;
      total += 1;
      if (!entry.patch.shown) folded += 1;
    }
  }
  return folded > 0 ? { folded, total } : null;
}

/** How many files a reading really accounts for, over how many the diff holds.
 *
 *  Drawn at the top of the view, because it is the one number that says whether the grouping is a
 *  picture of the whole branch. */
export function reviewCoverage(
  review: GitLabReview | null | undefined,
  diff: GitLabDiff | null | undefined,
): { grouped: number; total: number } {
  const total = diff?.files.length ?? 0;
  if (!review) return { grouped: 0, total };
  const groups = reviewGroups(review, diff);
  const grouped = groups
    .filter((group) => !group.unplaced)
    .reduce((count, group) => count + group.files.length, 0);
  return { grouped, total };
}

/** Whether the page can offer a reading at all.
 *
 *  Exactly when there is a diff with files in it. A reading of nothing is nothing, and a control
 *  that would start an agent run over an empty diff is one that spends the reader's money to be told
 *  the branch is empty. */
export function reviewCanBeAsked(diff: GitLabDiff | null | undefined): boolean {
  return (diff?.files.length ?? 0) > 0;
}

/** The id one section of the document hangs off, so the sticky heading, the tab's own panel and
 *  anything that later points AT a theme all spell it once.
 *
 *  Keyed on the INDEX rather than on the title: two themes may be titled the same thing (the
 *  parse bounds the words and does not make them unique), and an id that collided would put two
 *  headings behind one anchor. */
export function reviewSectionId(index: number): string {
  return `gitlab-review-section-${index}`;
}
