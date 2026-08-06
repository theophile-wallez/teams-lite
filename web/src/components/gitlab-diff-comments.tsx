import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Loading02Icon, SentIcon } from "@hugeicons/core-free-icons";
import {
  diffCommentTargetLabel,
  diffThreadLabel,
  type DiffCommentTarget,
  type DiffThread,
} from "~/lib/gitlab-diff-comment";
import { parseGitLabMarkdown } from "~/lib/gitlab-markdown";
import { personFace } from "~/lib/tracker-people";
import { cn } from "~/lib/utils";
import type { GitLabNote } from "~/lib/gitlab-mr";
import { Avatar } from "./avatar";
import { useAppState, useController } from "./controller-context";
import { RichNodes } from "./rich-content";

// What hangs UNDER a line of a diff: a thread that is already there, and the box for one being
// written. Both are drawn into `@pierre/diffs`' own annotation slot — which is ordinary light
// DOM, so this app's styles apply to it exactly as anywhere else (see gitlab-diff-view.tsx for
// the seam).
//
// Three rules hold this surface, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **The composer is where the code is.** A comment about line 42 is written under line 42,
//     because the one thing a reviewer needs while writing it is the line — and a box docked at
//     the foot of the page would take the code off a phone's screen to make room for itself.
//   - **A comment that FAILED says so at the box**, beside the words that are still in it. The
//     rule § Sending messages states for the chat composer, and the reason this page carries an
//     error of its own rather than the merge request's: a refusal shown on a page the reader is
//     not looking at is a refusal nobody reads.
//   - **A comment of the user's OWN can be deleted from here**, which is what makes writing one
//     from this page acceptable at all (see AGENTS.md § The trackers). It asks twice, and the
//     backend re-reads whose comment it is before it deletes.

/** The box for a comment being written on a line, or on the range the reader dragged over. */
export function DiffLineComposer(props: { target: DiffCommentTarget }) {
  const controller = useController();
  const draft = useAppState((s) => s.gitlabDiffCommentDraft);
  const busy = useAppState((s) => s.gitlabDiffCommentBusy);
  // Only a failure of THIS box. A refusal that belongs to a thread's reply is drawn in that
  // thread, because that is where the reader wrote the words.
  const error = useAppState((s) =>
    s.gitlabDiffCommentError && s.gitlabDiffCommentError.thread === null
      ? s.gitlabDiffCommentError.message
      : null,
  );
  const empty = draft.trim() === "";

  return (
    <AnnotationCard testId="gitlab-diff-composer" data={{ "data-lines": diffCommentTargetLabel(props.target) }}>
      <div className="flex items-baseline gap-2">
        <p className="text-[11px] font-medium text-text-dim">{diffCommentTargetLabel(props.target)}</p>
        <p className="min-w-0 truncate font-mono text-[10px] text-text-faint">{props.target.path}</p>
      </div>
      <textarea
        data-testid="gitlab-diff-comment-input"
        value={draft}
        rows={3}
        autoFocus
        placeholder="Comment on this code…"
        onChange={(event) => controller.setGitLabDiffCommentDraft(event.target.value)}
        onKeyDown={(event) => {
          // ⌘↵ / Ctrl+↵ posts and plain Enter does not: a comment is outward, and a review
          // comment is written in paragraphs. Escape closes the box — the same gesture as
          // pressing the lit line again.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!empty && !busy) void controller.postGitLabDiffComment(draft);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            controller.closeGitLabDiffComment();
          }
        }}
        className="w-full resize-y rounded-lg bg-background px-2.5 py-2 text-[13px] text-foreground ring-1 ring-inset ring-border-subtle outline-none placeholder:text-text-faint focus:ring-primary/50"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="gitlab-diff-comment-send"
          disabled={empty || busy}
          data-cuelume-press=""
          onClick={() => void controller.postGitLabDiffComment(draft)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground transition-opacity",
            (empty || busy) && "opacity-50",
          )}
        >
          <HugeiconsIcon
            icon={busy ? Loading02Icon : SentIcon}
            className={cn("size-3.5", busy && "animate-spin")}
            strokeWidth={1.8}
          />
          Comment
        </button>
        <button
          type="button"
          data-testid="gitlab-diff-comment-cancel"
          onClick={() => controller.closeGitLabDiffComment()}
          className="text-[12px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
        >
          Cancel
        </button>
        <p className="ml-auto text-[10px] text-text-faint">Everybody watching is told</p>
      </div>
      <CommentError error={error} />
    </AnnotationCard>
  );
}

/** One thread already hanging on a line: its comments, and the reply into it. */
export function DiffLineThread(props: { thread: DiffThread }) {
  const thread = props.thread;
  const [reply, setReply] = useState<string | null>(null);
  const controller = useController();
  const busy = useAppState((s) => s.gitlabDiffCommentBusy);
  const error = useAppState((s) =>
    s.gitlabDiffCommentError?.thread === thread.discussionId
      ? s.gitlabDiffCommentError.message
      : null,
  );

  return (
    <AnnotationCard
      testId="gitlab-diff-thread"
      data={{
        "data-discussion": thread.discussionId,
        "data-lines": diffThreadLabel(thread),
        "data-resolved": thread.resolved ? "true" : undefined,
      }}
    >
      <div className="flex items-baseline gap-2">
        <p className="text-[11px] font-medium text-text-dim">{diffThreadLabel(thread)}</p>
        {thread.resolved && (
          <span
            data-testid="gitlab-diff-thread-resolved"
            className="rounded bg-primary/12 px-1.5 py-px text-[10px] font-medium text-primary"
          >
            resolved
          </span>
        )}
      </div>
      {thread.notes.map((note) => (
        <DiffNote key={note.id} note={note} discussionId={thread.discussionId} />
      ))}

      {reply === null ? (
        <button
          type="button"
          data-testid="gitlab-diff-thread-reply"
          onClick={() => setReply("")}
          className="self-start text-[11px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
        >
          Reply in this thread
        </button>
      ) : (
        <>
          <textarea
            data-testid="gitlab-diff-reply-input"
            value={reply}
            rows={2}
            autoFocus
            placeholder="Reply in this thread…"
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (reply.trim() !== "" && !busy) {
                  // The box closes only when the reply LANDED: a refusal keeps the words, like
                  // the composer above and like the chat composer before both.
                  void controller
                    .postGitLabDiffComment(reply, thread.discussionId)
                    .then((posted) => {
                      if (posted) setReply(null);
                    });
                }
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setReply(null);
              }
            }}
            className="w-full resize-y rounded-lg bg-background px-2.5 py-2 text-[13px] text-foreground ring-1 ring-inset ring-border-subtle outline-none placeholder:text-text-faint focus:ring-primary/50"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="gitlab-diff-reply-send"
              disabled={reply.trim() === "" || busy}
              data-cuelume-press=""
              onClick={() =>
                void controller
                  .postGitLabDiffComment(reply, thread.discussionId)
                  .then((posted) => {
                    if (posted) setReply(null);
                  })
              }
              className={cn(
                "flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground transition-opacity",
                (reply.trim() === "" || busy) && "opacity-50",
              )}
            >
              <HugeiconsIcon
                icon={busy ? Loading02Icon : SentIcon}
                className={cn("size-3.5", busy && "animate-spin")}
                strokeWidth={1.8}
              />
              Reply
            </button>
            <button
              type="button"
              data-testid="gitlab-diff-reply-cancel"
              onClick={() => setReply(null)}
              className="text-[12px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
            >
              Cancel
            </button>
          </div>
        </>
      )}
      <CommentError error={error} />
    </AnnotationCard>
  );
}

/** One comment of a thread. Its body is the same GitLab markdown the description and the
 *  merge-request page's comments go through — a review comment quotes code as often as a
 *  description does — and never GitLab's rendered HTML, which would bring remote references
 *  with it. */
function DiffNote(props: { note: GitLabNote; discussionId: string }) {
  const note = props.note;
  const controller = useController();
  const busy = useAppState((s) => s.gitlabDiffCommentBusy);
  const nodes = useMemo(() => parseGitLabMarkdown(note.body), [note.body]);
  const author = useMemo(() => personFace(note.author), [note.author]);
  const [armed, setArmed] = useState(false);

  return (
    <div data-testid="gitlab-diff-note" data-note={note.id} data-mine={note.mine ? "true" : undefined}>
      <div className="flex items-center gap-2">
        <Avatar
          seed={author.seed}
          label={author.label}
          photo={author.photo}
          initials={author.label.slice(0, 1).toUpperCase()}
          fallback="person"
          className="size-5 text-[9px]"
        />
        <span
          data-testid="gitlab-diff-note-author"
          className="min-w-0 truncate text-[12px] font-medium text-foreground"
        >
          {author.label}
        </span>
        {/* The undo that makes commenting from this page acceptable, offered where the comment
            is. It asks twice, and the backend refuses a comment that is not the user's own. */}
        {note.mine && (
          <button
            type="button"
            data-testid={armed ? "gitlab-diff-note-delete-confirm" : "gitlab-diff-note-delete"}
            disabled={busy}
            aria-label={armed ? "Confirm deleting this comment" : "Delete this comment"}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              setArmed(false);
              void controller.deleteGitLabDiffComment(note.id, props.discussionId);
            }}
            className={cn(
              "ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] transition-colors",
              armed ? "bg-destructive/12 text-destructive" : "text-text-faint hover:text-text-dim",
            )}
          >
            <HugeiconsIcon icon={Delete02Icon} className="size-3" strokeWidth={1.8} />
            {armed ? "Delete for everybody" : "Delete"}
          </button>
        )}
      </div>
      <RichNodes nodes={nodes} className="pl-7 pt-1 text-[13px] leading-relaxed text-text-dim" />
    </div>
  );
}

/** Why a comment did not go out. One sentence, beside the words that are still in the box. */
function CommentError(props: { error: string | null }) {
  if (!props.error) return null;
  return (
    <p data-testid="gitlab-diff-comment-error" className="text-[12px] text-destructive">
      {props.error}
    </p>
  );
}

/** The box either of the two above sits in.
 *
 *  It carries its own width bound (`max-w-2xl`) and wraps: the annotation is slotted into a
 *  diff whose rows SCROLL sideways, and a card that grew with the reader's words would widen
 *  the code beside it. */
function AnnotationCard(props: {
  testId: string;
  data?: Record<string, string | undefined>;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={props.testId}
      {...props.data}
      className="my-1 flex max-w-2xl flex-col gap-2 rounded-xl bg-card p-2.5 ring-1 ring-inset ring-border-subtle"
    >
      {props.children}
    </div>
  );
}
