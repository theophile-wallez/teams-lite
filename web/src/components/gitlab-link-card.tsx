import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashTwoIcon,
  CircleXIcon,
  Clock01Icon,
  FolderGitTwoIcon,
  GitPullRequestArrowIcon,
  Loading02Icon,
  PlayCircleIcon,
} from "@hugeicons/core-free-icons";
import type { GitLabLinkKind, GitLabLinkMetadata } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { CardPerson } from "./card-person";

const KIND_ICON: Record<GitLabLinkKind, IconSvgElement> = {
  merge_request: GitPullRequestArrowIcon,
  issue: CircleDotIcon,
  project: FolderGitTwoIcon,
};

type StatusStyle = { label: string; badge: string; icon: string };

/** Map a resource's state to a calm, semantic badge + icon color. Draft wins over
 *  the raw state; unknown states fall back to a neutral zinc pill. */
function statusStyle(meta: GitLabLinkMetadata): StatusStyle | null {
  if (meta.kind === "project") return null;
  if (meta.draft) {
    return {
      label: "Draft",
      badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      icon: "text-amber-600 dark:text-amber-400",
    };
  }
  switch (meta.state) {
    case "opened":
      return {
        label: "Open",
        badge: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
        icon: "text-emerald-600 dark:text-emerald-400",
      };
    case "merged":
      return {
        label: "Merged",
        badge: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
        icon: "text-violet-600 dark:text-violet-400",
      };
    case "closed":
      return {
        label: "Closed",
        badge: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
        icon: "text-rose-600 dark:text-rose-400",
      };
    case "locked":
      return {
        label: "Locked",
        badge: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400",
        icon: "text-zinc-600 dark:text-zinc-400",
      };
    default:
      return meta.state
        ? {
            label: meta.state.charAt(0).toUpperCase() + meta.state.slice(1),
            badge: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400",
            icon: "text-zinc-600 dark:text-zinc-400",
          }
        : null;
  }
}

type PipelineStyle = { label: string; badge: string; icon: IconSvgElement; spin?: boolean };

/** Map a merge request's CI/CD pipeline status to a small status badge. The
 *  in-progress states (queued/running) share a "working" look — the card is
 *  polled and these update live — while the terminal states each get their own
 *  semantic color. An unknown/newer status still renders as a neutral pill. */
function pipelineStyle(status: string | undefined): PipelineStyle | null {
  if (!status) return null;
  switch (status) {
    case "success":
      return {
        label: "Passed",
        badge: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
        icon: CircleCheckIcon,
      };
    case "failed":
      return {
        label: "Failed",
        badge: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
        icon: CircleXIcon,
      };
    case "running":
      return {
        label: "Running",
        badge: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
        icon: Loading02Icon,
        spin: true,
      };
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "pending":
    case "scheduled":
      return {
        label: "Pending",
        badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        icon: Clock01Icon,
      };
    case "canceled":
      return {
        label: "Canceled",
        badge: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400",
        icon: CircleSlashTwoIcon,
      };
    case "skipped":
      return {
        label: "Skipped",
        badge: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400",
        icon: CircleSlashTwoIcon,
      };
    case "manual":
      return {
        label: "Manual",
        badge: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400",
        icon: PlayCircleIcon,
      };
    default:
      return {
        label: status.charAt(0).toUpperCase() + status.slice(1),
        badge: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-400",
        icon: CircleDashedIcon,
      };
  }
}

const MAX_LABELS = 4;

/**
 * A rich preview card for a GitLab link (merge request, issue, or project),
 * rendered from already-resolved metadata. It shows title, state, reference,
 * author, branches, milestone, labels, and a short description, and is itself the
 * clickable link to the resource. Enrichment (and its caching) is owned by the
 * caller (see MessageBubble), so this component is pure and always renders.
 *
 * The card spans its container: alongside text it fills the bubble's width so it
 * lines up with the message body, and on its own the bubble's cap sizes it.
 *
 * Every line of it is free to SHRINK, and that is what makes it fit a phone. Each
 * one holds text with no break in it — a nested group path, a branch name, a label —
 * so a span left at its natural width raises the whole card's min-content above the
 * screen: the card then either ran off the side (on its own, where nothing but
 * `max-w-md` capped it) or spilled its badges out of the bubble that held it. Hence
 * `min-w-0` on each truncating span, so it may ellipsize, and `break-words` on the
 * prose, whose longest token is somebody else's to choose.
 */
export function GitLabLinkCard(props: { metadata: GitLabLinkMetadata }) {
  const meta = props.metadata;
  const kindIcon = KIND_ICON[meta.kind];
  const status = statusStyle(meta);
  // Only merge requests carry a pipeline; issues/projects never do.
  const pipeline = meta.kind === "merge_request" ? pipelineStyle(meta.pipeline_status) : null;
  const labels = meta.labels ?? [];
  const extraLabels = labels.length - MAX_LABELS;

  return (
    <a
      href={meta.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="gitlab-link-card"
      data-kind={meta.kind}
      className="block w-full rounded-xl bg-card px-3 py-2.5 text-foreground shadow-chip transition-shadow hover:shadow-card"
    >
      <div className="flex items-start gap-2.5">
        <HugeiconsIcon
          icon={kindIcon}
          className={cn("mt-0.5 size-4 shrink-0", status?.icon ?? "text-primary")}
          strokeWidth={1.6}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {meta.title}
            </span>
            {status && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  status.badge,
                )}
              >
                {status.label}
              </span>
            )}
            {pipeline && (
              <span
                data-testid="gitlab-pipeline-status"
                data-status={meta.pipeline_status}
                title={`Pipeline: ${pipeline.label}`}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  pipeline.badge,
                )}
              >
                <HugeiconsIcon
                  icon={pipeline.icon}
                  className={cn("size-3", pipeline.spin && "animate-spin")}
                  strokeWidth={2}
                  aria-hidden
                />
                {pipeline.label}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-faint">
            <span className="min-w-0 truncate">{meta.project_path}</span>
            {meta.reference && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 font-medium text-text-dim">{meta.reference}</span>
              </>
            )}
            {meta.author && (
              <>
                <span aria-hidden>·</span>
                <CardPerson person={meta.author} testId="gitlab-card-author" />
              </>
            )}
          </div>

          {meta.source_branch && meta.target_branch && (
            <div className="flex items-center gap-1 text-[11px] text-text-faint">
              <code className="min-w-0 truncate rounded bg-element px-1 py-0.5 font-mono text-[10px] text-text-dim">
                {meta.source_branch}
              </code>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className="size-3 shrink-0"
                strokeWidth={1.6}
              />
              <code className="min-w-0 truncate rounded bg-element px-1 py-0.5 font-mono text-[10px] text-text-dim">
                {meta.target_branch}
              </code>
            </div>
          )}

          {meta.description && (
            <p className="line-clamp-2 break-words text-xs text-text-dim">{meta.description}</p>
          )}

          {(labels.length > 0 || meta.milestone) && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              {meta.milestone && (
                <span className="min-w-0 truncate rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {meta.milestone}
                </span>
              )}
              {labels.slice(0, MAX_LABELS).map((label) => (
                <span
                  key={label}
                  className="min-w-0 truncate rounded bg-element px-1.5 py-0.5 text-[10px] text-text-dim"
                >
                  {label}
                </span>
              ))}
              {extraLabels > 0 && (
                <span className="text-[10px] text-text-faint">+{extraLabels}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </a>
  );
}
