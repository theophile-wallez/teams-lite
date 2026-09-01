import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, Cancel01Icon, Loading02Icon, SentIcon } from "@hugeicons/core-free-icons";
import {
  matchReviewTags,
  MAX_REVIEW_TAG_FILES,
  reviewQuestionCanBeAsked,
  reviewTagKey,
  reviewTagLimit,
  reviewTags,
  turnContext,
  type GitLabReview,
  type GitLabReviewTurn,
  type ReviewTag,
} from "~/lib/gitlab-review";
import type { GitLabDiff } from "~/lib/gitlab-diff";
import { parseGitLabMarkdown } from "~/lib/gitlab-markdown";
import { gitLabMarkdownOptions } from "~/lib/gitlab-upload";
import { formatMessageTime } from "~/lib/message-time";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import { RichNodes } from "./rich-content";

// ASKING A FOLLOW-UP about the reading — the conversation beside the document.
//
// The reading answers "what does this branch do". The next question is always narrower, and the point
// of asking it HERE rather than in a chat is that the reader can POINT at what they mean: a theme,
// some files, and the question travels with exactly those. `web/src/lib/gitlab-review.ts` holds every
// pure decision and `src/gitlab_review.rs` the prompt, the bounds and the trust boundary.
//
// Seven rules hold it, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **It is the same RUN, narrowed.** The CLI, the provider, the model and "no tools at all" are
//     the reading's own, so the cost is the same cost and the gate is the same gate — which is why
//     what it costs is stated once, at the top of the page, rather than again here.
//   - **THE TAGS DECIDE WHAT LEAVES THE MACHINE**, and they are drawn as chips so the reader can see
//     it before pressing. A question with no tags carries the reading and no code at all.
//   - **"@" opens the list, themes above files** — the shape the composer's own "@" has for a channel
//     above the people and the providers above the personas: a short fixed list a reader learns once
//     comes first, and the growing one after it.
//   - **A refusal is reported at the BOX the words are still in**, and the words are KEPT. The
//     composer's contract: an action that did not happen must never look like it did, and a question
//     that did not reach the model must be left where the reader can press again.
//   - **A question that WORKED takes back the words and the tags**, and only then. Clearing on the
//     press would lose a question the model never saw.
//   - **The transcript is markdown**, through the same parser the reading's own prose goes through —
//     a model writes fences and backticks, and printed literally they are noise.
//   - **Every turn says what it was TOLD** (`turnContext`), from what the backend recorded rather
//     than from what the page asked for: a tagged file the diff does not hold never reached the
//     model, and a transcript claiming it did would misstate what the answer rests on.

export function ReviewChatPanel(props: {
  review: GitLabReview;
  diff: GitLabDiff;
  project: string | undefined;
}) {
  const chat = useAppState((s) => s.gitlabReviewChat);
  const asking = useAppState((s) => s.gitlabReviewAsking);
  const error = useAppState((s) => s.gitlabReviewAskError);
  const controller = useController();

  const [question, setQuestion] = useState("");
  const [tags, setTags] = useState<ReviewTag[]>([]);
  // Where the "@" that opened the list starts, or `null` for a list that is not open. It is an
  // OFFSET rather than a boolean because what is typed after it is the query.
  const [trigger, setTrigger] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  const all = useMemo(() => reviewTags(props.review, props.diff), [props.review, props.diff]);
  const picked = useMemo(() => new Set(tags.map(reviewTagKey)), [tags]);
  const query = trigger === null ? "" : question.slice(trigger + 1);
  const matches = useMemo(
    () => (trigger === null ? [] : matchReviewTags(all, query, picked)),
    [trigger, all, query, picked],
  );
  const limit = reviewTagLimit(tags);

  // The newest answer, once it lands. A conversation is read from the bottom, so a turn arriving
  // above the fold is one the reader has to go looking for.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat.turns.length]);

  const pick = (tag: ReviewTag) => {
    // The chip carries the tag; the "@…" that opened the list is taken back out of the words,
    // because the tag is not part of the question's own text.
    if (trigger !== null) setQuestion(question.slice(0, trigger));
    setTrigger(null);
    setActive(0);
    // A file past the bound is refused HERE rather than dropped by the send, which is what makes
    // `reviewTagLimit`'s sentence honest.
    const files = tags.filter((entry) => entry.kind === "file").length;
    if (tag.kind === "file" && files >= MAX_REVIEW_TAG_FILES) return;
    setTags([...tags, tag]);
    field.current?.focus();
  };

  const ask = async () => {
    if (!reviewQuestionCanBeAsked(props.review, question) || asking) return;
    const asked = question;
    const sent = tags;
    const ok = await controller.askGitLabReview(asked, sent);
    // Cleared only once the turn is really there. The words are the reader's until then — the
    // composer's own rule, and what makes a refused question one press from being asked again.
    if (!ok) return;
    setQuestion((current) => (current === asked ? "" : current));
    setTags((current) => (current === sent ? [] : current));
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
        {chat.turns.length === 0 ? (
          <p
            data-testid="gitlab-review-chat-empty"
            className="max-w-prose text-[12px] leading-relaxed text-text-faint"
          >
            {/* ONE sentence, and it is the one fact the reader needs before they type: what they tag
                is what leaves the machine. It was a paragraph and took a QUARTER of a phone screen
                for a hint, in the panel that is the feature — measured on the 390px capture. What a
                question with no tags does is left to the answer's own context line to say. */}
            Type <span className="font-medium text-text-dim">@</span> to point at a theme or a file —
            what you tag is what travels with the question.
          </p>
        ) : (
          <ul className="flex flex-col gap-5">
            {chat.turns.map((turn, index) => (
              <li key={`${turn.asked_ms}:${index}`}>
                <ReviewTurn turn={turn} review={props.review} project={props.project} />
              </li>
            ))}
          </ul>
        )}
        {asking && (
          <p
            data-testid="gitlab-review-chat-asking"
            className="mt-4 flex items-center gap-1.5 text-[12px] text-text-faint"
          >
            <HugeiconsIcon icon={Loading02Icon} className="size-3.5 animate-spin" strokeWidth={1.6} />
            Reading it again for that…
          </p>
        )}
        <div ref={end} />
      </div>

      <div className="shrink-0 border-t border-border-subtle px-4 py-3 md:px-5">
        {tags.length > 0 && (
          // WHAT WILL TRAVEL, before the press. This is the whole reason the tags are chips rather
          // than a syntax inside the words: the reader can see what leaves the machine.
          <ul data-testid="gitlab-review-chat-tags" className="mb-2 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <li key={reviewTagKey(tag)}>
                <button
                  type="button"
                  data-testid="gitlab-review-chat-tag"
                  data-kind={tag.kind}
                  title={`Do not send ${tag.label} with this question`}
                  onClick={() => setTags(tags.filter((entry) => entry !== tag))}
                  className={cn(
                    "flex max-w-[16rem] items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]",
                    tag.kind === "theme"
                      ? "bg-primary/10 text-primary"
                      : "bg-element font-mono text-text-dim",
                  )}
                >
                  <span className="min-w-0 truncate">{tag.label}</span>
                  <HugeiconsIcon icon={Cancel01Icon} className="size-3 shrink-0" strokeWidth={2} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {limit && (
          <p data-testid="gitlab-review-chat-limit" className="mb-2 text-[11px] text-text-faint">
            {limit}
          </p>
        )}
        <div className="relative">
          {matches.length > 0 && (
            // Over the field rather than under it, because the field is at the foot of a column: a
            // list below it would be off the bottom of the screen.
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
              const caret = event.target.selectionStart ?? next.length;
              const at = next.lastIndexOf("@", Math.max(caret - 1, 0));
              const opens = at === 0 || (at > 0 && /\s/.test(next[at - 1]!));
              const run = at >= 0 ? next.slice(at + 1, caret) : "";
              setTrigger(at >= 0 && opens && !/\s/.test(run) ? at : null);
              setActive(0);
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
            className="w-full resize-none rounded-lg bg-element px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-text-faint"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            data-testid="gitlab-review-chat-ask"
            disabled={asking || !reviewQuestionCanBeAsked(props.review, question)}
            data-cuelume-press=""
            onClick={() => void ask()}
            className={cn(
              "flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity",
              (asking || !reviewQuestionCanBeAsked(props.review, question)) && "opacity-50",
            )}
          >
            <HugeiconsIcon
              icon={asking ? Loading02Icon : SentIcon}
              className={cn("size-3.5", asking && "animate-spin")}
              strokeWidth={1.8}
            />
            Ask
          </button>
          <span className="text-[11px] text-text-faint">Enter asks · Shift+Enter is a new line</span>
        </div>
        {error && (
          // At the box the words are still in, which is the composer's own contract: a question that
          // did not reach the model must never look like it did, and it is one press from being
          // asked again because the words are still there.
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

/** ONE question and its answer. */
function ReviewTurn(props: {
  turn: GitLabReviewTurn;
  review: GitLabReview;
  project: string | undefined;
}) {
  const { turn } = props;
  const answer = useMemo(
    () => parseGitLabMarkdown(turn.answer, gitLabMarkdownOptions(props.project)),
    [turn.answer, props.project],
  );
  const context = turnContext(turn, props.review);
  return (
    <div data-testid="gitlab-review-turn" className="flex flex-col gap-1.5">
      <p className="text-[13px] font-medium leading-relaxed text-foreground">{turn.question}</p>
      {context && (
        // WHAT IT WAS TOLD, from what the backend recorded: a tagged file the diff does not hold
        // never reached the model, so this is the one honest account of what the answer rests on.
        <p
          data-testid="gitlab-review-turn-context"
          className="text-[11px] text-text-faint"
          title="What travelled with this question"
        >
          {context}
        </p>
      )}
      <div data-testid="gitlab-review-turn-answer">
        <RichNodes nodes={answer} className="text-[13px] leading-relaxed text-text-dim" />
      </div>
      <p className="text-[10px] text-text-faint">{formatMessageTime(turn.asked_ms)}</p>
    </div>
  );
}
