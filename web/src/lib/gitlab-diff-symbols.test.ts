import { describe, expect, it } from "vitest";
import {
  fileIsSearchable,
  MAX_SYMBOL_OCCURRENCES,
  occurrenceSideLabel,
  SYMBOL_MAX_CHARS,
  SYMBOL_MIN_CHARS,
  symbolIsSearchable,
  symbolOccurrences,
  symbolSearchLimits,
  symbolSearchSummary,
} from "./gitlab-diff-symbols";
import type { GitLabDiff, GitLabDiffFile } from "./gitlab-diff";

/** A patch whose SHAPE is the point: the name under test stands on an added line, on a removed
 *  line, on a context line, twice on one line, and inside a longer word that must NOT match. The
 *  leading space on a context line is a real patch's own mark — without it the line numbers this
 *  search reports would be one out, which is the trap `patchTextLines` is built around. */
const PATCH = [
  "diff --git a/src/server/health.ts b/src/server/health.ts",
  "--- a/src/server/health.ts",
  "+++ b/src/server/health.ts",
  "@@ -1,4 +1,5 @@",
  " import { server } from './server';",
  "-export function health(server) {",
  "+export function health(server, ready) {",
  "+  if (server.draining) return 503;",
  "   return serverReady ? 200 : 503;",
  "",
].join("\n");

function file(over: Partial<GitLabDiffFile> = {}): GitLabDiffFile {
  return {
    path: "src/server/health.ts",
    change: "changed",
    patch: PATCH,
    additions: 2,
    deletions: 1,
    binary: false,
    collapsed: false,
    generated: false,
    ...over,
  };
}

function diff(files: GitLabDiffFile[]): GitLabDiff {
  return { files, truncated: false, collapsed: 0, expanded: false };
}

describe("symbolIsSearchable", () => {
  it("takes an identifier in the shape every language in a diff spells one", () => {
    for (const name of ["server", "podDisruptionBudget", "READY_PATH", "aws_s3_bucket", "$svc", "_x", "db"]) {
      expect(symbolIsSearchable(name)).toBe(true);
    }
  });

  it("refuses what is punctuation, a literal, or whitespace around a name", () => {
    // Every one of these is a token the renderer really reports, and a press on one that opened
    // an empty side panel would read as a bug.
    for (const token of ["{", "=>", "  ", "", '"a string"', "1.42.0", "server.ready", "-", ":"]) {
      expect(symbolIsSearchable(token)).toBe(false);
    }
  });

  it("refuses a single character, because that is a highlight of most of the file", () => {
    expect(SYMBOL_MIN_CHARS).toBe(2);
    expect(symbolIsSearchable("i")).toBe(false);
    expect(symbolIsSearchable("id")).toBe(true);
  });

  it("refuses a token too long to be a name a reader pressed on purpose", () => {
    expect(symbolIsSearchable("a".repeat(SYMBOL_MAX_CHARS))).toBe(true);
    expect(symbolIsSearchable("a".repeat(SYMBOL_MAX_CHARS + 1))).toBe(false);
  });

  it("answers false for nothing at all rather than throwing", () => {
    expect(symbolIsSearchable(null)).toBe(false);
    expect(symbolIsSearchable(undefined)).toBe(false);
  });
});

describe("symbolOccurrences", () => {
  it("finds the name as a WHOLE word, and never inside a longer one", () => {
    const found = symbolOccurrences(diff([file()]), "server")!;
    // `serverReady` on the context line holds `server` and is not an occurrence of it. Five
    // matches: the context import (twice — the identifier and the module name are both `server`
    // as whole words? no: './server' is inside quotes but IS whole-word bounded by `'`), the
    // removed line, and two on the added line.
    expect(found.files).toHaveLength(1);
    expect(found.total).toBe(found.files[0]!.occurrences.length);
    for (const occurrence of found.files[0]!.occurrences) {
      expect(occurrence.text.slice(occurrence.start, occurrence.end)).toBe("server");
    }
    // The one that must not be there: nothing points into `serverReady`.
    const contextLine = found.files[0]!.occurrences.find((o) => o.text.includes("serverReady"));
    expect(contextLine).toBeUndefined();
  });

  it("reports the line number the GUTTER shows, and which side the line is on", () => {
    const found = symbolOccurrences(diff([file()]), "health")!;
    // `health` is on the removed line (old 2) and the added line (new 2).
    const sides = found.files[0]!.occurrences.map((o) => ({ side: o.side, lineNumber: o.lineNumber }));
    expect(sides).toEqual([
      { side: "old", lineNumber: 2 },
      { side: "new", lineNumber: 2 },
    ]);
  });

  it("finds a name that stands twice on one line, in reading order", () => {
    const twice = file({
      patch: [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+const ready = ready + 1;",
        "",
      ].join("\n"),
    });
    const found = symbolOccurrences(diff([twice]), "ready")!;
    const starts = found.files[0]!.occurrences.map((o) => o.start);
    expect(starts).toEqual([6, 14]);
    expect(starts[0]!).toBeLessThan(starts[1]!);
  });

  it("keeps the diff's own file order, and lists no file that does not hold the name", () => {
    const other = file({
      path: "charts/values.yaml",
      patch: [
        "diff --git a/charts/values.yaml b/charts/values.yaml",
        "--- a/charts/values.yaml",
        "+++ b/charts/values.yaml",
        "@@ -1 +1,2 @@",
        " web:",
        "+  server: on",
        "",
      ].join("\n"),
    });
    const nothing = file({ path: "docs/readme.md", patch: "diff --git a/docs/readme.md b/docs/readme.md\n--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -1 +1 @@\n-a\n+b\n" });
    const found = symbolOccurrences(diff([other, nothing, file()]), "server")!;
    expect(found.files.map((f) => f.path)).toEqual(["charts/values.yaml", "src/server/health.ts"]);
  });

  it("counts a file with NO patch as unsearchable rather than searching nothing", () => {
    // Four of the five states a file arrives in carry no patch, and one of them may well hold the
    // name — so the search says it covered less than the branch did.
    const binary = file({ path: "docs/x.png", patch: undefined, binary: true });
    const collapsed = file({ path: "bun.lock", patch: undefined, collapsed: true });
    const found = symbolOccurrences(diff([file(), binary, collapsed]), "server")!;
    expect(found.searched).toBe(1);
    expect(found.unsearchable).toBe(2);
    expect(symbolSearchLimits(found)).toContain("2 files");
  });

  it("answers a search with no files rather than null when the name is nowhere else", () => {
    // A real and useful answer: the reader pressed a name, and this is "only here".
    const found = symbolOccurrences(diff([file()]), "kubernetes")!;
    expect(found).not.toBeNull();
    expect(found.files).toEqual([]);
    expect(found.total).toBe(0);
    expect(symbolSearchSummary(found)).toBe("Nowhere else in these changes.");
  });

  it("answers null when there is nothing to search or nothing worth searching for", () => {
    expect(symbolOccurrences(null, "server")).toBeNull();
    expect(symbolOccurrences(diff([file()]), "{")).toBeNull();
    expect(symbolOccurrences(diff([file()]), "")).toBeNull();
    expect(symbolOccurrences(diff([file()]), null)).toBeNull();
  });

  it("bounds the list and SAYS it bounded it, rather than cutting it silently", () => {
    // One file whose every added line holds the name, well past the budget.
    const many = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      `@@ -1 +1,${MAX_SYMBOL_OCCURRENCES + 50} @@`,
      ...Array.from({ length: MAX_SYMBOL_OCCURRENCES + 50 }, () => "+const server = 1;"),
      "",
    ].join("\n");
    const found = symbolOccurrences(diff([file({ path: "big.ts", patch: many })]), "server")!;
    expect(found.total).toBe(MAX_SYMBOL_OCCURRENCES);
    expect(found.truncated).toBe(true);
    expect(symbolSearchLimits(found)).toContain(String(MAX_SYMBOL_OCCURRENCES));
  });

  it("spends the budget in the diff's own order, and does not call a file it never opened searched", () => {
    const many = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      `@@ -1 +1,${MAX_SYMBOL_OCCURRENCES + 10} @@`,
      ...Array.from({ length: MAX_SYMBOL_OCCURRENCES + 10 }, () => "+const server = 1;"),
      "",
    ].join("\n");
    const found = symbolOccurrences(
      diff([file({ path: "big.ts", patch: many }), file()]),
      "server",
    )!;
    // The second file was never opened, so it is neither searched nor unsearchable — what says
    // the list is short is `truncated`, said once.
    expect(found.files.map((f) => f.path)).toEqual(["big.ts"]);
    expect(found.searched).toBe(1);
    expect(found.unsearchable).toBe(0);
    expect(found.truncated).toBe(true);
  });

  it("treats `$` as part of a name, which `\\b` would not", () => {
    // The boundary is the same character set the identifier is, so `$svc` inside `x$svc` is not a
    // match — the asymmetry a `\b`-based pattern gets wrong in one direction only.
    const helm = file({
      path: "templates/pdb.yaml",
      patch: [
        "diff --git a/templates/pdb.yaml b/templates/pdb.yaml",
        "--- a/templates/pdb.yaml",
        "+++ b/templates/pdb.yaml",
        "@@ -1 +1,2 @@",
        "+{{- if $svc.podDisruptionBudget }}",
        "+{{- if x$svc }}",
        "",
      ].join("\n"),
    });
    const found = symbolOccurrences(diff([helm]), "$svc")!;
    expect(found.total).toBe(1);
    expect(found.files[0]!.occurrences[0]!.text).toContain("podDisruptionBudget");
  });
});

describe("symbolSearchSummary", () => {
  it("never says '1 occurrences' or '1 files'", () => {
    const one = symbolOccurrences(diff([file()]), "draining")!;
    expect(one.total).toBe(1);
    expect(symbolSearchSummary(one)).toBe("1 occurrence in 1 file");
  });

  it("states the two counts apart, because they answer different questions", () => {
    const found = symbolOccurrences(diff([file()]), "health")!;
    expect(symbolSearchSummary(found)).toBe("2 occurrences in 1 file");
  });
});

describe("symbolSearchLimits", () => {
  it("answers null when the search covered every file", () => {
    expect(symbolSearchLimits(symbolOccurrences(diff([file()]), "server")!)).toBeNull();
  });

  it("never says '1 files'", () => {
    const found = symbolOccurrences(diff([file(), file({ path: "x.png", patch: undefined })]), "server")!;
    expect(symbolSearchLimits(found)).toContain("1 file in this diff");
  });
});

describe("occurrenceSideLabel", () => {
  it("names a context line as context rather than as a change to review", () => {
    expect(occurrenceSideLabel("new")).toBe("added");
    expect(occurrenceSideLabel("old")).toBe("removed");
    expect(occurrenceSideLabel("both")).toBe("context");
  });
});

describe("fileIsSearchable", () => {
  it("is exactly whether the file's patch travelled", () => {
    expect(fileIsSearchable(file())).toBe(true);
    expect(fileIsSearchable(file({ patch: undefined }))).toBe(false);
  });
});
