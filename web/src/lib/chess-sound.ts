/**
 * The sounds a game of chess makes — synthesized, never fetched.
 *
 * A board that answers a move with a knock is most of what makes playing one feel like playing
 * one, and the full-screen page is where a reader is playing rather than reading a chat. So this
 * module exists, and two decisions shape all of it:
 *
 *   - **NOTHING IS DOWNLOADED.** Every sound is built out of oscillators and a noise burst, the
 *     way `cuelume` builds the app's own interaction cues (see lib/sounds.ts). A dozen small
 *     files would be a dozen requests on a page whose whole promise is that displaying it makes
 *     none, and they would ride in the release asset the launcher embeds. What synthesis costs
 *     is that a knock is a knock rather than a recording of oak — which is the right trade for a
 *     10 KB module.
 *   - **THE RECIPES ARE DATA AND THE CHOICE IS PURE.** `CHESS_SOUNDS` is a table and
 *     {@link chessSoundFor} is a function of a move, so which sound a capture earns is
 *     unit-tested without an AudioContext anywhere. Only {@link playChessSound} touches the
 *     browser, and it is a no-op everywhere it cannot be one.
 *
 * Three browser rules are obeyed rather than fought: an AudioContext may not START before a user
 * gesture (so the context is created lazily, on the first sound a press asks for, and resumed if
 * the browser suspended it), iOS suspends it whenever the app goes away (so every play resumes
 * it), and a page in the background must not make noise (so a hidden document plays nothing).
 */

/** Which sound. Named after what happened, never after what it is made of. */
export type ChessSoundName =
  | "move"
  | "capture"
  | "castle"
  | "check"
  | "promote"
  | "start"
  | "win"
  | "lose"
  | "draw"
  | "illegal"
  | "premove"
  | "lowTime";

/** One voice inside a sound. Times are seconds from the trigger. */
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
 * The whole palette. Each sound has its own SHAPE rather than being the same click at another
 * volume: a reader hears which of them it was without looking at the board, which is the only
 * reason to have twelve.
 */
export const CHESS_SOUNDS: Record<ChessSoundName, ChessSoundRecipe> = {
  // The commonest sound in the feature, so it is the shortest and the quietest.
  move: { layers: knock(2000, 180, 0.16) },
  // A capture is two pieces meeting: brighter, and a second click a hair behind the first.
  capture: {
    layers: [...knock(3200, 140, 0.22), ...knock(2400, 120, 0.12, 0.028)],
  },
  // Castling is two pieces moving, so it is the move sound twice.
  castle: { layers: [...knock(1800, 190, 0.15), ...knock(1800, 190, 0.13, 0.075)] },
  // Check is an alert rather than an impact: two rising notes over the knock.
  check: {
    layers: [...knock(2600, 160, 0.14), note(880, 0.02, 0.1, 0.14, "triangle"), note(1320, 0.09, 0.09, 0.16, "triangle")],
  },
  // A promotion is the one move that gains something: a small rising arpeggio.
  promote: {
    layers: [...knock(2200, 175, 0.13), note(659, 0.03, 0.09), note(880, 0.1, 0.09), note(1319, 0.17, 0.08)],
  },
  start: { layers: [note(523, 0, 0.1), note(784, 0.08, 0.1)] },
  win: { layers: [note(659, 0, 0.11), note(880, 0.09, 0.11), note(1175, 0.18, 0.1, 0.3)] },
  lose: { layers: [note(659, 0, 0.1), note(523, 0.1, 0.1), note(392, 0.2, 0.1, 0.34)] },
  // A draw is neither, so it is one note held with a second beating against it.
  draw: {
    layers: [note(587, 0, 0.09, 0.3), { kind: "tone", wave: "sine", freq: 591, at: 0, attack: 0.01, decay: 0.3, peak: 0.07 }],
  },
  // A refusal, and the one sound here that is deliberately unpleasant.
  illegal: { layers: [{ kind: "tone", wave: "square", freq: 150, at: 0, attack: 0.002, decay: 0.1, peak: 0.055 }] },
  // Setting a premove is the quietest thing in the palette: it is a private intention, and it
  // happens while the opponent is still thinking.
  premove: { layers: [note(1568, 0, 0.04, 0.05)] },
  // A clock running out, meant to be heard over a game and repeated by the caller.
  lowTime: { layers: [note(1047, 0, 0.07, 0.06, "triangle"), note(1047, 0.1, 0.06, 0.06, "triangle")] },
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
}): ChessSoundName {
  const flags = move.flags ?? "";
  if (move.check) return "check";
  if (move.promotion || flags.includes("p")) return "promote";
  if (flags.includes("k") || flags.includes("q")) return "castle";
  if (move.captured || flags.includes("c") || flags.includes("e")) return "capture";
  return "move";
}

/** Which sound a finished game earns, from the reader's own side of it. */
export function chessOutcomeSound(result: "win" | "lose" | "draw"): ChessSoundName {
  return result;
}

// ---- the one part that touches the browser ---------------------------------------

let context: AudioContext | null = null;
let noise: AudioBuffer | null = null;

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
  const recipe = CHESS_SOUNDS[name];
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
