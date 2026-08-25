/**
 * WHAT THE ENGINE IS ASKED, and how strong it plays — the pure half.
 *
 * Stockfish is a program that reads UCI on its standard input, and in this app it is a Web Worker
 * the browser talks to over `postMessage` (see components/use-chess-engine.ts, which is the only
 * place a Worker exists). Everything that can be decided WITHOUT one lives here: which strengths are
 * offered, the exact commands each strength sends, and how an answer is read back. That split is
 * what lets the whole protocol be unit-tested with no Worker, no WebAssembly and no download.
 *
 * **THE STRENGTH SCALE IS THE ENGINE'S OWN, and its floor is 1320.** Measured off the binary
 * (`option name UCI_Elo type spin default 1320 min 1320 max 3190`), so the picker offers nothing
 * outside it and the page says so rather than pretending a weaker setting exists. `Skill Level`
 * exists too and reaches lower, but it is a DIFFERENT mechanism that `UCI_LimitStrength` overrides —
 * setting both would leave the reader with a strength neither number describes, so this app sets one
 * and states its limit.
 */

/** One rung the picker offers. */
export type ChessEngineStrength = {
  /** The Elo the engine is asked for. It IS the label: the reader picked a number. */
  elo: number;
  /** A word for the two ends of the scale, where the number alone says nothing. */
  note?: string;
  /** How long the engine may search for one move, in ms. A weak engine thinking for a second is
   *  still weak, and a short search keeps a game against it feeling like a game. */
  movetimeMs: number;
};

/** The engine's own bounds, MEASURED off `uci` (and pinned again in src/chess_engine.rs). */
export const CHESS_ENGINE_MIN_ELO = 1320;
export const CHESS_ENGINE_MAX_ELO = 3190;

/**
 * The rungs, from the engine's floor to its full strength.
 *
 * Seven, because a picker is a row of presses and nine was already the clock's: the numbers are
 * spread widely enough that two neighbouring rungs really play differently, which is the only thing
 * a rung has to earn.
 */
export const CHESS_ENGINE_STRENGTHS: ChessEngineStrength[] = [
  { elo: 1320, note: "the engine's floor", movetimeMs: 100 },
  { elo: 1500, movetimeMs: 150 },
  { elo: 1800, movetimeMs: 250 },
  { elo: 2100, movetimeMs: 400 },
  { elo: 2400, movetimeMs: 600 },
  { elo: 2700, movetimeMs: 900 },
  { elo: CHESS_ENGINE_MAX_ELO, note: "full strength", movetimeMs: 1200 },
];

/** What the picker opens on. Around a club player: strong enough to punish a blunder, beatable by
 *  somebody who is paying attention — which is what "a game against the computer" should mean. */
export const CHESS_ENGINE_DEFAULT_ELO = 1800;

/** The rung nearest a stated Elo, so a game opened by another build still plays at a sane strength
 *  and a number outside the engine's range is CLAMPED rather than refused: the game is real either
 *  way, and refusing to move would strand it. */
export function chessEngineStrengthFor(elo: number): ChessEngineStrength {
  const wanted = Math.min(CHESS_ENGINE_MAX_ELO, Math.max(CHESS_ENGINE_MIN_ELO, Math.round(elo)));
  let best = CHESS_ENGINE_STRENGTHS[0] as ChessEngineStrength;
  for (const rung of CHESS_ENGINE_STRENGTHS) {
    if (Math.abs(rung.elo - wanted) < Math.abs(best.elo - wanted)) best = rung;
  }
  // The Elo the GAME states is what is asked for, not the rung's own: the rung only decides how
  // long the search may take. A game at 1750 plays at 1750.
  return { ...best, elo: wanted };
}

/** How much memory the engine may use, in MiB. Small deliberately: this runs on a PHONE as well as
 *  a laptop, the default is 16, and a hash table bigger than the position needs buys a weak engine
 *  nothing. */
export const CHESS_ENGINE_HASH_MB = 16;

/**
 * The commands that configure one strength, in order — sent once per worker and again whenever the
 * strength changes.
 *
 * `UCI_LimitStrength` is what makes `UCI_Elo` mean anything, and it is switched OFF at the top rung:
 * a reader who picked full strength asked for the engine's own best rather than for a cap that
 * happens to sit at its maximum.
 */
export function chessEngineSetup(elo: number): string[] {
  const strength = chessEngineStrengthFor(elo);
  const limited = strength.elo < CHESS_ENGINE_MAX_ELO;
  return [
    "uci",
    `setoption name Hash value ${CHESS_ENGINE_HASH_MB}`,
    `setoption name UCI_LimitStrength value ${limited ? "true" : "false"}`,
    ...(limited ? [`setoption name UCI_Elo value ${strength.elo}`] : []),
    "isready",
  ];
}

/**
 * What to ask for one position.
 *
 * The POSITION is a FEN rather than `startpos moves …`, and that is the one decision here worth
 * arguing: this app's board already holds the position as a FEN (the replay computes one per ply),
 * a FEN is one line whatever the game's length, and it cannot disagree with the board the reader is
 * looking at. `startpos moves …` would mean converting every SAN in the game to UCI on every ask —
 * a second spelling of the move list, and a fiftieth-move bug waiting to happen.
 *
 * The cost is stated: with a FEN the engine cannot see the repetition history, so it may claim a
 * draw by repetition later than a full game record would. In a game against a 1320 engine that is
 * a trade nobody notices.
 */
export function chessEngineGo(fen: string, elo: number): string[] {
  return [`position fen ${fen}`, `go movetime ${chessEngineStrengthFor(elo).movetimeMs}`];
}

/** A move the engine answered with, in UCI's own spelling. */
export type ChessEngineMove = { from: string; to: string; promotion?: "q" | "r" | "b" | "n" };

/**
 * The move on a `bestmove` line, or null for any other line the engine prints.
 *
 * `bestmove e7e8q ponder …` is the whole shape: two squares and an optional promotion letter. A
 * `bestmove (none)` — which is what a mated position answers — is null, because there is no move to
 * play and the board's own rules have already ended the game.
 */
export function parseBestMove(line: string): ChessEngineMove | null {
  const match = /^bestmove\s+([a-h][1-8])([a-h][1-8])([qrbn])?/.exec(line.trim());
  if (!match) return null;
  const promotion = match[3] as "q" | "r" | "b" | "n" | undefined;
  return {
    from: match[1] as string,
    to: match[2] as string,
    ...(promotion ? { promotion } : {}),
  };
}

/**
 * Where the engine's own files are served from — this app's own origin, one directory per engine
 * version, because the glue finds its `.wasm` beside itself (see web/engine-file.ts).
 *
 * The BACKEND names the path (`chess_engine_status.worker_path`), so this only guards it: a page that
 * accepted any string here would create a Worker from whatever a backend answered, and a Worker is
 * code. It must be an absolute path on this origin under the engine's own route — never a URL with a
 * host in it, and never a path that climbs out.
 */
export function chessEngineWorkerUrl(workerPath: string): string | null {
  if (!workerPath.startsWith("/__engine/")) return null;
  if (workerPath.includes("..") || workerPath.includes("//")) return null;
  return workerPath;
}

/** What the backend says about the engine on this machine (the `chess_engine_status` answer). */
export type ChessEngineState = {
  label: string;
  version: string;
  present: boolean;
  /** What fetching it costs, in bytes. */
  bytes: number;
  /** The PATH a Worker is made from, on this app's own origin. */
  worker_path: string;
  min_elo: number;
  max_elo: number;
  downloading: boolean;
  received: number;
  /** Why the last attempt failed, in the backend's own words. Empty when nothing failed. */
  error: string;
};

/** Nothing known yet — the reading before the backend has answered. It says the engine is ABSENT,
 *  which is the honest default: an offer drawn on a hopeful `present` would start a game whose
 *  first move nothing could make. */
export const NO_CHESS_ENGINE: ChessEngineState = {
  label: "Stockfish",
  version: "",
  present: false,
  bytes: 0,
  worker_path: "",
  min_elo: CHESS_ENGINE_MIN_ELO,
  max_elo: CHESS_ENGINE_MAX_ELO,
  downloading: false,
  received: 0,
  error: "",
};

/** What the download row says: the size before the press, the progress during it, the reason after
 *  a failure. One place, because the row is drawn in the menu and in Settings. */
export function chessEngineRowLabel(state: ChessEngineState): string {
  if (state.downloading) {
    const done = state.bytes > 0 ? Math.round((state.received / state.bytes) * 100) : 0;
    return `Fetching the engine… ${Math.min(99, done)}%`;
  }
  if (state.present) return `${state.label} is on this machine`;
  return `Play the computer — fetch ${state.label} (${megabytes(state.bytes)})`;
}

/** A size a reader can read. */
export function megabytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
