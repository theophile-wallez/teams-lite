import { HugeiconsIcon } from "@hugeicons/react";
import { CallIcon } from "@hugeicons/core-free-icons";
import {
  callUnavailableReason,
  canPlaceCall,
  conversationCallAction,
  meetingAddressOf,
} from "~/lib/call";
import { convLabel, isGroupChat } from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import { MeetingJoinButton } from "./meeting-join-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * The call control in a conversation's header — one per conversation, and the conversation
 * itself decides which one it is (`conversationCallAction`).
 *
 * A chat with people in it is CALLED: one person in a 1:1, everybody at once in a group,
 * which is the same POST and the same call. A thread Teams minted FOR a meeting is JOINED
 * instead, addressed by that thread — so a meeting the user was invited to is reachable
 * from the chat list, without going to the calendar for its link.
 *
 * It is drawn only where it would really work — on a machine the user turned calling on,
 * with the calling connection up and no call already in flight. Everywhere else it is
 * absent rather than disabled: a button that cannot do the thing it names is worse than no
 * button, and the reason it is missing belongs in Settings, where the switch is.
 *
 * The one exception is a chat where calling is simply OFF. There the control stays,
 * disabled, with the reason in its tooltip — because that is the case the user can fix, and
 * a missing button would leave them looking for a feature the app has.
 */
export function CallButton(props: { conversationId: string }) {
  const controller = useController();
  const status = useAppState((s) => s.callStatus);
  const conversation = useAppState((s) =>
    s.conversations.find((c) => c.id === props.conversationId),
  );

  const action = conversationCallAction(conversation);
  // Notes — the chat with oneself — and anything this app cannot address: no control.
  if (action === "none") return null;
  // A meeting is joined rather than rung, and the Join button carries its own rails,
  // including the address it states for a driver to prove before it clicks.
  const meeting = meetingAddressOf(conversation);
  if (action === "join" && meeting) return <MeetingJoinButton meeting={meeting} />;

  const ready = canPlaceCall(status);
  const reason = callUnavailableReason(status);
  const group = !!conversation && isGroupChat(conversation);
  const button = (
    <button
      type="button"
      data-testid="call-button"
      // A group call rings EVERY member at once, so the label says what it reaches rather
      // than naming one person. That is the fact the user needs before the click, and the
      // one thing they cannot take back after it.
      aria-label={
        ready
          ? group
            ? `Call everybody in ${convLabel(conversation)}`
            : `Call ${conversation?.name || "this person"}`
          : reason
      }
      disabled={!ready}
      onClick={() => void controller.startCall(props.conversationId)}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <HugeiconsIcon icon={CallIcon} className="size-5" strokeWidth={1.6} />
    </button>
  );

  if (ready) return button;
  return (
    <Tooltip>
      {/* A disabled button fires no pointer events, so the tooltip hangs off a wrapper
          the user can still hover and focus — the reason is the whole point of drawing
          it disabled rather than hiding it. */}
      <TooltipTrigger asChild>
        <span tabIndex={0}>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
