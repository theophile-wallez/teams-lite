import { HugeiconsIcon } from "@hugeicons/react";
import { CallIcon } from "@hugeicons/core-free-icons";
import { canJoinMeeting, isMeetingJoinLink, meetingUnavailableReason } from "~/lib/call";
import { useAppState, useController } from "./controller-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * "Join here" — walk into a meeting with audio, in this app.
 *
 * It sits beside the link that opens real Teams, and it does not replace it: this joins
 * with a microphone and nothing else, so a meeting where the user has to see a shared
 * screen is still a meeting they open in Teams. Offering both is the honest shape.
 *
 * Drawn only for a link this app can really join, and only where a join would work. When
 * calling is off it stays, disabled, with the reason in its tooltip — that is the case
 * the user can fix, and Settings is where they fix it.
 */
export function MeetingJoinButton(props: { joinUrl: string; subject?: string }) {
  const controller = useController();
  const status = useAppState((s) => s.callStatus);

  // A link this app cannot address is not offered at all. The check is a small port of
  // `calling::MeetingJoin::from_join_url`; the backend refuses anything it disagrees
  // with, so the worst a mismatch costs is a button that reports a refusal.
  if (!isMeetingJoinLink(props.joinUrl)) return null;

  const ready = canJoinMeeting(status);
  const reason = meetingUnavailableReason(status);
  const button = (
    <button
      type="button"
      data-testid="meeting-join-here"
      disabled={!ready}
      aria-label={ready ? "Join this meeting with audio" : reason}
      onClick={() => void controller.joinMeeting(props.joinUrl, props.subject)}
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
