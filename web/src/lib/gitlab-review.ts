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

/**
 * The tags a question's own WORDS name, in the order they are written.
 *
 * The one reader of a question's text, so what the composer offered and what really travels cannot
 * disagree — and a tag the reader deleted with the caret is simply gone, with nothing to clean up.
 *
 * A run that matches no tag stays the words it is, which is the rule an @mention naming a person the
 * thread does not hold already follows: `@rfc-2119` in a question is a question about `@rfc-2119`.
 */
export function reviewTagsInText(text: string, tags: ReviewTag[]): ReviewTag[] {
  const byText = new Map(tags.map((tag) => [reviewTagText(tag), tag]));
  const picked: ReviewTag[] = [];
  const seen = new Set<string>();
  // `@[…]` first, because a bare run would stop at the `[` and match nothing — and the bracket form
  // is the only one that can hold a title with spaces in it.
  const pattern = /@\[([^\]\n]+)\]|@([^\s@]+)/g;
  for (const match of text.matchAll(pattern)) {
    const tag =
      match[1] !== undefined ? byText.get(`@[${match[1]}]`) : bareTag(match[2]!, byText);
    if (!tag) continue;
    const key = reviewTagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(tag);
  }
  return picked;
}

/** The trailing characters that belong to the SENTENCE rather than to the path before them.
 *
 *  A question ends in `?`, a clause in `,`, a list item in `;` — and a reader really does write "and
 *  not @src/server/health.ts?". `agent_policy::split_prefix` states the same rule for an agent's own
 *  address ("the punctuation an address is written with belongs to it"), and without it a tag would
 *  silently name nothing whenever it fell at the end of a sentence. */
const TAG_TRAILING_PUNCTUATION = new Set([".", ",", "?", "!", ";", ":", ")", "]", "}", '"', "'", "…"]);

/** The tag a bare `@run` names, backing off one trailing punctuation mark at a time.
 *
 *  The LONGEST match wins, so a path that really ends in one of those characters is found before
 *  anything is trimmed — and the walk stops at the first character that is not punctuation, so
 *  `health.ts` keeps its extension. */
function bareTag(run: string, byText: Map<string, ReviewTag>): ReviewTag | undefined {
  let candidate = run;
  while (candidate.length > 0) {
    const tag = byText.get(`@${candidate}`);
    if (tag) return tag;
    const last = candidate[candidate.length - 1]!;
    if (!TAG_TRAILING_PUNCTUATION.has(last)) return undefined;
    candidate = candidate.slice(0, -1);
  }
  return undefined;
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

/** The room the DOCUMENT keeps whatever the reader drags, which is not a preference: a unified patch
 *  under about 90 characters is unreadable, and the code is why this page exists. It is the rule
 *  `DIFF_CODE_MIN_WIDTH` holds one page over. */
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
