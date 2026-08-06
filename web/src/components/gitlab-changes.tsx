import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  LayoutThreeRowIcon,
  LayoutTwoColumnIcon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";
import {
  diffFileNotice,
  diffFileState,
  diffSummary,
  diffTruncationNotice,
  effectiveDiffLayout,
  expandDiffHint,
  formatDiffStat,
  selectDiffFile,
  SPLIT_MIN_WIDTH,
  type DiffLayout,
  type GitLabDiffFile,
} from "~/lib/gitlab-diff";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { Panel } from "./gitlab-panel";
import type { MergeRequestDetail } from "~/lib/gitlab-mr";

// The Changes section: what the merge request changed, and one file of it read in full.
//
// This file holds the SECTION — its heading, its notices, its two controls and which file is
// shown. What draws a tree and highlights a patch is `gitlab-diff-view.tsx`, behind a lazy
// import, because that chunk carries Shiki and a grammar per language (see its own header).
//
// The split matters for more than bundle size: everything here is decided by the pure rules in
// `web/src/lib/gitlab-diff.ts`, so a merge request with nothing to render — no token, a read
// that failed, a diff of one binary file — is a section that says so without loading a
// megabyte of highlighter to say it.
//
// Four rules hold the surface together, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **A file with NO patch is a state, not a failure.** Three of them arrive from a real
//     GitLab — a binary file, a pure rename, and a file GitLab would not expand — and each
//     says something different, because the reader's next move differs (`diffFileState`).
//   - **What GitLab withheld is COUNTED, and the way out is offered once.** A diff that
//     silently dropped a third of its files reads as a complete one. The expanded read is the
//     reader's own ask and its cost is named before the click (`expandDiffHint`).
//   - **A narrow screen is always UNIFIED.** Split needs two columns of code, and this app is
//     read from a phone. The preference is kept, it simply cannot apply there
//     (`effectiveDiffLayout`).
//   - **A diff that could not be read costs THIS panel and nothing else** — the contract the
//     comments already hold. The page is a header and five panels; one that cannot be read
//     must not empty the others.

/** The tree and the patch, behind a lazy import: Shiki must never sit on a chat's path. */
const GitLabDiffView = lazy(() => import("./gitlab-diff-view"));

export function ChangesPanel(props: { detail: MergeRequestDetail }) {
  const diff = useAppState((s) => s.gitlabDiff);
  const loading = useAppState((s) => s.gitlabDiffLoading);
  const error = useAppState((s) => s.gitlabDiffError);
  const path = useAppState((s) => s.gitlabDiffPath);
  const layout = useAppState((s) => s.gitlabDiffLayout);
  const theme = useAppState((s) => s.resolvedTheme);
  const controller = useController();

  const file = useMemo(() => selectDiffFile(diff, path), [diff, path]);
  const width = useViewportWidth();
  const effective = effectiveDiffLayout(layout, width);
  const truncation = diffTruncationNotice(diff);
  const expand = expandDiffHint(diff);

  return (
    <Panel
      title="Changes"
      testId="gitlab-changes"
      right={
        // Drawn only where it would DO something: on a phone the split layout cannot apply,
        // and a toggle that changes nothing reads as a bug.
        width >= SPLIT_MIN_WIDTH && diff && diff.files.length > 0 ? (
          <LayoutToggle
            layout={layout}
            onPick={(next) => controller.setGitLabDiffLayout(next)}
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-2">
        <p data-testid="gitlab-changes-summary" className="text-[12px] text-text-faint">
          {diff ? diffSummary(diff) : loading ? "Reading the changes…" : diffSummary(null)}
          {/* The way out to GitLab's own diff stays, whatever this page can draw: a file it
              cannot expand, a merge request past 100 files, and a review comment on a line
              this page does not show are all reasons a reader still wants theirs. */}
          {props.detail.web_url && (
            <>
              {" · "}
              <a
                href={`${props.detail.web_url}/diffs`}
                target="_blank"
                rel="noreferrer"
                data-testid="gitlab-changes-link"
                className="text-text-dim underline-offset-2 hover:text-foreground hover:underline"
              >
                Open in GitLab
              </a>
            </>
          )}
        </p>

        {truncation && (
          <p data-testid="gitlab-changes-truncated" className="text-[12px] text-text-faint">
            {truncation}
          </p>
        )}

        {/* A read that failed says so HERE. It costs this panel and nothing else. */}
        {error && !diff ? (
          <p
            data-testid="gitlab-changes-error"
            className="flex items-start gap-1.5 text-[12px] text-destructive"
          >
            <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
            {error}
          </p>
        ) : !diff ? (
          <p className="flex items-center gap-2 text-[12px] text-text-faint">
            <HugeiconsIcon icon={Loading02Icon} className="size-3.5 animate-spin" strokeWidth={1.6} />
            Reading the changes…
          </p>
        ) : diff.files.length === 0 ? (
          <p data-testid="gitlab-changes-empty" className="text-[12px] text-text-faint">
            This merge request changes no files.
          </p>
        ) : (
          <>
            <FileHeading file={file} />
            <Suspense fallback={<DiffPlaceholder />}>
              <GitLabDiffView
                diff={diff}
                file={file}
                layout={effective}
                theme={theme}
                onPick={(picked) => controller.setGitLabDiffFile(picked)}
              />
            </Suspense>
            {file && <FileNotice file={file} />}
          </>
        )}

        {expand && (
          <div className="flex flex-col gap-1 pt-1">
            <button
              type="button"
              data-testid="gitlab-changes-expand"
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
            {/* What it costs, before it is pressed — the rule the update button follows for
                its 130 MB. This read is measured at half a megabyte on a large merge
                request. */}
            <p data-testid="gitlab-changes-expand-hint" className="text-[11px] text-text-faint">
              {expand.hint}
            </p>
          </div>
        )}
      </div>
    </Panel>
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
      data-testid="gitlab-changes-file"
      data-path={file.path}
      data-change={file.change}
      className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12px] text-text-dim"
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

/** Why a file has no patch, when that is the case. Nothing for a file that has one, and
 *  nothing for a rename — a rename's patch IS its header, so the renderer draws it. */
function FileNotice(props: { file: GitLabDiffFile }) {
  const notice = diffFileNotice(props.file);
  if (!notice) return null;
  return (
    <p
      data-testid="gitlab-changes-file-notice"
      data-state={diffFileState(props.file)}
      className="text-[12px] text-text-faint"
    >
      {notice}
    </p>
  );
}

/** Unified or split. Two states of one control, so the reader's eye does not move. */
function LayoutToggle(props: { layout: DiffLayout; onPick: (layout: DiffLayout) => void }) {
  return (
    <div
      data-testid="gitlab-diff-layout"
      data-layout={props.layout}
      className="flex items-center gap-0.5 rounded-lg bg-element p-0.5"
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

/** What stands in for the diff while its chunk loads.
 *
 *  It reserves the room the diff will take rather than collapsing to nothing, so the page
 *  under it does not jump when the highlighter arrives — the rule the composer's own
 *  `Suspense` fallback follows. */
function DiffPlaceholder() {
  return (
    <div
      data-testid="gitlab-diff-loading"
      className="flex h-40 items-center justify-center rounded-xl bg-element/40"
    >
      <span className="flex items-center gap-2 text-[12px] text-text-faint">
        <HugeiconsIcon icon={Loading02Icon} className="size-3.5 animate-spin" strokeWidth={1.6} />
        Highlighting…
      </span>
    </div>
  );
}

/** The viewport's width, which decides whether the split layout can apply at all.
 *
 *  SSR-safe by starting at a width that resolves to the unified layout: unified works at every
 *  size, so the first paint is never a split diff that has to be undone. */
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
