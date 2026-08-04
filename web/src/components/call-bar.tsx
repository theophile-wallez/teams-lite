import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CallEnd01Icon,
  CallIcon,
  Mic01Icon,
  MicOff01Icon,
} from "@hugeicons/core-free-icons";
import { callDurationLabel, callPhaseLabel, isLive, type ActiveCall } from "~/lib/call";
import { useAppState, useController } from "./controller-context";
import { Avatar } from "./avatar";
import { Button } from "./ui/button";

/**
 * The one call this machine is in, drawn over everything else.
 *
 * Two states in one component, because they are one call: it RINGS (Answer / Decline)
 * and then it is UP (who, how long, mute, hang up). Splitting them into two components
 * would let a transition between them flicker the card out and back in, and a ringing
 * call that becomes a live one is the most common transition there is.
 *
 * Everything it decides comes from the backend's own `call_state`: whether answering is
 * possible (`can_accept` — only the backend holds the links), who the other person is,
 * and when audio started. The duration is counted from the backend's clock, so two open
 * pages agree to the second.
 */
export function CallBar() {
  const call = useAppState((s) => s.callStatus.call);
  const error = useAppState((s) => s.callError);
  // Why the last call ended, kept by the store: the call itself is dropped the moment
  // that frame arrives, so the reason cannot be read off it afterwards.
  const ended = useAppState((s) => s.callNotice);

  // Bottom, not top, and one place for both states. A connected call stays for
  // minutes, so a top-centre card would sit over the conversation's own header for the
  // whole call; down here it covers a corner of the history and no control at all. It is
  // also away from the awareness banner (`incoming-call-banner.tsx`), which is a
  // different thing and may be on screen at the same time. On a phone it spans the
  // width, because a floating pill in a corner is a target nobody hits. It clears the
  // composer rather than resting on it: a card over the message box would swallow the
  // click that focuses it, and a call is not a reason to stop being able to type.
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-24 z-[95] flex flex-col items-stretch gap-2 pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:right-4 sm:items-end">
      <AnimatePresence>
        {call && isLive(call) && <CallCard key="call" call={call} />}
        {/* A failure the user did not cause, and an ending they did not ask for, each
            get one line. An ordinary hangup says nothing: they were there. */}
        {!isLive(call) && (error || ended) && (
          <CallNotice key="notice" text={error ?? ended ?? ""} />
        )}
      </AnimatePresence>
    </div>
  );
}

function CallCard(props: { call: ActiveCall }) {
  const { call } = props;
  const controller = useController();
  const reduce = useReducedMotion();
  const ringing = call.phase === "ringing";

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
        <Avatar seed={call.peer_mri} label={call.peer} className="size-10" />
        {ringing && (
          <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-success text-white">
            <HugeiconsIcon icon={CallIcon} className="size-2.5 animate-pulse" strokeWidth={2.4} />
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p data-testid="call-peer" className="truncate text-sm font-semibold text-foreground">
          {call.peer || "Unknown caller"}
        </p>
        <p data-testid="call-phase" className="truncate text-xs text-text-faint">
          {call.phase === "connected" ? <CallClock call={call} /> : callPhaseLabel(call)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {ringing && call.can_accept && (
          <Button
            size="sm"
            data-testid="call-answer"
            onClick={() => void controller.answerCall()}
          >
            Answer
          </Button>
        )}
        {!ringing && (
          <button
            type="button"
            data-testid="call-mute"
            aria-label={call.muted ? "Unmute" : "Mute"}
            aria-pressed={call.muted}
            onClick={() => void controller.setCallMuted(!call.muted)}
            className={`grid size-9 place-items-center rounded-full transition-colors ${
              call.muted
                ? "bg-warning/15 text-warning hover:bg-warning/25"
                : "bg-element text-text-dim hover:bg-accent hover:text-foreground"
            }`}
          >
            <HugeiconsIcon
              icon={call.muted ? MicOff01Icon : Mic01Icon}
              className="size-4"
              strokeWidth={1.8}
            />
          </button>
        )}
        <button
          type="button"
          data-testid="call-hangup"
          aria-label={ringing ? "Decline" : "Hang up"}
          onClick={() => void controller.hangUpCall()}
          className="grid size-9 place-items-center rounded-full bg-destructive/15 text-destructive transition-colors hover:bg-destructive/25"
        >
          <HugeiconsIcon icon={CallEnd01Icon} className="size-4" strokeWidth={1.8} />
        </button>
      </div>
    </motion.div>
  );
}

/** The running duration, ticking once a second off the backend's own start time. */
function CallClock(props: { call: ActiveCall }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span data-testid="call-duration">{callDurationLabel(props.call, now) || "In a call"}</span>;
}

function CallNotice(props: { text: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.p
      data-testid="call-notice"
      role="status"
      initial={{ opacity: 0, y: reduce ? 0 : -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="pointer-events-auto rounded-xl border border-border bg-card px-3 py-2 text-xs text-text-dim shadow-pop sm:max-w-80"
    >
      {props.text}
    </motion.p>
  );
}
