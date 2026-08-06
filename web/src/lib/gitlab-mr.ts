// The merge-request page: its wire types, and every decision it makes about them.
//
// A mirror of `src/gitlab_mr.rs` and `src/gitlab_mr_write.rs` (the backend does the
// fetching; this page never touches the network), plus the pure rules the surface is built
// from — whether a merge can be offered, what a pipeline's state means, whether it is still
// worth polling, and how a pipeline's jobs group into stages.
//
// Everything here is pure: no DOM, no network, no React. That is deliberate for the one
// decision that matters most — **whether the Merge button is offered at all**. It is a
// button that lands somebody's branch, and what it may say is decided by unit-tested rules
// over GitLab's own `detailed_merge_status`, never by a component reading a status string
// and guessing.
//
// A PERSON is not here: `lib/tracker-people.ts` owns that type and the one decision about how
// somebody is drawn, because the preview cards name people too and one colleague must not be
// drawn two ways.

import type { DiffRefs } from "./gitlab-diff-comment";
import type { TrackerPerson } from "./tracker-people";

/** A GitLab person is a tracker person: one shape, one match rule, one way of drawing them
 *  (`personFace`). Kept as a name of its own because this file mirrors `gitlab_mr.rs`, whose
 *  own `Person` is the same re-export. */
export type GitLabPerson = TrackerPerson;

/** One row of the sidebar. Mirrors `gitlab_mr::MergeRequestRow`. */
export type MergeRequestRow = {
  project_path: string;
  iid: number;
  reference: string;
  title: string;
  state: string;
  draft: boolean;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: GitLabPerson;
  detailed_merge_status?: string;
  labels?: string[];
  user_notes_count: number;
  upvotes: number;
  downvotes: number;
  updated_at: string;
  created_at: string;
};

/** A page of rows. Mirrors `gitlab_mr::MergeRequestList`, plus the one field the HANDLER
 *  adds (`gitlab_mr_list` in src/bin/server.rs). */
export type MergeRequestList = {
  scope: string;
  state: string;
  items: MergeRequestRow[];
  total?: number;
  truncated: boolean;
  /** Whether this machine holds a GitLab token at all.
   *
   *  It rides the LIST answer rather than being read from the settings, because the read is
   *  the thing that needs the token — and because it must never come from a cached payload,
   *  which a token added or removed since would contradict. `undefined` on an older backend
   *  reads as "yes", so an app talking to one shows the list rather than a wrong notice. */
  token_set?: boolean;
};

/** Mirrors `gitlab_mr::PipelineSummary`. */
export type GitLabPipeline = {
  id: number;
  status: string;
  web_url?: string;
  source?: string;
  created_at?: string;
  updated_at?: string;
};

/** Mirrors `gitlab_mr::Job`. */
export type GitLabJob = {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure: boolean;
  duration?: number;
  web_url?: string;
  finished_at?: string;
};

/** Mirrors `gitlab_mr::PipelineView`. */
export type GitLabPipelineView = {
  pipeline?: GitLabPipeline;
  jobs?: GitLabJob[];
};

/** Mirrors `gitlab_mr::MergeRequestDetail`. */
export type MergeRequestDetail = {
  project_path: string;
  iid: number;
  reference: string;
  title: string;
  description?: string;
  state: string;
  draft: boolean;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: GitLabPerson;
  assignees?: GitLabPerson[];
  reviewers?: GitLabPerson[];
  labels?: string[];
  milestone?: string;
  sha?: string;
  /** The three commits a comment on a diff LINE is placed against. Mirrors
   *  `gitlab_mr::DiffRefs`; absent on an older backend, which is what
   *  `diffCommentsAvailable` reads as "this page cannot place a comment". */
  diff_refs?: DiffRefs;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts: boolean;
  blocking_discussions_resolved: boolean;
  squash: boolean;
  should_remove_source_branch?: boolean;
  changes_count?: string;
  user_notes_count: number;
  upvotes: number;
  downvotes: number;
  created_at: string;
  updated_at: string;
  merged_at?: string;
  closed_at?: string;
  pipeline?: GitLabPipeline;
};

/** Where a code comment hangs. Mirrors `gitlab_mr::NotePosition`.
 *
 *  The two line numbers are the ANCHOR — the one line the thread hangs under, which on a
 *  comment about several lines is the LAST of them. Exactly one is set on a line that exists
 *  on one side only, and both on a context line: GitLab's own convention, and what tells a
 *  reader whether a comment is about code that arrived, went, or stayed. */
export type GitLabNotePosition = {
  new_path?: string;
  old_path?: string;
  new_line?: number;
  old_line?: number;
  /** Both ends, when the comment was written about a RANGE. Absent on a comment about one
   *  line — a range of one is a line. Mirrors `gitlab_mr::NoteLineRange`. */
  line_range?: { start: GitLabNoteLineEnd; end: GitLabNoteLineEnd };
};

/** One end of such a range. Mirrors `gitlab_mr::NoteLineEnd`; `type` is GitLab's own word for
 *  the side, absent on a context line, which belongs to both. */
export type GitLabNoteLineEnd = { new_line?: number; old_line?: number; type?: string };

/** Mirrors `gitlab_mr::Note`. */
export type GitLabNote = {
  id: number;
  author: GitLabPerson;
  body: string;
  system: boolean;
  created_at: string;
  updated_at?: string;
  resolvable: boolean;
  resolved: boolean;
  mine: boolean;
  position?: GitLabNotePosition;
};

/** Mirrors `gitlab_mr::Discussion`. */
export type GitLabDiscussion = {
  id: string;
  individual_note: boolean;
  notes: GitLabNote[];
};

/** Mirrors `gitlab_mr::DiscussionList`. */
export type GitLabDiscussionList = {
  discussions: GitLabDiscussion[];
  truncated: boolean;
};

/** What one merge answered. Mirrors `gitlab_mr_write::MergeResult`. */
export type MergeOutcome = {
  state: string;
  merge_commit_sha?: string;
  merged_at?: string;
};

/** A comment GitLab stored. Mirrors `gitlab_mr_write::PostedNote`. */
export type PostedNote = {
  id: number;
  author: GitLabPerson;
  body: string;
  created_at: string;
  discussion_id?: string;
};

/** Which merge requests the sidebar asks for. The four the backend accepts, and no more. */
export type MergeRequestScope = "all" | "assigned" | "mine" | "reviewing";
/** Both halves of "not merged". `merged` is deliberately not a thing this page can ask. */
export type MergeRequestState = "opened" | "closed";

/** The label each scope wears in the sidebar's own filter. */
export const SCOPE_LABELS: Record<MergeRequestScope, string> = {
  all: "All",
  assigned: "Assigned",
  mine: "Mine",
  reviewing: "I review",
};

/** What each scope means, for the control's title — a four-way filter with one-word
 *  labels needs somewhere to say which is which. */
export const SCOPE_HINTS: Record<MergeRequestScope, string> = {
  all: "Every merge request this token can see",
  assigned: "Assigned to you",
  mine: "Opened by you",
  reviewing: "You are a reviewer",
};

/** One merge request, addressed the way every call and every URL addresses it. */
export type MergeRequestKey = { projectPath: string; iid: number };

/**
 * The id one merge request has in this app's own URL: `/mr/<project>!<iid>`, with the
 * project path percent-encoded so its slashes cannot become path segments.
 *
 * The pair is what the backend takes, so a deep link carries both — and it survives a
 * reload, which a numeric GitLab id would not, because a project's numeric id is not in
 * anything the sidebar shows.
 */
export function mergeRequestId(key: MergeRequestKey): string {
  return `${encodeURIComponent(key.projectPath)}!${key.iid}`;
}

/** The merge request one of those ids names, or `null` when it names none. */
export function parseMergeRequestId(id: string): MergeRequestKey | null {
  // The separator is the LAST `!`: a project path cannot hold one (GitLab forbids it),
  // but reading from the right is what makes that assumption harmless rather than load-
  // bearing.
  const cut = id.lastIndexOf("!");
  if (cut <= 0) return null;
  const iid = Number(id.slice(cut + 1));
  if (!Number.isInteger(iid) || iid <= 0) return null;
  let projectPath: string;
  try {
    projectPath = decodeURIComponent(id.slice(0, cut));
  } catch {
    return null; // a malformed escape is not an address
  }
  if (projectPath.trim() === "") return null;
  return { projectPath, iid };
}

/** True when the two names name the same merge request. */
export function sameMergeRequest(a: MergeRequestKey | null, b: MergeRequestKey | null): boolean {
  return !!a && !!b && a.iid === b.iid && a.projectPath === b.projectPath;
}

// ---- pipelines --------------------------------------------------------------

/** Pipeline and job states that are still in flight, so the page keeps polling.
 *
 *  Shared with the message list's own badge (`gitlab-pipeline.ts`) in meaning, and wider
 *  in membership: a JOB can also be `manual` or `waiting_for_callback`, and a page that
 *  stopped polling on the first manual job would freeze a pipeline that a colleague is
 *  about to start by hand. `manual` is deliberately NOT here for the pipeline itself —
 *  a pipeline blocked on a human is waiting on a person, not on time. */
export const ACTIVE_JOB_STATES: ReadonlySet<string> = new Set([
  "created",
  "waiting_for_resource",
  "waiting_for_callback",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);

/** What a status means, reduced to the four things a badge can say. Keeps every colour
 *  decision in one place: a component that mapped strings itself would drift the moment
 *  GitLab adds a state. */
export type PipelineTone = "running" | "success" | "failed" | "idle";

export function pipelineTone(status: string | null | undefined): PipelineTone {
  if (!status) return "idle";
  if (ACTIVE_JOB_STATES.has(status)) return "running";
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  // `canceled`, `skipped`, `manual`, `scheduled`, and anything GitLab adds next: neither
  // good news nor bad, and never mistaken for either.
  return "idle";
}

/** Whether a pipeline is still moving on its own, i.e. worth re-reading.
 *
 *  A pipeline whose own status is terminal but which still holds a running job is still
 *  live: GitLab reports the pipeline as `success` only once every required job is done, but
 *  an `allow_failure` job can keep running past that. So the JOBS decide too. */
export function pipelineIsLive(view: GitLabPipelineView | null | undefined): boolean {
  if (!view?.pipeline) return false;
  if (ACTIVE_JOB_STATES.has(view.pipeline.status)) return true;
  return (view.jobs ?? []).some((job) => ACTIVE_JOB_STATES.has(job.status));
}

/** One stage of a pipeline, in GitLab's own order. */
export type PipelineStage = { name: string; jobs: GitLabJob[] };

/** Group a pipeline's jobs into stages, keeping GitLab's order for both.
 *
 *  GitLab returns jobs in stage order already, so nothing is sorted here: a sort would
 *  invent an order (alphabetical) that contradicts the pipeline's real shape, and a stage
 *  named "🧪 test" would then come before "🏗 build". */
export function pipelineStages(jobs: GitLabJob[] | null | undefined): PipelineStage[] {
  const stages: PipelineStage[] = [];
  for (const job of jobs ?? []) {
    const last = stages[stages.length - 1];
    // Consecutive jobs of one stage join it; a stage that reappears later (GitLab can
    // interleave retried jobs) gets its own group rather than being merged backwards,
    // because merging would move a job away from the run it belongs to.
    if (last && last.name === job.stage) last.jobs.push(job);
    else stages.push({ name: job.stage, jobs: [job] });
  }
  return stages;
}

/** The worst thing that happened in a stage, for its own badge. A stage is red when any
 *  job that COUNTS failed, running while any job runs, and green only when nothing is
 *  either. A job allowed to fail never turns a stage red — that is what allowing it
 *  means. */
export function stageTone(stage: PipelineStage): PipelineTone {
  if (stage.jobs.some((job) => ACTIVE_JOB_STATES.has(job.status))) return "running";
  if (stage.jobs.some((job) => job.status === "failed" && !job.allow_failure)) return "failed";
  if (stage.jobs.every((job) => job.status === "success")) return "success";
  return "idle";
}

/** A job's duration as a person reads it: "1m 12s", "4s", or nothing when it has not run. */
export function formatJobDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// ---- what the page may offer ------------------------------------------------

/**
 * Whether the MERGE button is offered, and what it says when it is not.
 *
 * The decision is GitLab's own `detailed_merge_status`, which is what its own merge button
 * reads. Three rules hold this together, and each exists because the alternative is worse:
 *
 *   - **An unknown status is not a green light.** A GitLab version that reports something
 *     this app has never heard of leaves the button DISABLED with the raw reason on it. A
 *     merge is irreversible, so "I do not recognise this state" must never resolve to
 *     "go ahead".
 *   - **A missing status is not a green light either.** Older instances report only
 *     `merge_status`, and `can_be_merged` there is the one value that means yes.
 *   - **`checking` is temporary, and says so.** GitLab is still working out whether the
 *     branch merges; the button waits rather than claiming a conflict.
 */
export type MergeVerdict = {
  /** Whether the button may be pressed. */
  can: boolean;
  /** One line saying why not — or, when it can, what the merge will do. */
  reason: string;
  /** True while GitLab has not finished deciding, so the UI can say "checking…" instead
   *  of naming a blocker that may not exist. */
  checking: boolean;
};

/** GitLab's `detailed_merge_status` values, and what each one means to a reader. Only
 *  `mergeable` is a yes; every other known value is a specific no, and anything absent
 *  from this table is an unknown no. */
const MERGE_BLOCKERS: Record<string, string> = {
  not_approved: "It still needs an approval.",
  not_open: "It is not open.",
  draft_status: "It is marked as a draft.",
  ci_must_pass: "Its pipeline has to pass first.",
  ci_still_running: "Its pipeline is still running.",
  discussions_not_resolved: "A thread on it is unresolved.",
  conflict: "It conflicts with the target branch.",
  need_rebase: "It has to be rebased first.",
  broken_status: "GitLab cannot merge it as it stands.",
  blocked_status: "Another merge request blocks it.",
  policies_denied: "A project policy denies it.",
  requested_changes: "A reviewer requested changes.",
  jira_association_missing: "It has no Jira issue, which this project requires.",
  approvals_syncing: "GitLab is still counting its approvals.",
  security_policy_violations: "A security policy is not satisfied.",
  locked_paths: "It touches locked paths.",
  locked_lfs_files: "It touches locked LFS files.",
};

export function mergeVerdict(detail: MergeRequestDetail | null | undefined): MergeVerdict {
  if (!detail) return { can: false, reason: "Nothing is open.", checking: false };
  if (detail.state !== "opened") {
    return { can: false, reason: `This merge request is ${detail.state}.`, checking: false };
  }

  const status = detail.detailed_merge_status;
  if (status === "mergeable") {
    return {
      can: true,
      reason: `Merges ${detail.source_branch} into ${detail.target_branch}.`,
      checking: false,
    };
  }
  if (status === "checking" || status === "unchecked" || status === "preparing") {
    return {
      can: false,
      reason: "GitLab is still checking whether it can merge.",
      checking: true,
    };
  }
  if (status) {
    return {
      can: false,
      // An unknown state keeps GitLab's own word rather than a guess. It reads as a code
      // because it is one, which is honest: this app does not know what it means.
      reason: MERGE_BLOCKERS[status] ?? `GitLab reports "${status}".`,
      checking: false,
    };
  }

  // No detailed status at all: an older GitLab. `can_be_merged` is its yes.
  if (detail.merge_status === "can_be_merged" && !detail.has_conflicts) {
    return {
      can: true,
      reason: `Merges ${detail.source_branch} into ${detail.target_branch}.`,
      checking: false,
    };
  }
  if (detail.merge_status === "checking" || detail.merge_status === "unchecked") {
    return { can: false, reason: "GitLab is still checking whether it can merge.", checking: true };
  }
  return {
    can: false,
    reason: detail.has_conflicts
      ? "It conflicts with the target branch."
      : "GitLab does not report it as mergeable.",
    checking: false,
  };
}

/** What the state control offers next: closing an open merge request, or reopening a
 *  closed one. `null` for a merged one — there is nothing to undo, and GitLab offers
 *  nothing either. */
export function stateChangeFor(
  detail: MergeRequestDetail | null | undefined,
): "close" | "reopen" | null {
  if (!detail) return null;
  if (detail.state === "opened") return "close";
  if (detail.state === "closed") return "reopen";
  return null;
}

/** The one-word label a row's own state wears. GitLab calls a draft "opened" and marks it
 *  separately, so the sidebar says which it is in one place. */
export function rowStateLabel(row: MergeRequestRow): string {
  if (row.draft) return "Draft";
  if (row.state === "opened") return "Open";
  if (row.state === "closed") return "Closed";
  return row.state;
}

/** Whether a merge request is one this page shows at all. The backend only ever asks for
 *  the two non-merged states, and this is the same rule applied to whatever arrives — a
 *  merged row landing here (a live refresh that crossed a merge) is dropped rather than
 *  drawn in a list whose whole promise is "not merged". */
export function isNotMerged(row: MergeRequestRow): boolean {
  return row.state !== "merged";
}

/** The notes of one discussion, split into what a person said and what GitLab recorded.
 *  A timeline of "changed the description" ten times is noise between two real comments,
 *  so the page draws the two differently — and a discussion that is ONLY system notes is
 *  an event, not a conversation. */
export function isSystemOnly(discussion: GitLabDiscussion): boolean {
  return discussion.notes.every((note) => note.system);
}

/** Discussions in the order the page draws them: every real conversation, then nothing
 *  else. System events are kept apart by {@link isSystemOnly} and drawn as a timeline. */
export function conversationDiscussions(list: GitLabDiscussionList | null): GitLabDiscussion[] {
  return (list?.discussions ?? []).filter((discussion) => !isSystemOnly(discussion));
}

/** The system events of a merge request, oldest first — one flat list, because a thread of
 *  one automated line is not a thread. */
export function systemNotes(list: GitLabDiscussionList | null): GitLabNote[] {
  return (list?.discussions ?? [])
    .filter(isSystemOnly)
    .flatMap((discussion) => discussion.notes);
}

/** The description's own type: 13px over a 1.625 leading, which is what makes "a line" a
 *  NUMBER this file can reason about. The component sets both from these constants rather
 *  than from a class, so the fold below and the text it folds cannot disagree. */
export const DESCRIPTION_FONT_PX = 13;
export const DESCRIPTION_LINE_HEIGHT = 1.625;

/** How much of a long description is shown before the reader asks for the rest, and how
 *  much of that window the fade covers. The fade sits INSIDE the eight, so a folded
 *  description reads as five clear lines running out rather than as eight cut off. */
export const DESCRIPTION_LINES_SHOWN = 8;
export const DESCRIPTION_LINES_FADED = 3;

/** One line of the description, in px. */
export const DESCRIPTION_LINE_PX = DESCRIPTION_FONT_PX * DESCRIPTION_LINE_HEIGHT;

/** The height a folded description takes, in px. It is a constant rather than a measurement
 *  because the box has to be the right size on its FIRST paint: a description drawn whole
 *  and then clipped a frame later is a jump the reader watches. */
export const DESCRIPTION_COLLAPSED_PX = Math.round(DESCRIPTION_LINE_PX * DESCRIPTION_LINES_SHOWN);

/** The height of the gradient over the foot of a folded description, in px. */
export const DESCRIPTION_FADE_PX = Math.round(DESCRIPTION_LINE_PX * DESCRIPTION_LINES_FADED);

/** Whether a description of this height is worth folding at all.
 *
 *  Two states are deliberately NOT collapsible, and each is a control that would read as a
 *  bug. A description that already fits keeps no button — there is nothing behind it. And
 *  one that overruns by less than a single line keeps none either: hiding half a line behind
 *  a click, under a gradient covering three, costs the reader more than it saves.
 *
 *  `contentHeight` of 0 is the answer before anything is measured, and it reads as "do not
 *  offer one yet": the fold itself is a constant, so nothing moves when the measurement
 *  arrives — only the button and the gradient appear. */
export function descriptionIsFoldable(contentHeight: number): boolean {
  return contentHeight > DESCRIPTION_COLLAPSED_PX + DESCRIPTION_LINE_PX;
}

/** How many unresolved threads a merge request holds, for the header's own count. Counts
 *  THREADS rather than notes: five replies under one objection is one thing to settle. */
export function unresolvedThreadCount(list: GitLabDiscussionList | null): number {
  return (list?.discussions ?? []).filter(
    (discussion) =>
      !discussion.individual_note &&
      discussion.notes.some((note) => note.resolvable && !note.resolved),
  ).length;
}
