import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Download04Icon,
  RecordIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import {
  recordingDurationLabel,
  recordingFileName,
  recordingPeopleLabel,
  recordingSizeLabel,
  recordingWhenLabel,
  type CallRecording,
} from "~/lib/call-recording";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { useController } from "./controller-context";

/**
 * A recording of a call, drawn where the call happened.
 *
 * **It is not a message, and it is drawn as one thing that is not.** No bubble, no side, no
 * sender, no reactions, no "…" menu: nothing was sent, nobody else can see it, and a card
 * that looked like a message would be this app claiming something reached the thread. It is
 * a row of the app's own, like the system lines around it — the one difference being that
 * this one holds a file.
 *
 * Three things it always says, because each is something the reader would otherwise have to
 * assume:
 *
 * - **Only they can see it.** The line under the title says so in as many words. A recording
 *   made here is teams-lite's own file; Teams was never told the call was recorded and holds
 *   nothing (see lib/call-recording.ts).
 * - **Where it is kept.** In this browser — so it is not on the user's other devices, and
 *   clearing the browser's data takes it. Save is offered beside it, which is how a recording
 *   becomes a file they really own.
 * - **What it costs.** These are the largest things this app keeps, and the only person who
 *   can decide one is no longer worth the room is the reader.
 *
 * The video is loaded LAZILY, from this browser's storage, when the card is first drawn: the
 * history is virtualized, so a conversation full of recordings must not decode all of them —
 * and a `<video>` with no `src` is a poster-sized panel rather than a hole.
 */
export function CallRecordingCard(props: { recording: CallRecording; className?: string }) {
  const { recording } = props;
  const controller = useController();
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    let alive = true;
    setMissing(false);
    void controller.recordingUrl(recording.id).then((next) => {
      if (!alive) return;
      setUrl(next);
      setMissing(next === null);
    });
    return () => {
      alive = false;
    };
  }, [controller, recording.id]);

  const people = recordingPeopleLabel(recording);

  return (
    <article
      data-testid="call-recording"
      data-recording-id={recording.id}
      data-conversation-id={recording.conversationId ?? undefined}
      className={cn(
        "mx-auto flex w-full max-w-xl flex-col gap-3 rounded-2xl bg-card p-3 shadow-chip ring-1 ring-border-subtle",
        props.className,
      )}
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive"
        >
          <HugeiconsIcon icon={RecordIcon} className="size-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">
            Recording · {recording.title}
          </h3>
          {/* The whole promise of this feature, in the one place the reader meets it. */}
          <p data-testid="call-recording-privacy" className="text-xs text-text-faint">
            Only you can see this. It is kept in this browser, and Teams was never told.
          </p>
        </div>
      </header>

      <RecordingVideo url={url} missing={missing} />

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-faint">
        <span data-testid="call-recording-duration" className="font-medium text-text-dim">
          {recordingDurationLabel(recording.durationMs)}
        </span>
        <Dot />
        <span data-testid="call-recording-size">{recordingSizeLabel(recording.size)}</span>
        <Dot />
        <span>{recordingWhenLabel(recording)}</span>
        {people && (
          <>
            <Dot />
            <span className="inline-flex min-w-0 items-center gap-1">
              <HugeiconsIcon icon={UserMultipleIcon} className="size-3 shrink-0" strokeWidth={1.8} />
              <span className="truncate">{people}</span>
            </span>
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid="call-recording-save"
          disabled={!url}
          asChild={!!url}
        >
          {url ? (
            <a href={url} download={recordingFileName(recording)}>
              <HugeiconsIcon icon={Download04Icon} />
              Save
            </a>
          ) : (
            <span>
              <HugeiconsIcon icon={Download04Icon} />
              Save
            </span>
          )}
        </Button>
        {/* Asked twice, like deleting a message — and for the sharper version of the same
            reason: there is nothing upstream to take a deletion back from, so this one is
            the whole deletion. */}
        {confirmingDelete ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              data-testid="call-recording-delete-confirm"
              onClick={() => void controller.deleteCallRecording(recording.id)}
            >
              Delete for good
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="call-recording-delete-cancel"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            data-testid="call-recording-delete"
            onClick={() => setConfirmingDelete(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
            Delete
          </Button>
        )}
      </div>
    </article>
  );
}

/** The picture itself, or the one sentence that explains its absence.
 *
 *  A recording whose file this browser no longer holds is a real state — another device made
 *  it, or the storage was cleared — and the metadata is what is left. Saying so is better
 *  than a player that will not play. */
function RecordingVideo(props: { url: string | null; missing: boolean }) {
  const element = useRef<HTMLVideoElement | null>(null);
  const { url, missing } = props;
  if (missing) {
    return (
      <p
        data-testid="call-recording-missing"
        className="rounded-xl bg-element px-3 py-6 text-center text-xs text-text-faint"
      >
        This browser no longer holds the video for this recording.
      </p>
    );
  }
  return (
    <video
      ref={element}
      data-testid="call-recording-video"
      // Controls and nothing else: no autoplay, no loop, no muted-autoplay poster trick. A
      // recording of a conversation must never start playing because somebody scrolled past
      // it — the voices in it belong to people who are not in the room.
      controls
      preload="metadata"
      playsInline
      src={url ?? undefined}
      className="aspect-video w-full rounded-xl bg-black"
    />
  );
}

function Dot() {
  return <span aria-hidden>·</span>;
}
