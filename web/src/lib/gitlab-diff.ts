// The Changes section: its wire types, and every decision it makes about them.
//
// A mirror of the diff half of `src/gitlab_mr.rs` (the backend does the fetching and writes
// the patch; this page never touches the network), plus the pure rules the surface is built
// from — which file is shown, what the tree says about each one, what a file with no patch
// says instead, and whether the expanded read is worth offering.
//
// Everything here is pure: no DOM, no network, no React, and nothing from `@pierre/diffs` or
// `@pierre/trees`. That split is deliberate: those two are a 728 KB lazy chunk plus one per
// language Shiki has to load, so the section's own decisions have to be testable and renderable
// without them — `gitlab-diff-view.tsx` is the only file that imports either.
//
// The one thing worth knowing before reading further: **a file can arrive with no patch, and
// that is normal rather than a failure.** Three ways, measured against the real instance by
// `examples/merge_request_diff_recon.rs` — a binary file (4 of 508), a file GitLab did not
// expand (148 of 508), and a pure rename, which has nothing to show by definition (18 of
// 508). Each says something different, and `diffFileState` is where they are told apart.

/** Which of the two diff reads. Mirrors `gitlab_mr::DiffDepth`, and closed for its reason:
 *  the two are different GitLab endpoints with very different costs. */
export type DiffDepth = "listed" | "raw";

/** How a file changed. Mirrors `gitlab_mr::FileChange`. */
export type DiffChange = "new" | "deleted" | "renamed" | "changed";

/** One changed file. Mirrors `gitlab_mr::DiffFile`. */
export type GitLabDiffFile = {
  /** The path the file has now — its old one for a deletion. What the tree is keyed on. */
  path: string;
  /** Where it was, only when that differs. Present on a rename and nothing else. */
  old_path?: string;
  change: DiffChange;
  /** A complete unified patch, the header written by the backend. Absent when there is
   *  nothing to render (see the module header). */
  patch?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  collapsed: boolean;
  generated: boolean;
};

/** Everything one merge request changed. Mirrors `gitlab_mr::MergeRequestDiff`. */
export type GitLabDiff = {
  files: GitLabDiffFile[];
  total?: number;
  truncated: boolean;
  /** How many of the files that travelled carry no patch because GitLab collapsed them. */
  collapsed: number;
  /** Whether this is the expanded read. */
  expanded: boolean;
};

/** What a file's row and its header say about it, in one word.
 *
 *  `patch` is the ordinary case. The other three are files with nothing to render, and they
 *  are kept apart because the reader's next move differs for each: a pure rename is complete
 *  as it stands, a binary file will never have a diff, and a collapsed one is one read away. */
export type DiffFileState = "patch" | "renamed" | "binary" | "collapsed";

export function diffFileState(file: GitLabDiffFile): DiffFileState {
  if (file.patch) return "patch";
  // Order matters: GitLab sets `collapsed` on a renamed row too (measured), and the backend
  // already refuses to read that as an elision. This is the same rule on this side, so a
  // payload from an older backend cannot draw a moved file as one nobody expanded.
  if (file.change === "renamed") return "renamed";
  if (file.binary) return "binary";
  return "collapsed";
}

/** What a file with no patch says in place of one. `null` for a file that has a patch, and
 *  for a rename — a rename's patch IS its header, so the renderer draws it and there is
 *  nothing to explain. */
export function diffFileNotice(file: GitLabDiffFile): string | null {
  switch (diffFileState(file)) {
    case "binary":
      return "A binary file. GitLab does not diff one, and neither does this page.";
    case "collapsed":
      return "GitLab did not expand this file — the merge request's diff is past the size it expands.";
    default:
      return null;
  }
}

/** The git status `@pierre/trees` draws a row with, for one file.
 *
 *  Its own vocabulary, which is git's: `modified` is the ordinary case, and there is no name
 *  for "generated" or "binary" — those are the header's business, not the tree's. */
export type DiffTreeStatus = "added" | "deleted" | "modified" | "renamed";

export function diffTreeStatus(file: GitLabDiffFile): DiffTreeStatus {
  switch (file.change) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/** Every path in the diff, in GitLab's own order — which is the order its own page lists
 *  them in, so a reader who knows the merge request from GitLab finds the same file first.
 *  The tree sorts what it is given; this hands it no order of its own. */
export function diffFilePaths(diff: GitLabDiff | null): string[] {
  return (diff?.files ?? []).map((file) => file.path);
}

/** The path → status pairs the tree tints its rows with. */
export function diffTreeGitStatus(
  diff: GitLabDiff | null,
): { path: string; status: DiffTreeStatus }[] {
  return (diff?.files ?? []).map((file) => ({ path: file.path, status: diffTreeStatus(file) }));
}

/** The file the section shows: the one named, or the first that has something to render.
 *
 *  Falling back to the first file WITH A PATCH is the load-bearing half. A merge request
 *  whose first alphabetical file is a lockfile GitLab collapsed would otherwise open on a
 *  sentence explaining why there is nothing to see, which reads as a diff that failed to
 *  load. The first file with a patch is the first thing a reader can actually read. */
export function selectDiffFile(
  diff: GitLabDiff | null,
  path: string | null,
): GitLabDiffFile | null {
  const files = diff?.files ?? [];
  if (files.length === 0) return null;
  if (path) {
    const named = files.find((file) => file.path === path);
    // A path that names nothing falls through rather than showing nothing: a reader who
    // switched to the expanded read, or came back to a merge request that moved, kept a
    // selection for a file that is no longer in the list.
    if (named) return named;
  }
  return files.find((file) => file.patch) ?? files[0] ?? null;
}

/** Lines added and removed across the whole diff — counted from the patches that arrived, so
 *  a collapsed file contributes nothing. That is honest: nothing came to count. */
export function diffTotals(diff: GitLabDiff | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of diff?.files ?? []) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

/** One file's own count, as the row draws it: `+12 −3`, either half dropped when it is zero,
 *  and nothing at all for a file that changed no lines. A `0` beside a `+` is noise. */
export function formatDiffStat(file: GitLabDiffFile): string {
  const parts: string[] = [];
  if (file.additions > 0) parts.push(`+${file.additions}`);
  // U+2212, the minus sign, rather than a hyphen: it lines up with the `+` at these sizes.
  if (file.deletions > 0) parts.push(`−${file.deletions}`);
  return parts.join(" ");
}

/** The section's own heading: how many files, and how many lines moved.
 *
 *  It states what TRAVELLED rather than GitLab's total, because that is what the tree below
 *  holds — and `diffTruncationNotice` says the difference separately. Two numbers in one
 *  sentence that disagree is worse than two sentences. */
export function diffSummary(diff: GitLabDiff | null): string {
  const files = diff?.files.length ?? 0;
  if (files === 0) return "No files changed.";
  const { additions, deletions } = diffTotals(diff);
  // The two counts are ONE fact — how much moved — so they stay together and only the file
  // count is separated. `7 files · +27 · −10` reads as three things; `7 files · +27 −10` reads
  // as the two it is, and it is the shape every tracker writes a diffstat in.
  const moved = [additions > 0 ? `+${additions}` : null, deletions > 0 ? `−${deletions}` : null]
    .filter(Boolean)
    .join(" ");
  const count = `${files} file${files === 1 ? "" : "s"}`;
  return moved ? `${count} · ${moved}` : count;
}

/** What this read left out, when it left anything out. `null` when it is complete.
 *
 *  A list that stops without saying so reads as a complete one — the rule the merge-request
 *  list already follows for `x-total`. */
export function diffTruncationNotice(diff: GitLabDiff | null): string | null {
  if (!diff?.truncated) return null;
  const total = diff.total;
  const shown = diff.files.length;
  if (total == null || total <= shown) {
    return "GitLab holds more changed files than this page read.";
  }
  return `${total} files changed — the ${shown} below are what this page read.`;
}

/** Whether the expanded read is worth offering, and it is exactly when something is
 *  collapsed and this is not already the expanded answer.
 *
 *  Offering it on a complete diff would be a control that changes nothing; offering it again
 *  after it ran would ask the reader to pay half a megabyte for the same answer. The
 *  expanded read does not always expand everything either — measured, 3 of 149 files stayed
 *  collapsed — which is why the notice on a file is the same sentence in both. */
export function canExpandDiff(diff: GitLabDiff | null): boolean {
  return !!diff && !diff.expanded && diff.collapsed > 0;
}

/** The control's own words, and what pressing it costs. `null` when there is nothing to
 *  offer, so a caller never has to ask twice. */
export function expandDiffHint(diff: GitLabDiff | null): { label: string; hint: string } | null {
  if (!diff || !canExpandDiff(diff)) return null;
  const count = diff.collapsed;
  return {
    label: `Expand ${count} file${count === 1 ? "" : "s"}`,
    // The cost is named before the click, for the reason the update button names its 130 MB:
    // this read is measured at half a megabyte on a large merge request, and the machine may
    // be on a metered link.
    hint: `GitLab did not expand ${count} of these files. Asking for them reads the whole diff again, which is slower and much larger.`,
  };
}

/** The Shiki themes `@pierre/diffs` highlights with, for the app's own resolved theme.
 *
 *  Both halves always travel: the component passes a `{ light, dark }` pair and names which
 *  one is current, so a theme switch re-colours the diff without the highlighter loading a
 *  grammar again. The names are `@pierre/theme`'s own — it ships with the diff renderer, so
 *  they need no install of their own and the code and its chrome match by construction. */
export const DIFF_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

/** How a diff is laid out. Pierre's own two words, kept as its own type because the choice
 *  is the reader's and is remembered per browser. */
export type DiffLayout = "unified" | "split";

/** Which layout a viewport of this width can hold.
 *
 *  Split needs two columns of code side by side, and this app is read from a phone: at 390 px
 *  a split diff is two columns of about eight characters each. So a narrow screen is always
 *  unified, whatever the reader last chose — the preference is kept, it simply cannot apply
 *  here. `SPLIT_MIN_WIDTH` is where two 60-column gutters and the app's own sidebar fit. */
export const SPLIT_MIN_WIDTH = 900;

export function effectiveDiffLayout(preferred: DiffLayout, width: number): DiffLayout {
  return width < SPLIT_MIN_WIDTH ? "unified" : preferred;
}
