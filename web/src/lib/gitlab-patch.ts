// A unified patch, cut into the HUNKS it is made of — and put back together holding only some of
// them.
//
// It exists because a changed FILE is not a unit of meaning. One file very often holds two
// unrelated changes: the handler that gained a draining state and, forty lines down, a rename
// somebody did on the way past. The AI reading groups the branch by what it DOES (§ AN AI READING
// OF THE DIFF), so a theme has to be able to claim PART of a file — and the only honest unit for
// that is the hunk, for three reasons:
//
//   - **A hunk is the diff's own answer to "a contiguous change".** git decided where it begins
//     and ends, from the real distance between the edits, so nothing here invents a boundary.
//   - **A patch narrowed to whole hunks is still a PATCH.** Every hunk carries its own `@@` header
//     with its own line counts, so a subset of them is valid input for the renderer, for
//     `patchTextLines`, and for anything else that reads one. Slicing a hunk at an arbitrary line
//     would leave a header whose counts lie — which `@pierre/diffs` and git would both read as a
//     corrupt patch.
//   - **The reader can act on it.** A part says "lines 96–140 of this file", which is a place they
//     can go and look at.
//
// Everything here is pure: no DOM, no network, no React, and nothing from `@pierre/diffs`. That is
// the split `gitlab-diff.ts` and `gitlab-diff-comment.ts` already hold, and for their reason — the
// renderer is a 728 KB lazy chunk and the rules that decide what a reader is shown have to be
// testable without loading it.

/**
 * A hunk header, and the ONE spelling of it in this app.
 *
 * It used to live in `gitlab-diff-comment.ts`, which imports it from here now. Two copies of this
 * regex is the hazard that file's own header names for its walk: a pattern that recognised a header
 * in one module and not the other would put a comment on one line while the reading drew another,
 * and neither would look wrong. It carries no `g` flag, so it holds no `lastIndex` and is safe to
 * `exec` from several walks at once.
 */
export const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One hunk of a patch: where it sits in the NEW file, and its own text. */
export type PatchHunk = {
  /** Its place in the patch, counted from zero — which is what a part CLAIMS, because two hunks
   *  of one file can cover the same new-file line only if the patch is corrupt. */
  index: number;
  /**
   * The first line of the NEW file this hunk covers, and the last.
   *
   * Taken from the header's own `+c,d` counts rather than by counting the body's lines: those
   * counts are what every diff tool trusts and what git writes, and re-deriving them would be a
   * second opinion about the same fact — the trap `patchTextLines` states for its own walk.
   *
   * A hunk that adds nothing to the new file (`+c,0`, a pure deletion) covers `[c, c]` rather
   * than an empty span. It really covers no new line at all, but a hunk no range can ever name
   * would fall out of every theme and into the leftovers for ever, which is worse than treating
   * it as the single point it sits at.
   */
  from: number;
  to: number;
  /** The hunk's own text, its `@@` header first, always newline-terminated. */
  text: string;
};

/** A patch taken apart: what stood before the first hunk, and the hunks. */
export type SplitPatch = {
  /**
   * Everything before the first `@@` — the git header this app's backend writes
   * (`gitlab_mr::unified_patch`), which is what NAMES the file to a parser.
   *
   * It is kept whole and re-emitted by {@link narrowPatch}, because a patch with no header is a
   * patch whose file has no name: `@pierre/diffs` would draw the code under nothing.
   */
  preamble: string;
  hunks: PatchHunk[];
};

/**
 * Cut one patch into its hunks.
 *
 * A patch with no `@@` at all — a binary marker, a pure rename's empty diff — comes back with no
 * hunks and its whole text as the preamble, which is the honest answer: there is nothing in it to
 * split.
 */
export function splitPatch(patch: string | null | undefined): SplitPatch {
  if (!patch) return { preamble: "", hunks: [] };
  const rows = patch.split("\n");
  // A patch ends with a newline, so the split leaves one empty string behind it. That is the
  // terminator rather than a line — the trap `patchTextLines` states for its own walk, and here it
  // would put a blank row at the foot of the last hunk on every round trip.
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();

  const preamble: string[] = [];
  const hunks: PatchHunk[] = [];
  let current: string[] | null = null;
  let from = 0;
  let to = 0;

  const close = () => {
    if (!current) return;
    hunks.push({ index: hunks.length, from, to, text: `${current.join("\n")}\n` });
    current = null;
  };

  for (const raw of rows) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      close();
      const start = Number(header[3]);
      // An absent count means one line, which is git's own shorthand.
      const count = header[4] === undefined ? 1 : Number(header[4]);
      from = start;
      // `max` is what gives a pure deletion the single point it sits at — see `PatchHunk.to`.
      to = Math.max(start, start + count - 1);
      current = [raw];
      continue;
    }
    if (current) current.push(raw);
    else preamble.push(raw);
  }
  close();

  return {
    preamble: preamble.length > 0 ? `${preamble.join("\n")}\n` : "",
    hunks,
  };
}

/**
 * The patch again, holding only the named hunks.
 *
 * `null` when nothing is kept, because an empty patch is not a small patch: a caller handed one
 * would draw a file box with no code in it and no note saying why. The preamble travels whatever is
 * kept, so what comes back names its file.
 *
 * The hunks are emitted in the PATCH's own order rather than the set's, so a part reads the way the
 * file does however its indices were collected.
 */
export function narrowPatch(split: SplitPatch, keep: ReadonlySet<number>): string | null {
  const kept = split.hunks.filter((hunk) => keep.has(hunk.index));
  if (kept.length === 0) return null;
  return split.preamble + kept.map((hunk) => hunk.text).join("");
}

/**
 * The hunks that overlap a range of NEW-file lines.
 *
 * This is how a range a MODEL named becomes something the page can draw. It is deliberately
 * generous — a hunk that touches the range at all is in — because the model is naming a region it
 * read in a `@@` header and the reader's question is "which changes are this theme's", not "which
 * exact lines". A range that touches NO hunk answers nothing, which is what leaves its part
 * unclaimed and its file in the leftovers rather than drawing a heading over an empty box.
 *
 * The ends are inclusive and may arrive in either order — a model writing `[96, 40]` meant the same
 * region — so they are put in reading order here rather than refused. That is the one thing this
 * normalises: `gitlab_review::ReviewRange` refuses a range whose numbers cannot be a place at all
 * (a zero, a negative), and a swapped pair is a place.
 */
export function hunksTouching(hunks: PatchHunk[], from: number, to: number): Set<number> {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const out = new Set<number>();
  for (const hunk of hunks) {
    if (hunk.from <= high && hunk.to >= low) out.add(hunk.index);
  }
  return out;
}
