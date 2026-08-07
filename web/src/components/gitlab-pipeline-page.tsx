import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Link01Icon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";
import {
  formatJobDuration,
  jobsTone,
  jobTone,
  pipelineIsLive,
  pipelineStages,
  type GitLabJob,
  type GitLabPipelineView,
  type PipelineTone,
} from "~/lib/gitlab-mr";
import {
  canGroupByNeeds,
  defaultGrouping,
  graphSummary,
  pipelineGraph,
  type PipelineGrouping,
} from "~/lib/gitlab-pipeline-graph";
import { gitlabPageUrl, mergeRequestPagePanel } from "~/lib/gitlab-mr-pages";
import { cn } from "~/lib/utils";
import { useAppState } from "./controller-context";
import {
  PipelineGraphView,
  PipelineStatusBadge,
  ToneDot,
  TONE_WORDS,
} from "./gitlab-pipeline-graph";

// PIPELINES: one of the four pages of a merge request (`/mr/<id>/pipelines`), and the graph in
// it. The pane draws it under the header that names the merge request and the sub-header that
// names its pages, so this file draws the page's own CONTENT and never a header of its own —
// see `gitlab-mr-pages.tsx` for the strip, and `gitlab-pane.tsx` for where this sits.
//
// The Overview keeps a compact graph — a LOOK at the run, with the way in — and this is where
// the run is read: the two controls the graph really has, and the jobs as a list beside it. A
// panel in a column that also carries a description, the approvals, the actions and a
// conversation has no room for either.
//
// Four rules hold it, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **A ROUTE, never a piece of state**, like all four pages: it survives a reload, it can be
//     sent to whoever is asking why CI is red, and the browser's own Back leaves it.
//   - **The controls are the graph's own two, and each is drawn only where it does something.**
//     Grouping by dependency needs a pipeline that declares one, and lighting the dependencies
//     needs the same — so a pipeline ordered by its stages alone gets neither, rather than two
//     controls that change nothing (the rule the diff's split toggle follows on a phone).
//   - **JOBS are a second view, not a second surface.** The graph answers "what is the shape of
//     this run"; the list answers "what took four minutes" — and it is the better one on a
//     phone. One page, one read, two ways to look at it.
//   - **A live run is FOLLOWED here as it is on the Overview.** The store's own poll is armed by
//     the merge request being open, which this page needs no half of: it reads the same field.

/** Which of the page's two views is up. */
type PipelineView = "graph" | "jobs";

export function GitLabPipelinePage() {
  const detail = useAppState((s) => s.gitlabDetail);
  const view = useAppState((s) => s.gitlabPipeline);
  const error = useAppState((s) => s.gitlabPipelineError);
  const jobs = view?.jobs ?? [];
  const live = pipelineIsLive(view);

  const [tab, setTab] = useState<PipelineView>("graph");
  // The grouping is not remembered across pipelines, and that is deliberate: the honest default
  // is the shape the pipeline's own author wrote (`defaultGrouping`), and a preference kept from
  // another merge request would open this one on a mode it may not even have.
  const [grouping, setGrouping] = useState<PipelineGrouping | null>(null);
  const [showNeeds, setShowNeeds] = useState(true);
  const groupable = canGroupByNeeds(jobs);
  const effectiveGrouping = grouping ?? defaultGrouping(jobs);
  const graph = useMemo(() => pipelineGraph(view, effectiveGrouping), [view, effectiveGrouping]);

  // A pipeline that turns out to declare no dependencies cannot be grouped by them, so a
  // grouping picked on an earlier one is let go rather than silently ignored.
  useEffect(() => {
    if (!groupable && grouping === "needs") setGrouping(null);
  }, [groupable, grouping]);

  return (
    // This page's own content IS the panel the strip's Pipelines tab controls, so it carries
    // that tab's id — see `mergeRequestPagePanel`.
    <section
      {...mergeRequestPagePanel("pipelines")}
      data-testid="gitlab-pipeline-page"
      data-view={tab}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* What this page holds, in one line, with GitLab's own pipeline beside it. There is no
          header here: the pane's own names the merge request and the sub-header above names the
          page, so a third row saying either would be this app stating one thing twice. */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 md:px-5">
        <p className="min-w-0 flex-1 truncate text-[12px] text-text-faint">
          <span data-testid="gitlab-pipeline-summary">
            {view?.pipeline ? graphSummary(view, graph) : "Reading the pipeline…"}
          </span>
          {live && (
            <span data-testid="gitlab-pipeline-live" className="ml-1">
              · following
            </span>
          )}
        </p>
        {view?.pipeline && <PipelineStatusBadge status={view.pipeline.status} jobs={jobs} />}
        {view?.pipeline?.web_url && (
          <a
            href={view.pipeline.web_url}
            target="_blank"
            rel="noreferrer"
            data-testid="gitlab-pipeline-link"
            title="Open this pipeline in GitLab"
            aria-label="Open this pipeline in GitLab"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Link01Icon} className="size-4" strokeWidth={1.6} />
          </a>
        )}
      </div>

      {error && !view ? (
        // On this page the failure IS the whole screen — there is no other content to fall back
        // on — so it says why and offers the one thing left, which is GitLab's own page.
        <div
          data-testid="gitlab-pipeline-error"
          className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center"
        >
          <HugeiconsIcon icon={Alert02Icon} className="size-5 text-destructive" strokeWidth={1.8} />
          <p className="max-w-md text-[13px] text-text-dim">{error}</p>
          {detail?.web_url && (
            <a
              href={gitlabPageUrl(detail.web_url, "pipelines") ?? detail.web_url}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
            >
              Open the pipelines in GitLab
            </a>
          )}
        </div>
      ) : !view ? (
        <Loading label="Reading the pipeline…" />
      ) : !view.pipeline ? (
        <p
          data-testid="gitlab-pipeline-none"
          className="flex flex-1 items-center justify-center p-8 text-[13px] text-text-faint"
        >
          No pipeline has run for this merge request.
        </p>
      ) : jobs.length === 0 ? (
        <p
          data-testid="gitlab-pipeline-empty"
          className="flex flex-1 items-center justify-center p-8 text-[13px] text-text-faint"
        >
          This pipeline has no jobs yet.
        </p>
      ) : (
        <>
          {/* The controls, in one row: which view, how the graph is grouped, and whether the
              dependencies are lit. Everything here is a way of LOOKING — nothing on this page
              changes anything in GitLab. */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-y border-border-subtle px-3 py-2 md:px-5">
            <Segmented
              testId="gitlab-pipeline-view"
              value={tab}
              onPick={(next) => setTab(next as PipelineView)}
              options={[
                { value: "graph", label: "Graph" },
                { value: "jobs", label: "Jobs" },
              ]}
            />
            {tab === "graph" && groupable && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-text-faint">Group by</span>
                  <Segmented
                    testId="gitlab-pipeline-grouping"
                    value={effectiveGrouping}
                    onPick={(next) => setGrouping(next as PipelineGrouping)}
                    options={[
                      { value: "stage", label: "Stage" },
                      { value: "needs", label: "Dependencies" },
                    ]}
                  />
                </div>
                <label className="flex cursor-pointer items-center gap-2">
                  <span className="text-[11px] font-medium text-text-faint">
                    Show dependencies
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showNeeds}
                    aria-label="Show the dependencies between jobs"
                    data-testid="gitlab-pipeline-needs-toggle"
                    onClick={() => setShowNeeds((on) => !on)}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      showNeeds ? "bg-primary" : "bg-element",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block size-4 transform rounded-full bg-white shadow-sm transition-transform",
                        showNeeds ? "translate-x-[18px]" : "translate-x-0.5",
                      )}
                    />
                  </button>
                </label>
              </>
            )}
          </div>

          {tab === "graph" ? (
            // The graph scrolls sideways INSIDE this box, and the box is the page's own room:
            // neither this page nor the app around it ever scrolls.
            <div className="flex min-h-0 flex-1 flex-col">
              <PipelineGraphView
                graph={graph}
                showNeeds={showNeeds}
                className="min-h-0 flex-1 px-2 py-3 md:px-4"
              />
              <Legend jobs={jobs} />
            </div>
          ) : (
            <JobList view={view} />
          )}
        </>
      )}
    </section>
  );
}

/** The jobs as a list, in GitLab's own stage order: what the graph is bad at. A stage view
 *  reads down a phone's screen with no sideways scroll, and a duration beside every name is how
 *  a reader finds the four minutes they are looking for. */
function JobList(props: { view: GitLabPipelineView }) {
  const stages = useMemo(() => pipelineStages(props.view), [props.view]);
  return (
    <div data-testid="gitlab-pipeline-jobs" className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-5">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        {stages.map((stage, index) => (
          <section key={`${stage.name}:${index}`} data-testid="gitlab-pipeline-jobs-stage">
            <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-text-faint">
              {stage.name}
              <span className="text-[11px] font-normal normal-case tracking-normal">
                {TONE_WORDS[jobsTone(stage.jobs)]}
              </span>
            </h2>
            <ul className="flex flex-col divide-y divide-border-subtle rounded-xl bg-card/60">
              {stage.jobs.map((job) => (
                <li
                  key={job.id}
                  data-testid="gitlab-pipeline-job-row"
                  data-status={job.status}
                  data-tone={jobTone(job)}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <ToneDot tone={jobTone(job)} />
                  {job.web_url ? (
                    <a
                      href={job.web_url}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate text-[13px] text-text-dim underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {job.name}
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-dim">
                      {job.name}
                    </span>
                  )}
                  {job.allow_failure && job.status === "failed" && (
                    <span className="shrink-0 text-[10px] text-text-faint">(allowed to fail)</span>
                  )}
                  <span className="shrink-0 tabular-nums text-[11px] text-text-faint">
                    {formatJobDuration(job.duration) || job.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** What the colours mean, in words, once — for the whole graph rather than per card.
 *
 *  Only the tones this pipeline actually holds are listed: a legend naming four states when the
 *  run has two is a legend nobody reads. */
function Legend(props: { jobs: GitLabJob[] }) {
  const tones = useMemo(() => {
    const order: PipelineTone[] = ["success", "warning", "failed", "running", "idle"];
    const held = new Set(props.jobs.map((job) => jobTone(job)));
    return order.filter((tone) => held.has(tone));
  }, [props.jobs]);
  if (tones.length < 2) return null;
  return (
    <div
      data-testid="gitlab-pipeline-legend"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle px-3 py-2 md:px-5"
    >
      {tones.map((tone) => (
        <span key={tone} data-tone={tone} className="flex items-center gap-1.5 text-[11px] text-text-faint">
          <ToneDot tone={tone} />
          {TONE_WORDS[tone]}
        </span>
      ))}
    </div>
  );
}

/** A row of two or three choices. One shape for the view and for the grouping, because they
 *  are the same kind of question — which of these am I looking at. */
function Segmented(props: {
  testId: string;
  value: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
}) {
  return (
    <div
      data-testid={props.testId}
      data-value={props.value}
      role="tablist"
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-element p-0.5"
    >
      {props.options.map((option) => {
        const current = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={current}
            data-value={option.value}
            data-current={current ? "true" : undefined}
            onClick={() => props.onPick(option.value)}
            className={cn(
              "cursor-pointer rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              current ? "bg-card text-foreground shadow-sm" : "text-text-dim hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Loading(props: { label: string }) {
  return (
    <p className="flex flex-1 items-center justify-center gap-2 p-8 text-[13px] text-text-faint">
      <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.6} />
      {props.label}
    </p>
  );
}
