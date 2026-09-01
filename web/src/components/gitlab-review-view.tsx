import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  Loading02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import {
  reviewAttribution,
  reviewCoverage,
  reviewGroups,
  reviewIsStale,
  reviewLimits,
  type GitLabReview,
  type ReviewGroup,
} from "~/lib/gitlab-review";
import { formatDiffStat, type GitLabDiff, type GitLabDiffFile } from "~/lib/gitlab-diff";
import { formatMessageTime } from "~/lib/message-time";
import { cn } from "~/lib/utils";

// The THEMES view of a diff: the changed files grouped by what the branch is DOING, with the
// reading's own thought process written around them.
//
// It is a second view of ONE read — the same `gitlabDiff` the feed draws — which is the shape the
// Pipelines page already has for its graph and its job list. So it is a control in the diff page's
// own header rather than a route of its own, and every decision it makes is pure and lives in
// `web/src/lib/gitlab-review.ts`.
//
// Three things about it are worth knowing:
//
//   - **The prose is the point.** A grouping with no words is a folder; what a reviewer opens this
//     for is the sentence saying why four files are one change and what to look at closely. So the
//     summary is set as prose, at a readable measure, above the files it is about.
//   - **Nothing is hidden.** Every changed file is in exactly one group, and the files no theme
//     claimed are a group of their own at the END rather than a footnote — a reviewer still has to
//     read them, and a grouped view that quietly left a file out would let them believe they had
//     seen the branch.
//   - **A press on a file takes them to it in the FEED.** This view is a map, not a place to read
//     code: the diff is one press away and already drawn, so nothing here re-renders a patch.

export type ReviewViewProps = {
  review: GitLabReview | null;
  diff: GitLabDiff;
  /** The commit the page is drawing, so the view can say when the reading is of an earlier one. */
  headSha: string | null;
  busy: boolean;
  error: string | null;
  /** Ask for a reading — the reader's own press, which starts an agent run on this machine. */
  onRun: () => void;
  /** Go to one file in the FEED. */
  onOpenFile: (path: string) => void;
};

export function DiffReviewView(props: ReviewViewProps) {
  const { review, diff } = props;
  const groups = reviewGroups(review, diff);
  const stale = reviewIsStale(review, props.headSha);
  return (
    <section
      data-testid="gitlab-diff-review"
      data-has-review={review ? "yes" : "no"}
      data-stale={stale ? "yes" : "no"}
      data-themes={groups.filter((group) => !group.unplaced).length}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6">
        {!review ? (
          <ReviewOffer busy={props.busy} error={props.error} onRun={props.onRun} files={diff.files.length} />
        ) : (
          <>
            <ReviewHeader
              review={review}
              diff={diff}
              stale={stale}
              busy={props.busy}
              error={props.error}
              onRun={props.onRun}
            />
            {groups.map((group, index) => (
              <ReviewGroupCard
                key={group.title ? `${group.title}:${index}` : `unplaced:${index}`}
                group={group}
                onOpenFile={props.onOpenFile}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** What stands here before any reading has been made: what the press DOES, and what it costs.
 *
 *  The cost is named before the press, which is the rule the update button holds for its 130 MB and
 *  the expanded diff read holds for its half a megabyte. Here it is not bytes: it is that the code
 *  leaves this machine for a model provider, which is the one fact the reader cannot undo after. */
function ReviewOffer(props: {
  busy: boolean;
  error: string | null;
  onRun: () => void;
  files: number;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl bg-card p-5 shadow-card">
      <h2 className="flex items-center gap-2 text-[15px] font-medium text-foreground">
        <HugeiconsIcon icon={SparklesIcon} className="size-4 text-primary" strokeWidth={1.8} />
        Read these changes by theme
      </h2>
      <p className="max-w-prose text-[13px] leading-relaxed text-text-dim">
        A local agent reads the whole diff and groups the {props.files} changed{" "}
        {props.files === 1 ? "file" : "files"} by what the branch is doing, with a note on each group
        saying why those files are one change and what to look at closely.
      </p>
      <RunButton busy={props.busy} onRun={props.onRun} label="Read the changes" />
      {/* The cost, before the press. It runs the CLI the reader chose in Settings › AI providers, and
          the diff travels in the prompt — so this says where their code goes, in as many words. */}
      <p data-testid="gitlab-diff-review-cost" className="max-w-prose text-[11px] leading-relaxed text-text-faint">
        This runs the agent you chose in Settings › AI providers, on this machine. The diff is put in
        the prompt, so this branch's code reaches that provider — exactly as it does when you write
        to an agent in a chat. It is granted no access to your files.
      </p>
      {props.error && <ReviewError error={props.error} />}
    </div>
  );
}

/** The reading's own heading: the headline, who read it and when, how much of the branch it
 *  accounts for, and the way to ask again. */
function ReviewHeader(props: {
  review: GitLabReview;
  diff: GitLabDiff;
  stale: boolean;
  busy: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const { review } = props;
  const coverage = reviewCoverage(review, props.diff);
  const limits = reviewLimits(review);
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-5 shadow-card">
      <div className="flex items-start gap-2">
        <HugeiconsIcon
          icon={SparklesIcon}
          className="mt-1 size-4 shrink-0 text-primary"
          strokeWidth={1.8}
        />
        <p
          data-testid="gitlab-diff-review-headline"
          className="min-w-0 flex-1 text-[15px] leading-relaxed text-foreground"
        >
          {review.headline || "This branch was read, but the reading said nothing about it as a whole."}
        </p>
      </div>
      <p className="text-[11px] text-text-faint">
        {/* WHICH machine read it, and WHEN — the two facts a reader deciding how much to trust a
            machine's reading of their branch is owed. The moment is drawn with the app's own words
            for one, so "Yesterday 14:32" means the same thing here as in a chat. */}
        <span data-testid="gitlab-diff-review-by">{reviewAttribution(review)}</span>
        {" · "}
        {formatMessageTime(review.generated_ms)}
        {" · "}
        <span data-testid="gitlab-diff-review-coverage">
          {coverage.grouped} of {coverage.total} files grouped
        </span>
      </p>
      {props.stale && (
        // A reading is of ONE commit. It is not thrown away when the branch moves — it is still the
        // best account anybody has — but a reader must not take a grouping of files that have since
        // moved for a grouping of what is on screen.
        <p
          data-testid="gitlab-diff-review-stale"
          className="flex items-start gap-1.5 rounded-lg bg-element px-3 py-2 text-[12px] leading-relaxed text-text-dim"
        >
          <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
          This reading is of an earlier commit. Somebody has pushed since, so the files below may
          have moved — read it again for the branch as it stands.
        </p>
      )}
      {limits && (
        <p data-testid="gitlab-diff-review-limits" className="text-[11px] leading-relaxed text-text-faint">
          {limits}
        </p>
      )}
      <RunButton busy={props.busy} onRun={props.onRun} label="Read it again" />
      {props.error && <ReviewError error={props.error} />}
    </div>
  );
}

/** One group: its heading, the thought process, and the files it holds. */
function ReviewGroupCard(props: { group: ReviewGroup; onOpenFile: (path: string) => void }) {
  const { group } = props;
  return (
    <article
      data-testid="gitlab-diff-review-group"
      data-unplaced={group.unplaced ? "yes" : "no"}
      className="flex flex-col gap-3 rounded-xl bg-card p-5 shadow-card"
    >
      <h3
        data-testid="gitlab-diff-review-title"
        className={cn(
          "text-[14px] font-medium",
          // The leftovers are not a theme somebody stated, so they are not drawn as one: the accent
          // this app spends on what matters stays on the real groups.
          group.unplaced ? "text-text-dim" : "text-foreground",
        )}
      >
        {group.title}
      </h3>
      {group.summary && (
        // The PROSE, at a readable measure. This is what the view exists for — a grouping with no
        // words is a folder — so it is set as prose rather than as metadata.
        <p
          data-testid="gitlab-diff-review-summary"
          className="max-w-prose whitespace-pre-line text-[13px] leading-relaxed text-text-dim"
        >
          {group.summary}
        </p>
      )}
      <ul className="flex flex-col">
        {group.files.map((entry) => (
          <li key={entry.file.path}>
            <ReviewFileRow
              file={entry.file}
              note={entry.note}
              onOpen={() => props.onOpenFile(entry.file.path)}
            />
          </li>
        ))}
      </ul>
    </article>
  );
}

/** One file inside a group: its path, its stat, and whatever the reading said about it in
 *  particular. The whole row is the control, because the target is "this file". */
function ReviewFileRow(props: { file: GitLabDiffFile; note?: string; onOpen: () => void }) {
  const stat = formatDiffStat(props.file);
  return (
    <button
      type="button"
      data-testid="gitlab-diff-review-file"
      data-path={props.file.path}
      title={`Read ${props.file.path} in the changes`}
      onClick={props.onOpen}
      className="group flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="flex min-w-0 flex-1 items-baseline text-[12px]">
          <span className="min-w-0 truncate text-text-faint">{parentOf(props.file.path)}</span>
          <span className="shrink-0 font-medium text-foreground">{nameOf(props.file.path)}</span>
        </span>
        {stat && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-faint">{stat}</span>
        )}
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          className="size-3.5 shrink-0 text-transparent transition-colors group-hover:text-text-faint"
          strokeWidth={1.8}
        />
      </span>
      {props.note && (
        <span
          data-testid="gitlab-diff-review-note"
          className="max-w-prose text-[12px] leading-relaxed text-text-dim"
        >
          {props.note}
        </span>
      )}
    </button>
  );
}

/** The one control that starts a run, in both of the places that offer one. */
function RunButton(props: { busy: boolean; onRun: () => void; label: string }) {
  return (
    <button
      type="button"
      data-testid="gitlab-diff-review-run"
      disabled={props.busy}
      data-cuelume-press=""
      onClick={props.onRun}
      className={cn(
        "flex items-center gap-1.5 self-start rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity",
        props.busy && "opacity-70",
      )}
    >
      <HugeiconsIcon
        icon={props.busy ? Loading02Icon : SparklesIcon}
        className={cn("size-3.5", props.busy && "animate-spin")}
        strokeWidth={1.8}
      />
      {/* A run is tens of seconds, so the button says it is going rather than looking pressed and
          idle — the reader has no other signal that anything is happening. */}
      {props.busy ? "Reading the changes…" : props.label}
    </button>
  );
}

/** Why a reading did not happen, in the words the backend or the CLI used, beside the button that
 *  was pressed. The composer's own contract: an action that did not happen must never be left
 *  looking like it did. */
function ReviewError(props: { error: string }) {
  return (
    <p
      data-testid="gitlab-diff-review-error"
      className="flex max-w-prose items-start gap-1.5 text-[12px] leading-relaxed text-destructive"
    >
      <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
      {props.error}
    </p>
  );
}

/** A path's directory part, and its own file name — so a long path gives way in the middle rather
 *  than losing the name that says which file it is. The rule the occurrences panel holds. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

function nameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}
