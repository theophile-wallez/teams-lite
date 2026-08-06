import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Download04Icon, RecordIcon } from "@hugeicons/core-free-icons";
import {
  recordingDurationLabel,
  recordingFileName,
  recordingSizeLabel,
  recordingWhenLabel,
  recordingsTotalSize,
  type CallRecording,
} from "~/lib/call-recording";
import { convLabel } from "~/lib/protocol";
import { Button } from "./ui/button";
import { useAppState, useController } from "./controller-context";

/**
 * Every call this browser has recorded, and the one place to remove one.
 *
 * The recording itself appears in the conversation the call was in, which is right: that is
 * where the call was, and it is where somebody looks for it the same afternoon. But a
 * conversation has to be FOUND — the history is long, a recording made in March is a long
 * scroll up, and one made in a MEETING joined from a calendar link has no conversation at all
 * (the service resolves the thread from the code and never tells us). So the list belongs
 * here, exactly as the renamed people's does, and for the same reason.
 *
 * It also answers the one question about recordings that only this surface can: what they all
 * cost. They are the largest things this app keeps and they are kept in a browser, so the
 * total is stated and the user is the one who decides a recording is no longer worth the room.
 */
export function CallRecordingsSettings() {
  const recordings = useAppState((s) => s.recordings);
  const canKeep = useAppState((s) => s.recordingsCanBeKept);
  const total = useMemo(() => recordingsTotalSize(recordings), [recordings]);

  return (
    <section className="flex flex-col gap-4" data-testid="call-recordings-settings">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive shadow-chip">
          <HugeiconsIcon icon={RecordIcon} className="size-5" strokeWidth={1.5} />
        </div>
        <div className="flex flex-col">
          <h3 className="text-[15px] font-medium text-foreground">Call recordings</h3>
          <p className="text-[13px] text-text-faint">
            Calls you recorded in teams-lite, kept in this browser. Microsoft Teams holds none
            of them and was never told a call was recorded — so they are not on your other
            devices, and clearing this browser&apos;s data removes them. Save one to keep it
            for good. Record a call from the call&apos;s own header.
          </p>
        </div>
      </div>

      {!canKeep ? (
        <p
          data-testid="call-recordings-unavailable"
          className="rounded-xl bg-card p-4 text-[13px] text-text-faint shadow-chip"
        >
          This browser cannot keep a recording, so recording is not offered here.
        </p>
      ) : recordings.length === 0 ? (
        <p
          data-testid="call-recordings-empty"
          className="rounded-xl bg-card p-4 text-[13px] text-text-faint shadow-chip"
        >
          You haven&apos;t recorded a call yet.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {recordings.map((recording) => (
              <RecordingRow key={recording.id} recording={recording} />
            ))}
          </ul>
          <p data-testid="call-recordings-total" className="text-[11px] text-text-faint">
            {recordings.length === 1 ? "1 recording" : `${recordings.length} recordings`} ·{" "}
            {recordingSizeLabel(total)} in this browser
          </p>
        </>
      )}
    </section>
  );
}

/** One recording: what it was, how long, how big — and the two things that can be done with
 *  it. There is no player here: this list is for finding and pruning, and the conversation is
 *  where a recording is watched (a row that decoded a video would make opening Settings cost
 *  every recording on the machine). */
function RecordingRow(props: { recording: CallRecording }) {
  const { recording } = props;
  const controller = useController();
  const conversations = useAppState((s) => s.conversations);
  const [confirming, setConfirming] = useState(false);
  const [missing, setMissing] = useState(false);

  const where = useMemo(() => {
    if (!recording.conversationId) return "A meeting joined from a link";
    const conversation = conversations.find((c) => c.id === recording.conversationId);
    return conversation ? convLabel(conversation) : "A conversation this app no longer holds";
  }, [conversations, recording.conversationId]);

  // The file is read only when the user reaches for it, so opening Settings costs no bytes —
  // and the save is ONE press: the anchor is made here and clicked, rather than the row
  // turning into a link the user has to press a second time.
  const save = async () => {
    const url = await controller.recordingUrl(recording.id);
    if (!url) {
      setMissing(true);
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = recordingFileName(recording);
    link.click();
  };

  return (
    <li
      data-testid="call-recording-row"
      data-recording-id={recording.id}
      className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-3 shadow-chip"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">{recording.title}</span>
        <span className="truncate text-[11px] text-text-faint">
          {recordingDurationLabel(recording.durationMs)} · {recordingSizeLabel(recording.size)} ·{" "}
          {recordingWhenLabel(recording)} · {where}
        </span>
        {/* A row whose file this browser no longer holds keeps its row: the metadata is what
            is left of it, and saying so is better than a Save that does nothing. */}
        {missing && (
          <span data-testid="call-recording-row-missing" className="text-[11px] text-destructive">
            This browser no longer holds this video.
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          data-testid="call-recording-row-save"
          onClick={() => void save()}
        >
          <HugeiconsIcon icon={Download04Icon} />
          Save
        </Button>
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              data-testid="call-recording-row-delete-confirm"
              onClick={() => void controller.deleteCallRecording(recording.id)}
            >
              Delete for good
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="call-recording-row-delete-cancel"
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete the recording of ${recording.title}`}
            data-testid="call-recording-row-delete"
            onClick={() => setConfirming(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        )}
      </span>
    </li>
  );
}
