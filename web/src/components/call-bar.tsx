import { useCallback } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CallEnd01Icon, CallIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import {
  callNamesAConversation,
  callPhaseLabel,
  isLive,
  isMeeting,
  type ActiveCall,
} from "~/lib/call";
import { callStageIsUp } from "~/lib/call-stage";
import { useAppState, useController } from "./controller-context";
import { Avatar } from "./avatar";
import { CallStage } from "./call-stage";
import { Button } from "./ui/button";

/**
 * A call that is RINGING — and nothing else.
 *
 * Everything after the ring belongs to {@link CallStage}, which is mounted from here
 * because the two are one call in two shapes and only ever one of them is on screen: an
 * incoming call is an OFFER — nothing is connected, no microphone is open, and the whole of
 * it is one question with two answers, which a card beside the conversation asks better
 * than a page that took the screen for something the user may decline. The moment they
 * answer, the stage takes it (`callStageIsUp`).
 *
 * Everything the card decides comes from the backend's own `call_state`: whether answering
 * is possible (`can_accept` — only the backend holds the links) and who is calling.
 */
export function CallBar() {
  const call = useAppState((s) => s.callStatus.call);
  const stack = useNoticeReservation();

  // Bottom, not top: an incoming call is decided about in one glance, and down here the
  // card covers a corner of the history and no control at all. It is also away from the
  // awareness banner (`incoming-call-banner.tsx`), which is a different thing and may be on
  // screen at the same time. On a phone it spans the width, because a floating pill in a
  // corner is a target nobody hits. It clears the composer rather than resting on it: a
  // card over the message box would swallow the click that focuses it, and a call is not a
  // reason to stop being able to type.
  //
  // Why a call ENDED, and why one failed, are not here: each is one sentence about a call
  // that no longer exists, so each is a transient notice (lib/notice.ts). As a card it had
  // no timer at all — `not connected` stayed over the chat list until the next call.
  return (
    <>
      <CallStage />
      <div
        ref={stack}
        className="pointer-events-none fixed inset-x-3 bottom-24 z-[95] flex flex-col items-stretch gap-2 pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:right-4 sm:items-end"
      >
        <AnimatePresence>
          {call && isLive(call) && !callStageIsUp(call) && <RingingCard key="call" call={call} />}
        </AnimatePresence>
      </div>
    </>
  );
}

/** The gap between this stack and a notice above it — the column's own `gap-2`, so the
 *  two read as one stack whether or not a call is up. */
const NOTICE_GAP = 8;

/**
 * Keep a transient notice clear of whatever this stack is drawing.
 *
 * A notice is positioned by sonner and this column by CSS, so neither can lay the other
 * out: the height travels between them as `--notice-inset-bottom` instead (the base inset
 * lives in styles/app.css, and app-toaster.tsx reads the pair). Without it a camera the
 * browser refused would put its sentence over the card holding Answer.
 *
 * The CONTENT box is what is measured, so the stack's own safe-area padding is not counted
 * twice — the base inset already carries it. An empty stack reports nothing and the notice
 * falls back to that base, which is what it does through a live call: the page draws its own
 * controls at the TOP, and a folded window is somewhere the user put it.
 */
function useNoticeReservation() {
  return useCallback((node: HTMLElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      root.style.setProperty(
        "--notice-inset-bottom",
        height > 0
          ? `calc(var(--notice-inset-base) + ${Math.round(height) + NOTICE_GAP}px)`
          : "var(--notice-inset-base)",
      );
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--notice-inset-bottom");
    };
  }, []);
}

function RingingCard(props: { call: ActiveCall }) {
  const { call } = props;
  const controller = useController();
  const reduce = useReducedMotion();
  // A meeting AND a group call name a conversation rather than a person, so both wear the
  // group mark: `peer_mri` is empty on both, and a face seeded from nothing would stand in
  // for five people.
  const conversation = callNamesAConversation(call);

  return (
    <motion.div
      data-testid="call-bar"
      data-call-id={call.id}
      data-phase={call.phase}
      role="alert"
      initial={{ opacity: 0, y: reduce ? 0 : -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduce ? 0 : -8 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="pointer-events-auto flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-pop sm:w-80"
    >
      <span className="relative shrink-0">
        {conversation ? (
          <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <HugeiconsIcon icon={UserGroupIcon} className="size-5" strokeWidth={1.8} />
          </span>
        ) : (
          <Avatar seed={call.peer_mri} label={call.peer} className="size-10" />
        )}
        <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-success text-white">
          <HugeiconsIcon icon={CallIcon} className="size-2.5 animate-pulse" strokeWidth={2.4} />
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <p data-testid="call-peer" className="truncate text-sm font-semibold text-foreground">
          {call.peer || (isMeeting(call) ? "Meeting" : "Unknown caller")}
        </p>
        <p data-testid="call-phase" className="truncate text-xs text-text-faint">
          {callPhaseLabel(call)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {call.can_accept && (
          <Button size="sm" data-testid="call-answer" onClick={() => void controller.answerCall()}>
            Answer
          </Button>
        )}
        {/* A ringing call has no mute: nothing is being sent yet, and a button that muted a
            microphone which is not open would be a lie about what the machine is doing. */}
        <button
          type="button"
          data-testid="call-hangup"
          aria-label="Decline"
          onClick={() => void controller.hangUpCall()}
          className="grid size-9 place-items-center rounded-full bg-destructive/15 text-destructive transition-colors hover:bg-destructive/25"
        >
          <HugeiconsIcon icon={CallEnd01Icon} className="size-4" strokeWidth={1.8} />
        </button>
      </div>
    </motion.div>
  );
}
