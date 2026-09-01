import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Anser, { type AnserJsonEntry } from "anser";
import { useVirtualizer } from "@tanstack/react-virtual";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  ChevronLeftIcon,
  Link01Icon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { formatJobDuration, jobTone, type GitLabJobDetail } from "~/lib/gitlab-mr";
import {
  allSectionIds,
  emptyJobLogReason,
  filterLogLines,
  jobLogIsLive,
  jobLogSummary,
  jobLogTruncation,
  jobLogUnreadable,
  parseJobLog,
  visibleLogLines,
  type JobLogDocument,
  type JobLogLine,
} from "~/lib/gitlab-job-log";
import { gitlabPageUrl } from "~/lib/gitlab-mr-pages";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { GitLabLogo } from "./gitlab-logo";
import { MergeRequestPageStrip } from "./gitlab-mr-pages";
import { ToneDot, TONE_WORDS } from "./gitlab-pipeline-graph";
import { FadeArc } from "./loading-ui/fade-arc";

// ONE JOB'S LOG, as a page of its own (`/mr/<id>/jobs/<jobId>` — see
// routes/_app.mr.$mergeRequestId.jobs.$jobId.tsx). It is where a job card on the Pipelines page
// goes: a card says a job failed, and the only thing anybody wants next is why.
//
// **It is a page for the diff page's own reasons.** A log measured 4 238 lines and 510 KB on this
// instance, with one line 22 129 bytes wide — that has no room inside a column which also holds a
// description, a pipeline, the actions and a conversation, and reading a red job is somewhere a
// reader STAYS. Three things come with the URL and none is available to a piece of state: it
// survives a reload, it can be sent to whoever is asking why CI is red, and the browser's own
// Back leaves it.
//
// The parse is PURE and lives in `lib/gitlab-job-log.ts`, which is where every measured fact
// about a GitLab trace is written down. This file is the drawing, and the drawing's own rules —
// each pinned by `web/e2e/gitlab.spec.ts`:
//
//   - **The rows are VIRTUALIZED, over this app's own virtualizer.** Thousands of rows is what a
//     log is, and it is the same `@tanstack/react-virtual` the chat history, the mail list and
//     the merge-request sidebar already scroll with — a second virtualization library for the
//     fifth list in this app would be the icon-set mistake in another vocabulary.
//   - **The ANSI is `anser`'s** (MIT, no dependencies), which is the one part of this worth a
//     dependency: 35 856 escape sequences travel in 48 logs here, over 16 colours, a 256-colour
//     cube and truecolor, and a hand-rolled parser would be wrong on the first `cargo` line. It
//     is given `use_classes`, so WHAT a colour means is this app's decision in `app.css` and each
//     theme keeps a legible palette — the seam the pierre packages are held to, in reverse.
//   - **It never WRAPS, and the numbers never leave.** A 22 KB line wrapped is 200 rows of one
//     line, which would make every row's height a measurement and the scrollbar a guess; so the
//     page scrolls SIDEWAYS like a terminal, and the line-number gutter is sticky against it.
//   - **A search FILTERS.** In 4 000 lines "which lines say `error`" is the question, and
//     scrolling to a tinted word is not an answer to it. A filtered row keeps the log's own line
//     number, and pressing that number is what takes the reader back to it in place.
//   - **The sections are the runner's**, folded and unfolded from their own opening line, with
//     what each one COST — which is the number somebody looking at a slow pipeline came for.
//   - **A LIVE log follows itself, until the reader scrolls back.** The store polls exactly while
//     the job has not finished; this page sticks to the newest line while the reader is at the
//     bottom and lets go the moment they are not — the rule the agent transcript already holds.
//   - **Nothing here writes.** GitLab's own job page offers Retry, Cancel and Erase; this app
//     reads trackers, and the writes it offers are elsewhere behind their own consent gates
//     (AGENTS.md § The trackers). The way out to GitLab is where those live.

/** One row's height, and the type it is set in. A constant rather than a measurement, because
 *  nothing here wraps: every row is exactly one line, which is what lets the virtualizer place
 *  4 000 of them without measuring one. */
const LINE_HEIGHT = 19;
const FONT_SIZE = 12;

/** How near the bottom counts as "at the bottom", in pixels. One row's height plus a little: a
 *  reader who has not deliberately scrolled back is following the log. */
const AT_BOTTOM_SLACK = LINE_HEIGHT * 2;

export function GitLabJobLogPage(props: { onBack: () => void }) {
  const controller = useController();
  const detail = useAppState((s) => s.gitlabDetail);
  const log = useAppState((s) => s.gitlabJobLog);
  const jobId = useAppState((s) => s.gitlabJobId);
  const loading = useAppState((s) => s.gitlabJobLogLoading);
  const error = useAppState((s) => s.gitlabJobLogError);
  // The pipeline read is already on this page's own state, so the header can NAME the job while
  // its log is still travelling — a header that said "Job" for two seconds would be a page that
  // does not know what it is showing.
  const pipeline = useAppState((s) => s.gitlabPipeline);
  const card = useMemo(
    () => (pipeline?.jobs ?? []).find((job) => job.id === jobId) ?? null,
    [pipeline, jobId],
  );

  const doc = useMemo(() => parseJobLog(log?.trace), [log?.trace]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  // The rows in two steps, because the two answer different questions: the FOLD decides which
  // lines are part of the document a reader is looking at, and the FILTER then narrows that to
  // the ones they asked about.
  const visible = useMemo(() => visibleLogLines(doc, folded), [doc, folded]);
  const rows = useMemo(() => filterLogLines(visible, query), [visible, query]);
  const filtering = query.trim().length > 0;

  // A new JOB starts with nothing folded and nothing searched: both are answers about the log the
  // reader was reading, and carrying them over would open the next one half hidden.
  useEffect(() => {
    setFolded(new Set());
    setQuery("");
  }, [jobId]);

  const toggleSection = useCallback((id: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const live = jobLogIsLive(log);
  const job = log?.job ?? null;
  const truncation = jobLogTruncation(log);
  // The LOG failed while the job answered — a different thing from a job that printed nothing,
  // and the one sentence this page must not swap for the other.
  const unreadable = jobLogUnreadable(log);
  const gitlabUrl = job?.web_url ?? card?.web_url ?? null;

  return (
    <section
      data-testid="gitlab-job-log-page"
      data-job={jobId ?? undefined}
      data-live={live ? "true" : undefined}
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-4">
        {/* Back leaves the log for the pipeline the reader pressed a card on. One control, because
            "back" means one thing: out of where I am. */}
        <button
          type="button"
          data-testid="gitlab-job-back"
          aria-label="Back to the pipeline"
          onClick={props.onBack}
          className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
        </button>
        <GitLabLogo className="size-5 shrink-0" title="GitLab" />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* WHICH job, from whichever read arrived first — and the merge request under it,
              because a full-screen page has nothing else to say where the reader is. */}
          <h1
            data-testid="gitlab-job-title"
            className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground"
          >
            {(job ?? card) && <ToneDot tone={jobTone(job ?? card!)} />}
            <span className="truncate">{job?.name ?? card?.name ?? "Job log"}</span>
          </h1>
          <p className="truncate text-[11px] text-text-faint">
            {detail ? `${detail.reference} · ` : ""}
            {/* What the log IS, once it is here. A read that FAILED says nothing here: the
                failure is the whole screen below, and "Reading the log…" over a refusal would be
                this app saying it is still trying. */}
            <span data-testid="gitlab-job-summary">
              {log
                ? jobLogSummary({ bytes: log.bytes, lines: doc.lines.length })
                : error
                  ? ""
                  : "Reading the log…"}
            </span>
          </p>
        </div>
        {/* GitLab's own job page: where a Retry, a Cancel and an Erase live, none of which this
            app offers (see the header above). */}
        {gitlabUrl && (
          <a
            href={gitlabUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="gitlab-job-link"
            title="Open this job in GitLab"
            aria-label="Open this job in GitLab"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Link01Icon} className="size-4" strokeWidth={1.6} />
          </a>
        )}
      </header>

      {/* The same sub-header every page of a merge request carries, with PIPELINES current: a job
          is read from that page, and a reader who wanted the Commits of what they are looking at
          must not have to go back for the strip (see `gitlab-mr-pages.tsx`). */}
      <MergeRequestPageStrip current="pipelines" className="md:px-4" />

      {/* What the job DID, in one line: the state in words, what it cost, what ran it, and — when
          GitLab said one — why it failed. A log cannot always say that last one for itself: a job
          killed for taking too long ends mid-sentence with nothing to explain it. */}
      <JobFacts job={job} fallback={card} />

      {error && !log ? (
        <JobLogFailure error={error} webUrl={detail?.web_url} />
      ) : !log ? (
        <JobLogLoading label="Reading the log…" />
      ) : unreadable ? (
        // The job answered and its LOG did not. "This job printed nothing" would be this app
        // stating something it was never told, so the reason is stated instead — and GitLab's own
        // job page is the one thing left.
        <JobLogFailure error={unreadable} webUrl={detail?.web_url} jobUrl={gitlabUrl} />
      ) : doc.lines.length === 0 ? (
        <p
          data-testid="gitlab-job-log-empty"
          className="flex flex-1 items-center justify-center p-8 text-center text-[13px] text-text-faint"
        >
          {emptyJobLogReason(job ?? {})}
        </p>
      ) : (
        <>
          <LogControls
            query={query}
            onQuery={setQuery}
            matches={filtering ? rows.length : null}
            sections={doc.sections.length}
            allFolded={folded.size > 0 && folded.size >= doc.sections.length}
            onFoldAll={() =>
              setFolded((current) =>
                current.size >= doc.sections.length ? new Set() : new Set(allSectionIds(doc)),
              )
            }
            loading={loading}
            live={live}
            onReload={() => void controller.reloadJobLog()}
          />
          {truncation && (
            <p
              data-testid="gitlab-job-log-truncated"
              className="shrink-0 border-b border-border-subtle px-3 py-1.5 text-[11px] text-text-faint md:px-4"
            >
              {truncation}
            </p>
          )}
          <LogBody
            rows={rows}
            doc={doc}
            folded={folded}
            onToggleSection={toggleSection}
            follow={live && !filtering}
            // A filtered row's own number is the way back into the log in place: the filter goes,
            // and the row draws the reader to the line so they can read what is around it — which
            // is the half a filter cannot give them.
            onClearFilter={() => setQuery("")}
          />
        </>
      )}
    </section>
  );
}

/** What the job did, beside its own state. Every field GitLab omits until a job has run is left
 *  out rather than drawn as a zero — a `manual` job waited for nobody and took no time. */
function JobFacts(props: { job: GitLabJobDetail | null; fallback: { status: string; stage: string; allow_failure: boolean } | null }) {
  const job = props.job;
  const state = job ?? props.fallback;
  if (!state) return null;
  const duration = formatJobDuration(job?.duration);
  const queued = formatJobDuration(job?.queued_duration);
  return (
    <div
      data-testid="gitlab-job-facts"
      data-status={state.status}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-2 text-[11px] text-text-faint md:px-4"
    >
      <span className="font-medium text-text-dim">{state.stage}</span>
      {/* GitLab's own word for the state, and this app's for it — but only where the two say
          different things: `failed` twice over is a row that reads as a rendering fault, while
          "still running" beside `running` and "done, with a failure nobody has to fix" beside
          `failed` are the sentence the colour cannot carry. A colour is never the only signal
          here, which is the rule the pipeline graph holds. */}
      {TONE_WORDS[jobTone(state)] !== state.status && <span>{TONE_WORDS[jobTone(state)]}</span>}
      <span>{state.status}</span>
      {state.allow_failure && state.status === "failed" && <span>allowed to fail</span>}
      {duration && <span className="tabular-nums">ran {duration}</span>}
      {queued && <span className="tabular-nums">queued {queued}</span>}
      {job?.runner && <span className="truncate">on {job.runner}</span>}
      {job?.failure_reason && (
        <span data-testid="gitlab-job-failure-reason" className="text-destructive">
          {job.failure_reason.replace(/_/g, " ")}
        </span>
      )}
    </div>
  );
}

/** The row of controls: the filter, the fold, and the reader's own Reload. */
function LogControls(props: {
  query: string;
  onQuery: (query: string) => void;
  /** How many lines the filter kept, or `null` when nothing is being filtered. */
  matches: number | null;
  sections: number;
  allFolded: boolean;
  onFoldAll: () => void;
  loading: boolean;
  live: boolean;
  onReload: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2 md:px-4">
      <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-element px-2 py-1">
        <HugeiconsIcon
          icon={Search01Icon}
          className="size-3.5 shrink-0 text-text-faint"
          strokeWidth={1.8}
        />
        <input
          // `text` rather than `search`: a search input draws the BROWSER's own clear cross, and
          // two crosses in one box is a control the reader has to choose between.
          type="text"
          data-testid="gitlab-job-log-search"
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder="Filter the lines"
          aria-label="Filter the log's lines"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-text-faint"
        />
        {props.query && (
          <button
            type="button"
            data-testid="gitlab-job-log-search-clear"
            aria-label="Clear the filter"
            onClick={() => props.onQuery("")}
            className="grid size-4 shrink-0 place-items-center rounded text-text-faint hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-3" strokeWidth={2} />
          </button>
        )}
      </label>
      {/* What the filter found, stated: a filter that answered nothing looks exactly like a log
          that arrived empty. */}
      {props.matches !== null && (
        <span data-testid="gitlab-job-log-matches" className="shrink-0 text-[11px] text-text-faint">
          {props.matches === 0
            ? "no line matches"
            : `${props.matches.toLocaleString("en-GB")} ${props.matches === 1 ? "line" : "lines"}`}
        </span>
      )}
      {props.sections > 0 && (
        <button
          type="button"
          data-testid="gitlab-job-log-fold-all"
          aria-pressed={props.allFolded}
          onClick={props.onFoldAll}
          className="shrink-0 rounded-lg bg-element px-2.5 py-1 text-[11px] font-medium text-text-dim transition-colors hover:text-foreground"
        >
          {props.allFolded ? "Unfold all" : "Fold all"}
        </button>
      )}
      {/* A live log says so, and the store is what makes it true: the poll is armed exactly while
          the job has not finished. */}
      {props.live && (
        <span
          data-testid="gitlab-job-log-live"
          className="flex shrink-0 items-center gap-1 text-[11px] text-text-faint"
        >
          <ToneDot tone="running" />
          following
        </span>
      )}
      <button
        type="button"
        data-testid="gitlab-job-log-reload"
        aria-label="Read the log again"
        title="Read the log again"
        disabled={props.loading}
        onClick={props.onReload}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground",
          props.loading && "opacity-60",
        )}
      >
        {props.loading ? (
          <FadeArc className="size-3.5" />
        ) : (
          <HugeiconsIcon icon={RefreshIcon} className="size-3.5" strokeWidth={1.8} />
        )}
      </button>
    </div>
  );
}

/**
 * The log itself: one virtualized row per line.
 *
 * The scroller owns BOTH directions — down the log and sideways along a line — and the row is as
 * wide as its own text, which is what a terminal does with a 22 KB line. The gutter is sticky
 * against the sideways scroll, because a line number that scrolls away takes with it the one
 * thing that says where the reader is.
 */
function LogBody(props: {
  rows: JobLogLine[];
  doc: JobLogDocument;
  folded: ReadonlySet<string>;
  onToggleSection: (id: string) => void;
  follow: boolean;
  onClearFilter: () => void;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => LINE_HEIGHT,
    getItemKey: (index) => props.rows[index]?.number ?? index,
    overscan: 24,
  });

  // Whether the reader is AT the bottom. It is what decides whether a live log keeps following:
  // the moment somebody scrolls back to read what went wrong, the log stops moving under them —
  // and returning to the bottom takes it up again, so there is no control to find.
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    setAtBottom(box.scrollHeight - box.scrollTop - box.clientHeight <= AT_BOTTOM_SLACK);
  }, []);

  const sections = useMemo(
    () => new Map(props.doc.sections.map((section) => [section.id, section])),
    [props.doc],
  );

  // A live log opens at its END and stays there. That is the honest place for a log somebody
  // opened while it was being written: the newest line is the one they came for.
  const count = props.rows.length;
  useEffect(() => {
    if (!props.follow || !atBottom || count === 0) return;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
    // `count` is what moves when a poll brings new lines; the virtualizer's own identity does
    // not, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, props.follow, atBottom]);

  /** Scroll to one of the log's own line numbers, whatever is being drawn — which is how a
   *  filtered row's number takes the reader back to the line in place. */
  const goTo = useCallback(
    (number: number) => {
      props.onClearFilter();
      // The row set changes in the same commit as the filter that was just cleared, so the scroll
      // waits a frame for it: the index of a line is a question about the rows on screen.
      requestAnimationFrame(() => {
        const index = props.doc.lines.findIndex((line) => line.number === number);
        if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
      });
    },
    [props, virtualizer],
  );

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      data-testid="gitlab-job-log"
      data-rows={props.rows.length}
      data-following={props.follow && atBottom ? "true" : undefined}
      // `overflow-auto` in BOTH directions: down the log, and along a line that a terminal would
      // not have wrapped either. `ansi-log` is the seam onto the palette in app.css.
      className="ansi-log min-h-0 flex-1 overflow-auto bg-card font-mono"
      style={{ fontSize: FONT_SIZE, lineHeight: `${LINE_HEIGHT}px` }}
    >
      <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const line = props.rows[item.index];
          if (!line) return null;
          const section = line.opens ? sections.get(line.opens) : undefined;
          return (
            <div
              key={item.key}
              data-testid="gitlab-job-log-line"
              data-line={line.number}
              data-section={line.section ?? undefined}
              data-opens={line.opens ?? undefined}
              className="absolute left-0 top-0 flex w-max min-w-full items-center"
              style={{ height: LINE_HEIGHT, transform: `translateY(${item.start}px)` }}
            >
              {/* The gutter. Sticky against the sideways scroll, and a control: pressing a line
                  number is how a reader gets from a filtered row back to the line in place. */}
              <button
                type="button"
                data-testid="gitlab-job-log-number"
                aria-label={`Go to line ${line.number}`}
                onClick={() => goTo(line.number)}
                className={cn(
                  "sticky left-0 z-10 h-full w-14 shrink-0 select-none bg-card pr-2 text-right",
                  "tabular-nums text-text-faint transition-colors hover:text-text-dim",
                )}
              >
                {line.number}
              </button>
              {/* A line that OPENS a section carries the fold, what the section is called and what
                  it cost. Everything else is the log's own words. */}
              {section && (
                <button
                  type="button"
                  data-testid="gitlab-job-log-section"
                  data-section={section.id}
                  data-folded={props.folded.has(section.id) ? "true" : undefined}
                  aria-expanded={!props.folded.has(section.id)}
                  onClick={() => props.onToggleSection(section.id)}
                  title={`${section.label} — ${section.lines} lines`}
                  className="flex h-full shrink-0 items-center gap-1 pr-2 text-text-dim transition-colors hover:text-foreground"
                  style={{ paddingLeft: section.depth * 10 }}
                >
                  <HugeiconsIcon
                    icon={props.folded.has(section.id) ? ArrowRight01Icon : ArrowDown01Icon}
                    className="size-3.5"
                    strokeWidth={2}
                  />
                  <span className="font-sans text-[11px] font-medium">{section.label}</span>
                  {section.seconds !== null && (
                    <span className="font-sans text-[11px] tabular-nums text-text-faint">
                      {formatJobDuration(section.seconds)}
                    </span>
                  )}
                </button>
              )}
              <span className="min-w-0 shrink-0 whitespace-pre pr-4 text-foreground">
                <AnsiLine text={line.text} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One line's ANSI, as spans.
 *
 * `anser` does the parse — the one part of this feature worth a dependency, because 35 856 escape
 * sequences travel in 48 logs here across 16 colours, a 256-colour cube and truecolor. It is
 * asked for CLASSES rather than colours, so what a colour MEANS belongs to `app.css` and each
 * theme keeps a palette a reader can actually read; only the cube and truecolor resolve to a
 * value here, because neither can be a class.
 *
 * Parsed per VISIBLE row rather than per line of the log: a page holds sixty rows and a log holds
 * four thousand.
 */
function AnsiLine(props: { text: string }) {
  const parts = useMemo(
    () =>
      props.text.includes("\x1b")
        ? Anser.ansiToJson(props.text, { use_classes: true, remove_empty: true })
        : null,
    [props.text],
  );
  if (!parts) return <>{props.text}</>;
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} className={ansiClass(part)} style={ansiStyle(part)}>
          {part.content}
        </span>
      ))}
    </>
  );
}

/** The classes one span wears: the palette's own, plus the decorations as this app spells them. */
function ansiClass(part: AnserJsonEntry): string | undefined {
  const classes: string[] = [];
  if (part.fg && !isValue(part.fg)) classes.push(`${part.fg}-fg`);
  if (part.bg && !isValue(part.bg)) classes.push(`${part.bg}-bg`);
  for (const decoration of part.decorations ?? []) {
    // Only the decorations a log really uses. `blink` and `hidden` are deliberately not among
    // them: one is a distraction in a page of text and the other would hide a line somebody
    // needs. `dim` is opacity rather than a colour, so it survives whatever the ink is.
    if (decoration === "bold") classes.push("font-semibold");
    else if (decoration === "italic") classes.push("italic");
    else if (decoration === "underline") classes.push("underline");
    else if (decoration === "strikethrough") classes.push("line-through");
    else if (decoration === "dim") classes.push("opacity-60");
  }
  return classes.length > 0 ? classes.join(" ") : undefined;
}

/** The colours a CLASS cannot carry: the 256-colour cube and truecolor. Both are values rather
 *  than vocabulary — nobody can name colour 208 — so they are resolved here and inline. */
function ansiStyle(part: AnserJsonEntry): React.CSSProperties | undefined {
  const style: React.CSSProperties = {};
  const fg = colourValue(part.fg, part.fg_truecolor);
  const bg = colourValue(part.bg, part.bg_truecolor);
  if (fg) style.color = fg;
  if (bg) style.background = `color-mix(in oklab, ${bg} 22%, transparent)`;
  return fg || bg ? style : undefined;
}

/** Whether anser's answer is a VALUE rather than one of the sixteen names. */
function isValue(name: string): boolean {
  return name === "ansi-truecolor" || name.startsWith("ansi-palette-");
}

/** A cube or truecolor colour as CSS, or null when the span wears a class instead. */
function colourValue(name: string | null, truecolor: string | null): string | null {
  if (!name || !isValue(name)) return null;
  if (name === "ansi-truecolor") return truecolor ? `rgb(${truecolor})` : null;
  const index = Number(name.slice("ansi-palette-".length));
  return xterm256(index);
}

/** One of xterm's 256 colours as CSS.
 *
 *  The cube (16–231) and the greyscale ramp (232–255) are arithmetic, so they are computed. The
 *  first sixteen are the palette's own and are drawn from the same custom properties the classes
 *  read, so a runner writing `38;5;1` and one writing `31` get the same red. */
function xterm256(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return `var(--ansi-${XTERM_NAMES[index]})`;
  if (index < 232) {
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    const at = index - 16;
    return `rgb(${level(Math.floor(at / 36))}, ${level(Math.floor(at / 6) % 6)}, ${level(at % 6)})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey}, ${grey}, ${grey})`;
}

/** The names of the first sixteen, in xterm's own order — the order `38;5;n` counts in. */
const XTERM_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;

/** A log that could not be read. This page IS that read, so the failure is the whole screen — and
 *  it offers the one thing left, which is GitLab's own pipelines. */
function JobLogFailure(props: { error: string; webUrl?: string; jobUrl?: string | null }) {
  // The JOB's own page when this app knows it, the merge request's pipelines otherwise: whichever
  // is nearer to the log the reader came for.
  const href = props.jobUrl ?? (props.webUrl ? gitlabPageUrl(props.webUrl, "pipelines") : null);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p
        data-testid="gitlab-job-log-error"
        className="flex max-w-md items-start gap-1.5 text-[13px] text-destructive"
      >
        <HugeiconsIcon icon={Alert02Icon} className="mt-px size-4 shrink-0" strokeWidth={1.8} />
        {props.error}
      </p>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          data-testid="gitlab-job-log-error-link"
          className="text-[13px] text-text-dim underline-offset-2 hover:text-foreground hover:underline"
        >
          {props.jobUrl ? "Open this job in GitLab" : "Open the pipelines in GitLab"}
        </a>
      )}
    </div>
  );
}

/** What stands in while the log is on its way. It fills the page rather than collapsing, so
 *  nothing under it jumps when the log arrives. */
function JobLogLoading(props: { label: string }) {
  return (
    <div
      data-testid="gitlab-job-log-loading"
      className="flex h-full flex-1 items-center justify-center p-8"
    >
      <span className="flex items-center gap-2 text-[12px] text-text-faint">
        <FadeArc className="size-3.5" />
        {props.label}
      </span>
    </div>
  );
}
