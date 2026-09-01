import { describe, expect, it } from "vitest";
import {
  patchTextLineCount,
  REVIEW_PATCH_OPEN_LINES,
  REVIEW_PATCHES_SHOWN,
  reviewAttribution,
  reviewCanBeAsked,
  reviewCoverage,
  reviewFoldedPatches,
  reviewGroups,
  reviewIsStale,
  reviewLimits,
  reviewSectionId,
  UNPLACED_TITLE,
  type GitLabReview,
} from "./gitlab-review";
import type { GitLabDiff, GitLabDiffFile } from "./gitlab-diff";

function file(path: string): GitLabDiffFile {
  return {
    path,
    change: "changed",
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
    additions: 1,
    deletions: 1,
    binary: false,
    collapsed: false,
    generated: false,
  };
}

/** The same file with a patch of a stated number of body lines, so a test can put one either
 *  side of `REVIEW_PATCH_OPEN_LINES`. The 4-line git header this app's backend writes is part of
 *  the patch, and `patchTextLineCount` counts it — so the body is asked for and the header added,
 *  which is what a caller really controls. */
function longFile(path: string, bodyLines: number): GitLabDiffFile {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +${bodyLines} @@\n`;
  return { ...file(path), patch: header + Array.from({ length: bodyLines }, (_, i) => `+line ${i}`).join("\n") + "\n" };
}

function diff(paths: string[]): GitLabDiff {
  return { files: paths.map(file), truncated: false, collapsed: 0, expanded: false };
}

function review(over: Partial<GitLabReview> = {}): GitLabReview {
  return {
    head_sha: "aa11",
    headline: "It drains pods cleanly.",
    themes: [
      { title: "Draining", summary: "Why these are one change.", files: [{ path: "a.ts", note: "n" }] },
    ],
    unplaced: [],
    provider: "claude",
    model: "sonnet",
    generated_ms: 1_700_000_000_000,
    truncated: false,
    files_unseen: 0,
    ...over,
  };
}

describe("reviewIsStale", () => {
  it("is true only when the two commits are known and differ", () => {
    expect(reviewIsStale(review({ head_sha: "aa11" }), "bb22")).toBe(true);
    expect(reviewIsStale(review({ head_sha: "aa11" }), "aa11")).toBe(false);
  });

  it("is false when either commit is missing, rather than warning about every reading", () => {
    // A reading whose commit nothing can compare is not KNOWN to be stale, and a warning on every
    // reading is a warning nobody reads.
    expect(reviewIsStale(review({ head_sha: "" }), "bb22")).toBe(false);
    expect(reviewIsStale(review(), null)).toBe(false);
    expect(reviewIsStale(null, "bb22")).toBe(false);
  });
});

describe("reviewGroups", () => {
  it("resolves every file against the DIFF, so a group holds the real changed file", () => {
    const groups = reviewGroups(review(), diff(["a.ts"]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.files[0]!.file.patch).toContain("+b");
    expect(groups[0]!.files[0]!.note).toBe("n");
  });

  it("drops a path the diff no longer holds, and the theme with it when nothing is left", () => {
    // A stored reading outlives the diff it was made from, so a branch that moved can leave one
    // naming a file the page is not drawing. A heading over nothing reads as a failed section.
    const groups = reviewGroups(review(), diff(["somewhere/else.ts"]));
    expect(groups.filter((group) => !group.unplaced)).toHaveLength(0);
  });

  it("puts every file no theme claimed in a group of its OWN, at the end", () => {
    // The one thing a grouped view must never do is quietly leave a changed file out: a reviewer
    // who read the themes and believed they had seen the branch would be wrong.
    const groups = reviewGroups(review(), diff(["a.ts", "forgotten.ts"]));
    expect(groups).toHaveLength(2);
    const last = groups[1]!;
    expect(last.unplaced).toBe(true);
    expect(last.title).toBe(UNPLACED_TITLE);
    expect(last.files.map((entry) => entry.file.path)).toEqual(["forgotten.ts"]);
    expect(last.summary).not.toBe("");
  });

  it("computes the leftovers against the diff ON SCREEN, not the stored list", () => {
    // A file added by a push since the reading was made turns up in the leftovers rather than being
    // invisible — which is only true if this is derived rather than trusted.
    const stored = review({ unplaced: [] });
    const groups = reviewGroups(stored, diff(["a.ts", "pushed-since.ts"]));
    expect(groups.at(-1)!.files.map((entry) => entry.file.path)).toEqual(["pushed-since.ts"]);
  });

  it("draws no leftovers group when every file is grouped", () => {
    const groups = reviewGroups(review(), diff(["a.ts"]));
    expect(groups.some((group) => group.unplaced)).toBe(false);
  });

  it("is empty with no reading or no diff, rather than throwing", () => {
    expect(reviewGroups(null, diff(["a.ts"]))).toEqual([]);
    expect(reviewGroups(review(), null)).toEqual([]);
  });

  it("never draws one file under two headings, and the FIRST theme keeps it", () => {
    // The Rust parse already gives a file to the first theme only; this holds the view to the same
    // answer for a payload from anywhere else — an older backend, a store row somebody edited. A
    // file drawn twice is a file reviewed twice, and it would make the coverage count claim more
    // files than the diff holds.
    const twice = review({
      themes: [
        { title: "First", summary: "s", files: [{ path: "a.ts" }] },
        { title: "Second", summary: "s", files: [{ path: "a.ts" }] },
      ],
    });
    const groups = reviewGroups(twice, diff(["a.ts"]));
    const drawn = groups.flatMap((group) => group.files.map((entry) => entry.file.path));
    expect(drawn).toEqual(["a.ts"]);
    expect(groups.map((group) => group.title)).toEqual(["First"]);
    // And the coverage stays honest: one file grouped, out of one.
    expect(reviewCoverage(twice, diff(["a.ts"]))).toEqual({ grouped: 1, total: 1 });
  });
});

describe("reviewCoverage", () => {
  it("counts the files a THEME accounts for, over the diff's own total", () => {
    expect(reviewCoverage(review(), diff(["a.ts", "b.ts"]))).toEqual({ grouped: 1, total: 2 });
  });

  it("counts nothing grouped with no reading, and still states the total", () => {
    expect(reviewCoverage(null, diff(["a.ts", "b.ts"]))).toEqual({ grouped: 0, total: 2 });
  });
});

describe("reviewLimits", () => {
  it("says a branch was too large to read whole, and how many files never reached the model", () => {
    const cut = review({ truncated: true, files_unseen: 3 });
    expect(reviewLimits(cut)).toContain("3 files");
  });

  it("never says '1 files'", () => {
    expect(reviewLimits(review({ truncated: true, files_unseen: 1 }))).toContain("1 file never");
  });

  it("says nothing when the reading covered the whole diff", () => {
    expect(reviewLimits(review())).toBeNull();
  });
});

describe("reviewAttribution", () => {
  it("names the CLI and the model, because they are two facts", () => {
    expect(reviewAttribution(review())).toBe("claude · sonnet");
  });

  it("names the CLI alone when no model was chosen", () => {
    const noModel = review();
    delete noModel.model;
    expect(reviewAttribution(noModel)).toBe("claude");
  });
});

describe("reviewCanBeAsked", () => {
  it("is exactly whether there is a diff with files in it", () => {
    // A control that would start an agent run over an empty diff spends the reader's money to be
    // told the branch is empty.
    expect(reviewCanBeAsked(diff(["a.ts"]))).toBe(true);
    expect(reviewCanBeAsked(diff([]))).toBe(false);
    expect(reviewCanBeAsked(null)).toBe(false);
  });
});

describe("patchTextLineCount", () => {
  it("counts the lines a patch really holds", () => {
    expect(patchTextLineCount("@@ -1 +1 @@\n-a\n+b\n")).toBe(3);
    // A trailing newline TERMINATES the last line rather than starting an empty one — the trap
    // `patchTextLines` states for its own walk, and getting it wrong makes every count one too many.
    expect(patchTextLineCount("@@ -1 +1 @@\n-a\n+b")).toBe(3);
  });

  it("is 0 for a file that carries no patch at all", () => {
    // Four of the five states a file arrives in carry none: a binary file, a pure rename, one
    // GitLab collapsed. Those have no code, no fold and no count.
    expect(patchTextLineCount(null)).toBe(0);
    expect(patchTextLineCount(undefined)).toBe(0);
    expect(patchTextLineCount("")).toBe(0);
    expect(patchTextLineCount("\n")).toBe(0);
  });
});

describe("the document's two patch budgets", () => {
  /** A reading whose one theme names every file it is given. */
  function grouping(paths: string[]): GitLabReview {
    return review({
      themes: [{ title: "T", summary: "S", files: paths.map((path) => ({ path })) }],
    });
  }

  it("shows a short patch and folds a long one", () => {
    const short = longFile("short.ts", REVIEW_PATCH_OPEN_LINES - 10);
    const long = longFile("long.ts", REVIEW_PATCH_OPEN_LINES + 10);
    const groups = reviewGroups(grouping(["short.ts", "long.ts"]), {
      files: [short, long],
      truncated: false,
      collapsed: 0,
      expanded: false,
    });
    const files = groups[0]!.files;
    expect(files[0]!.patch).toMatchObject({ shown: true });
    expect(files[1]!.patch).toMatchObject({ shown: false });
    // And the count is the patch's own, which is what the fold's label states.
    expect(files[1]!.patch!.lines).toBeGreaterThan(REVIEW_PATCH_OPEN_LINES);
  });

  it("has no patch at all for a file that carries none", () => {
    const binary: GitLabDiffFile = { ...file("logo.png"), patch: undefined, binary: true };
    const groups = reviewGroups(grouping(["logo.png"]), {
      files: [binary],
      truncated: false,
      collapsed: 0,
      expanded: false,
    });
    // `null` rather than a zero-line patch: there is nothing to draw, so there is no fold either,
    // and the header note is what says which state it is.
    expect(groups[0]!.files[0]!.patch).toBeNull();
  });

  it("stops showing patches past the DOCUMENT's own ceiling, however short they are", () => {
    // Nothing here virtualizes: every shown patch is a mounted renderer with a highlighter of its
    // own, all on one first paint. A reading of a 149-file branch can name forty small files.
    const paths = Array.from({ length: REVIEW_PATCHES_SHOWN + 5 }, (_, i) => `f${i}.ts`);
    const groups = reviewGroups(grouping(paths), diff(paths));
    const shown = groups[0]!.files.filter((entry) => entry.patch?.shown).length;
    expect(shown).toBe(REVIEW_PATCHES_SHOWN);
    // The ones past it are folded rather than dropped: every changed file is still in the document.
    expect(groups[0]!.files.length).toBe(paths.length);
  });

  it("spends the ceiling across the WHOLE document, not per theme", () => {
    // The budget is a fact about the page — how many renderers are mounted at once — so a reading
    // of eight themes must not open twelve patches in each of them.
    const paths = Array.from({ length: REVIEW_PATCHES_SHOWN + 4 }, (_, i) => `f${i}.ts`);
    const half = Math.ceil(paths.length / 2);
    const twoThemes = review({
      themes: [
        { title: "One", summary: "S", files: paths.slice(0, half).map((path) => ({ path })) },
        { title: "Two", summary: "S", files: paths.slice(half).map((path) => ({ path })) },
      ],
    });
    const groups = reviewGroups(twoThemes, diff(paths));
    const shown = groups.flatMap((g) => g.files).filter((entry) => entry.patch?.shown).length;
    expect(shown).toBe(REVIEW_PATCHES_SHOWN);
  });

  it("does not let a LONG patch spend the ceiling it was never going to use", () => {
    // A long patch is folded on its own account, so it mounts nothing — and a document of long
    // files must still open its short ones.
    const long = Array.from({ length: 5 }, (_, i) => longFile(`long${i}.ts`, REVIEW_PATCH_OPEN_LINES + 5));
    const shortPaths = Array.from({ length: REVIEW_PATCHES_SHOWN }, (_, i) => `short${i}.ts`);
    const files = [...long, ...shortPaths.map(file)];
    const groups = reviewGroups(grouping(files.map((f) => f.path)), {
      files,
      truncated: false,
      collapsed: 0,
      expanded: false,
    });
    const shown = groups[0]!.files.filter((entry) => entry.patch?.shown);
    expect(shown.length).toBe(REVIEW_PATCHES_SHOWN);
    expect(shown.every((entry) => entry.file.path.startsWith("short"))).toBe(true);
  });

  it("gives the LEFTOVERS the same budget rather than a rule of their own", () => {
    // The reading had nothing to say about them, so their code is the only thing on the page that
    // speaks for them.
    const groups = reviewGroups(grouping(["a.ts"]), diff(["a.ts", "nobody-claimed.ts"]));
    const leftovers = groups.at(-1)!;
    expect(leftovers.unplaced).toBe(true);
    expect(leftovers.files[0]!.patch).toMatchObject({ shown: true });
  });
});

describe("reviewFoldedPatches", () => {
  it("counts what folded, over what the reading holds", () => {
    const paths = Array.from({ length: REVIEW_PATCHES_SHOWN + 3 }, (_, i) => `f${i}.ts`);
    const groups = reviewGroups(
      review({ themes: [{ title: "T", summary: "S", files: paths.map((path) => ({ path })) }] }),
      diff(paths),
    );
    expect(reviewFoldedPatches(groups)).toEqual({ folded: 3, total: paths.length });
  });

  it("says nothing when every patch is shown", () => {
    // A document that warned about a fold it does not have is a warning nobody reads — the rule
    // `reviewIsStale` already holds for a commit nothing can compare.
    expect(reviewFoldedPatches(reviewGroups(review(), diff(["a.ts"])))).toBeNull();
    expect(reviewFoldedPatches([])).toBeNull();
  });

  it("counts no patch for a file that has none", () => {
    const binary: GitLabDiffFile = { ...file("logo.png"), patch: undefined, binary: true };
    const groups = reviewGroups(
      review({ themes: [{ title: "T", summary: "S", files: [{ path: "logo.png" }] }] }),
      { files: [binary], truncated: false, collapsed: 0, expanded: false },
    );
    // Neither folded nor shown: there was never a diff to draw, so it is in no total.
    expect(reviewFoldedPatches(groups)).toBeNull();
  });
});

describe("reviewSectionId", () => {
  it("is keyed on the INDEX, so two themes with one title do not collide", () => {
    // The parse bounds the words and does not make them unique, and an id that collided would put
    // two sticky headings behind one anchor.
    expect(reviewSectionId(0)).not.toBe(reviewSectionId(1));
    expect(reviewSectionId(0)).toMatch(/^gitlab-review-section-/);
  });
});
