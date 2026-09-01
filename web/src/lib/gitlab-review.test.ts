import { describe, expect, it } from "vitest";
import {
  reviewAttribution,
  reviewCanBeAsked,
  reviewCoverage,
  reviewGroups,
  reviewIsStale,
  reviewLimits,
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
