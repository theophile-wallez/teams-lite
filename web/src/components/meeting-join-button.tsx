import { HugeiconsIcon } from "@hugeicons/react";
import { CallIcon } from "@hugeicons/core-free-icons";
import {
  canJoinMeeting,
  isMeetingJoinLink,
  meetingUnavailableReason,
  type MeetingAddress,
} from "~/lib/call";
import { useAppState, useController } from "./controller-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * "Join here" — walk into a meeting with audio, in this app.
 *
 * In a calendar event it sits beside the link that opens real Teams, and it does not
 * replace it: this joins with a microphone and nothing else, so a meeting where the user
 * has to see a shared screen is still a meeting they open in Teams. Offering both is the
 * honest shape.
 *
 * Two surfaces reach it, and each covers what the other cannot. A calendar event joins by
 * the LINK it carries; a meeting's own CHAT joins by its THREAD, which is the only address
 * that exists there — this tenant's invitations carry the short `/meet/{code}` link, and
 * that code lives in the event and nowhere in the conversation. So the button takes either
 * {@link MeetingAddress} and states the one it holds.
 *
 * Drawn only for an address this app can really join, and only where a join would work. When
 * calling is off it stays, disabled, with the reason in its tooltip — that is the case
 * the user can fix, and Settings is where they fix it.
 */
export function MeetingJoinButton(props: { meeting: MeetingAddress; subject?: string }) {
  const controller = useController();
  const status = useAppState((s) => s.callStatus);
  const { meeting } = props;

  // An address this app cannot join is not offered at all. For a LINK the check is a small
  // port of `calling::MeetingJoin::from_join_url`; a THREAD was checked where the address
  // was built (`meetingAddressOf`, the port of `from_thread_id`). The backend parses it
  // again either way, so the worst a mismatch costs is a button that reports a refusal.
  if (meeting.kind === "link" && !isMeetingJoinLink(meeting.joinUrl)) return null;

  const ready = canJoinMeeting(status);
  const reason = meetingUnavailableReason(status);
  const button = (
    <button
      type="button"
      data-testid="meeting-join-here"
      // WHICH meeting this button joins, in the page's own state — one attribute per shape
      // of address, and never both.
      //
      // Joining is outward — everybody in the meeting sees the user arrive — so a driver
      // must be able to prove its target before it clicks, exactly as it re-reads
      // `[data-testid="composer-shell"]`'s `data-conversation-id` before every keystroke.
      // Without this, a script could only assume, and an assumption is what put three
      // messages in real colleagues' chats (AGENTS.md § Automation safety).
      data-join-url={meeting.kind === "link" ? meeting.joinUrl : undefined}
      data-meeting-thread={meeting.kind === "thread" ? meeting.thread : undefined}
      disabled={!ready}
      aria-label={ready ? "Join this meeting with audio" : reason}
      onClick={() => void controller.joinMeeting(meeting, props.subject)}
      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
    >
      <HugeiconsIcon icon={CallIcon} className="size-3.5" strokeWidth={1.8} />
      Join here
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button fires no pointer events, so the tooltip hangs off a
            wrapper the user can still hover and focus. */}
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        {reason || "Join with audio, here. Open it in Teams for video and screen sharing."}
      </TooltipContent>
    </Tooltip>
  );
}
