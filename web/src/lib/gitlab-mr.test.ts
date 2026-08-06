import { describe, expect, it } from "vitest";
import {
  conversationDiscussions,
  formatJobDuration,
  isNotMerged,
  isSystemOnly,
  mergeRequestId,
  mergeVerdict,
  parseMergeRequestId,
  personFace,
  pipelineIsLive,
  pipelineStages,
  pipelineTone,
  rowStateLabel,
  sameMergeRequest,
  stageTone,
  stateChangeFor,
  systemNotes,
  unresolvedThreadCount,
  type GitLabDiscussion,
  type GitLabJob,
  type MergeRequestDetail,
  type MergeRequestRow,
} from "./gitlab-mr";

function detail(patch: Partial<MergeRequestDetail> = {}): MergeRequestDetail {
  return {
    project_path: "group/app",
    iid: 42,
    reference: "!42",
    title: "Add the page",
    state: "opened",
    draft: false,
    web_url: "https://gitlab.example.com/group/app/-/merge_requests/42",
    source_branch: "feat/page",
    target_branch: "main",
    author: { name: "Ada", username: "ada" },
    has_conflicts: false,
    blocking_discussions_resolved: true,
    squash: false,
    user_notes_count: 0,
    upvotes: 0,
    downvotes: 0,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-02T10:00:00.000Z",
    ...patch,
  };
}

function row(patch: Partial<MergeRequestRow> = {}): MergeRequestRow {
  return {
    project_path: "group/app",
    iid: 42,
    reference: "!42",
    title: "Add the page",
    state: "opened",
    draft: false,
    web_url: "https://gitlab.example.com/group/app/-/merge_requests/42",
    source_branch: "feat/page",
    target_branch: "main",
    author: { name: "Ada", username: "ada" },
    user_notes_count: 0,
    upvotes: 0,
    downvotes: 0,
    updated_at: "2026-08-02T10:00:00.000Z",
    created_at: "2026-08-01T10:00:00.000Z",
    ...patch,
  };
}

function job(patch: Partial<GitLabJob> = {}): GitLabJob {
  return {
    id: 1,
    name: "test",
    stage: "test",
    status: "success",
    allow_failure: false,
    ...patch,
  };
}

describe("addressing one merge request", () => {
  it("a nested project path survives the round trip", () => {
    const key = { projectPath: "group/sub/app", iid: 596 };
    const id = mergeRequestId(key);
    // The slashes are encoded, so the id is ONE path segment in this app's own URL.
    expect(id).toBe("group%2Fsub%2Fapp!596");
    expect(id.includes("/")).toBe(false);
    expect(parseMergeRequestId(id)).toEqual(key);
  });

  it("an id that names nothing is refused rather than guessed at", () => {
    for (const bad of ["", "!", "!42", "group%2Fapp", "group%2Fapp!", "group%2Fapp!0", "group%2Fapp!x", "%E0%A4%A!1"]) {
      expect(parseMergeRequestId(bad)).toBeNull();
    }
  });

  it("two names name the same merge request only when both halves match", () => {
    const key = { projectPath: "group/app", iid: 42 };
    expect(sameMergeRequest(key, { ...key })).toBe(true);
    expect(sameMergeRequest(key, { projectPath: "group/app", iid: 4 })).toBe(false);
    expect(sameMergeRequest(key, { projectPath: "group/other", iid: 42 })).toBe(false);
    expect(sameMergeRequest(key, null)).toBe(false);
    expect(sameMergeRequest(null, null)).toBe(false);
  });
});

describe("whether the merge button is offered", () => {
  it("only GitLab's own `mergeable` is a yes", () => {
    const verdict = mergeVerdict(detail({ detailed_merge_status: "mergeable" }));
    expect(verdict.can).toBe(true);
    // The line says what the click will do, naming both branches.
    expect(verdict.reason).toContain("feat/page");
    expect(verdict.reason).toContain("main");
  });

  it("an UNKNOWN status is never a green light", () => {
    // A merge cannot be taken back, so a state this app has never heard of must resolve
    // to "no" — with GitLab's own word on it, so the reader can go and look.
    const verdict = mergeVerdict(detail({ detailed_merge_status: "some_new_gitlab_state" }));
    expect(verdict.can).toBe(false);
    expect(verdict.reason).toContain("some_new_gitlab_state");
    expect(verdict.checking).toBe(false);
  });

  it("each known blocker says what to do about it", () => {
    for (const [status, phrase] of [
      ["not_approved", "approval"],
      ["ci_must_pass", "pipeline"],
      ["conflict", "conflicts"],
      ["draft_status", "draft"],
      ["discussions_not_resolved", "unresolved"],
      ["need_rebase", "rebased"],
    ] as const) {
      const verdict = mergeVerdict(detail({ detailed_merge_status: status }));
      expect(verdict.can).toBe(false);
      expect(verdict.reason.toLowerCase()).toContain(phrase);
    }
  });

  it("`checking` is temporary and says so instead of naming a blocker", () => {
    const verdict = mergeVerdict(detail({ detailed_merge_status: "checking" }));
    expect(verdict.can).toBe(false);
    expect(verdict.checking).toBe(true);
    expect(verdict.reason).toContain("still checking");
  });

  it("a merge request that is not open can never be merged", () => {
    for (const state of ["closed", "merged", "locked"]) {
      const verdict = mergeVerdict(detail({ state, detailed_merge_status: "mergeable" }));
      expect(verdict.can).toBe(false);
      expect(verdict.reason).toContain(state);
    }
  });

  it("an older GitLab is read from `merge_status`, and only its yes is a yes", () => {
    expect(mergeVerdict(detail({ merge_status: "can_be_merged" })).can).toBe(true);
    expect(mergeVerdict(detail({ merge_status: "cannot_be_merged" })).can).toBe(false);
    expect(mergeVerdict(detail({ merge_status: "checking" })).checking).toBe(true);
    // A conflict wins over a stale "can be merged".
    const conflicted = mergeVerdict(detail({ merge_status: "can_be_merged", has_conflicts: true }));
    expect(conflicted.can).toBe(false);
    expect(conflicted.reason).toContain("conflicts");
  });

  it("nothing open offers nothing", () => {
    expect(mergeVerdict(null).can).toBe(false);
    expect(mergeVerdict(undefined).can).toBe(false);
  });
});

describe("closing and reopening", () => {
  it("each direction is offered where it is the undo of the other", () => {
    expect(stateChangeFor(detail({ state: "opened" }))).toBe("close");
    expect(stateChangeFor(detail({ state: "closed" }))).toBe("reopen");
    // A merged merge request offers neither: there is nothing to undo, and GitLab would
    // refuse both.
    expect(stateChangeFor(detail({ state: "merged" }))).toBeNull();
    expect(stateChangeFor(null)).toBeNull();
  });
});

describe("pipelines", () => {
  it("a tone is one of four, and an unknown state is neither good nor bad news", () => {
    expect(pipelineTone("running")).toBe("running");
    expect(pipelineTone("pending")).toBe("running");
    expect(pipelineTone("success")).toBe("success");
    expect(pipelineTone("failed")).toBe("failed");
    for (const quiet of ["canceled", "skipped", "manual", "something_new", null, undefined, ""]) {
      expect(pipelineTone(quiet)).toBe("idle");
    }
  });

  it("a pipeline is live while it — or any of its jobs — is still moving", () => {
    expect(pipelineIsLive(null)).toBe(false);
    expect(pipelineIsLive({ jobs: [job({ status: "running" })] })).toBe(false); // no pipeline
    expect(pipelineIsLive({ pipeline: { id: 1, status: "running" } })).toBe(true);
    expect(pipelineIsLive({ pipeline: { id: 1, status: "success" } })).toBe(false);
    // The case a pipeline-only check gets wrong: GitLab reports success once the required
    // jobs are done, while a job allowed to fail keeps running.
    expect(
      pipelineIsLive({
        pipeline: { id: 1, status: "success" },
        jobs: [job({ status: "success" }), job({ id: 2, status: "running", allow_failure: true })],
      }),
    ).toBe(true);
    // A pipeline waiting on a human is NOT live: it is waiting on a person, not on time.
    expect(pipelineIsLive({ pipeline: { id: 1, status: "manual" }, jobs: [job({ status: "manual" })] })).toBe(false);
  });

  it("stages keep GitLab's own order, emoji names and all", () => {
    const stages = pipelineStages([
      job({ id: 1, name: "🤖 Opencode", stage: "detect 🕵️" }),
      job({ id: 2, name: "🔖 Tag Branch", stage: "detect 🕵️", status: "created" }),
      job({ id: 3, name: "unit", stage: "🧪 test", status: "running" }),
    ]);
    expect(stages.map((s) => s.name)).toEqual(["detect 🕵️", "🧪 test"]);
    expect(stages[0]!.jobs.length).toBe(2);
    // Nothing is sorted: an alphabetical order would put "🧪 test" before "detect".
    expect(stages[1]!.jobs[0]!.name).toBe("unit");
    expect(pipelineStages(null)).toEqual([]);
    expect(pipelineStages([])).toEqual([]);
  });

  it("a stage's tone reads the jobs that count", () => {
    expect(stageTone({ name: "t", jobs: [job(), job({ id: 2 })] })).toBe("success");
    expect(stageTone({ name: "t", jobs: [job({ status: "failed" })] })).toBe("failed");
    // A job allowed to fail never turns a stage red — that is what allowing it means.
    expect(stageTone({ name: "t", jobs: [job(), job({ id: 2, status: "failed", allow_failure: true })] })).toBe(
      "idle",
    );
    // Running wins over everything: the stage has not finished having its say.
    expect(stageTone({ name: "t", jobs: [job({ status: "failed" }), job({ id: 2, status: "running" })] })).toBe(
      "running",
    );
    expect(stageTone({ name: "t", jobs: [job({ status: "manual" })] })).toBe("idle");
  });

  it("a duration reads as a person says it", () => {
    expect(formatJobDuration(4)).toBe("4s");
    expect(formatJobDuration(59.6)).toBe("1m");
    expect(formatJobDuration(72)).toBe("1m 12s");
    expect(formatJobDuration(300.794)).toBe("5m 1s");
    expect(formatJobDuration(3720)).toBe("1h 2m");
    // A job that has not run has no duration, and nothing is drawn for it.
    for (const none of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatJobDuration(none)).toBe("");
    }
  });
});

describe("the sidebar's own rows", () => {
  it("a draft says so where the state would be", () => {
    expect(rowStateLabel(row())).toBe("Open");
    expect(rowStateLabel(row({ draft: true }))).toBe("Draft");
    expect(rowStateLabel(row({ state: "closed" }))).toBe("Closed");
    // An unfamiliar state keeps GitLab's own word.
    expect(rowStateLabel(row({ state: "locked" }))).toBe("locked");
  });

  it("a merged row is dropped from a list whose promise is `not merged`", () => {
    expect(isNotMerged(row())).toBe(true);
    expect(isNotMerged(row({ state: "closed" }))).toBe(true);
    expect(isNotMerged(row({ state: "merged" }))).toBe(false);
  });
});

describe("comments", () => {
  const conversation: GitLabDiscussion = {
    id: "d1",
    individual_note: true,
    notes: [
      {
        id: 1,
        author: { name: "Ada", username: "ada" },
        body: "Looks good",
        system: false,
        created_at: "2026-08-04T11:42:17.515Z",
        resolvable: false,
        resolved: false,
        mine: false,
      },
    ],
  };
  const event: GitLabDiscussion = {
    id: "d2",
    individual_note: true,
    notes: [
      {
        id: 2,
        author: { name: "bot", username: "bot" },
        body: "changed the description",
        system: true,
        created_at: "2026-08-04T11:46:16.800Z",
        resolvable: false,
        resolved: false,
        mine: false,
      },
    ],
  };
  const thread: GitLabDiscussion = {
    id: "d3",
    individual_note: false,
    notes: [
      {
        id: 3,
        author: { name: "bot", username: "bot" },
        body: "the preStop command interpolates",
        system: false,
        created_at: "2026-08-04T11:46:49.409Z",
        resolvable: true,
        resolved: false,
        mine: false,
        position: { new_path: "charts/app/templates/deploy.yaml", new_line: 42 },
      },
    ],
  };

  it("what somebody said is kept apart from what GitLab recorded", () => {
    expect(isSystemOnly(event)).toBe(true);
    expect(isSystemOnly(conversation)).toBe(false);
    const list = { discussions: [conversation, event, thread], truncated: false };
    expect(conversationDiscussions(list).map((d) => d.id)).toEqual(["d1", "d3"]);
    expect(systemNotes(list).map((n) => n.id)).toEqual([2]);
    expect(conversationDiscussions(null)).toEqual([]);
    expect(systemNotes(null)).toEqual([]);
  });

  it("unresolved THREADS are counted, not unresolved notes", () => {
    const list = { discussions: [conversation, event, thread], truncated: false };
    expect(unresolvedThreadCount(list)).toBe(1);
    // Five replies under one objection is still one thing to settle.
    const busy = {
      discussions: [
        {
          ...thread,
          notes: [...thread.notes, { ...thread.notes[0]!, id: 4 }, { ...thread.notes[0]!, id: 5 }],
        },
      ],
      truncated: false,
    };
    expect(unresolvedThreadCount(busy)).toBe(1);
    // A resolved thread counts for nothing, and a standalone comment is not a thread.
    const settled = {
      discussions: [{ ...thread, notes: [{ ...thread.notes[0]!, resolved: true }] }],
      truncated: false,
    };
    expect(unresolvedThreadCount(settled)).toBe(0);
    expect(unresolvedThreadCount({ discussions: [conversation], truncated: false })).toBe(0);
    expect(unresolvedThreadCount(null)).toBe(0);
  });
});

describe("who a GitLab user is drawn as", () => {
  it("draws a colleague the app knows as that colleague", () => {
    const face = personFace({
      name: "Lucas Silva",
      username: "lucas.silva",
      // What the backend resolved: the person, under the name this app calls them — which is
      // the user's own nickname for them when they set one.
      teams: { mri: "8:orgid:lucas-silva", name: "Luca" },
    });
    expect(face.label).toBe("Luca");
    // Their real photo, addressed the way every other avatar in this app is.
    expect(face.photo).toEqual({ kind: "user", id: "8:orgid:lucas-silva" });
    // Seeded on the identity, so one person is one colour across every surface.
    expect(face.seed).toBe("8:orgid:lucas-silva");
  });

  it("leaves somebody only GitLab knows exactly as GitLab named them", () => {
    const face = personFace({ name: "Ada Lovelace", username: "ada" });
    expect(face).toEqual({ seed: "ada", label: "Ada Lovelace" });
    // Nothing to fetch: GitLab's own avatar URL is never requested.
    expect(face.photo).toBeUndefined();
  });

  it("asks for no picture when the identity is empty, and never shows a blank name", () => {
    // A backend that answered with a person carrying no MRI has resolved nobody.
    expect(personFace({ name: "Ada", username: "ada", teams: { mri: "", name: "x" } })).toEqual({
      seed: "ada",
      label: "Ada",
    });
    // A bot GitLab redacts has a handle and no name; a name is what the row shows.
    expect(personFace({ name: "", username: "project_17_bot" }).label).toBe("project_17_bot");
    // And a resolved person whose name did not travel keeps GitLab's.
    expect(
      personFace({ name: "Lucas Silva", username: "lucas", teams: { mri: "8:orgid:l", name: "" } })
        .label,
    ).toBe("Lucas Silva");
  });
});
