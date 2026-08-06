import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  DIFF_THEMES,
  diffFilePaths,
  diffTreeGitStatus,
  formatDiffStat,
  type DiffLayout,
  type GitLabDiff,
} from "~/lib/gitlab-diff";
import { DIFF_COMMENT_HINT, type DiffAnnotationCard } from "~/lib/gitlab-diff-comment";
import type { ResolvedTheme } from "~/lib/appearance";
import { FILE_TREE_ICONS } from "~/lib/tree-icons";

// The two halves of the diff page that need a renderer: the file TREE, and one file's PATCH.
// This module is the whole of this app's contact with `@pierre/trees` and `@pierre/diffs`, and
// it is reached only through `lazy(() => import(…))` from `gitlab-diff-page.tsx`.
//
// **The lazy boundary is load-bearing.** `@pierre/diffs` is built on Shiki, which resolves a
// TextMate grammar per language as a dynamic import — so the chunk behind this file is 728 KB
// of its own, plus one chunk per language a reader actually opens. It must never sit on the
// path of a chat: the emoji picker draws the same line for the same reason
// (`web/src/components/emoji-picker.tsx`), and every pure decision the page makes lives in
// `web/src/lib/gitlab-diff.ts` so it is testable and renderable without any of this.
//
// **The two halves are exported apart, and neither knows where the other is.** The PAGE owns
// the layout — a full-height column of files beside a full-height patch on a wide screen, one
// then the other on a phone — because that is a decision about the page and not about a
// renderer. A component here that wrapped both in a flex row would own a layout it cannot see
// the constraints of, which is exactly what it did while the diff was a panel.
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

/** The one thing this app adds to pierre's file header. Hoisted out of the component so the
 *  slot it is handed to is a stable function across renders. */
const renderGeneratedChip = () => (
  <span
    data-testid="gitlab-diff-generated"
    className="rounded bg-element px-1.5 py-px text-[10px] text-text-faint"
  >
    generated
  </span>
);

/** One card hanging under a line of a diff, addressed in the renderer's own vocabulary.
 *
 *  It is pierre's own `DiffLineAnnotation<T>` with this app's `T`: the side and the line say
 *  WHERE, and the metadata says WHAT — which the page's own slot then draws. */
export type DiffAnnotation = DiffLineAnnotation<DiffAnnotationCard>;

/** One file's patch, highlighted, filling whatever box the page gives it.
 *
 *  The patch is COMPLETE — the backend writes the `diff --git` header GitLab never sends (see
 *  `gitlab_mr::unified_patch`) — so the renderer learns the file, its language and what
 *  happened to it from the patch itself and needs nothing told to it.
 *
 *  **The COMMENT gesture is pierre's own, and that is why it is a gesture at all.** Its
 *  interaction manager starts a selection only from the line-NUMBER gutter and follows the
 *  pointer to another number, so a click is one line and a drag is a span — which is what
 *  GitLab's own diff does and what a reviewer already knows how to do. Nothing here reimplements
 *  it; what this app adds is the meaning of the answer (`lib/gitlab-diff-comment.ts`) and the
 *  card that hangs under the line (`gitlab-diff-comments.tsx`). Three things about the seam:
 *

 *    - **The selection is CONTROLLED**: passing `selectedLines` at all is what turns pierre's
 *      own rendering of it off, so what is lit is this app's own state. The live gesture and the
 *      finished one arrive apart (`onLineSelectionChange` and `onLineSelected`) because they mean
 *      different things — the first lights lines, the second is the only one that may open a
 *      comment box.
 *    - **The gutter's own PLACEMENT is pierre's** (`enableGutterUtility`), and it is the half
 *      that makes the gesture discoverable: the control follows the hovered line, and on a touch
 *      screen — where there is no hover — a press on the gutter reveals it. The control itself is
 *      this app's, because its glyph has to be hugeicons' like every other in this app.
 *    - **Every callback is read through a ref.** They are handed to the renderer inside an
 *      options object it keeps, so a new closure per render would either be ignored or force a
 *      re-render of the whole patch. It is the rule `DiffFileTree` below already follows.
 */
export function DiffFilePatch(props: {
  patch: string;
  layout: DiffLayout;
  theme: ResolvedTheme;
  /** GitLab's own `generated_file`. Drawn in pierre's header slot — never used to HIDE a
   *  file, because a generated file is where a surprising change hides. */
  generated: boolean;
  /** Whether a comment can be put on this file at all — a patch to point at, and the commits
   *  to place it against (`diffCommentsAvailable`). With `false` the gutter offers nothing and
   *  a line cannot be picked, rather than collecting a comment that has nowhere to go. */
  commentable: boolean;
  /** The lines lit right now — wherever the gesture has reached, or null. */
  selection: SelectedLineRange | null;
  /** The gesture is still going: the pointer is down, or a line number was just pressed. */
  onSelectionChange: (range: SelectedLineRange | null) => void;
  /** The gesture ENDED on these lines, which is when a comment box may open under them. */
  onSelectionEnd: (range: SelectedLineRange | null) => void;
  /** The lines that carry a card — the threads already there, and the one being written. */
  annotations: DiffAnnotation[];
  renderAnnotation: (annotation: DiffAnnotation) => ReactNode;
}) {
  // The callbacks the renderer keeps. See the note about refs in the doc comment above.
  const onChange = useRef(props.onSelectionChange);
  onChange.current = props.onSelectionChange;
  const onCommit = useRef(props.onSelectionEnd);
  onCommit.current = props.onSelectionEnd;

  // The gutter's own control. Stable across renders — the ref above is what carries the
  // current handler into it — so the slot pierre places at the hovered line is not rebuilt
  // every time the reader moves the pointer.
  const renderGutter = useCallback(
    (getHoveredLine: () => { lineNumber: number; side: "additions" | "deletions" } | undefined) => (
      <GutterCommentButton
        getHoveredLine={getHoveredLine}
        onPick={(line) =>
          onCommit.current({
            start: line.lineNumber,
            side: line.side,
            end: line.lineNumber,
            endSide: line.side,
          })
        }
      />
    ),
    [],
  );

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
      // A click on a line number, and a drag from one to another: the comment gesture, and
      // pierre's own. It is off on a file that cannot carry a comment, so a reader is never
      // given a selection with nothing to do.
      enableLineSelection: props.commentable,
      // The affordance that says the gesture EXISTS: pierre moves the gutter's own slot to the
      // hovered line — and to the pressed one on a touch screen, where there is no hover.
      enableGutterUtility: props.commentable,
      // Where the gestures arrive, and the SPLIT between these two is what keeps a drag usable.
      // `onLineSelectionChange` is the live one — it lights the lines under a pointer that is
      // still moving, since a controlled selection draws nothing of its own — and
      // `onLineSelectionEnd` is the gesture ENDING, which is the only moment a comment box may
      // appear: a card drawn mid-drag inserts a row into the patch and moves the line numbers
      // out from under the reader's own pointer (measured — it cut a drag from line 3 to line 6
      // short at line 4).
      //
      // **`onLineSelected` is deliberately NOT the commit signal.** It is what pierre calls
      // whenever the selection is SET, the app's own `selectedLines` prop included — the React
      // wrapper writes that prop back into the instance on every render, and every write
      // announces itself as a commit. So the live highlight this app draws would come back as
      // "the reader finished here" a frame later, which is exactly the mid-drag card above. The
      // END of a pointer session is reported by nothing but a real pointer session.
      //
      // `onGutterUtilityClick` is not here either: pierre refuses it beside a custom
      // `renderGutterUtility` ("use only one gutter utility API"), and the custom one is what
      // keeps the glyph this app's own. So the control's press is handled where the control is
      // (see `GutterCommentButton`), and pierre keeps the two gestures that are really its own.
      onLineSelectionChange: (range: SelectedLineRange | null) => onChange.current(range),
      onLineSelectionEnd: (range: SelectedLineRange | null) => onCommit.current(range),
      // Pierre's own file header is KEPT, and this app draws none of its own over a patch: it
      // already names the file, states the stat, shows both names of a renamed one, and it is
      // sticky inside the scroller. Two headers naming one file three centimetres apart is
      // what the first capture of this page showed. `disableFileHeader: true` was the other
      // way round and it collapses the container to nothing, so this is the one that works.
      stickyHeader: true,
    }),
    [props.layout, props.theme, props.commentable],
  );
  return (
    <div data-testid="gitlab-diff-patch" className="min-w-0">
      {/* The generic is PINNED rather than inferred: this app's annotation metadata is a
          union of two cards, and inference from the first array element would settle on one
          of them and refuse the other. */}
      <PatchDiff<DiffAnnotationCard>
        patch={props.patch}
        options={options}
        // Passing this at all is what makes the selection CONTROLLED — pierre stops drawing one
        // of its own — so these lines and the composer under them are one fact.
        selectedLines={props.selection}
        lineAnnotations={props.annotations}
        renderAnnotation={props.renderAnnotation}
        // What the gutter's own control looks like. It is a plain button of this app's, drawn
        // into the slot pierre moves to the hovered line — so the glyph is hugeicons' like
        // every other in this app, and the placement is theirs.
        renderGutterUtility={props.commentable ? renderGutter : undefined}
        // What pierre's header cannot know: GitLab's own `generated_file`. It goes in the slot
        // their header publishes for exactly this, rather than becoming a second header. It is
        // the REACT prop rather than an `options` key — the options object's own callback
        // returns a DOM node, and this app has React ones.
        renderHeaderMetadata={props.generated ? renderGeneratedChip : undefined}
      />
    </div>
  );
}

/** The control the gutter offers on the line under the pointer.
 *
 *  WHICH line that is comes from pierre — `getHoveredLine` is handed to the slot for exactly
 *  this — so the control never has to work out where it has been placed. It names one line:
 *  a span is the drag down the line numbers, and this is the press. */
function GutterCommentButton(props: {
  getHoveredLine: () => { lineNumber: number; side: "additions" | "deletions" } | undefined;
  onPick: (line: { lineNumber: number; side: "additions" | "deletions" }) => void;
}) {
  return (
    <button
      type="button"
      data-testid="gitlab-diff-comment-affordance"
      title={DIFF_COMMENT_HINT}
      aria-label={DIFF_COMMENT_HINT}
      onClick={() => {
        const line = props.getHoveredLine();
        if (line) props.onPick(line);
      }}
      className="grid size-4 place-items-center rounded bg-primary text-primary-foreground"
    >
      <HugeiconsIcon icon={PlusSignIcon} className="size-3" strokeWidth={2.4} />
    </button>
  );
}

/** The changed files as a tree, tinted by what happened to each.
 *
 *  It fills the height its host gives it and scrolls itself — `h-full` rather than a fixed
 *  height, because on the diff page the host is a full-height column. The tree VIRTUALIZES its
 *  rows, so it measures its own box before drawing any: a box with only a `max-height`
 *  measures zero, which drew an empty column the width of a tree. */
export function DiffFileTree(props: {
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

  // The one path this component selected ITSELF, waiting to be recognised when it comes back
  // out as a change. Lighting the current row is a UI reflection; a reader pressing a row is a
  // navigation — and pierre reports both through the same callback, off a store subscription
  // that can fire a tick later, so a synchronous "we are reflecting" flag would miss it.
  //
  // Without this the page could not be left on a narrow screen: Back showed the files, mounting
  // the tree reflected the selection, the reflection came back as a pick, and the patch took the
  // screen again in the same frame. It is consumed ONCE, so a reader really pressing the row of
  // the file already open is still a press.
  const reflected = useRef<string | null>(null);

  const { model } = useFileTree({
    paths,
    gitStatus,
    // A diff is a handful of directories: opening them all is what a reviewer would do
    // first, and a tree of closed folders hides the very thing the page is for.
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
      if (!path) return;
      // Our own reflection coming back — see `reflected`. Consumed once.
      if (path === reflected.current) {
        reflected.current = null;
        return;
      }
      // A DIRECTORY row is a fold, not a file: picking one must not clear the diff under it.
      if (statsRef.current.has(path)) onPick.current(path);
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

  // The selection the PAGE decided, reflected into the tree. It is not always the reader's own
  // press: with nothing picked, `selectDiffFile` chooses the first file that has something to
  // read, and the row for it has to be the lit one.
  useEffect(() => {
    if (!props.selected) return;
    // Already lit — nothing to reflect, and nothing that would come back as a change.
    if (model.getSelectedPaths().includes(props.selected)) return;
    reflected.current = props.selected;
    model.getItem(props.selected)?.select();
  }, [model, props.selected]);

  return <FileTree model={model} data-testid="gitlab-diff-tree" className="h-full w-full" />;
}
