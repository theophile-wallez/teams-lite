import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Loading02Icon,
  MinusSignCircleIcon,
  PlayIcon,
  TimeQuarterIcon,
} from "@hugeicons/core-free-icons";
import { formatJobDuration, jobsTone, type GitLabJob, type PipelineTone } from "~/lib/gitlab-mr";
import {
  edgeIsLit,
  relatedNodes,
  type GraphNode,
  type PipelineGraph,
} from "~/lib/gitlab-pipeline-graph";
import { cn } from "~/lib/utils";

// The pipeline drawn as a GRAPH: columns of job cards, with a curve from each job to the ones
// that wait for it. The layout — which card is in which column, which cards a curve joins, and
// what a reader is shown when they point at one — is pure and lives in
// `lib/gitlab-pipeline-graph.ts`. This file is the drawing, and only the drawing.
//
// **The geometry is MEASURED, never computed.** A card's height depends on the font, the
// length of the job's own name and the width the reader gave the window, so the curves are
// drawn between the cards' real boxes: the SVG sits inside the scrolling content, sized to it,
// and every path is re-derived when anything moves. A layout that predicted those boxes would
// be a second opinion about where a card is, and the wrong one on the first long job name.
//
// Five rules hold the surface, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **FOUR COLOURS, and they are a closed set** (`PipelineTone`): green done, orange for a
//     failure nobody has to fix, red for one somebody does, neutral for everything not
//     finished. `running` takes the neutral ink and says it is moving with MOTION, because a
//     fifth hue in a wall of cards would cost the three that mean something their meaning.
//   - **Colour is never the only signal.** Every card carries its own glyph and states its
//     status or its duration in words, so the graph reads with no colour vision at all.
//   - **It scrolls SIDEWAYS, and the page it is in does not.** A pipeline is as wide as its
//     longest chain — measured at 4 columns by dependency and 8 stages on this tenant — and a
//     graph that widened its container would take a phone's whole layout with it.
//   - **Pointing at a card answers "what is this waiting for, and what waits for it"**
//     (`relatedNodes`, followed the whole way through), by drawing everything else faint. It is
//     an enhancement and never the only way to read the graph: there is no hover on a phone.
//   - **Nothing here writes.** GitLab's own graph puts a RETRY on every card; this app reads
//     trackers and the four writes it offers are elsewhere, each behind its own consent gate
//     (AGENTS.md § The trackers). A card links to the job in GitLab and does nothing else.

/** How much room the graph has: the merge-request panel's column, or its own page. Cards and
 *  gaps shrink together, so the curves keep their shape either way. */
export type GraphDensity = "compact" | "full";

export function PipelineGraphView(props: {
  graph: PipelineGraph;
  /** Whether the dependency curves are drawn. They are a fact about the pipeline rather than
   *  about the grouping, so the stage columns can carry them too — which is what makes
   *  "grouped by stage, with the dependencies lit" a reading a stage view cannot otherwise
   *  give. */
  showNeeds: boolean;
  density?: GraphDensity;
  className?: string;
}) {
  const { graph, showNeeds } = props;
  const density = props.density ?? "full";
  const [focused, setFocused] = useState<string | null>(null);
  const related = useMemo(
    () => (focused ? relatedNodes(graph, focused) : null),
    [graph, focused],
  );
  // Whether this curve is part of the chain the reader is pointing at. Nothing is lit at rest —
  // the rule lives in `edgeIsLit`, so it is unit-tested rather than implied here.
  const lit = (edge: { from: string; to: string }) => edgeIsLit(edge, related);
  const scroller = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const edges = useEdgePaths(graph, scroller, cards, showNeeds);

  // A card leaving the tree takes its box with it, or a graph that changed under a poll would
  // keep drawing curves to jobs that are gone.
  const register = useCallback((key: string, element: HTMLElement | null) => {
    if (element) cards.current.set(key, element);
    else cards.current.delete(key);
  }, []);

  return (
    <div
      ref={scroller}
      data-testid="gitlab-pipeline-graph"
      data-grouping={graph.grouping}
      data-needs={showNeeds ? "shown" : "hidden"}
      data-focused={focused ?? undefined}
      // The graph is the one thing in this app that is genuinely wider than its column, so it
      // owns a scroller of its own. `overflow-y-hidden` is deliberate: a column taller than the
      // box grows the PANEL (which scrolls already) rather than trapping a second scrollbar
      // inside a page that has one.
      // The run starts at the TOP of the room it is given, under the controls that decide how it
      // is drawn — a reader's eye follows those down into it. Centring was tried and is wrong on
      // a page as tall as a screen: a four-row pipeline floated in the middle with a hand's width
      // of nothing above it. The COLUMNS inside stay top-aligned against each other too, or the
      // first card of each would sit on a different line from its neighbours.
      // `isolate` is load-bearing: the curves sit at `-z-10` so a card's own background hides
      // whatever runs under it, and without a stacking context HERE that negative layer falls
      // behind the PAGE's background instead — which draws no curves at all.
      className={cn(
        "relative isolate flex min-w-0 items-start overflow-x-auto overflow-y-hidden",
        props.className,
      )}
      onPointerLeave={() => setFocused(null)}
    >
      {/* The curves, BEHIND the cards and deaf to the pointer: an edge is a statement about two
          cards, never something to press — and a card is opaque, so a curve that runs past one
          goes under it rather than across its words. `-z-10` is what puts it there: without a
          layer of its own, a positioned sibling paints over the cards' own backgrounds. */}
      <svg
        data-testid="gitlab-pipeline-edges"
        className="pointer-events-none absolute left-0 top-0 -z-10 overflow-visible"
        width={edges.width}
        height={edges.height}
        aria-hidden
      >
        {edges.paths.map((path) => (
          <path
            key={`${path.from}->${path.to}`}
            data-testid="gitlab-pipeline-edge"
            data-from={path.from}
            data-to={path.to}
            data-lit={lit(path) ? "true" : "false"}
            d={path.d}
            fill="none"
            strokeWidth={lit(path) ? 2 : 1.5}
            className={cn(
              "transition-[stroke,opacity,stroke-width] duration-200",
              // At REST the graph is one neutral colour: a wall of accent-coloured wires says
              // every dependency matters, which is the same as saying none does. The accent is
              // what a POINTER buys — the chain of the job under it, and only that.
              lit(path)
                ? "stroke-primary opacity-100"
                : related
                  ? "stroke-border opacity-30"
                  : "stroke-border opacity-70",
            )}
          />
        ))}
      </svg>

      <div
        className={cn(
          "relative flex w-max items-start",
          density === "compact" ? "gap-8 p-1" : "gap-14 p-2",
        )}
      >
        {graph.columns.map((column) => (
          <div
            key={column.key}
            data-testid="gitlab-pipeline-column"
            data-stage={column.label || undefined}
            data-tone={column.tone}
            className={cn("flex flex-col", density === "compact" ? "gap-1.5" : "gap-2")}
          >
            {/* A stage column is NAMED; a dependency column is a level and has no name of its
                own — the card names its stage instead, which is what GitLab's own dependency
                view does. The heading's room is kept either way, so the cards of every column
                start on one line. */}
            <div className="flex h-5 items-center gap-1.5 px-1">
              {column.label ? (
                <>
                  <ToneDot tone={column.tone} />
                  <span className="truncate text-[11px] font-medium text-text-dim">
                    {column.label}
                  </span>
                  <span className="text-[11px] text-text-faint">{column.nodes.length}</span>
                </>
              ) : null}
            </div>
            {column.nodes.map((node) => (
              <JobCard
                key={node.key}
                node={node}
                density={density}
                showStage={!column.label}
                dimmed={!!related && !related.has(node.key)}
                onRef={register}
                onFocus={() => setFocused(node.key)}
                onBlur={() => setFocused((at) => (at === node.key ? null : at))}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One job. A link to the job in GitLab when it has a page, plain otherwise — and never a
 *  control, because everything this card could otherwise offer is a write (see the header). */
function JobCard(props: {
  node: GraphNode;
  density: GraphDensity;
  /** Whether the card says which stage the job is in. It does in a dependency column, where
   *  the column cannot; a stage column already said it once. */
  showStage: boolean;
  dimmed: boolean;
  onRef: (key: string, element: HTMLElement | null) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const { node, density } = props;
  const job = node.job;
  const duration = formatJobDuration(job.duration);
  // What the card SAYS, which is never the colour: the time it took once it has one, and the
  // state it is in until then.
  const words = duration || job.status || "unknown";
  const Element = job.web_url ? "a" : "div";
  return (
    <Element
      ref={(element: HTMLElement | null) => props.onRef(node.key, element)}
      data-testid="gitlab-pipeline-job"
      data-job={node.key}
      data-name={job.name}
      data-status={job.status}
      data-tone={node.tone}
      data-related={props.dimmed ? "false" : "true"}
      {...(job.web_url
        ? { href: job.web_url, target: "_blank", rel: "noreferrer" }
        : {})}
      title={`${job.name} — ${job.stage} · ${words}`}
      aria-label={`${job.name}, ${job.stage}, ${words}`}
      onPointerEnter={props.onFocus}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      className={cn(
        // `bg-card` is OPAQUE and stays that way in every state. The whole card used to take an
        // `opacity` when another job was pointed at, and a translucent card lets the curves
        // behind it show through its own words — so what fades is the CONTENT below, and the
        // surface keeps hiding whatever runs under it.
        "group relative flex items-center gap-2 rounded-xl border bg-card transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        density === "compact" ? "w-44 px-2 py-1.5" : "w-56 px-2.5 py-2",
        // A dimmed card's ring goes neutral rather than translucent, for the same reason.
        props.dimmed ? "border-border-subtle" : toneBorder(node.tone),
        job.web_url && !props.dimmed && "hover:border-border hover:shadow-sm",
      )}
    >
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 transition-opacity duration-200",
          props.dimmed ? "opacity-40" : "opacity-100",
        )}
      >
      <StatusGlyph tone={node.tone} status={job.status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate font-medium text-foreground",
            density === "compact" ? "text-[11px]" : "text-[12px]",
          )}
        >
          {job.name}
        </span>
        {/* Two lines only where they say two things: the stage in a dependency column, and the
            fact a failure was allowed — a red mark on something nobody has to fix is what
            teaches a reader to ignore red. */}
        {(props.showStage || (job.allow_failure && job.status === "failed")) && (
          <span className="truncate text-[10px] text-text-faint">
            {props.showStage ? job.stage : ""}
            {props.showStage && job.allow_failure && job.status === "failed" ? " · " : ""}
            {job.allow_failure && job.status === "failed" ? "allowed to fail" : ""}
          </span>
        )}
      </span>
      <span
        className={cn(
          "shrink-0 tabular-nums text-text-faint",
          density === "compact" ? "text-[10px]" : "text-[11px]",
        )}
      >
        {words}
      </span>
      </span>
    </Element>
  );
}

/** The glyph that says what happened, in the tone that means it. It is the half of the signal
 *  that survives without colour — and the ONE state drawn with motion is `running`, which has
 *  the neutral ink of every other unfinished job.
 *
 *  Two neutral states get a glyph of their own, because "nothing has happened yet" covers three
 *  different situations and only one of them is waiting on time: a MANUAL job waits on a person
 *  (so it wears the play mark it is started with), and a SKIPPED one will never run at all. */
function StatusGlyph(props: { tone: PipelineTone; status?: string }) {
  // The STATUS decides the glyph, not the tone, because `running` as a tone means "worth
  // polling" and covers a job that has not started. Only one that really is running turns.
  const turning = props.status === "running";
  const icon =
    props.tone === "success"
      ? CheckmarkCircle02Icon
      : props.tone === "failed" || props.tone === "warning"
        ? Alert02Icon
        : turning
          ? Loading02Icon
          : props.status === "manual"
            ? PlayIcon
            : props.status === "skipped" || props.status === "canceled"
              ? MinusSignCircleIcon
              : TimeQuarterIcon;
  return (
    <HugeiconsIcon
      icon={icon}
      data-testid="gitlab-pipeline-glyph"
      data-tone={props.tone}
      data-turning={turning ? "true" : undefined}
      className={cn("size-4 shrink-0", toneInk(props.tone), turning && "animate-spin")}
      strokeWidth={1.8}
    />
  );
}

/** A tone as a dot. Its meaning is in its `title`, because a dot is the one thing on this
 *  surface with no words of its own. Exported because the panel, the page's legend and its job
 *  list all draw one, and four spellings of one dot would drift at the first tone added. */
export function ToneDot(props: { tone: PipelineTone; className?: string }) {
  return (
    <span
      data-testid="gitlab-tone"
      data-tone={props.tone}
      title={TONE_WORDS[props.tone]}
      className={cn("size-2 shrink-0 rounded-full", toneFill(props.tone), props.className)}
    />
  );
}

/** The pipeline's own state, in GitLab's word and this app's tone.
 *
 *  The JOBS decide the tone beside the status, because GitLab calls a pipeline `success` while a
 *  job allowed to fail sits red inside it — and "passed", flat green, over a red job is the one
 *  thing this badge must not say. Both the merge-request panel and the pipeline page draw it, so
 *  there is one answer in this app to "how did the run go". */
export function PipelineStatusBadge(props: {
  status: string;
  jobs: readonly GitLabJob[];
  className?: string;
}) {
  const tone = jobsTone(props.jobs);
  return (
    <span
      data-testid="gitlab-pipeline-status"
      data-status={props.status}
      data-tone={tone}
      title={TONE_WORDS[tone]}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "success"
          ? "bg-success/12 text-success"
          : tone === "failed"
            ? "bg-destructive/12 text-destructive"
            : tone === "warning"
              ? "bg-warning/12 text-warning"
              : "bg-element text-text-dim",
        props.className,
      )}
    >
      {props.status}
    </span>
  );
}

/** The four words the four colours mean, for a reader who cannot see one of them. */
export const TONE_WORDS: Record<PipelineTone, string> = {
  success: "done",
  warning: "done, with a failure nobody has to fix",
  failed: "failed",
  running: "still running",
  idle: "not started",
};

function toneInk(tone: PipelineTone): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "failed":
      return "text-destructive";
    case "warning":
      return "text-warning";
    case "running":
      return "text-text-dim";
    default:
      return "text-text-faint";
  }
}

/** A tone as a fill. `running` takes the neutral ink and breathes: motion is what says "still
 *  going", never a fifth colour. Private, because every dot in this section is a `ToneDot`. */
function toneFill(tone: PipelineTone): string {
  switch (tone) {
    case "success":
      return "bg-success";
    case "failed":
      return "bg-destructive";
    case "warning":
      return "bg-warning";
    case "running":
      return "animate-pulse bg-text-dim";
    default:
      return "bg-text-faint/40";
  }
}

function toneBorder(tone: PipelineTone): string {
  switch (tone) {
    case "success":
      return "border-success/30";
    case "failed":
      return "border-destructive/40";
    case "warning":
      return "border-warning/40";
    default:
      return "border-border-subtle";
  }
}

type EdgePath = { from: string; to: string; d: string };

/** The curves, measured off the cards themselves.
 *
 *  It runs after every layout that could have moved one — the graph changing under a poll, the
 *  container being resized, the reader's window — because a stale path is a line pointing at
 *  where a card used to be. `ResizeObserver` on the scroller covers the two cases a window
 *  listener misses: the merge-request panel narrowing under a sibling, and the cards
 *  themselves growing when a job name arrives. */
function useEdgePaths(
  graph: PipelineGraph,
  scroller: React.RefObject<HTMLDivElement | null>,
  cards: React.RefObject<Map<string, HTMLElement>>,
  showNeeds: boolean,
) {
  const [state, setState] = useState<{ paths: EdgePath[]; width: number; height: number }>({
    paths: [],
    width: 0,
    height: 0,
  });

  const measure = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    if (!showNeeds) {
      setState({ paths: [], width: 0, height: 0 });
      return;
    }
    const origin = box.getBoundingClientRect();
    const paths: EdgePath[] = [];
    for (const edge of graph.edges) {
      const from = cards.current?.get(edge.from);
      const to = cards.current?.get(edge.to);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      // Relative to the SCROLLING CONTENT, not the viewport: the SVG lives inside it, so a
      // graph scrolled sideways keeps its curves on its cards with nothing to recompute.
      const x1 = a.right - origin.left + box.scrollLeft;
      const y1 = a.top + a.height / 2 - origin.top + box.scrollTop;
      const x2 = b.left - origin.left + box.scrollLeft;
      const y2 = b.top + b.height / 2 - origin.top + box.scrollTop;
      // A horizontal-tangent cubic: the curve leaves a card sideways and arrives sideways, so
      // it reads as a wire between two boxes rather than as a diagonal crossing them. The pull
      // is half the gap, floored so two cards in ONE column (a dependency inside a stage, which
      // GitLab allows) still get a curve with a shape rather than a spike.
      const pull = Math.max(24, (x2 - x1) / 2);
      paths.push({
        from: edge.from,
        to: edge.to,
        d: `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`,
      });
    }
    setState({ paths, width: box.scrollWidth, height: box.scrollHeight });
  }, [graph, scroller, cards, showNeeds]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const box = scroller.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const card of cards.current?.values() ?? []) observer.observe(card);
    return () => observer.disconnect();
  }, [measure, scroller, cards]);

  return state;
}
