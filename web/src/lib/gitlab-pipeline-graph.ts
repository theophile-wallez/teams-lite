// Where every card of the pipeline graph goes, and which cards a curve joins.
//
// The graph draws a pipeline as columns of job cards with curves between them (see
// AGENTS.md § The pipeline is a GRAPH). Everything here is PURE: a payload in, a layout out,
// so the two questions that decide whether the surface is right — what goes in which column,
// and what a reader is shown when they point at one job — are unit-tested with no DOM, no
// renderer and no measurement.
//
// What is NOT here is geometry. The renderer measures the cards' real boxes and draws its
// curves between them (`gitlab-pipeline-view.tsx`), because a card's height depends on the
// font, the name's own length and the reader's window — so a layout that computed pixels
// here would be a second, wrong opinion about where a card is.

import {
  jobsTone,
  jobTone,
  pipelineStages,
  type GitLabJob,
  type GitLabPipelineView,
  type PipelineTone,
} from "./gitlab-mr";

/** How the columns are decided.
 *
 *  - `stage` is GitLab's own stage order, which every pipeline has.
 *  - `needs` is the DEPENDENCY order: a job sits one column right of the last job it waits
 *    for. It exists only where the jobs carry `needs` (see `src/gitlab_ci_graph.rs`, which
 *    reads them over GraphQL because GitLab's REST jobs endpoint carries none). */
export type PipelineGrouping = "stage" | "needs";

/** One job, placed. `key` identifies it for the renderer and for an edge's two ends: the
 *  job's ID rather than its name, because a retried job appears twice under one name and two
 *  cards may not share one key. */
export type GraphNode = {
  key: string;
  job: GitLabJob;
  tone: PipelineTone;
  /** The jobs this one waits for, as keys, and only the ones this graph really holds. */
  needs: string[];
};

/** One column of the graph, with the jobs that fall in it. */
export type GraphColumn = {
  key: string;
  /** The stage's own name in `stage` mode; empty in `needs` mode, where a column is a
   *  dependency LEVEL and has no name of its own — the card names its stage instead, which
   *  is what GitLab's own dependency view does. */
  label: string;
  tone: PipelineTone;
  nodes: GraphNode[];
};

/** One curve: which job waits for which. Both ends are node keys. */
export type GraphEdge = { from: string; to: string };

/** A pipeline, laid out. */
export type PipelineGraph = {
  grouping: PipelineGrouping;
  columns: GraphColumn[];
  edges: GraphEdge[];
  /** Every node by key, for the renderer and for `relatedNodes`. */
  nodes: Map<string, GraphNode>;
};

/** A job's key. Its id, which is unique inside a pipeline where its name is not. */
export function jobKey(job: GitLabJob): string {
  return String(job.id);
}

/** Whether the DEPENDENCY grouping can be offered at all: some job has to wait for another
 *  job THIS graph holds. A pipeline ordered by its stages alone gets no switch, because a
 *  control that changes nothing on screen reads as a bug — the rule the diff's split toggle
 *  already follows on a narrow screen.
 *
 *  A declared `needs` is not enough on its own. One naming a bridge — a trigger job, which
 *  GitLab's jobs endpoint omits — is a dependency the graph can draw nothing for, so a
 *  pipeline whose only `needs` are those would offer a mode that lays every job in one
 *  column and joins none of them. */
export function canGroupByNeeds(jobs: readonly GitLabJob[] | null | undefined): boolean {
  const names = new Set((jobs ?? []).map((job) => job.name));
  return (jobs ?? []).some((job) =>
    (job.needs ?? []).some((need) => need !== job.name && names.has(need)),
  );
}

/** Which grouping to open on. Dependencies when the pipeline declares them — that is the
 *  shape its author wrote, and the one a stage view flattens away — and stages otherwise. */
export function defaultGrouping(jobs: readonly GitLabJob[] | null | undefined): PipelineGrouping {
  return canGroupByNeeds(jobs) ? "needs" : "stage";
}

/** Lay a pipeline out.
 *
 *  `grouping` is honoured only where it CAN be: asking for `needs` on a pipeline that
 *  declares none answers a stage layout rather than one column holding every job, because a
 *  single column is not a graph and the reader asked to see structure. */
export function pipelineGraph(
  view: GitLabPipelineView | null | undefined,
  grouping: PipelineGrouping,
): PipelineGraph {
  const jobs = view?.jobs ?? [];
  const effective: PipelineGrouping = grouping === "needs" && canGroupByNeeds(jobs) ? "needs" : "stage";
  const nodes = new Map<string, GraphNode>();
  // A `needs` names a job by NAME (GitLab declares dependencies per name), and an edge joins
  // two CARDS. So names are resolved to keys once, here — and a name carried by two cards, a
  // retried job, resolves to the newest of them: GitLab returns jobs oldest-first within a
  // stage, so the last one under a name is the run that counts.
  const keyByName = new Map<string, string>();
  for (const job of jobs) keyByName.set(job.name, jobKey(job));
  for (const job of jobs) {
    const key = jobKey(job);
    const needs = (job.needs ?? [])
      .map((name) => keyByName.get(name))
      .filter((need): need is string => !!need && need !== key);
    nodes.set(key, { key, job, tone: jobTone(job), needs: dedupe(needs) });
  }

  const columns =
    effective === "needs" ? needsColumns(jobs, nodes) : stageColumns(jobs, nodes);
  const edges: GraphEdge[] = [];
  for (const node of nodes.values()) {
    for (const need of node.needs) edges.push({ from: need, to: node.key });
  }
  return { grouping: effective, columns, edges, nodes };
}

/** Columns in GitLab's own stage order. Nothing is sorted — see `pipelineStages`. */
function stageColumns(jobs: readonly GitLabJob[], nodes: Map<string, GraphNode>): GraphColumn[] {
  return pipelineStages(jobs as GitLabJob[]).map((stage, index) => ({
    key: `${stage.name}:${index}`,
    label: stage.name,
    tone: jobsTone(stage.jobs),
    nodes: stage.jobs.map((job) => nodes.get(jobKey(job))!).filter(Boolean),
  }));
}

/** Columns by DEPENDENCY DEPTH: a job's column is one past the deepest job it waits for, so
 *  every curve travels left to right and a reader follows the run in reading order.
 *
 *  A job that waits for nothing is column 0 whatever its stage, which is the whole point of
 *  this mode — a lint job in the `test` stage that needs nothing starts at once, and the
 *  stage view is what hides that. */
function needsColumns(jobs: readonly GitLabJob[], nodes: Map<string, GraphNode>): GraphColumn[] {
  const depth = new Map<string, number>();
  const resolve = (key: string, seen: Set<string>): number => {
    const known = depth.get(key);
    if (known != null) return known;
    // GitLab refuses a cyclic `needs:`, so this cannot happen against a real pipeline — but a
    // walk that trusted that would hang the page rather than draw a slightly odd graph.
    if (seen.has(key)) return 0;
    seen.add(key);
    const node = nodes.get(key);
    const own = (node?.needs ?? []).reduce(
      (deepest, need) => Math.max(deepest, resolve(need, seen) + 1),
      0,
    );
    seen.delete(key);
    depth.set(key, own);
    return own;
  };
  const byColumn = new Map<number, GraphNode[]>();
  for (const job of jobs) {
    const key = jobKey(job);
    const node = nodes.get(key);
    if (!node) continue;
    const column = resolve(key, new Set());
    const bucket = byColumn.get(column);
    if (bucket) bucket.push(node);
    else byColumn.set(column, [node]);
  }
  return [...byColumn.keys()]
    .sort((a, b) => a - b)
    .map((column) => {
      const columnNodes = byColumn.get(column)!;
      return {
        key: `level:${column}`,
        label: "",
        tone: jobsTone(columnNodes.map((node) => node.job)),
        nodes: columnNodes,
      };
    });
}

/** The jobs one job's own run is about: itself, everything it waits for, and everything
 *  waiting on it — each followed all the way through.
 *
 *  It is what a reader points at a card to ask, and answering it with the DIRECT neighbours
 *  alone would be a half-answer: "what is holding this up" is a chain, not one step. What is
 *  NOT in the set is dimmed, which is how the whole graph answers in one look. */
export function relatedNodes(graph: PipelineGraph, key: string): Set<string> {
  if (!graph.nodes.has(key)) return new Set();
  const waitedOn = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const bucket = waitedOn.get(edge.from);
    if (bucket) bucket.push(edge.to);
    else waitedOn.set(edge.from, [edge.to]);
  }
  const related = new Set<string>([key]);
  const walk = (from: string, next: (of: string) => readonly string[]) => {
    const queue = [from];
    while (queue.length > 0) {
      const at = queue.pop()!;
      for (const step of next(at)) {
        if (related.has(step)) continue;
        related.add(step);
        queue.push(step);
      }
    }
  };
  walk(key, (of) => graph.nodes.get(of)?.needs ?? []);
  walk(key, (of) => waitedOn.get(of) ?? []);
  return related;
}

/** Whether an edge joins two jobs a reader is looking at, so the renderer can draw the rest
 *  of them faint. Both ends have to be in the set: an edge with one end outside it belongs to
 *  a run the reader did not ask about. */
export function edgeIsRelated(edge: GraphEdge, related: Set<string> | null): boolean {
  return !related || (related.has(edge.from) && related.has(edge.to));
}

/** How the graph says what it holds, in one line under the controls: "9 jobs · 3 stages", and
 *  what it had to leave out.
 *
 *  The count of DROPPED edges is deliberate. A `needs` may name a bridge — a trigger job,
 *  which GitLab's jobs endpoint omits — so the graph really does hold fewer curves than the
 *  pipeline declares, and a graph that stayed quiet about that would read as a complete one.
 *  It is the rule the diff's own truncation notice follows. */
export function graphSummary(
  view: GitLabPipelineView | null | undefined,
  graph: PipelineGraph,
): string {
  const jobs = view?.jobs ?? [];
  const parts = [count(jobs.length, "job")];
  if (graph.grouping === "stage") {
    parts.push(count(graph.columns.length, "stage"));
  } else {
    parts.push(count(graph.columns.length, "step"));
  }
  const declared = jobs.reduce((total, job) => total + (job.needs?.length ?? 0), 0);
  const drawn = graph.edges.length;
  if (declared > drawn) {
    parts.push(`${declared - drawn} of ${count(declared, "dependency", "dependencies")} lead outside this pipeline`);
  }
  return parts.join(" · ");
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function dedupe(keys: string[]): string[] {
  return [...new Set(keys)];
}
