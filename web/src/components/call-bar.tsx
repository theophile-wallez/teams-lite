import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CallEnd01Icon,
  CallIcon,
  ComputerScreenShareIcon,
  Mic01Icon,
  MicOff01Icon,
  UserGroupIcon,
  Video01Icon,
  VideoOffIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import {
  callDurationLabel,
  callNamesAConversation,
  callPhaseLabel,
  callPresenceLabel,
  isLive,
  isMeeting,
  type ActiveCall,
} from "~/lib/call";
import { useAppState, useController } from "./controller-context";
import { Avatar } from "./avatar";
import { CallVideoStage } from "./call-video";
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
  const stack = useNoticeReservation();

  // Bottom, not top, and one place for both states. A connected call stays for
  // minutes, so a top-centre card would sit over the conversation's own header for the
  // whole call; down here it covers a corner of the history and no control at all. It is
  // also away from the awareness banner (`incoming-call-banner.tsx`), which is a
  // different thing and may be on screen at the same time. On a phone it spans the
  // width, because a floating pill in a corner is a target nobody hits. It clears the
  // composer rather than resting on it: a card over the message box would swallow the
  // click that focuses it, and a call is not a reason to stop being able to type.
  //
  // Why a call ENDED, and why one failed, are not here any more: each is one sentence
  // about a call that no longer exists, so each is a transient notice (lib/notice.ts).
  // As a card it had no timer at all — `not connected` stayed over the chat list until
  // the next call — and it was drawn only while NO call was live, which is exactly when
  // a refused camera has something to say.
  return (
    <div
      ref={stack}
      className="pointer-events-none fixed inset-x-3 bottom-24 z-[95] flex flex-col items-stretch gap-2 pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {/* The picture, ABOVE the bar and outside its AnimatePresence: it comes and goes on
          its own timing — a screen starts and stops several times in one call — and the
          controls must not move when it does. */}
      <CallVideoStage />
      <AnimatePresence>
        {call && isLive(call) && <CallCard key="call" call={call} />}
      </AnimatePresence>
    </div>
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
 * browser refused would put its sentence over the card holding Hang up.
 *
 * The CONTENT box is what is measured, so the stack's own safe-area padding is not counted
 * twice — the base inset already carries it. An empty stack (no call, no picture) reports
 * nothing and the notice falls back to that base.
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

function CallCard(props: { call: ActiveCall }) {
  const { call } = props;
  const controller = useController();
  const reduce = useReducedMotion();
  const ringing = call.phase === "ringing";
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
      // Wider once the camera and the share buttons are there: four round controls beside a
      // name do not fit 20rem, and what gives way is the name — a meeting called
      // "Architecture guild" was drawn "Archit…", which is the one thing on this card the
      // user cannot work out from context. The width changes at the same moment the buttons
      // do, which is a transition the card already makes (Answer becomes mute and hang up).
      className={`pointer-events-auto flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-pop ${
        call.can_send_media ? "sm:w-[26rem]" : "sm:w-80"
      }`}
    >
      <span className="relative shrink-0">
        {/* A meeting and a group call are not a person, so each gets its own mark rather
            than a face seeded from an empty mri. */}
        {conversation ? (
          <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <HugeiconsIcon icon={UserGroupIcon} className="size-5" strokeWidth={1.8} />
          </span>
        ) : (
          <Avatar seed={call.peer_mri} label={call.peer} className="size-10" />
        )}
        {ringing && (
          <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-success text-white">
            <HugeiconsIcon icon={CallIcon} className="size-2.5 animate-pulse" strokeWidth={2.4} />
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p data-testid="call-peer" className="truncate text-sm font-semibold text-foreground">
          {call.peer || (isMeeting(call) ? "Meeting" : "Unknown caller")}
        </p>
        <p data-testid="call-phase" className="truncate text-xs text-text-faint">
          {/* Connected: the duration, and — in a meeting — who else is in it, because
              "how long" alone does not answer the question a meeting raises. Any other
              phase says what it is doing instead. */}
          {call.phase === "connected" ? (
            <>
              {conversation && <>{callPresenceLabel(call)} · </>}
              <CallClock call={call} />
            </>
          ) : (
            callPhaseLabel(call)
          )}
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
        {/* The camera and the screen, and only where they would work: the service refuses
            new media on a call that is not established, so a button drawn before then would
            report a refusal the user could do nothing about. Each click is the consent for
            that one action, and the browser asks its own permission under it. */}
        {!ringing && call.can_send_media && (
          <>
            <SendToggle
              testId="call-camera"
              on={call.sending.includes("camera")}
              onLabel="Turn the camera off"
              offLabel="Turn the camera on"
              icon={call.sending.includes("camera") ? VideoOffIcon : Video01Icon}
              onToggle={(on) => void controller.setCameraOn(on)}
            />
            <SendToggle
              testId="call-share"
              on={call.sending.includes("screen")}
              onLabel="Stop sharing the screen"
              offLabel="Share the screen"
              icon={ComputerScreenShareIcon}
              onToggle={(on) => void controller.setScreenShareOn(on)}
            />
          </>
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
          aria-label={ringing ? "Decline" : isMeeting(call) ? "Leave the meeting" : "Hang up"}
          onClick={() => void controller.hangUpCall()}
          className="grid size-9 place-items-center rounded-full bg-destructive/15 text-destructive transition-colors hover:bg-destructive/25"
        >
          <HugeiconsIcon icon={CallEnd01Icon} className="size-4" strokeWidth={1.8} />
        </button>
      </div>
    </motion.div>
  );
}

/**
 * One thing this machine can send, and whether it is sending it.
 *
 * The two share a component because they are one kind of control and one kind of promise: a
 * click turns a capture on, the browser then asks its own permission, and the state comes
 * back from the BACKEND rather than from this button — so two open pages, and a phone that
 * reconnects mid-call, all draw the same thing.
 */
function SendToggle(props: {
  testId: string;
  on: boolean;
  onLabel: string;
  offLabel: string;
  icon: IconSvgElement;
  onToggle: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.on ? props.onLabel : props.offLabel}
      aria-pressed={props.on}
      title={props.on ? props.onLabel : props.offLabel}
      onClick={() => props.onToggle(!props.on)}
      className={`grid size-9 place-items-center rounded-full transition-colors ${
        props.on
          ? "bg-primary/15 text-primary hover:bg-primary/25"
          : "bg-element text-text-dim hover:bg-accent hover:text-foreground"
      }`}
    >
      <HugeiconsIcon icon={props.icon} className="size-4" strokeWidth={1.8} />
    </button>
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
