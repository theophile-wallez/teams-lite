import { describe, expect, it } from "vitest";
import {
  parseReviewProgress,
  REVIEW_RUN_STAGES,
  reviewProgressIsOurs,
  reviewRunRows,
  reviewRunStarting,
  type ReviewRunProgress,
  type ReviewRunStage,
} from "./review-progress";
import type { TaskRow } from "../components/beautifului/task-rows";

/** A frame at a stage, with whatever the run would really know by then. */
function frame(stage: ReviewRunStage, over: Partial<ReviewRunProgress> = {}): ReviewRunProgress {
  const known: Partial<ReviewRunProgress> = {};
  const at = REVIEW_RUN_STAGES.indexOf(stage);
  if (at >= REVIEW_RUN_STAGES.indexOf("diff")) known.headSha = "a1b2c3d4e5f6";
  if (at >= REVIEW_RUN_STAGES.indexOf("asking")) {
    known.files = 8;
    known.promptBytes = 18_400;
    known.backend = "claude";
    known.model = "sonnet";
  }
  if (at >= REVIEW_RUN_STAGES.indexOf("writing")) known.answerBytes = 4_800;
  if (at >= REVIEW_RUN_STAGES.indexOf("done")) known.themes = 5;
  return { ...reviewRunStarting("acme/webapp", 42), stage, ...known, ...over };
}

const rowOf = (rows: TaskRow[], key: string): TaskRow => {
  const row = rows.find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
};
/** A detail's own `meta`, by the label it is drawn under. */
const metaOf = (rows: TaskRow[], key: string, label: string): string => {
  const detail = rowOf(rows, key).details.find((candidate) => candidate.label === label);
  if (!detail) throw new Error(`no detail ${label}`);
  return detail.meta;
};

describe("the frames off the wire", () => {
  it("reads one the backend really sends", () => {
    const parsed = parseReviewProgress({
      run_id: "acme/webapp!42/1756060012345",
      project_path: "acme/webapp",
      iid: 42,
      stage: "asking",
      head_sha: "a1b2c3d4e5f6",
      files: 8,
      prompt_bytes: 18_400,
      truncated: false,
      files_unseen: 0,
      backend: "claude",
      model: "sonnet",
      answer_bytes: 0,
      themes: 0,
      error: null,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.stage).toBe("asking");
    expect(parsed?.files).toBe(8);
    expect(parsed?.backend).toBe("claude");
    expect(parsed?.error).toBeNull();
  });

  /** A stage this build does not know is refused rather than defaulted, so the page keeps the frame
   *  it has: stale by one step, never a run drawn as going backwards. */
  it("refuses a stage it does not know, and a frame naming no merge request", () => {
    expect(parseReviewProgress({ project_path: "a/b", iid: 1, stage: "uploading" })).toBeNull();
    expect(parseReviewProgress({ project_path: "a/b", iid: 1 })).toBeNull();
    expect(parseReviewProgress({ stage: "detail", iid: 1 })).toBeNull();
    expect(parseReviewProgress({ stage: "detail", project_path: "a/b" })).toBeNull();
    expect(parseReviewProgress(null)).toBeNull();
  });

  /** The five spellings, pinned against `gitlab_review::RunStage::as_str` on the other side of the
   *  socket — which has its own test asserting the same list. A rename on either side draws nothing. */
  it("holds the same five stages the backend spells", () => {
    expect([...REVIEW_RUN_STAGES]).toEqual(["detail", "diff", "asking", "writing", "done"]);
  });
});

describe("which run a frame belongs to", () => {
  it("takes a frame from the run being watched and refuses another run's", () => {
    const ours = frame("asking", { runId: "acme/webapp!42/1" });
    expect(reviewProgressIsOurs(frame("writing", { runId: "acme/webapp!42/1" }), ours)).toBe(true);
    // Another run of the SAME merge request — a second page asked too. Its `done` would take these
    // rows down under a run that is still going.
    expect(reviewProgressIsOurs(frame("done", { runId: "acme/webapp!42/2" }), ours)).toBe(false);
  });

  /** A backend older than the field sends no run id, and the older behaviour is one run at a time —
   *  so it is accepted. Refusing it would draw nothing at all. */
  it("accepts a frame with no run id at all", () => {
    expect(reviewProgressIsOurs(frame("writing", { runId: "" }), frame("asking", { runId: "x" })))
      .toBe(true);
    expect(reviewProgressIsOurs(frame("writing", { runId: "x" }), null)).toBe(true);
  });
});

describe("the rows a run is watched through", () => {
  /** THREE rows, and `done` gets none: the document says everything a finished list would, so a row
   *  reading "5 themes" above a headline that opens by saying so would state one fact twice. */
  it("draws three rows and no row for the reading itself", () => {
    const rows = reviewRunRows(frame("asking"));
    expect(rows.map((row) => row.key)).toEqual(["read", "prompt", "agent"]);
  });

  it("marks everything before the current stage finished, the current one running, the rest to come", () => {
    const rows = reviewRunRows(frame("asking"));
    expect(rowOf(rows, "read").status).toBe("done");
    expect(rowOf(rows, "prompt").status).toBe("done");
    expect(rowOf(rows, "agent").status).toBe("running");
    // The two phases, in the detail behind the running row's own chevron.
    expect(metaOf(rows, "agent", "Thinking")).toBe("now");
    expect(metaOf(rows, "agent", "Writing the review")).toBe("");
  });

  it("walks forward through every stage without a row ever going back", () => {
    const seen: string[][] = REVIEW_RUN_STAGES.map((stage) =>
      reviewRunRows(frame(stage)).map((row) => row.status),
    );
    // A row's state may only ever advance as the run does. `pending` → `running` → `done`, never the
    // other way: a reader watching a step un-finish itself would read the page as broken.
    const rank: Record<string, number> = { pending: 0, running: 1, done: 2, failed: 3 };
    for (let step = 1; step < seen.length; step += 1) {
      const previous = seen[step - 1] ?? [];
      const current = seen[step] ?? [];
      for (let row = 0; row < current.length; row += 1) {
        expect(rank[current[row] ?? ""]).toBeGreaterThanOrEqual(rank[previous[row] ?? ""] ?? 0);
      }
    }
  });

  it("has every row finished by the time the reading exists", () => {
    const rows = reviewRunRows(frame("done"));
    expect(rows.every((row) => row.status === "done")).toBe(true);
  });

  /** A number nobody has yet draws NOTHING. "0 files" is a claim about the branch; a blank is not. */
  it("states no value for a fact the run has not learnt", () => {
    const rows = reviewRunRows(frame("detail"));
    expect(rowOf(rows, "read").status).toBe("running");
    expect(rowOf(rows, "read").amount).toBe("");
    expect(metaOf(rows, "read", "The merge request")).toBe("");
    expect(rowOf(rows, "prompt").amount).toBe("");
    expect(metaOf(rows, "agent", "Writing the review")).toBe("");
  });

  it("states the facts it has learnt, in the words a reader reads", () => {
    const rows = reviewRunRows(frame("writing"));
    expect(rowOf(rows, "read").amount).toBe("8 files");
    // The commit, shortened — which is what makes a reading checkable against the branch later.
    expect(metaOf(rows, "read", "The merge request")).toBe("a1b2c3d4");
    expect(rowOf(rows, "prompt").amount).toBe("18 KB");
    // The CLI and the model are named, because they are what the reader would go and change if this
    // is the row that fails — and BOTH are capitalized, through the review's own `capitalizedName`,
    // so this row cannot say `sonnet` while the document above it says `Sonnet`.
    expect(rowOf(rows, "agent").label).toBe("Claude reviews it");
    expect(rowOf(rows, "agent").amount).toBe("Sonnet");
    expect(metaOf(rows, "agent", "Writing the review")).toBe("4.7 KB");
  });

  it("says one file rather than 1 files", () => {
    expect(rowOf(reviewRunRows(frame("writing", { files: 1 })), "read").amount).toBe("1 file");
  });

  /** The cut is stated only when there really was one: a line reading "0 files went without their
   *  patch" on every run is a line that never varies, which is a line nobody reads. */
  it("says nothing about a cut diff unless the diff was cut", () => {
    const whole = rowOf(reviewRunRows(frame("asking")), "prompt");
    expect(whole.details.map((detail) => detail.label)).toEqual(["Patch sent"]);
    const cut = rowOf(reviewRunRows(frame("asking", { truncated: true, filesUnseen: 3 })), "prompt");
    expect(cut.details.map((detail) => detail.label)).toEqual([
      "Patch sent",
      "3 files went without their patch",
    ]);
    expect(
      rowOf(reviewRunRows(frame("asking", { truncated: true, filesUnseen: 1 })), "prompt")
        .details[1]?.label,
    ).toBe("1 file went without its patch");
  });

  /** A failure marks the stage it stopped AT and leaves everything before it finished — which is the
   *  half that tells the reader whose problem it is. */
  it("fails at the stage the run stopped at, and keeps what got done", () => {
    const rows = reviewRunRows(frame("asking", { error: "claude is not on this machine's PATH" }));
    expect(rowOf(rows, "read").status).toBe("done");
    expect(rowOf(rows, "agent").status).toBe("failed");
    expect(metaOf(rows, "agent", "Thinking")).toBe("stopped");
    // The answer never started arriving, so it says nothing rather than claiming a second failure.
    expect(metaOf(rows, "agent", "Writing the review")).toBe("");
    // A failed row OPENS itself: the reason is why the reader is looking.
    expect(rowOf(rows, "agent").defaultOpen).toBe(true);
  });

  it("blames the diff read when that is where it stopped", () => {
    const rows = reviewRunRows(frame("diff", { error: "GitLab could not be reached" }));
    expect(rowOf(rows, "read").status).toBe("failed");
    // Nothing after it is drawn as having happened.
    expect(rowOf(rows, "agent").status).toBe("pending");
    expect(rowOf(rows, "prompt").status).toBe("pending");
  });

  /** The press draws rows in its own task, and this is the frame it draws them from: the first stage
   *  running and nothing else claimed, which is exactly true a millisecond after the press. */
  it("starts from a frame that claims nothing", () => {
    const start = reviewRunStarting("acme/webapp", 42);
    expect(start.stage).toBe("detail");
    expect(start.error).toBeNull();
    const rows = reviewRunRows(start);
    expect(rows.map((row) => row.status)).toEqual(["running", "pending", "pending"]);
    // Not one amount anywhere, because not one fact is known yet.
    expect(rows.every((row) => row.amount === "")).toBe(true);
    // And the row still says what it is going to do, so the reader is not shown three blank lines.
    expect(rows.map((row) => row.label)).toEqual([
      "Read the branch",
      "Put the diff in the prompt",
      "The agent reviews it",
    ]);
  });

  /** No percentage, no bar, no estimate — anywhere. Nothing on either side of the socket knows how
   *  long a model will think, so a proportion here would be the one thing on this page a reader
   *  could catch lying. */
  it("never states a proportion of anything", () => {
    for (const stage of REVIEW_RUN_STAGES) {
      const rows = reviewRunRows(frame(stage));
      const text = rows
        .flatMap((row) => [
          row.label,
          row.amount,
          ...row.details.flatMap((detail) => [detail.label, detail.meta]),
        ])
        .join(" ");
      expect(text).not.toMatch(/%/);
      expect(text).not.toMatch(/\bof \d/);
      expect(text).not.toMatch(/remaining|left|eta/i);
    }
  });
});
