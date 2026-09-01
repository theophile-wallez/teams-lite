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

/** What a row and a file header of a diff MEASURE, for the feed to reserve room with.
 *
 *  The renderer virtualizes the feed, so it has to know a file's height before that file is
 *  mounted — and it can only know it from these numbers. They are `web/src/styles/app.css`'s
 *  own (`--diffs-line-height`, and the header that font size and the padding make), which is
 *  why they live beside {@link DIFF_THEMES} rather than inside the renderer's seam: a stylesheet
 *  that changed the type and left these behind would leave a 900-line file reserving the wrong
 *  room, and the scrollbar would jump under the reader as each file was measured. */
export const DIFF_FEED_METRICS = { lineHeight: 19, diffHeaderHeight: 43, spacing: 8 } as const;

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

// ---- the FEED ---------------------------------------------------------------
//
// Every changed file is drawn one after another in one scroller, so a review is read by
// scrolling rather than by pressing a row per file. Two facts about it are decisions rather
// than plumbing, and both live here because both have to be testable without the renderer:
// WHICH file the reader is at, and WHEN an item has to be handed to the renderer again.

/** How far past the top of the viewport a file may start and still be the one being read.
 *
 *  A few pixels, because the file at the top of the screen IS the answer and a fractional
 *  scroll position must not hand it to the file above. */
export const DIFF_FEED_TOLERANCE = 8;

/** Where one file of the feed begins, measured by the renderer. */
export type DiffFeedTop = { path: string; top: number };

/**
 * The file the reader is at: the last one that begins at or above the top of the viewport.
 *
 * That is the file whose code fills the top of the screen, which is what the tree then lights —
 * and it is the same answer a sticky file header gives, so the row and the header agree.
 *
 * **A file the feed CANNOT bring to the top is the one exception**, and it is what keeps a press
 * honest. The last screenful of a diff holds several files at once, and the scroll runs out before
 * any of them reaches the top — so the rule above would answer with whichever one happens to
 * start above the fold, and a press on any of the others would light a row the reader did not
 * press. While the feed is pinned at its end, a file the reader ASKED for and can see is the file
 * they are at; scrolling away from it hands the question back to the rule above.
 */
export function activeDiffFeedFile(
  tops: DiffFeedTop[],
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  asked: string | null = null,
): string | null {
  if (tops.length === 0) return null;
  // Within a pixel of the end: a scroll position is fractional on a device-pixel display.
  const pinnedAtEnd = viewportHeight > 0 && scrollTop + viewportHeight >= scrollHeight - 1;
  if (pinnedAtEnd && asked) {
    const index = tops.findIndex((entry) => entry.path === asked);
    // One file's room runs to where the next one begins, and the last one's to the end.
    const top = index < 0 ? 0 : tops[index]!.top;
    const bottom = index < 0 ? 0 : (tops[index + 1]?.top ?? scrollHeight);
    if (index >= 0 && top < scrollTop + viewportHeight && bottom > scrollTop) return asked;
  }
  let current = tops[0]!.path;
  for (const entry of tops) {
    if (entry.top > scrollTop + DIFF_FEED_TOLERANCE) break;
    current = entry.path;
  }
  return current;
}

/** Whether two reads describe the same file in the same state — every field that decides what is
 *  drawn, the patch included.
 *
 *  It is a CONTENT comparison because a read is fresh JSON every time: a background refresh, a
 *  poll, or a write's own re-read hands the page objects nobody has seen before, and almost all of
 *  them say exactly what the last ones said. */
export function sameDiffFile(a: GitLabDiffFile, b: GitLabDiffFile): boolean {
  return (
    a.path === b.path &&
    a.old_path === b.old_path &&
    a.change === b.change &&
    a.patch === b.patch &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.binary === b.binary &&
    a.collapsed === b.collapsed &&
    a.generated === b.generated
  );
}

/** What one file of the feed was last handed to the renderer as: the file itself, the cards on
 *  it, and how many times either has changed. */
export type DiffFeedVersion = { file: GitLabDiffFile; cards: string; version: number };

/**
 * The version number each file's item carries, moved for the files that really CHANGED.
 *
 * `@pierre/diffs`' own `CodeView` keeps the item snapshot it holds while the version is
 * unchanged — which is what lets it hold a mounted, highlighted file still while the list around
 * it is rebuilt. Both halves of that bargain matter, and each was got wrong once:
 *
 *   - a version that does NOT move when the file did leaves the renderer drawing the old file.
 *     That is what the expanded read is: a file GitLab withheld comes back WITH its patch, under
 *     the same path, and the feed went on showing the sentence explaining there was nothing to
 *     see.
 *   - a version that moves when nothing did hands the renderer all 149 files again — for one
 *     comment box, or for a refresh that changed nothing.
 *
 * `cards` is what hangs under the file's lines, as one string (see `diffAnnotationKey`); the
 * number is only ever the count of changes, because that is all the renderer compares.
 */
export function diffFeedVersions(
  previous: Map<string, DiffFeedVersion>,
  entries: { file: GitLabDiffFile; cards: string }[],
): Map<string, DiffFeedVersion> {
  const next = new Map<string, DiffFeedVersion>();
  for (const entry of entries) {
    const held = previous.get(entry.file.path);
    const same = !!held && held.cards === entry.cards && sameDiffFile(held.file, entry.file);
    next.set(entry.file.path, {
      file: entry.file,
      cards: entry.cards,
      version: same ? held!.version : (held?.version ?? 0) + 1,
    });
  }
  return next;
}

// ---- the page's own two columns ---------------------------------------------

/** Which of the page's two columns is on screen, when only one can be.
 *
 *  `files` is the tree, `patch` is the file it picked. On a wide screen the question does not
 *  arise — both are up — and `diffPageColumns` says so. */
export type DiffColumn = "files" | "patch";

/** Where the page stops being two columns and becomes one page then another.
 *
 *  The app's own `md` breakpoint, and deliberately the same number: below it every surface in
 *  this app is a list that a detail takes the screen from (see `paneOpen` in
 *  `components/app.tsx`), and a diff is a list of files and one file. A tree beside a patch at
 *  390 px is a 120 px column of truncated paths next to eight characters of code. */
export const DIFF_COLUMNS_MIN_WIDTH = 768;

/** What the page draws at this width: both columns, or the one named.
 *
 *  Returning the pair rather than a boolean is what keeps the decision in one place — the
 *  header's Back control, the tree's own visibility and the patch's are three readings of one
 *  answer, and three `width >=` comparisons would eventually disagree. */
export function diffPageColumns(
  width: number,
  column: DiffColumn,
): { files: boolean; patch: boolean; narrow: boolean } {
  // Width 0 is the first paint, before anything is measured. It resolves to the FILES column
  // alone, which is the honest opening state of a page whose subject the reader has not picked
  // yet — and never to a patch drawn at a width nothing has measured.
  const narrow = width < DIFF_COLUMNS_MIN_WIDTH;
  if (!narrow) return { files: true, patch: true, narrow };
  return { files: column === "files", patch: column === "patch", narrow };
}

// ---- how WIDE each column is ------------------------------------------------
//
// The files column shipped at a fixed `w-72`, and the reader has two reasons to disagree with it
// that pull opposite ways: a deep tree (`src/main/java/com/acme/…`) truncates every path at that
// width, and a reader who has picked their file wants the room back for the code. So both side
// columns are dragged, and their widths are remembered per browser like the unified/split choice
// (see `applyPersistedDiffColumnWidths` in lib/store.ts) — a per-screen decision with no upstream
// to write it to.
//
// Every number below is a WIDTH IN PIXELS and every rule about them is here rather than in the
// component, for the reason `diffPageColumns` is: the splitter, the column it sizes, the panel on
// the other side and the persisted value are four readings of one answer.

/** What the files column has always been: `w-72`, 18rem. It stays the default because it is the
 *  width every capture and every reader of this page has seen. */
export const FILES_COLUMN_DEFAULT_WIDTH = 288;

/** The narrowest the files column goes. Below this a path is truncated to its extension and the
 *  tree stops being a way of finding a file — and the stat decoration on the row (`+12 −3`) has
 *  nowhere to sit. */
export const FILES_COLUMN_MIN_WIDTH = 180;

/** What the occurrences panel opens at, and the narrowest it goes.
 *
 *  It is wider than the tree by default because its rows hold a line of CODE rather than a path,
 *  and narrower than the code column because it is a list of places rather than a place to read. */
export const SYMBOLS_PANEL_DEFAULT_WIDTH = 340;
export const SYMBOLS_PANEL_MIN_WIDTH = 240;

/** The room the CODE keeps, whatever the reader drags.
 *
 *  This is the one number here that is not a preference: the patch is what the page is FOR, and a
 *  reader who drags a splitter to the far side must not be able to leave themselves eight
 *  characters of code — the same argument `SPLIT_MIN_WIDTH` makes for refusing the split layout on
 *  a phone. So a drag is clamped against it, and with both side columns open it is what decides
 *  which of them gives way (see {@link resolveDiffColumnWidths}). */
export const DIFF_CODE_MIN_WIDTH = 360;

/** Whether the reader may drag the columns at all.
 *
 *  Exactly when both columns are on screen: below `DIFF_COLUMNS_MIN_WIDTH` the page is one column
 *  at a time and each fills the screen, so a splitter there would size nothing — and a control
 *  that changes nothing reads as a bug, which is the rule that already hides the unified/split
 *  toggle below `SPLIT_MIN_WIDTH`. It reads the same number `diffPageColumns` does, through it, so
 *  the two can never disagree about whether there are two columns to divide. */
export function diffColumnsAreResizable(width: number): boolean {
  return !diffPageColumns(width, "files").narrow;
}

/** One column's own width, brought inside its bounds and the viewport's.
 *
 *  A stored width outlives the screen it was chosen on — a laptop undocked from a wide monitor
 *  reads back 900 px for a column in a 1280 px window — so every width is clamped on the way OUT
 *  of the store rather than only on the way in. `Math.round` because a fractional column width is
 *  a fractional gap beside it at some device pixel ratios. */
export function clampDiffColumnWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

/**
 * The width each side column really gets, for a viewport and the two the reader asked for.
 *
 * ONE function rather than a clamp per column, because the two are not independent: the code
 * between them keeps {@link DIFF_CODE_MIN_WIDTH}, so on a narrow-ish desktop the pair cannot both
 * have what was stored for them and something has to give.
 *
 * **The OCCURRENCES panel gives way first, and the files column second.** The panel is the
 * transient one — it was opened by a press a moment ago and is closed by another — while the files
 * column is the page's own furniture, at a width the reader set deliberately and expects to find
 * again. Taking the room from the tree instead would move the whole page's shape every time a name
 * was pressed, which is the jump this order exists to avoid. If shrinking the panel is not enough
 * the tree gives way too, and only then does the code go below its minimum — which is a window too
 * narrow to hold this layout at all, and is why `diffColumnsAreResizable` is false there.
 */
export function resolveDiffColumnWidths(input: {
  viewport: number;
  files: number;
  symbols: number;
  symbolsOpen: boolean;
}): { files: number; symbols: number } {
  // A viewport of 0 is the first paint, before anything is measured. Nothing is clamped against
  // it — and the ceiling has to be lifted BEFORE the clamps rather than after them, or each column
  // is clamped to `min(asked, 0)` and comes back at its own minimum, which is precisely the bug
  // this guard exists to prevent.
  const unmeasured = input.viewport <= 0;
  const ceiling = unmeasured ? Number.POSITIVE_INFINITY : input.viewport;
  const symbolsWanted = input.symbolsOpen
    ? clampDiffColumnWidth(input.symbols, SYMBOLS_PANEL_MIN_WIDTH, ceiling)
    : 0;
  const filesWanted = clampDiffColumnWidth(input.files, FILES_COLUMN_MIN_WIDTH, ceiling);
  if (unmeasured) return { files: filesWanted, symbols: symbolsWanted };
  let symbols = symbolsWanted;
  let files = filesWanted;
  const overflow = () => files + symbols + DIFF_CODE_MIN_WIDTH - input.viewport;
  if (overflow() > 0 && symbols > 0) {
    symbols = Math.max(SYMBOLS_PANEL_MIN_WIDTH, symbols - overflow());
  }
  if (overflow() > 0) {
    files = Math.max(FILES_COLUMN_MIN_WIDTH, files - overflow());
  }
  return { files, symbols };
}
