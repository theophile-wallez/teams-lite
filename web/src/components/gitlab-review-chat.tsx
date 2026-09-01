import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, SentIcon } from "@hugeicons/core-free-icons";
import {
  drawnReviewTurns,
  reviewQuestionCanBeAsked,
  reviewQuestionParts,
  reviewTagKey,
  reviewTagLimit,
  reviewTags,
  reviewTagsInText,
  turnContext,
  type DrawnReviewTurn,
  type GitLabReview,
  type ReviewTag,
} from "~/lib/gitlab-review";
import type { GitLabDiff } from "~/lib/gitlab-diff";
import { parseGitLabMarkdown } from "~/lib/gitlab-markdown";
import { markReviewCode } from "~/lib/gitlab-review-code";
import { gitLabMarkdownOptions } from "~/lib/gitlab-upload";
import { useCodeVocabulary } from "./review-code-context";
import { formatMessageTime } from "~/lib/message-time";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { FadeArc } from "./loading-ui/fade-arc";
import { RichNodes } from "./rich-content";
import { ReviewTagChip } from "./review-tag-chip";
import type { ReviewQuestionHandle } from "./review-question-editor";

/** The question's own FIELD, out of a lazy chunk.
 *
 *  It is TipTap, which is the app's own editor and a chunk of its own — the main composer loads it
 *  the same way and for the same reason (`composer.tsx`). Nothing on this page waits for it: the
 *  document, the transcript and every answer render while it is on its way, and what stands in
 *  meanwhile is a box of the same height (`QuestionFieldPlaceholder`), so the composer does not jump
 *  when it arrives. */
const ReviewQuestionEditor = lazy(() =>
  import("./review-question-editor").then((m) => ({ default: m.ReviewQuestionEditor })),
);

// ASKING A FOLLOW-UP about the reading — the conversation beside the document.
//
// The reading answers "what does this branch do". The next question is always narrower, and the point
// of asking it HERE rather than in a chat is that the reader can POINT at what they mean: a theme,
// some files, and the question travels with exactly those. `web/src/lib/gitlab-review.ts` holds every
// pure decision and `src/gitlab_review.rs` the prompt, the bounds and the trust boundary.
//
// Twelve rules hold it, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **It is the same RUN, narrowed.** The CLI, the provider, the model and "no tools at all" are
//     the reading's own, so the cost is the same cost and the gate is the same gate — which is why
//     what it costs is stated once, at the top of the page, rather than again here.
//   - **A TAG IS WORDS IN THE QUESTION, DRAWN AS A CHIP** (`reviewTagText`, `reviewQuestionParts`).
//     The words are the truth — `@src/server/health.ts`, `@[A replica is drained…]`, which is what
//     travels and what `reviewTagsInText` reads — and the chip is how those characters are drawn, in
//     the field and again in the bubble, by ONE component (`review-tag-chip.tsx`). That is the shape
//     `@claude` already has: a chip in the composer, the bare prefix on the wire, read back for the
//     thread. What it is NOT is a chip row BESIDE the field, which is what this replaced: those were
//     a second place the same fact lived, they could not be edited with the caret, and they pushed
//     the box down.
//   - **A FILE CHIP SHOWS ITS NAME, NOT ITS PATH** (`reviewTagLabel`). Measured on this instance a
//     path runs to `tooling/ci/components/blocks/kubernetes-agent.gitlab-ci.yaml`, and a chip
//     carrying all of it is a chip the width of the composer. The whole path is in its `title`, and
//     the line under a sent question names what really travelled in full.
//   - **THE QUESTION IS DRAWN THE MOMENT IT LEAVES**, in its own bubble, with the words gone from the
//     box (`gitlabReviewPending`). A run is tens of seconds, so a composer that swallows the words
//     and shows nothing until the answer lands looks like one that lost them — the rule
//     `chessPending` already holds for a move. The words are never in neither place.
//   - **A publish that FAILED takes the bubble back and hands the words back**, beside the reason,
//     with the CHIPS rebuilt by re-reading those words (`setText`) — so nothing about a handed-back
//     question is kept anywhere. The composer's contract read through the optimistic draw: a question
//     that did not reach the model must end up where the reader can press again. **The current words
//     are read from a REF** rather than from the state, because `ask` closes over the render it was
//     created in and the state it can see is the value from BEFORE the box was cleared — which made
//     the hand-back decide against itself and leave the reader an empty box beside a refusal.
//   - **THE FIELD IS THE APP'S OWN EDITOR, out of a lazy chunk**, which is what a chip whose width is
//     not its text's costs: no overlay over a `<textarea>` can shorten a run and keep the caret where
//     the reader put it. Nothing about the wire moved with it — `ReviewTagNode.renderText` emits the
//     tag's own spelling, so the question is the same string it always was.
//   - **THE FIELD GROWS WITH THE QUESTION, to eight lines**, then scrolls itself. A box two lines tall
//     hides most of a paragraph; one that grows for ever takes the conversation with it.
//   - **THE COMPOSER IS ONE BOX**, and Send is inside it — the app's own composer's shape
//     (`rounded-2xl bg-card`, a column with a control row at its foot), because two boxes for one
//     act ask the reader which is the thing they are typing into.
//   - **"@" opens the list, themes above files** — a short fixed list a reader learns once first, the
//     growing one after it. A row is activated on `mousemove`, never `mouseenter`: the list opens
//     right over the field the reader just clicked, so a row appearing under a stationary cursor
//     would take the active row away from the keyboard.
//   - **The transcript is markdown**, through the same parser the reading's own prose goes through.
//   - **Every turn says what it was TOLD** (`turnContext`), from what the backend recorded rather
//     than from what the page asked for.
//   - **THE COLUMN IS DRAGGED** and the document keeps its own minimum — see the page.

export function ReviewChatPanel(props: {
  review: GitLabReview;
  diff: GitLabDiff;
  project: string | undefined;
}) {
  const chat = useAppState((s) => s.gitlabReviewChat);
  const pending = useAppState((s) => s.gitlabReviewPending);
  const asking = useAppState((s) => s.gitlabReviewAsking);
  const error = useAppState((s) => s.gitlabReviewAskError);
  const controller = useController();

  const [question, setQuestion] = useState("");
  // The FIELD's own handle. The typeahead, the caret and the query all live inside it now, because
  // every one of them is a fact about a document position and only the editor holds those — what the
  // panel keeps is the question as WORDS, which is what it sends.
  const field = useRef<ReviewQuestionHandle | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  // The question as it stands RIGHT NOW, for `ask` to read AFTER its await.
  //
  // It is a ref rather than the state because `ask` closes over the render it was created in, so the
  // state it can see is the value from BEFORE the box was cleared — which made the failure hand-back
  // decide against itself and leave the reader with an empty box and a refusal. The textarea version
  // read the current value through `setQuestion`'s own updater form; that is not available here,
  // because restoring the words also has to rebuild the chips (`setText`) and a side effect inside a
  // state updater is one React may run twice.
  const asked = useRef("");
  asked.current = question;

  const all = useMemo(() => reviewTags(props.review, props.diff), [props.review, props.diff]);
  // WHAT THE QUESTION NAMES, read out of its own words — so what the reader sees in the sentence and
  // what travels are one fact rather than two. It is unchanged by the field becoming an editor: the
  // chips serialize to exactly the words a textarea held (`ReviewTagNode.renderText`).
  const tags = useMemo(() => reviewTagsInText(question, all), [question, all]);
  const picked = useMemo(() => new Set(tags.map(reviewTagKey)), [tags]);
  const limit = reviewTagLimit(tags);
  const turns = useMemo(() => drawnReviewTurns(chat, pending), [chat, pending]);

  // The newest turn, once it lands — the reader's own question included, which is the moment the
  // words leave the box. A conversation is read from the bottom, so a turn arriving above the fold is
  // one they have to go looking for.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length]);

  const ask = async () => {
    if (!reviewQuestionCanBeAsked(props.review, question) || asking) return;
    const words = question;
    const sent = tags;
    // THE BOX IS CLEARED ON THE PRESS, because the words are drawn as a bubble in the same frame
    // (`gitlabReviewPending`). They are never in neither place.
    setQuestion("");
    field.current?.clear();
    const ok = await controller.askGitLabReview(words, sent);
    if (ok) return;
    // A publish that failed hands the words BACK, beside the reason — unless the reader has written
    // something new meanwhile, which is the rule `removeSentWords` holds for a draft that was
    // rewritten while a send travelled: their words win over ours. The chips come back with them,
    // rebuilt by re-reading the words (`setText`), so nothing about a handed-back question is kept.
    if (asked.current !== "") return;
    setQuestion(words);
    field.current?.setText(words);
  };

  return (
    <section
      data-testid="gitlab-review-chat"
      data-turns={chat.turns.length}
      // `flex-1`, or the panel takes its CONTENT's height and the composer floats mid-column with the
      // rest of it blank — measured at 250px of empty space under the box on a 1280x850 page.
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5">
        {turns.length === 0 ? (
          <p
            data-testid="gitlab-review-chat-empty"
            className="text-[12px] leading-relaxed text-text-faint"
          >
            {/* ONE sentence, and it is the one fact the reader needs before they type: what they tag
                is what leaves the machine. */}
            Type <span className="font-medium text-text-dim">@</span> to point at a theme or a file —
            what you tag is what travels with the question.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {turns.map((turn, index) => (
              <li key={`${turn.asked_ms}:${index}`}>
                <ReviewTurn
                  turn={turn}
                  review={props.review}
                  tags={all}
                  project={props.project}
                />
              </li>
            ))}
          </ul>
        )}
        <div ref={end} />
      </div>

      <div className="shrink-0 px-3 pb-3 md:px-4">
        {limit && (
          <p data-testid="gitlab-review-chat-limit" className="mb-2 text-[11px] text-text-faint">
            {limit}
          </p>
        )}
        {/* ONE BOX, and Send is inside it — the app's own composer's shape (see `composer.tsx`): a
            column holding the field and then a control row at its foot, on one surface with one focus
            ring. Two boxes for one act ask the reader which of them they are typing into. */}
        <div
          className="relative flex cursor-text flex-col gap-1.5 rounded-2xl bg-card px-3 py-2.5 shadow-chip transition-shadow focus-within:shadow-card"
          // `cursor-text` promises the whole box types, so a press anywhere in it that is not a
          // control puts the caret in the field — the app's own composer wires exactly this, and the
          // class without the handler is a padding frame that says "type here" and does nothing.
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            field.current?.focus();
          }}
        >
          {/* THE FIELD, and the "@" list it opens — both the editor's, because a query is a fact
              about the caret. What stands in while its chunk arrives is a box of the same height, so
              the composer does not jump when it lands. */}
          <Suspense fallback={<QuestionFieldPlaceholder />}>
            <ReviewQuestionEditor
              handle={field}
              tags={all}
              picked={picked}
              placeholder="Ask about a theme or a file…"
              onChangeText={setQuestion}
              onSubmit={() => void ask()}
            />
          </Suspense>
          {/* The control row, at the box's own foot. Send is a round button at the right, which is
              where the app's own composer puts it. */}
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-text-faint">
              Enter asks · Shift+Enter is a new line
            </span>
            <button
              type="button"
              data-testid="gitlab-review-chat-ask"
              aria-label="Ask about the changes"
              title="Ask about the changes"
              disabled={asking || !reviewQuestionCanBeAsked(props.review, question)}
              data-cuelume-press=""
              onClick={() => void ask()}
              className={cn(
                "grid size-8 shrink-0 cursor-pointer place-items-center rounded-full transition-all disabled:cursor-default",
                asking || !reviewQuestionCanBeAsked(props.review, question)
                  ? "bg-element text-text-faint"
                  : "bg-primary text-primary-foreground shadow-chip hover:brightness-110 active:brightness-95",
              )}
            >
              {asking ? (
                <FadeArc className="size-4" />
              ) : (
                <HugeiconsIcon icon={SentIcon} className="size-4" strokeWidth={1.8} />
              )}
            </button>
          </div>
        </div>
        {error && (
          // At the box the words are back in, which is the composer's own contract: a question that
          // did not reach the model must never look like it did, and it is one press from being asked
          // again because the words were handed back.
          <p
            data-testid="gitlab-review-chat-error"
            className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-destructive"
          >
            <HugeiconsIcon icon={Alert02Icon} className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/** ONE question and its answer, each in its own bubble.
 *
 *  The reader's own question is drawn on the RIGHT in the accent fill and the answer on the LEFT on a
 *  plain surface, which is the shape a conversation takes everywhere in this app — and it is what
 *  makes a question that has just left legible as the reader's rather than as a heading over an empty
 *  space. A question whose answer is still on its way says so where the answer will be. */
function ReviewTurn(props: {
  turn: DrawnReviewTurn;
  review: GitLabReview;
  /** Everything a question could have been tagged with, so its own words can be read back into chips.
   *  A tag the reading no longer holds — a fresh reading renamed its theme, a push removed its file —
   *  stays the words it is, which is the rule an @mention naming a person the thread does not hold
   *  already follows. */
  tags: ReviewTag[];
  project: string | undefined;
}) {
  const { turn } = props;
  const code = useCodeVocabulary();
  // An ANSWER is prose about the same code the document is about, so a name in one is marked by the
  // same rules — the fourth and last of the memos that do it (see review-code-context.tsx). It costs
  // nothing where there is no diff: the vocabulary is empty and `markReviewCode` hands the tree back.
  const answer = useMemo(
    // BOTH sides of the rebase: a turn whose answer has not landed yet draws nothing (a question is
    // drawn the moment it leaves, so `turn.answer` is empty while the run is out), and one that HAS
    // landed is marked like every other piece of this page's prose.
    () =>
      turn.answer
        ? markReviewCode(parseGitLabMarkdown(turn.answer, gitLabMarkdownOptions(props.project)), code)
        : null,
    [turn.answer, props.project, code],
  );
  const context = turnContext(turn, props.review);
  return (
    <div
      data-testid="gitlab-review-turn"
      data-answered={turn.answer ? "yes" : "no"}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-col items-end gap-0.5">
        <p
          data-testid="gitlab-review-turn-question"
          className="max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground"
        >
          {/* THE SAME CHIPS THE FIELD DREW, from the same walk over the same words — so what the
              reader pointed at is legible in the message as well as in the box, and a question is not
              a paragraph of raw paths. `onAccent`, because this bubble IS the accent fill: the tint
              is a property of the surface rather than of the tag (§ A CHIP IS TINTED FOR THE SURFACE
              IT LANDS ON). */}
          <ReviewQuestionText question={turn.question} tags={props.tags} />
        </p>
        {context && (
          // WHAT IT WAS TOLD, from what the backend recorded: a tagged file the diff does not hold
          // never reached the model, so this is the one honest account of what the answer rests on.
          <p
            data-testid="gitlab-review-turn-context"
            className="max-w-[92%] truncate text-[10px] text-text-faint"
            title="What travelled with this question"
          >
            {context}
          </p>
        )}
      </div>
      {answer ? (
        <div
          data-testid="gitlab-review-turn-answer"
          className="rounded-2xl rounded-bl-md bg-element px-3 py-2"
        >
          <RichNodes nodes={answer} className="text-[13px] leading-relaxed text-text-dim" />
          <p className="mt-1 text-[10px] text-text-faint">{formatMessageTime(turn.asked_ms)}</p>
        </div>
      ) : (
        // The answer's own place, saying it is on its way — rather than a spinner somewhere else on
        // the panel, which would leave the question looking like it had been swallowed.
        <p
          data-testid="gitlab-review-chat-asking"
          className="flex items-center gap-1.5 self-start rounded-2xl rounded-bl-md bg-element px-3 py-2 text-[12px] text-text-faint"
        >
          <FadeArc className="size-3.5" />
          Reading it again for that…
        </p>
      )}
    </div>
  );
}

/**
 * One question's words, with its tagged themes and files drawn as CHIPS.
 *
 * It is the read half of the composer's own node: the field turns a chip into words
 * (`ReviewTagNode.renderText`) and this turns words back into chips, both over the one walk
 * (`reviewQuestionParts`). So a question written by hand, one built by picking and one handed back
 * after a failure all draw the same thing — and a tag the reading no longer holds stays the words it
 * is rather than becoming a chip naming nothing.
 *
 * The runs keep their own newlines, because the bubble is `whitespace-pre-wrap`: a reader who pressed
 * Shift+Enter meant a line to be there.
 */
function ReviewQuestionText(props: { question: string; tags: ReviewTag[] }) {
  const parts = useMemo(
    () => reviewQuestionParts(props.question, props.tags),
    [props.question, props.tags],
  );
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <ReviewTagChip key={index} tag={part.tag} onAccent />
        ),
      )}
    </>
  );
}

/**
 * What stands in the composer while the field's own chunk is on its way.
 *
 * It reserves the height an EMPTY field has, so the box does not jump when the editor lands — the
 * rule the app's own composer holds for exactly this swap (`COMPOSER_FIELD_CLASS`, shared between the
 * placeholder and the editor so the two cannot disagree). It carries the placeholder's own words too,
 * because a blank box for a moment reads as one that failed to load.
 */
function QuestionFieldPlaceholder() {
  return (
    <p
      data-testid="gitlab-review-chat-field-placeholder"
      aria-hidden
      // Two lines at the field's own metrics — `text-[13px] leading-5`, which is where `LINE_PX`
      // comes from.
      className="min-h-10 text-[13px] leading-5 text-text-faint"
    >
      Ask about a theme or a file…
    </p>
  );
}
