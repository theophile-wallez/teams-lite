/**
 * The sounds a game of chess makes — chess.com's recordings, with this app's own synthesis under
 * them.
 *
 * A board that answers a move with a knock is most of what makes playing one feel like playing one,
 * and the sounds every chess player already knows are chess.com's. So the palette is theirs, and
 * three decisions shape everything here:
 *
 *   - **THE RECORDINGS COME FROM THIS MACHINE, never from chess.com.** The backend fetches the
 *     eleven files once, verifies each against a digest it pins, and serves them from this app's own
 *     origin (src/chess_sound.rs, web/chess-sound-file.ts). A page that fetched them itself would
 *     tell chess.com's CDN the reader's address every time it drew a board — the read receipt
 *     § Mail strips out of every message body, in another costume. This module is handed a ROUTE by
 *     the backend and never builds one.
 *   - **SYNTHESIS IS THE FALLBACK, so this can never cost a board its sound.** {@link CHESS_SOUNDS}
 *     is still a table of oscillators and noise bursts, the way `cuelume` builds the app's own cues
 *     (see lib/sounds.ts), and it is what plays until the recordings are on the machine — the first
 *     game ever, a machine that is offline, a reader who never let this app fetch them. It is the
 *     rule § A picture somebody SENT holds for a reduced view: the better thing is the addition.
 *   - **THE RECIPES ARE DATA AND THE CHOICE IS PURE.** {@link chessSoundFor} is a function of a
 *     move, so which sound a capture earns is unit-tested with no AudioContext anywhere. Only
 *     {@link playChessSound} and {@link primeChessSounds} touch the browser, and both are a no-op
 *     everywhere they cannot be one.
 *
 * Three browser rules are obeyed rather than fought: an AudioContext may not START before a user
 * gesture (so it is created lazily and resumed on every play), iOS suspends it whenever the app goes
 * away (so every play resumes it), and a page in the background must not make noise (so a hidden
 * document plays nothing).
 */

/**
 * Which sound. Named after what happened, never after what it is made of.
 *
 * `move` and `moveOpponent` are two names for one event on purpose: chess.com gives the reader's own
 * move and their opponent's different recordings, and that is the one split worth having — it says a
 * move ARRIVED without the reader having to look at the board. Everything else is the same sound
 * whoever did it, which is chess.com's own arrangement: a capture is a capture.
 */
export type ChessSoundName =
  | "move"
  | "moveOpponent"
  | "capture"
  | "castle"
  | "check"
  | "promote"
  | "start"
  | "win"
  | "lose"
  | "draw"
  | "premove"
  | "lowTime"
  | "notify";

/**
 * Which of chess.com's files each sound is, without the `.mp3`.
 *
 * The names are the ones `src/chess_sound.rs` pins and `web/chess-sound-file.ts` serves —
 * `chess_sound::tests::the_page_asks_for_the_files_this_build_pins` scans this file, because the
 * three tables are on opposite sides of two process boundaries and a name that drifted here is an
 * event whose sound would 404 for ever while the page quietly fell back to synthesis.
 *
 * **WIN, LOSE AND DRAW ARE ONE FILE.** chess.com plays `game-end` however a game finished, and the
 * result is on screen the moment it does — so the three names stay (they are real distinctions this
 * app knows, and the synthesized fallback still tells them apart by pitch) and all three resolve to
 * it. chess.com does publish `game-win-long`, `game-lose-long` and `game-draw`; they are not pinned,
 * so this is a stated trade rather than an oversight.
 */
export const CHESS_SOUND_FILE: Record<ChessSoundName, string> = {
  move: "move-self",
  moveOpponent: "move-opponent",
  capture: "capture",
  castle: "castle",
  check: "move-check",
  promote: "promote",
  start: "game-start",
  win: "game-end",
  lose: "game-end",
  draw: "game-end",
  premove: "premove",
  lowTime: "tenseconds",
  notify: "notify",
};

/** One voice inside a SYNTHESIZED sound. Times are seconds from the trigger. */
export type ChessSoundLayer =
  | {
      kind: "tone";
      wave: OscillatorType;
      freq: number;
      /** Where the pitch glides to, when it glides. */
      glideTo?: number;
      at: number;
      attack: number;
      decay: number;
      peak: number;
    }
  | {
      kind: "noise";
      /** A band of noise is what a piece landing on a board really is. */
      filterFreq: number;
      q: number;
      at: number;
      attack: number;
      decay: number;
      peak: number;
    };

export type ChessSoundRecipe = { layers: ChessSoundLayer[] };

/** A piece landing: a band of noise for the click, and a low sine for the weight under it. */
function knock(bright: number, thump: number, peak: number, at = 0): ChessSoundLayer[] {
  return [
    { kind: "noise", filterFreq: bright, q: 1.1, at, attack: 0.001, decay: 0.055, peak },
    {
      kind: "tone",
      wave: "sine",
      freq: thump,
      at,
      attack: 0.001,
      decay: 0.075,
      peak: peak * 0.55,
    },
  ];
}

/** One note. */
function note(
  freq: number,
  at: number,
  peak: number,
  decay = 0.16,
  wave: OscillatorType = "sine",
): ChessSoundLayer {
  return { kind: "tone", wave, freq, at, attack: 0.006, decay, peak };
}

/**
 * The FALLBACK palette, played until the recordings are on this machine. Each sound has its own
 * SHAPE rather than being the same click at another volume: a reader hears which of them it was
 * without looking at the board, which is the only reason to have thirteen.
 */
export const CHESS_SOUNDS: Record<ChessSoundName, ChessSoundRecipe> = {
  // The commonest sound in the feature, so it is the shortest and the quietest.
  move: { layers: knock(2000, 180, 0.16) },
  // The opponent's move is the same event from the other side, so it is the same knock DULLER and a
  // little lower — different enough to tell apart with the board out of sight, which is the whole
  // reason the two are separate names.
  moveOpponent: { layers: knock(1400, 150, 0.15) },
  // A capture is two pieces meeting: brighter, and a second click a hair behind the first.
  capture: {
    layers: [...knock(3200, 140, 0.22), ...knock(2400, 120, 0.12, 0.028)],
  },
  // Castling is two pieces moving, so it is the move sound twice.
  castle: { layers: [...knock(1800, 190, 0.15), ...knock(1800, 190, 0.13, 0.075)] },
  // Check is an alert rather than an impact: two rising notes over the knock.
  check: {
    layers: [
      ...knock(2600, 160, 0.14),
      note(880, 0.02, 0.1, 0.14, "triangle"),
      note(1320, 0.09, 0.09, 0.16, "triangle"),
    ],
  },
  // A promotion is the one move that gains something: a small rising arpeggio.
  promote: {
    layers: [
      ...knock(2200, 175, 0.13),
      note(659, 0.03, 0.09),
      note(880, 0.1, 0.09),
      note(1319, 0.17, 0.08),
    ],
  },
  start: { layers: [note(523, 0, 0.1), note(784, 0.08, 0.1)] },
  win: { layers: [note(659, 0, 0.11), note(880, 0.09, 0.11), note(1175, 0.18, 0.1, 0.3)] },
  lose: { layers: [note(659, 0, 0.1), note(523, 0.1, 0.1), note(392, 0.2, 0.1, 0.34)] },
  // A draw is neither, so it is one note held with a second beating against it.
  draw: {
    layers: [
      note(587, 0, 0.09, 0.3),
      { kind: "tone", wave: "sine", freq: 591, at: 0, attack: 0.01, decay: 0.3, peak: 0.07 },
    ],
  },
  // Setting a premove is the quietest thing in the palette: it is a private intention, and it
  // happens while the opponent is still thinking.
  premove: { layers: [note(1568, 0, 0.04, 0.05)] },
  // A clock running out, meant to be heard over a game and repeated by the caller.
  lowTime: { layers: [note(1047, 0, 0.07, 0.06, "triangle"), note(1047, 0.1, 0.06, 0.06, "triangle")] },
  // Somebody wants something from the reader — a draw offered while their own clock runs.
  notify: { layers: [note(784, 0, 0.08, 0.12, "triangle"), note(1047, 0.11, 0.07, 0.14, "triangle")] },
};

/** What one move sounds like. Mate is drawn from the OUTCOME rather than here — a game ending is
 *  not a move — so the sharpest thing a move itself says is check. */
export function chessSoundFor(move: {
  /** chess.js's own flags string, where `c` is a capture, `k`/`q` castling and `p` a promotion. */
  flags?: string;
  captured?: string | undefined;
  promotion?: string | undefined;
  /** Whether the position after the move is a check. */
  check?: boolean;
  /**
   * Whether the reader played it. `false` is the OPPONENT's move and nothing else — a game the
   * reader is only watching has no opponent, so it defaults to `true` and such a board sounds the
   * way it always did.
   */
  mine?: boolean;
}): ChessSoundName {
  const flags = move.flags ?? "";
  if (move.check) return "check";
  if (move.promotion || flags.includes("p")) return "promote";
  if (flags.includes("k") || flags.includes("q")) return "castle";
  if (move.captured || flags.includes("c") || flags.includes("e")) return "capture";
  return move.mine === false ? "moveOpponent" : "move";
}

/** Which sound a finished game earns, from the reader's own side of it. */
export function chessOutcomeSound(result: "win" | "lose" | "draw"): ChessSoundName {
  return result;
}

/**
 * The URL one sound is fetched from, or null when the route is not one this app serves.
 *
 * The BACKEND names the route (`chess_sound_status.route`), so this only guards it — the rule
 * `chessEngineWorkerUrl` holds for the Worker's own path: a page that trusted any string a backend
 * answered with would fetch whatever it was handed.
 */
export function chessSoundUrl(route: string, name: ChessSoundName): string | null {
  if (!route.startsWith("/__chess-sound/")) return null;
  if (route.includes("..") || route.includes("//")) return null;
  if (!route.endsWith("/")) return null;
  return `${route}${CHESS_SOUND_FILE[name]}.mp3`;
}

/** Every distinct file the palette needs — thirteen names over eleven recordings. */
export function chessSoundFileNames(): string[] {
  return [...new Set(Object.values(CHESS_SOUND_FILE))];
}

/** What the backend says about the recordings on this machine (the `chess_sound_status` answer). */
export type ChessSoundsState = {
  label: string;
  version: string;
  /** Whether every recording is here, verified. */
  present: boolean;
  /** What they weigh, for the row that offers to give the disk back. */
  bytes: number;
  /** Where to fetch them from, on THIS app's own origin. */
  route: string;
};

/** Nothing known yet. It says the recordings are ABSENT, which is the honest default AND the safe
 *  one: absent means the synthesized palette plays, so a board that never hears from the backend
 *  still makes a noise. */
export const NO_CHESS_SOUNDS: ChessSoundsState = {
  label: "chess.com's default board sounds",
  version: "",
  present: false,
  bytes: 0,
  route: "",
};

// ---- the one part that touches the browser ---------------------------------------

let context: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** The decoded recordings, by the FILE they came from rather than by the sound name — win, lose and
 *  draw are one file, and decoding it three times would be three copies of one buffer. */
const decoded = new Map<string, AudioBuffer>();

/** Which route has already been asked for, so a board that mounts twice fetches once. */
let primed: string | null = null;

/**
 * How loud a recording plays. chess.com's files are mastered close to full scale while the
 * synthesized palette above peaks at 0.16, so playing them untouched would make a board the loudest
 * thing on the machine — and this app has no volume control of its own to correct it with. One
 * number, backed off a little, so the two palettes sit at roughly one level.
 */
const RECORDING_GAIN = 0.8;

/** The shared context, created on the first sound and resumed whenever the browser has
 *  suspended it. Null wherever Web Audio is not a thing, which is SSR and a browser too old. */
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    if (!context) context = new Ctor();
    // iOS suspends it every time the app goes away, so this is not a one-off at startup.
    if (context.state === "suspended") void context.resume();
    return context;
  } catch {
    return null;
  }
}

/**
 * Fetch and decode the recordings, once.
 *
 * Called with the route the BACKEND published, and only once it says they are on this machine — so a
 * 404 here is exceptional rather than the ordinary state of a machine nobody has played on. It is
 * best-effort in every direction: a file that cannot be fetched or decoded simply leaves its sound
 * synthesized, which is why nothing here reports a failure to the reader. A board makes a noise
 * either way, and there is nothing they could do about it.
 */
export function primeChessSounds(route: string): void {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  if (primed === route) return;
  const ctx = audio();
  if (!ctx) return;
  primed = route;
  for (const name of chessSoundFileNames()) {
    const url = `${route}${name}.mp3`;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        // `decodeAudioData` works on a SUSPENDED context, which is what this one is before the
        // reader's first gesture — so the recordings are ready before the first move rather than
        // one move behind it.
        const buffer = await ctx.decodeAudioData(bytes);
        decoded.set(name, buffer);
      } catch {
        // Left synthesized.
      }
    })();
  }
}

/** Forget every decoded recording — what a test uses to get back to the synthesized palette. */
export function resetChessSounds(): void {
  decoded.clear();
  primed = null;
}

/** Whether a sound would play as a RECORDING rather than as synthesis. */
export function chessSoundIsRecorded(name: ChessSoundName): boolean {
  return decoded.has(CHESS_SOUND_FILE[name]);
}

/**
 * Play one sound, or do nothing at all.
 *
 * It answers to the app's own sound preference (`soundsEnabled`, which the caller reads — see
 * lib/sounds.ts), so the one switch in Settings covers this palette too: a reader who turned the
 * app's cues off did not ask for a chess board to be the exception.
 */
export function playChessSound(name: ChessSoundName, enabled = true): void {
  if (!enabled) return;
  // A board in a background tab must not make noise. The page is what the reader is looking at,
  // and a move arriving on a hidden one is caught up with in silence.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const ctx = audio();
  if (!ctx) return;
  const recording = decoded.get(CHESS_SOUND_FILE[name]);
  if (recording) {
    const gain = ctx.createGain();
    gain.gain.value = RECORDING_GAIN;
    gain.connect(ctx.destination);
    const source = ctx.createBufferSource();
    source.buffer = recording;
    source.connect(gain);
    source.start();
    return;
  }
  synthesize(ctx, CHESS_SOUNDS[name]);
}

/** A quarter-second of white noise, made once and reused: it is what every knock is filtered
 *  out of, and allocating one per move would be a garbage-collector pause per move. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  noise = buffer;
  return buffer;
}

/** The fallback: build one sound out of oscillators and a band of noise. */
function synthesize(ctx: AudioContext, recipe: ChessSoundRecipe): void {
  const now = ctx.currentTime;
  for (const layer of recipe.layers) {
    const gain = ctx.createGain();
    const start = now + layer.at;
    const end = start + layer.attack + layer.decay;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, layer.peak), start + layer.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(ctx.destination);

    if (layer.kind === "tone") {
      const osc = ctx.createOscillator();
      osc.type = layer.wave;
      osc.frequency.setValueAtTime(layer.freq, start);
      if (layer.glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(layer.glideTo, end);
      osc.connect(gain);
      osc.start(start);
      osc.stop(end + 0.01);
    } else {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer(ctx);
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(layer.filterFreq, start);
      filter.Q.setValueAtTime(layer.q, start);
      source.connect(filter);
      filter.connect(gain);
      source.start(start);
      source.stop(end + 0.01);
    }
  }
}
