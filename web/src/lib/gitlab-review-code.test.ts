import { describe, expect, it } from "vitest";
import {
  CODE_CARD_FILES,
  CODE_CARD_ROWS,
  codePreviewMore,
  codeRefRemovedOnly,
  codeRefsIn,
  codeVocabulary,
  markReviewCode,
  nameIsCodeShaped,
  namesAFileOfTheDiff,
  NO_CODE_VOCABULARY,
  reviewCodePreview,
  reviewCodeUnsearchable,
} from "./gitlab-review-code";
import { symbolOccurrences } from "./gitlab-diff-symbols";
import { parseGitLabMarkdown } from "./gitlab-markdown";
import { nodeText } from "./rich-text";
import type { GitLabDiff, GitLabDiffFile } from "./gitlab-diff";

/** A branch that really holds the names the prose below writes about, including the two that decide
 *  the hard cases: `state` and `automatedAction` stand SEPARATELY (nothing indexes a dotted chain),
 *  and `health` stands in a file called `health.ts`. */
const PATCH = [
  "--- a/src/server/health.ts",
  "+++ b/src/server/health.ts",
  "@@ -1,6 +1,9 @@",
  " import { state } from './state';",
  "-export function health(server) {",
  "+export function health(server, ready) {",
  "+  if (server.draining) return 503;",
  "+  const grantedAction = computeState(state.automatedAction);",
  "+  return getNextActions(grantedAction);",
  "+}",
  " export const READY_PATH = '/readyz';",
  "+const terminationGracePeriodSeconds = 30;",
  "+// kind: PodDisruptionBudget, rendered by GitLab",
  "",
].join("\n");

function file(over: Partial<GitLabDiffFile> = {}): GitLabDiffFile {
  return {
    path: "src/server/health.ts",
    change: "changed",
    patch: PATCH,
    additions: 5,
    deletions: 1,
    binary: false,
    collapsed: false,
    generated: false,
    ...over,
  };
}

function diff(files: GitLabDiffFile[] = [file()]): GitLabDiff {
  return { files, truncated: false, collapsed: 0, expanded: false };
}

/** The names a body ends up carrying, parsed and marked exactly as the page does it. */
function marked(body: string, d: GitLabDiff = diff()): string[] {
  return codeRefsIn(markReviewCode(parseGitLabMarkdown(body), codeVocabulary(d)));
}

/** Every character the marked tree would DRAW, in order.
 *
 *  It exists because `marked` above cannot see the one defect that would matter most: this transform
 *  rewrites somebody else's prose in place, and a walk that dropped the words BETWEEN two names — or
 *  emitted one twice — would pass every assertion about which names were found. Measured: deleting
 *  the lead-text push in `markText` passes all 64 tests without this. */
function drawnText(body: string, d: GitLabDiff = diff()): string {
  return nodeText(markReviewCode(parseGitLabMarkdown(body), codeVocabulary(d)));
}

describe("nameIsCodeShaped", () => {
  it("takes ONE hump, which is the commonest identifier shape there is", () => {
    // Measured over this app's own source: 2 798 identifiers carry exactly one lowercase-to-uppercase
    // transition against 1 940 with two or more. A two-hump threshold would mark `getNextActions` and
    // refuse `computeState` in the same sentence, and a reader who can infer no rule from what is
    // marked reads the marking as noise.
    for (const name of ["computeState", "grantedAction", "initActions", "toBe", "apiVersion"]) {
      expect(nameIsCodeShaped(name), name).toBe(true);
    }
  });

  it("takes an underscore and several humps too", () => {
    for (const name of ["READY_PATH", "aws_s3_bucket", "PodDisruptionBudget", "terminationGracePeriodSeconds"]) {
      expect(nameIsCodeShaped(name), name).toBe(true);
    }
  });

  it("REFUSES a single lowercase word, which is the honest limit of the whole feature", () => {
    // Each of these is an identifier in a real branch AND ordinary English in the paragraph about it.
    // Nothing in the text can tell the two apart, so prose leaves them alone — a backtick is what
    // the model has for saying it meant the code.
    for (const name of ["state", "ready", "draining", "transitions", "flag", "group", "payload"]) {
      expect(nameIsCodeShaped(name), name).toBe(false);
    }
  });

  it("refuses a capitalised word and bare all-caps", () => {
    for (const name of ["Two", "The", "Kubernetes", "API", "JSON", "HTTP", "TODO"]) {
      expect(nameIsCodeShaped(name), name).toBe(false);
    }
  });

  it("takes a trailing call, which is how a sentence names a function", () => {
    expect(nameIsCodeShaped("health", true)).toBe(true);
    expect(nameIsCodeShaped("health", false)).toBe(false);
  });
});

describe("namesAFileOfTheDiff", () => {
  const paths = ["src/server/health.ts", "package.json", "charts/user-facing/values.yaml"];

  it("recognises a whole path and the tail of one, which is how a model writes each", () => {
    expect(namesAFileOfTheDiff("src/server/health.ts", paths)).toBe(true);
    expect(namesAFileOfTheDiff("health.ts", paths)).toBe(true);
    expect(namesAFileOfTheDiff("values.yaml", paths)).toBe(true);
    expect(namesAFileOfTheDiff("package.json", paths)).toBe(true);
  });

  it("does not mistake a name that merely ENDS the same way for a file", () => {
    // `ealth.ts` is a suffix of the path and is not a segment of it, so the boundary has to be a `/`.
    expect(namesAFileOfTheDiff("ealth.ts", paths)).toBe(false);
    expect(namesAFileOfTheDiff("health", paths)).toBe(false);
  });
});

describe("markReviewCode — plain prose", () => {
  it("marks a name whose SPELLING says code and the diff holds", () => {
    expect(marked("The grantedAction is extracted in computeState and passed to getNextActions.")).toEqual(
      ["grantedAction", "computeState", "getNextActions"],
    );
  });

  it("leaves a single lowercase word alone even where the branch holds it", () => {
    // `state`, `ready` and `health` are all in the patch above. In prose they are English.
    expect(marked("When the state is ready the health answer changes.")).toEqual([]);
  });

  it("marks the SEGMENTS of a dotted span and never the chain", () => {
    // `state.` stays prose and `automatedAction` is the chip. That is what the diff page does too:
    // Shiki tokenizes the chain into three tokens, so `onTokenClick` there searches the last segment
    // alone — one word, one answer, on both pages of one merge request. Marking the chain would also
    // mint a chip whose name `symbolIsSearchable` refuses, and the panel behind it would be empty.
    expect(marked("An effect sets state.automatedAction before normalization.")).toEqual([
      "automatedAction",
    ]);
  });

  it("REFUSES a name the diff does not hold, which is what makes a chip a claim worth trusting", () => {
    expect(marked("The grantNextAction hook applies it.")).toEqual([]);
    expect(marked("There is no gracefulShutdown yet.")).toEqual([]);
  });

  it("leaves a filename, a host and an abbreviation alone", () => {
    // Each of these is `name.name`, and each of its segments would resolve on its own. The shape rule
    // refuses every lowercase segment, so nothing here needs a stop-list of extensions.
    expect(marked("Nothing changed in health.ts, package.json, or on gitlab.example.com — i.e. nothing.")).toEqual(
      [],
    );
  });

  it("marks a name followed by a call even when it is one lowercase word", () => {
    expect(marked("Then health() answers 503.")).toEqual(["health"]);
  });

  it("MARKS A PROPER NOUN with an internal capital that the branch also holds — the stated cost", () => {
    // `GitLab` has one hump and stands in a comment in the fixture's own patch, so prose naming it
    // gets a chip nobody needed. It is recorded here rather than fixed because the panel behind it is
    // honest — it really does show where that string stands — and the alternative is a stop-list,
    // which this codebase refuses on principle: it would grow for ever and be wrong on the first name
    // nobody listed. The asymmetry is what decides it: this costs a chip, and the rule that would
    // prevent it costs `computeState`.
    expect(marked("GitLab renders it.")).toEqual(["GitLab"]);
  });
});

describe("markReviewCode — the model's own backticks", () => {
  it("drops the shape test inside a span that points at ONE name", () => {
    // This is what makes a single lowercase word reachable at all, and it is why the prompt asks the
    // model to backtick an identifier (`gitlab_review::system_prompt`).
    expect(marked("`draining` has to win over `ready`.")).toEqual(["draining", "ready"]);
  });

  it("strips one trailing call from a span", () => {
    expect(marked("`health()` gains a draining state.")).toEqual(["health"]);
  });

  it("keeps the shape test inside a span that quotes a FRAGMENT", () => {
    // A span holding several names is a quotation of code rather than a pointer at one name, so the
    // shape test still applies inside it: the names get their chips and the fragment's own
    // structural words stay plain. Without the split, every lowercase word inside every quoted
    // fragment — `kind`, `const`, `state` — would become a chip.
    expect(marked("`kind: PodDisruptionBudget` is new.")).toEqual(["PodDisruptionBudget"]);
    expect(marked("`const grantedAction = computeState(state)` is the line.")).toEqual([
      "grantedAction",
      "computeState",
    ]);
    // And the one-name span above it is the contrast that makes the split visible: there `state`
    // WOULD be marked, because the model pointed at exactly it.
    expect(marked("`state` is the receiver.")).toEqual(["state"]);
  });

  it("refuses a span that names a FILE of the diff, dotted or whole", () => {
    expect(marked("Nothing changed in `health.ts`.")).toEqual([]);
    expect(marked("Nothing changed in `src/server/health.ts`.")).toEqual([]);
  });

  it("refuses a span that is not a name at all", () => {
    expect(marked("It answers `503`.")).toEqual([]);
    expect(marked("The flag is `automated-actions`.")).toEqual([]);
  });
});

describe("markReviewCode — what it never reaches into", () => {
  it("leaves a FENCED BLOCK entirely alone", () => {
    // A fence is `pre > code` in this parser, so skipping `pre` by name is the whole of what stops a
    // block of code from being drawn as a row of pressable pills. It is the rule `markTrackerRefs`
    // states as "a reference inside code is code".
    const body = "Look:\n\n```ts\nif (state.automatedAction) return getNextActions(grantedAction);\n```\n";
    expect(marked(body)).toEqual([]);
  });

  it("leaves a link's own label alone", () => {
    expect(marked("See [computeState](https://example.com/x) for it.")).toEqual([]);
  });

  it("marks inside emphasis, a heading and a list item, which are prose", () => {
    expect(marked("**PodDisruptionBudget** is new.")).toEqual(["PodDisruptionBudget"]);
    expect(marked("## computeState\n")).toEqual(["computeState"]);
    expect(marked("- the grantedAction is extracted\n")).toEqual(["grantedAction"]);
  });

  it("is IDEMPOTENT: a second pass marks nothing new and changes no node", () => {
    const once = markReviewCode(parseGitLabMarkdown("The computeState call."), codeVocabulary(diff()));
    const twice = markReviewCode(once, codeVocabulary(diff()));
    expect(codeRefsIn(twice)).toEqual(["computeState"]);
    expect(twice).toBe(once);
  });

  it("returns the SAME array when nothing was marked, so a caller can memoize on identity", () => {
    const nodes = parseGitLabMarkdown("Nothing here names anything.");
    expect(markReviewCode(nodes, codeVocabulary(diff()))).toBe(nodes);
    expect(markReviewCode(nodes, NO_CODE_VOCABULARY)).toBe(nodes);
  });

  it("marks nothing at all with no diff, which is every surface but the reading", () => {
    expect(marked("The computeState call.", { files: [], truncated: false, collapsed: 0, expanded: false })).toEqual(
      [],
    );
  });
});

describe("THE PROSE SURVIVES, character for character", () => {
  /** This transform rewrites prose nobody here wrote, in place. Every assertion elsewhere in this
   *  file is about WHICH names were found, and not one of them would notice the words between two
   *  names going missing, or a word being drawn twice. */
  it("draws every character of the original, once, whatever it marked", () => {
    for (const body of [
      "The grantedAction is extracted in computeState and passed to getNextActions.",
      "computeState",
      "computeState and computeState again",
      "state.automatedAction, then terminationGracePeriodSeconds.",
      "`draining` has to win over `ready`, or a replica reports itself healthy.",
      "Then health() answers 503 — see READY_PATH.",
      "- the grantedAction is extracted\n- and READY_PATH moved\n",
      "Nothing here names anything at all.",
    ]) {
      // The parse itself normalises some markup, so the comparison is against the tree BEFORE
      // marking rather than against the raw body: what is being pinned is that MARKING adds and
      // removes no characters.
      const before = nodeText(parseGitLabMarkdown(body));
      expect(drawnText(body), body).toBe(before);
    }
  });

  it("keeps the words on BOTH sides of a marked name, and between two of them", () => {
    // The three positions a lead-or-tail bug hides in: a name at the very start, at the very end,
    // and two with prose between them.
    expect(drawnText("computeState is called by getNextActions")).toBe(
      "computeState is called by getNextActions",
    );
    expect(drawnText("we call computeState")).toBe("we call computeState");
    expect(drawnText("computeState")).toBe("computeState");
  });
});

describe("every chip a marker mints can be searched for", () => {
  /** The one invariant that stops an empty panel: a chip's name is a member of the index, and every
   *  member of the index is a name `symbolOccurrences` finds. Asserted over the marker's own output
   *  rather than over the index, because the marker is what mints the name the card will ask about. */
  it("finds at least one place for every name marked in a real paragraph", () => {
    const d = diff();
    const names = marked(
      "The grantedAction is extracted in computeState and passed to getNextActions, where " +
        "`draining` wins over `ready` — see state.automatedAction, `READY_PATH` and `health()`, and " +
        "terminationGracePeriodSeconds.",
      d,
    );
    expect(names.length).toBeGreaterThan(6);
    for (const name of names) {
      const found = symbolOccurrences(d, name);
      expect(found, `a chip was minted for ${name} and the search refused it`).not.toBeNull();
      expect(found!.total, `a chip was minted for ${name} and the search found none`).toBeGreaterThan(0);
    }
  });
});

describe("reviewCodePreview", () => {
  const search = () => symbolOccurrences(diff(), "state");

  /** A diff big enough to CROSS both bounds: five files, each holding the name four times. The
   *  fixture above holds one file with three occurrences, so every assertion about a ceiling passed it
   *  trivially — `3 <= 6` and `1 <= 3` are true of a slicing rule that does nothing at all. */
  function crowded(): GitLabDiff {
    const patch = (n: number) =>
      [
        `--- a/f${n}.ts`,
        `+++ b/f${n}.ts`,
        "@@ -1,4 +1,5 @@",
        "+const a = state;",
        "+const b = state;",
        "+const c = state;",
        "+const d = state;",
        "",
      ].join("\n");
    return diff([0, 1, 2, 3, 4].map((n) => file({ path: `f${n}.ts`, patch: patch(n) })));
  }

  it("bounds the rows and the files, and says how many places it is not showing", () => {
    const preview = reviewCodePreview(search())!;
    expect(preview.shown).toBeLessThanOrEqual(CODE_CARD_ROWS);
    expect(preview.files.length).toBeLessThanOrEqual(CODE_CARD_FILES);
    expect(preview.total).toBeGreaterThan(0);
    // The summary counts the whole SEARCH rather than the rows drawn — a card that counted its own
    // three files would disagree with the panel it presses through to.
    expect(preview.summary).toContain("occurrence");
  });

  it("really CUTS at both ceilings, and counts what it cut", () => {
    const found = symbolOccurrences(crowded(), "state")!;
    // 5 files x 4 places, so the search is well past both bounds and the slicing has work to do.
    expect(found.total).toBe(20);
    expect(found.files.length).toBe(5);

    const preview = reviewCodePreview(found)!;
    // The ROW ceiling binds first here: six rows fill inside the second file, so the third file is
    // never reached and the FILE ceiling is not what stopped it.
    expect(preview.shown).toBe(CODE_CARD_ROWS);
    expect(preview.files.length).toBeLessThanOrEqual(CODE_CARD_FILES);
    // Every drawn row belongs to a file that is drawn, and no file is drawn empty.
    expect(preview.files.reduce((n, f) => n + f.occurrences.length, 0)).toBe(preview.shown);
    for (const f of preview.files) expect(f.occurrences.length).toBeGreaterThan(0);
    // And the reader is told what is behind the press rather than being shown six of twenty in
    // silence.
    expect(codePreviewMore(preview)).toBe("14 more places in these changes");
    // The summary still counts the WHOLE search — five files, not the two drawn.
    expect(preview.summary).toContain("20 occurrences");
    expect(preview.summary).toContain("5 files");
  });

  it("cuts at the FILE ceiling when the files are short enough to reach it", () => {
    // One place per file, five files: the row budget never fills, so the file ceiling is the only
    // thing that can stop it — the other half of the pair, which one fixture cannot show.
    const oneEach = diff(
      [0, 1, 2, 3, 4].map((n) =>
        file({
          path: `g${n}.ts`,
          patch: [`--- a/g${n}.ts`, `+++ b/g${n}.ts`, "@@ -1,1 +1,2 @@", "+const a = state;", ""].join("\n"),
        }),
      ),
    );
    const preview = reviewCodePreview(symbolOccurrences(oneEach, "state"))!;
    expect(preview.files.length).toBe(CODE_CARD_FILES);
    expect(preview.shown).toBe(CODE_CARD_FILES);
    expect(codePreviewMore(preview)).toBe("2 more places in these changes");
  });

  it("counts what it left out, and says nothing when it left out nothing", () => {
    const preview = reviewCodePreview(search())!;
    expect(codePreviewMore({ ...preview, total: preview.shown })).toBeNull();
    expect(codePreviewMore({ ...preview, total: preview.shown + 3 })).toBe(
      "3 more places in these changes",
    );
    expect(codePreviewMore({ ...preview, total: preview.shown + 1 })).toContain("1 more place");
  });

  it("carries the removed-only verdict, so the card states it once about the whole answer", () => {
    // It is ON the preview rather than asked for beside it, because a component making a second call
    // could be handed a verdict about a different search. It was dead code for a while: written,
    // documented as riding the card's own label, and wired to nothing.
    expect(reviewCodePreview(search())!.removedOnly).toBe(false);
    const removed = diff([
      file({
        patch: ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,1 @@", "-const gone = oldHelper();", " keep", ""].join("\n"),
      }),
    ]);
    expect(reviewCodePreview(symbolOccurrences(removed, "oldHelper"))!.removedOnly).toBe(true);
  });

  it("is null for no search at all, so a chip whose diff moved draws nothing", () => {
    expect(reviewCodePreview(null)).toBeNull();
    expect(reviewCodePreview(symbolOccurrences(diff(), "nothingHere"))!.files).toEqual([]);
  });
});

describe("codeRefRemovedOnly", () => {
  it("is true only when the branch took every one of them away", () => {
    // `server` is on a removed line and on added ones in the fixture, so it is not removed-only.
    expect(codeRefRemovedOnly(symbolOccurrences(diff(), "server"))).toBe(false);
    const removed = diff([
      file({ patch: ["--- a/x.ts", "+++ b/x.ts", "@@ -1,2 +1,1 @@", "-const gone = oldHelper();", " keep", ""].join("\n") }),
    ]);
    expect(codeRefRemovedOnly(symbolOccurrences(removed, "oldHelper"))).toBe(true);
  });

  it("is false for a search that found nothing, which is not a claim about the branch", () => {
    expect(codeRefRemovedOnly(symbolOccurrences(diff(), "nothingHere"))).toBe(false);
    expect(codeRefRemovedOnly(null)).toBe(false);
  });
});

describe("reviewCodeUnsearchable", () => {
  it("counts the files a name could stand in without this ever saying so", () => {
    // The normal case rather than an edge: measured on the real instance, 96 of one merge request's
    // 149 files came back collapsed at every page size.
    expect(reviewCodeUnsearchable(diff())).toBeNull();
    const blind = diff([file(), file({ path: "logo.png", patch: undefined })]);
    expect(reviewCodeUnsearchable(blind)).toContain("1 file");
    expect(reviewCodeUnsearchable(blind)).toContain("not marked");
    expect(reviewCodeUnsearchable(null)).toBeNull();
  });

  it("never says '1 files'", () => {
    const blind = diff([file(), file({ path: "a.png", patch: undefined }), file({ path: "b.png", patch: undefined })]);
    expect(reviewCodeUnsearchable(blind)).toContain("2 files");
  });
});
