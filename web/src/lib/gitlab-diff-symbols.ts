// Where a name the reader pressed turns up everywhere ELSE in the same changes.
//
// A reviewer reading a diff meets an identifier and asks one question about it — "what else in
// this branch touches it?" — and every answer they have today is a trip out to GitLab or a
// find-in-page over a virtualized feed that has most of the diff unmounted. Pressing the name
// answers it here: `@pierre/diffs` reports the token (`onTokenClick`), and this module says
// where else that name stands, across every file whose patch travelled.
//
// Everything here is pure: no DOM, no network, no React, and nothing from `@pierre/diffs`. That
// is the split `gitlab-diff.ts` and `gitlab-diff-comment.ts` already hold and for their reason —
// the renderer is a 728 KB lazy chunk plus a Shiki grammar per language, so the rules have to be
// testable and renderable without loading any of it.
//
// **IT IS A TEXTUAL SEARCH, AND IT SAYS SO RATHER THAN PRETENDING OTHERWISE.** GitHub answers
// this from a symbol index built by a language server, which knows that the `health` in one file
// is the `health` declared in another and that the `health` in a comment is prose. Nothing on
// this machine holds such an index for a diff read out of a tracker: the repository is not
// checked out here, and the patches are fragments of files rather than files. So what this does
// is find the name as a WHOLE WORD, and the panel drawn from it is named for what it really is.
// The honest failure is a match in a comment or a string; the dishonest alternative — calling a
// grep "references" — is what makes a reader trust a list they should be checking.
//
// **WHAT IS SEARCHED IS WHAT TRAVELLED**, which is the rule `diffTotals` already follows for its
// counts. Four of the five states a file arrives in carry no patch (a binary file, a pure rename,
// one GitLab collapsed, one this read never expanded — see `diffFileState`), and a file with no
// patch holds no line to search. That is not a failure and it is not hidden either:
// {@link SymbolSearch.unsearchable} counts those files so the panel can say the search covered
// less than the branch did, and the reader can press Expand and ask again.

import {
  diffLineNumber,
  patchTextLines,
  type DiffLineSelection,
  type DiffLineSide,
  type PatchTextLine,
  type PierreSide,
} from "./gitlab-diff-comment";
import type { DiffChange, GitLabDiff, GitLabDiffFile } from "./gitlab-diff";

/** The name the reader pressed, and where they pressed it.
 *
 *  The WHERE is not decoration: it is what lights the line they pressed, so the press has an
 *  answer in the code as well as in the panel, and it is what makes pressing the same name twice
 *  its own undo. It is in the renderer's own vocabulary (a line number on a side) because that is
 *  what `onTokenClick` reports — resolving it to a patch line here would be a second answer to a
 *  question `patchLineAt` already has one for. */
export type DiffSymbolTarget = {
  /** The token, exactly as the reader pressed it. */
  name: string;
  /** The file it was pressed in — the diff is a feed of all of them, so a line number alone names
   *  a line in most of them at once. */
  path: string;
  lineNumber: number;
  side: PierreSide;
};

/**
 * The lines the feed LIGHTS for a pressed name: the one line the press was made on.
 *
 * A press on a name is answered in the code by lighting its line, which is the only granularity
 * available through the renderer's public seam — what is lit is a controlled line SELECTION
 * (`selectedLines`), and there is no published way to tint one token of one line. The tokens live
 * in a shadow root, and CSS cannot select an element by its text, so the alternative would be
 * generating a rule per occurrence against two undocumented attributes and re-injecting it on
 * every press. The panel is where a name is emphasized exactly, character for character, because
 * there this app draws the line itself.
 *
 * `null` for no press, so a caller can hand this straight to the feed beside the comment gesture's
 * own selection.
 */
export function symbolSelection(target: DiffSymbolTarget | null | undefined): DiffLineSelection | null {
  if (!target) return null;
  return {
    path: target.path,
    range: {
      start: target.lineNumber,
      side: target.side,
      end: target.lineNumber,
      endSide: target.side,
    },
  };
}

/** The shortest name worth looking for.
 *
 *  One character is not a search, it is a highlight of most of the file: `i`, `x` and `n` are in
 *  every loop in the diff, so the panel would open on a wall of rows that answers nothing. Two is
 *  where a name starts saying something (`id`, `db`, `ok`). */
export const SYMBOL_MIN_CHARS = 2;

/** The longest — a bound on the trust boundary rather than a judgement about names.
 *
 *  The token comes from the renderer, which hands over whatever Shiki made of a line: a minified
 *  bundle in the diff is one token thousands of characters wide, and it is neither a name a
 *  reader pressed on purpose nor one this search should walk every line for. */
export const SYMBOL_MAX_CHARS = 120;

/** How many occurrences the panel will hold, over the whole diff.
 *
 *  A name like `name` or `value` in a 149-file branch runs to thousands, and a list that long is
 *  one nobody scrolls and a render nobody needs. What is dropped is COUNTED
 *  ({@link SymbolSearch.truncated}) rather than silently cut, which is the rule
 *  `diffTruncationNotice` holds for the file list: a list that stops without saying so reads as a
 *  complete one. */
export const MAX_SYMBOL_OCCURRENCES = 200;

/**
 * Whether a token is a name this search can answer for.
 *
 * The set is deliberately narrow and deliberately language-agnostic: it is the shape an
 * identifier takes in every language in a diff on this instance — a letter, `_` or `$` to open,
 * then letters, digits, `_` or `$`. So pressing `podDisruptionBudget` in a YAML key, `READY_PATH`
 * in TypeScript and `aws_s3_bucket` in Terraform all search, while pressing `{`, `=>`, `"a
 * string"`, `1.42.0` or a run of whitespace does nothing at all.
 *
 * **A control that answers nothing is not offered**, which is why this is asked BEFORE a panel is
 * opened rather than answered with an empty one: a press on a brace that opened an empty side
 * panel would read as a bug, and a press that does nothing reads as a brace not being a name.
 *
 * A KEYWORD is deliberately not excluded. `return`, `if` and `end` are identifier-shaped and a
 * stop-list of them would have to be per language, would be wrong on the first language nobody
 * listed, and would refuse a reader who really did want to see every `return` the branch added.
 * The panel says it is a textual search; a keyword is that search working.
 */
export function symbolIsSearchable(token: string | null | undefined): boolean {
  if (!token) return false;
  if (token.length < SYMBOL_MIN_CHARS || token.length > SYMBOL_MAX_CHARS) return false;
  return IDENTIFIER.test(token);
}

/** An identifier, in the shape every language in a diff here spells one. Anchored at both ends:
 *  a token that merely CONTAINS a name is punctuation around one, and searching for it would
 *  find nothing whole-word anyway. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** One place the name stands: which line, and where in that line's own text.
 *
 *  The offsets are into {@link SymbolOccurrence.text} so the panel can emphasize exactly the
 *  name and never a word that happens to contain it — which is the whole of what makes this list
 *  readable at a glance. */
export type SymbolOccurrence = {
  /** The line number a reader sees in the gutter: the new file's, or the old file's for a line
   *  that was removed. `diffLineNumber`'s own answer, so the panel and the gutter agree. */
  lineNumber: number;
  /** Whether the line was added, removed, or is context the patch carried for the surroundings. */
  side: DiffLineSide;
  /** The line's own code, whitespace and all. Trimming belongs to the drawing, not to the data:
   *  the panel indents nothing, and a test asserting on the text should see the line as it is. */
  text: string;
  /** Where the name starts and ends inside {@link text}. */
  start: number;
  end: number;
  /** The line's place in the rendered patch, which is what orders two occurrences on one line. */
  row: number;
};

/** Every place the name stands in ONE file. */
export type SymbolFileMatches = {
  path: string;
  change: DiffChange;
  occurrences: SymbolOccurrence[];
};

/** What a press on a name found, across the whole diff. */
export type SymbolSearch = {
  /** The name searched for, exactly as the reader pressed it. */
  symbol: string;
  /** The files that hold it, in the diff's own order — which is GitLab's own order, so the panel
   *  lists them the way the tree and the feed above it do. A file with no match is not here. */
  files: SymbolFileMatches[];
  /** How many occurrences are in {@link files}. */
  total: number;
  /** Whether {@link MAX_SYMBOL_OCCURRENCES} cut the list. */
  truncated: boolean;
  /** How many files had a patch to search. */
  searched: number;
  /** How many did not, and so could hold the name without this list saying so — a binary file, a
   *  pure rename, one GitLab collapsed. See the module header. */
  unsearchable: number;
};

/**
 * Every whole-word occurrence of `symbol` in the patches this diff carries.
 *
 * `null` rather than an empty search when there is nothing to answer — no diff, or a token that
 * is not a name ({@link symbolIsSearchable}) — so a caller never has to ask twice and can never
 * open a panel about nothing.
 *
 * A search that found the name NOWHERE still answers a {@link SymbolSearch}, with no files in it.
 * That is a real and useful answer rather than a null: the reader pressed a name, and "this
 * branch touches it only here" is what the panel then says. It is also what a reader gets after
 * pressing a name in a file whose only other uses are in the part GitLab collapsed, which is why
 * {@link SymbolSearch.unsearchable} travels beside the count.
 */
export function symbolOccurrences(
  diff: GitLabDiff | null | undefined,
  symbol: string | null | undefined,
): SymbolSearch | null {
  if (!diff || !symbol || !symbolIsSearchable(symbol)) return null;
  const files: SymbolFileMatches[] = [];
  let total = 0;
  let truncated = false;
  let searched = 0;
  let unsearchable = 0;
  for (const file of diff.files) {
    if (!file.patch) {
      unsearchable += 1;
      continue;
    }
    // The budget is spent across the whole diff rather than per file, so the FIRST files in
    // GitLab's own order are the ones that fit — the order the reader is reading in. A file the
    // budget never let us open is not a file we SEARCHED, so it is counted as neither: what says
    // the list is short is `truncated`, and saying it twice would let the two disagree.
    if (total >= MAX_SYMBOL_OCCURRENCES) {
      truncated = true;
      continue;
    }
    searched += 1;
    const occurrences: SymbolOccurrence[] = [];
    // Per FILE rather than read off `truncated`, which is about the whole search. Today the two
    // cannot disagree — the only way to set `truncated` is to fill the budget, and the check above
    // then skips every later file — so this is a guard against a future budget that is not
    // all-or-nothing rather than one that prevents a reachable defect. Seeding it from `truncated`
    // is measured to fail no test, which is what that sentence means.
    let spent = false;
    for (const line of patchTextLines(file.patch)) {
      for (const start of wholeWordMatches(line.text, symbol)) {
        if (total + occurrences.length >= MAX_SYMBOL_OCCURRENCES) {
          spent = true;
          break;
        }
        occurrences.push(occurrenceAt(line, start, symbol.length));
      }
      if (spent) break;
    }
    if (spent) truncated = true;
    if (occurrences.length > 0) {
      total += occurrences.length;
      files.push({ path: file.path, change: file.change, occurrences });
    }
  }
  return { symbol, files, total, truncated, searched, unsearchable };
}

/** One occurrence, from the line it is on. Split out so the line's own numbering is read through
 *  `diffLineNumber` — the one answer to "which number does this line show" in this app. */
function occurrenceAt(line: PatchTextLine, start: number, length: number): SymbolOccurrence {
  return {
    lineNumber: diffLineNumber(line),
    side: line.side,
    text: line.text,
    start,
    end: start + length,
    row: line.row,
  };
}

/**
 * Where `needle` stands in `haystack` as a whole word, left to right.
 *
 * Scanned by hand rather than with a `RegExp`, for two reasons that are both about correctness
 * rather than speed. A name goes into a pattern only if it is escaped, and a name is exactly the
 * kind of value that arrives from outside this module — so the version with no pattern in it
 * cannot be got wrong. And `\b` is defined over `[A-Za-z0-9_]`, which is not the set an
 * identifier here is made of: `$` is a word character in JavaScript and not to `\b`, so `$svc`
 * searched with `\b$svc\b` matches inside `x$svc` and misses nothing else — a boundary that is
 * wrong in one direction only, which is the hardest kind to notice.
 */
function wholeWordMatches(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return found;
    const before = at === 0 ? "" : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? "";
    if (!isNameChar(before) && !isNameChar(after)) found.push(at);
    // One past the START, never past the whole match: `aa` occurs twice in `aaa` as far as a
    // reader is concerned only if the boundaries allow it, and skipping the match length would
    // make which occurrences are found depend on where the scan happened to begin.
    from = at + 1;
  }
}

/** Whether a character can be part of a name — the same set {@link IDENTIFIER} is built from, so
 *  a boundary and a name can never disagree about what a name is. */
function isNameChar(ch: string): boolean {
  return ch !== "" && /[A-Za-z0-9_$]/.test(ch);
}

// ---- the NAMES the diff holds ------------------------------------------------
//
// {@link symbolOccurrences} answers "where does this one name stand", which is the question a
// press in the code asks. The reading's own prose asks the cheaper one first — "is this word a
// name these changes hold at all?" — of every candidate word in a paragraph, and it must have
// the SAME answer.
//
// **THAT IS WHY THIS LIVES HERE AND NOT IN THE CALLER.** A second module would have to re-spell
// the boundary, and the obvious tokenizer — `/[A-Za-z_$][A-Za-z0-9_$]*/g` — is wrong in exactly
// the direction {@link wholeWordMatches} refuses: over `memory: 256Mi` (a real line of the diff
// fixture) it yields `Mi`, whose left-hand neighbour is `6` — a name character — so the search
// finds nothing there. A word in the index whose search comes back empty is a chip whose panel
// says "Nowhere else in these changes" about a name that is on screen beside it, which is a
// control that changes nothing.
//
// {@link nameRuns} is what makes the two one predicate: a MAXIMAL run of name characters has a
// non-name character (or the end of the line) on both sides BY CONSTRUCTION, which is precisely
// the boundary `wholeWordMatches` tests for. So `256Mi` is one run, `symbolIsSearchable` refuses
// it for opening with a digit, and `Mi` never enters the index at all.

/** One maximal run of name characters, and where it sits. */
export type NameRun = { name: string; start: number; end: number };

/**
 * Every maximal run of name characters in `text`.
 *
 * It is the ONE tokenizer this app reads a name out of running text with — the index below is
 * built from it, and the reading's prose is scanned with it — so a word the index holds and a
 * word a paragraph offers are cut from their surroundings by one rule.
 *
 * A run is returned whatever it looks like; {@link symbolIsSearchable} is what judges one. Two
 * jobs in one function would leave a caller unable to ask the second question about a run it can
 * see.
 *
 * Note what this does NOT do: it never joins two runs across a `.`, so `state.automatedAction` is
 * `state` and `automatedAction`, and `health.ts` is `health` and `ts`. That is the same cut Shiki
 * makes in the diff feed, where `onTokenClick` reports `automatedAction` alone — so one word gets
 * one answer on both pages of one merge request.
 */
export function nameRuns(text: string): NameRun[] {
  const runs: NameRun[] = [];
  let at = 0;
  while (at < text.length) {
    if (!isNameChar(text[at]!)) {
      at += 1;
      continue;
    }
    const start = at;
    while (at < text.length && isNameChar(text[at]!)) at += 1;
    runs.push({ name: text.slice(start, at), start, end: at });
  }
  return runs;
}

/** The names the patches of one diff hold. A `Set`, because the only question asked of it is
 *  membership — and it is READ-ONLY to its callers, since a caller that added to it would be
 *  claiming the diff holds a name it does not. */
export type SymbolIndex = ReadonlySet<string>;

/** An index of nothing, for a caller with no diff yet. Shared rather than built per call, so a
 *  memo keyed on it is stable while the diff is still on its way. */
export const EMPTY_SYMBOL_INDEX: SymbolIndex = new Set<string>();

/**
 * Every name the patches of `diff` hold, taken over the text that TRAVELLED.
 *
 * Built once per diff and asked many times, which is the whole reason it exists: marking a
 * paragraph runs a membership test per word, where a search per word would walk every patch line
 * again for each of them.
 *
 * What it can be wrong about is what {@link SymbolSearch.unsearchable} already says out loud:
 * four of the five states a file arrives in carry no patch, so a name that stands only in a
 * binary file, a pure rename or a stretch GitLab collapsed is absent from this — the same
 * blindness the panel states in a sentence, in the one direction that is safe. A name it does
 * not hold is left as the word it was.
 *
 * **Every member is guaranteed to be findable.** A member is a maximal run that
 * {@link symbolIsSearchable} accepted, so `symbolOccurrences(diff, member)` answers a search with
 * at least one occurrence in it — the boundary is the same rule, the comparison is the same bytes
 * (nothing here folds case), and the bounds are the same two constants.
 * `the_index_and_the_search_cannot_disagree` pins that over the fixture's own diff.
 */
export function symbolIndex(diff: GitLabDiff | null | undefined): SymbolIndex {
  if (!diff) return EMPTY_SYMBOL_INDEX;
  const names = new Set<string>();
  for (const file of diff.files) {
    if (!fileIsSearchable(file)) continue;
    for (const line of patchTextLines(file.patch)) {
      for (const run of nameRuns(line.text)) {
        if (symbolIsSearchable(run.name)) names.add(run.name);
      }
    }
  }
  return names;
}

/**
 * The panel's own heading: how many, and in how many files.
 *
 * It counts FILES rather than naming them because the list below names every one, and it states
 * the two numbers separately because they answer different questions — "is this name all over the
 * branch" is the file count, "how much of it is there" is the total.
 */
export function symbolSearchSummary(search: SymbolSearch): string {
  if (search.total === 0) return "Nowhere else in these changes.";
  const times = `${search.total} ${search.total === 1 ? "occurrence" : "occurrences"}`;
  const where = `${search.files.length} ${search.files.length === 1 ? "file" : "files"}`;
  return `${times} in ${where}`;
}

/**
 * What this search could NOT see, when it could not see something. `null` when it covered every
 * file in the diff.
 *
 * A file with no patch may hold the name and this list would never say so, so the panel says it
 * — the rule `diffTruncationNotice` holds for the file list, applied to a search over it. The two
 * causes are stated apart because the reader's next move differs: a cut list is asking them to
 * press a narrower name, and an unsearched file is asking them to expand the diff.
 */
export function symbolSearchLimits(search: SymbolSearch): string | null {
  const notes: string[] = [];
  if (search.truncated) {
    notes.push(`Only the first ${MAX_SYMBOL_OCCURRENCES} are listed.`);
  }
  if (search.unsearchable > 0) {
    const files = `${search.unsearchable} ${search.unsearchable === 1 ? "file" : "files"}`;
    notes.push(`${files} in this diff carry no patch to search — a binary file, a rename, or one GitLab did not expand.`);
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

/** What one occurrence's line is, in a word the reader already knows from the gutter's own tint.
 *
 *  `both` is a line the patch carried for context rather than one the branch changed, and saying
 *  so is what stops a reader reading a context match as a change they have to review. */
export function occurrenceSideLabel(side: DiffLineSide): string {
  switch (side) {
    case "new":
      return "added";
    case "old":
      return "removed";
    default:
      return "context";
  }
}

/** Whether a file in the diff can be searched at all — the same question
 *  {@link symbolOccurrences} asks per file, exported so a caller can say why a file is missing
 *  from a list without re-deriving the rule. */
export function fileIsSearchable(file: GitLabDiffFile): boolean {
  return !!file.patch;
}
