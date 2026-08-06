import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ChevronLeftIcon,
  Delete02Icon,
  Edit02Icon,
  GitMergeIcon,
  Link01Icon,
  Loading02Icon,
  Message01Icon,
  RefreshIcon,
  Tick02Icon,
  XVariableCircleIcon,
} from "@hugeicons/core-free-icons";
import { noteWasEdited, threadResolution, threadResolveAction } from "~/lib/gitlab-diff-comment";
import { parseGitLabMarkdown } from "~/lib/gitlab-markdown";
import { defaultGrouping, graphSummary, pipelineGraph } from "~/lib/gitlab-pipeline-graph";
import { gitLabMarkdownOptions } from "~/lib/gitlab-upload";
import {
  DESCRIPTION_COLLAPSED_PX,
  DESCRIPTION_FADE_PX,
  DESCRIPTION_FONT_PX,
  DESCRIPTION_LINE_HEIGHT,
  conversationDiscussions,
  descriptionFoldSeconds,
  descriptionIsFoldable,
  mergeRequestId,
  mergeVerdict,
  pipelineIsLive,
  stateChangeFor,
  systemNotes,
  unresolvedThreadCount,
  type GitLabDiscussion,
  type GitLabNote,
  type GitLabPerson,
  type MergeRequestDetail,
} from "~/lib/gitlab-mr";
import { mergeRequestPagePanel } from "~/lib/gitlab-mr-pages";
import { personFace } from "~/lib/tracker-people";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { useAppState, useController } from "./controller-context";
import { ChangesPanel } from "./gitlab-changes";
import { GitLabLogo } from "./gitlab-logo";
import {
  MergeRequestPageStrip,
  UnbuiltMergeRequestPage,
  useMergeRequestPage,
} from "./gitlab-mr-pages";
import { Panel } from "./gitlab-panel";
import { GitLabPipelinePage } from "./gitlab-pipeline-page";
import { PipelineGraphView, PipelineStatusBadge } from "./gitlab-pipeline-graph";
import { RichNodes } from "./rich-content";

// The merge-request page. It occupies the same slot as `MessagePane` and `MailPane`, so the
// two-column layout, the mobile full-screen page and the back button behave identically
// whether the user is reading a chat, a mail or a merge request.
//
// Unlike those two, this surface WRITES: it merges, comments, rewrites and deletes a comment,
// resolves a thread, approves and closes. Four rules hold that apart from the read-only
// surfaces beside it, and each is load-bearing:
//
//   - **Every write is one click of the user's, and MERGE asks twice.** The merge is the one
//     action in this app that no later click takes back, so it arms a confirmation naming
//     the target branch — the pattern a message deletion already uses.
//   - **The outcome is reported HERE**, beside the control that was pressed. An outward
//     action that failed must never be left looking like it worked (the same contract the
//     composer holds for a failed send — see lib/send-failure.ts).
//   - **A control is drawn only where it would work.** The Merge button reads GitLab's own
//     `detailed_merge_status`, so a blocked merge request shows a disabled control with the
//     reason on it instead of a refusal after the fact.
//   - **Nothing here is fetched from GITLAB by the browser.** Its `avatar_url` is never
//     requested, and the description and every comment are rendered through the app's own
//     markdown subset — never GitLab's rendered HTML, which would carry remote references
//     with it. A face IS drawn for a person the user's own Teams knows, through the
//     backend's `fetch_avatar` like every other avatar in this app: that is a Teams read,
//     it tells the GitLab instance nothing, and it is what makes a colleague here the same
//     colleague as in a chat (see `personFace`).
//
// The Changes section states what changed and opens the DIFF, which is a page of its own at
// `/mr/<id>/diff` (`gitlab-changes.tsx` for the summary, `gitlab-diff-page.tsx` for the page).
// Nothing on THIS page carries a highlighter: reviewing code is somewhere a reader goes, so
// Shiki is behind that route rather than on the path of every merge request anybody opens. A
// review comment still keeps the file and line it hangs on (`note.position`), and this page
// names that file, so a comment on a line the diff does not show is never one about nothing.
//
// **This pane is the OVERVIEW, one of four pages**, and the sub-header under its header names
// all four (`gitlab-mr-pages.tsx`): Overview, Commits, Pipelines, Diffs — GitLab's own set in
// GitLab's own order. The strip is drawn as soon as a merge request is open, before its detail
// has arrived, because the URL already says which merge request the pages belong to: a strip
// that waited on a read would leave the reader unable to leave the page they are waiting on.

/** The folded box, named so the control can say what it opens. One merge request is drawn at
 *  a time, so one id is enough. */
const DESCRIPTION_BOX_ID = "gitlab-description-box";

/** The description's fold takes the transcript panel's own curve (`agent-reply.tsx`), because
 *  two disclosures on one screen must not move on two different ones. Its DURATION is
 *  `descriptionFoldSeconds`, which is the half that depends on the document rather than on the
 *  control — a strong ease-out over a distance nothing here knows in advance. */
const FOLD_EASE = [0.23, 1, 0.32, 1] as const;

export function GitLabPane(props: {
  onBack?: () => void;
  /** Open this merge request's DIFF, which is a route and a full-screen page of its own (see
   *  `gitlab-diff-page.tsx`). The shell navigates; this pane only asks. */
  onOpenDiff?: () => void;
  /** Open its PIPELINE, on the same terms and for the same reason: a graph is as wide as the
   *  run it draws (see `gitlab-pipeline-page.tsx`). */
  onOpenPipeline?: () => void;
}) {
  const open = useAppState((s) => s.openMergeRequest);
  const detail = useAppState((s) => s.gitlabDetail);
  const loading = useAppState((s) => s.gitlabDetailLoading);
  const error = useAppState((s) => s.gitlabDetailError);
  const controller = useController();
  // Which of the four pages the URL asks for. `diffs` never reaches here — the shell draws
  // that one over this pane, full screen — so this pane holds the three that live in it.
  const page = useMergeRequestPage();

  if (!open) return <GitLabEmptyState />;

  return (
    <section data-testid="gitlab-pane" className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-5">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back to merge requests"
            data-testid="back-to-list"
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
          </button>
        )}
        <GitLabLogo className="size-5 shrink-0" title="GitLab" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 data-testid="gitlab-title" className="truncate text-sm font-medium text-foreground">
            {detail ? detail.title : `${open.projectPath}!${open.iid}`}
          </h2>
          <p className="truncate text-[11px] text-text-faint">
            {open.projectPath}
            {detail ? ` · ${detail.reference}` : ""}
          </p>
        </div>
        <button
          type="button"
          data-testid="gitlab-detail-reload"
          aria-label="Reload this merge request"
          title="Reload from GitLab"
          data-cuelume-press=""
          onClick={() => void controller.reloadMergeRequest()}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon
            icon={loading ? Loading02Icon : RefreshIcon}
            className={cn("size-4", loading && "animate-spin")}
            strokeWidth={1.6}
          />
        </button>
        {detail?.web_url && (
          <a
            href={detail.web_url}
            target="_blank"
            rel="noreferrer"
            data-testid="gitlab-open-in-gitlab"
            title="Open in GitLab"
            aria-label="Open in GitLab"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Link01Icon} className="size-4" strokeWidth={1.6} />
          </a>
        )}
      </header>

      {/* The four pages of this merge request, in GitLab's own order. It sits under the
          header — which names WHICH merge request — because that is what a sub-header is: the
          same subject, a different page of it. */}
      <MergeRequestPageStrip current={page} />

      {/* PIPELINES is a page of this pane, and it is the pipeline GRAPH (see
          `gitlab-pipeline-page.tsx`). It is drawn here rather than over the whole screen
          because it is one of the four pages of a merge request, and the header above it
          already says which merge request that is. */}
      {page === "pipelines" ? (
        <GitLabPipelinePage />
      ) : page !== "overview" ? (
        /* A page this app does not read yet says so and offers GitLab's own, rather than being
           drawn blank — which reads as a read that failed. */
        <UnbuiltMergeRequestPage page={page} webUrl={detail?.web_url} />
      ) : (
        // The Overview's own content IS the panel the strip's first tab controls, so it
        // carries that tab's id (see `mergeRequestPagePanel`).
        <div
          {...mergeRequestPagePanel("overview")}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6"
        >
          <article className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {error && !detail ? (
              <p data-testid="gitlab-detail-error" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : !detail ? (
              <p className="flex items-center gap-2 py-6 text-[13px] text-text-faint">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="size-3.5 animate-spin"
                  strokeWidth={1.6}
                />
                Loading the merge request…
              </p>
            ) : (
              <>
                <MergeRequestHeader detail={detail} />
                {/* Keyed by the merge request, so ANOTHER one is a fresh mount: the fold is the
                    state a page opens in, and a reader who opened one description must not find
                    the next one already open. This pane is not re-created when the open merge
                    request changes — its detail is simply replaced. */}
                <MergeRequestDescription
                  key={mergeRequestId({ projectPath: detail.project_path, iid: detail.iid })}
                  detail={detail}
                />
                <PipelinePanel onOpenPipeline={props.onOpenPipeline ?? (() => {})} />
                <ApprovalPanel />
                <ActionPanel detail={detail} />
                <ChangesPanel detail={detail} onOpenDiff={props.onOpenDiff ?? (() => {})} />
                <DiscussionPanel />
              </>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

/** Title, reference, state, branches and the people on it. */
function MergeRequestHeader(props: { detail: MergeRequestDetail }) {
  const detail = props.detail;
  const notes = useAppState((s) => s.gitlabNotes);
  const unresolved = unresolvedThreadCount(notes);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge detail={detail} />
        <span className="text-[12px] tabular-nums text-text-faint">{detail.reference}</span>
        {detail.changes_count && (
          <span className="text-[12px] text-text-faint">
            {detail.changes_count} file{detail.changes_count === "1" ? "" : "s"} changed
          </span>
        )}
        {unresolved > 0 && (
          <span
            data-testid="gitlab-unresolved"
            className="rounded-full bg-element px-2 py-0.5 text-[11px] font-medium text-text-dim"
          >
            {unresolved} unresolved thread{unresolved === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* The title in full: it is what the reader came for, so it WRAPS rather than being
          shortened here — the header above already carries the one-line spelling of it.
          `break-words` is for what a title carries besides words: a branch name, a URL or a
          bracketed list of tickets is one long token, and a token wider than the article
          would otherwise scroll the page sideways. */}
      <h1
        data-testid="gitlab-heading"
        className="break-words text-lg font-semibold leading-snug text-foreground"
      >
        {detail.title}
      </h1>

      {/* The branches, in the direction the merge goes. */}
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-text-dim">
        <code
          data-testid="gitlab-source-branch"
          className="rounded bg-element px-1.5 py-0.5 font-mono text-[11px]"
        >
          {detail.source_branch}
        </code>
        <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5 text-text-faint" strokeWidth={2} aria-label="into" />
        <code
          data-testid="gitlab-target-branch"
          className="rounded bg-element px-1.5 py-0.5 font-mono text-[11px]"
        >
          {detail.target_branch}
        </code>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <PersonLine label="Author" people={[detail.author]} />
        {detail.reviewers && detail.reviewers.length > 0 && (
          <PersonLine label="Reviewers" people={detail.reviewers} />
        )}
        {detail.assignees && detail.assignees.length > 0 && (
          <PersonLine label="Assignees" people={detail.assignees} />
        )}
      </div>

      {detail.labels && detail.labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {detail.labels.map((label) => (
            <span
              key={label}
              data-testid="gitlab-label"
              className="rounded-full bg-element px-2 py-0.5 text-[11px] text-text-dim"
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One row of people, as faces and names. A colleague the user's Teams knows is drawn as
 *  that colleague — their Teams face and the name this app calls them (see `personFace`);
 *  anybody else keeps GitLab's own name over tinted initials. */
function PersonLine(props: { label: string; people: GitLabPerson[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-text-faint">{props.label}</span>
      {props.people.map((person) => (
        <PersonChip key={person.username || person.name} person={person} />
      ))}
    </div>
  );
}

/** One person, as a face beside a name. The GitLab handle stays in the title whatever the
 *  chip is called: it is how the reader finds them on the instance, so a Teams name never
 *  replaces it. */
function PersonChip(props: { person: GitLabPerson }) {
  const person = props.person;
  const face = useMemo(() => personFace(person), [person]);
  return (
    <span
      data-testid="gitlab-person"
      data-person={face.label}
      title={person.username ? `@${person.username}` : person.name}
      className="flex items-center gap-1.5 rounded-full bg-accent/60 py-0.5 pl-0.5 pr-2"
    >
      <Avatar
        seed={face.seed}
        label={face.label}
        photo={face.photo}
        initials={face.label.slice(0, 1).toUpperCase()}
        fallback="person"
        className="size-5 text-[9px]"
      />
      <span className="max-w-[160px] truncate text-[12px] text-text-dim">{face.label}</span>
    </span>
  );
}

/** The one-word state, in the tone GitLab gives it. A draft says draft: GitLab calls it
 *  "opened" and marks it separately, and "Open" on a draft is the wrong thing to read
 *  first. */
function StateBadge(props: { detail: MergeRequestDetail }) {
  const detail = props.detail;
  const label = detail.draft
    ? "Draft"
    : detail.state === "opened"
      ? "Open"
      : detail.state === "merged"
        ? "Merged"
        : detail.state === "closed"
          ? "Closed"
          : detail.state;
  const tone =
    detail.state === "merged"
      ? "bg-primary/12 text-primary"
      : detail.state === "closed"
        ? "bg-destructive/12 text-destructive"
        : detail.draft
          ? "bg-element text-text-dim"
          : "bg-primary/12 text-primary";
  return (
    <span
      data-testid="gitlab-state"
      data-state={detail.state}
      data-draft={detail.draft ? "true" : undefined}
      className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", tone)}
    >
      {label}
    </span>
  );
}

/** The description, as GitLab's own markdown through the app's own renderer — headings,
 *  tables, fenced code, task lists and all (see `gitlab-markdown.ts`, whose subset is
 *  measured against what the authors on this instance really write).
 *
 *  Never GitLab's rendered HTML: that would bring remote images and links with it, and
 *  this app's whole promise about a body is that drawing it makes no request.
 *
 *  **A long one is FOLDED to eight lines, and the last three of those fade out.** Measured on
 *  the tenant, a description here is a whole document — a summary, a table of tickets, a
 *  fenced command line and a task list (see `examples/merge_request_markdown_recon.rs`) — and
 *  unfolded it pushed the pipeline, the Merge button and the conversation off the first
 *  screen of every merge request anybody opened. Five rules hold the fold, and
 *  `web/e2e/gitlab.spec.ts` pins each:
 *
 *  - **The window is a CONSTANT, so the first paint is already right**
 *    ({@link DESCRIPTION_COLLAPSED_PX}, over the type this component sets itself). Measuring
 *    first would draw the whole document and clip it a frame later, which is a jump the
 *    reader watches — and it would do it again on every pass of the page.
 *  - **The fade sits INSIDE the eight lines**, so what a folded description reads as is five
 *    clear lines running out rather than eight lines cut off with a rule under them.
 *  - **A description that is not really longer keeps NO control** ({@link
 *    descriptionIsFoldable}): a click that reveals half a line, from under a gradient
 *    covering three, is a control that costs more than it gives.
 *  - **The two states are ONE movement.** The height carries it, the gradient and the label
 *    are quicker than the height and led by it, and the chevron turns on the same curve —
 *    the transcript panel's own rules (`agent-reply.tsx`), because two animations for one
 *    press read as a stutter.
 *  - **The button is the reader's from then on.** Nothing re-folds a description they opened;
 *    a merge request they walk away from and come back to is a fresh mount and folds again,
 *    which is the state a page should open in. */
function MergeRequestDescription(props: { detail: MergeRequestDetail }) {
  const nodes = useMemo(
    // The project is what makes a pasted screenshot a picture rather than a link nobody can
    // follow: an upload path names no project of its own (see `gitLabMarkdownOptions`).
    () =>
      parseGitLabMarkdown(
        props.detail.description ?? "",
        gitLabMarkdownOptions(props.detail.project_path),
      ),
    [props.detail.description, props.detail.project_path],
  );
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  // Whether the reader has pressed the control, and whether a press is travelling right now.
  // Both exist for one rule: **the fold on MOUNT is a state, not a movement.** Opening the page
  // used to play a collapse nobody asked for — the box was held at the fold by a CSS clamp until
  // the words were measured, and the measurement then dropped that clamp and handed Motion the
  // whole document's height to come down from. So the height is animated by a PRESS and by
  // nothing else, and the clamp is lifted only while a press is travelling.
  const [everPressed, setEverPressed] = useState(false);
  const [animating, setAnimating] = useState(false);
  // What the words really take, watched rather than read once: a table re-flows when the
  // window narrows, and a description that fitted at 1200px overruns at 390px.
  const [contentHeight, setContentHeight] = useState(0);
  const content = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setContentHeight(el.getBoundingClientRect().height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [nodes]);

  if (!props.detail.description) return null;

  const foldable = descriptionIsFoldable(contentHeight);
  const folded = foldable && !open;
  // The ceiling is on before anything is measured too — that is what makes the first paint the
  // folded window rather than the whole document. A description shorter than the window is
  // clamped by nothing, so the unmeasured case costs it nothing.
  const clamped = !animating && (folded || contentHeight === 0);
  // The distance the box really travels decides how long it takes (see
  // `descriptionFoldSeconds`): a description on this instance is a whole document, and a
  // fixed duration over a thousand pixels is a jump cut rather than a movement.
  const motionEase =
    reduce || !everPressed
      ? { duration: 0 }
      : {
          duration: descriptionFoldSeconds(contentHeight - DESCRIPTION_COLLAPSED_PX, open),
          ease: FOLD_EASE,
        };

  return (
    // `min-w-0` is the description's own rail: a wide table or a long fenced line must scroll
    // inside it (the renderer's `table` and `pre` cases both say so) rather than widen the
    // article and push the page's own controls off a phone's screen.
    <div
      data-testid="gitlab-description"
      data-folded={folded ? "true" : undefined}
      className="min-w-0"
    >
      <motion.div
        id={DESCRIPTION_BOX_ID}
        className="relative min-w-0 overflow-hidden"
        initial={false}
        // A plain CSS ceiling at exactly the height the fold holds, so the FIRST paint is
        // already the folded window — before the words are measured, and on the server. It is
        // lifted for one thing only: while a press is TRAVELLING, because a clamp left on would
        // clip the very movement it is there to make unnecessary. Lifting it on the measurement
        // instead is what played a collapse on open: the box painted at the whole document's
        // height for the frame between React dropping the clamp and Motion writing the fold.
        // A description shorter than the window is clamped by nothing, at every moment.
        style={clamped ? { maxHeight: DESCRIPTION_COLLAPSED_PX } : { maxHeight: "none" }}
        // `auto` rather than the measured number: only Motion knows what it measures to, and
        // leaving the box at `auto` afterwards is what lets a re-flow inside an OPEN
        // description size it without a second animation.
        animate={{ height: folded ? DESCRIPTION_COLLAPSED_PX : "auto" }}
        transition={{ height: motionEase }}
        onAnimationComplete={() => setAnimating(false)}
      >
        {/* The type is set HERE, from the constants the fold is derived from, so "eight lines"
            means eight of these lines. The blocks inside space themselves with a top margin
            only (`BLOCK_SPACING`), so this box's own height is what the words really take. */}
        <div
          ref={content}
          style={{ fontSize: DESCRIPTION_FONT_PX, lineHeight: DESCRIPTION_LINE_HEIGHT }}
        >
          <RichNodes nodes={nodes} className="text-text-dim" />
        </div>
        {/* The foot of the window, not a rule under it: the words themselves run out. It is
            drawn only where there is something behind it, and it FADES rather than vanishing
            — quicker than the box opens, so the last lines are legible while the height is
            still travelling. */}
        {foldable && (
          <motion.div
            aria-hidden
            data-testid="gitlab-description-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-b from-transparent to-background"
            style={{ height: DESCRIPTION_FADE_PX }}
            initial={false}
            animate={{ opacity: folded ? 1 : 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.14, ease: "linear" }}
          />
        )}
      </motion.div>
      {foldable && (
        // CENTRED, because the control belongs to the whole width it opens rather than to the
        // first word of the line above it — and because the words either side of it are the
        // reader's own document, which a control tucked against its left edge reads as part of.
        <button
          type="button"
          data-testid="gitlab-description-toggle"
          aria-expanded={open}
          aria-controls={DESCRIPTION_BOX_ID}
          onClick={() => {
            setEverPressed(true);
            setAnimating(true);
            setOpen((was) => !was);
          }}
          className="mx-auto mt-1.5 flex w-fit items-center gap-1 rounded text-[12px] font-medium text-text-dim transition-colors hover:text-foreground"
        >
          <motion.span
            className="flex shrink-0 items-center"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={motionEase}
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              className="size-4"
              strokeWidth={1.8}
              aria-hidden
            />
          </motion.span>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** The live pipeline, drawn as the GRAPH it is — compact, and with the way into its own page.
 *
 *  THE live half of this page. The store polls it while anything is in flight and stops the
 *  moment nothing is, so a finished pipeline costs nothing (see `loadPipeline`).
 *
 *  It used to be a list of stages, each with its jobs under it. What that shape cannot say is
 *  the one thing a reader of a red pipeline asks — WHICH job is holding the rest up — because a
 *  list has no room for the dependencies between its rows. So the panel draws the graph a
 *  glance needs and the PAGE draws the one a reader works in (`gitlab-pipeline-page.tsx`): the
 *  same split, and the same reason, as the Changes panel and the diff page above it. */
function PipelinePanel(props: { onOpenPipeline: () => void }) {
  const view = useAppState((s) => s.gitlabPipeline);
  const error = useAppState((s) => s.gitlabPipelineError);
  const jobs = view?.jobs ?? [];
  const live = pipelineIsLive(view);
  // The panel has no controls of its own: it shows the pipeline in the shape its own author
  // wrote (dependencies where they exist, stages otherwise) and hands the choice to the page.
  // A row of controls above a 96-pixel graph would be more control than graph.
  const graph = useMemo(() => pipelineGraph(view, defaultGrouping(jobs)), [view, jobs]);

  if (error && !view) {
    return (
      <Panel title="Pipeline" testId="gitlab-pipeline">
        <p
          data-testid="gitlab-pipeline-error"
          className="flex items-start gap-1.5 text-[12px] text-destructive"
        >
          <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
          {error}
        </p>
      </Panel>
    );
  }
  if (!view) {
    return (
      <Panel title="Pipeline" testId="gitlab-pipeline">
        <p className="flex items-center gap-2 text-[12px] text-text-faint">
          <HugeiconsIcon icon={Loading02Icon} className="size-3.5 animate-spin" strokeWidth={1.6} />
          Reading the pipeline…
        </p>
      </Panel>
    );
  }
  if (!view.pipeline) {
    return (
      <Panel title="Pipeline" testId="gitlab-pipeline">
        <p data-testid="gitlab-no-pipeline" className="text-[12px] text-text-faint">
          No pipeline has run for this merge request.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Pipeline"
      testId="gitlab-pipeline"
      data-live={live ? "true" : undefined}
      right={
        <div className="flex items-center gap-2">
          <PipelineStatusBadge status={view.pipeline.status} jobs={jobs} />
          {/* Says that the panel is following the run, so a reader knows the page is not
              simply stale. */}
          {live && (
            <span data-testid="gitlab-pipeline-live" className="text-[11px] text-text-faint">
              following
            </span>
          )}
          {view.pipeline.web_url && (
            <a
              href={view.pipeline.web_url}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-text-faint underline-offset-2 hover:underline"
            >
              #{view.pipeline.id}
            </a>
          )}
        </div>
      }
    >
      {jobs.length === 0 ? (
        <p className="text-[12px] text-text-faint">This pipeline has no jobs yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <PipelineGraphView graph={graph} showNeeds density="compact" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="gitlab-pipeline-open"
              data-cuelume-press=""
              onClick={props.onOpenPipeline}
              className="flex items-center gap-1.5 self-start rounded-lg bg-element px-3 py-1.5 text-[12px] font-medium text-text-dim transition-colors hover:text-foreground"
            >
              <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5" strokeWidth={1.8} />
              Open the pipeline
            </button>
            <p data-testid="gitlab-pipeline-summary" className="text-[11px] text-text-faint">
              {graphSummary(view, graph)}
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Who has approved, and the user's own approval as a toggle.
 *
 *  The same read and the same write a chat message's menu uses (`gitlab_approvals` /
 *  `gitlab_set_approval`), so there is one approval path in this app and not two — and the
 *  same reason it is offered at all: `approved: false` is GitLab's own undo. */
function ApprovalPanel() {
  const approval = useAppState((s) => s.gitlabApproval);
  const acting = useAppState((s) => s.gitlabActing);
  const controller = useController();
  if (!approval) return null;

  const busy = acting === "approve" || acting === "unapprove";
  return (
    <Panel
      title="Approvals"
      testId="gitlab-approvals"
      right={
        <button
          type="button"
          data-testid="gitlab-approve"
          data-mine={approval.mine ? "true" : undefined}
          disabled={!!acting}
          data-cuelume-toggle=""
          onClick={() => void controller.setOpenMergeRequestApproval(!approval.mine)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors",
            approval.mine
              ? "bg-element text-text-dim hover:text-foreground"
              : "bg-primary/12 text-primary hover:bg-primary/20",
            !!acting && "opacity-60",
          )}
        >
          <HugeiconsIcon
            icon={busy ? Loading02Icon : Tick02Icon}
            className={cn("size-3.5", busy && "animate-spin")}
            strokeWidth={1.8}
          />
          {approval.mine ? "Revoke approval" : "Approve"}
        </button>
      }
    >
      <div className="flex flex-col gap-1 text-[12px] text-text-dim">
        {approval.approvals_left != null && approval.approvals_left > 0 ? (
          <p data-testid="gitlab-approvals-left">
            {approval.approvals_left} more approval{approval.approvals_left === 1 ? "" : "s"} needed.
          </p>
        ) : approval.approved ? (
          <p data-testid="gitlab-approved">GitLab reports this as approved.</p>
        ) : null}
        {approval.approved_by && approval.approved_by.length > 0 ? (
          // Named the way every other person on this page is: a colleague the app knows is
          // called what the user calls them, and anybody else keeps GitLab's own word.
          <p data-testid="gitlab-approved-by">
            Approved by {approval.approved_by.map((p) => personFace(p).label).join(", ")}.
          </p>
        ) : (
          <p className="text-text-faint">Nobody has approved it yet.</p>
        )}
      </div>
    </Panel>
  );
}

/** The two writes that change what a merge request IS: the merge, and the close.
 *
 *  The merge asks twice — it is the one action here that no later click takes back — and the
 *  close does not, because a reopen undoes it from the same row. */
function ActionPanel(props: { detail: MergeRequestDetail }) {
  const detail = props.detail;
  const acting = useAppState((s) => s.gitlabActing);
  const error = useAppState((s) => s.gitlabActionError);
  const done = useAppState((s) => s.gitlabActionDone);
  const controller = useController();
  const [armed, setArmed] = useState(false);

  const verdict = mergeVerdict(detail);
  const change = stateChangeFor(detail);
  const merging = acting === "merge";
  const changing = acting === change;

  return (
    <Panel title="Actions" testId="gitlab-actions">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* MERGE. Two clicks: the first arms, the second lands the branch. The sentence
              under it names what that costs, so nobody presses the second one to find out.
              Disabled — with GitLab's own reason on it — wherever GitLab would refuse. */}
          {detail.state === "opened" && (
            <button
              type="button"
              data-testid={armed ? "gitlab-merge-confirm" : "gitlab-merge"}
              data-armed={armed ? "true" : undefined}
              disabled={!verdict.can || !!acting}
              title={verdict.reason}
              data-cuelume-press=""
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                void controller.mergeOpenMergeRequest();
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                armed
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90",
                (!verdict.can || !!acting) && "cursor-not-allowed opacity-50",
              )}
            >
              <HugeiconsIcon
                icon={merging ? Loading02Icon : GitMergeIcon}
                className={cn("size-4", merging && "animate-spin")}
                strokeWidth={1.8}
              />
              {armed ? "Merge — this cannot be undone" : "Merge"}
            </button>
          )}

          {armed && (
            <button
              type="button"
              data-testid="gitlab-merge-cancel"
              onClick={() => setArmed(false)}
              className="rounded-lg px-2.5 py-1.5 text-[12px] text-text-dim transition-colors hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
          )}

          {change && !armed && (
            <button
              type="button"
              data-testid={change === "close" ? "gitlab-close" : "gitlab-reopen"}
              disabled={!!acting}
              data-cuelume-press=""
              onClick={() => void controller.setOpenMergeRequestState(change)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg bg-element px-3 py-1.5 text-[13px] font-medium text-text-dim transition-colors hover:text-foreground",
                !!acting && "opacity-60",
              )}
            >
              <HugeiconsIcon
                icon={changing ? Loading02Icon : XVariableCircleIcon}
                className={cn("size-4", changing && "animate-spin")}
                strokeWidth={1.8}
              />
              {change === "close" ? "Close" : "Reopen"}
            </button>
          )}
        </div>

        {/* What the state of things is, in one line. While armed it is the WARNING, because
            that is the moment the sentence matters. */}
        <p
          data-testid="gitlab-merge-hint"
          className={cn("text-[12px]", armed ? "text-destructive" : "text-text-faint")}
        >
          {armed
            ? `This merges ${detail.source_branch} into ${detail.target_branch} for everybody, and no later click takes it back.`
            : verdict.reason}
        </p>

        {/* The outcome, where the click was made. A failure is never left looking like a
            success, and never left to the eleven pixels of the status line. */}
        {error && (
          <p
            data-testid="gitlab-action-error"
            className="flex items-start gap-1.5 text-[12px] text-destructive"
          >
            <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
            {error}
          </p>
        )}
        {done && !error && (
          <p data-testid="gitlab-action-done" className="text-[12px] text-primary">
            {done}
          </p>
        )}
      </div>
    </Panel>
  );
}

/** The conversation: real comments as bubbles, GitLab's own events as a quiet timeline, and
 *  a composer that posts under the user's name on their own Enter. */
function DiscussionPanel() {
  const notes = useAppState((s) => s.gitlabNotes);
  const discussions = useMemo(() => conversationDiscussions(notes), [notes]);
  const events = useMemo(() => systemNotes(notes), [notes]);
  const [showEvents, setShowEvents] = useState(false);

  return (
    <Panel
      title="Comments"
      testId="gitlab-comments"
      right={
        events.length > 0 && (
          <button
            type="button"
            data-testid="gitlab-events-toggle"
            aria-expanded={showEvents}
            onClick={() => setShowEvents((open) => !open)}
            className="text-[11px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
          >
            {showEvents ? "Hide" : "Show"} {events.length} event
            {events.length === 1 ? "" : "s"}
          </button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {showEvents && events.length > 0 && (
          <ul data-testid="gitlab-events" className="flex flex-col gap-1 border-l border-border-subtle pl-3">
            {events.map((note) => (
              <li key={note.id} className="text-[11px] text-text-faint">
                <span className="text-text-dim">{personFace(note.author).label}</span>{" "}
                {note.body} · {formatNoteTime(note.created_at)}
              </li>
            ))}
          </ul>
        )}

        {discussions.length === 0 ? (
          <p data-testid="gitlab-comments-empty" className="text-[12px] text-text-faint">
            Nothing has been said on this merge request yet.
          </p>
        ) : (
          discussions.map((discussion) => (
            <DiscussionThread key={discussion.id} discussion={discussion} />
          ))
        )}

        {notes?.truncated && (
          <p className="text-[11px] text-text-faint">
            GitLab holds more comments than this page read.
          </p>
        )}

        <CommentComposer />
      </div>
    </Panel>
  );
}

/** One discussion — a standalone comment, or a thread with its replies and its Reply. */
function DiscussionThread(props: { discussion: GitLabDiscussion }) {
  const discussion = props.discussion;
  const controller = useController();
  const replyTo = useAppState((s) => s.gitlabReplyTo);
  const acting = useAppState((s) => s.gitlabActing);
  const first = discussion.notes[0];
  const unresolved = discussion.notes.some((note) => note.resolvable && !note.resolved);
  const replying = replyTo === discussion.id;
  // What the resolve control says here, through the same rule the diff page's card uses — so a
  // thread cannot be resolvable on one surface and not on the other.
  const resolve = threadResolveAction(threadResolution(discussion.notes));

  return (
    <div
      data-testid="gitlab-discussion"
      data-discussion={discussion.id}
      data-thread={discussion.individual_note ? undefined : "true"}
      data-unresolved={unresolved ? "true" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-xl p-2.5",
        discussion.individual_note ? "bg-card" : "bg-card ring-1 ring-inset ring-border-subtle",
      )}
    >
      {/* Where a thread hangs in the code, when it does. The Changes section shows one file
          at a time, so the file and the line are what keep a review comment attached to
          something the reader can go and find. */}
      {first?.position && (
        <p data-testid="gitlab-note-position" className="font-mono text-[11px] text-text-faint">
          {first.position.new_path ?? first.position.old_path}
          {first.position.new_line != null ? `:${first.position.new_line}` : ""}
        </p>
      )}

      {discussion.notes.map((note) => (
        <NoteBubble key={note.id} note={note} />
      ))}

      {!discussion.individual_note && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="gitlab-reply"
            onClick={() => controller.setGitLabReplyTo(replying ? null : discussion.id)}
            className="text-[11px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
          >
            {replying ? "Cancel reply" : "Reply in this thread"}
          </button>
          {/* The same resolution the diff page's own card offers, on the same thread — one
              thread must not be two answers to "can I settle this?". One press either way,
              because each direction is the other's undo. */}
          {resolve && (
            <button
              type="button"
              data-testid="gitlab-thread-resolve"
              data-resolves={resolve.resolved ? "true" : "false"}
              disabled={!!acting}
              title={resolve.hint}
              data-cuelume-press=""
              onClick={() =>
                void controller.setGitLabThreadResolved(discussion.id, resolve.resolved)
              }
              className="ml-auto shrink-0 rounded px-1.5 py-px text-[10px] text-text-faint transition-colors hover:bg-element hover:text-text-dim"
            >
              {resolve.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** One comment. Its body is the same GitLab markdown the description is (a review comment
 *  quotes code as often as a description does), and the user's OWN comment carries the one
 *  thing that takes it back. */
function NoteBubble(props: { note: GitLabNote }) {
  const note = props.note;
  const controller = useController();
  const acting = useAppState((s) => s.gitlabActing);
  // A comment's own pictures are uploads of the merge request's project, exactly as the
  // description's are — and the open merge request IS the one these comments belong to.
  const project = useAppState((s) => s.openMergeRequest?.projectPath);
  const nodes = useMemo(
    () => parseGitLabMarkdown(note.body, gitLabMarkdownOptions(project)),
    [note.body, project],
  );
  const author = useMemo(() => personFace(note.author), [note.author]);
  const deleting = acting === `delete:${note.id}`;
  const [armed, setArmed] = useState(false);
  // `null` while the comment is read; a string while it is being REWRITTEN, starting from the
  // words that are there — an edit is a change to them and not a blank page.
  const [draft, setDraft] = useState<string | null>(null);

  const saveEdit = () => {
    if (draft === null || draft.trim() === "" || acting) return;
    // The box closes only when the rewrite LANDED: a refusal keeps the words, which is the
    // contract every box in this app holds (see lib/send-failure.ts).
    void controller.editGitLabComment(note.id, draft).then((edited) => {
      if (edited) setDraft(null);
    });
  };

  return (
    <div data-testid="gitlab-note" data-note={note.id} data-mine={note.mine ? "true" : undefined}>
      <div className="flex items-center gap-2">
        <Avatar
          seed={author.seed}
          label={author.label}
          photo={author.photo}
          initials={author.label.slice(0, 1).toUpperCase()}
          fallback="person"
          className="size-5 text-[9px]"
        />
        <span data-testid="gitlab-note-author" className="text-[12px] font-medium text-foreground">
          {author.label}
        </span>
        <time className="text-[11px] text-text-faint">{formatNoteTime(note.created_at)}</time>
        {note.resolvable && (
          <span
            data-testid="gitlab-note-resolved"
            className={cn(
              "rounded px-1.5 py-px text-[10px] font-medium",
              note.resolved ? "bg-primary/12 text-primary" : "bg-element text-text-faint",
            )}
          >
            {note.resolved ? "resolved" : "unresolved"}
          </span>
        )}

        {/* The words on screen are not the words the thread replied to, so it says so. */}
        {noteWasEdited(note) && (
          <span data-testid="gitlab-note-edited" className="shrink-0 text-[10px] text-text-faint">
            edited
          </span>
        )}

        {/* What the user may do to their OWN comment: rewrite it, or take it back. Those two
            undos are why commenting is offered at all. The deletion asks twice, like every
            other irreversible-looking action; the edit asks once, because it can be edited
            back. The backend re-reads whose comment it is before either. */}
        {note.mine && draft === null && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="gitlab-note-edit"
              disabled={!!acting}
              aria-label="Edit this comment"
              title="Rewrite this comment — everybody watching sees the new words"
              onClick={() => {
                setArmed(false);
                setDraft(note.body);
              }}
              className="flex items-center gap-1 rounded px-1.5 py-px text-[10px] text-text-faint transition-colors hover:text-text-dim"
            >
              <HugeiconsIcon icon={Edit02Icon} className="size-3" strokeWidth={1.8} />
              Edit
            </button>
            <button
              type="button"
              data-testid={armed ? "gitlab-note-delete-confirm" : "gitlab-note-delete"}
              disabled={!!acting}
              aria-label={armed ? "Confirm deleting this comment" : "Delete this comment"}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                void controller.deleteGitLabComment(note.id);
              }}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-px text-[10px] transition-colors",
                armed ? "bg-destructive/12 text-destructive" : "text-text-faint hover:text-text-dim",
              )}
            >
              <HugeiconsIcon
                icon={deleting ? Loading02Icon : Delete02Icon}
                className={cn("size-3", deleting && "animate-spin")}
                strokeWidth={1.8}
              />
              {armed ? "Delete for everybody" : "Delete"}
            </button>
          </div>
        )}
      </div>

      {draft === null ? (
        <RichNodes nodes={nodes} className="pl-7 pt-1 text-[13px] leading-relaxed text-text-dim" />
      ) : (
        <div className="flex flex-col gap-2 pl-7 pt-1">
          <textarea
            data-testid="gitlab-note-edit-input"
            value={draft}
            rows={3}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // ⌘↵ saves and Escape leaves the words as they were — the composer's own keys.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                saveEdit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
            }}
            className="w-full resize-y rounded-lg bg-background px-2.5 py-2 text-[13px] text-foreground ring-1 ring-inset ring-border-subtle outline-none focus:ring-primary/50"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="gitlab-note-edit-save"
              disabled={draft.trim() === "" || !!acting}
              data-cuelume-press=""
              onClick={saveEdit}
              className={cn(
                "flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground transition-opacity",
                (draft.trim() === "" || !!acting) && "opacity-50",
              )}
            >
              <HugeiconsIcon icon={Edit02Icon} className="size-3.5" strokeWidth={1.8} />
              Save
            </button>
            <button
              type="button"
              data-testid="gitlab-note-edit-cancel"
              onClick={() => setDraft(null)}
              className="text-[12px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The comment box.
 *
 *  Outward, so it holds the composer's own contract: the words stay in the box until GitLab
 *  has taken them, a failure is reported beside it, and nothing is posted but by the user's
 *  own click or ⌘↵. */
function CommentComposer() {
  const controller = useController();
  const draft = useAppState((s) => s.gitlabCommentDraft);
  const replyTo = useAppState((s) => s.gitlabReplyTo);
  const acting = useAppState((s) => s.gitlabActing);
  const error = useAppState((s) => s.gitlabActionError);
  const posting = acting === "comment";
  const empty = draft.trim() === "";

  return (
    <div data-testid="gitlab-composer" className="flex flex-col gap-2 pt-1">
      {replyTo && (
        <p className="text-[11px] text-text-faint">
          Replying in a thread ·{" "}
          <button
            type="button"
            onClick={() => controller.setGitLabReplyTo(null)}
            className="underline-offset-2 hover:text-text-dim hover:underline"
          >
            write a new comment instead
          </button>
        </p>
      )}
      <textarea
        data-testid="gitlab-comment-input"
        value={draft}
        rows={3}
        placeholder={replyTo ? "Reply in this thread…" : "Comment on this merge request…"}
        onChange={(event) => controller.setGitLabCommentDraft(event.target.value)}
        onKeyDown={(event) => {
          // ⌘↵ / Ctrl+↵ posts, plain Enter does not: a comment is outward, and a newline
          // in a review note is far more common than a finished thought.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!empty && !acting) void controller.postGitLabComment();
          }
        }}
        className={cn(
          "w-full resize-y rounded-xl bg-card px-3 py-2 text-[13px] text-foreground shadow-chip",
          "placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-primary/40",
        )}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="gitlab-comment-send"
          disabled={empty || !!acting}
          data-cuelume-press=""
          onClick={() => void controller.postGitLabComment()}
          className={cn(
            "flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90",
            (empty || !!acting) && "cursor-not-allowed opacity-50",
          )}
        >
          <HugeiconsIcon
            icon={posting ? Loading02Icon : Message01Icon}
            className={cn("size-3.5", posting && "animate-spin")}
            strokeWidth={1.8}
          />
          {replyTo ? "Reply" : "Comment"}
        </button>
        <span className="text-[11px] text-text-faint">
          Posts to GitLab under your name. ⌘↵ sends.
        </span>
      </div>
      {/* The composer's own report of a failed post, beside the words that are still in the
          box — the mirror of `sendError` in the chat composer. */}
      {error && posting === false && (
        <p data-testid="gitlab-comment-error" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A comment's time, in the shape a conversation reads in. */
function formatNoteTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Shown in the detail pane while the GitLab tab is up but nothing is open. */
function GitLabEmptyState() {
  return (
    <section
      data-testid="gitlab-pane-empty"
      className="flex min-w-0 flex-1 items-center justify-center bg-background p-8"
    >
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <GitLabLogo className="size-10" title="GitLab" />
        <p className="text-sm text-text-dim">Pick a merge request to read it.</p>
        <p className="text-[12px] text-text-faint">
          The list holds what is not merged. Merging, commenting, approving and closing all
          happen under your own GitLab account, and only when you press the button.
        </p>
      </div>
    </section>
  );
}
