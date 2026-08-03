import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Wrench } from "lucide-react";
import { agentMarkdownToHtml } from "~/lib/agent-markdown";
import { agentPhaseLabel, agentRunIsLive, type AgentRun } from "~/lib/agent-run";
import type { AgentBackendName } from "~/lib/agent-message";
import { cn } from "~/lib/utils";
import { AgentCoin } from "./agent-logo";
import { RichContent } from "./rich-content";

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
 */

/** The slowest the reveal ever runs, in characters per second. Fast enough to feel like
 *  writing rather than typing, slow enough that a word is a word and not a flicker. */
const MIN_CHARS_PER_SECOND = 65;

/** How long the reveal takes to absorb whatever is waiting. The speed is the backlog
 *  divided by this, so a burst is caught up in about a third of a second however big it
 *  is — which is what keeps the answer from ever falling behind the model. */
const CATCHUP_SECONDS = 0.3;

/** How much of the model's reasoning is shown: the tail, on one line. The whole thing is
 *  a paragraph nobody asked for, and the latest sentence is the informative part. */
const THINKING_TAIL_CHARS = 160;

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
 * What a live run's bubble holds: the answer so far, and a line saying what the agent is
 * doing to grow it.
 *
 * `onSettled` fires once a finished run has nothing left to reveal — the caller then lets
 * the run go and the posted message renders on its own (see `forgetAgentRun`).
 */
export function AgentStream(props: { run: AgentRun; onSettled: () => void }) {
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
      {html ? (
        <RichContent
          html={html}
          tokens
          // The caret rides the last block of the body while the answer is arriving,
          // so it sits at the end of the text rather than under it.
          className={cn(run.phase === "writing" && "agent-streaming")}
        />
      ) : null}
      <AgentStatus run={run} hasBody={html !== ""} />
    </div>
  );
}

/**
 * The line under a live answer: what the agent is doing, and what it is doing it to.
 *
 * It shimmers while the run has nothing else to show — that is the state a reader is
 * actually waiting through, and a static "thinking…" is indistinguishable from a
 * frozen app. Once words are arriving the shimmer stops: the words are the progress
 * indicator, and two competing animations is one too many.
 */
function AgentStatus(props: { run: AgentRun; hasBody: boolean }) {
  const { run } = props;
  const reduce = useReducedMotion();
  const live = agentRunIsLive(run);
  const activity = run.phase === "working" ? run.activity : null;
  // The reasoning stays up while a tool runs, because it is why the tool is running.
  // It goes the moment words start arriving: the answer replaces the account of it.
  const thinking = run.phase === "writing" ? "" : tail(run.thinking, THINKING_TAIL_CHARS);
  const waiting = live && run.phase !== "writing";

  if (run.phase === "error") {
    return (
      <div
        data-testid="agent-error"
        className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive"
      >
        <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
        <span>{agentPhaseLabel(run)}</span>
      </div>
    );
  }
  if (!live) return null;

  return (
    <div
      data-testid="agent-status"
      role="status"
      aria-live="polite"
      className={cn("flex min-w-0 flex-col gap-1 text-xs", props.hasBody && "mt-1.5")}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="typing-dots text-text-dim" aria-hidden="true">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </span>
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
          {run.phase === "working" ? `${run.backend} is working` : agentPhaseLabel(run)}
        </span>
      </div>

      {/* The tool that is running, named. `popLayout` so one call replaces the last
          without the row jumping while both are mounted. */}
      <AnimatePresence initial={false} mode="popLayout">
        {activity ? (
          <motion.span
            key={`${activity.tool}:${activity.target}`}
            data-testid="agent-activity"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: [0.2, 0.65, 0.3, 0.9] }}
            className="flex min-w-0 items-center gap-1.5 self-start rounded-md bg-black/5 px-1.5 py-0.5 text-[11px] text-text-dim dark:bg-white/10"
          >
            <Wrench className="size-3 shrink-0" strokeWidth={1.8} aria-hidden />
            <span className="font-medium">{activity.tool}</span>
            {activity.target ? (
              <span className="min-w-0 truncate font-mono opacity-80">{activity.target}</span>
            ) : null}
          </motion.span>
        ) : null}
      </AnimatePresence>

      {/* The tail of the model's reasoning, on one line, shimmering with the phase it
          belongs to. Data, not prose: it is what the model said to itself. */}
      <AnimatePresence initial={false}>
        {thinking ? (
          <motion.p
            data-testid="agent-thinking"
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.65, 0.3, 0.9] }}
            // Slower and wider than the phase line above it: this is a whole sentence,
            // and a band sized for two words reads as a flicker crossing it.
            className="shimmer shimmer-duration-2600 shimmer-spread-[6rem] min-w-0 overflow-hidden text-[11px] italic text-text-faint"
          >
            {thinking}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The last `max` characters of `text`, cut at a word so the line does not open
 *  mid-word. Empty in, empty out. */
function tail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(flat.length - max);
  const space = cut.indexOf(" ");
  return `…${space > 0 && space < 40 ? cut.slice(space + 1) : cut}`;
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
 * There is deliberately no animation on the "still writing" case. Nothing is arriving —
 * a shimmer would promise a word that is never coming.
 */
export function AgentStoredStatus(props: {
  authorship: { pending: boolean; failure: string | null };
  hasBody: boolean;
}) {
  const { authorship } = props;
  if (authorship.failure) {
    return (
      <div
        data-testid="agent-error"
        className={cn(
          "flex items-start gap-1.5 text-xs text-destructive",
          props.hasBody && "mt-1.5",
        )}
      >
        <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
        <span>{authorship.failure}</span>
      </div>
    );
  }
  if (!authorship.pending) return null;
  return (
    <div
      data-testid="agent-stalled"
      className={cn("text-xs italic text-text-faint", props.hasBody && "mt-1.5")}
    >
      still being written…
    </div>
  );
}

/**
 * The line that says a machine wrote this message.
 *
 * The posted message carries the same fact as text (`— claude, via teams-lite`), and
 * that line is load-bearing in the thread — it is what a colleague in a real Teams
 * client reads. Here it becomes the mark plus the name, which says it in less space and
 * says it before the answer instead of after; the words themselves are removed from the
 * body (see `agentAuthorship`) so the bubble does not state it twice.
 */
export function AgentSignature(props: { backend: AgentBackendName; busy?: boolean }) {
  return (
    <div
      data-testid="agent-signature"
      className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-sender-name"
    >
      <AgentCoin backend={props.backend} busy={props.busy} className="size-5" />
      <span>{props.backend}</span>
      <span className="font-normal text-text-faint">via teams-lite</span>
    </div>
  );
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
export function AgentPendingBubble(props: { run: AgentRun; onSettled: () => void }) {
  const reduce = useReducedMotion();
  return (
    <div className="group mt-2 flex w-full justify-start">
      <motion.div
        data-testid="agent-pending"
        data-conversation-id={props.run.conversation}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.24, ease: [0.2, 0.65, 0.3, 0.9] }}
        className="max-w-[76%] rounded-2xl bg-bubble-incoming px-3.5 py-2 text-sm leading-relaxed text-bubble-incoming-foreground shadow-card ring-1 ring-inset ring-primary/15"
      >
        {/* The same shape a real bubble has, down to the signature sitting inside it —
            this row is replaced by the posted message the moment it arrives, and a
            different layout would make that swap visible. */}
        <AgentSignature backend={props.run.backend as AgentBackendName} busy />
        <AgentStream run={props.run} onSettled={props.onSettled} />
      </motion.div>
    </div>
  );
}
