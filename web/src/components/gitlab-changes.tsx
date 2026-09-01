import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { diffSummary, diffTruncationNotice, type GitLabDiff } from "~/lib/gitlab-diff";
import { cn } from "~/lib/utils";
import { useAppState } from "./controller-context";
import { Panel } from "./gitlab-panel";
import { FadeArc } from "./loading-ui/fade-arc";
import type { MergeRequestDetail } from "~/lib/gitlab-mr";

// The Changes section of the merge-request page: what changed, in one line, and the way IN.
//
// The diff itself is a PAGE (`gitlab-diff-page.tsx`, at `/mr/<id>/diff`). This section used to
// hold the whole tree and the whole patch, and that was the wrong shape twice over: a 149-file
// tree and a 900-line file have no room inside a column that also carries a description, a
// pipeline, the actions and a conversation — and it put Shiki on the path of every merge
// request anybody opened, whether or not they meant to read code.
//
// So what is left here is what belongs on a summary page, and three rules hold it:
//
//   - **It STATES the diff and never draws it.** The count and the lines moved are what a
//     reader deciding whether to review needs; the code is one press away and a place of its
//     own. Nothing in this file imports `@pierre/diffs`, so the merge-request page carries no
//     highlighter at all.
//   - **The way in is a ROUTE**, not a control that swaps a piece of state. That is what makes
//     the diff reloadable, sendable and behind the browser's own Back — the press is handed up
//     to the pane, which owns this app's navigation.
//   - **A diff that could not be read costs THIS panel and nothing else** — the contract the
//     comments already hold — and the way out to GitLab's own stays whatever this app can draw.

export function ChangesPanel(props: {
  detail: MergeRequestDetail;
  /** Open the diff page. The pane navigates, so this component names no route. */
  onOpenDiff: () => void;
}) {
  const diff = useAppState((s) => s.gitlabDiff);
  const loading = useAppState((s) => s.gitlabDiffLoading);
  const error = useAppState((s) => s.gitlabDiffError);
  const truncation = diffTruncationNotice(diff);

  return (
    <Panel
      title="Changes"
      testId="gitlab-changes"
      right={
        props.detail.web_url ? (
          <a
            href={`${props.detail.web_url}/diffs`}
            target="_blank"
            rel="noreferrer"
            data-testid="gitlab-changes-link"
            className="text-[11px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
          >
            Open in GitLab
          </a>
        ) : null
      }
    >
      <div className="flex flex-col gap-2">
        <p data-testid="gitlab-changes-summary" className="text-[12px] text-text-faint">
          {diff ? diffSummary(diff) : loading ? "Reading the changes…" : diffSummary(null)}
        </p>

        {truncation && (
          <p data-testid="gitlab-changes-truncated" className="text-[12px] text-text-faint">
            {truncation}
          </p>
        )}

        {/* A read that failed says so HERE. It costs this panel and nothing else. */}
        {error && !diff && (
          <p
            data-testid="gitlab-changes-error"
            className="flex items-start gap-1.5 text-[12px] text-destructive"
          >
            <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
            {error}
          </p>
        )}

        <ReviewButton diff={diff} loading={loading} onOpenDiff={props.onOpenDiff} />
      </div>
    </Panel>
  );
}

/** The way into the diff page.
 *
 *  Drawn only where there is something to read: a diff still on its way says so, a merge
 *  request that changed nothing says that, and a read that failed leaves GitLab's own link
 *  above rather than a press that opens an empty page. */
function ReviewButton(props: {
  diff: GitLabDiff | null;
  loading: boolean;
  onOpenDiff: () => void;
}) {
  if (!props.diff) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-text-faint">
        {props.loading && <FadeArc className="size-3.5" />}
        {props.loading ? "Reading the changes…" : "The changes could not be read."}
      </p>
    );
  }
  if (props.diff.files.length === 0) {
    return (
      <p data-testid="gitlab-changes-empty" className="text-[12px] text-text-faint">
        This merge request changes no files.
      </p>
    );
  }
  return (
    <button
      type="button"
      data-testid="gitlab-review-changes"
      data-cuelume-press=""
      onClick={props.onOpenDiff}
      className={cn(
        "flex items-center gap-1.5 self-start rounded-lg bg-element px-3 py-1.5 text-[13px] font-medium text-text-dim transition-colors",
        "hover:bg-accent hover:text-foreground",
      )}
    >
      Review the changes
      <HugeiconsIcon icon={ArrowRight01Icon} className="size-4" strokeWidth={1.8} />
    </button>
  );
}
