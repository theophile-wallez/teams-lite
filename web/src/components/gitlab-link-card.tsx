import {
  ArrowRight,
  CircleDot,
  FolderGit2,
  GitPullRequestArrow,
  type LucideIcon,
} from "lucide-react";
import type { GitLabLinkKind, GitLabLinkMetadata } from "~/lib/protocol";
import { cn } from "~/lib/utils";

const KIND_ICON: Record<GitLabLinkKind, LucideIcon> = {
  merge_request: GitPullRequestArrow,
  issue: CircleDot,
  project: FolderGit2,
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

const MAX_LABELS = 4;

/**
 * A rich preview card for a GitLab link (merge request, issue, or project),
 * rendered from already-resolved metadata. It shows title, state, reference,
 * author, branches, milestone, labels, and a short description, and is itself the
 * clickable link to the resource. Enrichment (and its caching) is owned by the
 * caller (see MessageBubble), so this component is pure and always renders.
 */
export function GitLabLinkCard(props: { metadata: GitLabLinkMetadata }) {
  const meta = props.metadata;
  const Icon = KIND_ICON[meta.kind];
  const status = statusStyle(meta);
  const labels = meta.labels ?? [];
  const extraLabels = labels.length - MAX_LABELS;

  return (
    <a
      href={meta.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="gitlab-link-card"
      data-kind={meta.kind}
      className="block max-w-md rounded-xl bg-card px-3 py-2.5 text-foreground shadow-chip transition-shadow hover:shadow-card"
    >
      <div className="flex items-start gap-2.5">
        <Icon
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
          </div>

          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-faint">
            <span className="truncate">{meta.project_path}</span>
            {meta.reference && (
              <>
                <span aria-hidden>·</span>
                <span className="font-medium text-text-dim">{meta.reference}</span>
              </>
            )}
            {meta.author_name && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{meta.author_name}</span>
              </>
            )}
          </div>

          {meta.source_branch && meta.target_branch && (
            <div className="flex items-center gap-1 text-[11px] text-text-faint">
              <code className="rounded bg-element px-1 py-0.5 font-mono text-[10px] text-text-dim">
                {meta.source_branch}
              </code>
              <ArrowRight className="size-3 shrink-0" strokeWidth={1.6} />
              <code className="rounded bg-element px-1 py-0.5 font-mono text-[10px] text-text-dim">
                {meta.target_branch}
              </code>
            </div>
          )}

          {meta.description && (
            <p className="line-clamp-2 text-xs text-text-dim">{meta.description}</p>
          )}

          {(labels.length > 0 || meta.milestone) && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              {meta.milestone && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {meta.milestone}
                </span>
              )}
              {labels.slice(0, MAX_LABELS).map((label) => (
                <span
                  key={label}
                  className="rounded bg-element px-1.5 py-0.5 text-[10px] text-text-dim"
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
