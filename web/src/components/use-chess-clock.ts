/**
 * A running clock, without a rules engine anywhere near it.
 *
 * The clocks are pure arithmetic over the thread's own numbers (see lib/chess-clock.ts), so all a
 * surface needs to draw one is a `now` that moves. This hook is that, and it lives in a module of
 * its own for one reason worth stating: the strip of running games under the conversation header
 * draws clocks, and it must not pull `chess.js` into the path of every chat. The board's own hook
 * (use-chess-game.ts) imports the rules engine; this one imports nothing.
 *
 * It ticks only while something is really counting down — a settled game, a game nobody has
 * joined and a game with no clock all cost zero timers — and it stops while the tab is hidden,
 * because a clock nobody can see does not need redrawing sixty times a minute.
 */

import { useEffect, useState } from "react";
import { chessClockReading, chessClockTickMs, type ChessClockReading } from "~/lib/chess-clock";
import { chessClockStateOf, type ChessGame } from "~/lib/chess-thread";

/**
 * What the two clocks of one game read, redrawn as often as they need to be.
 *
 * `frozen` is what the RULES decide and a message cannot: a game that ended in checkmate or
 * stalemate has no settling message behind it, so the derivation still calls it "playing" — and a
 * clock that kept counting down under a finished board would be the one number on screen still
 * claiming the game is on.
 */
export function useChessClock(game: ChessGame | null, frozen = false): ChessClockReading {
  const state = game ? { ...chessClockStateOf(game), settled: frozen || chessClockStateOf(game).settled } : null;
  const [now, setNow] = useState(() => Date.now());

  // The first reading decides the pace: tenths below twenty seconds, quarters above it, and no
  // timer at all when nothing is running.
  const reading = state
    ? chessClockReading(state, now)
    : { white: null, black: null, running: null, flagged: null };
  const tick = chessClockTickMs(reading);

  useEffect(() => {
    if (tick === 0) return;
    // A first read on mount: `now` may be a second old by the time an effect runs.
    setNow(Date.now());
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => setNow(Date.now()), tick);
    };
    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = (): void => {
      // Coming back is the moment the clock is most wrong, so it is read before the timer that
      // will keep it right: the numbers are derived from the thread, so there is nothing to
      // catch up on — one read is the whole answer.
      setNow(Date.now());
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    if (typeof document === "undefined" || document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tick]);

  return reading;
}
