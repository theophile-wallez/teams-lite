// One CI JOB's log, as a document a page can draw: its lines, and the sections the runner
// wrapped them in.
//
// Everything here is PURE — no DOM, no fetch, and no ANSI rendering (that is `anser`, called by
// `components/gitlab-job-log-page.tsx` per visible row). What lives here is the half that is
// GitLab-specific and therefore worth testing on its own: turning the runner's own control bytes
// into structure.
//
// **Every rule below is MEASURED**, by `examples/job_trace_recon.rs` against this instance —
// READ-ONLY, over 58 jobs of the 12 newest open merge requests:
//
//   - **A log is wrapped in SECTIONS, and they NEST.** 48 of 58 logs carry
//     `section_start:<unix ts>:<name>` / `section_end:<unix ts>:<name>` markers, each followed
//     by a carriage return and an erase-line escape; 5 to 9 sections per log, and every start
//     measured was closed. `step_script` holds sections a project's own `.gitlab-ci.yml` emitted
//     (`pnpm_section`, `unit_tests_section`), so the parse keeps a STACK — a flat one would draw
//     a nested section's lines as its parent's.
//   - **The two markers are a DURATION.** Their timestamps are seconds apart, so a folded
//     section still says what it cost, which is the number a reader scanning a slow pipeline is
//     after.
//   - **A MARKER IS READ BEFORE THE CARRIAGE RETURN THAT FOLLOWS IT.** The runner writes
//     `section_start:…:step_script`, then `\r`, then an erase, then the section's own heading —
//     so a parse that resolved the rewrite first would have erased the marker along with it, and
//     no log would have any sections at all. Order is the whole of that bug.
//   - **A bare CARRIAGE RETURN means the runner rewrote the line in place**: 48 of 48 logs carry
//     one, and 1 444 erase-line escapes travel with them. So a line's last segment is what the
//     terminal would be showing, and everything before it is a progress bar nobody can read
//     after the fact.
//   - **Only two escape kinds exist here**: 35 856 SGR (colour) and 1 444 erase-line. No cursor
//     move at all, so nothing here has to model a screen.
//   - **A line can be enormous**: the longest measured 22 129 bytes. That is why the page never
//     wraps, and why searching is a FILTER rather than a scroll to a highlight — a query that
//     matched one line of a wall of them must not leave the reader hunting a tinted word.

/** One line of a log, as drawn. */
export type JobLogLine = {
  /** 1-based, and the log's OWN numbering — never the drawn row's index. A folded section hides
   *  rows, and a line that says 812 while sitting fourth on screen is what tells a reader where
   *  in the run they are. */
  number: number;
  /** The line's text with the runner's control bytes resolved: markers taken out, the erased
   *  segments of a rewritten line dropped, and the ANSI colours left in for the renderer. */
  text: string;
  /** The same words with no escapes at all: what a search matches. */
  plain: string;
  /** The innermost section this line is inside, or `null` at the top level. */
  section: string | null;
  /** Set on the ONE line that opens a section — the line the marker travelled on, which is where
   *  GitLab writes the section's own heading. It is the row a folded section leaves behind. */
  opens?: string;
};

/** One section of a log: a run of lines the runner named. */
export type JobLogSection = {
  /** Unique within the log. A name can repeat — `restore_cache` runs per cache key — so the id
   *  carries which occurrence it is, and the fold state keys on it. */
  id: string;
  /** The runner's own name for it (`step_script`), or a project's own (`unit_tests_section`). */
  name: string;
  /** What the fold's control says: the name with its underscores opened out. */
  label: string;
  /** How long it took, in seconds, from the two markers' own timestamps — or `null` when the
   *  section was never closed (a job cancelled mid-section). */
  seconds: number | null;
  /** How deep it sits. 0 is a section of the log itself; 1 is one inside `step_script`. */
  depth: number;
  /** The section this one is inside, or `null`. */
  parent: string | null;
  /** How many lines it holds, its own opening line included. A parent counts its children's. */
  lines: number;
};

export type JobLogDocument = {
  lines: JobLogLine[];
  sections: JobLogSection[];
};

const EMPTY: JobLogDocument = { lines: [], sections: [] };

/** Every ANSI escape sequence, for stripping: the CSI form (`ESC [ … final byte`) first, then any
 *  other two-byte one — so a stray `ESC c`, and the half-sequence a cut tail can begin with, cost
 *  their own two bytes rather than the rest of the line. */
const ANSI = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|[@-~])/g;

/** An erase-line escape, which is what a rewritten line clears its old content with. */
const ERASE = /\x1b\[[012]?K/g;

/** A section marker, and the carriage return and erase the runner writes after it.
 *
 *  Anchored at the start of what is left of the line, because that is where the runner writes it
 *  — a `section_start:` inside somebody's build output is their words, not a marker. */
const MARKER = /^section_(start|end):(\d+):([^\s]+)(?:\r(?:\x1b\[[012]?K)?)?/;

/**
 * Read one job's log into lines and sections.
 *
 * One pass, and the section STACK is what makes nesting work: a start pushes, an end pops the
 * section it names — and anything still open beneath it, because a section closed while a child
 * is open is a runner that died mid-section rather than a reason to hand the rest of the log to
 * the wrong parent.
 */
export function parseJobLog(trace: string | null | undefined): JobLogDocument {
  if (!trace) return EMPTY;
  const lines: JobLogLine[] = [];
  const sections: JobLogSection[] = [];
  const stack: JobLogSection[] = [];
  /** When each open section started, by id — kept apart from the section itself so `seconds`
   *  only ever holds a duration. */
  const startedAt = new Map<string, number>();
  let counted = 0;

  // A log ends with a newline, so the empty piece after it is not a line. Nothing else is
  // dropped: a blank line inside a log is a blank line the runner printed.
  const raw = trace.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  for (const line of raw) {
    let rest = line;
    let opens: string | undefined;
    let marked = false;

    // The markers come off the FRONT first, each with the carriage return that follows it —
    // before any rewrite is resolved, or the marker would be the thing the rewrite erased. A
    // start and an end can share one line (a section that held nothing), so this loops.
    for (;;) {
      const marker = MARKER.exec(rest);
      if (!marker) break;
      const [whole, kind, at, name] = marker;
      rest = rest.slice(whole.length);
      marked = true;
      const stamp = Number(at);
      if (kind === "start") {
        const parent = stack[stack.length - 1] ?? null;
        const section: JobLogSection = {
          id: `${name}#${sections.length}`,
          name: name!,
          label: sectionLabel(name!),
          seconds: null,
          depth: stack.length,
          parent: parent?.id ?? null,
          lines: 0,
        };
        sections.push(section);
        stack.push(section);
        startedAt.set(section.id, stamp);
        // The row a fold leaves behind is this one, whatever else the line carries.
        opens = section.id;
      } else {
        const from = stack.map((section) => section.name).lastIndexOf(name!);
        if (from >= 0) {
          for (const closing of stack.splice(from)) {
            const began = startedAt.get(closing.id);
            closing.seconds =
              began !== undefined && stamp >= began ? stamp - began : closing.seconds;
          }
        }
      }
    }

    // Only NOW: what the terminal would be showing, once the runner's rewrites are resolved.
    rest = collapseRewrites(rest);

    const current = stack[stack.length - 1] ?? null;
    // A line that carried nothing but a MARKER is not a line: the runner's own bookkeeping is
    // drawn as the fold, never as an empty row in somebody's log. A line that OPENS a section is
    // kept even when it is blank, because it is the row the fold leaves behind — and a line the
    // runner really did write, even one that ends up showing nothing, keeps its row: that blank
    // is what the job printed.
    if (rest === "" && opens === undefined && marked) continue;
    counted += 1;
    const entry: JobLogLine = {
      number: counted,
      text: rest,
      plain: stripAnsi(rest),
      section: current?.id ?? null,
    };
    if (opens !== undefined) entry.opens = opens;
    lines.push(entry);
    for (const section of stack) section.lines += 1;
  }

  return { lines, sections };
}

/**
 * What one line really shows, once the runner's rewrites are resolved.
 *
 * A bare carriage return means "back to the start of this line", and a progress bar is dozens of
 * those in one line — so what a terminal would be showing is the LAST segment with anything in
 * it. An erase escape says the same thing and goes with them. A line that ends by returning to
 * its own start still shows what it wrote, which is why the walk runs backwards rather than
 * simply taking what follows the final return.
 */
function collapseRewrites(line: string): string {
  // Cheap way out for a line with neither a rewrite nor an escape in it, which is most of them.
  // Never `ERASE.test(…)`: a global regex carries its own `lastIndex`, so a test would answer
  // differently on the second identical line it was asked about.
  if (!line.includes("\r") && !line.includes("\x1b[")) return line;
  const segments = line.split("\r");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!.replace(ERASE, "");
    if (segment !== "" || index === 0) return segment;
  }
  return "";
}

/** The same text with no escape sequences: what a search matches. */
export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI, "") : text;
}

/** The words a fold's control shows for a section GitLab named. `step_script` reads as "Step
 *  script": the runner's own vocabulary opened out, rather than a table of translations that
 *  would leave a project's own `unit_tests_section` bare while its neighbours were prose. */
export function sectionLabel(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The rows to draw, given which sections the reader folded.
 *
 * A folded section leaves its OPENING line and takes everything under it, its nested sections
 * included — which is why this climbs to the OUTERMOST folded ancestor: a child left visible
 * inside a folded parent would be a row with nothing above it to say where it is.
 */
export function visibleLogLines(doc: JobLogDocument, folded: ReadonlySet<string>): JobLogLine[] {
  if (folded.size === 0) return doc.lines;
  const sections = new Map(doc.sections.map((section) => [section.id, section]));
  // Per section, the outermost folded section at or above it — computed once each, because a log
  // holds thousands of lines and nine sections.
  const cache = new Map<string, string | null>();
  const outermostFolded = (id: string | null): string | null => {
    if (!id) return null;
    const known = cache.get(id);
    if (known !== undefined) return known;
    const section = sections.get(id);
    const above = outermostFolded(section?.parent ?? null);
    const answer = above ?? (folded.has(id) ? id : null);
    cache.set(id, answer);
    return answer;
  };
  return doc.lines.filter((line) => {
    const folder = outermostFolded(line.section);
    return folder === null || line.opens === folder;
  });
}

/**
 * The lines a query matches, each keeping its own number.
 *
 * A filter rather than a highlight, because a log here runs to 4 238 lines with one of them
 * 22 KB wide (measured): "which lines say `error`" is the question, and scrolling to a tinted
 * word in a wall of text is not an answer to it. Case-insensitive, because nobody remembers
 * whether the runner shouted.
 */
export function filterLogLines(lines: readonly JobLogLine[], query: string): JobLogLine[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return lines as JobLogLine[];
  return lines.filter((line) => line.plain.toLowerCase().includes(needle));
}

/** Every section of a log, so one control can fold them all. */
export function allSectionIds(doc: JobLogDocument): string[] {
  return doc.sections.map((section) => section.id);
}

/**
 * How big a log is, in the words a reader can act on.
 *
 * The BYTES are GitLab's own count rather than what travelled, so a log that was cut states the
 * size of the whole of it — the number that explains why its top is missing.
 */
export function jobLogSummary(log: { bytes?: number; lines: number }): string {
  const lines = `${log.lines.toLocaleString("en-GB")} ${log.lines === 1 ? "line" : "lines"}`;
  const bytes = formatBytes(log.bytes);
  return bytes ? `${lines} · ${bytes}` : lines;
}

/** A byte count in the units a reader thinks in, or `null` when there is nothing to say. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;
  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`;
}

/**
 * What a log that did not travel whole says, or `null` when it did.
 *
 * It names the END as what is on screen, because that is the half a reader opening a red job came
 * for — and it points at GitLab for the whole of it, which is the only place it can be: this
 * instance refuses a Range read (measured), so there is nothing here to ask for the rest with.
 */
export function jobLogTruncation(
  log: { truncated?: boolean; bytes?: number } | null | undefined,
): string | null {
  if (!log?.truncated) return null;
  const size = formatBytes(log.bytes);
  return size
    ? `This log is ${size}, so only its end is shown here.`
    : "This log is too big to show whole, so only its end is shown here.";
}

/**
 * Why a log is MISSING rather than empty, or `null` when nothing is missing.
 *
 * The job read and the trace read are two requests, and only the second can fail on its own — a
 * trace file GitLab has dropped answers 404 while the job still answers in full. So an empty log
 * has two possible meanings, and this is the one the page must never state as the other:
 * `emptyJobLogReason` says the job printed nothing, and that is a claim about the job.
 */
export function jobLogUnreadable(
  log: { trace_error?: string } | null | undefined,
): string | null {
  const reason = log?.trace_error?.trim();
  return reason ? reason : null;
}

/**
 * What a job with NO log says — which is never a blank page.
 *
 * The reason differs and so does the reader's next move: a job that has not run yet will have a
 * log later, one that was ERASED never will, and a job that ran and printed nothing is a third
 * thing again. Measured on this instance: 10 of 58 jobs answered an empty log, every one of them
 * `manual` or `created`.
 */
export function emptyJobLogReason(job: { status?: string; erased_at?: string }): string {
  if (job.erased_at) return "This log was erased, so there is nothing left to read.";
  switch (job.status) {
    case "manual":
      return "This job has not been started, so it has no log yet.";
    case "created":
    case "pending":
    case "waiting_for_resource":
      return "This job has not started running, so it has no log yet.";
    case "skipped":
      return "This job was skipped, so it never wrote a log.";
    case "canceled":
      return "This job was cancelled before it wrote anything.";
    default:
      return "This job wrote nothing to its log.";
  }
}

/**
 * Whether a job's log is worth re-reading: the page polls exactly while this is true.
 *
 * It reads the BACKEND's own verdict (`complete`), which is the job's STATUS rather than anything
 * about the log — a running job that has printed nothing yet is still a job to follow. An answer
 * that says nothing is read as still running, because a page that stopped polling on a missing
 * field would freeze a live log with no way back.
 */
export function jobLogIsLive(log: { complete?: boolean } | null | undefined): boolean {
  return !!log && log.complete !== true;
}
