import { useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  Message01Icon,
  RefreshIcon,
  ThumbsUpIcon,
} from "@hugeicons/core-free-icons";
import {
  SCOPE_HINTS,
  SCOPE_LABELS,
  mergeRequestId,
  rowStateLabel,
  sameMergeRequest,
  type MergeRequestRow,
  type MergeRequestScope,
  type MergeRequestState,
} from "~/lib/gitlab-mr";
import { personFace } from "~/lib/tracker-people";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { useAppState, useController } from "./controller-context";
import { GitLabLogo, GitLabLogoOutline } from "./gitlab-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

// The GitLab tab's sidebar surface: the merge requests that are NOT merged, in the same
// shape as the Chats and Mail tabs — a filter above a virtualized list of rows whose
// selection drives the shared detail pane. One app, five sections; not a second
// application wearing this one's chrome.
//
// **A row carries no pipeline badge, and that is measured rather than forgotten.** GitLab's
// list endpoint answers without `head_pipeline` (verified against the tenant — see the
// module header of src/gitlab_mr.rs), so a status per row would cost one request per merge
// request: 109 of them on the first screen of this instance. What the row states instead is
// `detailed_merge_status`, which IS on the row and is what GitLab's own merge button reads.
// The pipeline lives on the page, where it is polled live.

/** Row height for the three-line row (project, title, chips). */
const ROW_HEIGHT = 78;

/** The scopes the filter offers, in the order it offers them. */
const SCOPES: MergeRequestScope[] = ["all", "assigned", "mine", "reviewing"];

/** The short reason a row's own `detailed_merge_status` stands for. A chip has room for two
 *  words, and the page says the rest — so this is deliberately terser than
 *  `mergeVerdict`'s sentence, and only for the states worth flagging in a list. */
const ROW_BLOCKERS: Record<string, string> = {
  not_approved: "Needs approval",
  ci_must_pass: "CI must pass",
  ci_still_running: "CI running",
  discussions_not_resolved: "Unresolved",
  conflict: "Conflicts",
  need_rebase: "Needs rebase",
  draft_status: "Draft",
  blocked_status: "Blocked",
  requested_changes: "Changes asked",
  mergeable: "Ready",
};

/** Compact relative time for a row. Mirrors the chat and mail sidebars, so all three
 *  lists read alike. */
function formatUpdated(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (now.getTime() - date.getTime() < 7 * dayMs) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

export function GitLabSidebar() {
  const controller = useController();
  const rows = useAppState((s) => s.gitlabList);
  const scope = useAppState((s) => s.gitlabScope);
  const state = useAppState((s) => s.gitlabState);
  const loading = useAppState((s) => s.gitlabListLoading);
  const error = useAppState((s) => s.gitlabListError);
  const total = useAppState((s) => s.gitlabTotal);
  const truncated = useAppState((s) => s.gitlabTruncated);
  const tokenSet = useAppState((s) => s.gitlabTokenSet);
  const open = useAppState((s) => s.openMergeRequest);
  const navigate = useNavigate();

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => {
      const row = rows[index];
      return row ? `${row.project_path}!${row.iid}` : index;
    },
    overscan: 10,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitLabFilter
        scope={scope}
        state={state}
        loading={loading}
        onScope={(next) => controller.setGitLabScope(next)}
        onState={(next) => controller.setGitLabState(next)}
        onReload={() => void controller.reloadMergeRequests()}
      />

      {/* No token means the page can read nothing at all, so it says that — and where to
          fix it — instead of showing an empty list somebody would read as "no work". */}
      {!tokenSet ? (
        <p
          data-testid="gitlab-no-token"
          className="px-6 py-6 text-center text-[13px] text-text-faint"
        >
          Add a GitLab token in Settings → Integrations to see your merge requests.
        </p>
      ) : error && rows.length === 0 ? (
        <p
          data-testid="gitlab-list-error"
          className="px-4 py-6 text-center text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : loading && rows.length === 0 ? (
        <GitLabListSkeleton />
      ) : rows.length === 0 ? (
        <p
          data-testid="gitlab-list-empty"
          className="px-6 py-6 text-center text-[13px] text-text-faint"
        >
          {state === "opened"
            ? "No open merge requests here."
            : "No closed merge requests here."}
        </p>
      ) : (
        <div
          ref={parentRef}
          data-testid="gitlab-scroll"
          className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2"
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={`${row.project_path}!${row.iid}`}
                  className="absolute left-0 top-0 w-full"
                  style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${item.start}px)` }}
                >
                  <MergeRequestSidebarRow
                    row={row}
                    open={sameMergeRequest(open, { projectPath: row.project_path, iid: row.iid })}
                    onClick={() =>
                      void navigate({
                        to: "/mr/$mergeRequestId",
                        params: {
                          mergeRequestId: mergeRequestId({
                            projectPath: row.project_path,
                            iid: row.iid,
                          }),
                        },
                      })
                    }
                  />
                </div>
              );
            })}
          </div>

          {/* What the list left out, counted. GitLab is asked for one page of 100; a list
              that stopped without saying so would read as a complete one. */}
          {truncated && total != null && (
            <p
              data-testid="gitlab-truncated"
              className="px-3 py-3 text-center text-[11px] text-text-faint"
            >
              {total} match — the {rows.length} most recently updated are shown.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The two filters, and a reload. `state` is a two-way switch because it has exactly two
 *  values and both are one word; `scope` is a dropdown because it has four and one of them
 *  ("I review") needs a sentence to explain it. */
function GitLabFilter(props: {
  scope: MergeRequestScope;
  state: MergeRequestState;
  loading: boolean;
  onScope: (scope: MergeRequestScope) => void;
  onState: (state: MergeRequestState) => void;
  onReload: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-2">
      <Tabs
        value={props.state}
        onValueChange={(value) => props.onState(value as MergeRequestState)}
        className="min-w-0 flex-1"
      >
        <TabsList aria-label="Merge request state" className="w-full">
          <TabsTrigger
            value="opened"
            data-testid="gitlab-state-opened"
            className="py-1 text-[12px] data-[state=active]:text-primary"
          >
            Open
          </TabsTrigger>
          <TabsTrigger
            value="closed"
            data-testid="gitlab-state-closed"
            className="py-1 text-[12px] data-[state=active]:text-primary"
          >
            Closed
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="gitlab-scope-picker"
          data-scope={props.scope}
          title={SCOPE_HINTS[props.scope]}
          data-cuelume-press=""
          className={cn(
            "shrink-0 rounded-lg bg-card px-2.5 py-1.5 text-[12px] font-medium text-foreground",
            "shadow-chip transition-colors hover:bg-accent",
          )}
        >
          {SCOPE_LABELS[props.scope]}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px]">
          {SCOPES.map((scope) => (
            <DropdownMenuItem
              key={scope}
              data-testid="gitlab-scope-option"
              data-scope={scope}
              onSelect={() => props.onScope(scope)}
              className={cn("flex flex-col items-start gap-0.5", scope === props.scope && "bg-accent")}
            >
              <span className="text-[13px]">{SCOPE_LABELS[scope]}</span>
              <span className="text-[11px] text-text-faint">{SCOPE_HINTS[scope]}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        data-testid="gitlab-reload"
        aria-label="Reload merge requests"
        title="Reload from GitLab"
        data-cuelume-press=""
        onClick={props.onReload}
        className="grid size-7 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon
          icon={props.loading ? Loading02Icon : RefreshIcon}
          className={cn("size-3.5", props.loading && "animate-spin")}
          strokeWidth={1.6}
        />
      </button>
    </div>
  );
}

/** One merge request in the sidebar: whose it is, where it lives, what it is called, and
 *  the one thing standing between it and the target branch. */
function MergeRequestSidebarRow(props: {
  row: MergeRequestRow;
  open: boolean;
  onClick: () => void;
}) {
  const row = props.row;
  const author = useMemo(() => personFace(row.author), [row.author]);
  const updated = useMemo(() => formatUpdated(row.updated_at), [row.updated_at]);
  const stateLabel = rowStateLabel(row);
  const named = row.detailed_merge_status
    ? ROW_BLOCKERS[row.detailed_merge_status]
    : undefined;
  // A draft's own blocker IS that it is a draft, so the row would otherwise wear "Draft"
  // twice. One chip per thing said.
  const blocker = named === stateLabel ? undefined : named;

  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid="gitlab-row"
      data-project={row.project_path}
      data-iid={row.iid}
      // Who the face stands for. The row has no room for a name — three lines are already
      // the project, the title and the blockers — so this is where the author is stated.
      data-author={author.label}
      data-open={props.open ? "true" : undefined}
      data-draft={row.draft ? "true" : undefined}
      aria-current={props.open ? "true" : undefined}
      className={cn(
        "my-0.5 flex h-[74px] w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-all",
        props.open ? "bg-row-open shadow-card" : "hover:bg-row-hovered",
      )}
    >
      {/* The author's real face when this is somebody the user's Teams knows, fetched
          through the backend like every other avatar here; tinted initials otherwise.
          GitLab's own avatar URL is never requested — see `personFace`. */}
      <Avatar
        seed={author.seed}
        label={author.label}
        photo={author.photo}
        fallback="person"
        className="mt-0.5 size-7 text-[10px]"
        testId="gitlab-author"
      />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            data-testid="gitlab-row-project"
            className="min-w-0 flex-1 truncate text-[11px] text-text-faint"
          >
            {row.project_path}
          </span>
          {updated && (
            <time className="shrink-0 text-[11px] tabular-nums text-text-faint">{updated}</time>
          )}
        </span>

        <span className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-[12px] font-medium tabular-nums text-text-dim">
            {row.reference}
          </span>
          <span
            data-testid="gitlab-row-title"
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              props.open ? "font-medium text-foreground" : "text-foreground",
            )}
          >
            {row.title}
          </span>
        </span>

        <span className="flex items-center gap-1.5">
          {(row.draft || row.state !== "opened") && (
            <span
              data-testid="gitlab-row-state"
              className="shrink-0 rounded bg-element px-1.5 py-px text-[10px] font-medium text-text-dim"
            >
              {stateLabel}
            </span>
          )}
          {blocker && (
            <span
              data-testid="gitlab-row-blocker"
              data-status={row.detailed_merge_status}
              className={cn(
                "min-w-0 truncate rounded px-1.5 py-px text-[10px] font-medium",
                row.detailed_merge_status === "mergeable"
                  ? "bg-primary/12 text-primary"
                  : "bg-element text-text-faint",
              )}
            >
              {blocker}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-text-faint">
            {row.upvotes > 0 && (
              <span className="flex items-center gap-0.5">
                <HugeiconsIcon icon={ThumbsUpIcon} className="size-3" strokeWidth={1.6} aria-hidden />
                {row.upvotes}
              </span>
            )}
            {row.user_notes_count > 0 && (
              <span className="flex items-center gap-0.5" title={`${row.user_notes_count} comments`}>
                <HugeiconsIcon icon={Message01Icon} className="size-3" strokeWidth={1.6} aria-hidden />
                {row.user_notes_count}
              </span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}

/** How many placeholder rows the skeleton draws. */
const SKELETON_ROWS = 8;

/** Per-row bar widths, a fixed cycle so a screenshot is reproducible (the mail list makes
 *  the same choice for the same reason). */
const SKELETON_WIDTHS = [
  { project: "w-28", title: "w-44" },
  { project: "w-36", title: "w-32" },
  { project: "w-24", title: "w-48" },
  { project: "w-32", title: "w-36" },
];

/** The first load: the rows that are coming, drawn as quiet bars, so the column keeps its
 *  geometry and nothing jumps when the merge requests land. */
function GitLabListSkeleton() {
  return (
    <div
      data-testid="gitlab-list-loading"
      className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2"
      aria-busy="true"
      aria-hidden
    >
      {Array.from({ length: SKELETON_ROWS }, (_, index) => {
        const width = SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]!;
        return (
          <div
            key={index}
            className="my-0.5 flex h-[74px] shrink-0 animate-pulse items-start gap-3 px-2.5 py-2"
            style={{ animationDelay: `${index * 90}ms` }}
          >
            <span className="mt-0.5 size-7 shrink-0 rounded-full bg-text-faint/20" />
            <span className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
              <span className={cn("h-2.5 rounded bg-text-faint/15", width.project)} />
              <span className={cn("h-3 rounded bg-text-faint/25", width.title)} />
              <span className="h-2.5 w-20 rounded bg-text-faint/15" />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The mark the sidebar's own tab wears. Kept here so the tab strip imports one thing per
 *  section, like the others.
 *
 *  Two spellings of one mark, and the tab's own state picks: GitLab's line at rest, so the
 *  tanuki sits in the strip the way its four neighbours do, and GitLab's colours once the
 *  section is the current one — which is where every other tab takes the accent. The swap is
 *  CSS over the trigger's `data-state` (hence `group` on it), so nothing here has to be told
 *  which tab is open. */
export function GitLabTabIcon() {
  return (
    <>
      <GitLabLogoOutline className="size-[17px] group-data-[state=active]:hidden" />
      <GitLabLogo className="hidden size-[17px] group-data-[state=active]:block" />
    </>
  );
}
