import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowRight01Icon, CheckIcon, Loading02Icon, StopIcon } from "@hugeicons/core-free-icons";
import { agentMarkdownToHtml } from "~/lib/agent-markdown";
import {
  agentPhaseLabel,
  agentRunIsLive,
  agentTranscriptLabel,
  type AgentRun,
  type AgentStep,
  type AgentTranscript,
} from "~/lib/agent-run";
import { agentDisplayName, type AgentBackendName } from "~/lib/agent-message";
import { agentPersonaNamed } from "~/lib/agent-persona";
import { cn } from "~/lib/utils";
import { AgentCoin, agentShineColor } from "./agent-logo";
import { useAppState } from "./controller-context";
import { RichContent } from "./rich-content";
import { ShineBorder } from "./magicui/shine-border";

/**
 * The agent's reply, as this app draws it.
 *
 * A Teams client can only be shown the message: the backend posts one and edits it
 * about once a second, which is why the thread outside this app fills in a paragraph at
 * a time (`agent_stream_edits` in src/bin/server.rs). This app is on the same machine as
 * the CLI, so it is told the whole run over `agent_stream` — and what it draws is the
 * answer being written: the words as they arrive, the file being read, the model
 * reasoning before it types.
 *
 * Three things are deliberate here.
 *
 * **The reply sits on the left, under the CLI's own mark.** The message is genuinely
 * the user's — it went out through their account, it says so in the thread, and a
 * colleague reading it in Teams sees their name on it. But the user did not write it,
 * and putting it on the right next to the things they did write is the one place this
 * app would be lying to the person it belongs to. So the answer takes the side of
 * everything that arrives rather than the side of everything sent.
 *
 * **The stream is an overlay, never a message.** The row is the posted message; only its
 * body is replaced while a run is live. That is what keeps the reply a single thing in
 * the history: no duplicate to reconcile, no phantom to clean up if a frame is lost, and
 * a reply this app never watched being written renders identically from the message
 * alone.
 *
 * **The reveal is paced by us, not by the model.** Tokens arrive in bursts of wildly
 * uneven size; replayed verbatim they read as a stutter. {@link useSmoothReveal} eases
 * the revealed length toward whatever has arrived, one whole word at a time, and each
 * new word fades in on mount (`.agent-token` in app.css). The effect is the answer
 * being written at a readable, even pace — while the underlying text stays exactly what
 * the CLI said.
 *
 * **The work is a TRANSCRIPT, and it is kept.** The reasoning and the tool calls stream
 * into one scrolling panel above the answer, in the order they happened
 * (`agent::Step`) — so a reader watches the run being worked out rather than watching one
 * line replace the last. It used to be exactly that: a 160-character tail of the
 * reasoning on one truncated line, and one tool chip that the next call pushed out. Every
 * sentence the model wrote and every file it read went past and was gone, which made the
 * most interesting part of a run the part nobody could read.
 *
 * **And it FOLDS when the run ENDS, never while it is going.** The panel is open for as
 * long as there is something arriving into it — the reasoning, the calls, and the answer
 * being written beside them — because that whole stretch is the run a reader is watching.
 * It used to fold the moment the first word of the answer arrived, which took the work
 * away at the one moment it explained what was being written. Once the run is over the
 * answer is all there is to make room for, so the panel becomes one row naming what it
 * holds — and opens again on a click. The fold is automatic and the reader's own click
 * wins over it from then on, because a panel that folded under somebody who had just
 * opened it would be fighting them.
 *
 * The panel is an overlay like everything else here: the Teams message holds the answer
 * and never the reasoning, so the transcript goes when the run does. That is why it is
 * not a disclosure on a stored message — there is nothing behind one to disclose.
 */

/** The slowest the reveal ever runs, in characters per second. Fast enough to feel like
 *  writing rather than typing, slow enough that a word is a word and not a flicker. */
const MIN_CHARS_PER_SECOND = 65;

/** How long the reveal takes to absorb whatever is waiting. The speed is the backlog
 *  divided by this, so a burst is caught up in about a third of a second however big it
 *  is — which is what keeps the answer from ever falling behind the model. */
const CATCHUP_SECONDS = 0.3;

/**
 * How tall the transcript may grow before it scrolls itself, in pixels.
 *
 * A bound is required rather than nice: the panel sits in a virtualized history, and a
 * run that reasons for an hour would otherwise push the whole conversation off screen one
 * frame at a time. Deep enough for a few sentences and the call under them — which is
 * the window that reads as "being written" — and the rest is a scroll away.
 */
const TRANSCRIPT_MAX_HEIGHT = 168;

/** How close to the bottom counts as "still following the run", in pixels. Anything
 *  above that is a reader who scrolled back, and the panel stops dragging them down. */
const TRANSCRIPT_PIN_SLACK = 24;

/**
 * The curve the transcript opens and closes on: a strong ease-out.
 *
 * It moves fast first and settles, which is what makes a fold feel answered rather than
 * played back — the built-in curves are too weak to read as either. The same curve
 * carries the chevron, so the arrow and the rows are one movement and not two.
 */
const TRANSCRIPT_EASE = [0.23, 1, 0.32, 1] as const;

/** How long the panel takes to open, and to close. Both stay well under the 300 ms a
 *  movement in a UI has to finish inside to read as an answer rather than as a replay. */
const TRANSCRIPT_OPEN_SECONDS = 0.26;
const TRANSCRIPT_CLOSE_SECONDS = 0.18;

/**
 * How long a finished run stays on screen after its last word is revealed.
 *
 * Letting go of the run hands the bubble back to the posted message, and those two are
 * the same text — but only once the final edit has been echoed back to us. The backend
 * edits the message before it says the run is done, so this is a margin on top of that
 * for the trouter round-trip, not the mechanism.
 */
const SETTLE_GRACE_MS = 900;

/**
 * The prefix of `text` that is on screen, eased toward the whole of it.
 *
 * Reveals only up to a word boundary, which is why there is no half-written word
 * anywhere: while `live`, the target is the end of the last COMPLETE word, so a token
 * that arrived mid-word waits for its neighbour. `caughtUp` says the whole text is
 * shown, which is how the caller knows a finished run has nothing left to animate.
 *
 * Under `prefers-reduced-motion` there is no reveal at all: the text is simply there.
 */
export function useSmoothReveal(
  text: string,
  live: boolean,
): { revealed: string; caughtUp: boolean } {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(() => (live && !reduce ? 0 : text.length));
  const countRef = useRef(count);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const cancel = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
    const settle = (at: number) => {
      cancel();
      if (countRef.current === at) return;
      countRef.current = at;
      setCount(at);
    };

    // A text that is not an extension of what is on screen was REPLACED, not grown —
    // the CLI's authoritative final answer differing from the streamed pieces, say. An
    // animation would be a lie about which words are new, so it just appears.
    if (!text.startsWith(text.slice(0, countRef.current))) return settle(text.length);
    if (reduce || !live) return settle(text.length);
    if (countRef.current >= text.length) return settle(Math.min(countRef.current, text.length));

    let previous = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.1); // a backgrounded tab: one step
      previous = now;
      const target = lastWordBoundary(text);
      if (countRef.current < target) {
        const speed = Math.max(MIN_CHARS_PER_SECOND, (target - countRef.current) / CATCHUP_SECONDS);
        const next = boundaryAtOrBelow(text, countRef.current + speed * dt, target);
        if (next > countRef.current) {
          countRef.current = next;
          setCount(next);
        }
      }
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return cancel;
  }, [text, live, reduce]);

  const shown = Math.min(count, text.length);
  return { revealed: text.slice(0, shown), caughtUp: shown >= text.length };
}

/** The end of the last complete word — the furthest a still-growing text may be
 *  revealed to. */
function lastWordBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (/\s/.test(text[i] ?? "")) return i + 1;
  }
  return 0;
}

/** The largest word boundary at or below `at`, so a frame never commits half a word.
 *  `target` is allowed exactly, since it is a boundary by construction. */
function boundaryAtOrBelow(text: string, at: number, target: number): number {
  let i = Math.min(Math.floor(at), target);
  if (i >= target) return target;
  while (i > 0 && !/\s/.test(text[i - 1] ?? "")) i -= 1;
  return i;
}

/**
 * What a live run's bubble holds: the answer so far, the work behind it, and a line saying
 * what the agent is doing to grow it.
 *
 * `onSettled` fires once a finished run has nothing left to reveal — the caller then lets
 * the run go and the posted message renders on its own (see `forgetAgentRun`), keeping the
 * transcript beside it.
 *
 * `transcriptOpen` / `onTranscriptToggle` are the reader's own fold, held by the caller
 * because this component is remounted twice over: once when the run is let go and the
 * message takes over the body, and again whenever the virtualized history scrolls the row
 * away. `null` means they have not said, which is what leaves the fold automatic.
 */
export function AgentStream(props: {
  run: AgentRun;
  onSettled: () => void;
  transcriptOpen?: boolean | null;
  onTranscriptToggle?: (open: boolean) => void;
  /** Stop this run, if the surface can. Absent where a run cannot be reached (a stored
   *  transcript has no live run to stop); present on every live bubble, phone included.
   *  Returns the ask so the button can re-enable itself on a real failure. */
  onStop?: () => Promise<unknown>;
}) {
  const { run } = props;
  const live = agentRunIsLive(run);
  const { revealed, caughtUp } = useSmoothReveal(run.text, live);
  const settled = !live && caughtUp;

  // Hand the run back once its last word is on screen — after the paint that completed
  // it, and after a beat (see {@link SETTLE_GRACE_MS}). Doing it during the render would
  // drop this component's own text out from under it.
  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => props.onSettled(), SETTLE_GRACE_MS);
    return () => clearTimeout(timer);
    // `onSettled` is a stable callback from the pane; re-running on its identity would
    // hand the same run back twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  const html = revealed.trim() ? agentMarkdownToHtml(revealed) : "";
  return (
    <div data-testid="agent-stream" data-phase={run.phase}>
      {/* Above the answer, because it is how the answer was reached. The run is handed in
          only while it is going: a finished one is a transcript like any other, and the
          panel then says what it holds rather than what is happening. */}
      <TranscriptPanel
        steps={run.steps}
        run={live ? run : null}
        folded={agentTranscriptLabel(run.steps, run.tools_used)}
        open={props.transcriptOpen ?? null}
        onChoose={props.onTranscriptToggle ?? (() => undefined)}
        onStop={live ? props.onStop : undefined}
      />
      {html ? (
        <RichContent
          html={html}
          tokens
          // The caret rides the last block of the body while the answer is arriving,
          // so it sits at the end of the text rather than under it.
          className={cn(run.phase === "writing" && "agent-streaming")}
        />
      ) : null}
      <AgentFailure run={run} />
    </div>
  );
}

/**
 * How wide the travelling light is, and how long one pass round the bubble takes.
 *
 * Two pixels, not one: it rides the hairline the agent's bubble already wears, and a
 * light no wider than that ring is one a reader has to be told about before they can see
 * it. Six seconds is a lap slow enough to read as a light going round an edge rather than
 * a flicker, and quick enough that a glance at the thread catches it somewhere.
 */
const SHINE_WIDTH = 2;
const SHINE_SECONDS = 6;

/**
 * The bubble's own edge, catching the light while an answer is being written into it
 * (magicui's ShineBorder, in components/magicui/shine-border.tsx).
 *
 * It carries the fact the breathing mark carries, in the one place that covers the whole
 * message: on a long answer the signature scrolls out of the top of the bubble, and the
 * edge is still there to say which message is live.
 *
 * Two things about it are this app's and not the component's. The colour is the CLI's
 * (see {@link agentShineColor}), so the edge and the mark inside the bubble are the same
 * vendor. And under `prefers-reduced-motion` it is not drawn AT ALL rather than merely
 * held still — stopped, the sweep is a smear of colour over one corner, which reads as a
 * rendering fault instead of a light. That second one is `.agent-shine` in app.css and not
 * a check here on purpose: the OS query then takes effect on its own, with no render in
 * between, which is what a reader who changes the setting with the app open gets.
 */
export function AgentBubbleShine(props: { backend: string }) {
  return (
    <ShineBorder
      data-testid="agent-shine"
      data-backend={props.backend}
      className="agent-shine"
      borderWidth={SHINE_WIDTH}
      duration={SHINE_SECONDS}
      shineColor={agentShineColor(props.backend)}
    />
  );
}

/**
 * The failure of a run, under whatever it managed to write.
 *
 * It sits below the answer rather than in the transcript above it: what went wrong is
 * about the answer the reader was promised, not about the reasoning that led there.
 *
 * There is deliberately no animation on it — nothing more is arriving.
 */
function AgentFailure(props: { run: AgentRun }) {
  if (props.run.phase !== "error") return null;
  return (
    <div
      data-testid="agent-error"
      className="mt-2 flex items-start gap-1.5 text-xs text-destructive"
    >
      <HugeiconsIcon
        icon={Alert02Icon}
        className="mt-px size-3.5 shrink-0"
        strokeWidth={1.8}
        aria-hidden
      />
      <span>{agentPhaseLabel(props.run)}</span>
    </div>
  );
}

/**
 * The folded transcript of a reply that is FINISHED, above the message's own body.
 *
 * The run is over — the app let it go and the Teams message is the record again — but what
 * the agent worked out is still worth having, so the panel outlives the overlay: one row
 * saying what it holds, opening on a click into the same rows the run streamed into.
 *
 * It exists for as long as this page does and no longer, because the Teams message holds
 * the answer and never the reasoning (see {@link AgentTranscript}). A reply answered from a
 * phone, or before this page loaded, has no panel at all — which is the honest shape: there
 * is nothing behind one to disclose.
 */
export function AgentStoredTranscript(props: {
  transcript: AgentTranscript;
  open: boolean | null;
  onChoose: (open: boolean) => void;
}) {
  const { transcript } = props;
  return (
    <TranscriptPanel
      steps={transcript.steps}
      run={null}
      folded={agentTranscriptLabel(transcript.steps, transcript.tools_used)}
      open={props.open}
      onChoose={props.onChoose}
    />
  );
}

/**
 * The run being worked out: what the agent is doing, and everything it has done.
 *
 * The header is the status line this component grew out of. It shimmers while the run has
 * nothing else to show — that is the state a reader is actually waiting through, and a
 * static "thinking…" is indistinguishable from a frozen app. Once words are arriving the
 * shimmer stops: the words are the progress indicator, and two competing animations is one
 * too many. There is no spinner beside it for the same reason.
 *
 * Under it, the transcript: the model's reasoning as it is written, and a row for every
 * tool call, in the order they happened. Five things hold it together.
 *
 * - **It scrolls itself, and only while the reader is following it.** The panel has a
 *   ceiling ({@link TRANSCRIPT_MAX_HEIGHT}) because it sits in a virtualized history that
 *   an unbounded bubble would push around; a reader who scrolls back inside it is left
 *   where they are, because dragging them to the newest line is how a transcript becomes
 *   unreadable.
 * - **The header names the newest call only while the rows are folded.** Open, the rows
 *   say it better than a label can, and stating it twice makes the panel look like it is
 *   reporting two things.
 * - **The fold is automatic ONCE — at the end of the run — and then the reader owns it.**
 *   The panel stays open for as long as anything is arriving into it, because that is the
 *   stretch a reader is watching; it closes when the run does, on the curve
 *   {@link TRANSCRIPT_EASE} names. Nothing re-folds a panel somebody opened — which is why
 *   the choice is the CALLER's to hold: this component is remounted when the run is let go,
 *   and again on every pass of the virtualized history.
 * - **It outlives the run.** The same rows are drawn from the kept transcript once the
 *   overlay is gone (see {@link AgentStoredTranscript}), so a reply keeps its disclosure
 *   for as long as the page is open.
 * - **The reasoning is data, not prose.** It is what the model said to itself, so it is
 *   set small, dim and italic, and no Markdown is applied to it — a heading the model
 *   happened to type is not a heading in this app's voice.
 */
/**
 * Stop the run being written into this bubble.
 *
 * It sits on the live bubble's own header, so it is reachable from any client watching a
 * run — a phone included, which is the whole point of the feature: most runs are asked for
 * from one. Pressing it asks the backend to stop; the run then finalizes with the answer
 * so far and a "stopped by you" note, and the overlay tears down the same way a finished
 * run's does. So there is nothing to do on success but wait for that terminal frame — the
 * button says "Stopping…" and stays disabled until the run ends under it, which unmounts it.
 *
 * A backend that does not own the run answers `stopped: false` (it is streaming on the
 * other install, say); that is not an error, and the button simply settles when the frame
 * that ends the run arrives. A real REJECTION re-enables it, because a Stop that silently
 * did nothing is worse than one the reader can press again — and a double-press is guarded
 * by the `asked` state, since the second click reaches the same live run.
 */
function AgentStopButton(props: { onStop: () => Promise<unknown> }) {
  const [asked, setAsked] = useState(false);
  return (
    <button
      type="button"
      data-testid="agent-stop"
      disabled={asked}
      onClick={() => {
        setAsked(true);
        // Re-enable only on a real failure; success is followed by the run ending, which
        // unmounts this button — leaving it disabled until then is the honest state.
        void props.onStop().catch(() => setAsked(false));
      }}
      title="Stop this run"
      aria-label="Stop this run"
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-text-faint hover:bg-black/5 hover:text-text disabled:opacity-60 dark:hover:bg-white/10"
    >
      <HugeiconsIcon icon={StopIcon} className="size-3.5" strokeWidth={2} aria-hidden />
      {asked ? "Stopping…" : "Stop"}
    </button>
  );
}

function TranscriptPanel(props: {
  steps: AgentStep[];
  /** The run, while it is going. `null` once it is over — a kept transcript has no phase,
   *  nothing is arriving into it, and the header stops saying otherwise. */
  run: AgentRun | null;
  /** What the folded row says (see {@link agentTranscriptLabel}). */
  folded: string;
  /** The reader's own fold, or `null` while they have not said. Held by the caller, per
   *  message: this panel is remounted when the run is let go and again on every scroll
   *  through a virtualized history, and a fold that reset there would fight the reader. */
  open: boolean | null;
  onChoose: (open: boolean) => void;
  /** Stop the run, when there is one to stop. Absent on a stored transcript. */
  onStop?: () => Promise<unknown>;
}) {
  const { run } = props;
  const reduce = useReducedMotion();
  const live = !!run && agentRunIsLive(run);
  const has = props.steps.length > 0;
  const waiting = live && run?.phase !== "writing";
  // Open for the whole run, and folded once it is over — the answer is then all there is
  // to make room for, and nothing is arriving into the panel any more. The reader's own
  // choice wins over that, which is what `open === null` leaves room for.
  const open = has && (props.open ?? live);

  const box = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const follow = useCallback(() => {
    const el = box.current;
    if (!el || !following.current) return;
    el.scrollTop = el.scrollHeight;
  }, []);
  // A fold unmounts the rows, so re-opening starts at the top of them. The reader asked to
  // see the run, which means its newest line: following resumes with the panel.
  useEffect(() => {
    if (!open) return;
    following.current = true;
    follow();
  }, [follow, open]);
  // A new row (a tool call, a thought opening after one) scrolls the panel down; a thought
  // that is still growing does it through {@link AgentThought}'s own `onGrow`, since the
  // reveal runs in that component and never re-renders this one.
  useEffect(follow, [follow, props.steps.length]);

  // The rows that were already there when the panel opened ride the panel's own animation;
  // only a row that ARRIVES while it is open animates in of its own accord. Both at once
  // is two animations for one event, which reads as a stutter — and on a fold re-opened
  // over a long run it is a dozen of them.
  const ridden = useRef(props.steps.length);
  useEffect(() => {
    if (!open) ridden.current = props.steps.length;
  }, [open, props.steps.length]);

  if (!live && !has) return null;

  // What the header says, in the three cases that each answer a different question:
  //   - live, and open: what the run is doing, since the rows below say what it has done;
  //   - live, folded by the reader, and still thinking or working: the same, because those
  //     rows are out of sight and a tool call the reader cannot see is a wait with no
  //     stated cause;
  //   - folded by the reader while the answer arrives, or after the run: what the fold
  //     HOLDS, which is what a reader clicks it for. The caret at the end of the answer
  //     already says it is being written, so the header does not spend its line on that.
  const label =
    run && live && (open || waiting)
      ? open && run.phase === "working"
        ? `${agentDisplayName(run.backend)} is working`
        : agentPhaseLabel(run)
      : props.folded;
  // The last thought is the only one that can still be growing, so it is the only one
  // whose text is revealed rather than simply shown.
  const growing = lastThoughtIndex(props.steps);

  // The collapse: the box's own height, and the words fading with it. Four things about
  // that pair, and not one of them is Motion's to choose for us.
  //
  // The height carries the movement, because that IS the movement — a rail of text sliding
  // out from under a chevron — and it is animated rather than transitioned because only
  // Motion knows what `auto` measures to. The close is SHORTER than the open: opening is
  // the reader asking to read something, closing is the app getting out of their way. The
  // exit states its own timing inside `exit` rather than reading `open`, since an exiting
  // child keeps the props of the last render it was in and would otherwise close on the
  // opening curve. And the opacity is quicker than the height and led by it on the way in,
  // so the rows are only legible inside a box with room for them: a cross-fade at full
  // height is what makes one panel look like two.
  const opening = reduce
    ? { opacity: 1, transition: { duration: 0 } }
    : {
        opacity: 1,
        height: "auto",
        transition: {
          height: { duration: TRANSCRIPT_OPEN_SECONDS, ease: TRANSCRIPT_EASE },
          opacity: { duration: 0.16, ease: "linear", delay: 0.05 },
        },
      };
  const closing = reduce
    ? { opacity: 0, transition: { duration: 0 } }
    : {
        opacity: 0,
        height: 0,
        transition: {
          height: { duration: TRANSCRIPT_CLOSE_SECONDS, ease: TRANSCRIPT_EASE },
          opacity: { duration: 0.12, ease: "linear" },
        },
      };

  return (
    <div
      data-testid="agent-transcript"
      data-open={open}
      className="mb-1.5 flex min-w-0 flex-col text-xs"
    >
      {/* Announced while the run is going, and silent once it is not: the folded row of a
          finished run is a label, not news. The testid says the same thing — it is the
          live status, and a client that outlives it (see `onSettled`) has no status. */}
      <div
        data-testid={live ? "agent-status" : undefined}
        role={live ? "status" : undefined}
        aria-live={live ? "polite" : undefined}
        className="flex min-w-0 items-center gap-2"
      >
        <button
          type="button"
          data-testid="agent-transcript-toggle"
          // A header with nothing behind it is not a control: a run whose CLI reports no
          // reasoning and has called nothing has only this line to show.
          disabled={!has}
          aria-expanded={has ? open : undefined}
          onClick={() => props.onChoose(!open)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded text-left",
            has && "hover:text-text",
          )}
        >
          {has ? (
            <motion.span
              className="flex shrink-0 items-center text-text-faint"
              animate={{ rotate: open ? 90 : 0 }}
              initial={false}
              transition={
                reduce
                  ? { duration: 0 }
                  : {
                      duration: open ? TRANSCRIPT_OPEN_SECONDS : TRANSCRIPT_CLOSE_SECONDS,
                      ease: TRANSCRIPT_EASE,
                    }
              }
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden
              />
            </motion.span>
          ) : null}
          <span
            data-testid="agent-phase"
            // shadcn's `shimmer` (ui.shadcn.com/docs/utils/shimmer): it paints the text
            // out of `currentColor` and sweeps a brighter copy of it across, so the colour
            // class stays — it is what the highlight is derived from — and the dark theme
            // needs nothing said about it. `prefers-reduced-motion` is handled by the
            // utility itself, which is why only `waiting` gates it here.
            className={cn(
              "min-w-0 truncate text-text-dim",
              waiting && "shimmer shimmer-duration-2100",
            )}
          >
            {label}
          </span>
        </button>
        {props.onStop ? <AgentStopButton onStop={props.onStop} /> : null}
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="steps"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={opening}
            exit={closing}
            className="overflow-hidden"
          >
            <div
              ref={box}
              data-testid="agent-transcript-steps"
              // `overscroll-contain`: the panel is a scroller inside the history's own
              // scroller, and without it reaching the end of the reasoning would carry on
              // into the conversation.
              onScroll={(event) => {
                const el = event.currentTarget;
                following.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight <= TRANSCRIPT_PIN_SLACK;
              }}
              style={{ maxHeight: TRANSCRIPT_MAX_HEIGHT }}
              // A rail rather than a box: the transcript is an aside to the answer under
              // it, and a second card inside a bubble reads as a second message. It hangs
              // under the chevron, so the fold and what it holds line up.
              className="ml-[7px] mt-1 flex min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain border-l border-black/15 pl-2.5 dark:border-white/20"
            >
              {/* Keyed by position, because that is what a step IS: the transcript only
                  ever grows at its end. The one exception is its own cap dropping the
                  oldest rows (`MAX_TOOL_CALLS`), which shifts the rest — a re-mount, and
                  the only thing it costs is a fade on rows already read. */}
              {props.steps.map((step, index) =>
                step.kind === "thought" ? (
                  <AgentThought
                    key={index}
                    text={step.text}
                    live={live && index === growing}
                    onGrow={follow}
                  />
                ) : (
                  <AgentToolRow
                    key={index}
                    step={step}
                    reduce={!!reduce}
                    entering={index >= ridden.current}
                  />
                ),
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Where the last thought sits, or `-1`. Only that one can still be growing. */
function lastThoughtIndex(steps: AgentStep[]): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.kind === "thought") return i;
  }
  return -1;
}

/**
 * One stretch of the model's reasoning, revealed at the pace the answer is.
 *
 * The same easing as the answer ({@link useSmoothReveal}), because it is the same act: a
 * text arriving in bursts of uneven size, read by somebody watching it appear. `onGrow`
 * is how the panel above follows it — the reveal ticks in here, so this is the only place
 * that knows a line was added.
 */
function AgentThought(props: { text: string; live: boolean; onGrow: () => void }) {
  const { onGrow } = props;
  const { revealed } = useSmoothReveal(props.text, props.live);
  useEffect(() => {
    onGrow();
  }, [revealed, onGrow]);
  if (!revealed.trim()) return null;
  return (
    <p
      data-testid="agent-thinking"
      className="min-w-0 whitespace-pre-wrap break-words text-[11px] italic leading-relaxed text-text-faint"
    >
      {revealed}
    </p>
  );
}

/**
 * One tool call: what it was, what it was pointed at, and whether it is still running.
 *
 * A finished call keeps its row — the whole point of a transcript — and says so with a
 * tick, while the one in flight spins. The two states are what tells a reader whether the
 * wait they are in is this call's fault.
 *
 * `entering` is false for a row the panel opened WITH: it is then already where it belongs
 * and the panel's own collapse is the animation (see {@link TranscriptPanel}).
 */
function AgentToolRow(props: {
  step: Extract<AgentStep, { kind: "tool" }>;
  reduce: boolean;
  entering: boolean;
}) {
  const { step } = props;
  return (
    <motion.span
      data-testid="agent-activity"
      data-done={step.done}
      // `false`: straight to where it belongs, with no animation of its own.
      initial={!props.entering ? false : props.reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={props.entering ? { duration: 0.18, ease: TRANSCRIPT_EASE } : { duration: 0 }}
      // `max-w-full` is load-bearing next to `self-start`: a flex item aligned to the
      // start is sized by its content, so a chip naming a long path would grow straight
      // through the bubble's edge instead of ellipsising inside it.
      className="flex min-w-0 max-w-full items-center gap-1.5 self-start rounded-md bg-black/5 px-1.5 py-0.5 text-[11px] text-text-dim dark:bg-white/10"
    >
      <HugeiconsIcon
        icon={step.done ? CheckIcon : Loading02Icon}
        className={cn("size-3 shrink-0", !step.done && "animate-spin")}
        strokeWidth={1.8}
        aria-hidden
      />
      <span className="font-medium">{step.tool}</span>
      {step.target ? (
        <span className="min-w-0 truncate font-mono opacity-80">{step.target}</span>
      ) : null}
    </motion.span>
  );
}

/**
 * The status line of a reply nobody watched being written.
 *
 * Most replies are this one: the run happened while the app was closed, or on another
 * device, or before this page loaded — the feature exists so the user can ask from their
 * phone. Everything shown here comes from the message itself (see `agentAuthorship`), so
 * it is exactly as informative as the thread is: an answer that was still being written
 * when the run died says so, and a failure says why.
 *
 * The WORDS here never animate. Nothing is arriving into this page, so a shimmer on the
 * line — or a caret at the end of the answer — would promise the next word at a pace this
 * app is not being fed at. What does say the answer is unfinished is the bubble's own edge
 * ({@link AgentBubbleShine}): a run somewhere else is still a run, and one moving hairline
 * around the whole message claims less than a line of text pretending to be live.
 */
export function AgentStoredStatus(props: {
  authorship: { pending: boolean; failure: string | null };
}) {
  const { authorship } = props;
  if (authorship.failure) {
    return (
      <div
        data-testid="agent-error"
        className="mt-2 flex items-start gap-1.5 text-xs text-destructive"
      >
        <HugeiconsIcon
          icon={Alert02Icon}
          className="mt-px size-3.5 shrink-0"
          strokeWidth={1.8}
          aria-hidden
        />
        <span>{authorship.failure}</span>
      </div>
    );
  }
  if (!authorship.pending) return null;
  return (
    <div
      data-testid="agent-stalled"
      className="mt-2 text-xs italic text-text-faint"
    >
      still being written…
    </div>
  );
}

/**
 * The line that says who wrote this message: the CLI's mark and name, then whose request
 * it answers.
 *
 * It stands where a sender's name stands on any other incoming bubble, and it carries
 * one more fact than a name can — "Claude by Théophile WALLEZ" names both the machine
 * that wrote the words and the account that posted them, which is exactly the pair a
 * reader of this thread needs.
 *
 * The posted message says the same thing as text (`— claude, via teams-lite`), and that
 * line is load-bearing in the THREAD: it is what a colleague in a real Teams client
 * reads. It is not repeated here, because here the mark says it — the words are stripped
 * from the body (see `agentAuthorship`) rather than shown twice.
 */
export function AgentSignature(props: {
  backend: AgentBackendName;
  /** The CUSTOM AGENT that answered, by address — read out of the message's own signature
   *  (`agentAuthorship`), never looked up. So a reply keeps the name it answered under even
   *  after the user renames or deletes that agent, and one answered on another machine draws
   *  its name too. */
  persona?: string | null;
  /** Whose message the agent answered — the account the reply went out under. */
  author?: string;
  busy?: boolean;
}) {
  const author = props.author?.trim();
  const label = usePersonaSignatureLabel(props.persona);
  return (
    <div
      data-testid="agent-signature"
      data-persona={props.persona ?? undefined}
      className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-sender-name"
    >
      <AgentCoin
        backend={props.backend}
        persona={props.persona}
        busy={props.busy}
        className="size-4"
      />
      <span>{label ?? agentDisplayName(props.backend)}</span>
      {/* A custom agent names the CLI behind it in the faint half of the line, where the
          author's name goes: "Natacha · claude by Théophile". Which program answered is part
          of the authorship this line exists to state — a name the user invented says nothing
          about what ran. */}
      {props.persona ? (
        <span className="shrink-0 font-normal text-text-faint">{agentDisplayName(props.backend)}</span>
      ) : null}
      {author ? <span className="min-w-0 truncate font-normal text-text-faint">by {author}</span> : null}
    </div>
  );
}

/** The name a persona's reply is drawn under: its label if this machine still holds the
 *  record, else the address the signature carried. Never the provider's name — that would
 *  rewrite a reply the reader watched being written. */
function usePersonaSignatureLabel(name: string | null | undefined): string | null {
  const agent = useAppState((s) => s.agent);
  if (!name) return null;
  return agentPersonaNamed(agent, name)?.label ?? name;
}

/**
 * The bubble a run gets before its posted message has reached us.
 *
 * The backend posts the placeholder before it starts the CLI, so this is a window of
 * about a second — the time it takes Teams to echo our own message back through the
 * trouter. It is worth drawing anyway: the alternative is a thread that shows nothing
 * at all right after the user asked, which reads as a feature that ignored them. It is
 * also the fallback if that echo is ever lost.
 */
export function AgentPendingBubble(props: {
  run: AgentRun;
  /** Whose request it answers — the pane reads it off the newest message of ours, since
   *  this row has no message of its own yet. */
  author?: string;
  onSettled: () => void;
  transcriptOpen?: boolean | null;
  onTranscriptToggle?: (messageId: string, open: boolean) => void;
  /** Stop the run this row is drawing. Threaded through like the toggle so the button is
   *  the same one the posted message's bubble shows once Teams echoes it back. */
  onStop?: (runId: string) => Promise<unknown>;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="group mt-2 flex w-full justify-start">
      <motion.div
        data-testid="agent-pending"
        data-conversation-id={props.run.conversation}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.24, ease: [0.2, 0.65, 0.3, 0.9] }}
        className="relative max-w-[76%] rounded-2xl bg-bubble-incoming px-3.5 py-2 text-sm leading-relaxed text-bubble-incoming-foreground shadow-card ring-1 ring-inset ring-primary/15"
      >
        {/* The same edge the posted message's bubble lights while a run writes into it
            (see the mount in message-bubble.tsx). This row is replaced by that bubble the
            moment Teams echoes the placeholder back, and a light that started only then
            would draw attention to a swap the user is not meant to see. */}
        {agentRunIsLive(props.run) ? <AgentBubbleShine backend={props.run.backend} /> : null}

        {/* The same shape a real bubble has, down to the signature sitting inside it —
            this row is replaced by the posted message the moment it arrives, and a
            different layout would make that swap visible. */}
        <AgentSignature
          backend={props.run.backend as AgentBackendName}
          persona={props.run.persona}
          author={props.author}
          busy
        />
        <AgentStream
          run={props.run}
          onSettled={props.onSettled}
          transcriptOpen={props.transcriptOpen ?? null}
          onTranscriptToggle={(open) => props.onTranscriptToggle?.(props.run.message_id, open)}
          onStop={props.onStop ? () => props.onStop!(props.run.run_id) : undefined}
        />
      </motion.div>
    </div>
  );
}
