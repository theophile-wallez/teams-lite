import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  ChevronLeftIcon,
  LayoutThreeRowIcon,
  LayoutTwoColumnIcon,
  Link01Icon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";
import {
  diffFileNotice,
  diffFileState,
  diffPageColumns,
  diffSummary,
  diffTruncationNotice,
  effectiveDiffLayout,
  expandDiffHint,
  formatDiffStat,
  selectDiffFile,
  SPLIT_MIN_WIDTH,
  type DiffColumn,
  type DiffLayout,
  type GitLabDiffFile,
} from "~/lib/gitlab-diff";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { GitLabLogo } from "./gitlab-logo";

// The DIFF PAGE: the whole screen, the changed files down the left, one of them read on the
// right. It is its own route (`/mr/<id>/diff` — see routes/_app.mr.$mergeRequestId.diff.tsx),
// and the shell draws it over the app's own sidebar as well as its pane.
//
// **It is a page rather than a panel, and that is the whole design.** The diff used to be a
// section inside the merge request's scrolling article, which is the wrong shape for the one
// thing it is for: reading code is somewhere a reviewer STAYS, and a 149-file tree beside a
// 900-line patch has no room to be either inside a column that also holds a description, a
// pipeline and a conversation. Three things follow from the URL, and none of them is available
// to a piece of component state: it survives a reload, it can be sent to a colleague, and the
// browser's own Back leaves it.
//
// Six rules hold the surface, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **Each column scrolls ITSELF, and the page does not scroll at all.** The header stays,
//     the tree keeps its place while a patch is read, and a file picked after ten minutes of
//     scrolling does not put the reader back at the top of a page. That is what the height
//     chain is for: `h-full` and `min-h-0` down both columns, never a page that grows.
//   - **A narrow screen is one column at a time** (`diffPageColumns`): the files, then the file
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

// The tree and the patch: the only two things here that need a renderer, and the only two
// imports of the chunk that carries Shiki. Two `lazy` calls over ONE module is deliberate — the
// bundler memoizes `import()`, so the second resolves out of the module registry rather than
// asking for the chunk twice, and each column gets to suspend on its own.
const DiffFileTree = lazy(() =>
  import("./gitlab-diff-view").then((m) => ({ default: m.DiffFileTree })),
);
const DiffFilePatch = lazy(() =>
  import("./gitlab-diff-view").then((m) => ({ default: m.DiffFilePatch })),
);

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
  };
}

export function GitLabDiffPage(props: { onBack: () => void }) {
  const { detail, diff, loading, error, path, layout, theme } = useDiffState();
  const controller = useController();

  const file = useMemo(() => selectDiffFile(diff, path), [diff, path]);
  const width = useViewportWidth();
  // Which column the reader is IN on a narrow screen. The page opens on the files, because
  // that is the question a diff asks first — which of these do I want to read?
  const [column, setColumn] = useState<DiffColumn>("files");
  const columns = diffPageColumns(width, column);
  const effective = effectiveDiffLayout(layout, width);
  const expand = expandDiffHint(diff);

  return (
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
        {/* The layout toggle, where it applies. Split needs two columns of code — on a phone it
            cannot, so it is not drawn at all rather than drawn dead. */}
        {width >= SPLIT_MIN_WIDTH && diff && diff.files.length > 0 && (
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
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* THE FILES. Its own column, its own scroll, and the expand control at its foot
              because what GitLab withheld is a fact about this list. */}
          {columns.files && (
            <div
              data-testid="gitlab-diff-files"
              className={cn(
                "flex min-h-0 flex-col",
                columns.narrow ? "flex-1" : "w-72 shrink-0 border-r border-border-subtle",
              )}
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                <Suspense fallback={<DiffLoading label="Loading the files…" />}>
                  <DiffFileTree
                    diff={diff}
                    selected={file?.path ?? null}
                    onPick={(picked) => {
                      controller.setGitLabDiffFile(picked);
                      // On a narrow screen a pick is a navigation: the file the reader chose
                      // takes the screen, exactly as opening a chat does.
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
                    <HugeiconsIcon
                      icon={loading ? Loading02Icon : ArrowRight01Icon}
                      className={cn("size-3.5", loading && "animate-spin")}
                      strokeWidth={1.8}
                    />
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

          {/* THE PATCH. Its own column and its own scroll, so the tree beside it never moves
              while a nine-hundred-line file is read. */}
          {/* The pane STATES which file it holds, whatever draws that file's name — pierre's own
              header over a patch, this app's over a sentence. One place to read "what is on
              screen" from, which is the sentinel discipline the composer already follows for its
              conversation. */}
          {columns.patch && (
            <div
              data-testid="gitlab-diff-pane"
              data-path={file?.path}
              data-change={file?.change}
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {/* A file with a PATCH is named by pierre's own header, inside the scroller and
                  sticky — see `DiffFilePatch`. One with no patch has no header of theirs at
                  all, so this app draws one over the sentence that stands in for the code. */}
              {file?.patch ? (
                <div className="min-h-0 flex-1 overflow-auto">
                  <Suspense fallback={<DiffLoading label="Highlighting…" />}>
                    <DiffFilePatch
                      patch={file.patch}
                      layout={effective}
                      theme={theme}
                      generated={file.generated}
                    />
                  </Suspense>
                </div>
              ) : (
                file && (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <FileHeading file={file} />
                    <FileNotice file={file} />
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Which file is on screen, and what it costs in lines.
 *
 *  A rename says both of its names, because "what happened to this file" is the one thing a
 *  moved file's patch header states and a tree row cannot. */
function FileHeading(props: { file: GitLabDiffFile | null }) {
  const file = props.file;
  if (!file) return null;
  const stat = formatDiffStat(file);
  return (
    <p
      data-testid="gitlab-diff-file"
      data-path={file.path}
      data-change={file.change}
      className="flex shrink-0 flex-wrap items-baseline gap-x-2 border-b border-border-subtle px-4 py-2 font-mono text-[12px] text-text-dim"
    >
      {file.old_path && (
        <span className="text-text-faint">
          <span className="line-through">{file.old_path}</span> →
        </span>
      )}
      <span className="min-w-0 break-all text-foreground">{file.path}</span>
      {stat && <span className="tabular-nums text-text-faint">{stat}</span>}
      {file.generated && (
        <span className="rounded bg-element px-1.5 py-px font-sans text-[10px] text-text-faint">
          generated
        </span>
      )}
    </p>
  );
}

/** Why a file has no patch, when that is the case. Nothing for a rename — a rename's patch IS
 *  its header, so the renderer draws it and there is nothing to explain. */
function FileNotice(props: { file: GitLabDiffFile }) {
  const notice = diffFileNotice(props.file);
  if (!notice) return null;
  return (
    <p
      data-testid="gitlab-diff-file-notice"
      data-state={diffFileState(props.file)}
      className="p-6 text-[13px] text-text-faint"
    >
      {notice}
    </p>
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
        <HugeiconsIcon icon={Loading02Icon} className="size-3.5 animate-spin" strokeWidth={1.6} />
        {props.label}
      </span>
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
