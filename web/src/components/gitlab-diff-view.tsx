import { useEffect, useMemo, useRef } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  DIFF_THEMES,
  diffFilePaths,
  diffTreeGitStatus,
  formatDiffStat,
  type DiffLayout,
  type GitLabDiff,
  type GitLabDiffFile,
} from "~/lib/gitlab-diff";
import type { ResolvedTheme } from "~/lib/appearance";
import { FILE_TREE_ICONS } from "~/lib/tree-icons";

// The two halves of the Changes section that need a renderer: the file TREE, and one file's
// DIFF. This module is the whole of this app's contact with `@pierre/trees` and
// `@pierre/diffs`, and it is reached only through `lazy(() => import(…))` from
// `gitlab-changes.tsx`.
//
// **The lazy boundary is load-bearing.** `@pierre/diffs` is built on Shiki, which resolves a
// TextMate grammar per language as a dynamic import — so the chunk behind this file is 728 KB
// of its own, plus one chunk per language a reader actually opens. It must never sit on the
// path of a chat: the emoji picker draws the same line for the same reason
// (`web/src/components/emoji-picker.tsx`), and every pure decision the section makes lives in
// `web/src/lib/gitlab-diff.ts` so it is testable and renderable without any of this.
//
// Four things about the pair are worth knowing before touching either:
//
//   - **Both render into a SHADOW ROOT**, through a custom element of their own
//     (`diffs-container`, `file-tree-container`). So their internals cannot be styled from
//     the app's stylesheet and are not meant to be: each publishes a `--diffs-*` /
//     `--trees-*` custom property per colour, and `web/src/styles/app.css` maps the ones this
//     app cares about onto its own tokens. That is the vendor boundary, and it is the same
//     choice made for magicui's `ShineBorder`: keep the vendor's file, own the seam.
//   - **The theme is passed EXPLICITLY, never sniffed.** Both packages resolve `light-dark()`
//     from the used `color-scheme`, which follows the OS rather than this app's own
//     appearance setting — so a reader whose OS is dark and whose app is light would get a
//     black diff in a white page. `themeType` carries the app's own resolved theme to the
//     highlighter, and app.css pins `color-scheme` on both hosts to match. It is the mistake
//     the update button's orb already made once (§ Updating the app from inside it).
//   - **The GLYPHS are this app's own**, injected into the tree's shadow root as a sprite (see
//     `web/src/lib/tree-icons.ts`). Pierre ships a coloured file-type icon pack, and it is a
//     second icon set — a different grid at a different weight, three centimetres from this
//     app's own tab strip, which is what § Project shape bans. What stays theirs is the git
//     status TINT per row, because that is a colour vocabulary rather than an icon set.
//   - **The tree model is created ONCE** (`useFileTree` holds it in `useState`), so a new diff
//     is a mutation of it rather than a new tree — which is what keeps the reader's folds and
//     their scroll position across the expanded read.

/** The tree of changed files, and the file the reader picked out of it. */
export default function GitLabDiffView(props: {
  diff: GitLabDiff;
  file: GitLabDiffFile | null;
  layout: DiffLayout;
  theme: ResolvedTheme;
  onPick: (path: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start">
      <DiffFileTree
        diff={props.diff}
        selected={props.file?.path ?? null}
        onPick={props.onPick}
      />
      <div className="min-w-0 flex-1">
        {props.file?.patch ? (
          <FilePatch patch={props.file.patch} layout={props.layout} theme={props.theme} />
        ) : null}
      </div>
    </div>
  );
}

/** One file's patch, highlighted.
 *
 *  The patch is COMPLETE — the backend writes the `diff --git` header GitLab never sends (see
 *  `gitlab_mr::unified_patch`) — so the renderer learns the file, its language and what
 *  happened to it from the patch itself and needs nothing told to it. */
function FilePatch(props: { patch: string; layout: DiffLayout; theme: ResolvedTheme }) {
  const options = useMemo(
    () => ({
      diffStyle: props.layout,
      theme: DIFF_THEMES,
      // The app's own appearance, never the OS's. See the module header.
      themeType: props.theme,
      // Bars rather than `+`/`-` glyphs: the gutter already carries the line numbers, and a
      // column of signs beside a column of numbers is two things saying one thing.
      diffIndicators: "bars" as const,
      // Which WORDS changed inside a line, not only which lines. A review of a one-line
      // change is otherwise a whole line marked as replaced by a whole line.
      lineDiffType: "word" as const,
      // A hunk separator that states the lines it skipped, and skipped context the reader can
      // open — a diff whose gaps say nothing is one you cannot check the surroundings of.
      hunkSeparators: "line-info" as const,
      expandUnchanged: true,
      // Long lines SCROLL rather than wrap: a wrapped line breaks the alignment the split
      // layout is for, and this app is read on a phone where nearly every line would wrap.
      overflow: "scroll" as const,
      enableLineSelection: true,
      stickyHeader: true,
    }),
    [props.layout, props.theme],
  );
  return (
    <div data-testid="gitlab-diff-patch" className="min-w-0 overflow-hidden rounded-xl">
      <PatchDiff patch={props.patch} options={options} />
    </div>
  );
}

/** The changed files as a tree, tinted by what happened to each.
 *
 *  Bounded and scrolling: it sits inside a page that already scrolls, and a 149-file merge
 *  request would otherwise push the diff below the fold before a reader could read a line of
 *  it. That is the rule the agent transcript already follows. */
function DiffFileTree(props: {
  diff: GitLabDiff;
  selected: string | null;
  onPick: (path: string) => void;
}) {
  const paths = useMemo(() => diffFilePaths(props.diff), [props.diff]);
  const gitStatus = useMemo(() => diffTreeGitStatus(props.diff), [props.diff]);
  // The stat per path, for the row decoration. Read through a ref because the decoration
  // callback is given to the model ONCE, at construction.
  const stats = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const file of props.diff.files) byPath.set(file.path, formatDiffStat(file));
    return byPath;
  }, [props.diff]);

  // Both callbacks are handed to the model at construction and never replaced, so they read
  // the current props out of refs. Without this the tree would call the first render's
  // `onPick` for ever — and pick a file out of the first diff it was given.
  const onPick = useRef(props.onPick);
  onPick.current = props.onPick;
  const statsRef = useRef(stats);
  statsRef.current = stats;

  const { model } = useFileTree({
    paths,
    gitStatus,
    // A diff is a handful of directories: opening them all is what a reviewer would do
    // first, and a tree of closed folders hides the very thing the section is for.
    initialExpansion: "open",
    // `src/main/java/com/acme` as one row rather than four empty ones. A diff's tree is deep
    // and narrow, and the empty levels are the part nobody reads.
    flattenEmptyDirectories: true,
    // The app's OWN glyphs, through the seam pierre offers for them — see
    // `web/src/lib/tree-icons.ts`. There is one icon library in this app.
    icons: FILE_TREE_ICONS,
    search: false,
    // Nothing here renames, moves or deletes a file: this is a picture of a diff, and the
    // tree's editing affordances would offer actions that write to nothing.
    dragAndDrop: false,
    renaming: false,
    onSelectionChange: (selected) => {
      const path = selected[0];
      // A DIRECTORY row is a fold, not a file: picking one must not clear the diff under it.
      if (path && statsRef.current.has(path)) onPick.current(path);
    },
    renderRowDecoration: ({ item }) => {
      if (item.kind !== "file") return null;
      const stat = statsRef.current.get(item.path);
      return stat ? { text: stat } : null;
    },
  });

  // A NEW diff — the expanded read, or another merge request — is a mutation of the one model
  // rather than a new tree, so the reader's folds and their scroll position survive it.
  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
  }, [model, paths, gitStatus]);

  // The selection the SECTION decided, reflected into the tree. It is not always the reader's
  // own click: with nothing picked, `selectDiffFile` chooses the first file that has something
  // to read, and the row for it has to be the lit one.
  useEffect(() => {
    if (!props.selected) return;
    model.getItem(props.selected)?.select();
  }, [model, props.selected]);

  return (
    <FileTree
      model={model}
      data-testid="gitlab-diff-tree"
      // An explicit HEIGHT rather than a max: the tree virtualizes its rows, so it measures
      // its own box before it draws any — and a box with only a `max-height` measures zero,
      // which draws an empty column the width of a tree. The height is what bounds it, and
      // `overflow-auto` is what makes a 149-file merge request scroll inside it.
      className="h-48 w-full shrink-0 overflow-auto rounded-xl md:h-[30rem] md:w-64"
    />
  );
}
