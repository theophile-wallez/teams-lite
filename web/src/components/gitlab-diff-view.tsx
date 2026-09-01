import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { CodeView, FileDiff, type CodeViewHandle } from "@pierre/diffs/react";
import {
  processFile,
  type ChangeTypes,
  type CodeView as CodeViewInstance,
  type CodeViewDiffItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
  type TokenEventBase,
} from "@pierre/diffs";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  activeDiffFeedFile,
  DIFF_FEED_METRICS,
  DIFF_THEMES,
  diffFeedVersions,
  diffFileNotice,
  diffFilePaths,
  diffFileState,
  diffTreeGitStatus,
  formatDiffStat,
  type DiffFeedTop,
  type DiffFeedVersion,
  type DiffLayout,
  type GitLabDiff,
  type GitLabDiffFile,
} from "~/lib/gitlab-diff";
import {
  diffAnnotationKey,
  DIFF_COMMENT_HINT,
  type DiffAnnotationCard,
  type DiffLineSelection,
  type PierreLineRange,
  type PierreSide,
} from "~/lib/gitlab-diff-comment";
import type { ResolvedTheme } from "~/lib/appearance";
import { FILE_TREE_ICONS } from "~/lib/tree-icons";

// The two halves of the diff page that need a renderer: the file TREE, and the FEED of every
// changed file. This module is the whole of this app's contact with `@pierre/trees` and
// `@pierre/diffs`, and it is reached only through `lazy(() => import(…))` from
// `gitlab-diff-page.tsx`.
//
// **The lazy boundary is load-bearing.** `@pierre/diffs` is built on Shiki, which resolves a
// TextMate grammar per language as a dynamic import — so the chunk behind this file is 728 KB
// of its own, plus one chunk per language a reader actually opens. It must never sit on the
// path of a chat: the emoji picker draws the same line for the same reason
// (`web/src/components/emoji-picker.tsx`), and every pure decision the page makes lives in
// `web/src/lib/gitlab-diff.ts` so it is testable and renderable without any of this.
//
// **The two halves are exported apart, and neither knows where the other is.** The PAGE owns
// the layout — a full-height column of files beside a full-height feed on a wide screen, one
// then the other on a phone — because that is a decision about the page and not about a
// renderer. A component here that wrapped both in a flex row would own a layout it cannot see
// the constraints of, which is exactly what it did while the diff was a panel.
//
// **The FEED is the vendor's own `CodeView`, and choosing it over a virtualizer of this app's
// was the whole design decision.** A review is read by scrolling, so every changed file is in
// one scroller — and the room a file needs cannot be known before that file is highlighted,
// which is what makes a hand-rolled virtual list wrong here: it would reserve a guessed height,
// mount the file, measure it, and correct the scroll position under the reader, once per file,
// for 149 files. `CodeView` was built for exactly this list: it reserves room from the line
// COUNTS its own parser already read, mounts only what the viewport can hold, pools the
// elements it unmounts, anchors the scroll while a measurement corrects a row above, and
// pre-warms the highlighter of a file somebody just jumped to (`primeHighlightCache`). What this
// app keeps is the meaning: which file the reader is AT ([[activeDiffFeedFile]]), and when an
// item has really changed ([[diffFeedVersions]]).
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

/** What this app adds to pierre's own file header, beside the file's name: WHICH file this is,
 *  what their parser cannot know, and why there is nothing under the header at all.
 *
 *  All three belong in the header rather than in a row of this app's own, because in a feed a row
 *  between two files would read as a file. `generated` is GitLab's `generated_file` and is never
 *  used to HIDE a file — a surprising change hides in one.
 *
 *  **It names the file for the same reason the pane does**, and it is the only place that can: the
 *  renderer's own item element carries no path, and these slots are rendered as light-DOM children
 *  OF that element — so this is what lets a test, a capture and a reader's own eye tell which of
 *  the feed's files a row of code belongs to. */
function FileHeaderNote(props: { file: GitLabDiffFile | undefined }) {
  const file = props.file;
  if (!file) return null;
  const notice = diffFileNotice(file);
  return (
    <span
      data-testid="gitlab-diff-file"
      data-path={file.path}
      data-change={file.change}
      data-state={diffFileState(file)}
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {file.generated && (
        <span
          data-testid="gitlab-diff-generated"
          data-path={file.path}
          className="rounded bg-element px-1.5 py-px text-[10px] text-text-faint"
        >
          generated
        </span>
      )}
      {notice && (
        <span
          data-testid="gitlab-diff-file-notice"
          data-path={file.path}
          data-state={diffFileState(file)}
          className="min-w-0 text-[11px] text-text-faint"
        >
          {notice}
        </span>
      )}
    </span>
  );
}

/** The hovered line, as pierre's gutter slot reports one.
 *
 *  The side is optional because the same slot serves a whole-FILE view, where a line has no
 *  side to be on. This feed holds only diffs, so that shape cannot really arrive — and a press
 *  on one is skipped rather than guessed at, because the side decides which of GitLab's two line
 *  numbers the comment is filed under. */
type FeedGutterGetter = () => { lineNumber: number; side?: PierreSide } | undefined;

/** A token as pierre's own press reports one.
 *
 *  The side is OPTIONAL for the same reason the gutter's line above has none: `onTokenClick` is one
 *  callback over two modes, and a whole-FILE view's token sits on no side — so the handler has to
 *  satisfy both overloads. This feed holds only diffs, so a token with no side cannot really arrive,
 *  and one is skipped rather than guessed at: the side decides which of GitLab's two line numbers
 *  the press was on. */
type FeedToken = TokenEventBase & { side?: PierreSide };

/** One card hanging under a line of a diff, addressed in the renderer's own vocabulary.
 *
 *  It is pierre's own `DiffLineAnnotation<T>` with this app's `T`: the side and the line say
 *  WHERE, and the metadata says WHAT — which the page's own slot then draws. */
export type DiffAnnotation = DiffLineAnnotation<DiffAnnotationCard>;

/** What the renderer hands back with a callback: the item it is about.
 *
 *  Narrowed to the one field this app reads — the item's id, which IS the file's path — because
 *  pierre's own context type is an overloaded pair (a file item and a diff item) and a callback
 *  has to satisfy both. */
type FeedItemContext = { item: { id: string } };

/** What the page can ASK the feed to do: show a file, or show one LINE of one.
 *
 *  It is a handle rather than a prop, and that is deliberate. A "which file to scroll to" prop
 *  re-asks on every mount of the effect that reads it — a resize, a remount, any change of the
 *  object — and an ask the renderer cannot carry out at once is HELD until it can, which spends
 *  the reader's next wheel notch on it (measured, on this seam). A press is an event, so it is
 *  spelled as one.
 *
 *  `showLine` is what an occurrences row presses. A file here runs to nine hundred lines, so
 *  bringing the FILE up for a reader who asked for line 512 leaves them to find it themselves —
 *  and the renderer publishes a line target of its own, so nothing about this is computed here. */
export type DiffFeedHandle = {
  showFile: (path: string) => void;
  showLine: (path: string, lineNumber: number, side: PierreSide) => void;
};

type DiffFeedProps = {
  diff: GitLabDiff;
  layout: DiffLayout;
  theme: ResolvedTheme;
  /** Which files can carry a comment, by path (`diffCommentableFiles`). A file that cannot is
   *  offered no control at all rather than one drawn dead — and an EMPTY set arms the gesture
   *  nowhere, which is a diff whose three commits this page never read. */
  commentable: Set<string>;
  /** The lines lit right now, and the file they are in. */
  selection: DiffLineSelection | null;
  /** The gesture is still going: the pointer is down, or a line number was just pressed. */
  onSelectionChange: (path: string, range: PierreLineRange | null) => void;
  /** The gesture ENDED on these lines, which is when a comment box may open under them. */
  onSelectionEnd: (path: string, range: PierreLineRange | null) => void;
  /** The cards hanging under a line, per file — the threads already there, and the one being
   *  written. */
  annotations: Map<string, DiffAnnotation[]>;
  renderAnnotation: (annotation: DiffAnnotation, path: string) => ReactNode;
  /** The file the reader is AT, whenever it changes — which is what the tree lights. */
  onActiveFile: (path: string) => void;
  /** The reader pressed a NAME in the code. The token is whatever Shiki made of the line, so what
   *  is worth searching for is the page's decision (`symbolIsSearchable`) and not this seam's. */
  onTokenPress: (path: string, token: string, lineNumber: number, side: PierreSide) => void;
  /** Which file the feed OPENS at — the one the reader was last at on this merge request. It is
   *  read ONCE, when the items are first there: from then on where the feed sits is the reader's
   *  own business, and a press comes through {@link DiffFeedHandle}. */
  openAt: string | null;
};

/** The changed files, one after another, in one scroller the renderer virtualizes.
 *
 *  The patches are COMPLETE — the backend writes the `diff --git` header GitLab never sends (see
 *  `gitlab_mr::unified_patch`) — so each item learns its file, its language and what happened to
 *  it from its own patch and needs nothing told to it.
 *
 *  **A file with NO patch is still in the feed.** A binary file, one GitLab collapsed: the tree
 *  lists it, so a feed that skipped it would make the tree lie about where the reader is — and
 *  scrolling would jump over a name that is in the list. It becomes an item with no hunks, which
 *  is exactly the shape pierre's own parser returns for a pure rename, and the page's header slot
 *  states why there is nothing under it.
 *
 *  **The COMMENT gesture is pierre's own, and that is why it is a gesture at all.** Its
 *  interaction manager starts a selection only from the line-NUMBER gutter and follows the
 *  pointer to another number, so a click is one line and a drag is a span — which is what
 *  GitLab's own diff does and what a reviewer already knows how to do. Nothing here reimplements
 *  it; what this app adds is the meaning of the answer (`lib/gitlab-diff-comment.ts`) and the
 *  card that hangs under the line (`gitlab-diff-comments.tsx`). Four things about the seam:
 *
 *    - **Every gesture names its FILE.** In a feed a line number means nothing on its own — line
 *      42 exists in most of these files — so the item's id travels with the selection, with the
 *      end of it, and with the gutter's own press. That is the shape pierre's
 *      `CodeViewLineSelection` takes too, for the same reason.
 *    - **The selection is CONTROLLED**: passing `selectedLines` at all is what turns pierre's
 *      own rendering of it off, so what is lit is this app's own state. The live gesture and the
 *      finished one arrive apart (`onLineSelectionChange` and `onLineSelectionEnd`) because they
 *      mean different things — the first lights lines, the second is the only one that may open a
 *      comment box.
 *    - **The gutter's own PLACEMENT is pierre's** (`enableGutterUtility`), and it is the half
 *      that makes the gesture discoverable: the control follows the hovered line, and on a touch
 *      screen — where there is no hover — a press on the gutter reveals it. The control itself is
 *      this app's, because its glyph has to be hugeicons' like every other in this app.
 *    - **Every callback is read through a ref.** They are handed to the renderer inside an
 *      options object it keeps, so a new closure per render would either be ignored or rebuild
 *      every mounted file. It is the rule `DiffFileTree` below already follows.
 */
export const DiffFeed = forwardRef<DiffFeedHandle, DiffFeedProps>(function DiffFeed(props, ref) {
  // The callbacks the renderer keeps. See the note about refs in the doc comment above.
  const onChange = useRef(props.onSelectionChange);
  onChange.current = props.onSelectionChange;
  const onCommit = useRef(props.onSelectionEnd);
  onCommit.current = props.onSelectionEnd;
  const onActiveFile = useRef(props.onActiveFile);
  onActiveFile.current = props.onActiveFile;
  const onTokenPress = useRef(props.onTokenPress);
  onTokenPress.current = props.onTokenPress;
  const draw = useRef(props.renderAnnotation);
  draw.current = props.renderAnnotation;

  const view = useRef<CodeViewHandle<DiffAnnotationCard> | null>(null);

  const items = useDiffFeedItems(props.diff, props.annotations);

  // The gutter's own control, and the header slot beside a file's name. Both are stable across
  // renders — the refs above carry the current handlers into them — so the slots pierre moves
  // between rows are not rebuilt every time the reader moves the pointer.
  const commentable = useRef(props.commentable);
  commentable.current = props.commentable;
  const renderGutter = useCallback(
    (getHoveredLine: FeedGutterGetter, item: { id: string }) =>
      // A file that cannot carry a comment is offered NO control, rather than one drawn dead: the
      // renderer arms the slot for the whole feed, and this is where one file's answer is given.
      commentable.current.has(item.id) ? (
        <GutterCommentButton
          getHoveredLine={getHoveredLine}
          onPick={(line) =>
            onCommit.current(item.id, {
              start: line.lineNumber,
              side: line.side,
              end: line.lineNumber,
              endSide: line.side,
            })
          }
        />
      ) : null,
    [],
  );
  const filesByPath = useMemo(() => {
    const byPath = new Map<string, GitLabDiffFile>();
    for (const file of props.diff.files) byPath.set(file.path, file);
    return byPath;
  }, [props.diff]);
  const headerFiles = useRef(filesByPath);
  headerFiles.current = filesByPath;
  const renderHeaderMetadata = useCallback(
    (item: { id: string }) => <FileHeaderNote file={headerFiles.current.get(item.id)} />,
    [],
  );
  const renderAnnotation = useCallback(
    (annotation: DiffAnnotation, item: { id: string }) => draw.current(annotation, item.id),
    [],
  );

  // Bring one file to the top. `instant` because the press already said where to be: a spring
  // across 149 files would be a second of scenery, and the reader asked to be somewhere else.
  //
  // The path is remembered as the file the reader ASKED for, which is what keeps a press honest at
  // the end of the feed, where no file can reach the top of the screen (`activeDiffFeedFile`).
  const asked = useRef<string | null>(null);
  const showFile = useCallback((path: string) => {
    asked.current = path;
    view.current?.scrollTo({ type: "item", id: path, align: "start", behavior: "instant" });
  }, []);
  // One line of one file, for an occurrences row.
  //
  // `start` rather than `center`, and that is a correctness rule rather than a preference.
  // `activeDiffFeedFile` answers "which file is the reader at" with the last file that begins at or
  // above the top of the viewport — so CENTRING a line near the beginning of a file leaves the
  // PREVIOUS file filling the top, and the feed's own scroll then reports that one and overwrites
  // the file the reader just asked for. Measured: pressing an occurrence in the second file left the
  // pane still naming the first. Aligning to the start puts the asked-for line at the top, so its
  // file began at or above the top and the tree, the pane and the code agree.
  //
  // It is also what a press on a file ROW already does, so a press in this page means one thing:
  // what you asked for goes to the top. What it costs is the context above the line, which is one
  // wheel notch away.
  const showLine = useCallback((path: string, lineNumber: number, side: PierreSide) => {
    asked.current = path;
    view.current?.scrollTo({
      type: "line",
      id: path,
      lineNumber,
      side,
      align: "start",
      behavior: "instant",
    });
  }, []);
  useImperativeHandle(ref, () => ({ showFile, showLine }), [showFile, showLine]);

  // Where the feed OPENS. Three things about it, and each was measured on this seam:
  //
  //   - the file is the one the page named at the FIRST render (`useRef` keeps that value), never
  //     the current one: `openAt` follows the reader from then on, so reading it later would open
  //     the feed at wherever it had already got to;
  //   - a feed already opens at its first file, so asking for THAT one asks for nothing — and a
  //     scroll that goes nowhere is not free, because the renderer holds a programmatic target
  //     until it carries it out and a wheel notch can be spent on it instead of on the scroll;
  //   - and it is asked for once the renderer has really DRAWN something (`onPostRender`, below),
  //     not when the items are handed over. A scroll asked for before the first paint is applied
  //     against a layout nothing has measured, and the correction that follows puts the reader
  //     back at the top — which is a press in the tree that looks like it did nothing.
  const openingFile = useRef(props.openAt);
  const firstFile = useRef<string | undefined>(undefined);
  firstFile.current = items[0]?.id;
  const opened = useRef(false);
  const openFeed = useCallback(() => {
    if (opened.current) return;
    opened.current = true;
    const wanted = openingFile.current;
    if (wanted && wanted !== firstFile.current) showFile(wanted);
  }, [showFile]);

  const options = useMemo(
    () => ({
      diffStyle: props.layout,
      theme: DIFF_THEMES,
      // The app's own appearance, never the OS's. See the module header.
      themeType: props.theme,
      // What a row and a header MEASURE, which is what the feed reserves room with before a file
      // is mounted. app.css owns those numbers — see `DIFF_FEED_METRICS`.
      itemMetrics: DIFF_FEED_METRICS,
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
      // pierre's own. It is off on a diff whose commits this page never read, so a reader is
      // never given a selection with nothing to do.
      enableLineSelection: props.commentable.size > 0,
      // The affordance that says the gesture EXISTS: pierre moves the gutter's own slot to the
      // hovered line — and to the pressed one on a touch screen, where there is no hover.
      enableGutterUtility: props.commentable.size > 0,
      // Where the gestures arrive, and the SPLIT between these two is what keeps a drag usable.
      // `onLineSelectionChange` is the live one — it lights the lines under a pointer that is
      // still moving, since a controlled selection draws nothing of its own — and
      // `onLineSelectionEnd` is the gesture ENDING, which is the only moment a comment box may
      // appear: a card drawn mid-drag inserts a row into the patch and moves the line numbers
      // out from under the reader's own pointer (measured — it cut a drag from line 3 to line 6
      // short at line 4).
      //
      // **`onLineSelected` is deliberately NOT the commit signal**, and neither is
      // `onSelectedLinesChange`. Both are what pierre calls whenever the selection is SET, the
      // app's own `selectedLines` prop included — the React wrapper writes that prop back into
      // the instance on every render, and every write announces itself. So the live highlight
      // this app draws would come back as "the reader finished here" a frame later, which is
      // exactly the mid-drag card above. The END of a pointer session is reported by nothing but
      // a real pointer session.
      //
      // `onGutterUtilityClick` is not here either: pierre refuses it beside a custom
      // `renderGutterUtility` ("use only one gutter utility API"), and the custom one is what
      // keeps the glyph this app's own. So the control's press is handled where the control is
      // (see `GutterCommentButton`), and pierre keeps the two gestures that are really its own.
      onLineSelectionChange: (range: SelectedLineRange | null, context: FeedItemContext) =>
        onChange.current(context.item.id, range),
      onLineSelectionEnd: (range: SelectedLineRange | null, context: FeedItemContext) =>
        onCommit.current(context.item.id, range),
      // A press on a NAME in the code, which is what opens the occurrences panel. Passing this
      // handler at all is what turns pierre's token transformer on, so the tokens become elements
      // a press can land on — and the gesture is entirely theirs: this app never asks which word is
      // under a pointer.
      //
      // It does not compete with the comment gesture. That one starts only from the line-NUMBER
      // gutter (see `enableLineSelection` above), so a press in the code is never the start of a
      // selection and a drag down the numbers never lands on a token.
      //
      // The FILE travels, because in a feed a line number names a line in most of the files at
      // once. A token with no side is a whole-FILE view's and cannot arrive here — this feed holds
      // only diffs — and is skipped rather than guessed at, for the reason the gutter's own control
      // skips one: the side decides which of GitLab's two numbers the line is.
      onTokenClick: (token: FeedToken, _event: MouseEvent, context: FeedItemContext) => {
        if (!token.side) return;
        onTokenPress.current(context.item.id, token.tokenText, token.lineNumber, token.side);
      },
      // The renderer has drawn a file: the feed can be put where it opens (see `openFeed`). It is
      // the one signal that says the layout is real rather than reserved.
      onPostRender: (_node: HTMLElement, _instance: unknown, phase: string) => {
        if (phase === "mount") openFeed();
      },
      // Pierre's own file header is KEPT, and this app draws none of its own over a file: it
      // already names the file, states the stat, shows both names of a renamed one, and it is
      // sticky inside the scroller — which in a feed is what says which file the code under the
      // reader's eye belongs to. Two headers naming one file three centimetres apart is what
      // the first capture of this page showed. `disableFileHeader: true` was the other way
      // round and it collapses the container to nothing, so this is the one that works.
      stickyHeaders: true,
    }),
    [props.layout, props.theme, props.commentable.size, openFeed],
  );

  // Which file the reader is at, on every scroll. The tops are the renderer's own measured
  // layout, so this follows a file whose real height was only learned once it was mounted.
  const onScroll = useCallback(
    (scrollTop: number, viewer: CodeViewInstance<DiffAnnotationCard>) => {
      const tops: DiffFeedTop[] = [];
      for (const item of items) {
        const top = viewer.getTopForItem(item.id);
        if (top != null) tops.push({ path: item.id, top });
      }
      const active = activeDiffFeedFile(
        tops,
        scrollTop,
        viewer.getHeight(),
        viewer.getScrollHeight(),
        asked.current,
      );
      if (active) onActiveFile.current(active);
    },
    [items],
  );

  return (
    // The sentinel is on a wrapper of this app's own, because the renderer's element is the
    // SCROLLER — it listens for `scroll` on the div it is handed — and the props it passes
    // through are the class and the style alone.
    <div data-testid="gitlab-diff-feed" className="flex h-full min-h-0 min-w-0 flex-col">
      {/* The generic is PINNED rather than inferred: this app's annotation metadata is a union
          of two cards, and inference from the first array element would settle on one of them
          and refuse the other. */}
      <CodeView<DiffAnnotationCard>
        ref={view}
        items={items}
        options={options}
        onScroll={onScroll}
        // Passing this at all is what makes the selection CONTROLLED — pierre stops drawing one
        // of its own — so these lines and the composer under them are one fact.
        selectedLines={
          props.selection ? { id: props.selection.path, range: props.selection.range } : null
        }
        renderAnnotation={renderAnnotation}
        // What the gutter's own control looks like. It is a plain button of this app's, drawn
        // into the slot pierre moves to the hovered line — so the glyph is hugeicons' like
        // every other in this app, and the placement is theirs.
        renderGutterUtility={props.commentable.size > 0 ? renderGutter : undefined}
        // What pierre's header cannot know: which file this item IS as far as this app is
        // concerned, GitLab's own `generated_file`, and why a file has no code under it. It goes
        // in the slot their header publishes for exactly this, rather than becoming a second
        // header.
        renderHeaderMetadata={renderHeaderMetadata}
        className="min-h-0 flex-1 overflow-auto"
      />
    </div>
  );
});

/**
 * The feed's items, and the SAME objects whenever nothing about a file changed.
 *
 * Identity is what the renderer decides on: an items array whose elements are the ones it already
 * holds is a no-op, while a rebuilt array reconciles the whole list — and a reconcile CAPTURES a
 * scroll anchor and re-applies it, so a rebuild for no reason pulls the page back under a reader
 * who was scrolling. A read of this diff arrives as fresh JSON several times a minute (a poll, a
 * write's own re-read), and almost every file in it is unchanged.
 *
 * So a file's item — its parsed patch included, which is the expensive half — is held until that
 * file or its cards really move ([[diffFeedVersions]]), and the ARRAY is held until at least one
 * item does.
 */
function useDiffFeedItems(
  diff: GitLabDiff,
  annotations: Map<string, DiffAnnotation[]>,
): CodeViewDiffItem<DiffAnnotationCard>[] {
  const versions = useRef<Map<string, DiffFeedVersion>>(new Map());
  const held = useRef<Map<string, CodeViewDiffItem<DiffAnnotationCard>>>(new Map());
  const list = useRef<CodeViewDiffItem<DiffAnnotationCard>[]>([]);
  return useMemo(() => {
    versions.current = diffFeedVersions(
      versions.current,
      diff.files.map((file) => ({
        file,
        cards: (annotations.get(file.path) ?? []).map(annotationSignature).join("|"),
      })),
    );
    const next = new Map<string, CodeViewDiffItem<DiffAnnotationCard>>();
    let moved = list.current.length !== diff.files.length;
    const rows = diff.files.map((file, index) => {
      const version = versions.current.get(file.path)!.version;
      const previous = held.current.get(file.path);
      // The version is what says whether anything about this file changed, so it is also what
      // says whether its patch has to be parsed again — see the note above.
      const item =
        previous && previous.version === version
          ? previous
          : {
              id: file.path,
              type: "diff" as const,
              fileDiff: diffFeedMetadata(file),
              annotations: annotations.get(file.path),
              version,
            };
      if (list.current[index] !== item) moved = true;
      next.set(file.path, item);
      return item;
    });
    held.current = next;
    if (moved) list.current = rows;
    return list.current;
  }, [diff, annotations]);
}

/** What pierre's parser calls a change, for the files it never parses.
 *
 *  Only a file with NO patch is mapped here: one with a patch is read out of the patch itself,
 *  where a renamed file that also changed says so. */
const FEED_CHANGE_TYPES: Record<GitLabDiffFile["change"], ChangeTypes> = {
  new: "new",
  deleted: "deleted",
  renamed: "rename-pure",
  changed: "change",
};

/** One file as the renderer's own data.
 *
 *  A file with a patch is PARSED — the header this app's backend wrote is what names it. A file
 *  with none is stated: its name, what happened to it, and no hunks, which is the same shape
 *  `processFile` itself returns for a pure rename. Nothing here invents a patch: writing one
 *  would be a second place in this app that spells git's own header. */
function diffFeedMetadata(file: GitLabDiffFile): FileDiffMetadata {
  if (file.patch) {
    const parsed = processFile(file.patch, { isGitDiff: true });
    if (parsed) return parsed;
  }
  return {
    name: file.path,
    ...(file.old_path ? { prevName: file.old_path } : {}),
    type: FEED_CHANGE_TYPES[file.change],
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  };
}

/** What one file's cards ARE, in one string — the whole of what a version bump is decided on.
 *
 *  Kept beside the renderer rather than inside `diffAnnotationKey` because the SIDE and the LINE
 *  are the renderer's half of an annotation and the card is this app's. */
function annotationSignature(annotation: DiffAnnotation): string {
  const card = annotation.metadata;
  return `${annotation.side}:${annotation.lineNumber}:${card ? diffAnnotationKey(card) : ""}`;
}

/** The control the gutter offers on the line under the pointer.
 *
 *  WHICH line that is comes from pierre — `getHoveredLine` is handed to the slot for exactly
 *  this — so the control never has to work out where it has been placed, in which file. It names
 *  one line: a span is the drag down the line numbers, and this is the press. */
function GutterCommentButton(props: {
  getHoveredLine: FeedGutterGetter;
  onPick: (line: { lineNumber: number; side: PierreSide }) => void;
}) {
  return (
    <button
      type="button"
      data-testid="gitlab-diff-comment-affordance"
      title={DIFF_COMMENT_HINT}
      aria-label={DIFF_COMMENT_HINT}
      onClick={() => {
        const line = props.getHoveredLine();
        // A line with no side is a whole-FILE view's, and this feed holds none — see
        // `FeedGutterGetter`. Never guessed at: the side decides which line GitLab files it under.
        if (line?.side) props.onPick({ lineNumber: line.lineNumber, side: line.side });
      }}
      className="grid size-4 place-items-center rounded bg-primary text-primary-foreground"
    >
      <HugeiconsIcon icon={PlusSignIcon} className="size-3" strokeWidth={2.4} />
    </button>
  );
}

/** No file header, hoisted so the callback is stable across renders — a new closure per render is
 *  handed to the instance and rebuilds it, which is the rule every callback at this seam follows. */
const noHeader = () => null;

/**
 * ONE file's patch, drawn IN FLOW at whatever height it needs — the code inside the reading's
 * document (see `gitlab-review-page.tsx`).
 *
 * It is `FileDiff` rather than `CodeView`, and the two are not interchangeable. `CodeView` is a
 * feed: it OWNS a scroller and virtualizes what is in it, which is exactly right for 149 files
 * read one after another and exactly wrong inside a scrolling document — a self-scrolling box in a
 * scrolling page is two scrollers competing for one wheel. `FileDiff` renders one file and takes
 * the height that file needs, which is what a paragraph of prose can sit above.
 *
 * **The metadata comes from the same `diffFeedMetadata` the feed uses**, so a file with no patch
 * draws the same shape here as there and its header note says why there is nothing under it.
 * Nothing about a patch is spelled twice.
 *
 * Three things it deliberately does NOT do, and each is a decision rather than an omission:
 *
 *   - **No comment gesture, and no press on a name.** Both are the Diffs page's, which is one
 *     press away on the strip: this surface is a read-through, and a document that collected
 *     comments in the margin would be a second place a review conversation lives.
 *   - **Always UNIFIED.** A split patch needs two columns of code, and here the code is already
 *     inside a column of prose set at a readable measure — so split would be two columns of eight
 *     characters, which is the reason `effectiveDiffLayout` refuses it on a phone.
 *   - **No sticky header.** The document's own theme heading is what sticks (its whole point is
 *     saying which theme the reader is inside), and two sticky bands stacking would leave the code
 *     reading out from under both.
 *   - **NO FILE HEADER AT ALL, which is the opposite of the feed's own rule and for that rule's own
 *     reason.** In the feed pierre's header is kept and this app draws none, because theirs is
 *     sticky inside the scroller and is what says whose code is under the reader's eye. Here the
 *     page has to draw one anyway: it carries the FOLD, and a folded patch mounts no renderer at all
 *     — so a control living in their header would vanish exactly when it is needed. Keeping both
 *     stated the path and the stat TWICE, three centimetres apart, which is the defect the first
 *     capture of the feed showed and this one showed again. `renderCustomHeader` is the published
 *     slot for replacing theirs, and returning nothing from it is what leaves the page's own row as
 *     the single name.
 */
export function DiffFilePatch(props: {
  file: GitLabDiffFile;
  theme: ResolvedTheme;
}) {
  const fileDiff = useMemo(() => diffFeedMetadata(props.file), [props.file]);
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      theme: DIFF_THEMES,
      // The app's own appearance, never the OS's — the mistake the module header states.
      themeType: props.theme,
      diffIndicators: "bars" as const,
      lineDiffType: "word" as const,
      hunkSeparators: "line-info" as const,
      expandUnchanged: true,
      overflow: "scroll" as const,
      // The two gestures the feed arms are off here. See the note above.
      enableLineSelection: false,
      enableGutterUtility: false,
      stickyHeaders: false,
    }),
    [props.theme],
  );
  // No test id here: `FileDiff` destructures the props it knows and drops the rest, so one passed
  // in would be silently absent from the DOM. The page names the box it puts this in.
  return <FileDiff fileDiff={fileDiff} options={options} renderCustomHeader={noHeader} />;
}

/** The changed files as a tree, tinted by what happened to each.
 *
 *  It fills the height its host gives it and scrolls itself — `h-full` rather than a fixed
 *  height, because on the diff page the host is a full-height column. The tree VIRTUALIZES its
 *  rows, so it measures its own box before drawing any: a box with only a `max-height`
 *  measures zero, which drew an empty column the width of a tree.
 *
 *  **A PRESS and a CHANGE OF SELECTION are two different things, and this component needs both.**
 *  `@pierre/trees` publishes exactly one callback — `onSelectionChange` — and its controller
 *  returns early when the selection it is handed matches the one it holds
 *  (`FileTreeController`: `if (!selectionChanged && !anchorChanged) return`). So a press on the row
 *  that is ALREADY current reports nothing at all, and no heuristic over that callback can recover
 *  it. That cost a reader the page: on a narrow screen the files and the patch are one column each
 *  and a press is also the NAVIGATION between them, so a diff of ONE file — which is always the
 *  current one — could not be opened at all. Pressing its row did nothing, for ever, with no way
 *  forward. (It is the same dead press at every width; only on a phone is it a trap.)
 *
 *  So the press is read from the DOM, through the tree's OWN row contract: its rows are
 *  `button[data-type="item"]` carrying `dataset.itemPath` and `dataset.itemType`, which is what its
 *  own hit-testing reads (`render/FileTreeView.js`). The listener sits on a wrapper of this app's
 *  and walks `composedPath()`, because the rows live in a shadow root and a `click` crosses it.
 *  Three things make that safe to rest on. A press this cannot resolve falls through to the
 *  selection-change path, which is exactly today's behaviour — so the failure mode of a vendor that
 *  renames those attributes is the bug above rather than something worse. `web/e2e/gitlab.spec.ts`
 *  presses the current row and holds the page to opening it, so a rename fails a test rather than
 *  stranding a reader. And the contract was ALREADY load-bearing here before this: `pickDiffFile`
 *  in `web/scripts/preview.ts` — which every diff capture and several specs drive the tree with —
 *  selects a row as `[data-item-path="…"]`. */
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

  // What the PAGE says the current file is, read at the moment a report arrives rather than
  // closed over — it is how a reflection is told from a press below.
  const current = useRef(props.selected);
  current.current = props.selected;

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
    // Lighting the current row is a UI REFLECTION; a reader pressing a row is a NAVIGATION — and
    // the tree reports both through this one callback, off a store subscription that can fire a
    // tick later. So the two are told apart by what the report SAYS, which needs no bookkeeping
    // and cannot be got wrong by a report arriving later than expected:
    //
    //   - a press selects exactly ONE row, so a report of any other size is a step of the
    //     reflection below (it deselects, then selects);
    //   - and a report naming the row the page ALREADY says is current is that reflection
    //     arriving. A press on that row changes nothing, and the tree reports nothing for it.
    //
    // Getting this wrong is not cosmetic. It made the page unreachable on a phone once — Back
    // showed the files, mounting the tree reflected the selection, the reflection came back as a
    // press, and the patch took the screen again in the same frame — and it threw a reader
    // scrolling the FEED back to the top of the diff every few files, because the row lighting
    // itself under them was read as a press.
    onSelectionChange: (selected) => {
      if (selected.length !== 1) return;
      const path = selected[0]!;
      if (path === current.current) return;
      // The press listener below already answered this one, in the same task. Without this the
      // pick would be made twice for every press on a row that is not already current — once from
      // the DOM and once from the selection it changed — which is one redundant instant scroll to
      // the file the feed is already being sent to.
      if (path === pressed.current) return;
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

  // The selection the PAGE decided, reflected into the tree. It is rarely the reader's own press:
  // it is the file at the top of the FEED, so it moves every time they scroll past a file — and
  // with nothing picked at all, `selectDiffFile` chooses the first file that has something to
  // read, and the row for it has to be the lit one.
  //
  // **Exactly ONE row is lit, so the old one is deselected first.** The item's own `select` ADDS
  // to the selection: without the deselect, a feed being scrolled left every file the reader had
  // passed lit, and the tree then reported a selection whose first path was the oldest of them —
  // which this component read as a press and answered by scrolling the feed back to that file. A
  // reader was thrown to the top of the diff every few files.
  useEffect(() => {
    if (!props.selected) return;
    const lit = model.getSelectedPaths();
    // Already the one lit row — nothing to reflect, and nothing that would come back as a change.
    if (lit.length === 1 && lit[0] === props.selected) return;
    for (const path of lit) if (path !== props.selected) model.getItem(path)?.deselect();
    model.getItem(props.selected)?.select();
    // And it is brought into view, because the tree is a column of its own with its own scroll:
    // a lit row the reader cannot see answers "where am I" for nobody. `focus: false` — the
    // keyboard belongs to whatever the reader is using, not to a row that lit itself.
    model.scrollToPath(props.selected, { focus: false });
  }, [model, props.selected]);

  // The last path a PRESS answered, cleared on the next task. It exists only so the selection this
  // press is about to change does not answer the same press a second time (see `onSelectionChange`).
  const pressed = useRef<string | null>(null);

  // A press on a row, read from the tree's own row contract — see the note in the doc comment
  // above for why this exists at all and why it is safe to rest on.
  const onClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    for (const node of event.nativeEvent.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.dataset.type !== "item") continue;
      // A FOLDER row is a fold, not a file — the same rule the selection path holds.
      if (node.dataset.itemType === "folder") return;
      const path = node.dataset.itemPath;
      // `statsRef` is the diff's own file list, so a row this app does not hold a file for is not
      // one it can show: that is the one check that makes this contract-independent.
      if (!path || !statsRef.current.has(path)) return;
      pressed.current = path;
      // Cleared on the next task rather than after a timeout: the selection change this press
      // causes is dispatched synchronously or on a microtask, and anything later than that is a
      // different press.
      queueMicrotask(() => {
        if (pressed.current === path) pressed.current = null;
      });
      onPick.current(path);
      return;
    }
  }, []);

  return (
    // The wrapper is what the press listener needs, and it takes the size the column gives it so
    // the tree below still measures a real box — a tree that measures zero draws no rows at all.
    <div className="h-full w-full" onClick={onClick}>
      <FileTree model={model} data-testid="gitlab-diff-tree" className="h-full w-full" />
    </div>
  );
}
