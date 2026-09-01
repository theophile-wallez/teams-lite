import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, SentIcon } from "@hugeicons/core-free-icons";
import {
  drawnReviewTurns,
  matchReviewTags,
  reviewQuestionCanBeAsked,
  reviewTagKey,
  reviewTagLimit,
  reviewTags,
  reviewTagsInText,
  reviewTagText,
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

// ASKING A FOLLOW-UP about the reading — the conversation beside the document.
//
// The reading answers "what does this branch do". The next question is always narrower, and the point
// of asking it HERE rather than in a chat is that the reader can POINT at what they mean: a theme,
// some files, and the question travels with exactly those. `web/src/lib/gitlab-review.ts` holds every
// pure decision and `src/gitlab_review.rs` the prompt, the bounds and the trust boundary.
//
// Nine rules hold it, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **It is the same RUN, narrowed.** The CLI, the provider, the model and "no tools at all" are
//     the reading's own, so the cost is the same cost and the gate is the same gate — which is why
//     what it costs is stated once, at the top of the page, rather than again here.
//   - **A TAG IS WORDS IN THE QUESTION, never a chip beside it** (`reviewTagText`,
//     `reviewTagsInText`). That is the shape every other "@" in this app takes — `@claude` is read
//     back out of a message's own words, and so is a tracker reference — and it is what the chips
//     above the field were replaced by: they were a second place the same fact lived, they could not
//     be edited with the caret, and they pushed the box down. A file is written bare
//     (`@src/server/health.ts`) and a THEME takes the bracket form this app already uses for a name
//     with spaces in it (`@[A replica is drained…]`).
//   - **THE QUESTION IS DRAWN THE MOMENT IT LEAVES**, in its own bubble, with the words gone from the
//     box (`gitlabReviewPending`). A run is tens of seconds, so a composer that swallows the words
//     and shows nothing until the answer lands looks like one that lost them — the rule
//     `chessPending` already holds for a move. The words are never in neither place.
//   - **A publish that FAILED takes the bubble back and hands the words back**, beside the reason.
//     The composer's contract read through the optimistic draw: a question that did not reach the
//     model must end up where the reader can press again.
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
  // Where the "@" that opened the list starts, or `null` for a list that is not open. It is an
  // OFFSET rather than a boolean because what is typed after it is the query.
  const [trigger, setTrigger] = useState<number | null>(null);
  // Where the CARET was when the trigger was measured. The query is what stands between the two, so
  // this cannot be read off the text: with the query taken to the END instead, picking a tag deleted
  // every word after the caret and the list matched against the whole tail — so a reader going back
  // to add a tag mid-sentence lost the rest of their question.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  const all = useMemo(() => reviewTags(props.review, props.diff), [props.review, props.diff]);
  // WHAT THE QUESTION NAMES, read out of its own words — so what the reader sees in the sentence and
  // what travels are one fact rather than two.
  const tags = useMemo(() => reviewTagsInText(question, all), [question, all]);
  const picked = useMemo(() => new Set(tags.map(reviewTagKey)), [tags]);
  const query = trigger === null ? "" : question.slice(trigger + 1, caret);
  const matches = useMemo(
    () => (trigger === null ? [] : matchReviewTags(all, query, picked)),
    [trigger, all, query, picked],
  );
  const limit = reviewTagLimit(tags);
  const turns = useMemo(() => drawnReviewTurns(chat, pending), [chat, pending]);

  // The newest turn, once it lands — the reader's own question included, which is the moment the
  // words leave the box. A conversation is read from the bottom, so a turn arriving above the fold is
  // one they have to go looking for.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length]);

  const pick = (tag: ReviewTag) => {
    if (trigger === null) return;
    // The tag goes INTO the words, in place of the "@…" that opened the list, with a space after it
    // so the sentence carries on. Nothing is kept beside the field.
    const before = question.slice(0, trigger);
    const after = question.slice(trigger + 1 + query.length);
    // A space AFTER it, so the reader carries straight on typing — and NOT a second one when the text
    // already has one there, which is what a pick in the middle of a sentence has in front of it. At
    // the END of the text there is nothing following, so the space is wanted.
    const spaced = after.startsWith(" ") ? "" : " ";
    const inserted = `${reviewTagText(tag)}${spaced}`;
    setQuestion(`${before}${inserted}${after}`);
    setTrigger(null);
    setActive(0);
    // The caret goes after what was inserted, or the next thing typed lands before it — and the state
    // follows, so the next "@" measures its query from the right place.
    const next = before.length + inserted.length;
    setCaret(next);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next, next);
    });
  };

  const ask = async () => {
    if (!reviewQuestionCanBeAsked(props.review, question) || asking) return;
    const asked = question;
    const sent = tags;
    // THE BOX IS CLEARED ON THE PRESS, because the words are drawn as a bubble in the same frame
    // (`gitlabReviewPending`). They are never in neither place.
    setQuestion("");
    setTrigger(null);
    const ok = await controller.askGitLabReview(asked, sent);
    if (ok) return;
    // A publish that failed hands the words BACK, beside the reason — unless the reader has written
    // something new meanwhile, which is the rule `removeSentWords` holds for a draft that was
    // rewritten while a send travelled: their words win over ours.
    setQuestion((current) => (current === "" ? asked : current));
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
                <ReviewTurn turn={turn} review={props.review} project={props.project} />
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
          {matches.length > 0 && (
            // Over the box rather than under it, because the box is at the foot of a column: a list
            // below would be off the bottom of the screen.
            <ul
              data-testid="gitlab-review-chat-list"
              className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto rounded-lg bg-card p-1 shadow-card"
            >
              {matches.map((tag, index) => (
                <li key={reviewTagKey(tag)}>
                  <button
                    type="button"
                    data-testid="gitlab-review-chat-option"
                    data-kind={tag.kind}
                    data-active={index === active ? "yes" : "no"}
                    // `mousemove` rather than `mouseenter`: this list opens right over the field the
                    // reader just clicked, so a row appearing under a STATIONARY cursor would take
                    // the active row away from the keyboard — the defect both composer typeaheads
                    // were fixed for.
                    onMouseMove={() => setActive(index)}
                    onClick={() => pick(tag)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                      index === active ? "bg-accent" : "",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-px text-[10px]",
                        tag.kind === "theme"
                          ? "bg-primary/10 text-primary"
                          : "bg-element text-text-faint",
                      )}
                    >
                      {tag.kind === "theme" ? "theme" : "file"}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        tag.kind === "file" ? "font-mono text-text-dim" : "text-foreground",
                      )}
                    >
                      {tag.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={field}
            data-testid="gitlab-review-chat-field"
            value={question}
            rows={2}
            placeholder="Ask about a theme or a file…"
            onChange={(event) => {
              const next = event.target.value;
              setQuestion(next);
              // The list is open while the caret is in a run of non-whitespace after an "@" that
              // opens the text or follows whitespace — the rule the emoji and mention typeaheads
              // hold, so `note@example` and an "@" in the middle of a word open nothing.
              const where = event.target.selectionStart ?? next.length;
              const at = next.lastIndexOf("@", Math.max(where - 1, 0));
              const opens = at === 0 || (at > 0 && /\s/.test(next[at - 1]!));
              const run = at >= 0 ? next.slice(at + 1, where) : "";
              setTrigger(at >= 0 && opens && !/\s/.test(run) ? at : null);
              setCaret(where);
              setActive(0);
            }}
            onSelect={(event) => {
              // A click or an arrow moves the caret with no change to the text. A list measured
              // against the OLD position would then match the wrong run, so it closes: the reader
              // types to open one again, which is what the "@" already means.
              const where = (event.target as HTMLTextAreaElement).selectionStart ?? 0;
              if (trigger !== null && where !== caret) setTrigger(null);
              setCaret(where);
            }}
            onKeyDown={(event) => {
              if (matches.length > 0) {
                // While the list is open the next key belongs to it — the rule the emoji typeahead
                // holds, including that ESCAPE is the way out and leaves the "@" as text.
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => (index + 1) % matches.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => (index - 1 + matches.length) % matches.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  pick(matches[active] ?? matches[0]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setTrigger(null);
                  return;
                }
              }
              // Enter asks; Shift+Enter is a new line, which is how every multi-line box in this app
              // behaves.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            }}
            className="w-full resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-text-faint"
          />
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
          {turn.question}
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
