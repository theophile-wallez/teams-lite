/**
 * THE ENGINE, running in a Worker — the only place in this app that starts one.
 *
 * Stockfish is 7.3 MB of WebAssembly the backend fetched and this app's own server hands over (see
 * src/chess_engine.rs and web/engine-file.ts). Here it becomes a Web Worker: the build is a plain
 * worker script that speaks UCI over `postMessage` and finds its own `.wasm` beside itself, so
 * starting it is one `new Worker(url)` and nothing more.
 *
 * Five rules hold it, and each is a decision rather than a mechanism:
 *
 *   - **it is started LAZILY, on the first move it is asked for.** A board with no engine game must
 *     not load 7 MB, and neither must a conversation the reader is only reading.
 *   - **ONE search at a time, and the board owns it.** The hook is used by the mounted board and by
 *     nothing else, so two boards cannot ask for two moves — and an ask that arrives while a search
 *     is out is refused rather than queued, because the position it was about has already changed.
 *   - **it is TERMINATED on the way out**: the reader walking away, the game ending, the component
 *     unmounting. A worker left running holds a wasm instance and a search thread for a board
 *     nobody is looking at.
 *   - **it is BOUNDED**: an engine that answers nothing inside {@link ENGINE_TIMEOUT_MS} is a broken
 *     engine, and the board says so rather than waiting for ever on a move that is never coming.
 *   - **every failure is REPORTED at the board**, in words the reader can act on — the composer's
 *     own rule. A game whose opponent cannot move is otherwise a board that has simply stopped.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chessEngineGo,
  chessEngineSetup,
  chessEngineWorkerUrl,
  parseBestMove,
  type ChessEngineMove,
} from "~/lib/chess-engine";

/** How long one move may take before the engine is called broken. Twenty times the longest search
 *  any rung asks for, so a slow phone is never mistaken for a dead worker. */
export const ENGINE_TIMEOUT_MS = 30_000;

/** What one ask answers: the move, and what the search really cost — which is what the engine's own
 *  clock is charged (the minutes an app was closed are not its thinking time). */
export type ChessEngineAnswer = { move: ChessEngineMove; spentMs: number };

export type ChessEngineApi = {
  /** Ask for a move in one position. Answers null when the engine could not play one — the reason is
   *  in {@link error} by then. */
  ask: (args: { fen: string; elo: number }) => Promise<ChessEngineAnswer | null>;
  /** Whether a search is out right now — what the board draws as "thinking". */
  thinking: boolean;
  /** Why the engine could not move, in one sentence, or null. */
  error: string | null;
};

/**
 * A worker for one board.
 *
 * `workerPath` is the address the BACKEND named (`chess_engine_status.worker_path`), never a string this
 * page assembled — and it is CHECKED before a Worker is made from it (`chessEngineWorkerUrl`),
 * because a Worker is code and a page that accepted any string would run whatever answered.
 */
export function useChessEngine(args: { workerPath: string; enabled: boolean }): ChessEngineApi {
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const configuredRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  // The live search: the resolver its lines are fed to, so the message listener stays one function
  // rather than one per ask.
  const pendingRef = useRef<{
    resolve: (answer: ChessEngineAnswer | null) => void;
    started: number;
    timer: number;
  } | null>(null);

  /** Take the worker down, and answer whatever ask was out. */
  const stop = useCallback((reason: string | null) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    busyRef.current = false;
    configuredRef.current = null;
    if (pending) {
      window.clearTimeout(pending.timer);
      pending.resolve(null);
    }
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) {
      try {
        // `quit` first, so the engine closes its own side; terminate is the belt.
        worker.postMessage("quit");
      } catch {
        /* a worker that already died needs no goodbye */
      }
      worker.terminate();
    }
    if (reason !== null) setError(reason);
    setThinking(false);
  }, []);

  // The reader walked away, the game ended, or this board is gone: nothing keeps a wasm instance
  // alive for a board nobody is looking at.
  useEffect(() => {
    if (!args.enabled) stop(null);
  }, [args.enabled, stop]);
  useEffect(() => () => stop(null), [stop]);
  // A different engine file is a different engine: whatever is running belongs to the old one.
  useEffect(() => {
    return () => stop(null);
  }, [args.workerPath, stop]);

  const ask = useCallback(
    async (request: { fen: string; elo: number }): Promise<ChessEngineAnswer | null> => {
      const url = chessEngineWorkerUrl(args.workerPath);
      if (!args.enabled || !url) return null;
      if (typeof window === "undefined" || typeof Worker === "undefined") return null;
      // ONE search at a time. A second ask is about a position the first has already been asked
      // about, so refusing it is the honest answer rather than queueing a move for a board that has
      // moved on.
      if (busyRef.current) return null;
      busyRef.current = true;
      setThinking(true);

      try {
        if (!workerRef.current) {
          const worker = new Worker(url);
          worker.onerror = () => {
            // The one failure a reader can actually act on: the files are not there, or the wasm
            // would not instantiate. Both look like this.
            stop("The chess engine would not start. Fetch it again from the conversation's menu.");
          };
          worker.onmessage = (event: MessageEvent) => {
            const line = typeof event.data === "string" ? event.data : "";
            if (!line.startsWith("bestmove")) return;
            const pending = pendingRef.current;
            if (!pending) return;
            pendingRef.current = null;
            window.clearTimeout(pending.timer);
            busyRef.current = false;
            setThinking(false);
            const move = parseBestMove(line);
            // `bestmove (none)` is a position with no move in it: the board's own rules have already
            // ended the game, so there is nothing to report and nothing to play.
            pending.resolve(move ? { move, spentMs: Date.now() - pending.started } : null);
          };
          workerRef.current = worker;
        }
        const worker = workerRef.current;
        if (!worker) return null;
        if (configuredRef.current !== request.elo) {
          for (const command of chessEngineSetup(request.elo)) worker.postMessage(command);
          configuredRef.current = request.elo;
        }
        setError(null);
        const answer = await new Promise<ChessEngineAnswer | null>((resolve) => {
          const timer = window.setTimeout(() => {
            // A broken engine, not a slow one: the longest rung searches for 1.2 s.
            stop("The chess engine stopped answering. Its game cannot go on — resign it, or reload.");
          }, ENGINE_TIMEOUT_MS);
          pendingRef.current = { resolve, started: Date.now(), timer };
          for (const command of chessEngineGo(request.fen, request.elo)) worker.postMessage(command);
        });
        return answer;
      } catch (e) {
        stop(
          `The chess engine could not be started: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      } finally {
        if (!pendingRef.current) {
          busyRef.current = false;
          setThinking(false);
        }
      }
    },
    [args.enabled, args.workerPath, stop],
  );

  return { ask, thinking, error };
}
