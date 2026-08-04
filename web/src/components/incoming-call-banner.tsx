import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CallIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { isLive } from "~/lib/call";
import { incomingCallTitle, type Channel, type Conversation, type IncomingCall } from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import { CallParticipants } from "./call-event-line";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * The call-AWARENESS banner: a note that a call is happening in a conversation,
 * built from the after-the-fact `Event/Call` chat message rather than from the calling
 * plane. It knows nothing about media, which is why "Answer" here is disabled and the
 * primary action opens the chat.
 *
 * It is the OTHER banner. When this machine is really being called — calling turned on,
 * an invite on the calling socket — `components/call-bar.tsx` draws that call with a
 * working Answer, and the awareness card for the same conversation is dropped: two cards
 * for one call, one of which says it cannot be answered, would be the app arguing with
 * itself. The awareness banner still covers every case the calling plane does not: a call
 * in a group chat, a channel meeting, a call that rang while calling was off, and a call
 * the user took on their phone.
 *
 * Fixed to the top-centre, under the call bar. Renders one card per ringing
 * conversation. Each is cleared by its backend `ended`/`missed`, a manual dismiss, or the
 * store's safety timeout.
 */
export function IncomingCallBanner() {
  const awareness = useAppState((s) => s.incomingCalls);
  const liveCall = useAppState((s) => s.callStatus.call);
  const calls = awareness.filter(
    (c) => !(liveCall && isLive(liveCall) && liveCall.conversation_id === c.conversationId),
  );
  // Always render the (empty, pointer-events-none) container so AnimatePresence
  // stays mounted — otherwise dismissing the last call unmounts it before the
  // exit animation can play, and the common single-call case would pop out with
  // no transition at all.
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[90] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {calls.map((call) => (
          <IncomingCallCard key={call.conversationId} call={call} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** The group/channel name to pair with the caller, or undefined for a 1:1 (whose
 *  conversation name is just the other person — already shown as the caller). */
function groupLabelFor(
  call: IncomingCall,
  conversations: Conversation[],
  channels: Channel[],
): string | undefined {
  const conv = conversations.find((c) => c.id === call.conversationId);
  if (conv) {
    const isGroup = conv.kind === "group" || conv.kind === "unknown";
    return isGroup && conv.name ? conv.name : undefined;
  }
  const channel = channels.find((c) => c.id === call.conversationId);
  return channel?.name || undefined;
}

function IncomingCallCard(props: { call: IncomingCall }) {
  const { call } = props;
  const controller = useController();
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const conversations = useAppState((s) => s.conversations);
  const channels = useAppState((s) => s.channels);

  const title = incomingCallTitle(call, groupLabelFor(call, conversations, channels));

  const openChat = () => {
    controller.dismissIncomingCall(call.conversationId);
    void navigate({ to: "/c/$conversationId", params: { conversationId: call.conversationId } });
  };

  return (
    <motion.div
      data-testid="incoming-call-banner"
      data-conversation-id={call.conversationId}
      role="alert"
      initial={{ opacity: 0, y: reduce ? 0 : -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduce ? 0 : -8 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="pointer-events-auto flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-pop"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-success/10 text-success">
          <HugeiconsIcon icon={CallIcon} className="size-5 animate-pulse" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p data-testid="incoming-call-title" className="truncate text-sm font-semibold text-foreground">
            {title}
          </p>
          <p className="text-xs text-text-faint">Ringing…</p>
        </div>
        <button
          type="button"
          data-testid="incoming-call-dismiss"
          aria-label="Dismiss"
          onClick={() => controller.dismissIncomingCall(call.conversationId)}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-text-faint transition-colors hover:bg-element hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
        </button>
      </div>

      {call.participants.length > 0 && (
        <div className="pl-1">
          <CallParticipants participants={call.participants} mris={call.participantMris} />
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {/* "Answer" is intentionally disabled: teams-lite has no media stack and
            cannot join a call. The tooltip says so and points at real Teams, so
            the boundary is explicit rather than a silently broken button. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button
                size="sm"
                disabled
                data-testid="incoming-call-answer"
                className="pointer-events-none"
              >
                Answer
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Calls can't be answered in teams-lite — join in Microsoft Teams.</TooltipContent>
        </Tooltip>
        <Button variant="secondary" size="sm" data-testid="incoming-call-open" onClick={openChat}>
          Open chat
        </Button>
      </div>
    </motion.div>
  );
}
