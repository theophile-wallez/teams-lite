import { HugeiconsIcon } from "@hugeicons/react";
import { CallIcon } from "@hugeicons/core-free-icons";
import {
  callUnavailableReason,
  canPlaceCall,
  conversationIsCallable,
} from "~/lib/call";
import { useAppState, useController } from "./controller-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * The call button in a conversation's header.
 *
 * It is drawn only where a call would really work — a one-to-one chat, on a machine the
 * user turned calling on, with the calling connection up and no call already in flight.
 * Everywhere else it is absent rather than disabled: a button that cannot do the thing
 * it names is worse than no button, and the reason it is missing belongs in Settings,
 * where the switch is.
 *
 * The one exception is a one-to-one chat where calling is simply OFF. There the button
 * stays, disabled, with the reason in its tooltip — because that is the case the user
 * can fix, and a missing button would leave them looking for a feature the app has.
 */
export function CallButton(props: { conversationId: string }) {
  const controller = useController();
  const status = useAppState((s) => s.callStatus);
  const conversation = useAppState((s) =>
    s.conversations.find((c) => c.id === props.conversationId),
  );

  const callable = conversationIsCallable(conversation?.kind);
  // A channel, a group chat, or a thread this app cannot call: no button at all.
  if (!callable) return null;

  const ready = canPlaceCall(status);
  const reason = callUnavailableReason(status, callable);
  const button = (
    <button
      type="button"
      data-testid="call-button"
      aria-label={ready ? `Call ${conversation?.name || "this person"}` : reason}
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
