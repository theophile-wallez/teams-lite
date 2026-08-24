import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import {
  BubbleChatIcon,
  CallEnd01Icon,
  ComputerScreenShareIcon,
  Maximize01Icon,
  Mic01Icon,
  MicOff01Icon,
  Minimize01Icon,
  RecordIcon,
  StopIcon,
  UserGroupIcon,
  UserMultipleIcon,
  Video01Icon,
  VideoOffIcon,
} from "@hugeicons/core-free-icons";
import { callDurationLabel, callNamesAConversation, isMeeting, type ActiveCall } from "~/lib/call";
import {
  RECORDING_HINT,
  RECORD_HINT,
  callCanBeRecorded,
  recordingDurationLabel,
} from "~/lib/call-recording";
import {
  MINI_MARGIN,
  PANEL_BESIDE_PX,
  callMiniPicture,
  callStageChatConversation,
  callStageIsUp,
  callStageLayout,
  callStageLobbyLabel,
  callStageParticipants,
  callStageSubtitle,
  callStageTimeTitle,
  callStageTitle,
  callStartClockLabel,
  clampMiniPosition,
  miniHomePosition,
  miniSize,
  shareTakeoverHint,
  type CallStagePanel,
  type StageLayout,
  type StageParticipant,
  type StageTile,
  type StageViewport,
} from "~/lib/call-stage";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { CallStageChat } from "./conversation-chat-panel";
import { useCallStage } from "./call-stage-context";
import { LocalVideoFrame, RemoteVideoFrame } from "./call-video";
import { useAppState, useController } from "./controller-context";

/**
 * The call, as a page — and as the window that page folds into.
 *
 * A call used to be a card in the corner. It is the surface the app gives its whole
 * screen to now, because for as long as it runs it IS what the user is doing: the picture
 * has the room a shared screen needs, the people have a column of their own, and the
 * meeting's chat is beside them instead of behind them.
 *
 * **The two shapes are ONE element, and that is the whole design.** Nothing is unmounted
 * and re-mounted between them: the same box travels between the whole viewport and a
 * 320px window, so the video keeps playing, the conversation keeps arriving, and the
 * morph is a movement rather than a swap. Four things hold that up:
 *
 * - **The geometry is animated, not the layout.** `x`, `y`, `width` and `height` are
 *   motion values on one `position: fixed` box, and the content inside is ordinary flex
 *   that re-flows into whatever size the box currently has. So nothing is ever a scaled,
 *   stretched picture of another size — at 40% of the way the stage genuinely IS 40% of
 *   the way, which is what makes it read as one object moving.
 * - **The two contents crossfade over that movement.** The header of a page and the bar of
 *   a small window are different things and neither can be the other, so each fades while
 *   the box travels — quicker than the movement, and led by it.
 * - **The mini window is dragged with the same motion values.** Motion writes `x`/`y` while
 *   it is dragged and the mode change animates the same two, so a window dropped in a
 *   corner expands FROM that corner and folds back TO it.
 * - **What is folded is never lost.** The stage is drawn for every live call except a
 *   ringing one, and there is no close: a call this app holds and shows nowhere is a
 *   microphone the user cannot find the off switch for.
 */
export function CallStage() {
  const call = useAppState((s) => s.callStatus.call);
  return (
    <AnimatePresence>{callStageIsUp(call) && <Stage key={call.id} call={call} />}</AnimatePresence>
  );
}

/** How long the morph between the two shapes takes, and on which curve.
 *
 *  The curve is a strong ease-out — it leaves at speed and settles — because the movement
 *  is long (most of a screen), and a travel of that distance on a softer curve reads as a
 *  window being resized rather than as one thing arriving somewhere. The fade is shorter
 *  than the movement and starts with it, so the content being left is gone before the box
 *  stops and the arriving one is legible by the time it does. */
const STAGE_MORPH_SECONDS = 0.42;
const STAGE_EASE = [0.32, 0.72, 0, 1] as const;
const STAGE_FADE_SECONDS = 0.18;

/** The radius the mini window wears. Zero in full: a page has no corners. */
const MINI_RADIUS = 20;

function Stage(props: { call: ActiveCall }) {
  const { call } = props;
  const { mode, panel, position, setMode, togglePanel, setPosition } = useCallStage();
  const reduce = useReducedMotion();
  const viewport = useViewport();

  const geometry = useMemo(() => {
    if (mode === "full") {
      return { x: 0, y: 0, width: viewport.width, height: viewport.height, radius: 0 };
    }
    const point = clampMiniPosition(position ?? miniHomePosition(viewport), viewport);
    return { ...point, ...miniSize(viewport), radius: MINI_RADIUS };
  }, [mode, position, viewport]);

  // The box's own geometry, as motion values: the drag writes the first two and a mode
  // change animates all five, which is what makes a fold end exactly where the window was
  // last dropped.
  const x = useMotionValue(geometry.x);
  const y = useMotionValue(geometry.y);
  const width = useMotionValue(geometry.width);
  const height = useMotionValue(geometry.height);
  const radius = useMotionValue(geometry.radius);

  useEffect(() => {
    const transition = reduce
      ? { duration: 0 }
      : { duration: STAGE_MORPH_SECONDS, ease: STAGE_EASE };
    const running = [
      animate(x, geometry.x, transition),
      animate(y, geometry.y, transition),
      animate(width, geometry.width, transition),
      animate(height, geometry.height, transition),
      animate(radius, geometry.radius, transition),
    ];
    return () => running.forEach((playback) => playback.stop());
  }, [geometry, reduce, x, y, width, height, radius]);

  const videos = useAppState((s) => s.callVideo);
  const mine = useAppState((s) => s.callLocalVideo);
  const layout = useMemo(() => callStageLayout(videos, mine), [videos, mine]);

  const mini = mode === "mini";

  // Escape gives back what the last click took: the open panel first, then the whole page.
  // It NEVER ends the call — the one thing on this surface that cannot be undone is the
  // only thing a stray keystroke must not reach. It is handled in the CAPTURE phase and
  // stopped there, because the app shell listens for Escape too and would close the
  // conversation under the stage that is still on screen.
  useEffect(() => {
    if (mini) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (panel) togglePanel(panel);
      else setMode("mini");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mini, panel, togglePanel, setMode]);

  return (
    <motion.div
      data-testid="call-stage"
      data-mode={mode}
      data-phase={call.phase}
      data-call-id={call.id}
      // What the BACKEND says this endpoint sends, beside the phase and for the same reason:
      // it is the one fact about a live call that a driver has to read out of the app's own
      // state rather than out of a button, because a pressed button says what was ASKED for
      // and this says what the service granted (see web/scripts/join-live.ts).
      data-sending={call.sending.join(",")}
      role="region"
      aria-label={`${isMeeting(call) ? "Meeting" : "Call"}: ${callStageTitle(call)}`}
      // Dragging belongs to the small window alone: a page has nowhere to be dragged to.
      drag={mini}
      dragMomentum={false}
      dragElastic={0.06}
      dragConstraints={dragConstraints(viewport)}
      // The drop is CLAMPED and then written down, so the window is always wholly on
      // screen and the next fold returns to where the user left it.
      onDragEnd={() => setPosition(clampMiniPosition({ x: x.get(), y: y.get() }, viewport))}
      initial={{ opacity: 0, scale: reduce ? 1 : 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduce ? 1 : 0.98 }}
      transition={{ duration: reduce ? 0 : 0.22, ease: STAGE_EASE }}
      style={{ x, y, width, height, borderRadius: radius }}
      className={cn(
        "fixed left-0 top-0 z-[96] flex flex-col overflow-hidden bg-background",
        mini && "cursor-grab shadow-pop ring-1 ring-border active:cursor-grabbing",
      )}
    >
      {/* Two contents, one box. Both are absolutely positioned so they crossfade in place
          while the box travels: a `mode="wait"` swap would leave it empty for the length
          of the movement, which is the one moment the user is watching it. */}
      <AnimatePresence initial={false}>
        {mini ? (
          <StageLayer key="mini" reduce={reduce}>
            <MiniWindow call={call} layout={layout} onExpand={() => setMode("full")} />
          </StageLayer>
        ) : (
          <StageLayer key="full" reduce={reduce}>
            <FullStage
              call={call}
              layout={layout}
              panel={panel}
              beside={viewport.width >= PANEL_BESIDE_PX}
              onTogglePanel={togglePanel}
              onMinimize={() => setMode("mini")}
            />
          </StageLayer>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** One of the two contents, filling the box and fading over the movement. */
function StageLayer(props: { reduce: boolean | null; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: props.reduce ? 0 : STAGE_FADE_SECONDS, ease: "easeOut" }}
      className="absolute inset-0 flex min-h-0 flex-col"
    >
      {props.children}
    </motion.div>
  );
}

/** How far the mini window may be dragged: never off the screen, never flush to an edge. */
function dragConstraints(viewport: StageViewport) {
  const { width, height } = miniSize(viewport);
  return {
    left: MINI_MARGIN,
    top: MINI_MARGIN,
    right: Math.max(MINI_MARGIN, viewport.width - width - MINI_MARGIN),
    bottom: Math.max(MINI_MARGIN, viewport.height - height - MINI_MARGIN),
  };
}

/** The viewport, in CSS pixels, kept current.
 *
 *  It is what the full shape's size and the mini shape's corner are both derived from, so
 *  a rotated phone or a narrowed window re-lays the stage out and re-clamps the window
 *  rather than leaving either where it no longer fits. */
function useViewport(): StageViewport {
  const [viewport, setViewport] = useState<StageViewport>(() =>
    typeof window === "undefined"
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight },
  );
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewport;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function FullStage(props: {
  call: ActiveCall;
  layout: StageLayout;
  panel: CallStagePanel | null;
  beside: boolean;
  onTogglePanel: (panel: CallStagePanel) => void;
  onMinimize: () => void;
}) {
  const { call, layout, panel } = props;
  const controller = useController();
  const navigate = useNavigate();
  const conversations = useAppState((s) => s.conversations);
  const sending = useMemo(
    () => ({ camera: call.sending.includes("camera"), sharing: call.sending.includes("screen") }),
    [call.sending],
  );
  const participants = useMemo(() => callStageParticipants(call, sending), [call, sending]);
  // The chat is offered only where there is one: a meeting joined from a calendar link
  // names no thread at all (see `callStageChatConversation`).
  const chatConversation = useMemo(
    () =>
      callStageChatConversation(call, (id) =>
        conversations.some((conversation) => conversation.id === id),
      ),
    [call, conversations],
  );

  // An open chat panel OPENS that conversation in the app underneath, because the panel
  // renders the app's own thread: one nobody opened has no history, no draft and no live feed
  // here. It runs from the panel being open rather than from the click that opened it, so the
  // default (`initialCallStagePanel`) and the toggle take the same one path — and opening a
  // conversation marks it read, exactly as clicking its row in the sidebar does.
  const openId = useAppState((s) => s.openId);
  const chatPanelOpen = panel === "chat" && !!chatConversation;
  useEffect(() => {
    if (!chatPanelOpen || openId === chatConversation) return;
    void navigate({ to: "/c/$conversationId", params: { conversationId: chatConversation! } });
  }, [chatPanelOpen, chatConversation, openId, navigate]);

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-3 py-2.5 sm:px-4">
        <CallMark call={call} className="size-9" />
        <div className="min-w-0 flex-1">
          <p
            data-testid="call-peer"
            className="truncate text-sm font-semibold leading-tight text-foreground"
          >
            {callStageTitle(call)}
          </p>
          <p data-testid="call-phase" className="truncate text-xs leading-tight text-text-faint">
            {callStageSubtitle(call)}
          </p>
        </div>

        <StageClock call={call} />

        <div className="flex shrink-0 items-center gap-1.5">
          {/* What this machine sends, and only where the service would accept it:
              `can_send_media` is the backend's own answer, and a button drawn before that
              reports a refusal the user can do nothing about. */}
          {call.can_send_media && (
            <>
              <StageControl
                testId="call-camera"
                pressed={sending.camera}
                label={sending.camera ? "Turn the camera off" : "Turn the camera on"}
                icon={sending.camera ? VideoOffIcon : Video01Icon}
                onClick={() => void controller.setCameraOn(!sending.camera)}
              />
              <StageControl
                testId="call-share"
                pressed={sending.sharing}
                label={sending.sharing ? "Stop sharing the screen" : "Share the screen"}
                // What the press costs while a colleague presents: a meeting shows one screen
                // at a time, so this one takes theirs down. It is said and not asked, because
                // Teams asks nobody and they can take it straight back.
                title={sending.sharing ? undefined : shareTakeoverHint(participants)}
                icon={ComputerScreenShareIcon}
                onClick={() => void controller.setScreenShareOn(!sending.sharing)}
              />
            </>
          )}
          <StageControl
            testId="call-mute"
            pressed={call.muted}
            tone="warning"
            label={call.muted ? "Unmute" : "Mute"}
            icon={call.muted ? MicOff01Icon : Mic01Icon}
            onClick={() => void controller.setCallMuted(!call.muted)}
          />
          <RecordControl call={call} />

          <span aria-hidden className="mx-0.5 h-6 w-px bg-border-subtle" />

          <StageControl
            testId="call-stage-people"
            pressed={panel === "people"}
            label={
              panel === "people" ? "Hide the people" : `Show the people (${participants.length})`
            }
            icon={UserMultipleIcon}
            onClick={() => props.onTogglePanel("people")}
          />
          {chatConversation && (
            <StageControl
              testId="call-stage-chat-toggle"
              pressed={panel === "chat"}
              label={panel === "chat" ? "Hide the chat" : "Show the chat"}
              icon={BubbleChatIcon}
              onClick={() => props.onTogglePanel("chat")}
            />
          )}
          <StageControl
            testId="call-stage-minimize"
            label="Fold the call away"
            icon={Minimize01Icon}
            onClick={props.onMinimize}
          />

          <LeaveButton call={call} labelled />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <StageContent call={call} layout={layout} />
        {/* One panel at a time, and never an empty one: a chat whose conversation went away
            (a thread that left the list mid-call) closes the panel rather than opening a
            column with nothing in it. */}
        <AnimatePresence initial={false}>
          {(panel === "people" || (panel === "chat" && chatConversation)) && (
            <SidePanel key="panel" beside={props.beside}>
              {panel === "people" ? (
                <StagePeople call={call} participants={participants} />
              ) : (
                <CallStageChat conversation={chatConversation!} />
              )}
            </SidePanel>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

/** How wide the side panel is. One panel at a time and a FIXED width, because both of them
 *  are columns of text: a panel that took a share of the picture would change how much of
 *  a shared screen is readable every time the other tab was opened. */
const PANEL_WIDTH = 336;

function SidePanel(props: { beside: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  const { beside } = props;
  const transition = { duration: reduce ? 0 : 0.28, ease: STAGE_EASE };
  return (
    <motion.aside
      data-testid="call-stage-panel"
      // Beside the picture, the panel OPENS by taking its room — the content keeps its own
      // width behind the edge, so the words never squash while it does. Over the picture,
      // there is no room to take, so it slides in instead.
      initial={beside ? { width: 0, opacity: 0 } : { x: PANEL_WIDTH, opacity: 0 }}
      animate={beside ? { width: PANEL_WIDTH, opacity: 1 } : { x: 0, opacity: 1 }}
      exit={beside ? { width: 0, opacity: 0 } : { x: PANEL_WIDTH, opacity: 0 }}
      transition={transition}
      className={cn(
        "z-10 overflow-hidden border-l border-border-subtle bg-card",
        beside ? "relative shrink-0" : "absolute inset-y-0 right-0 w-full",
      )}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={beside ? { width: PANEL_WIDTH } : undefined}
      >
        {props.children}
      </div>
    </motion.aside>
  );
}

/**
 * The picture, or the faces, or the avatar — one card, filling everything the panel left.
 *
 * What takes the room is decided once, in `lib/call-stage.ts` (`callStageLayout`); this
 * component only draws that answer.
 */
function StageContent(props: { call: ActiveCall; layout: StageLayout }) {
  const { call, layout } = props;
  const names = useAppState((s) => s.callVideoNames);

  return (
    <div data-testid="call-stage-main" className="relative min-h-0 min-w-0 flex-1 p-3 sm:p-4">
      <div className="relative flex size-full items-center justify-center overflow-hidden rounded-2xl bg-card shadow-chip ring-1 ring-border-subtle">
        {layout.empty ? (
          <AvatarCard call={call} />
        ) : (
          // `call-video` sits on the region that exists only when there is something in
          // it, which is the rule this surface has always followed: an empty rectangle for
          // a stream nobody started is worse than no rectangle.
          <div data-testid="call-video" className="flex size-full flex-col gap-2 p-2">
            {layout.shared && (
              <RemoteVideoFrame
                video={layout.shared}
                name={names[layout.shared.mid]}
                className="min-h-0 flex-1"
              />
            )}
            {layout.tiles.length > 0 && (
              <div
                className={cn(
                  "flex flex-wrap items-center justify-center gap-2",
                  // Under a shared screen the faces are a strip; with no screen they ARE
                  // the stage and share the room between them.
                  layout.shared ? "h-24 shrink-0 sm:h-32" : "min-h-0 flex-1",
                )}
              >
                {layout.tiles.map((tile) => (
                  <StageTileFrame
                    key={tile.key}
                    tile={tile}
                    name={tile.kind === "remote" ? names[tile.video.mid] : undefined}
                    className={
                      layout.shared
                        ? "aspect-video h-full shrink-0"
                        : "aspect-video max-h-full min-w-0 flex-1 basis-64"
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* The user's own SCREEN, over the corner of whatever else is on. It is never the
            content itself, and never absent while the capture is live: the only way to
            know what the meeting is seeing is to see it too. */}
        {layout.ownScreen && (
          <LocalVideoFrame
            video={layout.ownScreen}
            // TOP right, because the bottom of this card is where the faces are: a preview
            // that overlapped the strip would hide the people to show the user themselves.
            className="absolute right-4 top-4 aspect-video w-40 shadow-pop sm:w-52"
          />
        )}
      </div>
    </div>
  );
}

function StageTileFrame(props: { tile: StageTile; name?: string; className?: string }) {
  return props.tile.kind === "remote" ? (
    <RemoteVideoFrame video={props.tile.video} name={props.name} className={props.className} />
  ) : (
    <LocalVideoFrame video={props.tile.video} className={props.className} />
  );
}

/** What a call with no picture in it looks like: who it is with, in the middle of the
 *  room, and what it is doing under them. An audio call is most calls. */
function AvatarCard(props: { call: ActiveCall }) {
  const { call } = props;
  return (
    <div
      data-testid="call-stage-avatar"
      className="flex flex-col items-center gap-4 px-6 text-center"
    >
      <CallMark call={call} className="size-24 sm:size-28" />
      <div>
        <p className="text-xl font-semibold text-foreground sm:text-2xl">{callStageTitle(call)}</p>
        <p className="mt-1 text-sm text-text-faint">{callStageSubtitle(call)}</p>
      </div>
    </div>
  );
}

/** Whose call this is, in one mark: a face for a person, and the group glyph for a meeting
 *  or a group call — both carry an empty `peer_mri`, so a face seeded from it would be a
 *  tinted circle standing in for five people. */
function CallMark(props: { call: ActiveCall; className?: string }) {
  const { call } = props;
  if (callNamesAConversation(call)) {
    return (
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary",
          props.className,
        )}
      >
        <HugeiconsIcon icon={UserGroupIcon} className="size-1/2" strokeWidth={1.6} />
      </span>
    );
  }
  return (
    <Avatar
      seed={call.peer_mri}
      label={call.peer}
      photo={call.peer_mri ? { kind: "user", id: call.peer_mri } : undefined}
      fallback="person"
      className={cn("shrink-0", props.className)}
    />
  );
}

// ---------------------------------------------------------------------------
// The people
// ---------------------------------------------------------------------------

function StagePeople(props: { call: ActiveCall; participants: StageParticipant[] }) {
  const lobby = callStageLobbyLabel(props.call);
  return (
    <div data-testid="call-stage-people-panel" className="flex min-h-0 flex-1 flex-col">
      <h2 className="shrink-0 px-4 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-text-faint">
        In this call · {props.participants.length}
      </h2>
      {lobby && (
        <p className="mx-3 mb-2 shrink-0 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          {lobby}
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {props.participants.map((person) => (
          <li
            key={person.key}
            data-testid="call-stage-participant"
            data-you={person.you ? "true" : undefined}
            className="flex items-center gap-2.5 rounded-xl px-2 py-1.5"
          >
            <Avatar
              seed={person.mri || person.name}
              label={person.name}
              photo={person.mri ? { kind: "user", id: person.mri } : undefined}
              // The user's own row takes the faceless coin: this page has no MRI for them —
              // nothing in the payload names it — so there is no photo to ask for, and a
              // monogram of the word "You" reads as somebody's initials.
              initials={person.you ? "?" : undefined}
              fallback="person"
              className="size-8 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{person.name}</span>
            {/* What somebody is sending, from the ROSTER's own streams — never from the
                sections this page happens to have subscribed to. */}
            {person.sharing && (
              <PersonSignal icon={ComputerScreenShareIcon} label="Sharing a screen" />
            )}
            {person.camera && <PersonSignal icon={Video01Icon} label="Camera on" />}
            {person.you && props.call.muted && <PersonSignal icon={MicOff01Icon} label="Muted" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonSignal(props: { icon: IconSvgElement; label: string }) {
  return (
    <span
      title={props.label}
      aria-label={props.label}
      className="grid size-6 shrink-0 place-items-center rounded-md bg-element text-text-dim"
    >
      <HugeiconsIcon icon={props.icon} className="size-3.5" strokeWidth={1.8} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The folded window
// ---------------------------------------------------------------------------

/**
 * The call, folded away: one picture, who it is with, and the two controls somebody who is
 * doing something else still needs — the microphone, and the way out.
 *
 * It is deliberately not every control the page has. A window this size is glanced at, and
 * the rest is one click away in the page it came from.
 */
function MiniWindow(props: { call: ActiveCall; layout: StageLayout; onExpand: () => void }) {
  const { call, layout } = props;
  const controller = useController();
  const names = useAppState((s) => s.callVideoNames);
  const picture = useMemo(() => callMiniPicture(layout), [layout]);

  return (
    <>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-card">
        {picture ? (
          <StageTileFrame
            tile={picture}
            name={picture.kind === "remote" ? names[picture.video.mid] : undefined}
            className="size-full rounded-none"
          />
        ) : (
          <div className="flex size-full items-center justify-center gap-2 px-3">
            <CallMark call={call} className="size-10" />
            <span className="min-w-0 truncate text-sm font-semibold text-foreground">
              {callStageTitle(call)}
            </span>
          </div>
        )}
      </div>
      {/* The bar's height is `MINI_BAR_HEIGHT`, which is what the window's own height is
          measured from: a bar that grew past it would eat the picture instead of the box. */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 px-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold leading-tight text-foreground">
            {callStageTitle(call)}
          </p>
          <p className="truncate text-[11px] leading-tight text-text-faint">
            <MiniStatus call={call} />
          </p>
        </div>
        <StageControl
          testId="call-mute"
          pressed={call.muted}
          tone="warning"
          size="sm"
          label={call.muted ? "Unmute" : "Mute"}
          icon={call.muted ? MicOff01Icon : Mic01Icon}
          onClick={() => void controller.setCallMuted(!call.muted)}
        />
        {/* Only while a recording is running — see RecordControl. */}
        <RecordControl call={call} mini />
        <StageControl
          testId="call-stage-expand"
          size="sm"
          label="Open the call"
          icon={Maximize01Icon}
          onClick={props.onExpand}
        />
        <LeaveButton call={call} />
      </div>
    </>
  );
}

/** The duration once there is one, and what the call is doing until then. */
function MiniStatus(props: { call: ActiveCall }) {
  const now = useNow(!!props.call.connected_at_ms);
  const duration = callDurationLabel(props.call, now);
  return <>{duration || callStageSubtitle(props.call)}</>;
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

/**
 * One round control in the call's own row.
 *
 * They share a component because they are one kind of promise: a click carries out one
 * thing the user just asked for, and what a control READS is the backend's own state
 * (`call.muted`, `call.sending`) rather than this page's memory — which is what makes a
 * second open page, and a phone that reconnects mid-call, draw the same row.
 *
 * `pressed` is absent on the controls that are not switches (fold, open), because
 * `aria-pressed="false"` on a plain button tells a screen reader there is a state to turn
 * on when there is none.
 */
function StageControl(props: {
  testId: string;
  label: string;
  /** The pointer's own sentence, when it has more to say than the label. The one control that
   *  needs it is Record: what it costs — that nobody on the call is told — does not fit in the
   *  words a screen reader should hear as its name. */
  title?: string;
  icon: IconSvgElement;
  pressed?: boolean;
  tone?: "primary" | "warning" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  onClick: () => void;
}) {
  const small = props.size === "sm";
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "grid shrink-0 cursor-pointer place-items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-70",
        small ? "size-8" : "size-9",
        props.pressed
          ? props.tone === "warning"
            ? "bg-warning/15 text-warning hover:bg-warning/25"
            : props.tone === "danger"
              ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
              : "bg-primary/15 text-primary hover:bg-primary/25"
          : props.tone === "danger"
            ? // Record is the one control that wears its colour before it is pressed: it is
              // the one whose result the people on the call cannot see.
              "bg-element text-destructive hover:bg-destructive/15"
            : "bg-element text-text-dim hover:bg-accent hover:text-foreground",
      )}
    >
      <HugeiconsIcon
        icon={props.icon}
        className={small ? "size-3.5" : "size-4"}
        strokeWidth={1.8}
      />
    </button>
  );
}

/**
 * Record this call, and stop recording it.
 *
 * teams-lite's own recording, and the control has to carry that whole fact before it is
 * pressed: the file is made here, kept in this browser, and **nobody on the call is told**
 * (see {@link RECORD_HINT} — Teams' own recording announces itself and this one cannot,
 * because it never touches Teams). It is one press either way; there is no arming, because
 * the thing it starts is stoppable and the thing it stops is kept.
 *
 * Three rules about where it is drawn:
 *
 * - **Only on a call whose audio is up** (`callCanBeRecorded`), because before that there is
 *   nothing to record and a button that produced an empty file would be worse than none.
 * - **Only where the file could be kept** (`recordingsCanBeKept`), which is this browser's
 *   own storage answering. A recording that had nowhere to go is a recording nobody asked
 *   for.
 * - **And in the folded window too, while one is running.** The rest of the page's controls
 *   are deliberately not there — a small window is glanced at — but a recording the user
 *   cannot stop without unfolding the call is the same mistake as a microphone with no
 *   findable off switch, which is why this app has no way to hide a live call at all.
 */
function RecordControl(props: { call: ActiveCall; mini?: boolean }) {
  const { call, mini } = props;
  const controller = useController();
  const canKeep = useAppState((s) => s.recordingsCanBeKept);
  const recording = useAppState((s) => s.callRecording);
  const live = recording && recording.callId === call.id ? recording : null;

  if (!callCanBeRecorded(call)) return null;
  // In the folded window the control exists only while it has something to stop.
  if (mini && !live) return null;
  if (!live && !canKeep) return null;

  if (!live) {
    return (
      <StageControl
        testId="call-record"
        tone="danger"
        label="Record this call"
        title={RECORD_HINT}
        icon={RecordIcon}
        onClick={() => void controller.startCallRecording()}
      />
    );
  }
  // Saving is its own state: writing a long recording out takes a moment, and a control that
  // snapped straight back to "record" in it would invite a second recording of nothing.
  if (mini) {
    return (
      <StageControl
        testId="call-record"
        tone="danger"
        pressed
        size="sm"
        disabled={live.saving}
        label={live.saving ? "Keeping the recording…" : RECORDING_HINT}
        icon={StopIcon}
        onClick={() => void controller.stopCallRecording()}
      />
    );
  }
  return (
    <button
      type="button"
      data-testid="call-record"
      data-recording={live.saving ? "saving" : "true"}
      aria-pressed
      disabled={live.saving}
      aria-label={live.saving ? "Keeping the recording…" : RECORDING_HINT}
      title={live.saving ? "Keeping the recording…" : RECORDING_HINT}
      onClick={() => void controller.stopCallRecording()}
      className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-destructive/15 px-3 text-destructive transition-colors hover:bg-destructive/25 disabled:cursor-default disabled:opacity-70"
    >
      <RecordingDot />
      <span className="text-xs font-semibold tabular-nums" data-testid="call-record-elapsed">
        {live.saving ? "Keeping…" : <RecordingElapsed startedAtMs={live.startedAtMs} />}
      </span>
    </button>
  );
}

/** The dot that says a recording is live. It breathes, because a recording is the one state
 *  on this surface that the user may forget they started — and it holds still under
 *  `prefers-reduced-motion`, where the colour and the elapsed time beside it say it alone. */
function RecordingDot() {
  const reduce = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      className="size-2 shrink-0 rounded-full bg-destructive"
      animate={reduce ? undefined : { opacity: [1, 0.35, 1] }}
      transition={reduce ? undefined : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

/** How long this recording has been going. Its own clock, from its own start: a recording
 *  begun ten minutes into a call is ten minutes shorter than the call. */
function RecordingElapsed(props: { startedAtMs: number }) {
  const now = useNow(true);
  return <>{recordingDurationLabel(Math.max(0, now - props.startedAtMs))}</>;
}

/** The way out. It is the one control here that ends something for everybody, so it is the
 *  one that wears a colour — and in the page it says the word too, because there it has
 *  the room and "leave" is not a shape anybody should have to recognise. */
function LeaveButton(props: { call: ActiveCall; labelled?: boolean }) {
  const controller = useController();
  const label = isMeeting(props.call) ? "Leave the meeting" : "Hang up";
  return (
    <button
      type="button"
      data-testid="call-hangup"
      aria-label={label}
      title={label}
      onClick={() => void controller.hangUpCall()}
      className={cn(
        "flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-destructive/15 text-destructive transition-colors hover:bg-destructive/25",
        props.labelled ? "h-9 px-3" : "size-8",
      )}
    >
      <HugeiconsIcon
        icon={CallEnd01Icon}
        className={props.labelled ? "size-4" : "size-3.5"}
        strokeWidth={1.8}
      />
      {props.labelled && (
        <span className="hidden text-xs font-semibold sm:inline">
          {isMeeting(props.call) ? "Leave" : "End"}
        </span>
      )}
    </button>
  );
}

/** The time this call has been going, and the clock time it started at.
 *
 *  Both, because they answer different questions: the duration is how long the user has
 *  been in it, and the start is what somebody who joined late needs to know how much they
 *  missed. The start goes first on a narrow screen, where the controls need the room. */
function StageClock(props: { call: ActiveCall }) {
  const { call } = props;
  const now = useNow(!!call.connected_at_ms);
  const duration = callDurationLabel(call, now);
  const started = callStartClockLabel(call);
  if (!duration) return null;
  return (
    <p
      data-testid="call-stage-time"
      title={callStageTimeTitle(call, now)}
      className="hidden shrink-0 items-baseline gap-2 rounded-full bg-element px-3 py-1 sm:flex"
    >
      <span
        data-testid="call-duration"
        className="text-sm font-semibold tabular-nums text-foreground"
      >
        {duration}
      </span>
      {started && <span className="hidden text-xs text-text-faint md:inline">since {started}</span>}
    </p>
  );
}

/** A clock that ticks once a second while there is something to count, and not at all
 *  before: a call that is still connecting has no duration to state. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
