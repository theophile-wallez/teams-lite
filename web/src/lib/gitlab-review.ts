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
import { hunksTouching, narrowPatch, splitPatch, type SplitPatch } from "./gitlab-patch";

/** A region of one file, in NEW-file line numbers, both ends inclusive. Mirrors
 *  `gitlab_review::ReviewRange`. */
export type GitLabReviewRange = { from: number; to: number };

/** One PART of the branch inside a theme, and what the reading said about that part. Mirrors
 *  `gitlab_review::ReviewFile`.
 *
 *  The range is optional and means "the whole file" when it is absent — which is what every reading
 *  made before parts existed carries, so an older stored one folds into whole-file parts rather than
 *  becoming unreadable. */
export type GitLabReviewFile = {
  path: string;
  range?: GitLabReviewRange;
  note?: string;
};

/** One theme. Mirrors `gitlab_review::ReviewTheme`. */
export type GitLabReviewTheme = {
  title: string;
  summary: string;
  /** The parts this theme is about. The field keeps the name `files` on the wire so every stored
   *  reading still parses; what it holds is a part. */
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

/** Which REGION of a file one entry is about, when it is about part of one.
 *
 *  It is resolved here rather than taken from the reading: the model names a range of NEW-file lines
 *  and `hunksTouching` turns that into whole hunks, so what this carries is the region really drawn
 *  rather than the one asked for. */
export type ReviewPart = {
  /** The patch narrowed to this part's hunks — a REAL patch, header and all, so the renderer and
   *  every line walk need no special case for it (see `gitlab-patch.ts`). */
  patch: string;
  /** The NEW-file lines the kept hunks cover, which is what the box says and what a reader looks
   *  for when they go to the file. */
  from: number;
  to: number;
  /** How many hunks this part holds, and how many the file has — so the box can say "2 of 5
   *  changes" rather than only a line span, which on its own says nothing about how much is left. */
  hunks: number;
  ofHunks: number;
};

/** One entry of a group: the real changed file, which part of it this is, whatever the reading said
 *  about that part, and how much of its code the document opens with. */
export type ReviewGroupFile = {
  file: GitLabDiffFile;
  note?: string;
  /** `null` when the entry is the WHOLE file — which is every entry of a reading made before parts
   *  existed, and every entry whose range turned out to cover all of the file's hunks. */
  part: ReviewPart | null;
  /** `null` for a file that carries no patch at all. */
  patch: ReviewPatch | null;
};

/** One entry's key, for a React list.
 *
 *  A PATH is no longer unique: the whole point of a part is that one file appears under several
 *  headings. So the key carries the region, and two parts of one file are two rows rather than one
 *  row React re-uses for both — which is what would make a fold pressed on one apply to the other.
 *
 *  It rests on hunk spans being DISTINCT, which follows from the two facts above it: a patch's hunks
 *  are in increasing order and a hunk is claimed once, so two disjoint sets of them cannot share both
 *  a lowest `from` and a highest `to`. What would break it is a patch carrying the same `@@` header
 *  twice — corrupt, and not something GitLab writes. The same span is what `data-region` states on the
 *  element, so a test and a capture rest on it too. */
export function reviewPartKey(entry: ReviewGroupFile): string {
  return entry.part ? `${entry.file.path}#${entry.part.from}-${entry.part.to}` : entry.file.path;
}

/** What a part's box says it is, or `null` when the entry is the whole file.
 *
 *  Both facts, because each answers something the other cannot: the LINES are where to look in the
 *  file, and the COUNT is how much of the file is elsewhere. A box saying only "lines 96–140" leaves
 *  the reader wondering whether that is all of it. */
export function reviewPartLabel(entry: ReviewGroupFile): string | null {
  if (!entry.part) return null;
  const { from, to, hunks, ofHunks } = entry.part;
  const span = from === to ? `line ${from}` : `lines ${from}–${to}`;
  return `${span} · ${hunks} of ${ofHunks} changes`;
}

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
  "The reading did not place these under any theme. They are part of the branch and still need reviewing.";

/** The second sentence the leftovers carry when some of them are REGIONS rather than whole files.
 *
 *  Without it a reader meeting `src/server/health.ts` under both a theme and "Not grouped" would read
 *  the page as having drawn one file twice. It says what really happened: part of that file is
 *  grouped, and this is the rest. */
export const UNPLACED_PARTS_NOTE =
  "Some are regions of files whose other changes are grouped above — this is what is left of them.";

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

  // Each file's patch cut into hunks, once. The walk asks for the same file as many times as the
  // reading names it, and `splitPatch` is a full pass over the text — which for a 900-line patch is
  // not something to do per theme.
  const splits = new Map<string, SplitPatch>();
  const splitFor = (file: GitLabDiffFile): SplitPatch => {
    let split = splits.get(file.path);
    if (!split) {
      split = splitPatch(file.patch);
      splits.set(file.path, split);
    }
    return split;
  };

  // **A HUNK IS CLAIMED ONCE, and that is the rule this whole file rests on.** The FIRST theme to
  // claim a hunk gets it, so no change is drawn under two headings — reviewed twice, counted twice,
  // with no way to tell which grouping the reading meant. The Rust parse holds a COARSER version of
  // the same rule (the same path-and-range pair twice), because deciding whether two RANGES overlap
  // needs the patch and that module deliberately holds no patch parser. This is the fine answer, and
  // it is also the only one that works for a payload from anywhere else — an older backend, a store
  // row somebody edited.
  //
  // A file with NO hunks (a binary file, a pure rename, one GitLab collapsed) is atomic: it has one
  // claimable unit, index 0, which is the file itself. That keeps the whole walk on one rule instead
  // of a second path for the four states that carry no patch.
  const claimed = new Map<string, Set<number>>();
  const claimedIn = (path: string): Set<number> => {
    let set = claimed.get(path);
    if (!set) {
      set = new Set<number>();
      claimed.set(path, set);
    }
    return set;
  };

  // How many patches the document has opened so far, across every group.
  let shown = 0;
  /** One entry, with both patch budgets spent on the code it really draws. */
  const entryFor = (file: GitLabDiffFile, part: ReviewPart | null, note?: string): ReviewGroupFile => {
    // The PART's own text when there is one, so a two-hunk region of a 900-line file is measured as
    // the region — which is what decides whether it opens shown, and what the fold offers to show.
    const lines = patchTextLineCount(part ? part.patch : file.patch);
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
    return { file, ...(note ? { note } : {}), part, patch };
  };

  /** The entry for a set of hunk indices, or `null` when the set is the whole file.
   *
   *  A part that covers EVERY hunk is drawn as the whole file rather than as "lines 1–200 · 5 of 5
   *  changes", whether the reading asked for it with a range or without one: it is the same code, and
   *  a label about a region is noise when there is no other region. */
  const partOf = (file: GitLabDiffFile, take: number[]): ReviewPart | null => {
    const split = splitFor(file);
    if (split.hunks.length === 0) return null;
    if (take.length === split.hunks.length) return null;
    const wanted = new Set(take);
    const kept = split.hunks.filter((hunk) => wanted.has(hunk.index));
    const patch = narrowPatch(split, wanted);
    if (!patch || kept.length === 0) return null;
    return {
      patch,
      from: Math.min(...kept.map((hunk) => hunk.from)),
      to: Math.max(...kept.map((hunk) => hunk.to)),
      hunks: kept.length,
      ofHunks: split.hunks.length,
    };
  };

  for (const theme of review.themes) {
    const files: ReviewGroupFile[] = [];
    for (const entry of theme.files) {
      const file = byPath.get(entry.path);
      // A path the diff no longer holds is dropped here as well as in Rust, and that second check is
      // not redundant: a stored reading outlives the diff it was made from, so a branch that moved
      // can leave a reading naming a file the page is not drawing.
      if (!file) continue;
      const split = splitFor(file);
      const units = split.hunks.length;
      // Which units this entry ASKS for. A range is resolved against the hunks; no range asks for
      // the whole file.
      //
      // A range on a file with NO hunks is IGNORED rather than fatal, and the file is claimed whole.
      // There is no region of a binary file, so the range cannot mean anything — but the theme did
      // place the file, and honouring that placement is worth more to the reader than moving it to
      // the leftovers over a field that could not apply. It is the direction `range_from_value` takes
      // in Rust for a range it cannot read: a bad range costs the range, never the part.
      const wanted =
        entry.range && units > 0
          ? hunksTouching(split.hunks, entry.range.from, entry.range.to)
          : new Set(units > 0 ? split.hunks.map((hunk) => hunk.index) : [0]);
      const already = claimedIn(entry.path);
      const take = [...wanted].filter((index) => !already.has(index)).sort((a, b) => a - b);
      // Nothing left to claim: an earlier theme took these hunks, or the range named a region the
      // file does not have. Either way this entry would be a heading over no code.
      if (take.length === 0) continue;
      for (const index of take) already.add(index);
      files.push(entryFor(file, partOf(file, take), entry.note));
    }
    if (files.length === 0) continue;
    groups.push({ title: theme.title, summary: theme.summary, files, unplaced: false });
  }

  // **THE LEFTOVERS ARE PER HUNK NOW, which is what keeps "nothing is silently left out" true once a
  // file can be split.** They come from the DIFF rather than from the stored list, so a file added by
  // a push since the reading was made turns up here instead of being invisible — and a file whose
  // OTHER half a theme claimed turns up here as the half it did not.
  const leftovers: ReviewGroupFile[] = [];
  for (const file of diff.files) {
    const already = claimed.get(file.path) ?? new Set<number>();
    const split = splitFor(file);
    if (split.hunks.length === 0) {
      if (!already.has(0)) leftovers.push(entryFor(file, null));
      continue;
    }
    const rest = split.hunks.map((hunk) => hunk.index).filter((index) => !already.has(index));
    if (rest.length === 0) continue;
    // The leftovers get the same budget rather than a rule of their own: the reading had nothing to
    // say about them, so their code is the only thing on the page that speaks for them.
    leftovers.push(entryFor(file, partOf(file, rest)));
  }
  if (leftovers.length > 0) {
    const partial = leftovers.some((entry) => entry.part !== null);
    groups.push({
      title: UNPLACED_TITLE,
      summary: partial ? `${UNPLACED_SUMMARY} ${UNPLACED_PARTS_NOTE}` : UNPLACED_SUMMARY,
      files: leftovers,
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

/** How many files a reading really accounts for, over how many the diff holds — and in how many
 *  PARTS it accounts for them.
 *
 *  Drawn at the top of the view, because it is the one number that says whether the grouping is a
 *  picture of the whole branch.
 *
 *  It takes the GROUPS rather than the reading, which is the shape `reviewFoldedPatches` already has
 *  and now a correctness matter as well as a tidiness one: computing the groups is a pass over every
 *  patch in the branch, and a version of this that made its own would do that twice on every render
 *  of the page.
 *
 *  `grouped` counts distinct FILES, because a path can now appear in several groups and a count of
 *  entries would claim to account for more files than the diff holds. A file whose hunks are split
 *  across a theme and the leftovers counts as grouped — the leftovers section says the rest out loud,
 *  which is the honest place for it. */
export function reviewCoverage(
  groups: ReviewGroup[],
  diff: GitLabDiff | null | undefined,
): { grouped: number; total: number; parts: number } {
  const total = diff?.files.length ?? 0;
  const paths = new Set<string>();
  let parts = 0;
  for (const group of groups) {
    if (group.unplaced) continue;
    for (const entry of group.files) {
      paths.add(entry.file.path);
      parts += 1;
    }
  }
  return { grouped: paths.size, total, parts };
}

/** Whether the page can offer a reading at all.
 *
 *  Exactly when there is a diff with files in it. A reading of nothing is nothing, and a control
 *  that would start an agent run over an empty diff is one that spends the reader's money to be told
 *  the branch is empty. */
export function reviewCanBeAsked(diff: GitLabDiff | null | undefined): boolean {
  return (diff?.files.length ?? 0) > 0;
}

// ---- asking a FOLLOW-UP about the reading -------------------------------------
//
// The reading answers "what does this branch do". The next question is always narrower — "why is the
// 503 before the ready check", "what breaks if I drop the budget" — and the point of asking it HERE
// rather than in a chat is that the reader can POINT at what they mean: a theme, some files, and the
// question travels with exactly those.
//
// A mirror of the `ChatTurn` / `ReviewChat` half of `src/gitlab_review.rs`, plus the pure rules the
// composer is built from. Nothing here reaches a model: the backend runs the same agent the reading
// runs, with the same permissions and the same gate.

/** One question and its answer. Mirrors `gitlab_review::ChatTurn`. */
export type GitLabReviewTurn = {
  question: string;
  /** The answer as the MARKDOWN the model wrote, rendered through this app's own GFM parser. */
  answer: string;
  /** The themes the question was tagged with, by their index in the reading. */
  themes: number[];
  /** The files whose code really travelled — what the backend recorded, not what was asked for. */
  paths: string[];
  asked_ms: number;
};

/** A whole conversation. Mirrors `gitlab_review::ReviewChat`. */
export type GitLabReviewChat = { turns: GitLabReviewTurn[] };

/** One thing a question can be tagged with: a theme of the reading, or a changed file.
 *
 *  ONE type for both, because they are picked from one list and drawn as one kind of chip — the
 *  shape the composer's own "@" already has for a channel above the people, and for the providers
 *  above the personas. */
export type ReviewTag =
  | { kind: "theme"; index: number; label: string }
  | { kind: "file"; path: string; label: string };

/** A tag's own key, for a React list and for keeping a picked set unique.
 *
 *  A theme is keyed on its INDEX and a file on its PATH, so two themes titled the same thing are two
 *  tags — the reason `reviewSectionId` is keyed on the index too. */
export function reviewTagKey(tag: ReviewTag): string {
  return tag.kind === "theme" ? `theme:${tag.index}` : `file:${tag.path}`;
}

/** The most tags one question may carry.
 *
 *  It mirrors the backend's own `MAX_QUESTION_FILES` for the files, and the point of stating it here
 *  is that the composer refuses the ninth rather than letting a send drop it — the rule the
 *  composer's picture ceilings hold: what the backend enforces, the page states. */
export const MAX_REVIEW_TAG_FILES = 8;

/** Everything a question can be tagged with, themes first.
 *
 *  The order is the argument the composer's own "@" makes: the THEMES are a short fixed list a
 *  reader learns once, and the files grow — so a list whose first row moved as files were added
 *  would have to be read every time. Within each, the reading's own order.
 *
 *  Only the files the DIFF holds are offered, because those are the only ones whose code can travel
 *  (`build_chat_prompt` drops any other) — so a row that could not be honoured is never drawn. */
export function reviewTags(
  review: GitLabReview | null | undefined,
  diff: GitLabDiff | null | undefined,
): ReviewTag[] {
  if (!review || !diff) return [];
  const tags: ReviewTag[] = review.themes.map((theme, index) => ({
    kind: "theme" as const,
    index,
    label: theme.title,
  }));
  for (const file of diff.files) {
    tags.push({ kind: "file" as const, path: file.path, label: file.path });
  }
  return tags;
}

/** The tags whose label matches what has been typed after the trigger, bounded.
 *
 *  Case-insensitive and a SUBSTRING rather than a prefix, because a path is `src/server/health.ts`
 *  and nobody types the directory to find the file — the rule the emoji typeahead's own search
 *  follows for an alias. Already-picked tags are left out: a control that changes nothing reads as a
 *  bug, and picking one twice sends it once anyway. */
export function matchReviewTags(
  tags: ReviewTag[],
  query: string,
  picked: ReadonlySet<string>,
  limit = 8,
): ReviewTag[] {
  const needle = query.trim().toLowerCase();
  const out: ReviewTag[] = [];
  for (const tag of tags) {
    if (picked.has(reviewTagKey(tag))) continue;
    if (needle && !tag.label.toLowerCase().includes(needle)) continue;
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * How one tag is WRITTEN INSIDE the question.
 *
 * **A tag is words in the prompt, not a chip beside it**, which is the shape every other "@" in this
 * app takes: `@claude` is read back out of a message's own words (`agent_policy::address_in`), a
 * tracker reference is read out of them (`lib/tracker-ref.ts`), and a chess move is read out of them.
 * There is nothing to keep in step, the reader can edit or delete a tag with the caret like any other
 * word, and what will travel is legible in the sentence itself rather than in a row above it.
 *
 * A FILE is one word — a path holds no space — so it is written bare. A THEME's title is a sentence,
 * so it takes the BRACKET form this app already uses for a mention whose name has spaces
 * (`@[Ada Byron]`, see § @mentions): without it, `@A replica is drained` would end at the first
 * space and name nothing.
 */
export function reviewTagText(tag: ReviewTag): string {
  return tag.kind === "file" ? `@${tag.path}` : `@[${tag.label}]`;
}

/** What a CHIP shows for one tag — which is not what the question SPELLS it as.
 *
 *  A theme shows its title. A FILE shows its own name and extension and not its path: measured on
 *  this instance, a path runs to `tooling/ci/components/blocks/kubernetes-agent.gitlab-ci.yaml`, and
 *  a chip carrying all of that is a chip the width of the composer — it says where the file lives
 *  four times over and what it is once. The whole path stays in the chip's `title`, so it is one
 *  hover away, and it stays in the WORDS, which is what travels (`reviewTagText`).
 *
 *  Two files with the same name are two chips reading alike, and that is deliberate: the alternative
 *  is a chip whose length depends on what else the branch changed. What tells them apart is the
 *  hover, and the line under a sent question, which names what really travelled in full. */
export function reviewTagLabel(tag: ReviewTag): string {
  if (tag.kind === "theme") return tag.label;
  const cut = tag.path.lastIndexOf("/");
  return cut < 0 ? tag.path : tag.path.slice(cut + 1);
}

/** One run of a question: words, or a tag drawn as a chip.
 *
 *  It is what both surfaces that draw a question are built from — the composer's own editor and the
 *  bubble a sent question lands in — so a chip means the same thing before and after the press. */
export type ReviewQuestionPart =
  | { kind: "text"; text: string }
  | { kind: "tag"; tag: ReviewTag };

/**
 * A question cut into its WORDS and its TAGS, in the order they are written.
 *
 * **This is the one walk over a question's text**, and {@link reviewTagsInText} is it with the words
 * thrown away — the rule `patchTextLines` holds for its own walk and for its reason: what travels
 * and what is DRAWN must be decided by one pass, or the bubble would draw a chip over a run the send
 * did not count as a tag. The two really did have to be one function, because the drawing came second
 * and a second scanner is exactly how they would drift.
 *
 * A run that matches no tag stays the words it is, which is the rule an @mention naming a person the
 * thread does not hold already follows: `@rfc-2119` in a question is a question about `@rfc-2119`.
 */
export function reviewQuestionParts(text: string, tags: ReviewTag[]): ReviewQuestionPart[] {
  const parts: ReviewQuestionPart[] = [];
  let plain = "";
  const flush = () => {
    if (plain) parts.push({ kind: "text", text: plain });
    plain = "";
  };
  let at = 0;
  const spellings = tagSpellings(tags);
  while (at < text.length) {
    const next = text.indexOf("@", at);
    if (next < 0) break;
    const found =
      spellings.find(
        (candidate) =>
          text.startsWith(candidate.text, next) && endsATag(text, next + candidate.text.length),
      ) ?? null;
    if (!found) {
      // Not a tag: the "@" and everything up to it are words. Advancing PAST the "@" is what stops
      // the walk looping on it.
      plain += text.slice(at, next + 1);
      at = next + 1;
      continue;
    }
    plain += text.slice(at, next);
    flush();
    parts.push({ kind: "tag", tag: found.tag });
    at = next + found.text.length;
  }
  plain += text.slice(at);
  flush();
  return parts;
}

/** Every tag's own spelling, longest first.
 *
 *  It is a TIE-BREAK rather than the rule that keeps `@src/a.ts` out of `@src/a.tsx` — `endsATag` is
 *  what does that, and a mutation of this order fails no test today, because it only decides between
 *  two tags where one spelling IS the other plus a character `endsATag` allows (a path ending in
 *  `?`). Kept because it costs nothing and the alternative is a silent wrong answer the day such a
 *  pair exists. */
function tagSpellings(tags: ReviewTag[]): { tag: ReviewTag; text: string }[] {
  return tags
    .map((tag) => ({ tag, text: reviewTagText(tag) }))
    .sort((a, b) => b.text.length - a.text.length);
}

/**
 * The tags a question's own WORDS name, in the order they are written, each once.
 *
 * The one thing that decides what TRAVELS, so what the composer offered and what leaves cannot
 * disagree — and a tag the reader deleted with the caret is simply gone, with nothing to clean up.
 * It is {@link reviewQuestionParts} with the words projected away, which is what keeps the drawing
 * and the sending one answer.
 */
export function reviewTagsInText(text: string, tags: ReviewTag[]): ReviewTag[] {
  const picked: ReviewTag[] = [];
  const seen = new Set<string>();
  for (const part of reviewQuestionParts(text, tags)) {
    if (part.kind !== "tag") continue;
    const key = reviewTagKey(part.tag);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(part.tag);
  }
  return picked;
}

/** The characters that may FOLLOW a tag, so a spelling is never found inside a longer word.
 *
 *  Whitespace and the end of the text are the ordinary ones. The punctuation a SENTENCE owns is here
 *  too, because a reader really does write "and not @src/server/health.ts?" — the rule
 *  `agent_policy::split_prefix` states for an agent's own address ("the punctuation an address is
 *  written with belongs to it"), and without it a tag would name nothing whenever it ended a question.
 *  And `@` itself, so two tags written with nothing between them are two tags.
 *
 *  What this REFUSES is the important half: `@src/a.ts` inside `@src/a.tsx` is not a match, because
 *  `x` is not here. */
const TAG_BOUNDARY = new Set([".", ",", "?", "!", ";", ":", ")", "]", "}", '"', "'", "…", "@"]);

function endsATag(text: string, at: number): boolean {
  if (at >= text.length) return true;
  const next = text[at]!;
  return /\s/.test(next) || TAG_BOUNDARY.has(next);
}

/** What a set of picked tags becomes on the wire: the theme indices and the file paths.
 *
 *  The FILES are bounded here as well as in the backend, and the two numbers are the same one:
 *  a question tagged with every file of a 149-file branch is a fresh reading wearing a question's
 *  clothes. What is over the bound is DROPPED rather than silently sent, and `reviewTagLimit` is what
 *  the composer states before a send. */
export function reviewTagsToWire(tags: ReviewTag[]): { themes: number[]; paths: string[] } {
  const themes: number[] = [];
  const paths: string[] = [];
  for (const tag of tags) {
    if (tag.kind === "theme") themes.push(tag.index);
    else if (paths.length < MAX_REVIEW_TAG_FILES) paths.push(tag.path);
  }
  return { themes, paths };
}

/** The sentence a composer shows when it is holding as many files as it may, or `null`.
 *
 *  Stated BEFORE the send rather than after it, which is the rule the composer's own picture
 *  ceilings hold: a refusal a reader meets by pressing Send is one they cannot plan around. */
export function reviewTagLimit(tags: ReviewTag[]): string | null {
  const files = tags.filter((tag) => tag.kind === "file").length;
  if (files < MAX_REVIEW_TAG_FILES) return null;
  return `A question carries at most ${MAX_REVIEW_TAG_FILES} files. Ask about these, then ask again.`;
}

/**
 * A question that has left this page and whose answer has not come back yet.
 *
 * **It is DRAWN at once, which is the rule `chessPending` already holds for a move**: a board that
 * waits for a round trip before the piece moves feels broken, and so does a composer that swallows a
 * question and shows nothing. The words leave the box on the press and appear as the reader's own
 * turn in the transcript, so nothing is ever lost between the two — and it is TAKEN BACK if the
 * publish fails, with the words handed back to the box where they can be pressed again.
 *
 * It carries no answer, because there is none. What it carries is exactly what the turn it becomes
 * will carry, so the transcript does not change shape when the real one lands.
 */
export type PendingReviewQuestion = {
  question: string;
  themes: number[];
  paths: string[];
  asked_ms: number;
};

/**
 * The transcript as the panel draws it: the turns the backend holds, then the question in flight.
 *
 * ONE list, so the panel has one thing to draw and the pending question is at the bottom where a
 * conversation is read from. The pending one is marked (`answer` is null) rather than given an empty
 * answer, because "no answer yet" and "the model said nothing" are different things — and an empty
 * answer is an ERROR on the backend, never a turn.
 */
export type DrawnReviewTurn = {
  question: string;
  /** `null` while the answer is still on its way. */
  answer: string | null;
  themes: number[];
  paths: string[];
  asked_ms: number;
};

export function drawnReviewTurns(
  chat: GitLabReviewChat | null | undefined,
  pending: PendingReviewQuestion | null | undefined,
): DrawnReviewTurn[] {
  const turns: DrawnReviewTurn[] = (chat?.turns ?? []).map((turn) => ({
    question: turn.question,
    answer: turn.answer,
    themes: turn.themes,
    paths: turn.paths,
    asked_ms: turn.asked_ms,
  }));
  if (pending) {
    turns.push({
      question: pending.question,
      answer: null,
      themes: pending.themes,
      paths: pending.paths,
      asked_ms: pending.asked_ms,
    });
  }
  return turns;
}

/** Whether a question can be asked at all.
 *
 *  It needs a reading to be about — the backend refuses one without it, and the page must not offer a
 *  press that reports that refusal — and it needs words. */
export function reviewQuestionCanBeAsked(
  review: GitLabReview | null | undefined,
  question: string,
): boolean {
  return !!review && question.trim().length > 0;
}

/** What one turn says it was told, for the line under a question, or `null` when it was told nothing
 *  in particular.
 *
 *  It names what really TRAVELLED, which the backend recorded rather than the page assuming: a
 *  tagged file the diff does not hold never reached the model, and a transcript claiming it did would
 *  misstate what the answer rests on. */
export function turnContext(
  turn: Pick<GitLabReviewTurn, "themes" | "paths">,
  review: GitLabReview | null,
): string | null {
  const parts: string[] = [];
  for (const index of turn.themes) {
    const title = review?.themes[index]?.title;
    if (title) parts.push(title);
  }
  for (const path of turn.paths) parts.push(path);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ---- the CONVERSATION's own column, which the reader drags ---------------------
//
// The same gesture the diff page's two side columns take (`ColumnSplitter`), and the same reasoning
// about what gives way: the DOCUMENT keeps a minimum, because the code inside it is the one thing on
// this page that cannot be narrowed and still be read.

/** What the conversation column opens at. */
export const REVIEW_CHAT_DEFAULT_WIDTH = 416;

/** The narrowest it may be dragged. Below this a question and its answer are a column of two words. */
export const REVIEW_CHAT_MIN_WIDTH = 280;

/**
 * The room the DOCUMENT keeps whatever the reader drags.
 *
 * It is the point below which this page stops being the thing it is — a column narrower than this
 * holds neither a readable paragraph nor a patch — and it is not a preference, because the reader can
 * drag the conversation and the document cannot answer back.
 *
 * **It does NOT claim to fit a whole line of code**, and an earlier spelling of this comment did: 480
 * px of column is about 430 of content after the page's own padding, which is some 60 monospace
 * characters rather than the ~90 a unified patch really wants. Reserving that would take 700 px and
 * leave the conversation a sliver on a 1280 px screen. What the reader gets at the minimum is a
 * document they can still read the PROSE of, with the code scrolling sideways inside it — which is
 * what `overflow: scroll` on a patch is for, and what a phone already does. `DIFF_CODE_MIN_WIDTH`
 * (360) is the diff page's own answer to the same question, and it is smaller still.
 */
export const REVIEW_DOCUMENT_MIN_WIDTH = 480;

/**
 * How wide the conversation column really is, given the window and what the reader asked for.
 *
 * A viewport of 0 is the first paint, before anything is measured, and nothing is clamped against it
 * — the trap `resolveDiffColumnWidths` states in full: clamping to `min(asked, 0)` brings every
 * column back at its own minimum, which is the bug the guard exists to prevent.
 */
export function resolveReviewChatWidth(input: { viewport: number; asked: number }): number {
  if (!Number.isFinite(input.asked)) return REVIEW_CHAT_DEFAULT_WIDTH;
  const wanted = Math.round(Math.max(input.asked, REVIEW_CHAT_MIN_WIDTH));
  if (input.viewport <= 0) return wanted;
  const room = input.viewport - REVIEW_DOCUMENT_MIN_WIDTH;
  return Math.max(REVIEW_CHAT_MIN_WIDTH, Math.min(wanted, room));
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
