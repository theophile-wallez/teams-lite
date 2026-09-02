// What an AI reading of a diff is DOING, while it does it.
//
// The mirror of `gitlab_review::RunStage` / `RunProgress` (src/gitlab_review.rs), plus the one pure
// decision this surface is built from: turning one frame into the rows a reader watches.
//
// **A RUN USED TO SAY ONE WORD FOR ALL OF IT.** The press was answered with "Reading the changes…"
// on the button and nothing else, for a run that is tens of seconds at best and has a 35-minute
// ceiling (`AGENT_REQUEST_TIMEOUT_MS`). So the reader could not tell apart the three things that
// really happen — a merge request GitLab would not answer for, a diff of half a megabyte coming
// down, and a model thinking — which are seconds, seconds and minutes, and have different next
// moves. A reader who cannot see which one they are in has no way to know whether waiting is the
// right thing to do.
//
// **EVERY VALUE DRAWN HERE IS MEASURED, and that is the rule the whole surface rests on.** There is
// no percentage, no bar and no estimated time, because nothing on either side of the socket knows
// how long a model will think — a run's own bound is SILENCE rather than a clock (§ The local
// agent). What is drawn instead is what really happened: the commit that was read, how many files
// the diff holds, how much patch went into the prompt, and how much answer has come back. A
// progress bar here would be the one part of this page a reader could catch lying.
//
// Everything here is pure: no DOM, no network, no React. That is the split `gitlab-review.ts`
// already holds, and it is what lets the row mapping be unit-tested for every stage without a
// browser.

import type { TaskRow, TaskState } from "../components/task-rows";
// The GitLab side's own byte formatter, reused rather than respelled: it already answers `null` for
// "nothing to say", which is exactly the shape every value on these rows takes.
import { formatBytes } from "./gitlab-job-log";

/** Where a reading has got to. Mirrors `gitlab_review::RunStage`, and the ORDER is the meaning:
 *  everything before the current stage is finished, which is what lets one frame say everything.
 *
 *  `gitlab_review::stage_tests` pins the same five spellings on the other side of the socket. */
export const REVIEW_RUN_STAGES = ["detail", "diff", "asking", "writing", "done"] as const;

export type ReviewRunStage = (typeof REVIEW_RUN_STAGES)[number];

/** One `gitlab_mr_review_progress` frame. Mirrors `gitlab_review::RunProgress` plus the envelope
 *  `review_progress_frame` wraps it in.
 *
 *  The WHOLE state arrives every time, never a delta, so folding a frame is an assignment: a page
 *  that connected mid-run or missed one under load draws exactly what a page that saw them all
 *  draws. Every field but `stage` is optional, because a frame is emitted before the fact it would
 *  carry is known — the commit is unknown until the first read answers, and the model's name until
 *  the prompt is built. */
export type ReviewRunProgress = {
  /** WHICH run. Two pages can ask about one merge request, so a frame from a run this page is not
   *  watching is ignored rather than folded — without it an older run's `done` would take the rows
   *  down under a newer one that is still going. */
  runId: string;
  projectPath: string;
  iid: number;
  stage: ReviewRunStage;
  headSha: string;
  files: number;
  promptBytes: number;
  truncated: boolean;
  filesUnseen: number;
  backend: string;
  model: string;
  answerBytes: number;
  themes: number;
  /** Why it stopped, in the backend's or the CLI's own words. The `stage` then says WHERE it
   *  stopped, so the rows before it are still drawn as finished. */
  error: string | null;
};

/** Read one frame off the wire.
 *
 *  A frame whose stage this build does not know is REFUSED rather than defaulted, and that is the
 *  narrow direction: a stage read as `detail` would draw a run that is nearly finished as one that
 *  has just started, and a reader would watch it appear to go backwards. Refused, the page keeps
 *  the frame it already has, which is stale by one step and never wrong. */
export function parseReviewProgress(raw: unknown): ReviewRunProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const stage = d.stage;
  if (typeof stage !== "string" || !isReviewRunStage(stage)) return null;
  if (typeof d.project_path !== "string" || typeof d.iid !== "number") return null;
  return {
    runId: typeof d.run_id === "string" ? d.run_id : "",
    projectPath: d.project_path,
    iid: d.iid,
    stage,
    headSha: typeof d.head_sha === "string" ? d.head_sha : "",
    files: num(d.files),
    promptBytes: num(d.prompt_bytes),
    truncated: d.truncated === true,
    filesUnseen: num(d.files_unseen),
    backend: typeof d.backend === "string" ? d.backend : "",
    model: typeof d.model === "string" ? d.model : "",
    answerBytes: num(d.answer_bytes),
    themes: num(d.themes),
    error: typeof d.error === "string" && d.error ? d.error : null,
  };
}

function isReviewRunStage(value: string): value is ReviewRunStage {
  return (REVIEW_RUN_STAGES as readonly string[]).includes(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** How far through the order a stage is. Everything below the current one has happened. */
function stageIndex(stage: ReviewRunStage): number {
  return REVIEW_RUN_STAGES.indexOf(stage);
}

/** The state of the stage a row is about, given where the run has got to.
 *
 *  A FAILURE marks the stage it stopped at and leaves everything before it finished, because how far
 *  the reading got is exactly what the reader needs in order to know what to do next: a diff that
 *  would not load is GitLab's problem, and a model that refused is the provider's. */
function stateOf(
  row: ReviewRunStage,
  progress: ReviewRunProgress,
): Exclude<TaskState, "failed"> | "failed" {
  const at = stageIndex(progress.stage);
  const mine = stageIndex(row);
  if (progress.error) {
    if (mine < at) return "done";
    return mine === at ? "failed" : "pending";
  }
  if (mine < at) return "done";
  return mine === at ? "running" : "pending";
}

/** The three rows a reading is drawn as, from one frame.
 *
 *  THREE rather than one per stage, because the stages a reader can act on are not the stages the
 *  code has: the two GitLab reads are one thing to a person ("it is fetching the branch") and are
 *  worth telling apart only as sub-steps, while what the model does is the row somebody waits in
 *  front of. The `done` stage gets no row at all: the reading itself takes the screen the moment it
 *  lands, so a row saying "5 themes" beside a document that opens by saying so would state one fact
 *  twice — the rule this page already holds for its own headline.
 *
 *  Every sub-step's value is a fact or nothing. A step whose number is not known yet draws no value
 *  rather than a zero, because "0 files" is a claim about the branch and a blank is not. */
export function reviewRunRows(progress: ReviewRunProgress): TaskRow[] {
  const read = stateOf("diff", progress);
  const readStarted = stateOf("detail", progress);
  const asking = stateOf("asking", progress);
  const writing = stateOf("writing", progress);
  return [
    {
      id: "read",
      title: "Read the branch",
      // The count is the headline fact about a diff and it is the LAST of the two reads to answer,
      // so this stays blank while the branch is still coming down rather than claiming a total.
      value: progress.files ? fileCount(progress.files) : null,
      // The row is finished once BOTH its steps are, which is what the diff read reaching `done`
      // means — and it fails if either does.
      state: rowState([readStarted, read]),
      steps: [
        {
          id: "detail",
          label: "The merge request",
          // The commit, shortened the way every other surface here shortens one. It is the fact that
          // makes a reading checkable later: the document says which commit it read, and this is
          // where that value comes from.
          value: progress.headSha ? progress.headSha.slice(0, 8) : null,
          state: readStarted,
        },
        {
          id: "diff",
          label: "Its changes",
          value: progress.files ? fileCount(progress.files) : null,
          state: read,
        },
      ],
    },
    {
      id: "prompt",
      title: "Put the diff in the prompt",
      value: formatBytes(progress.promptBytes),
      // It is not a stage of its own: the prompt is built between the diff read and the ask, in no
      // measurable time, so this row is finished exactly when the asking has begun. It is a ROW
      // rather than a step because of WHAT it says — how much of the branch left this machine, which
      // is the one fact the offer above warned the reader about and the only place it is answered.
      state: asking === "pending" ? "pending" : "done",
      steps: [
        {
          id: "prompt-bytes",
          label: "Patch sent",
          value: formatBytes(progress.promptBytes),
          state: asking === "pending" ? "pending" : "done",
        },
        // Only when the budget really cut something. A row reading "0 files without their patch" on
        // every run is a line that never varies, which is a line nobody reads.
        ...(progress.truncated || progress.filesUnseen
          ? [
              {
                id: "prompt-cut",
                label:
                  progress.filesUnseen === 1
                    ? "1 file went without its patch"
                    : `${progress.filesUnseen} files went without their patch`,
                value: "cut",
                state: "done" as const,
              },
            ]
          : []),
      ],
    },
    {
      id: "agent",
      // The CLI doing the reading, named — because it is what the reader chose in Settings and what
      // they would go and change if this row is the one that fails.
      title: progress.backend ? `${progress.backend} reads it` : "The agent reads it",
      value: progress.model || null,
      state: rowState([asking, writing]),
      steps: [
        {
          id: "thinking",
          label: "Thinking",
          state: asking,
        },
        {
          id: "writing",
          label: "Writing the reading",
          // The answer so far. The one number on this page that moves while the model works, and it
          // is what really arrived — never a fraction of an answer whose length nothing knows.
          value: formatBytes(progress.answerBytes),
          state: writing,
        },
      ],
    },
  ];
}

/** A row is as far along as its LEAST advanced step, and failed if any of them failed. */
function rowState(steps: TaskState[]): TaskState {
  if (steps.includes("failed")) return "failed";
  if (steps.every((state) => state === "done")) return "done";
  if (steps.some((state) => state !== "pending")) return "running";
  return "pending";
}

function fileCount(files: number): string {
  return files === 1 ? "1 file" : `${files} files`;
}

/** The frame a run starts from, before the backend has said anything.
 *
 *  The press has to draw rows in the same frame it is made in — a press answered by nothing for a
 *  second reads as one that missed — and the first real frame is a round trip away. It claims
 *  nothing: the first stage is running and every value is absent, which is exactly true. */
export function reviewRunStarting(projectPath: string, iid: number): ReviewRunProgress {
  return {
    runId: "",
    projectPath,
    iid,
    stage: "detail",
    headSha: "",
    files: 0,
    promptBytes: 0,
    truncated: false,
    filesUnseen: 0,
    backend: "",
    model: "",
    answerBytes: 0,
    themes: 0,
    error: null,
  };
}

/** Whether a frame belongs to the run this page is watching.
 *
 *  A frame with no `run_id` — a backend older than this field — is ACCEPTED, because the older
 *  behaviour is one run at a time and refusing it would draw nothing at all. What is refused is a
 *  frame naming a DIFFERENT run, which is the case this exists for. */
export function reviewProgressIsOurs(
  frame: ReviewRunProgress,
  watching: ReviewRunProgress | null,
): boolean {
  if (!watching) return true;
  if (!frame.runId || !watching.runId) return true;
  return frame.runId === watching.runId;
}
