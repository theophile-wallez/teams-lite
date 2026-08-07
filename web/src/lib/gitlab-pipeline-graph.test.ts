import { describe, expect, it } from "vitest";

import type { GitLabJob, GitLabPipelineView } from "./gitlab-mr";
import {
  canGroupByNeeds,
  defaultGrouping,
  edgeIsLit,
  graphSummary,
  pipelineGraph,
  relatedNodes,
} from "./gitlab-pipeline-graph";

let nextId = 1;
function job(over: Partial<GitLabJob> = {}): GitLabJob {
  return {
    id: over.id ?? nextId++,
    name: over.name ?? "unit",
    stage: over.stage ?? "test",
    status: over.status ?? "success",
    allow_failure: over.allow_failure ?? false,
    ...over,
  };
}

/** A pipeline in the shape the BACKEND answers with: the jobs newest first, as GitLab's own
 *  endpoint gives them, and the stage order named separately (see `pipelineStages`). */
function view(jobs: GitLabJob[], stages?: string[]): GitLabPipelineView {
  return { pipeline: { id: 1, status: "running" }, jobs: [...jobs].reverse(), stages };
}

/** The pipeline the screenshot this surface was asked for shows: three build jobs and a lint
 *  job in one stage, three tests, two deploys — and `needs` that cross the stages. */
function tenantShapedPipeline(): GitLabPipelineView {
  return view(
    [
      job({ id: 1, name: "build-job1", stage: "build" }),
      job({ id: 2, name: "build-job2", stage: "build" }),
      job({ id: 3, name: "build-job3", stage: "build" }),
      job({ id: 4, name: "lint-job1", stage: "test" }),
      job({ id: 5, name: "test-job1", stage: "test", needs: ["build-job1"] }),
      job({ id: 6, name: "test-job2", stage: "test", needs: ["build-job2"] }),
      job({ id: 7, name: "test-job3", stage: "test", needs: ["build-job3"] }),
      job({ id: 8, name: "deploy-job1", stage: "deploy", needs: ["test-job1"] }),
      job({ id: 9, name: "deploy-job2", stage: "deploy", needs: ["test-job2", "test-job3"] }),
    ],
    ["build", "test", "deploy"],
  );
}

describe("the pipeline graph", () => {
  it("groups by GitLab's own stages, in GitLab's own order", () => {
    const graph = pipelineGraph(tenantShapedPipeline(), "stage");
    expect(graph.grouping).toBe("stage");
    expect(graph.columns.map((column) => column.label)).toEqual(["build", "test", "deploy"]);
    expect(graph.columns[1]!.nodes.map((node) => node.job.name)).toEqual([
      "lint-job1",
      "test-job1",
      "test-job2",
      "test-job3",
    ]);
  });

  it("groups by dependency depth, whatever stage a job is in", () => {
    const graph = pipelineGraph(tenantShapedPipeline(), "needs");
    expect(graph.grouping).toBe("needs");
    // The whole point of this mode: `lint-job1` is in the `test` stage and waits for
    // nothing, so it starts with the builds rather than after them.
    expect(graph.columns[0]!.nodes.map((node) => node.job.name)).toEqual([
      "build-job1",
      "build-job2",
      "build-job3",
      "lint-job1",
    ]);
    expect(graph.columns[1]!.nodes.map((node) => node.job.name)).toEqual([
      "test-job1",
      "test-job2",
      "test-job3",
    ]);
    expect(graph.columns[2]!.nodes.map((node) => node.job.name)).toEqual([
      "deploy-job1",
      "deploy-job2",
    ]);
    // A column of a dependency layout is a LEVEL and carries no name: the card names its own
    // stage, which is what GitLab's own dependency view does.
    expect(graph.columns.every((column) => column.label === "")).toBe(true);
  });

  it("lays the columns out in CREATION order, whatever order GitLab answered in", () => {
    // GitLab's jobs endpoint answers newest first, and `view()` reverses the fixture for that
    // reason. Walking the answer laid every column out backwards — and it drew `install` last on
    // every real pipeline until somebody looked at one.
    const graph = pipelineGraph(tenantShapedPipeline(), "needs");
    expect(graph.columns[0]!.nodes.map((node) => node.job.id)).toEqual([1, 2, 3, 4]);
    const byStage = pipelineGraph(tenantShapedPipeline(), "stage");
    expect(byStage.columns.map((column) => column.label)).toEqual(["build", "test", "deploy"]);
  });

  it("draws one curve per declared dependency, both ends being cards", () => {
    const graph = pipelineGraph(tenantShapedPipeline(), "needs");
    expect(graph.edges.length).toBe(6);
    const named = graph.edges.map(
      (edge) => `${graph.nodes.get(edge.from)!.job.name}->${graph.nodes.get(edge.to)!.job.name}`,
    );
    expect(named).toContain("build-job1->test-job1");
    expect(named).toContain("test-job3->deploy-job2");
  });

  it("keeps the same curves under the stage grouping", () => {
    // The dependencies are a fact about the pipeline, not about how it is being drawn — so
    // the stage view can light them too, which is what the screenshot's own second control
    // does.
    const byStage = pipelineGraph(tenantShapedPipeline(), "stage");
    const byNeeds = pipelineGraph(tenantShapedPipeline(), "needs");
    expect(byStage.edges.length).toBe(byNeeds.edges.length);
  });

  it("offers the dependency grouping only where the pipeline declares one", () => {
    const flat = [job({ name: "build", stage: "build" }), job({ name: "test", stage: "test" })];
    expect(canGroupByNeeds(flat)).toBe(false);
    expect(defaultGrouping(flat)).toBe("stage");
    expect(canGroupByNeeds(null)).toBe(false);
    // And a pipeline that DOES declare one opens on it: that is the shape its author wrote.
    expect(defaultGrouping(tenantShapedPipeline().jobs!)).toBe("needs");
  });

  it("answers a stage layout when asked for a dependency one it cannot draw", () => {
    // One column holding every job is not a graph, and the reader asked to see structure.
    const graph = pipelineGraph(view([job({ name: "a", stage: "build" }), job({ name: "b", stage: "test" })]), "needs");
    expect(graph.grouping).toBe("stage");
    expect(graph.columns.map((column) => column.label)).toEqual(["build", "test"]);
  });

  it("names a dependency by name and joins it to a CARD", () => {
    // GitLab declares `needs:` per name; two cards may carry one name (a retried job), and a
    // card is keyed by its id. The newest run under a name is the one that counts.
    const graph = pipelineGraph(
      view([
        job({ id: 1, name: "build", stage: "build", status: "failed" }),
        job({ id: 2, name: "build", stage: "build" }),
        job({ id: 3, name: "test", stage: "test", needs: ["build"] }),
      ]),
      "needs",
    );
    expect(graph.edges).toEqual([{ from: "2", to: "3" }]);
  });

  it("drops a dependency on a job the graph does not hold", () => {
    // The backend already drops these; a payload from an older one must not draw an edge to
    // nothing either.
    const graph = pipelineGraph(
      view([job({ id: 1, name: "test", stage: "test", needs: ["trigger-downstream"] })]),
      "needs",
    );
    expect(graph.edges).toEqual([]);
    expect(graph.grouping).toBe("stage");
  });

  it("survives a cycle rather than hanging on one", () => {
    // GitLab refuses a cyclic `needs:`, so this is a payload nothing real produces — and a
    // walk that trusted that would spin the page instead of drawing an odd graph.
    const graph = pipelineGraph(
      view([
        job({ id: 1, name: "a", stage: "s", needs: ["b"] }),
        job({ id: 2, name: "b", stage: "s", needs: ["a"] }),
      ]),
      "needs",
    );
    expect(graph.columns.length).toBeGreaterThan(0);
    expect(graph.nodes.size).toBe(2);
  });

  it("never lets a job wait for itself", () => {
    const graph = pipelineGraph(view([job({ id: 1, name: "a", stage: "s", needs: ["a"] })]), "needs");
    expect(graph.edges).toEqual([]);
  });

  it("carries the four tones onto the cards and their columns", () => {
    const graph = pipelineGraph(
      view([
        job({ id: 1, name: "ok", stage: "s" }),
        job({ id: 2, name: "flaky", stage: "s", status: "failed", allow_failure: true }),
      ]),
      "stage",
    );
    expect(graph.nodes.get("1")!.tone).toBe("success");
    // Orange, not red: it failed and nobody has to fix it.
    expect(graph.nodes.get("2")!.tone).toBe("warning");
    expect(graph.columns[0]!.tone).toBe("warning");
  });

  it("answers what one job's own run is about, all the way through", () => {
    const graph = pipelineGraph(tenantShapedPipeline(), "needs");
    // `test-job2` (id 6) waits for `build-job2` (2) and is waited for by `deploy-job2` (9).
    const related = relatedNodes(graph, "6");
    expect([...related].sort()).toEqual(["2", "6", "9"]);
    // A chain is followed the whole way: build-job1 (1) → test-job1 (5) → deploy-job1 (8).
    expect([...relatedNodes(graph, "1")].sort()).toEqual(["1", "5", "8"]);
    // A job nothing touches is only itself.
    expect([...relatedNodes(graph, "4")]).toEqual(["4"]);
    expect(relatedNodes(graph, "nope").size).toBe(0);
  });

  it("lights the pointed-at chain only, and nothing at rest", () => {
    const graph = pipelineGraph(tenantShapedPipeline(), "needs");
    const related = relatedNodes(graph, "6");
    expect(edgeIsLit({ from: "2", to: "6" }, related)).toBe(true);
    expect(edgeIsLit({ from: "1", to: "5" }, related)).toBe(false);
    // Nothing pointed at: NOTHING is lit. The graph is one neutral colour until a reader asks,
    // because an accent on every wire is an accent that says nothing.
    expect(edgeIsLit({ from: "1", to: "5" }, null)).toBe(false);
  });

  it("says what it holds, and counts what it left out", () => {
    const full = tenantShapedPipeline();
    expect(graphSummary(full, pipelineGraph(full, "stage"))).toBe("9 jobs · 3 stages");
    expect(graphSummary(full, pipelineGraph(full, "needs"))).toBe("9 jobs · 3 steps");
    // A dependency leading out of this pipeline — a bridge, a job past the read's own page —
    // is stated rather than silently missing.
    const partial = view([
      job({ id: 1, name: "build", stage: "build" }),
      job({ id: 2, name: "test", stage: "test", needs: ["build", "trigger-downstream"] }),
    ]);
    expect(graphSummary(partial, pipelineGraph(partial, "needs"))).toBe(
      "2 jobs · 2 steps · 1 of 2 dependencies lead outside this pipeline",
    );
    expect(graphSummary(null, pipelineGraph(null, "stage"))).toBe("0 jobs · 0 stages");
  });
});
