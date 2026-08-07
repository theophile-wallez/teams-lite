import { describe, expect, it } from "vitest";
import {
  activeDiffFeedFile,
  canExpandDiff,
  DIFF_FEED_TOLERANCE,
  diffFeedVersions,
  DIFF_COLUMNS_MIN_WIDTH,
  diffFileNotice,
  diffFilePaths,
  diffFileState,
  diffPageColumns,
  diffSummary,
  diffTotals,
  diffTreeGitStatus,
  diffTreeStatus,
  diffTruncationNotice,
  effectiveDiffLayout,
  expandDiffHint,
  formatDiffStat,
  sameDiffFile,
  selectDiffFile,
  SPLIT_MIN_WIDTH,
  type GitLabDiff,
  type GitLabDiffFile,
} from "./gitlab-diff";

function file(over: Partial<GitLabDiffFile> = {}): GitLabDiffFile {
  return {
    path: "src/app.ts",
    change: "changed",
    patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n",
    additions: 1,
    deletions: 1,
    binary: false,
    collapsed: false,
    generated: false,
    ...over,
  };
}

function diff(over: Partial<GitLabDiff> = {}): GitLabDiff {
  return { files: [file()], truncated: false, collapsed: 0, expanded: false, ...over };
}

describe("a file with no patch", () => {
  it("says which of the three reasons it is", () => {
    expect(diffFileState(file())).toBe("patch");
    expect(diffFileState(file({ patch: undefined, binary: true }))).toBe("binary");
    expect(diffFileState(file({ patch: undefined }))).toBe("collapsed");
  });

  it("is a RENAME before it is a collapsed file, even when GitLab says collapsed", () => {
    // Measured against the real instance: GitLab sets `collapsed: true` on renamed rows,
    // whose diff is empty by definition. Reading that as an elision would report every
    // moved file as one the reader has to ask again for.
    const moved = file({ patch: undefined, change: "renamed", collapsed: true, old_path: "old.ts" });
    expect(diffFileState(moved)).toBe("renamed");
    expect(diffFileNotice(moved)).toBeNull();
  });

  it("explains a binary file and a collapsed one differently", () => {
    expect(diffFileNotice(file({ patch: undefined, binary: true }))).toMatch(/binary/i);
    expect(diffFileNotice(file({ patch: undefined }))).toMatch(/did not expand/i);
    // A file that HAS a patch explains nothing: the patch is the explanation.
    expect(diffFileNotice(file())).toBeNull();
  });
});

describe("the tree", () => {
  it("names each file in git's own vocabulary", () => {
    expect(diffTreeStatus(file({ change: "new" }))).toBe("added");
    expect(diffTreeStatus(file({ change: "deleted" }))).toBe("deleted");
    expect(diffTreeStatus(file({ change: "renamed" }))).toBe("renamed");
    expect(diffTreeStatus(file({ change: "changed" }))).toBe("modified");
  });

  it("keeps GitLab's own order and adds none of its own", () => {
    const d = diff({
      files: [file({ path: "z.ts" }), file({ path: "a.ts" }), file({ path: "src/m.ts" })],
    });
    expect(diffFilePaths(d)).toEqual(["z.ts", "a.ts", "src/m.ts"]);
    expect(diffTreeGitStatus(d).map((entry) => entry.path)).toEqual(["z.ts", "a.ts", "src/m.ts"]);
  });

  it("is empty rather than absent with nothing to show", () => {
    expect(diffFilePaths(null)).toEqual([]);
    expect(diffTreeGitStatus(null)).toEqual([]);
  });
});

describe("which file is shown", () => {
  it("is the one named", () => {
    const d = diff({ files: [file({ path: "a.ts" }), file({ path: "b.ts" })] });
    expect(selectDiffFile(d, "b.ts")?.path).toBe("b.ts");
  });

  it("falls back to the first file that has something to READ", () => {
    // A merge request whose first file is a lockfile GitLab collapsed would otherwise open
    // on a sentence explaining there is nothing to see, which reads as a failed load.
    const d = diff({
      files: [
        file({ path: "bun.lock", patch: undefined, collapsed: true }),
        file({ path: "src/app.ts" }),
      ],
    });
    expect(selectDiffFile(d, null)?.path).toBe("src/app.ts");
  });

  it("falls back when the named path no longer exists", () => {
    // A reader who switched to the expanded read, or came back to a merge request that
    // moved, holds a selection for a file that is not in the list any more.
    const d = diff({ files: [file({ path: "a.ts" })] });
    expect(selectDiffFile(d, "gone.ts")?.path).toBe("a.ts");
  });

  it("shows a file with no patch when that is all there is", () => {
    const d = diff({ files: [file({ path: "logo.png", patch: undefined, binary: true })] });
    expect(selectDiffFile(d, null)?.path).toBe("logo.png");
    expect(selectDiffFile(null, null)).toBeNull();
    expect(selectDiffFile(diff({ files: [] }), null)).toBeNull();
  });
});

describe("the counts", () => {
  it("adds up what arrived, and nothing it did not get", () => {
    const d = diff({
      files: [
        file({ additions: 10, deletions: 2 }),
        file({ path: "big.ts", patch: undefined, collapsed: true, additions: 0, deletions: 0 }),
      ],
    });
    expect(diffTotals(d)).toEqual({ additions: 10, deletions: 2 });
    // The two counts are one fact and stay together; only the file count is separated.
    expect(diffSummary(d)).toBe("2 files · +10 −2");
  });

  it("drops a half that is zero rather than drawing a 0", () => {
    expect(formatDiffStat(file({ additions: 3, deletions: 0 }))).toBe("+3");
    expect(formatDiffStat(file({ additions: 0, deletions: 4 }))).toBe("−4");
    expect(formatDiffStat(file({ additions: 0, deletions: 0 }))).toBe("");
    expect(formatDiffStat(file({ additions: 3, deletions: 4 }))).toBe("+3 −4");
  });

  it("says so plainly with nothing changed", () => {
    expect(diffSummary(diff({ files: [] }))).toBe("No files changed.");
    expect(diffSummary(null)).toBe("No files changed.");
    expect(diffSummary(diff({ files: [file({ additions: 0, deletions: 0 })] }))).toBe("1 file");
  });
});

describe("what a read left out", () => {
  it("counts it rather than stopping silently", () => {
    const d = diff({ files: [file(), file({ path: "b.ts" })], truncated: true, total: 149 });
    expect(diffTruncationNotice(d)).toBe("149 files changed — the 2 below are what this page read.");
  });

  it("still says something when GitLab named no total", () => {
    const d = diff({ truncated: true, total: undefined });
    expect(diffTruncationNotice(d)).toMatch(/more changed files/i);
  });

  it("says nothing about a complete read", () => {
    expect(diffTruncationNotice(diff())).toBeNull();
    expect(diffTruncationNotice(null)).toBeNull();
  });
});

describe("the expanded read", () => {
  it("is offered exactly when something is collapsed and this is the plain answer", () => {
    expect(canExpandDiff(diff({ collapsed: 3 }))).toBe(true);
    // Nothing collapsed: a control that changes nothing.
    expect(canExpandDiff(diff({ collapsed: 0 }))).toBe(false);
    // Already expanded: the same answer for another half a megabyte. Measured — 3 of 149
    // files stayed collapsed even then, so this must not offer a third read.
    expect(canExpandDiff(diff({ collapsed: 3, expanded: true }))).toBe(false);
    expect(canExpandDiff(null)).toBe(false);
  });

  it("names the count and what it costs before it is pressed", () => {
    const offer = expandDiffHint(diff({ collapsed: 50 }));
    expect(offer?.label).toBe("Expand 50 files");
    expect(offer?.hint).toMatch(/slower and much larger/i);
    expect(expandDiffHint(diff({ collapsed: 1 }))?.label).toBe("Expand 1 file");
    expect(expandDiffHint(diff({ collapsed: 0 }))).toBeNull();
  });
});

describe("the layout", () => {
  it("is unified on a narrow screen whatever the reader chose", () => {
    // This app is read from a phone: at 390px a split diff is two columns of eight
    // characters. The preference is kept, it simply cannot apply here.
    expect(effectiveDiffLayout("split", 390)).toBe("unified");
    expect(effectiveDiffLayout("split", SPLIT_MIN_WIDTH - 1)).toBe("unified");
    expect(effectiveDiffLayout("split", SPLIT_MIN_WIDTH)).toBe("split");
    expect(effectiveDiffLayout("split", 1400)).toBe("split");
  });

  it("never widens a unified choice", () => {
    expect(effectiveDiffLayout("unified", 1400)).toBe("unified");
  });
});

describe("the page's two columns", () => {
  it("draws both on a wide screen, whichever the reader is in", () => {
    for (const column of ["files", "patch"] as const) {
      expect(diffPageColumns(1400, column)).toEqual({ files: true, patch: true, narrow: false });
    }
    expect(diffPageColumns(DIFF_COLUMNS_MIN_WIDTH, "files").narrow).toBe(false);
  });

  it("draws ONE at a time below the app's own breakpoint", () => {
    // The list-then-detail shape every other surface in this app takes below `md`: a tree
    // beside a patch at 390px is a column of truncated paths next to eight characters of code.
    expect(diffPageColumns(390, "files")).toEqual({ files: true, patch: false, narrow: true });
    expect(diffPageColumns(390, "patch")).toEqual({ files: false, patch: true, narrow: true });
    expect(diffPageColumns(DIFF_COLUMNS_MIN_WIDTH - 1, "files").narrow).toBe(true);
  });

  it("opens on the FILES before anything is measured", () => {
    // Width 0 is the first paint. A page whose subject the reader has not picked yet opens on
    // the list of files, and never on a patch drawn at a width nothing measured.
    expect(diffPageColumns(0, "files")).toEqual({ files: true, patch: false, narrow: true });
  });
});

describe("which file the reader is at in the feed", () => {
  const tops = [
    { path: "a.ts", top: 0 },
    { path: "b.ts", top: 400 },
    { path: "c.ts", top: 900 },
  ];
  // Room for one more screenful under the last file, so the end of the feed is a state of its own.
  const scrollHeight = 1600;
  const viewport = 500;

  it("names the file whose code fills the top of the screen", () => {
    expect(activeDiffFeedFile(tops, 0, viewport, scrollHeight)).toBe("a.ts");
    expect(activeDiffFeedFile(tops, 300, viewport, scrollHeight)).toBe("a.ts");
    expect(activeDiffFeedFile(tops, 400, viewport, scrollHeight)).toBe("b.ts");
    expect(activeDiffFeedFile(tops, 700, viewport, scrollHeight)).toBe("b.ts");
    expect(activeDiffFeedFile(tops, 900, viewport, scrollHeight)).toBe("c.ts");
  });

  it("forgives a few pixels, because a scroll position is fractional", () => {
    // A file whose top is a hair below the fold is the one being read, not the one above it.
    expect(activeDiffFeedFile(tops, 400 - DIFF_FEED_TOLERANCE, viewport, scrollHeight)).toBe("b.ts");
    expect(activeDiffFeedFile(tops, 400 - DIFF_FEED_TOLERANCE - 1, viewport, scrollHeight)).toBe("a.ts");
  });

  it("keeps the file the reader ASKED for while the feed is pinned at its end", () => {
    // The last screenful holds several files and none of them can reach the top, so the rule
    // above would answer with whichever starts above the fold — and a press on any of the others
    // would light a row the reader did not press.
    const end = scrollHeight - viewport;
    const short = [...tops, { path: "d.ts", top: 1400 }, { path: "e.ts", top: 1500 }];
    expect(activeDiffFeedFile(short, end, viewport, scrollHeight, "d.ts")).toBe("d.ts");
    expect(activeDiffFeedFile(short, end, viewport, scrollHeight, "e.ts")).toBe("e.ts");
  });

  it("hands the question back once the reader scrolls away from what they asked for", () => {
    // Away from the end, and away from the file itself: the file at the top of the screen is the
    // answer again.
    expect(activeDiffFeedFile(tops, 400, viewport, scrollHeight, "a.ts")).toBe("b.ts");
    // At the end, but the asked file is above the viewport now.
    expect(activeDiffFeedFile(tops, scrollHeight - viewport, viewport, scrollHeight, "a.ts")).toBe(
      "c.ts",
    );
  });

  it("names a file nobody asked for by where it is", () => {
    expect(activeDiffFeedFile(tops, scrollHeight - viewport, viewport, scrollHeight)).toBe("c.ts");
    expect(activeDiffFeedFile(tops, scrollHeight - viewport, viewport, scrollHeight, "gone.ts")).toBe(
      "c.ts",
    );
  });

  it("answers nothing for a diff with no files", () => {
    expect(activeDiffFeedFile([], 0, viewport, scrollHeight)).toBeNull();
  });

  it("names the first file before anything has been measured", () => {
    // Width and height are 0 on the first paint, and the honest answer is where the feed opens.
    expect(activeDiffFeedFile(tops, 0, 0, 0)).toBe("a.ts");
  });
});

describe("the version each file's item carries", () => {
  const cards = (path: string) => ({ file: file({ path }), cards: "" });

  it("starts at one and stands still while nothing changes", () => {
    const first = diffFeedVersions(new Map(), [cards("a.ts"), cards("b.ts")]);
    expect(first.get("a.ts")?.version).toBe(1);
    const second = diffFeedVersions(first, [cards("a.ts"), cards("b.ts")]);
    expect(second.get("a.ts")?.version).toBe(1);
    expect(second.get("b.ts")?.version).toBe(1);
  });

  it("moves when the FILE changed, which is what the expanded read does", () => {
    // A file GitLab withheld comes back with its patch under the same path. A version that stood
    // still there left the renderer drawing the sentence that stood in for the code.
    const withheld = { file: file({ path: "bun.lock", patch: undefined, collapsed: true }), cards: "" };
    const first = diffFeedVersions(new Map(), [withheld]);
    const expanded = diffFeedVersions(first, [
      { file: file({ path: "bun.lock", patch: "diff --git a/bun.lock b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n" }), cards: "" },
    ]);
    expect(expanded.get("bun.lock")?.version).toBe(2);
  });

  it("moves when a CARD opened or landed, and only for that file", () => {
    const first = diffFeedVersions(new Map(), [cards("a.ts"), cards("b.ts")]);
    const second = diffFeedVersions(first, [
      { file: file({ path: "a.ts" }), cards: "composer:additions:5:2" },
      cards("b.ts"),
    ]);
    expect(second.get("a.ts")?.version).toBe(2);
    expect(second.get("b.ts")?.version).toBe(1);
  });

  it("reads a fresh read of the same file as the same file", () => {
    // Every read is fresh JSON, several times a minute, and almost all of it says what the last
    // one said. Bumping on identity would hand the renderer every file again for nothing.
    const first = diffFeedVersions(new Map(), [cards("a.ts")]);
    expect(sameDiffFile(file({ path: "a.ts" }), file({ path: "a.ts" }))).toBe(true);
    expect(diffFeedVersions(first, [cards("a.ts")]).get("a.ts")?.version).toBe(1);
  });

  it("sees every field that decides what is drawn", () => {
    const base = file();
    expect(sameDiffFile(base, file({ patch: base.patch + " " }))).toBe(false);
    expect(sameDiffFile(base, file({ additions: 9 }))).toBe(false);
    expect(sameDiffFile(base, file({ change: "new" }))).toBe(false);
    expect(sameDiffFile(base, file({ old_path: "was.ts" }))).toBe(false);
    expect(sameDiffFile(base, file({ generated: true }))).toBe(false);
    expect(sameDiffFile(base, file({ binary: true }))).toBe(false);
    expect(sameDiffFile(base, file({ collapsed: true }))).toBe(false);
  });
});
