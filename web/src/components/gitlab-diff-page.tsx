import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  ChevronLeftIcon,
  LayoutThreeRowIcon,
  LayoutTwoColumnIcon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import {
  DIFF_CODE_MIN_WIDTH,
  diffColumnsAreResizable,
  diffPageColumns,
  diffSummary,
  diffTruncationNotice,
  effectiveDiffLayout,
  expandDiffHint,
  FILES_COLUMN_MIN_WIDTH,
  resolveDiffColumnWidths,
  selectDiffFile,
  SPLIT_MIN_WIDTH,
  SYMBOLS_PANEL_MIN_WIDTH,
  type DiffColumn,
  type DiffLayout,
} from "~/lib/gitlab-diff";
import { symbolOccurrences, symbolSelection } from "~/lib/gitlab-diff-symbols";
import { reviewCanBeAsked, type DiffView } from "~/lib/gitlab-review";
import {
  diffCommentAnchor,
  diffCommentableFiles,
  diffThreadsFor,
} from "~/lib/gitlab-diff-comment";
import { mergeRequestPagePanel } from "~/lib/gitlab-mr-pages";
import type { DiffAnnotation, DiffFeedHandle } from "./gitlab-diff-view";
import { cn } from "~/lib/utils";
import { ColumnSplitter } from "./column-splitter";
import { useAppState, useController } from "./controller-context";
import { DiffLineComposer, DiffLineThread } from "./gitlab-diff-comments";
import { DiffSymbolsPanel } from "./gitlab-diff-symbols";
import { DiffReviewView } from "./gitlab-review-view";
import { GitLabLogo } from "./gitlab-logo";
import { MergeRequestPageStrip } from "./gitlab-mr-pages";
import { FadeArc } from "./loading-ui/fade-arc";
import { TrackerProjectProvider } from "./tracker-refs-context";

/** The custom properties the two side columns take their width from.
 *
 *  They are declared on the row that holds both columns and written by the splitters during a drag,
 *  which is what keeps a resize off React's path entirely (see `column-splitter.tsx`). The names are
 *  shared between the host and the handle, so they are spelled once, here. */
const FILES_WIDTH_VAR = "--diff-files-width";
const SYMBOLS_WIDTH_VAR = "--diff-symbols-width";

// The DIFF PAGE: the whole screen, the changed files down the left, and every one of them read
// on the right as one FEED. It is its own route (`/mr/<id>/diff` — see
// routes/_app.mr.$mergeRequestId.diff.tsx), and the shell draws it over the app's own sidebar as
// well as its pane.
//
// **It is a page rather than a panel, and that is the whole design.** The diff used to be a
// section inside the merge request's scrolling article, which is the wrong shape for the one
// thing it is for: reading code is somewhere a reviewer STAYS, and a 149-file tree beside a
// 900-line patch has no room to be either inside a column that also holds a description, a
// pipeline and a conversation. Three things follow from the URL, and none of them is available
// to a piece of component state: it survives a reload, it can be sent to a colleague, and the
// browser's own Back leaves it.
//
// **A review is read by SCROLLING, and the tree says where the reader is.** The right column
// holds every changed file one after another — the shape GitLab's own diff page has — because a
// reviewer's question is "what does this branch do", which is answered by reading the files in
// order rather than by pressing a row for each. The two directions are what make it a pair
// rather than two lists: the row of the file at the top of the feed is LIT
// (`activeDiffFeedFile`, over the renderer's own measured layout), and a press on a row brings
// that file to the top at once. Nothing is loaded per press — the whole diff is already read
// (see § The DIFF is a PAGE), so the press is a scroll and the renderer holds the room for what
// it has not highlighted yet.
//
// Seven rules hold the surface, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **Each column scrolls ITSELF, and the page does not scroll at all.** The header stays,
//     the tree keeps its place while the feed is read, and a file picked after ten minutes of
//     scrolling does not put the reader back at the top of a page. That is what the height
//     chain is for: `h-full` and `min-h-0` down both columns, never a page that grows.
//   - **A narrow screen is one column at a time** (`diffPageColumns`): the files, then the feed
//     — the list-then-detail shape every other surface in this app takes below `md`, with the
//     header's own Back between them. A tree beside a patch at 390 px is neither.
//   - **The renderer is a LAZY chunk.** Shiki carries a grammar per language, so
//     `gitlab-diff-view.tsx` is reached only through `lazy(() => import(…))` — and every
//     decision this page makes is pure and lives in `lib/gitlab-diff.ts`, so a diff with
//     nothing to render says so without loading a megabyte to say it.
//   - **The header names the merge request it belongs to.** A full-screen surface with no
//     sidebar has nothing else to say where the reader is, and the reference is what a review
//     is discussed by.
//   - **What GitLab withheld is COUNTED, and the way out is offered once** (`expandDiffHint`),
//     in the FILES column, because it is a fact about that list.
//   - **A diff that cannot be read says so and offers GitLab's own**, which is the one thing
//     left: this page has no other content to fall back on.
//   - **The PANE states which file the reader is at** (`data-path`), which is now the file the
//     feed is scrolled to rather than the only one drawn. One place to read "what is on screen"
//     from — the sentinel discipline the composer already follows for its conversation.

// The tree and the feed: the only two things here that need a renderer, and the only two
// imports of the chunk that carries Shiki. Two `lazy` calls over ONE module is deliberate — the
// bundler memoizes `import()`, so the second resolves out of the module registry rather than
// asking for the chunk twice, and each column gets to suspend on its own.
const DiffFileTree = lazy(() =>
  import("./gitlab-diff-view").then((m) => ({ default: m.DiffFileTree })),
);
const DiffFeed = lazy(() => import("./gitlab-diff-view").then((m) => ({ default: m.DiffFeed })));

/** Everything the page reads out of the store, in one place. */
function useDiffState() {
  return {
    detail: useAppState((s) => s.gitlabDetail),
    diff: useAppState((s) => s.gitlabDiff),
    loading: useAppState((s) => s.gitlabDiffLoading),
    error: useAppState((s) => s.gitlabDiffError),
    path: useAppState((s) => s.gitlabDiffPath),
    layout: useAppState((s) => s.gitlabDiffLayout),
    theme: useAppState((s) => s.resolvedTheme),
    /** The comments on the merge request, which is where the threads on this file come from.
     *  They are read with the page, so there is one answer about a conversation in this app. */
    notes: useAppState((s) => s.gitlabNotes),
    /** The lines lit by the gesture in flight, and the lines a comment is being written
     *  about. Two fields, because the box opens when the gesture ENDS (see the store). */
    selection: useAppState((s) => s.gitlabDiffSelection),
    comment: useAppState((s) => s.gitlabDiffComment),
    /** The name the reader pressed in the code, and how wide they have dragged the two side
     *  columns. */
    symbol: useAppState((s) => s.gitlabDiffSymbol),
    /** The AI reading of this diff, and which view of the diff the reader is in. */
    review: useAppState((s) => s.gitlabReview),
    reviewBusy: useAppState((s) => s.gitlabReviewBusy),
    reviewError: useAppState((s) => s.gitlabReviewError),
    view: useAppState((s) => s.gitlabDiffView),
    filesWidth: useAppState((s) => s.gitlabDiffFilesWidth),
    symbolsWidth: useAppState((s) => s.gitlabDiffSymbolsWidth),
  };
}

export function GitLabDiffPage(props: { onBack: () => void }) {
  const {
    detail,
    diff,
    loading,
    error,
    path,
    layout,
    theme,
    notes,
    selection,
    comment,
    symbol,
    filesWidth,
    symbolsWidth,
    review,
    reviewBusy,
    reviewError,
    view,
  } = useDiffState();
  const controller = useController();

  const file = useMemo(() => selectDiffFile(diff, path), [diff, path]);
  const width = useViewportWidth();
  // Which column the reader is IN on a narrow screen. The page opens on the files, because
  // that is the question a diff asks first — which of these do I want to read?
  const [column, setColumn] = useState<DiffColumn>("files");
  const columns = diffPageColumns(width, column);
  const effective = effectiveDiffLayout(layout, width);
  const expand = expandDiffHint(diff);

  // What the reader pressed in the code, and where else it stands. `null` for no press and for a
  // press on something that is not a name, so the panel is drawn exactly when it has an answer.
  const search = useMemo(() => symbolOccurrences(diff, symbol?.name ?? null), [diff, symbol?.name]);
  // The panel is only ever open beside the CODE, so it is not drawn while the reader is in the
  // files column of a narrow screen — and never on a narrow screen at all, where it would be a
  // third page competing with the two the page already has.
  const symbolsOpen = !!search && !columns.narrow;
  const resizable = diffColumnsAreResizable(width);
  // Both side columns' widths at once, because they are not independent: the code between them
  // keeps its own minimum, so on a narrow-ish desktop something has to give (see
  // `resolveDiffColumnWidths`).
  const widths = useMemo(
    () =>
      resolveDiffColumnWidths({
        viewport: width,
        files: filesWidth,
        symbols: symbolsWidth,
        symbolsOpen,
      }),
    [width, filesWidth, symbolsWidth, symbolsOpen],
  );
  // The element the two widths are declared on, and the one the splitters write to.
  const columnHost = useRef<HTMLDivElement | null>(null);

  // What hangs under a line, per file: every thread already there, and the composer for the
  // comment being written. Per FILE because the feed holds them all, and one list per file
  // because the renderer takes one per item — with the composer LAST, so a reader who picks the
  // line a thread is already on gets the box under it rather than above it.
  const commentable = useMemo(
    () => diffCommentableFiles(diff?.files, detail?.diff_refs),
    [diff, detail?.diff_refs],
  );
  const annotations = useMemo(() => {
    const byPath = new Map<string, DiffAnnotation[]>();
    for (const file of diff?.files ?? []) {
      const rows: DiffAnnotation[] = diffThreadsFor(file, notes).map((thread) => ({
        side: thread.side,
        lineNumber: thread.lineNumber,
        metadata: { kind: "thread", thread },
      }));
      if (comment && comment.path === file.path) {
        rows.push({
          ...diffCommentAnchor(comment),
          metadata: { kind: "composer", target: comment },
        });
      }
      if (rows.length > 0) byPath.set(file.path, rows);
    }
    return byPath;
  }, [diff, notes, comment]);

  // A press in the tree: the row is lit at once, and the feed is TOLD to bring that file up.
  // Telling it is an event rather than a piece of state — see `DiffFeedHandle`. On a narrow screen
  // the feed is not mounted while the reader is in the files column, so there is nothing to tell:
  // it opens at the file this press just made the current one (`openAt` below).
  const feed = useRef<DiffFeedHandle | null>(null);
  const showFile = useCallback(
    (picked: string) => {
      controller.setGitLabDiffFile(picked);
      feed.current?.showFile(picked);
    },
    [controller],
  );
  // The file the reader scrolled to. It moves the tree's own highlight and the pane's sentinel,
  // and it is remembered per merge request — so coming back opens where they stopped reading.
  const noteActiveFile = useCallback(
    (active: string) => controller.setGitLabDiffFile(active),
    [controller],
  );

  return (
    // A bare `!42` in a comment on a line of this diff means a merge request of THIS project,
    // exactly as it does on the merge request's own page (see lib/tracker-ref.ts).
    <TrackerProjectProvider project={detail?.project_path}>
    <section
      data-testid="gitlab-diff-page"
      data-column={columns.narrow ? column : "both"}
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-4">
        {/* Back leaves the PATCH for the files on a narrow screen, and the whole page for the
            merge request everywhere else. One control, because "back" means one thing to a
            reader: out of where I am. */}
        <button
          type="button"
          data-testid="gitlab-diff-back"
          aria-label={
            columns.narrow && column === "patch" ? "Back to the changed files" : "Back to the merge request"
          }
          onClick={() => {
            if (columns.narrow && column === "patch") setColumn("files");
            else props.onBack();
          }}
          className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
        </button>
        <GitLabLogo className="size-5 shrink-0" title="GitLab" />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Which merge request this is the diff OF. The page has no sidebar, so this line is
              the only thing that says where the reader is. */}
          <h1 data-testid="gitlab-diff-title" className="truncate text-sm font-medium text-foreground">
            {detail ? detail.title : "Changes"}
          </h1>
          <p className="truncate text-[11px] text-text-faint">
            {detail ? `${detail.reference} · ` : ""}
            <span data-testid="gitlab-diff-summary">{diff ? diffSummary(diff) : "Reading the changes…"}</span>
          </p>
        </div>
        {/* Which VIEW of the diff: the feed of files, or the AI reading's own themes. It is a
            control rather than a route because the two are one read drawn two ways — the shape the
            Pipelines page already has for its graph and its job list. Drawn only where there is a
            diff to read either way. */}
        {reviewCanBeAsked(diff) && (
          <ViewToggle view={view} onPick={(next) => controller.setGitLabDiffView(next)} />
        )}
        {/* The layout toggle, where it applies. Split needs two columns of code — on a phone it
            cannot, so it is not drawn at all rather than drawn dead. And it says nothing about the
            THEMES view, which draws no code: a control that changes nothing reads as a bug. */}
        {view === "files" && width >= SPLIT_MIN_WIDTH && diff && diff.files.length > 0 && (
          <LayoutToggle layout={layout} onPick={(next) => controller.setGitLabDiffLayout(next)} />
        )}
        {detail?.web_url && (
          <a
            href={`${detail.web_url}/diffs`}
            target="_blank"
            rel="noreferrer"
            data-testid="gitlab-diff-link"
            title="Open the changes in GitLab"
            aria-label="Open the changes in GitLab"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Link01Icon} className="size-4" strokeWidth={1.6} />
          </a>
        )}
      </header>

      {/* The same sub-header the merge request's own pane carries, so the four pages are
          reachable from all four rather than from three (see `gitlab-mr-pages.tsx`). Back
          still leaves the page; this is how a reader goes straight to the Commits of what they
          are reading. It takes THIS header's own padding, so the strip and the title above it
          start on one line — this page is narrower in its gutters than the pane is. */}
      <MergeRequestPageStrip current="diffs" className="md:px-4" />

      {/* Whatever this page can draw of the diff is the PANEL the strip's Diffs tab controls,
          so the id sits on the one element every branch below hangs off (see
          `mergeRequestPagePanel`). */}
      <div {...mergeRequestPagePanel("diffs")} className="flex min-h-0 flex-1 flex-col">
        {error && !diff ? (
          <DiffFailure error={error} webUrl={detail?.web_url} />
        ) : !diff ? (
          <DiffLoading label="Reading the changes…" />
        ) : diff.files.length === 0 ? (
          <p
            data-testid="gitlab-diff-empty"
            className="flex flex-1 items-center justify-center p-8 text-[13px] text-text-faint"
          >
            This merge request changes no files.
          </p>
        ) : view === "themes" ? (
          // THE READING. It replaces both columns rather than joining them: it is a map of the
          // whole branch, so a file tree beside it would be a second answer to "what is in this
          // diff" — and a press on one of its files switches back to the feed, which is where code
          // is read.
          <DiffReviewView
            review={review}
            diff={diff}
            headSha={detail?.diff_refs?.head_sha ?? null}
            busy={reviewBusy}
            error={reviewError}
            onRun={() => void controller.runGitLabReview()}
            onOpenFile={(picked) => {
              controller.setGitLabDiffView("files");
              showFile(picked);
              setColumn("patch");
            }}
          />
        ) : (
          <div
            ref={columnHost}
            className="flex min-h-0 flex-1"
            // The two widths live here, on the row both columns are in, because that is the one
            // element a splitter can write to and both columns can read from. React renders the
            // resolved numbers; a drag overwrites them on the DOM and the store catches up at the
            // end (see `column-splitter.tsx`).
            style={
              {
                [FILES_WIDTH_VAR]: `${widths.files}px`,
                [SYMBOLS_WIDTH_VAR]: `${widths.symbols}px`,
              } as React.CSSProperties
            }
          >
            {/* THE FILES. Its own column, its own scroll, and the expand control at its foot
                because what GitLab withheld is a fact about this list. */}
            {columns.files && (
              <div
                data-testid="gitlab-diff-files"
                className={cn("flex min-h-0 flex-col", columns.narrow ? "flex-1" : "shrink-0")}
                // On a wide screen the column is as wide as the reader dragged it. It carries no
                // border of its own: the splitter beside it IS the rule between the two, and a
                // border there would be two lines saying one thing.
                style={columns.narrow ? undefined : { width: `var(${FILES_WIDTH_VAR})` }}
              >
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Suspense fallback={<DiffLoading label="Loading the files…" />}>
                    <DiffFileTree
                      diff={diff}
                      selected={file?.path ?? null}
                      onPick={(picked) => {
                        // The feed scrolls to it. On a narrow screen the pick is also a
                        // navigation: the file the reader chose takes the screen, exactly as
                        // opening a chat does.
                        showFile(picked);
                        setColumn("patch");
                      }}
                    />
                  </Suspense>
                </div>
                <DiffTruncation />
                {expand && (
                  <div className="flex shrink-0 flex-col gap-1 border-t border-border-subtle p-3">
                    <button
                      type="button"
                      data-testid="gitlab-diff-expand"
                      disabled={loading}
                      title={expand.hint}
                      data-cuelume-press=""
                      onClick={() => void controller.expandGitLabDiff()}
                      className={cn(
                        "flex items-center gap-1.5 self-start rounded-lg bg-element px-3 py-1.5 text-[12px] font-medium text-text-dim transition-colors hover:text-foreground",
                        loading && "opacity-60",
                      )}
                    >
                      {loading ? (
                        <FadeArc className="size-3.5" />
                      ) : (
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          className="size-3.5"
                          strokeWidth={1.8}
                        />
                      )}
                      {expand.label}
                    </button>
                    {/* The cost, before the press — the rule the update button follows for its
                        130 MB. This read is measured at half a megabyte on a large merge
                        request. */}
                    <p data-testid="gitlab-diff-expand-hint" className="text-[11px] text-text-faint">
                      {expand.hint}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* The rule between the files and the code, and the handle that moves it. Drawn only
                where there really are two columns to divide — on a narrow screen each fills the
                screen in turn, so a splitter there would size nothing. */}
            {columns.files && columns.patch && resizable && (
              <ColumnSplitter
                host={columnHost}
                variable={FILES_WIDTH_VAR}
                width={widths.files}
                min={FILES_COLUMN_MIN_WIDTH}
                // The code keeps its own minimum, and the panel keeps whatever it is holding: the
                // drag stops where the code would start being squeezed rather than pushing the
                // panel closed under the reader.
                max={Math.max(
                  FILES_COLUMN_MIN_WIDTH,
                  width - widths.symbols - DIFF_CODE_MIN_WIDTH,
                )}
                side="start"
                onCommit={(next) => controller.setGitLabDiffFilesWidth(next)}
                label="Resize the file list"
                testId="gitlab-diff-files-splitter"
              />
            )}

            {/* THE FEED. Its own column and its own scroll, so the tree beside it never moves
                while nine hundred lines are read. */}
            {/* The pane STATES which file the reader is AT — the one at the top of the feed, whose
                row the tree has lit. One place to read "what is on screen" from, which is the
                sentinel discipline the composer already follows for its conversation. */}
            {columns.patch && (
              <div
                data-testid="gitlab-diff-pane"
                data-path={file?.path}
                data-change={file?.change}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                {/* Every file is named by pierre's own header, inside the scroller and sticky, so
                    the name above the code is always the code's own — see `DiffFeed`. */}
                <div className="min-h-0 flex-1">
                  <Suspense fallback={<DiffLoading label="Highlighting…" />}>
                    <DiffFeed
                      diff={diff}
                      layout={effective}
                      theme={theme}
                      commentable={commentable}
                      // The comment gesture's own lit lines, or — with none — the line the reader
                      // pressed a NAME on. One prop, because `selectedLines` is one fact: the
                      // composer's selection wins, since a reader writing a comment is doing the
                      // more particular thing.
                      selection={selection ?? symbolSelection(symbol)}
                      onSelectionChange={(path, range) =>
                        controller.setGitLabDiffSelection(path, range)
                      }
                      onSelectionEnd={(path, range) =>
                        controller.openGitLabDiffComment(path, range)
                      }
                      annotations={annotations}
                      renderAnnotation={renderDiffAnnotation}
                      onActiveFile={noteActiveFile}
                      onTokenPress={(pressedPath, token, lineNumber, side) =>
                        controller.openGitLabDiffSymbol(token, pressedPath, lineNumber, side)
                      }
                      openAt={file?.path ?? null}
                      ref={feed}
                    />
                  </Suspense>
                </div>
              </div>
            )}

            {/* THE OCCURRENCES PANEL, and the rule that sizes it. Its own column on the right, its
                own scroll, and it is drawn exactly when a press has an answer to show. */}
            {symbolsOpen && (
              <>
                <ColumnSplitter
                  host={columnHost}
                  variable={SYMBOLS_WIDTH_VAR}
                  width={widths.symbols}
                  min={SYMBOLS_PANEL_MIN_WIDTH}
                  max={Math.max(
                    SYMBOLS_PANEL_MIN_WIDTH,
                    width - widths.files - DIFF_CODE_MIN_WIDTH,
                  )}
                  side="end"
                  onCommit={(next) => controller.setGitLabDiffSymbolsWidth(next)}
                  label="Resize the occurrences panel"
                  testId="gitlab-diff-symbols-splitter"
                />
                <div
                  className="flex min-h-0 shrink-0 flex-col"
                  style={{ width: `var(${SYMBOLS_WIDTH_VAR})` }}
                >
                  <DiffSymbolsPanel
                    search={search}
                    currentPath={file?.path ?? null}
                    onGo={(occurrence, occurrencePath) => {
                      // The file becomes the one on screen, the LIT line moves to the occurrence,
                      // and the feed goes to it — which is the whole point of a place: a file here
                      // runs to nine hundred lines, so naming the file is not going there.
                      const side = occurrence.side === "old" ? "deletions" : "additions";
                      controller.goToGitLabDiffOccurrence(
                        occurrencePath,
                        occurrence.lineNumber,
                        side,
                      );
                      feed.current?.showLine(occurrencePath, occurrence.lineNumber, side);
                    }}
                    onClose={() => controller.closeGitLabDiffSymbol()}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
    </TrackerProjectProvider>
  );
}

/** What one annotation draws: a thread that is there, or the box for a comment being written.
 *
 *  Hoisted out of the page so the render prop is stable across renders, like the two slots
 *  beside it. The two components are NOT lazy: they are ordinary app components, and the chunk
 *  that has to stay off a chat's path is the highlighter's (see `gitlab-diff-view.tsx`). */
function renderDiffAnnotation(annotation: DiffAnnotation) {
  const metadata = annotation.metadata;
  if (!metadata) return null;
  return metadata.kind === "thread" ? (
    <DiffLineThread thread={metadata.thread} />
  ) : (
    <DiffLineComposer target={metadata.target} />
  );
}

/** What this read left out, when it left anything out — under the tree it is about. */
function DiffTruncation() {
  const diff = useAppState((s) => s.gitlabDiff);
  const notice = diffTruncationNotice(diff);
  if (!notice) return null;
  return (
    <p
      data-testid="gitlab-diff-truncated"
      className="shrink-0 border-t border-border-subtle px-3 py-2 text-[11px] text-text-faint"
    >
      {notice}
    </p>
  );
}

/** A diff that could not be read. The page has no other content, so this is the whole screen —
 *  and it offers the one thing left, which is GitLab's own. */
function DiffFailure(props: { error: string; webUrl?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p
        data-testid="gitlab-diff-error"
        className="flex max-w-md items-start gap-1.5 text-[13px] text-destructive"
      >
        <HugeiconsIcon icon={Alert02Icon} className="mt-px size-4 shrink-0" strokeWidth={1.8} />
        {props.error}
      </p>
      {props.webUrl && (
        <a
          href={`${props.webUrl}/diffs`}
          target="_blank"
          rel="noreferrer"
          data-testid="gitlab-diff-link-fallback"
          className="text-[13px] text-text-dim underline-offset-2 hover:text-foreground hover:underline"
        >
          Open the changes in GitLab
        </a>
      )}
    </div>
  );
}

/** What stands in while a read or the highlighter's chunk is on its way. It fills its column
 *  rather than collapsing, so nothing under it jumps when the diff arrives. */
function DiffLoading(props: { label: string }) {
  return (
    <div
      data-testid="gitlab-diff-loading"
      className="flex h-full flex-1 items-center justify-center p-8"
    >
      <span className="flex items-center gap-2 text-[12px] text-text-faint">
        <FadeArc className="size-3.5" />
        {props.label}
      </span>
    </div>
  );
}

/** The FILES or the THEMES. Two states of one control, in the same shape the layout toggle beside
 *  it takes — so the header reads as one row of switches rather than as a row of shapes.
 *
 *  It carries WORDS rather than two glyphs: "a feed of files" and "an AI reading grouped by theme"
 *  are not two things a 14px mark can tell apart, and this is the one control on this page whose two
 *  states are different KINDS of answer rather than two arrangements of one. */
function ViewToggle(props: { view: DiffView; onPick: (view: DiffView) => void }) {
  return (
    <div
      data-testid="gitlab-diff-view"
      data-view={props.view}
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-element p-0.5"
    >
      {(
        [
          ["files", "Files", "Every changed file, one after another"],
          ["themes", "Themes", "The changes grouped by what the branch does"],
        ] as const
      ).map(([option, label, hint]) => (
        <button
          key={option}
          type="button"
          data-testid={`gitlab-diff-view-${option}`}
          aria-pressed={props.view === option}
          title={hint}
          onClick={() => props.onPick(option)}
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
            props.view === option
              ? "bg-card text-foreground shadow-chip"
              : "text-text-faint hover:text-text-dim",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Unified or split. Two states of one control, so the reader's eye does not move. */
function LayoutToggle(props: { layout: DiffLayout; onPick: (layout: DiffLayout) => void }) {
  return (
    <div
      data-testid="gitlab-diff-layout"
      data-layout={props.layout}
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-element p-0.5"
    >
      {(["unified", "split"] as const).map((option) => (
        <button
          key={option}
          type="button"
          data-testid={`gitlab-diff-layout-${option}`}
          aria-pressed={props.layout === option}
          title={option === "unified" ? "One column" : "Side by side"}
          onClick={() => props.onPick(option)}
          className={cn(
            "grid size-6 place-items-center rounded-md transition-colors",
            props.layout === option
              ? "bg-card text-foreground shadow-chip"
              : "text-text-faint hover:text-text-dim",
          )}
        >
          <HugeiconsIcon
            icon={option === "unified" ? LayoutThreeRowIcon : LayoutTwoColumnIcon}
            className="size-3.5"
            strokeWidth={1.8}
            aria-label={option === "unified" ? "Unified" : "Split"}
          />
        </button>
      ))}
    </div>
  );
}

/** The viewport's width, which decides how many columns the page has and whether split can
 *  apply at all.
 *
 *  SSR-safe by starting at 0, which `diffPageColumns` resolves to the FILES column alone —
 *  the honest opening state of a page whose subject the reader has not picked yet. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return width;
}
