/**
 * The machinery behind recording a call: one canvas, one audio mixer, one `MediaRecorder`.
 *
 * This is the second module in the app that touches media — `./call-media.ts` is the other —
 * and it is deliberately downstream of it: it takes the streams that module already holds
 * and produces a file, and it never opens a device, never negotiates and never reaches the
 * network. Everything it makes stays in this browser (see `./recording-store.ts`), and Teams
 * is never told a recording happened, because nothing here can tell it.
 *
 * Five things about it are load-bearing:
 *
 * - **A `MediaRecorder` takes ONE stream, and a call is many.** So every picture is drawn
 *   onto one canvas and every voice is summed into one audio node, and what is recorded is
 *   that pair. The layout is `./call-recording.ts`'s, so the geometry is pure and pinned by
 *   its own tests, and this file only draws the answer.
 * - **The sources CHANGE while it runs.** Somebody unmutes, a camera comes on, a screen share
 *   ends. So the recorder is TOLD the current sources on every change ({@link
 *   CallRecorder.update}) and re-points its own elements and nodes at them — the recording
 *   itself never restarts, because a call recorded in five files is not a recording of the
 *   call.
 * - **The draw loop is a TIMER, not `requestAnimationFrame`.** rAF stops in a hidden tab, and
 *   a recording that froze whenever the user looked at another window would be worse than a
 *   slightly uneven one. A background tab throttles timers, so the picture loses frames
 *   there; the audio, which is what the user came back for, is untouched by that.
 * - **Nothing here plays anything.** The mixer's output goes to the recorder and to no
 *   destination, and every `<video>` it makes is muted: the call is already audible through
 *   the elements `call-media.ts` owns, and a second path to the speakers would double every
 *   voice and feed the microphone back into itself.
 * - **Stopping releases everything, on every path.** The timer, the elements, the audio
 *   nodes, the context, the canvas track. A recorder left running holds a rendering context
 *   and a `MediaStream` for a call that is over.
 */

import {
  RECORDING_FPS,
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
  RecordingUnsupportedError,
  pickRecordingMimeType,
  recordingDrawBox,
  recordingLayout,
  type RecordingPlacement,
  type RecordingSource,
} from "./call-recording";
import type { CallAudio } from "./call-media";

/** How often the recorder is handed a chunk. One second, so a run that ends in a way the
 *  app never sees — a closed tab, a crashed renderer — has left almost all of itself behind
 *  rather than nothing at all. */
const CHUNK_MS = 1000;

/** What the composite says when there is no picture at all, which is most calls. */
const AUDIO_ONLY_LINE = "Audio only";

/** Everything a recording is made of, as it stands right now. */
export type RecordingInput = {
  /** Every picture, in the order the frame lays them out ({@link recordingSources}). */
  sources: RecordingSource[];
  /** Every voice: the microphone and each remote stream. */
  audio: CallAudio;
  /** What the call is called, drawn on the frame while there is no picture. */
  title: string;
};

/** A recording in flight. */
export type CallRecorder = {
  /** Epoch ms of the moment the first chunk was asked for. */
  readonly startedAtMs: number;
  /** The container the browser is really writing. */
  readonly mimeType: string;
  /** Re-point at the call's current pictures and voices. Cheap, and safe to call on every
   *  frame of state: nothing is torn down for a source that is still there. */
  update(input: RecordingInput): void;
  /** Stop, and resolve with what was recorded. Releases everything, and resolves with a
   *  zero-byte blob when the recorder never wrote a frame — the caller says so rather than
   *  keeping an empty file. Safe to call twice; the second call gets the same promise. */
  stop(): Promise<Blob>;
};

/**
 * Start recording the call.
 *
 * Throws {@link RecordingUnsupportedError} when the browser has no `MediaRecorder` — the one
 * failure a second press will not fix, which is why it has a type of its own and a sentence
 * the user can act on.
 */
export function startCallRecorder(input: RecordingInput): CallRecorder {
  if (typeof MediaRecorder === "undefined") throw new RecordingUnsupportedError();

  const canvas = document.createElement("canvas");
  canvas.width = RECORDING_WIDTH;
  canvas.height = RECORDING_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new RecordingUnsupportedError();

  const pictures = new Pictures();
  const mixer = new VoiceMixer();
  let current = input;
  pictures.update(current.sources);
  mixer.update(current.audio);

  // The canvas is captured at the frame rate the loop draws at, so the track's own clock and
  // the loop agree: a canvas captured at 0 (draw-driven) needs `requestFrame` on every
  // frame, which is one more thing to get wrong for no gain.
  const videoTrack = canvas.captureStream(RECORDING_FPS).getVideoTracks()[0];
  const stream = new MediaStream([
    ...(videoTrack ? [videoTrack] : []),
    ...mixer.stream.getAudioTracks(),
  ]);

  const mimeType = pickRecordingMimeType((type) =>
    typeof MediaRecorder.isTypeSupported === "function"
      ? MediaRecorder.isTypeSupported(type)
      : false,
  );
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  });

  const timer = setInterval(() => {
    drawFrame(context, pictures, current);
  }, Math.round(1000 / RECORDING_FPS));
  // One frame straight away, so a recording stopped after half a second still has a picture.
  drawFrame(context, pictures, current);

  recorder.start(CHUNK_MS);
  const startedAtMs = Date.now();
  let finished: Promise<Blob> | null = null;

  return {
    startedAtMs,
    // What the recorder settled on, which is the truth about the file — `mimeType` above is
    // only what it was asked for.
    mimeType: recorder.mimeType || mimeType,
    update(next: RecordingInput): void {
      current = next;
      pictures.update(next.sources);
      mixer.update(next.audio);
    },
    stop(): Promise<Blob> {
      if (finished) return finished;
      finished = new Promise<Blob>((resolve) => {
        const done = () => {
          clearInterval(timer);
          pictures.release();
          mixer.release();
          videoTrack?.stop();
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" }));
        };
        // `stop` flushes one last `dataavailable` before `stop` fires, so waiting for the
        // event is what makes the final second part of the file.
        recorder.addEventListener("stop", done, { once: true });
        // A recorder already inactive fires nothing, so it is closed out by hand: a stop
        // that never resolved would leave the call's own teardown waiting for ever.
        if (recorder.state === "inactive") {
          recorder.removeEventListener("stop", done);
          done();
          return;
        }
        recorder.stop();
      });
      return finished;
    },
  };
}

/** Draw one frame: the pictures where the layout puts them, or the title card when there are
 *  none. */
function drawFrame(
  context: CanvasRenderingContext2D,
  pictures: Pictures,
  input: RecordingInput,
): void {
  const { width, height } = context.canvas;
  // The backdrop is drawn every frame rather than cleared: a transparent canvas records as
  // black in some encoders and as garbage in others, and a tile that shrinks would otherwise
  // leave the last frame's edges behind it.
  context.fillStyle = "#0b0b0c";
  context.fillRect(0, 0, width, height);

  const placements = recordingLayout(input.sources, { width, height });
  if (placements.length === 0) {
    drawAudioOnlyCard(context, input.title);
    return;
  }
  for (const placement of placements) drawPlacement(context, pictures, placement);
}

/** One source in its tile: the picture, and the name under it. */
function drawPlacement(
  context: CanvasRenderingContext2D,
  pictures: Pictures,
  placement: RecordingPlacement,
): void {
  const { source, rect } = placement;
  const element = pictures.element(source);
  context.save();
  // The tile's own bed, so a picture that has not arrived yet is a panel rather than a hole,
  // and a fitted screen sits on something instead of on the backdrop.
  context.fillStyle = "#17171a";
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  if (element && element.videoWidth > 0 && element.videoHeight > 0) {
    const box = recordingDrawBox(
      { width: element.videoWidth, height: element.videoHeight },
      rect,
      source.sharing ? "contain" : "cover",
    );
    // Everything is clipped to the tile: a cropped face is drawn from a source rectangle, but
    // a browser that rounds the other way would bleed one pixel into its neighbour.
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
    if (source.mirrored) {
      // Mirrored about the tile's own middle, so the flip cannot move the picture out of it.
      context.translate(box.dest.x * 2 + box.dest.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(
      element,
      box.source.x,
      box.source.y,
      box.source.width,
      box.source.height,
      box.dest.x,
      box.dest.y,
      box.dest.width,
      box.dest.height,
    );
  }
  context.restore();
  if (source.label) drawTileLabel(context, source.label, placement.rect);
}

/** Whose picture this is, along the bottom of its tile. It is in the FILE and not only on
 *  screen because a recording of five faces is what nobody can name a week later. */
function drawTileLabel(
  context: CanvasRenderingContext2D,
  label: string,
  rect: { x: number; y: number; width: number; height: number },
): void {
  // Scaled to the tile: the same size in a full-frame subject and in a face in a strip of
  // eight would be unreadable in one of them.
  const size = Math.max(11, Math.min(20, Math.round(rect.height * 0.06)));
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.clip();
  context.font = `600 ${size}px Inter, system-ui, sans-serif`;
  context.textBaseline = "alphabetic";
  const text = context.measureText(label);
  const padding = Math.round(size * 0.45);
  const boxHeight = size + padding * 2;
  const boxWidth = Math.min(rect.width, Math.round(text.width) + padding * 2);
  const left = rect.x;
  const top = rect.y + rect.height - boxHeight;
  context.fillStyle = "rgba(0,0,0,0.55)";
  context.fillRect(left, top, boxWidth, boxHeight);
  context.fillStyle = "#ffffff";
  context.fillText(label, left + padding, top + boxHeight - padding);
  context.restore();
}

/** What a call with no picture in it looks like in the file: what the call was, and that
 *  there was nothing to see.
 *
 *  It is a card rather than nothing, because the file has ONE video track for its whole
 *  length — a recording that started audio-only and grew a camera half way through must not
 *  be two files — and a black rectangle for ten minutes reads as a broken recording. */
function drawAudioOnlyCard(context: CanvasRenderingContext2D, title: string): void {
  const { width, height } = context.canvas;
  context.save();
  context.textAlign = "center";
  context.textBaseline = "middle";
  const name = title.trim() || "Call";
  context.fillStyle = "#f4f4f5";
  context.font = "600 44px Inter, system-ui, sans-serif";
  context.fillText(name, width / 2, height / 2 - 24, width - 120);
  context.fillStyle = "#a1a1aa";
  context.font = "400 24px Inter, system-ui, sans-serif";
  context.fillText(AUDIO_ONLY_LINE, width / 2, height / 2 + 30);
  context.restore();
}

/**
 * One `<video>` element per picture, kept for as long as that picture is on the call.
 *
 * `drawImage` needs an element, not a stream, and creating one per frame would decode the
 * whole call again 24 times a second. They live outside the document — nothing here is ever
 * seen — and each one is muted, because the call is already audible.
 */
class Pictures {
  private byKey = new Map<string, { element: HTMLVideoElement; stream: MediaStream }>();

  update(sources: readonly RecordingSource[]): void {
    const wanted = new Set(sources.map((source) => source.key));
    for (const [key, held] of [...this.byKey]) {
      if (!wanted.has(key)) {
        this.drop(key, held.element);
      }
    }
    for (const source of sources) {
      const held = this.byKey.get(source.key);
      // A section REUSED for another stream keeps its key and changes its stream, so the
      // element is re-pointed rather than left showing the person who left.
      if (held && held.stream === source.stream) continue;
      if (held) {
        held.element.srcObject = source.stream;
        this.byKey.set(source.key, { element: held.element, stream: source.stream });
        continue;
      }
      const element = document.createElement("video");
      element.autoplay = true;
      element.muted = true;
      element.playsInline = true;
      element.srcObject = source.stream;
      // A detached element does not play on its own in every browser, and a paused one hands
      // `drawImage` one frozen frame for the whole recording.
      void element.play().catch(() => {});
      this.byKey.set(source.key, { element, stream: source.stream });
    }
  }

  element(source: RecordingSource): HTMLVideoElement | undefined {
    return this.byKey.get(source.key)?.element;
  }

  private drop(key: string, element: HTMLVideoElement): void {
    element.pause();
    element.srcObject = null;
    this.byKey.delete(key);
  }

  release(): void {
    for (const [key, held] of [...this.byKey]) this.drop(key, held.element);
  }
}

/**
 * Every voice on the call, summed into one track.
 *
 * The microphone is in it: "the audio of everybody" includes the person recording, and a
 * recording of a call where only the other side is audible is half a conversation. A stream
 * is connected once, keyed by its own id, so a state change that re-states the same voices
 * costs nothing — connecting one twice would record it twice as loud.
 *
 * The output is a `MediaStreamAudioDestinationNode` and nothing else: the mixer is never
 * connected to `context.destination`, so it makes no sound in the room.
 */
class VoiceMixer {
  private context = new AudioContext();
  private destination = this.context.createMediaStreamDestination();
  private connected = new Map<string, MediaStreamAudioSourceNode>();

  constructor() {
    // A context created outside a gesture starts suspended, and a suspended one produces
    // silence. Recording starts from a click, so this resolves — and a failure is not worth
    // failing the recording over: the picture is still worth having.
    void this.context.resume().catch(() => {});
  }

  get stream(): MediaStream {
    return this.destination.stream;
  }

  update(audio: CallAudio): void {
    const streams = [...(audio.microphone ? [audio.microphone] : []), ...audio.remote];
    const wanted = new Set(streams.map((stream) => stream.id));
    for (const [id, node] of [...this.connected]) {
      if (wanted.has(id)) continue;
      node.disconnect();
      this.connected.delete(id);
    }
    for (const stream of streams) {
      if (this.connected.has(stream.id)) continue;
      // A stream with no live audio track cannot be a source node at all in some browsers,
      // and is silence in the rest: skipping it keeps this loop from throwing on a video-only
      // stream that arrived on the same list.
      if (stream.getAudioTracks().length === 0) continue;
      try {
        const node = this.context.createMediaStreamSource(stream);
        node.connect(this.destination);
        this.connected.set(stream.id, node);
      } catch {
        // One voice that cannot be mixed is one voice missing from the file, not a failed
        // recording. It is left out of `connected` so a later update tries again.
      }
    }
  }

  release(): void {
    for (const node of this.connected.values()) node.disconnect();
    this.connected.clear();
    for (const track of this.destination.stream.getTracks()) track.stop();
    void this.context.close().catch(() => {});
  }
}
