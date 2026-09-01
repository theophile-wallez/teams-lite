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
// **THE READING IS A SECOND VIEW OF ONE READ, not a second surface.** The diff page draws the files
// as a FEED or as these THEMES, from the same `gitlabDiff` — which is the shape the Pipelines page
// already has for its graph and its job list (§ The pipeline is a GRAPH: "JOBS are a second view of
// one read"). So it is a control in the page's own header rather than a route of its own: there is
// one diff, read two ways, and a second URL for the same read would be a second thing to keep in
// step.
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

/** One group as the view draws it: a theme, or the leftovers.
 *
 *  The two are ONE type because they are drawn the same way — a heading, some prose, and the files
 *  under it — and because the leftovers are not a footnote: a reviewer has to read those files too,
 *  so they are a group at the END rather than a sentence at the bottom. */
/** One file of a group: the real changed file, and whatever the reading said about it. */
export type ReviewGroupFile = { file: GitLabDiffFile; note?: string };

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
  for (const theme of review.themes) {
    const files = theme.files
      .map((entry): ReviewGroupFile | null => {
        const file = byPath.get(entry.path);
        if (!file || claimed.has(entry.path)) return null;
        claimed.add(entry.path);
        return { file, ...(entry.note ? { note: entry.note } : {}) };
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
      files: leftovers.map((file) => ({ file })),
      unplaced: true,
    });
  }
  return groups;
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

/** Which view of the diff the reader is in. Kept as its own type because the choice is the
 *  reader's and is remembered for the session. */
export type DiffView = "files" | "themes";
