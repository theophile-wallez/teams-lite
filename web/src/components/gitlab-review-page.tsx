import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  ChevronLeftIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import {
  resolveReviewChatWidth,
  REVIEW_CHAT_MIN_WIDTH,
  REVIEW_DOCUMENT_MIN_WIDTH,
  reviewAttribution,
  reviewCanBeAsked,
  reviewCoverage,
  reviewFoldedPatches,
  reviewGroups,
  reviewIsStale,
  reviewLimits,
  reviewPartKey,
  reviewPartLabel,
  reviewSectionId,
  type GitLabReview,
  type ReviewGroup,
  type ReviewGroupFile,
} from "~/lib/gitlab-review";
import type { ResolvedTheme } from "~/lib/appearance";
import { diffFileNotice, formatDiffStat, type GitLabDiff } from "~/lib/gitlab-diff";
import type { PierreSide } from "~/lib/gitlab-diff-comment";
import { parseGitLabMarkdown } from "~/lib/gitlab-markdown";
import { gitlabPageUrl, mergeRequestPagePanel } from "~/lib/gitlab-mr-pages";
import { markReviewCode, reviewCodeUnsearchable } from "~/lib/gitlab-review-code";
import { reviewRunRows, type ReviewRunProgress } from "~/lib/review-progress";
import TaskRows from "./beautifului/task-rows";
import { ReviewCodeProvider, useCodeVocabulary } from "./review-code-context";
import { gitLabMarkdownOptions } from "~/lib/gitlab-upload";
import { formatMessageTime } from "~/lib/message-time";
import { cn } from "~/lib/utils";
import { ColumnSplitter } from "./column-splitter";
import { useAppState, useController } from "./controller-context";
import { AgentLogo } from "./agent-logo";
import { GitLabLogo } from "./gitlab-logo";
import { MergeRequestPageStrip } from "./gitlab-mr-pages";
import { ReviewChatPanel } from "./gitlab-review-chat";
import { FadeArc } from "./loading-ui/fade-arc";
import { RichNodes } from "./rich-content";
import { TrackerProjectProvider } from "./tracker-refs-context";

// THE READING: `/mr/<project>!<iid>/review`, the fifth page of a merge request.
//
// It is the branch WRITTEN UP — one document, scrolled from top to bottom: a sentence about the
// whole branch, then a section per theme whose heading STICKS while its part is read, the reading's
// own prose under it, and under that the real patches of the files it is about. A reviewer who has
// not opened the branch yet reads this and knows what it does.
//
// **It is a PAGE, and that reverses what shipped first.** The reading was a second VIEW of the diff
// — a control in that page's header, on the argument the Pipelines page makes for its graph beside
// its job list. That held while the reading was a MAP: headings over the same file names the tree
// was already showing. It stops holding now the reading has its own prose, its own code and (next)
// its own conversation, because those are different content read a different way. The three things
// a URL gives are the point: it survives a reload, it can be sent to whoever is being asked to
// review, and the browser's own Back leaves it. `lib/gitlab-review.ts` carries the same note.
//
// Ten rules hold the surface, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **THE PAGE HAS ONE LAYOUT, before and after the press.** The offer used to be a `bg-card` panel
//     floating in the middle of an empty column, with the progress rows inside it as a second layer of
//     cards — and the finished state is a flush document, so the two states looked like two surfaces.
//     Both take `DOCUMENT_HEADER` now: the same measure, the same padding, the same 17px opening line
//     with an 11px line of fact under it. The reader reported the old one, and what they said about it
//     is the whole rule — a review page that does not look like itself until it has something to say
//     reads as unfinished.
//   - **THE ACCENT IS SPENT ON A PRESS THE READER STILL HAS TO MAKE, and never on one that undoes what
//     is on screen.** On the empty page "Start the AI review" is the only thing to do, so it is the
//     accent fill; on a finished document the same act throws that document away and makes the reader
//     wait again, so it is QUIET and stands beside the title (`RunButton`'s two tones). As a filled
//     pill under the meta line it was the loudest thing on a page whose point is the prose.
//   - **THE STEPS GO WHEN THE REVIEW LANDS, and stay when it fails.** The document says everything
//     three finished rows say and more, so a `Completed` list above it is scaffolding left standing —
//     a failure's rows are half of the answer and are kept. It is the store that holds this, in BOTH
//     places a run can end (see the `gitlab_mr_review_progress` handler: the terminal frame races the
//     response, and after the response there is no watched run to measure it against).
//   - **The document scrolls, and the page does not.** The header and the strip stay; one scroller
//     under them, which is what makes a sticky heading mean anything at all.
//   - **A theme's heading STICKS.** It is the one thing on screen that says which part of the branch
//     the code under the reader's eye belongs to — the job pierre's own sticky file header does in
//     the feed, one level up.
//   - **The prose is real markdown**, through this app's own GFM parser (`parseGitLabMarkdown`) and
//     its own renderer — never a model's HTML, and never `whitespace-pre-line` over raw text, which
//     is what the first version drew: a model writes lists and backticked identifiers because that
//     is how an engineer writes, and printed literally they are noise.
//   - **The DOCUMENT is ONE measure, and the words fill it.** It shipped with a second, narrower rule
//     inside it — `max-w-prose`, 65 characters, on every run of words — on the argument that a
//     paragraph past that is unreadable. Against the CONVERSATION beside it that argument broke: the
//     document column is then some 800px and the prose used half of it, so a theme's own description
//     read as a cropped column with a hand's width of nothing beside it. It was reported that way.
//     The measure is now the document's own `max-w-5xl` — bounded by what a unified PATCH needs,
//     which is the widest thing on the page. The one narrower measure left is the OFFER's own two
//     lines, and its reason is not that it is a card (it is not, any more): that is the single state
//     with no code and no conversation beside it, so the document really is the full 5xl there and a
//     sentence run across all of it is unreadable.
//   - **The code is the DIFF's, never the model's** — the patch the read already holds, so nothing
//     on this page is code somebody's branch does not contain.
//   - **A long patch opens FOLDED, and so does everything past the document's ceiling**
//     (`reviewGroups` spends both budgets). What folded is COUNTED at the top, because a document
//     that quietly stopped showing code reads as a reading that ran out of things to say.
//   - **Nothing is hidden.** Every changed file is in exactly one section, and the files no theme
//     claimed are a section of their own at the END rather than a footnote — a reviewer still has to
//     read them, and a grouped view that left one out would let them believe they had seen the
//     branch.

/** The patch renderer, out of the diff page's own lazy chunk.
 *
 *  Shiki carries a TextMate grammar per language, so this must never sit on the path of a chat —
 *  the rule `gitlab-diff-page.tsx` states in full. The prose is NOT behind it: the document renders
 *  and is readable while the highlighter is still on its way, which is the whole reason the patches
 *  suspend one by one rather than the page suspending once. */
const DiffFilePatch = lazy(() =>
  import("./gitlab-diff-view").then((m) => ({ default: m.DiffFilePatch })),
);

/** The custom property the conversation column takes its width from.
 *
 *  Declared on the row that holds both columns and written by the splitter during a drag, which is
 *  what keeps a resize off React's path entirely (see `column-splitter.tsx`). */
const CHAT_WIDTH_VAR = "--review-chat-width";

/** Below this the page is ONE column at a time — the app's own `md`, and the width the diff page's own
 *  two columns collapse at. */
const REVIEW_TWO_COLUMN_WIDTH = 768;

/** THE DOCUMENT'S OWN OPENING BLOCK, and the reason it is a constant rather than two class lists.
 *
 *  This page has two first screens — the OFFER before anything has been reviewed, and the review's
 *  own HEADLINE after — and the user reported the first as not looking like the page at all: it was a
 *  `bg-card` box of its own, floating in a column whose finished state is a flush document, with the
 *  progress rows inside it as a second layer of cards. So the two states are one shell now, spelled
 *  once, and the offer really is the document's first paragraph rather than a panel standing in for
 *  it. Neither can drift from the other, which is the whole value of the constant. */
const DOCUMENT_HEADER = "flex flex-col gap-3 px-4 pt-5 pb-6 md:px-6";

/** The viewport's width, which decides whether there are two columns to divide and how wide the
 *  conversation may be.
 *
 *  SSR-safe by starting at 0, which `resolveReviewChatWidth` reads as "nothing measured yet" and
 *  leaves the asked-for width alone — the trap that guard exists for. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return width;
}

export function GitLabReviewPage(props: {
  onBack: () => void;
  onOpenFile: (path: string) => void;
  /** Leave for the DIFF page with one name's occurrences panel open on it — the press a name chip
   *  in the prose makes on a coarse pointer, and the press a row inside its hover card makes on
   *  any pointer (see `review-code-chip.tsx`). */
  onOpenSymbol: (symbol: string, place?: { path: string; lineNumber: number; side: PierreSide }) => void;
}) {
  const detail = useAppState((s) => s.gitlabDetail);
  const diff = useAppState((s) => s.gitlabDiff);
  const diffError = useAppState((s) => s.gitlabDiffError);
  const review = useAppState((s) => s.gitlabReview);
  const busy = useAppState((s) => s.gitlabReviewBusy);
  const error = useAppState((s) => s.gitlabReviewError);
  const progress = useAppState((s) => s.gitlabReviewProgress);
  const askedChatWidth = useAppState((s) => s.gitlabReviewChatWidth);
  const controller = useController();

  const width = useViewportWidth();
  // Two columns only where there is room for two, at the app's own `md`. Below it the conversation is
  // a bounded slice under the document instead, and nothing is dragged.
  const wide = width >= REVIEW_TWO_COLUMN_WIDTH;
  const chatWidth = useMemo(
    () => resolveReviewChatWidth({ viewport: width, asked: askedChatWidth }),
    [width, askedChatWidth],
  );
  // The element the width is declared on, and the one the splitter writes to.
  const columnHost = useRef<HTMLDivElement | null>(null);

  // Written inline, these would be new function identities on every render of this page, so the
  // provider's value object would be new every render too.
  //
  // **WHAT IS LOAD-BEARING IS `code`, AND IT IS SAFE EITHER WAY**: it is memoized on the DIFF alone
  // (see review-code-context.tsx), so the four marking memos — which key on it and not on the value
  // object — do not re-run when only these move. So this is hygiene rather than a fix: it keeps the
  // context value from changing for no reason, which is what re-renders every consumer of it.
  //
  // And it is honest about its limit: `props.onOpenSymbol` is an inline arrow in `app.tsx`, so it is
  // a fresh identity on every render of the SHELL and these two follow it. Memoizing it there as
  // well would close that, and it is deliberately not done — the shell passes `onOpenFile` the same
  // way, and one file's style is worth more than a dependency that changes nothing measurable.
  const onOpenSymbol = props.onOpenSymbol;
  const openSymbol = useCallback((symbol: string) => onOpenSymbol(symbol), [onOpenSymbol]);
  const goToOccurrence = useCallback(
    (symbol: string, path: string, lineNumber: number, side: PierreSide) =>
      onOpenSymbol(symbol, { path, lineNumber, side }),
    [onOpenSymbol],
  );

  return (
    // A bare `!42` in the reading's own prose means a merge request of THIS project, exactly as it
    // does in the description and in a comment on a line of the diff (see lib/tracker-ref.ts).
    <TrackerProjectProvider project={detail?.project_path}>
      {/* And a NAME in that prose means something in THIS branch's diff — which is why the
          vocabulary is one page's and not the app's (see review-code-context.tsx). The provider
          wraps the conversation as well as the document, because an answer to a follow-up question
          is prose about the same code. */}
      <ReviewCodeProvider
        diff={diff}
        hasReview={!!review}
        onOpenSymbol={openSymbol}
        onGoToOccurrence={goToOccurrence}
      >
      <section
        data-testid="gitlab-review-page"
        className="flex h-full min-h-0 w-full flex-col bg-background"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-4">
          <button
            type="button"
            data-testid="gitlab-review-back"
            aria-label="Back to the merge request"
            onClick={props.onBack}
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
          </button>
          <GitLabLogo className="size-5 shrink-0" title="GitLab" />
          {/* WHICH merge request this is a reading of. This page has no sidebar, so the line is the
              only thing that says where the reader is — and `min-w-0` is what keeps a 150-character
              title from taking the controls off the right of the screen (the lesson § A long TITLE
              taught this surface). */}
          <div className="flex min-w-0 flex-1 flex-col">
            <h1
              data-testid="gitlab-review-title"
              className="truncate text-sm font-medium text-foreground"
            >
              {detail ? detail.title : "The changes, by theme"}
            </h1>
            <p className="truncate text-[11px] text-text-faint">
              {detail ? `${detail.reference} · ` : ""}
              Read by a local agent
            </p>
          </div>
        </header>

        {/* The same sub-header every other page of this merge request carries, so the five are
            reachable from all five (see `gitlab-mr-pages.tsx`). It takes this header's own padding,
            so the strip and the title above it start on one line. */}
        <MergeRequestPageStrip current="review" className="md:px-4" />

        <div {...mergeRequestPagePanel("review")} className="flex min-h-0 flex-1 flex-col">
          {diffError && !diff ? (
            // The reading is BUILT on the diff read, so a diff nobody could read is this page's own
            // failure — and the one thing left is GitLab's own changes, which is what every other
            // failure on these pages offers.
            <ReviewFailure error={diffError} webUrl={detail?.web_url} />
          ) : !diff ? (
            <ReviewLoading label="Reading the changes…" />
          ) : !reviewCanBeAsked(diff) ? (
            <p
              data-testid="gitlab-review-empty"
              className="flex flex-1 items-center justify-center p-8 text-[13px] text-text-faint"
            >
              This merge request changes no files, so there is nothing to read.
            </p>
          ) : (
            // THE DOCUMENT, and — once there is a reading to ask about — the CONVERSATION beside it.
            // Two columns on a wide screen and one above the other on a phone, which is the shape
            // the diff page's own two take: a document of prose and code cannot share 390px with a
            // transcript, and below `md` the conversation follows the words it is about.
            <div
              ref={columnHost}
              // The direction is `wide`'s too, not a `md:` class. They are two different measurements
              // — a media query is on the viewport, `window.innerWidth` counts a scrollbar it does
              // not — so at the boundary the CSS could lay out a row while the JS said narrow, giving
              // the column no width and no handle. The diff page has one source of truth for the same
              // reason (`diffPageColumns`).
              className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}
              // The width lives HERE, on the row both columns are in, because that is the one element
              // a splitter can write to and the column can read from. React renders the resolved
              // number; a drag overwrites it on the DOM and the store catches up at the end (see
              // `column-splitter.tsx`).
              style={{ [CHAT_WIDTH_VAR]: `${chatWidth}px` } as React.CSSProperties}
            >
              <ReviewDocument
                review={review}
                diff={diff}
                project={detail?.project_path}
                headSha={detail?.diff_refs?.head_sha ?? null}
                busy={busy}
                error={error}
                progress={progress}
                onRun={() => void controller.runGitLabReview()}
                onOpenFile={props.onOpenFile}
              />
              {review && (
                <>
                  {/* The rule between the document and the conversation, and the handle that moves it
                      — the diff page's own splitter, so a dragged column on this page behaves exactly
                      as one there. Drawn only where there really are two columns to divide: below `md`
                      each takes the full width in turn, so a splitter there would size nothing. */}
                  {wide && (
                    <ColumnSplitter
                      host={columnHost}
                      variable={CHAT_WIDTH_VAR}
                      width={chatWidth}
                      min={REVIEW_CHAT_MIN_WIDTH}
                      // The DOCUMENT keeps its own minimum, which is not a preference: the code
                      // inside it is the one thing on this page that cannot be narrowed and still be
                      // read.
                      max={Math.max(REVIEW_CHAT_MIN_WIDTH, width - REVIEW_DOCUMENT_MIN_WIDTH)}
                      // `end`: the column is to the RIGHT of the handle, so rightward travel narrows
                      // it.
                      side="end"
                      onCommit={(next) => controller.setGitLabReviewChatWidth(next)}
                      label="Resize the conversation"
                      testId="gitlab-review-chat-splitter"
                    />
                  )}
                  {/* On a phone it is BOUNDED and the document keeps the rest, because a transcript of
                      five turns would otherwise take the whole screen and leave the words it is about
                      nowhere — and each half scrolls itself, so both stay reachable. On a wide screen
                      it is a full-height column as wide as the reader dragged it, and it carries no
                      border of its own: the splitter beside it IS the rule between the two. */}
                  <div
                    data-testid="gitlab-review-chat-column"
                    className={cn(
                      "flex min-h-0 shrink-0 flex-col",
                      // Narrow: a bounded slice UNDER the document, so a transcript of five turns
                      // cannot take the screen from the words it is about. Wide: a full-height column
                      // as wide as the reader dragged it, with no border of its own — the splitter
                      // beside it IS the rule between the two.
                      wide ? "" : "max-h-[55%] border-t border-border-subtle",
                    )}
                    style={wide ? { width: `var(${CHAT_WIDTH_VAR})` } : undefined}
                  >
                    <h2 className="shrink-0 border-b border-border-subtle px-4 py-3 text-[13px] font-medium text-foreground md:px-5">
                      Ask about it
                    </h2>
                    <ReviewChatPanel review={review} diff={diff} project={detail?.project_path} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      </ReviewCodeProvider>
    </TrackerProjectProvider>
  );
}

/** The document, or the offer that stands in for it before anything has been read. */
function ReviewDocument(props: {
  review: GitLabReview | null;
  diff: GitLabDiff;
  project: string | undefined;
  headSha: string | null;
  busy: boolean;
  error: string | null;
  progress: ReviewRunProgress | null;
  onRun: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { review, diff } = props;
  const groups = useMemo(() => reviewGroups(review, diff), [review, diff]);
  const stale = reviewIsStale(review, props.headSha);
  const theme = useAppState((s) => s.resolvedTheme);
  return (
    <div
      data-testid="gitlab-review-document"
      data-has-review={review ? "yes" : "no"}
      data-stale={stale ? "yes" : "no"}
      data-themes={groups.filter((group) => !group.unplaced).length}
      // ONE scroller, which is what makes a sticky heading inside it mean anything. `overscroll-none`
      // so reaching the end of a long reading does not scroll whatever is behind the page.
      className="min-h-0 flex-1 overflow-y-auto overscroll-none"
    >
      {/* As wide as the CODE needs — a unified patch under about 90 characters is unreadable — with
          the prose held narrower inside it. Two measures, one column. */}
      <div className="mx-auto w-full max-w-5xl">
        {!review ? (
          // No padding of its own: the offer IS the document's own header, so it takes that block's
          // padding rather than sitting inside a second box with a second inset.
          <ReviewOffer
            busy={props.busy}
            error={props.error}
            progress={props.progress}
            onRun={props.onRun}
            files={diff.files.length}
          />
        ) : (
          <article>
            <ReviewHeadline
              review={review}
              diff={diff}
              groups={groups}
              project={props.project}
              stale={stale}
              busy={props.busy}
              error={props.error}
              progress={props.progress}
              onRun={props.onRun}
            />
            {groups.map((group, index) => (
              <ReviewSection
                key={group.title ? `${group.title}:${index}` : `unplaced:${index}`}
                group={group}
                index={index}
                project={props.project}
                theme={theme}
                onOpenFile={props.onOpenFile}
              />
            ))}
          </article>
        )}
      </div>
    </div>
  );
}

/** What stands here before any review has been made: what the press DOES, and what it costs.
 *
 *  The cost is named before the press, which is the rule the update button holds for its 130 MB and
 *  the expanded diff read holds for its half a megabyte. Here it is not bytes: it is that the code
 *  leaves this machine for a model provider, which is the one fact the reader cannot undo after.
 *
 *  **IT IS THE DOCUMENT'S OWN HEADER, not a card in front of it.** Both of those were wrong for what
 *  this page is, and the user reported them together: a `bg-card` panel floating in a column whose
 *  finished state is flush prose, and a paragraph explaining the feature to somebody who had already
 *  pressed the tab. So it is the same shell the headline takes (`DOCUMENT_HEADER`), with the same type
 *  scale — a 17px opening line, an 11px line of fact under it, the press, and the small print — and
 *  the explanation is gone. What remains is what a reader decides with, which is what the review
 *  gives them and where their code goes. */
function ReviewOffer(props: {
  busy: boolean;
  error: string | null;
  progress: ReviewRunProgress | null;
  onRun: () => void;
  files: number;
}) {
  return (
    <header data-testid="gitlab-review-offer" className={DOCUMENT_HEADER}>
      {/* The document's own opening line, at the size the headline it stands in for is set at — so
          the page reads as one surface across the press rather than swapping a panel for an article.
          The measure is the OFFER's alone, because this is the one state with no code and no
          conversation to be as wide as: the document is the full 5xl here, and a sentence run across
          all of it is unreadable. */}
      <h2 className="max-w-2xl text-[17px] leading-relaxed text-foreground">
        Review these changes by theme
      </h2>
      {/* WHAT THE PRESS GIVES, in the slot and the ink the finished document states its coverage in
          (`Claude · Sonnet · 3 of 3 files grouped`). It replaced three lines of prose about the
          feature: a reader who has opened this tab has asked for it already, so what they are owed is
          the fact, not the pitch — and the fact is the count and the grouping, in six words. That the
          code of each change is drawn under the words explaining it is left to be MET rather than
          promised, which is the same trade the fold's own note makes one state later. */}
      <p className="text-[11px] text-text-faint">
        {props.files === 1 ? "1 file" : `${props.files} files`} · grouped by what they do
      </p>
      <RunButton busy={props.busy} onRun={props.onRun} label="Start the AI review" />
      {/* WHAT THE RUN IS DOING, directly under the press that started it — the composer's own rule
          that an action reports itself where it was asked for. A run is tens of seconds at best and
          bounded at 35 minutes, and the button alone said one word for all of it. */}
      {props.progress && <ReviewRunProgressRows progress={props.progress} />}
      {/* The failure sits with the ROWS rather than at the foot of the block, because the two are one
          answer: the sentence says what went wrong and the rows say how far the review got, and a
          paragraph of small print between them would separate the halves. */}
      {props.error && <ReviewError error={props.error} />}
      {/* It runs the CLI the reader chose in Settings › AI providers, and the diff travels in the
          prompt — so this says where their code goes, in as many words. Last, which is where small
          print belongs once there is a report above it. */}
      <p
        data-testid="gitlab-review-cost"
        className="max-w-2xl text-[11px] leading-relaxed text-text-faint"
      >
        Runs the agent you chose in Settings › AI providers, on this machine. The diff is put in the
        prompt, so this branch's code reaches that provider. It is granted no access to your files.
      </p>
    </header>
  );
}

/** The rows a run is watched through.
 *
 *  The mapping is `reviewRunRows`' — pure, and tested for every stage without a browser — and the
 *  drawing is `TaskRows`'. Nothing about what a stage MEANS lives here. */
function ReviewRunProgressRows(props: { progress: ReviewRunProgress }) {
  const rows = useMemo(() => reviewRunRows(props.progress), [props.progress]);
  return (
    // NO RULE ABOVE THEM AND NOTHING STRETCHED, which is what taking the card away corrected. The
    // hairline was drawn to cross that card, and on the flush document it is a section break in the
    // middle of a header — the one mark this page spends on separating a theme from the theme before
    // it. The rows are already a different kind of object from the words above them, because they are
    // raised off the page and the words are not.
    //
    // `aria-live="polite"` sits on the wrapper rather than in the vendor's file: a reader who is not
    // looking is told when a step finishes, and never interrupted mid-sentence to hear it. Polite is
    // the only honest setting for a run that lasts minutes.
    <div aria-live="polite" aria-label="What the review is doing" className="flex w-full flex-col">
      {/* CAPSULES, which is the vendor's own default: each row a rounded card of its own, raised off
          the page the way this document's own file boxes are. It is the right variant now there is no
          card around it — inside one it was a card in a card, which is two nested surfaces for one
          thing (the argument `TabsList surface={false}` makes on the page strip above) and is exactly
          what the reader photographed. The LIST variant is one bordered box with flush rows, and it
          would be a third surface vocabulary on a page that already has raised boxes. */}
      <TaskRows rows={rows} testId="gitlab-review-progress" />
    </div>
  );
}

/** The document's own opening: the sentence about the whole branch, who read it and when, how much
 *  of the branch it accounts for, what it could not see, and the way to ask again. */
function ReviewHeadline(props: {
  review: GitLabReview;
  diff: GitLabDiff;
  groups: ReviewGroup[];
  project: string | undefined;
  stale: boolean;
  busy: boolean;
  error: string | null;
  progress: ReviewRunProgress | null;
  onRun: () => void;
}) {
  const { review } = props;
  // Off the GROUPS the document is really drawing, not off the reading: the groups are a pass over
  // every patch in the branch, and asking for them twice per render would double that.
  const coverage = reviewCoverage(props.groups, props.diff);
  const limits = reviewLimits(review);
  const folded = reviewFoldedPatches(props.groups);
  const unmarked = reviewCodeUnsearchable(props.diff);
  const code = useCodeVocabulary();
  // Parsed, then MARKED — the two in one memo, because the marking is a pass over the tree the parse
  // just made and a second memo would key on an array identity this one already owns. It is done
  // here rather than inside `RichNodes` for the reason review-code-context.tsx gives: this prose is
  // the only prose in the app that has a diff to point at.
  const headline = useMemo(
    () =>
      markReviewCode(
        parseGitLabMarkdown(review.headline, gitLabMarkdownOptions(props.project)),
        code,
      ),
    [review.headline, props.project, code],
  );
  return (
    // The same shell the OFFER takes, so the page keeps its shape across the press that fills it.
    <header className={DOCUMENT_HEADER}>
      {/* THE OPENING LINE AND THE WAY TO ASK AGAIN, on one row — because the re-review is not what
          this page is for. It stood under the meta line as a filled accent pill, which on a finished
          document made the loudest thing on the screen a control that throws that document away: the
          reader came to READ, and the accent is what this app spends on the one thing that earns it.
          Beside the title and drawn quiet, it is where a document's own controls sit and it costs the
          words nothing. `items-start` so it sits at the first line of a headline that wraps to three,
          and `min-w-0` so a long one gives way rather than pushing it off the right. */}
      {/* AND IT STACKS ON A PHONE, because there the button is not free. At 390px a labelled control
          takes some 150px of the row, and the headline — the one thing on this page a reader came for
          — was left wrapping in 200px, seven lines tall with an empty square beside it. Above `sm` the
          words have width to spare and the control costs them nothing. */}
      <div className="flex w-full flex-col items-start gap-3 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {review.headline ? (
            // The branch in one sentence, set as the document's own opening line rather than as a
            // card: this IS the first thing to read, so nothing frames it.
            <div data-testid="gitlab-review-headline">
              <RichNodes
                nodes={headline}
                className="text-[17px] leading-relaxed text-foreground [&_p]:m-0"
              />
            </div>
          ) : (
            <p className="text-[17px] leading-relaxed text-text-dim">
              This branch was reviewed, but the review said nothing about it as a whole.
            </p>
          )}
          {/* WHICH machine reviewed it, and WHEN — the two facts a reader deciding how much to trust
              a machine's reading of their branch is owed. The CLI's OWN MARK stands beside its name,
              because that is what says at a glance which vendor read the code: the name is the
              identifier the CLI is invoked with, and this app already draws that mark wherever an
              agent speaks (the bubble, the composer's chips, Settings › AI providers). The moment is
              drawn with the app's own words for one, so "Yesterday 14:32" means the same thing here
              as in a chat. */}
          {/* EVERY SEPARATOR BELONGS TO THE FACT AFTER IT, and is glued to it (`whitespace-nowrap`).
              A wrapped line is where this shows: as standalone flex children the `·` could be the last
              thing on a line, with the fact it introduced on the next one — measured on a phone, which
              left "12:14 AM ·" hanging at the end of a line. A break now falls BETWEEN facts, which is
              the only place it means anything. */}
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-text-faint">
            <AgentLogo
              backend={review.provider}
              className="size-3.5 shrink-0"
              title={review.provider}
            />
            <span data-testid="gitlab-review-by" className="whitespace-nowrap text-text-dim">
              {reviewAttribution(review)}
            </span>
            <span className="whitespace-nowrap">· {formatMessageTime(review.generated_ms)}</span>
            <span data-testid="gitlab-review-coverage">
              <span aria-hidden>· </span>
              {coverage.grouped} of {coverage.total} files grouped
              {/* IN HOW MANY PARTS, but only where a file was really split — a theme claims regions
                  of files, so "12 of 14 files grouped, in 19 parts" says the review found more than
                  one thing in some of them. Where every part is a whole file the clause says nothing,
                  and a number that never varies is a number nobody reads. */}
              {coverage.parts > coverage.grouped ? `, in ${coverage.parts} parts` : ""}
            </span>
          </p>
        </div>
        <RunButton busy={props.busy} onRun={props.onRun} label="Review again" tone="quiet" />
      </div>
      {/* WHY A NAME MIGHT NOT BE MARKED, said once and at document level — the only level where a
          missing chip can explain itself, since the chip that would have explained it is the thing
          that is absent. A name is only marked against the patches that TRAVELLED, and on the real
          instance 96 of one merge request's 149 files came back with none.
          It is a LINE OF ITS OWN rather than the last clause of the meta line above, which is where it
          used to sit: it is a whole sentence among that line's three short facts, so it wrapped and
          left the `·` before it dangling at the end of the first line. Its neighbours below — the
          limits and the fold — are the same kind of note and are already drawn this way. */}
      {unmarked && (
        <p data-testid="gitlab-review-unmarked" className="text-[11px] text-text-faint">
          {unmarked}
        </p>
      )}
      {props.stale && (
        // A reading is of ONE commit. It is not thrown away when the branch moves — it is still the
        // best account anybody has — but a reader must not take a grouping of files that have since
        // moved for a grouping of what is on screen.
        <p
          data-testid="gitlab-review-stale"
          className="flex items-start gap-1.5 rounded-lg bg-element px-3 py-2 text-[12px] leading-relaxed text-text-dim"
        >
          <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
          This reading is of an earlier commit. Somebody has pushed since, so the code below may have
          moved — read it again for the branch as it stands.
        </p>
      )}
      {limits && (
        <p
          data-testid="gitlab-review-limits"
          className="text-[11px] leading-relaxed text-text-faint"
        >
          {limits}
        </p>
      )}
      {folded && (
        // What the document did NOT open with its code shown. Said once, at the top, because a
        // reader who scrolls past four folded patches without being told there is a press to make
        // will read the fold as the reading having nothing to show.
        <p
          data-testid="gitlab-review-folded"
          className="text-[11px] leading-relaxed text-text-faint"
        >
          {/* THE COUNT AND THE RULE BEHIND IT, and nothing else. It used to carry two more clauses
              explaining that the page opens on the words and that a press opens any of them — which
              the reader can see, from the fold beside every file. What they cannot see is that some
              of the code is folded at all, so that is what this says. */}
          {folded.folded} of {folded.total} diffs start folded — the long ones, and everything past
          the first few.
        </p>
      )}
      {/* And the rows on a RE-REVIEW too, which is the press this page's own reader makes most: a
          review that has gone stale is asked for again from here, and the document behind it means
          the offer's copy of these rows is not drawn at all. Same mapping, same component — the
          feedback belongs to the run rather than to whichever control started it. */}
      {props.progress && <ReviewRunProgressRows progress={props.progress} />}
      {props.error && <ReviewError error={props.error} />}
    </header>
  );
}

/** ONE section of the document: a theme, its prose, and the code of the files it is about. */
function ReviewSection(props: {
  group: ReviewGroup;
  index: number;
  project: string | undefined;
  theme: ResolvedTheme;
  onOpenFile: (path: string) => void;
}) {
  const { group } = props;
  const code = useCodeVocabulary();
  const summary = useMemo(
    () =>
      markReviewCode(parseGitLabMarkdown(group.summary, gitLabMarkdownOptions(props.project)), code),
    [group.summary, props.project, code],
  );
  return (
    <section
      id={reviewSectionId(props.index)}
      data-testid="gitlab-review-section"
      data-unplaced={group.unplaced ? "yes" : "no"}
      className="border-t border-border-subtle"
    >
      {/* THE STICKY HEADING. It is the one thing on screen that says which part of the branch the
          code under the reader's eye belongs to, which is the job pierre's own sticky file header
          does in the feed — one level up. It is OPAQUE rather than translucent: code sliding under a
          wash reads as a rendering fault, and this app has one accent to spend and does not spend it
          on furniture. */}
      <h2
        data-testid="gitlab-review-heading"
        className={cn(
          "sticky top-0 z-10 border-b border-border-subtle bg-background px-4 py-3 text-[15px] font-semibold md:px-6",
          // The leftovers are not a theme somebody stated, so they are not drawn as one.
          group.unplaced ? "text-text-dim" : "text-foreground",
        )}
      >
        {group.title}
      </h2>
      <div className="flex flex-col gap-5 px-4 py-5 md:px-6">
        {group.summary && (
          // The PROSE, at a readable measure. This is what the page exists for — a grouping with no
          // words is a folder — so it is set as prose and parsed as the markdown a model writes.
          // `RichNodes` renders its own element and takes no test id, so the name is on a wrapper.
          <div data-testid="gitlab-review-summary">
            <RichNodes
              nodes={summary}
              className="text-[14px] leading-relaxed text-text-dim"
            />
          </div>
        )}
        {group.files.map((entry) => (
          <ReviewFile
            // The PART's key, not the path: one file appears under several headings now, and a key
            // React re-used for two of them would carry one box's fold over to the other.
            key={reviewPartKey(entry)}
            entry={entry}
            project={props.project}
            theme={props.theme}
            onOpen={() => props.onOpenFile(entry.file.path)}
          />
        ))}
      </div>
    </section>
  );
}

/** ONE file inside a section: its name, whatever the reading said about it, and its real patch. */
function ReviewFile(props: {
  entry: ReviewGroupFile;
  project: string | undefined;
  theme: ResolvedTheme;
  onOpen: () => void;
}) {
  const { entry } = props;
  const patch = entry.patch;
  // The document's own answer for this file, and the reader's from their first press.
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? patch?.shown ?? false;
  const stat = formatDiffStat(entry.file);
  const code = useCodeVocabulary();
  const note = useMemo(
    () =>
      entry.note
        ? markReviewCode(parseGitLabMarkdown(entry.note, gitLabMarkdownOptions(props.project)), code)
        : null,
    [entry.note, props.project, code],
  );
  const notice = diffFileNotice(entry.file);
  // WHICH region of the file this box is, when it is one of several. Drawn beside the name rather
  // than instead of it: the file is still what the reader recognises, and the region is what says
  // this is not all of it.
  const region = reviewPartLabel(entry);
  return (
    <div
      data-testid="gitlab-review-file"
      data-path={entry.file.path}
      // The region this box draws, so a test and a capture can tell two boxes of one file apart —
      // and absent, rather than empty, for a box that IS the whole file: the two are different
      // claims, which is the reading `data-patch` below already takes for its three states.
      {...(entry.part ? { "data-region": `${entry.part.from}-${entry.part.to}` } : {})}
      // THREE states rather than a boolean, because "there is no code" and "the code is folded" are
      // different things and a reader acts differently on each. A two-valued `shown` conflated them,
      // and the first capture of the fold cropped to a BINARY file — which has no diff to unfold and
      // no control to unfold it with.
      data-patch={patch ? (shown ? "shown" : "folded") : "none"}
      className="flex flex-col gap-1.5"
    >
      {note && (
        // What the reading said about THIS file, above its code and set as prose: it is a remark
        // about the change rather than a label on it.
        <div data-testid="gitlab-review-note">
          <RichNodes nodes={note} className="text-[13px] leading-relaxed text-text-dim" />
        </div>
      )}
      {/* ONE box per file, whose own top bar names it. The bar is this page's rather than the
          renderer's (see `DiffFilePatch`), because it carries the FOLD — and a folded patch mounts
          no renderer, so a control inside their header would vanish exactly when it is needed.
          Folded, the box IS the bar, which is the shape a collapsed file takes everywhere. */}
      <div className="overflow-hidden rounded-lg shadow-card">
        <div
          className={cn(
            "flex items-center gap-2 bg-card px-3 py-2",
            patch && shown && "border-b border-border-subtle",
          )}
        >
          {/* The NAME is the press that opens this file in the FEED, where a patch is read at
              length. A long path gives way in the middle rather than losing the name that says
              which file it is — the rule the occurrences panel holds. */}
          <button
            type="button"
            data-testid="gitlab-review-file-open"
            data-path={entry.file.path}
            title={`Read ${entry.file.path} in the changes`}
            onClick={props.onOpen}
            className="group flex min-w-0 items-baseline gap-1 rounded text-left font-mono text-[12px]"
          >
            <span className="min-w-0 truncate text-text-faint">{parentOf(entry.file.path)}</span>
            <span className="shrink-0 font-medium text-foreground group-hover:underline">
              {nameOf(entry.file.path)}
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              className="size-3.5 shrink-0 text-transparent transition-colors group-hover:text-text-faint"
              strokeWidth={1.8}
            />
          </button>
          {/* The REGION, where this box is part of a file rather than all of it. It stands in the
              stat's place: a stat is about the whole file and would be wrong here — "+42 −8" over
              two of five hunks describes code this box is not showing. */}
          {region ? (
            <span
              data-testid="gitlab-review-region"
              className="shrink-0 font-mono text-[10px] tabular-nums text-text-faint"
            >
              {region}
            </span>
          ) : (
            stat && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-faint">
                {stat}
              </span>
            )
          )}
          {/* Why there is no code under the bar, when there is none — a binary file, a pure rename,
              one GitLab collapsed. The feed's own header note says the same thing in the same words;
              here it is the bar's, because the bar is the only header this box has. */}
          {notice && (
            <span
              data-testid="gitlab-review-file-notice"
              className="min-w-0 truncate text-[11px] text-text-faint"
            >
              {notice}
            </span>
          )}
          {patch && (
            // The fold, at the bar's right edge, which is where a box's own control belongs. It
            // states the SIZE, because that is what the reader is deciding about — and it is the one
            // control on this page whose label changes with its state, since "show" and "hide" are
            // the two things it does.
            <button
              type="button"
              data-testid="gitlab-review-fold"
              data-path={entry.file.path}
              aria-expanded={shown}
              onClick={() => setOpen(!shown)}
              className="ml-auto shrink-0 rounded text-[11px] text-text-faint transition-colors hover:text-foreground"
            >
              {shown ? "Hide the diff" : `Show the diff · ${patch.lines} lines`}
            </button>
          )}
        </div>
        {patch && shown && (
          <div data-testid="gitlab-review-patch">
            {/* One Suspense per patch rather than one for the document: the chunk is fetched once
                and every later patch resolves out of the module registry, so this costs a brief
                placeholder on the first and never blocks the PROSE — which is the half the page is
                for. */}
            <Suspense fallback={<PatchLoading lines={patch.lines} />}>
              {/* The PART's own patch when this box is a region, which is the file's patch narrowed
                  to the hunks this theme claimed — a real patch, so the renderer needs no special
                  case (see `gitlab-patch.ts`). */}
              <DiffFilePatch
                file={entry.file}
                theme={props.theme}
                {...(entry.part ? { patch: entry.part.patch } : {})}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

/** The one control that starts a run, in both of the places that offer one.
 *
 *  TWO TONES, because the same act is not the same offer twice. On an EMPTY page it is the only thing
 *  to do and nothing else on screen competes with it, so it takes the accent. On a FINISHED document
 *  it throws that document away and makes the reader wait again — so it is quiet, and stands beside
 *  the title rather than under the words: this app has one accent to spend, and spending it there
 *  made a control the loudest thing on a page whose point is the prose. */
function RunButton(props: {
  busy: boolean;
  onRun: () => void;
  label: string;
  tone?: "accent" | "quiet";
}) {
  const quiet = props.tone === "quiet";
  return (
    <button
      type="button"
      data-testid="gitlab-review-run"
      data-tone={quiet ? "quiet" : "accent"}
      disabled={props.busy}
      data-cuelume-press=""
      onClick={props.onRun}
      className={cn(
        // `active:scale-[0.97]` is the app's own press feedback (see `ui/button.tsx`): a control that
        // starts a run of minutes must answer the press in the frame it happens, and the fill alone
        // cannot say it on a quiet one. `ease-out` and 150ms are that file's numbers too.
        "flex shrink-0 items-center gap-1.5 self-start rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all duration-150 ease-out active:scale-[0.97]",
        quiet
          ? "bg-element text-text-dim hover:bg-accent hover:text-foreground"
          : "bg-primary text-primary-foreground",
        props.busy && "opacity-70",
      )}
    >
      {props.busy ? (
        <FadeArc className="size-3.5" />
      ) : (
        <HugeiconsIcon icon={SparklesIcon} className="size-3.5" strokeWidth={1.8} />
      )}
      {/* A run is tens of seconds, so the button says it is going rather than looking pressed and
          idle — the reader has no other signal that anything is happening. It says REVIEWING rather
          than reading, which is also what keeps it distinct from `ReviewLoading`'s own "Reading the
          changes…": that one is the diff coming down from GitLab, and it is the same sentence the
          Diffs page and the Overview's own summary use for that read. */}
      {props.busy ? "Reviewing the changes…" : props.label}
    </button>
  );
}

/** Why a reading did not happen, in the words the backend or the CLI used, beside the button that
 *  was pressed. The composer's own contract: an action that did not happen must never be left
 *  looking like it did. */
function ReviewError(props: { error: string }) {
  return (
    <p
      data-testid="gitlab-review-error"
      className="flex items-start gap-1.5 text-[12px] leading-relaxed text-destructive"
    >
      <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
      {props.error}
    </p>
  );
}

/** A diff that could not be read, which is a reading that cannot exist. The page has no other
 *  content, so this is the whole screen — and it offers the one thing left, GitLab's own changes. */
function ReviewFailure(props: { error: string; webUrl?: string }) {
  const href = gitlabPageUrl(props.webUrl, "diffs");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p
        data-testid="gitlab-review-diff-error"
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
          data-testid="gitlab-review-link-fallback"
          className="text-[13px] text-text-dim underline-offset-2 hover:text-foreground hover:underline"
        >
          Open the changes in GitLab
        </a>
      )}
    </div>
  );
}

function ReviewLoading(props: { label: string }) {
  return (
    <div
      data-testid="gitlab-review-loading"
      className="flex h-full flex-1 items-center justify-center p-8"
    >
      <span className="flex items-center gap-2 text-[12px] text-text-faint">
        <FadeArc className="size-3.5" />
        {props.label}
      </span>
    </div>
  );
}

/** What stands in while the highlighter's chunk is on its way.
 *
 *  It reserves ROOM out of the line count the fold already knows, so the words below a patch do not
 *  jump when the code lands — the rule a picture's own box holds (§ A picture somebody SENT: the box
 *  IS the picture), applied to code. Bounded, because a 900-line placeholder is a screen of nothing. */
function PatchLoading(props: { lines: number }) {
  const height = Math.min(props.lines, 24) * 18 + 36;
  return (
    <div
      data-testid="gitlab-review-patch-loading"
      aria-hidden
      className="animate-pulse bg-element/50"
      style={{ height }}
    />
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
