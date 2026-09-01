// A NAME the reading mentions, drawn as the code it names.
//
// The AI reading of a merge request writes about the branch in prose (§ AN AI READING OF THE DIFF),
// and the things it writes about are in the diff on the next page: "`health()` gains a draining
// state", "the grantedAction is extracted in computeState". Read as words, every one of those is a
// dead end — the reader has to remember the name, press through to the feed, and find it. Read as a
// name, it is one hover away from the lines it stands on.
//
// This module decides WHICH words those are. `gitlab-diff-symbols.ts` decides what a name is and
// where it stands (`nameRuns`, `symbolIndex`, `symbolOccurrences`); nothing here re-spells either,
// which is the whole of why a chip can never open an empty panel.
//
// Everything here is pure: no DOM, no network, no React. That is the split `tracker-ref.ts` holds
// and for its reason — what a body offers is decided by unit-tested rules rather than by whatever a
// component happened to see.
//
// **A NAME THE DIFF DOES NOT HOLD STAYS THE WORD IT IS.** That is the rule `markTrackerRefs` holds
// for a reference nothing can address and `agent_markdown`'s @mention holds for a person the thread
// does not hold, and here it is the whole of what makes the highlighting trustworthy: a chip is a
// claim that these changes touch this name, so the claim is checked against the patches that really
// travelled before it is made.
//
// **AND IN PROSE THE SHAPE HAS TO SAY CODE.** The diff gate alone is not enough, because the words
// of a branch are also the words of a sentence: `state`, `flag`, `group`, `mode`, `payload`,
// `ready` and `next` are all identifiers in the branch this feature was reported against AND
// ordinary English in the paragraph describing it. Marking those puts a chip on half the nouns in
// every sentence, and a reader who meets one on the word "state" stops believing the chip on
// `computeState` means anything. So a word in plain prose is marked only where its own spelling says
// it is a name (see {@link nameIsCodeShaped}), and inside the model's OWN backticks that test is not
// applied at all — the model already pointed.
//
// The asymmetry is the argument: a name this misses costs the reader one press through to the feed,
// and a name this marks wrongly costs the feature its credibility.

import type { DiffChange, GitLabDiff } from "./gitlab-diff";
import {
  EMPTY_SYMBOL_INDEX,
  fileIsSearchable,
  nameRuns,
  symbolIndex,
  symbolIsSearchable,
  symbolSearchLimits,
  symbolSearchSummary,
  type NameRun,
  type SymbolIndex,
  type SymbolOccurrence,
  type SymbolSearch,
} from "./gitlab-diff-symbols";
import type { RichNode } from "./rich-text";

/**
 * Whether a word written in PLAIN PROSE is spelled like a name rather than like English.
 *
 * Three shapes say code, and each is one a sentence never produces:
 *
 *  - an internal `_` — `READY_PATH`, `init_actions`, `aws_s3_bucket`;
 *  - a lowercase letter followed by a capital — `computeState`, `getNextActions`,
 *    `PodDisruptionBudget`, `toBe`;
 *  - a trailing `()`, which is how a person writes a function in a sentence — `health()`.
 *
 * ONE hump is the shape, not two. Measured over `web/src` — 19 754 distinct identifiers, of which
 * 4 766 carry a hump — **2 811 have exactly one against 1 955 with two or more, so 59% of every
 * humped name in this app**. They are also the commonest names there are: `computeState`,
 * `grantedAction`, `initActions`, `replicaCount`, `apiVersion`, `toBe`. A rule that asked for two
 * would mark `getNextActions` (2) and refuse `computeState` (1) in the same sentence, and a reader
 * who can infer no rule from what is marked reads the marking as noise. That version was written
 * and measured out.
 *
 * What it REFUSES is the point of it:
 *
 *  - a single all-lowercase word (`state`, `ready`, `draining`, `transitions`, `flag`) — this is
 *    the honest limit of the whole feature. Such a word is a name as often as it is English and
 *    nothing in the text can tell the two apart, so it is left alone unless the model backticked
 *    it, which is exactly what a backtick is for;
 *  - a single capitalised word (`Two`, `The`, `Kubernetes`) — no internal transition, so nothing
 *    about it is code;
 *  - bare all-caps with no underscore (`API`, `JSON`, `HTTP`, `TODO`) — engineering prose is full
 *    of these and a constant named one of them is a constant the model can backtick.
 *
 * **What it accepts and should not, stated because it is real:** a proper noun with an internal
 * capital that the diff also holds — `GitLab`, `TypeScript`, `JavaScript`, `PostgreSQL`. Those
 * become chips, and the panel behind one honestly shows where that string stands in the branch, so
 * the cost is a chip nobody needed rather than a claim that is false. A stop-list would be the
 * alternative and this codebase refuses one on principle (see `symbolIsSearchable`'s own note on
 * keywords): it would have to grow for ever and would be wrong on the first name nobody listed.
 */
export function nameIsCodeShaped(name: string, followedByCall = false): boolean {
  if (followedByCall) return true;
  if (name.includes("_")) return true;
  return /[a-z][A-Z]/.test(name);
}

/** A `()` immediately after a run, which is how a sentence names a function. Exactly `()` and not
 *  a call with arguments: prose writes `health()`, and `health(req` is a fragment of code that
 *  belongs in a fence. */
function isCall(text: string, run: NameRun): boolean {
  return text.startsWith("()", run.end);
}

/** What the marking is done against: the names the branch holds, and the files it changed. */
export type CodeVocabulary = {
  index: SymbolIndex;
  /** Every changed file's path. Only used to REFUSE — see {@link namesAFileOfTheDiff}. */
  paths: readonly string[];
};

/** An empty vocabulary: marks nothing. What a surface with no diff gets, and what makes
 *  {@link markReviewCode} a single branch there. */
export const NO_CODE_VOCABULARY: CodeVocabulary = { index: EMPTY_SYMBOL_INDEX, paths: [] };

/** The vocabulary one diff gives. Built by the caller's own memo, once per diff. */
export function codeVocabulary(diff: GitLabDiff | null | undefined): CodeVocabulary {
  if (!diff) return NO_CODE_VOCABULARY;
  return { index: symbolIndex(diff), paths: diff.files.map((file) => file.path) };
}

/**
 * Whether a span of text names a FILE this branch changed, rather than something in it.
 *
 * It is the one test that tells `health.ts` from a member expression, and nothing about the
 * characters can do it: both are names joined by a dot. `src/server/health.ts` is in the diff, so
 * `health.ts` is the tail of a path — and a chip on it would search for `health`, which answers a
 * different question from the one the reader's own eyes are asking. `package.json`, `values.yaml`,
 * `bun.lock` and `rollout.png` all go the same way.
 *
 * A whole path counts as well as a tail, because a model writes both.
 */
export function namesAFileOfTheDiff(text: string, paths: readonly string[]): boolean {
  // Empty names no file, and the guard is not decoration: `path.endsWith("")` is TRUE of every
  // string, so without it this would fall through to the boundary check and answer on whether some
  // path happens to end in a `/`. Nothing reaches here with an empty string today — a span of
  // exactly `()` is the only way to produce one, and `nameRuns` then finds nothing to mark anyway —
  // so this closes a trap rather than a defect.
  if (text === "") return false;
  for (const path of paths) {
    if (path === text) return true;
    if (
      path.length > text.length &&
      path.endsWith(text) &&
      path[path.length - text.length - 1] === "/"
    ) {
      return true;
    }
  }
  return false;
}

/** The node a marked name becomes.
 *
 *  Its children are the run VERBATIM — the author's own characters — so anything that does not know
 *  the tag still shows exactly the word that was written. That is the discipline `refNode` holds for
 *  a tracker reference, and it is what makes this transform safe to run over prose nobody here
 *  wrote. */
function codeRefNode(name: string, inCode: boolean): RichNode {
  return {
    type: "element",
    tag: "codeRef",
    // The name is carried BESIDE the children rather than read back off them: what is asked of
    // the diff must be the bytes the index was built from, and a renderer is free to draw the
    // children however it likes. `inCode` says whether this already sits on the surface an
    // inline `code` span paints — see `RichAttrs`.
    attrs: { symbol: name, ...(inCode ? { inCode: true } : {}) },
    children: [{ type: "text", text: name }],
  };
}

/** One text node with every name in it marked, or `null` when it holds none — so an untouched tree
 *  comes back as the SAME tree and a caller can memoize on identity (the rule `markTrackerRefs`
 *  holds for its own walk). */
function markText(
  text: string,
  vocab: CodeVocabulary,
  /** Whether the shape test is dropped — see {@link markNodes}, which decides it per span. */
  pointed: boolean,
  inCode: boolean,
): RichNode[] | null {
  let out: RichNode[] | null = null;
  let at = 0;
  for (const run of nameRuns(text)) {
    // MEMBERSHIP IS THE WHOLE TEST, and it is asked first because it is the cheap one: a `Set` lookup
    // against a regex. `symbolIsSearchable` cannot then refuse anything — every member of the index
    // has already passed it (see `symbolIndex`) — so the second line is a guard on that invariant
    // rather than a filter, and it is what a name minted here is promised to satisfy. Deleting it
    // would fail no test today; keeping it means a future index built some other way cannot mint a
    // chip whose card is empty.
    if (!vocab.index.has(run.name)) continue;
    if (!symbolIsSearchable(run.name)) continue;
    // Where the model pointed at ONE name, the shape test is dropped: the backtick IS the pointing,
    // and it is what makes `draining` and `ready` reachable at all.
    if (!pointed && !nameIsCodeShaped(run.name, isCall(text, run))) continue;
    out ??= [];
    const lead = text.slice(at, run.start);
    if (lead.length > 0) out.push({ type: "text", text: lead });
    out.push(codeRefNode(run.name, inCode));
    at = run.end;
  }
  if (!out) return null;
  const tail = text.slice(at);
  if (tail.length > 0) out.push({ type: "text", text: tail });
  return out;
}

/** The subtrees this never reaches into, and why each one is left whole.
 *
 *  `pre` is a FENCED BLOCK, and in this app's parser a fence is `pre > code`
 *  (`gitlab-markdown.ts`) — so skipping it by name here is what stops a block of code from being
 *  drawn as a row of pressable pills, which is the rule `markTrackerRefs` states as "a reference
 *  inside code is code". The rest are already something a reader can press or a picture: a chip
 *  nested inside another chip has two targets in one word, and an author's own link label is their
 *  words. `codeRef` is in the list for IDEMPOTENCE — a second pass must not re-read what the first
 *  one marked. */
const OPAQUE = new Set([
  "pre",
  "codeRef",
  "trackerRef",
  "mention",
  "agent",
  "a",
  "img",
  "gitlabImage",
  "customEmoji",
  "card",
]);

/**
 * The same tree with every name the diff holds drawn as the code it names.
 *
 * Returns the SAME array when nothing changed, so the four memos that call it (the headline, a
 * theme's summary, a file's note and an answer in the follow-up conversation) can key on identity.
 *
 * An empty index marks nothing and costs one branch, which is what a caller with no diff yet — or
 * a surface that never had one — pays.
 */
export function markReviewCode(nodes: RichNode[], vocab: CodeVocabulary): RichNode[] {
  if (vocab.index.size === 0) return nodes;
  return markNodes(nodes, vocab, false, false);
}

/**
 * Whether an inline `code` span is the model POINTING at one name, rather than quoting a fragment.
 *
 * A span holding one name — with at most one trailing `()` — is a pointer: `` `health()` ``,
 * `` `draining` ``, `` `READY_PATH` ``. Inside one, the shape test is dropped entirely, which is
 * how a single lowercase word becomes reachable at all.
 *
 * A span holding SEVERAL names is a fragment of code — `` `kind: PodDisruptionBudget` ``,
 * `` `state.automatedAction` ``, `` `minAvailable: 1` `` — and there the shape test still applies,
 * so the fragment's own structural words stay plain: `PodDisruptionBudget` and `automatedAction`
 * are marked, while `kind` and `state` are not. Without that split, every lowercase word inside
 * every quoted fragment would become a chip.
 *
 * A span that names a FILE of the diff points at nothing this can search
 * ({@link namesAFileOfTheDiff}), so it is refused whole.
 */
function spanPointsAtOneName(text: string, vocab: CodeVocabulary): boolean {
  const bare = spanBareName(text);
  if (bare === "") return false;
  if (namesAFileOfTheDiff(bare, vocab.paths)) return false;
  const runs = nameRuns(bare);
  return runs.length === 1 && runs[0]!.name === bare;
}

/** A code span's text with its surrounding space and ONE trailing `()` taken off — the two things
 *  that stand between `` `health()` `` and the name it points at. Exactly one call and no arguments:
 *  `health(server)` is a fragment of code, and a fragment is what the branch above it is for. */
function spanBareName(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith("()") ? trimmed.slice(0, -2) : trimmed;
}

/** The text a `code` span holds, for the question above. A span's children are text, but a body
 *  can nest markup inside one — so anything that is not text makes it a fragment. */
function spanText(nodes: RichNode[]): string | null {
  let text = "";
  for (const node of nodes) {
    if (node.type !== "text") return null;
    text += node.text;
  }
  return text;
}

function markNodes(
  nodes: RichNode[],
  vocab: CodeVocabulary,
  pointed: boolean,
  inCode: boolean,
): RichNode[] {
  let changed = false;
  const out: RichNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const marked = markText(node.text, vocab, pointed, inCode);
      if (!marked) {
        out.push(node);
        continue;
      }
      out.push(...marked);
      changed = true;
      continue;
    }
    if (OPAQUE.has(node.tag)) {
      out.push(node);
      continue;
    }
    // A `code` span is KEPT rather than replaced: it may hold a name among punctuation, and the
    // code surface is what says those characters are code at all. What it decides is whether the
    // shape test applies inside it (see {@link spanPointsAtOneName}).
    const isCodeSpan = node.tag === "code";
    // Read ONCE — the two questions below are both about this span's own text, and asking twice is
    // two chances for them to be asked about different strings.
    const text = isCodeSpan ? spanText(node.children) : null;
    // A file the diff carries is refused WHOLE, so `health.ts` marks neither of its halves.
    if (text !== null && namesAFileOfTheDiff(spanBareName(text), vocab.paths)) {
      out.push(node);
      continue;
    }
    const spanPointed = isCodeSpan ? spanPointsAtOneName(text ?? "", vocab) : pointed;
    const children = markNodes(node.children, vocab, spanPointed, inCode || isCodeSpan);
    if (children === node.children) {
      out.push(node);
      continue;
    }
    out.push({ ...node, children });
    changed = true;
  }
  return changed ? out : nodes;
}

// ---- what the CARD behind a chip shows ---------------------------------------
//
// The occurrences PANEL on the diff page is a full column and scrolls itself. This is a card
// floating over a paragraph somebody is reading, so it is bounded hard and says what it left out —
// and the whole list is one press away on the page the card's own rows go to.

/** The most places one card lists, over every file. Six rows of code plus a heading or two is about
 *  a third of a laptop's viewport, which is as much as may sit over the sentence the reader is in
 *  the middle of. */
export const CODE_CARD_ROWS = 6;

/** The most files one card names. Three, because a fourth heading costs a row of code — and a name
 *  in more files than this is one the reader should be reading the panel for. */
export const CODE_CARD_FILES = 3;

/** One file's places, as the card draws them. */
export type CodePreviewFile = { path: string; change: DiffChange; occurrences: SymbolOccurrence[] };

/** What one card shows, and what it could not. */
export type CodePreview = {
  symbol: string;
  files: CodePreviewFile[];
  /** How many places the card is showing. */
  shown: number;
  /** How many places the search found in all — so the card can say it is showing some of them. */
  total: number;
  /** The count in words, over the WHOLE search rather than over the few rows drawn — the same
   *  sentence the occurrences panel opens with, so pressing through to it continues rather than
   *  restates. It is computed here because it is a fact about the search, and a component that
   *  assembled a `SymbolSearch` to ask for it would be counting the files it is DRAWING (three at
   *  most) instead of the files the name is in. */
  summary: string;
  /** Whether every place the name stands is on a REMOVED line, so the card can say the branch took
   *  it AWAY (see {@link codeRefRemovedOnly}). Carried here rather than asked for separately, so the
   *  component makes one call and cannot be handed a verdict about a different search. */
  removedOnly: boolean;
  /** Whether the SEARCH itself was cut or blind, in its own words, or `null`. Passed through rather
   *  than restated: one sentence about what a search could not see, written once. */
  limits: string | null;
};

/**
 * The first few places a name stands, in the DIFF's own order.
 *
 * Nothing is reordered, and that is deliberate: the panel one press away lists the same places in
 * the same order, so a reader who opens it does not have to work out why the card's first row is
 * somewhere else in the list. An added line and a removed one are told apart by the row itself
 * (`occurrenceSideLabel`), which is the honest way rather than by hiding one.
 *
 * `null` when there is no search to draw — which a chip should never be able to produce, because
 * the index it was minted from guarantees at least one occurrence (see `symbolIndex`). It is a
 * return type rather than a thrown error so a chip whose diff has moved under it draws nothing
 * instead of breaking the paragraph it is in.
 */
export function reviewCodePreview(search: SymbolSearch | null | undefined): CodePreview | null {
  if (!search) return null;
  const files: CodePreviewFile[] = [];
  let shown = 0;
  for (const file of search.files) {
    if (files.length >= CODE_CARD_FILES || shown >= CODE_CARD_ROWS) break;
    const room = CODE_CARD_ROWS - shown;
    const occurrences = file.occurrences.slice(0, room);
    if (occurrences.length === 0) break;
    files.push({ path: file.path, change: file.change, occurrences });
    shown += occurrences.length;
  }
  return {
    symbol: search.symbol,
    files,
    shown,
    total: search.total,
    summary: symbolSearchSummary(search),
    removedOnly: codeRefRemovedOnly(search),
    limits: symbolSearchLimits(search),
  };
}

/** What the card says about the places it is NOT showing, or `null` when it shows them all.
 *
 *  It counts rather than naming, because the list below already names what it has — and the count
 *  is what tells the reader whether pressing through to the panel is worth it. */
export function codePreviewMore(preview: CodePreview): string | null {
  const hidden = preview.total - preview.shown;
  if (hidden <= 0) return null;
  return `${hidden} more ${hidden === 1 ? "place" : "places"} in these changes`;
}

/**
 * What the marking could NOT see, as a sentence for the document to carry, or `null`.
 *
 * A name is only ever marked against the patches that TRAVELLED, and four of the five states a file
 * arrives in carry none — so a name that stands only in a collapsed file is a word here with no
 * chip on it, and nothing else on screen would say why. **This is the normal case rather than an
 * edge:** measured on the real instance, 96 of one merge request's 149 files came back collapsed at
 * every page size.
 *
 * It is said ONCE, at document level, beside the coverage count — the only level at which a MISSING
 * chip can explain itself, since the chip that would have explained it is the thing that is absent.
 */
export function reviewCodeUnsearchable(diff: GitLabDiff | null | undefined): string | null {
  if (!diff) return null;
  const blind = diff.files.filter((file) => !fileIsSearchable(file)).length;
  if (blind === 0) return null;
  // The VERB agrees with the noun, which "1 files" and "1 file carry" are the two ways of getting
  // wrong. The rule `symbolSearchLimits` holds for its own sentence, one clause further along.
  const files = blind === 1 ? "1 file carries" : `${blind} files carry`;
  return `${files} no patch, so names that stand only in them are not marked.`;
}

/** Whether every place a name stands is on a REMOVED line — so the card can say so.
 *
 *  It matters because the chip's claim is "these changes touch this name", and a name only on
 *  removed lines is one the branch took AWAY. The row already says `removed` per line; this is what
 *  lets the card say it about the whole answer, and it rides the chip's own label so a reader who
 *  never opens the card is told too. */
export function codeRefRemovedOnly(search: SymbolSearch | null | undefined): boolean {
  if (!search || search.total === 0) return false;
  return search.files.every((file) =>
    file.occurrences.every((occurrence) => occurrence.side === "old"),
  );
}

/** Every name a marked tree ended up carrying, in the order it is read.
 *
 *  Only for a test and a capture to assert on: a spec that counted chips in the DOM would be
 *  asserting on the renderer, and what these rules decide is which names there are. */
export function codeRefsIn(nodes: RichNode[]): string[] {
  const found: string[] = [];
  const walk = (list: RichNode[]) => {
    for (const node of list) {
      if (node.type === "text") continue;
      if (node.tag === "codeRef") {
        const name = node.attrs.symbol;
        if (name) found.push(name);
        continue;
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return found;
}


