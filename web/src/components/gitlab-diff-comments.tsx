import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Edit02Icon, Loading02Icon, SentIcon } from "@hugeicons/core-free-icons";
import {
  diffCommentTargetLabel,
  diffThreadLabel,
  noteWasEdited,
  threadResolveAction,
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
//   - **A comment of the user's OWN can be REWRITTEN or deleted from here**, which is what makes
//     writing one from this page acceptable at all (see AGENTS.md § The trackers). The deletion
//     asks twice and the edit once — where a Teams message edit sits, because an edit can be
//     edited back while a deletion cannot — and the backend re-reads whose comment it is before
//     either one.
//   - **A thread is RESOLVED from its own card**, one press either way, and a resolved one is
//     drawn folded: that is what GitLab's own diff does, and a settled objection has no claim on
//     two centimetres of somebody's code. The reader's own press wins over the fold from then on.

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

/** One thread already hanging on a line: its comments, the reply into it, and the resolution
 *  that settles it.
 *
 *  **A RESOLVED thread is drawn folded**, which is what GitLab's own diff does and what keeps a
 *  settled objection from taking two centimetres of somebody's code. The fold is a default and
 *  not a rule: the reader's own press wins from then on, so opening one to read what was said
 *  survives the next resolution of another thread. It is the discipline the agent transcript's
 *  own fold follows. */
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
  const resolve = threadResolveAction(thread);
  // `null` means "however the thread stands"; a boolean is the reader's own answer, and it
  // stays theirs. Keyed on nothing, because a thread's card is remounted on every pass of the
  // patch: what is kept per thread is only what the STORE holds, and a fold is not that.
  const [opened, setOpened] = useState<boolean | null>(null);
  const open = opened ?? !thread.resolved;

  return (
    <AnnotationCard
      testId="gitlab-diff-thread"
      data={{
        "data-discussion": thread.discussionId,
        "data-lines": diffThreadLabel(thread),
        "data-resolved": thread.resolved ? "true" : undefined,
        "data-open": open ? "true" : undefined,
      }}
    >
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium text-text-dim">{diffThreadLabel(thread)}</p>
        {thread.resolved && (
          <span
            data-testid="gitlab-diff-thread-resolved"
            className="rounded bg-primary/12 px-1.5 py-px text-[10px] font-medium text-primary"
          >
            resolved
          </span>
        )}
        {/* A folded thread says how much is behind the fold, because "resolved" alone does not
            say whether anybody answered. */}
        {!open && (
          <button
            type="button"
            data-testid="gitlab-diff-thread-open"
            onClick={() => setOpened(true)}
            className="text-[11px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
          >
            {thread.notes.length === 1 ? "Show 1 comment" : `Show ${thread.notes.length} comments`}
          </button>
        )}
        {resolve && (
          <button
            type="button"
            data-testid="gitlab-diff-thread-resolve"
            data-resolves={resolve.resolved ? "true" : "false"}
            disabled={busy}
            title={resolve.hint}
            data-cuelume-press=""
            onClick={() => {
              // The reader's own fold goes back to following the thread: they have just said
              // what this thread's state is, and the fold is that state's own consequence.
              setOpened(null);
              void controller.setGitLabDiffThreadResolved(thread.discussionId, resolve.resolved);
            }}
            className="ml-auto shrink-0 rounded px-1.5 py-px text-[10px] text-text-faint transition-colors hover:bg-element hover:text-text-dim"
          >
            {resolve.label}
          </button>
        )}
      </div>
      {open &&
        thread.notes.map((note) => (
          <DiffNote key={note.id} note={note} discussionId={thread.discussionId} />
        ))}

      {!open ? null : reply === null ? (
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
  // `null` while the comment is being read; a string while it is being REWRITTEN. It starts as
  // the words that are there, because an edit is a change to them and not a blank page.
  const [draft, setDraft] = useState<string | null>(null);

  const save = () => {
    if (draft === null || draft.trim() === "" || busy) return;
    // The box closes only when the rewrite LANDED — the contract every other box on this page
    // holds: a refusal keeps the words the reader typed.
    void controller.editGitLabDiffComment(note.id, draft, props.discussionId).then((edited) => {
      if (edited) setDraft(null);
    });
  };

  return (
    <div
      data-testid="gitlab-diff-note"
      data-note={note.id}
      data-mine={note.mine ? "true" : undefined}
      data-editing={draft === null ? undefined : "true"}
    >
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
        {/* The words on screen are not the words the thread replied to, so the comment says so
            — the honesty a Teams message's own "Edited" mark carries. */}
        {noteWasEdited(note) && (
          <span data-testid="gitlab-diff-note-edited" className="shrink-0 text-[10px] text-text-faint">
            edited
          </span>
        )}

        {/* What the user may do to their OWN comment, and nothing offered on anybody else's:
            rewrite it, or take it back. The backend re-reads whose it is before either. */}
        {note.mine && draft === null && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="gitlab-diff-note-edit"
              disabled={busy}
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
                "flex items-center gap-1 rounded px-1.5 py-px text-[10px] transition-colors",
                armed ? "bg-destructive/12 text-destructive" : "text-text-faint hover:text-text-dim",
              )}
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-3" strokeWidth={1.8} />
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
            data-testid="gitlab-diff-note-edit-input"
            value={draft}
            rows={3}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
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
              data-testid="gitlab-diff-note-edit-save"
              disabled={draft.trim() === "" || busy}
              data-cuelume-press=""
              onClick={save}
              className={cn(
                "flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground transition-opacity",
                (draft.trim() === "" || busy) && "opacity-50",
              )}
            >
              <HugeiconsIcon
                icon={busy ? Loading02Icon : Edit02Icon}
                className={cn("size-3.5", busy && "animate-spin")}
                strokeWidth={1.8}
              />
              Save
            </button>
            <button
              type="button"
              data-testid="gitlab-diff-note-edit-cancel"
              onClick={() => setDraft(null)}
              className="text-[12px] text-text-faint underline-offset-2 hover:text-text-dim hover:underline"
            >
              Cancel
            </button>
            {/* An edit cannot empty a comment: that is a deletion, which asks first and is one
                control to the right. Said here rather than after a refusal. */}
            <p className="ml-auto text-[10px] text-text-faint">
              {draft.trim() === "" ? "Delete it instead of emptying it" : "The old words are gone"}
            </p>
          </div>
        </div>
      )}
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
