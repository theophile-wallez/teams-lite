import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { canJoinMeeting, isMeetingJoinLink, meetingUnavailableReason } from "~/lib/call";
import { useAppState } from "./controller-context";
import { MeetingJoinButton } from "./meeting-join-button";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";

/**
 * "Join with a link" — walk into a meeting this app cannot otherwise SEE.
 *
 * The two ways in that already exist both need the meeting to be somewhere the app already
 * holds: a calendar event's own Join button, and a meeting CHAT's menu row. Between them they
 * miss the commonest ad-hoc meeting there is — the one somebody pastes to you. Measured
 * 2026-09-04 on a real `/meet/{code}` link the user had just made: no calendar event and no
 * chat thread, because a "Meet now" meeting creates neither, so nothing in the app could
 * reach it at all.
 *
 * It adds NO capability to the backend and no RPC. `call_join` has always taken a `join_url`
 * and parsed it with `MeetingJoin::from_join_url`, which reads both shapes Teams writes; what
 * was missing was somewhere for the user to put one. So the join, its consent gate and every
 * refusal are the ones {@link MeetingJoinButton} already carries, and this is a field in
 * front of them.
 *
 * Three rules, and each is pinned by `web/e2e/calendar.spec.ts`:
 *
 *  * **It does not weaken the calendar's read-only promise.** Joining is the CALLING plane,
 *    not a calendar write — the same reason an event may carry a Join button at all — so
 *    nothing here creates, answers or changes an event, and the header still says Read-only.
 *  * **The button is drawn only for a link this app can really join** (`isMeetingJoinLink`,
 *    the port of the backend's own two shapes). Words the user pasted by mistake earn a
 *    sentence rather than a request the service would refuse — and the backend parses it
 *    AGAIN, so the worst a disagreement between the two costs is a refusal reported at the
 *    dialog rather than a bad join.
 *  * **Nothing is joined without a press.** The field never acts on what it holds; a paste is
 *    not consent, and this app opens no meeting on the user's behalf (§ The calendar is
 *    READ-ONLY: `join_url` is a link the USER clicks).
 */
export function JoinWithLinkDialog() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const status = useAppState((s) => s.callStatus);

  const trimmed = url.trim();
  const joinable = isMeetingJoinLink(trimmed);
  // Said only once there is something to be wrong about: a sentence under an empty field is
  // a complaint about a form the reader has not filled in yet.
  const refusal = trimmed.length > 0 && !joinable ? NOT_A_MEETING_LINK : "";
  // Why a joinable link still cannot be joined HERE — a read-only backend, or a second
  // install that is not the one the user launched. The button states it too; this states it
  // where the reader is looking.
  const unavailable = joinable ? meetingUnavailableReason(status) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The link is dropped with the dialog: it is one address for one meeting, and a
        // stale one sitting in the field next time is a join nobody meant to make.
        if (!next) setUrl("");
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="calendar-join-with-link"
          data-cuelume-press=""
          title="Join a meeting from its link"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} className="size-4" strokeWidth={1.8} />
          <span className="sr-only">Join a meeting from its link</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Join a meeting from its link</DialogTitle>
          <DialogDescription>
            Paste a Teams meeting link. This app joins with your microphone only — for a
            meeting where you need to see a shared screen, open it in Teams instead.
          </DialogDescription>
        </DialogHeader>

        <label className="block">
          <span className="sr-only">Meeting link</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            data-testid="join-link-field"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://teams.microsoft.com/meet/…"
            // 16px and 44px tall: no iOS zoom on focus, and a real target under a thumb —
            // the two rules every other field in this app holds.
            className="h-11 w-full rounded-xl bg-field px-3 text-[16px] text-foreground shadow-chip outline-none placeholder:text-text-faint focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </label>

        {refusal && (
          <p data-testid="join-link-error" className="text-[13px] text-danger">
            {refusal}
          </p>
        )}
        {unavailable && (
          <p data-testid="join-link-unavailable" className="text-[13px] text-text-dim">
            {unavailable}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </DialogClose>
          {/* The join is the button this app already has, so the consent gate, the disabled
              states and every refusal are the ones every other Join carries. It is drawn only
              once the field holds something joinable: a Join beside an empty box would be a
              control that reports a refusal. */}
          {joinable && canJoinMeeting(status) && (
            <MeetingJoinButton
              meeting={{ kind: "link", joinUrl: trimmed }}
              shape="pill"
              onStarted={() => setOpen(false)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What a paste that is not a meeting link earns. It names both shapes, because the reader
 *  may have copied the wrong half of an invitation rather than the wrong thing entirely. */
const NOT_A_MEETING_LINK =
  "That is not a Teams meeting link. It should look like " +
  "teams.microsoft.com/meet/… or teams.microsoft.com/l/meetup-join/…";
