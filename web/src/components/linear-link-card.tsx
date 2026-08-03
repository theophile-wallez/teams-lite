import type { CSSProperties } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  CircleXIcon,
  CornerDownRightIcon,
  File02Icon,
  KanbanIcon,
  SignalMedium01Icon,
} from "@hugeicons/core-free-icons";
import {
  badgedPriority,
  formatDueDate,
  progressPercent,
  stateColor,
  stateShape,
  type BadgedPriority,
  type StateShape,
} from "~/lib/linear";
import type { LinearLinkKind, LinearLinkMetadata } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { LinearLogo } from "./linear-logo";

/** The icon each state category is drawn with, following Linear's own set: an
 *  empty circle before work starts, a dashed one in the backlog, a half-filled one
 *  in progress, a tick when done, a cross when dropped. */
const STATE_ICON: Record<StateShape, IconSvgElement> = {
  backlog: CircleDashedIcon,
  unstarted: CircleIcon,
  started: CircleDotDashedIcon,
  completed: CircleCheckIcon,
  canceled: CircleXIcon,
};

/** The fallback tint per category, for a workspace whose state carries no usable
 *  colour. Linear's own hues, so a card without a colour still reads right. */
const STATE_FALLBACK: Record<StateShape, string> = {
  backlog: "text-text-faint",
  unstarted: "text-text-dim",
  started: "text-amber-600 dark:text-amber-400",
  completed: "text-violet-600 dark:text-violet-400",
  canceled: "text-text-faint",
};

/** The icon that stands for the resource itself, shown when there is no state to
 *  draw (a project's status is optional; a document has none at all). */
const KIND_ICON: Record<LinearLinkKind, IconSvgElement> = {
  issue: CircleIcon,
  project: KanbanIcon,
  document: File02Icon,
};

type PriorityStyle = { label: string; badge: string; icon: IconSvgElement };

/** Urgent and High only — see `badgedPriority`. Urgent gets the alarming colour
 *  because it is the one a reader must not scroll past. */
const PRIORITY_STYLE: Record<BadgedPriority, PriorityStyle> = {
  1: {
    label: "Urgent",
    badge: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
    icon: Alert02Icon,
  },
  2: {
    label: "High",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    icon: SignalMedium01Icon,
  },
};

const MAX_LABELS = 3;

/**
 * A rich preview card for a Linear link (issue, project, or document), rendered
 * from already-resolved metadata. It shows the title, the workflow state, who owns
 * it, and the details that kind carries — an issue's identifier, labels and due
 * date; a project's progress; a document's project — and is itself the clickable
 * link to the resource. Enrichment (and its caching) is owned by the caller (see
 * MessageBubble), so this component is pure and always renders.
 *
 * It deliberately matches GitLabLinkCard's frame — same surface, radius, shadow and
 * type scale — so a conversation quoting both trackers reads as one list of cards
 * rather than two competing widgets. What differs is only what each tracker knows.
 *
 * The card spans its container: alongside text it fills the bubble's width so it
 * lines up with the message body, and on its own the bubble's cap sizes it.
 */
export function LinearLinkCard(props: { metadata: LinearLinkMetadata }) {
  const meta = props.metadata;
  const shape = stateShape(meta.state_type);
  const color = stateColor(meta.state_color);
  // The state icon when Linear gave us a category, else the resource's own icon.
  const icon = shape ? STATE_ICON[shape] : KIND_ICON[meta.kind];
  const level = badgedPriority(meta.priority);
  const priority = level ? PRIORITY_STYLE[level] : undefined;
  const labels = meta.labels ?? [];
  const extraLabels = labels.length - MAX_LABELS;
  const percent = progressPercent(meta.progress);
  const due = formatDueDate(meta.due_date ?? meta.target_date);
  // One faint line of context under the title: who owns this, and where it lives.
  const owner = meta.assignee_name ?? meta.lead_name ?? meta.creator_name;
  const context = [meta.identifier, meta.team, meta.project, owner].filter(Boolean) as string[];

  return (
    <a
      href={meta.url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="linear-link-card"
      data-kind={meta.kind}
      data-state-type={meta.state_type}
      // `linear-state` derives two legible treatments from the workspace's own state
      // colour (see app.css); without a colour the class costs nothing and the
      // category tints below apply instead.
      className={cn(
        "block w-full rounded-xl bg-card px-3 py-2.5 text-foreground shadow-chip transition-shadow hover:shadow-card",
        color && "linear-state",
      )}
      style={color ? ({ "--state-color": color } as CSSProperties) : undefined}
    >
      <div className="flex items-start gap-2.5">
        <HugeiconsIcon
          icon={icon}
          className={cn(
            "mt-0.5 size-4 shrink-0",
            // The workspace's colour when it gave us one, our own category tint
            // otherwise. Never the raw hex: see `.linear-state` in app.css.
            color ? "linear-state-icon" : shape ? STATE_FALLBACK[shape] : "text-primary",
          )}
          strokeWidth={1.6}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {meta.title}
            </span>
            {meta.state && (
              <span
                data-testid="linear-state"
                className={cn(
                  "shrink-0 rounded-full bg-element px-1.5 py-0.5 text-[10px] font-semibold",
                  color ? "linear-state-label" : "text-text-dim",
                )}
              >
                {meta.state}
              </span>
            )}
            {priority && (
              <span
                data-testid="linear-priority"
                data-priority={meta.priority}
                title={`Priority: ${meta.priority_label ?? priority.label}`}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  priority.badge,
                )}
              >
                <HugeiconsIcon
                  icon={priority.icon}
                  className="size-3"
                  strokeWidth={2}
                  aria-hidden
                />
                {priority.label}
              </span>
            )}
          </div>

          {/* The source line. Linear's own mark opens it, because a card that says
              "ENG-1 · Engineering" says nothing about which tracker it came from —
              and this card shares its frame with GitLab's on purpose. The mark
              carries the name for a screen reader, so the row always renders, even
              for a document that has no identifier, team, project or owner. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-faint">
            <LinearLogo title="Linear" className="size-3 shrink-0" />
            {context.map((part, index) => (
              <span key={`${part}-${index}`} className="flex items-center gap-1.5">
                {index > 0 && <span aria-hidden>·</span>}
                <span
                  className={cn(
                    "truncate",
                    // The identifier is the handle people speak in ("ENG-123"),
                    // so it reads a step stronger than the rest of the line.
                    part === meta.identifier && "font-medium text-text-dim",
                  )}
                >
                  {part}
                </span>
              </span>
            ))}
          </div>

          {meta.parent && (
            <div className="flex items-center gap-1 text-[11px] text-text-faint">
              <HugeiconsIcon
                icon={CornerDownRightIcon}
                className="size-3 shrink-0"
                strokeWidth={1.6}
                aria-hidden
              />
              <span className="truncate">Sub-issue of {meta.parent}</span>
            </div>
          )}

          {meta.description && (
            <p className="line-clamp-2 text-xs text-text-dim">{meta.description}</p>
          )}

          {percent !== null && (
            <div
              className="flex items-center gap-2 pt-0.5"
              data-testid="linear-progress"
              data-percent={percent}
            >
              <span
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-element"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Project progress"
              >
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span className="shrink-0 text-[10px] font-medium text-text-faint">{percent}%</span>
            </div>
          )}

          {(labels.length > 0 || due) && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              {due && (
                <span
                  data-testid="linear-due"
                  className="rounded bg-element px-1.5 py-0.5 text-[10px] font-medium text-text-dim"
                >
                  {due}
                </span>
              )}
              {labels.slice(0, MAX_LABELS).map((label) => {
                const labelColor = stateColor(label.color);
                return (
                  <span
                    key={label.name}
                    className="flex items-center gap-1 rounded bg-element px-1.5 py-0.5 text-[10px] text-text-dim"
                  >
                    {labelColor && (
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: labelColor }}
                        aria-hidden
                      />
                    )}
                    {label.name}
                  </span>
                );
              })}
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
