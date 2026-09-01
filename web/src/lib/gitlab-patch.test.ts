import { describe, expect, it } from "vitest";

import { HUNK_HEADER, hunksTouching, narrowPatch, splitPatch } from "./gitlab-patch";

// Three hunks, with the shape this app's own backend writes: the git header first (see
// `gitlab_mr::unified_patch`, which GitLab's bare `@@` answer does not carry), then the hunks. The
// NEW-side spans are 1–5, 21–24 and 98–100, which every test below is written against.
const PATCH = [
  "--- a/src/server/health.ts",
  "+++ b/src/server/health.ts",
  "@@ -1,4 +1,5 @@",
  ' import { readyz } from "./probe";',
  '+import { draining } from "./drain";',
  " ",
  ' export const READY_PATH = "/readyz";',
  "@@ -20,3 +21,4 @@ function ready() {",
  "   return 200;",
  "+  // the order matters",
  " }",
  "@@ -96,2 +98,3 @@ function health() {",
  "   return 200;",
  "+  if (draining) return 503;",
  " }",
  "",
].join("\n");

describe("splitPatch", () => {
  it("cuts a patch into its hunks, each with the NEW lines it covers", () => {
    const split = splitPatch(PATCH);
    expect(split.hunks.map((hunk) => [hunk.index, hunk.from, hunk.to])).toEqual([
      [0, 1, 5],
      [1, 21, 24],
      [2, 98, 100],
    ]);
  });

  it("keeps the git header as the PREAMBLE, because a patch with none names no file", () => {
    const split = splitPatch(PATCH);
    expect(split.preamble).toBe("--- a/src/server/health.ts\n+++ b/src/server/health.ts\n");
    // And no part of the header leaked into the first hunk.
    expect(split.hunks[0]!.text.startsWith("@@ -1,4 +1,5 @@")).toBe(true);
  });

  it("gives every hunk its own newline-terminated text, and loses no line", () => {
    const split = splitPatch(PATCH);
    // Put back together, a patch is itself: nothing added, nothing dropped, nothing reordered. That
    // is the whole contract a narrowed patch rests on.
    expect(split.preamble + split.hunks.map((hunk) => hunk.text).join("")).toBe(PATCH);
  });

  it("reads an absent count as ONE line, which is git's own shorthand", () => {
    const split = splitPatch("--- a\n+++ b\n@@ -3 +3 @@\n-was\n+is\n");
    expect([split.hunks[0]!.from, split.hunks[0]!.to]).toEqual([3, 3]);
  });

  it("gives a hunk that adds NOTHING the single point it sits at", () => {
    // `+40,0` is a pure deletion: it really covers no line of the new file. Left as an empty span it
    // could be named by no range at all, so it would fall out of every theme into the leftovers for
    // ever — see `PatchHunk.to`.
    const split = splitPatch("--- a\n+++ b\n@@ -40,3 +40,0 @@\n-one\n-two\n-three\n");
    expect([split.hunks[0]!.from, split.hunks[0]!.to]).toEqual([40, 40]);
    expect(hunksTouching(split.hunks, 40, 40)).toEqual(new Set([0]));
  });

  it("answers NO hunks for a patch that holds none, and for nothing at all", () => {
    // A binary marker is the real case: `Binary files a/logo.png and b/logo.png differ` carries no
    // `@@`, so there is nothing in it to split and the whole text is the preamble.
    const binary = splitPatch("--- a\n+++ b\nBinary files a/logo.png and b/logo.png differ\n");
    expect(binary.hunks).toEqual([]);
    expect(binary.preamble).toContain("Binary files");
    expect(splitPatch(null)).toEqual({ preamble: "", hunks: [] });
    expect(splitPatch("")).toEqual({ preamble: "", hunks: [] });
  });

  it("does not mistake a removed line beginning with dashes for a header", () => {
    // Inside a hunk, `--- x` is a removed line whose content starts with two dashes. The walk is
    // ordered — the preamble ends at the first `@@` — so the only thing that can start a hunk is a
    // hunk header, which is why the header is recognised by its shape and the preamble by position.
    const split = splitPatch("--- a\n+++ b\n@@ -1,2 +1,2 @@\n---- a table row\n+--- another\n");
    expect(split.hunks).toHaveLength(1);
    expect(split.hunks[0]!.text).toContain("---- a table row");
  });
});

describe("narrowPatch", () => {
  it("keeps the named hunks and the header, so what comes back is a real patch", () => {
    const split = splitPatch(PATCH);
    const narrowed = narrowPatch(split, new Set([2]));
    expect(narrowed).toBe(
      "--- a/src/server/health.ts\n+++ b/src/server/health.ts\n" +
        "@@ -96,2 +98,3 @@ function health() {\n" +
        "   return 200;\n+  if (draining) return 503;\n }\n",
    );
    // And it splits back into exactly the one hunk it holds, at the same place in the new file —
    // which is what makes a narrowed patch safe to hand to the renderer and to `patchTextLines`.
    const again = splitPatch(narrowed!);
    expect(again.hunks.map((hunk) => [hunk.from, hunk.to])).toEqual([[98, 100]]);
  });

  it("emits the hunks in the PATCH's order, whatever order the set was built in", () => {
    const split = splitPatch(PATCH);
    const narrowed = narrowPatch(split, new Set([2, 0]))!;
    expect(narrowed.indexOf("@@ -1,4")).toBeLessThan(narrowed.indexOf("@@ -96,2"));
  });

  it("answers NULL when nothing is kept, because an empty patch is not a small one", () => {
    // A caller handed `""` would draw a file box with no code in it and no note saying why.
    expect(narrowPatch(splitPatch(PATCH), new Set())).toBeNull();
    expect(narrowPatch(splitPatch(PATCH), new Set([9]))).toBeNull();
  });
});

describe("hunksTouching", () => {
  const hunks = splitPatch(PATCH).hunks;

  it("takes every hunk the range overlaps", () => {
    expect(hunksTouching(hunks, 21, 24)).toEqual(new Set([1]));
    expect(hunksTouching(hunks, 1, 100)).toEqual(new Set([0, 1, 2]));
    // Touching at ONE line counts: a range that ends exactly where a hunk begins is about that hunk.
    expect(hunksTouching(hunks, 5, 21)).toEqual(new Set([0, 1]));
  });

  it("answers NOTHING for a range no hunk holds", () => {
    // A model naming lines the file does not change. Its part then claims nothing and is dropped,
    // which leaves the file to the leftovers rather than drawing a heading over an empty box.
    expect(hunksTouching(hunks, 200, 300)).toEqual(new Set());
    expect(hunksTouching([], 1, 10)).toEqual(new Set());
  });

  it("reads a range written BACKWARDS as the same region", () => {
    // `[96, 40]` means what `[40, 96]` means. Refusing it would drop a part over a detail no reader
    // can see; `ReviewRange::normalize` in Rust refuses only a pair that cannot be a place at all.
    expect(hunksTouching(hunks, 24, 21)).toEqual(hunksTouching(hunks, 21, 24));
    expect(hunksTouching(hunks, 100, 1)).toEqual(new Set([0, 1, 2]));
  });
});

describe("HUNK_HEADER", () => {
  it("is the one spelling, and holds no lastIndex to carry between walks", () => {
    // No `g` flag: two walks `exec`ing the same regex must not resume where the other stopped. That
    // is what makes it safe for `gitlab-diff-comment.ts` and `splitPatch` to share this constant
    // rather than each keeping a copy.
    expect(HUNK_HEADER.global).toBe(false);
    expect(HUNK_HEADER.exec("@@ -1,4 +1,5 @@")?.[3]).toBe("1");
    expect(HUNK_HEADER.exec("@@ -1,4 +1,5 @@")?.[3]).toBe("1");
  });
});
