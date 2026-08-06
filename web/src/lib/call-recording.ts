/**
 * Recording a call, as an idea: what goes in the picture, what the result is called, and
 * what may be said about it.
 *
 * **A recording is teams-lite's own, and Teams is never told.** Nothing here posts, nothing
 * here reaches the network, and no message goes out: the file is made in the browser out of
 * the streams the call already carries, it is kept in that browser, and it is drawn in the
 * conversation for the one person who pressed record. That is the whole promise, and three
 * consequences follow from it that every reader of this feature has to know:
 *
 * - **Nobody else is told.** Teams' own recording announces itself to the meeting and drops
 *   a file in the chat for everybody; this one cannot, because it is not Teams' recording —
 *   it never touches the calling service, so there is nothing to announce it with and
 *   nowhere to announce it. The control says so in the words the user reads before they
 *   press it ({@link RECORD_HINT}), because that is the one fact they need in order to
 *   decide, and asking the people on the call is theirs to do.
 * - **It is one browser's file.** It lives in this browser's own storage (see
 *   `./recording-store.ts`), like the chat pins and the calendar preferences and for the
 *   same reason — there is no upstream to write it to, and a copy on a machine the user did
 *   not make it on is a copy they never asked for. So a recording made on the phone is not
 *   on the laptop, and the card says where it is kept and offers to save it out.
 * - **The picture is COMPOSITED, not the page.** A `MediaRecorder` takes one stream, and a
 *   call is many — so the sources are drawn onto one canvas here, by the same rule the stage
 *   draws them by (a shared screen is the subject; faces are tiles). It is deliberately not
 *   a capture of the app's own window: that would record the sidebar, the reader's scrolling
 *   and whatever else is on their screen, and it would ask for a second screen-capture
 *   permission to record a call the app already has every stream of.
 *
 * Everything in this file is pure. {@link ./call-recorder} owns the canvas, the mixer and
 * the `MediaRecorder`; the store owns when one runs; and the card draws the result.
 */

import type { ActiveCall } from "./call";
import type { LocalVideo, RemoteVideo } from "./call-media";

/**
 * The size every recording is made at, and the rate it is drawn at.
 *
 * 720p because the thing most worth recording is a shared SCREEN, and a screen is text:
 * 1280 wide is the point at which a colleague's editor is still readable in the result.
 * 24 frames a second because a call is faces and text rather than motion, and every frame
 * is one composite of several `<video>` elements — a rate a slow machine cannot hold is a
 * recording that stutters instead of one that is smaller.
 */
export const RECORDING_WIDTH = 1280;
export const RECORDING_HEIGHT = 720;
export const RECORDING_FPS = 24;

/** The gap between the tiles in the composite, and the padding around them, in canvas
 *  pixels. Both are deliberately small: this is a recording of a call, not a poster. */
export const RECORDING_GAP = 8;

/** How tall the strip of faces under a shared screen is, as a share of the frame.
 *
 *  A fifth: enough for a face to be recognised, little enough that the screen — the thing
 *  somebody shared because they wanted it read — keeps what it needs. */
const STRIP_SHARE = 0.2;

/** What a recording is written as, in the order the browser is asked.
 *
 *  VP9 first (a screen full of text at the same bitrate is visibly better), VP8 next, and
 *  then whatever the browser calls plain webm. Opus in every case, because it is the codec
 *  the call itself is carried in. */
export const RECORDING_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

/**
 * The first of {@link RECORDING_MIME_TYPES} this browser will really write, or `""` when it
 * names none.
 *
 * `""` is handed to `MediaRecorder` as "choose for yourself", which is the honest last
 * resort: a browser that says it supports nothing on that list may still record, and
 * refusing to record because the app could not name the container would be a refusal about
 * a detail the user cannot act on.
 */
export function pickRecordingMimeType(supported: (type: string) => boolean): string {
  return RECORDING_MIME_TYPES.find((type) => supported(type)) ?? "";
}

/**
 * One picture going into the composite.
 *
 * `mirrored` is the user's own camera and nothing else: a person expects their own face
 * mirrored and everybody else's as it is — and a mirrored SCREEN is unreadable, which is why
 * the flag travels per source rather than being derived from "is it ours".
 */
export type RecordingSource = {
  /** Stable per source, so the compositor keeps one `<video>` element per stream. */
  key: string;
  stream: MediaStream;
  /** Whether this picture is somebody's screen. It decides both where the source goes and
   *  whether it is fitted or cropped. */
  sharing: boolean;
  mirrored: boolean;
  /** Whose it is, drawn under the tile. Empty when nothing named it — a section never says
   *  whose picture it carries (see the store's `callVideoNames`). */
  label: string;
};

/**
 * Every picture on the call, in the order the composite lays them out.
 *
 * The rule is the stage's own (`callStageLayout`): a shared screen is the subject and faces
 * give way to it. It is re-derived here rather than shared, because the two answer different
 * questions — the stage decides what the USER looks at now, and this decides what the FILE
 * holds, which includes the user's own screen the stage keeps as a corner preview. A
 * recording that left out the screen its owner shared would be missing the only thing they
 * did on the call.
 */
export function recordingSources(
  remote: readonly RemoteVideo[],
  local: readonly LocalVideo[],
  names: Record<string, string> = {},
): RecordingSource[] {
  const remoteSources = remote.map(
    (video): RecordingSource => ({
      key: `remote:${video.mid}`,
      stream: video.stream,
      sharing: video.sharing,
      mirrored: false,
      label: labelForRemote(video, names[video.mid]),
    }),
  );
  const localSources = local.map(
    (video): RecordingSource => ({
      key: `local:${video.kind}`,
      stream: video.stream,
      sharing: video.kind === "screen",
      mirrored: video.kind === "camera",
      label: video.kind === "screen" ? "Your screen" : "You",
    }),
  );
  // Screens first, in both directions, because the first screen becomes the subject of the
  // frame and the ORDER is what decides which one that is. A colleague's screen wins over
  // the user's own: they are watching theirs already.
  const all = [...remoteSources, ...localSources];
  return [...all.filter((source) => source.sharing), ...all.filter((source) => !source.sharing)];
}

function labelForRemote(video: RemoteVideo, name?: string): string {
  if (name) return video.sharing ? `${name} — screen` : name;
  return video.sharing ? "Shared screen" : "Camera";
}

/** A rectangle in the recorded frame, in canvas pixels. */
export type RecordingRect = { x: number; y: number; width: number; height: number };

/** One source and where it is drawn. */
export type RecordingPlacement = { source: RecordingSource; rect: RecordingRect };

/**
 * Where every picture goes in one frame.
 *
 * Two shapes, and the first source decides which:
 *
 * - **A shared screen is the subject.** It takes the frame, and everybody else becomes a
 *   strip of faces along the bottom — the same trade the stage makes, for the same reason.
 * - **Otherwise the sources share the frame** in the tightest grid that fits them, so two
 *   people are side by side and four are a square. A single source takes everything.
 *
 * The frame is 16:9 and the tiles are too, so a source is CROPPED to its tile rather than
 * letterboxed — except a screen, which is fitted (see {@link recordingDrawBox}): cutting the
 * edges off a shared screen cuts off the thing being pointed at.
 */
export function recordingLayout(
  sources: readonly RecordingSource[],
  frame: { width: number; height: number } = { width: RECORDING_WIDTH, height: RECORDING_HEIGHT },
): RecordingPlacement[] {
  if (sources.length === 0) return [];
  const pad = RECORDING_GAP;
  const inner = {
    x: pad,
    y: pad,
    width: Math.max(1, frame.width - 2 * pad),
    height: Math.max(1, frame.height - 2 * pad),
  };
  const [first, ...rest] = sources;
  if (first!.sharing && rest.length > 0) {
    const stripHeight = Math.round(inner.height * STRIP_SHARE);
    const subject = {
      x: inner.x,
      y: inner.y,
      width: inner.width,
      height: inner.height - stripHeight - RECORDING_GAP,
    };
    const strip = {
      x: inner.x,
      y: inner.y + subject.height + RECORDING_GAP,
      width: inner.width,
      height: stripHeight,
    };
    return [
      { source: first!, rect: subject },
      ...rowPlacements(rest, strip),
    ];
  }
  return gridPlacements(sources, inner);
}

/** The faces under a shared screen: one row, each tile 16:9, centred in the strip.
 *
 *  They are sized by the strip's HEIGHT rather than by its width, because the strip is a
 *  fixed band and a row of eight tiles squeezed to fit it would show eight slivers. Past
 *  what fits, the extras are dropped from the frame — a recording of the call is not a
 *  register of everybody who had a camera on. */
function rowPlacements(
  sources: readonly RecordingSource[],
  strip: RecordingRect,
): RecordingPlacement[] {
  const height = strip.height;
  const width = Math.round((height * 16) / 9);
  const fits = Math.max(1, Math.floor((strip.width + RECORDING_GAP) / (width + RECORDING_GAP)));
  const drawn = sources.slice(0, fits);
  const total = drawn.length * width + (drawn.length - 1) * RECORDING_GAP;
  const left = strip.x + Math.round((strip.width - total) / 2);
  return drawn.map((source, index) => ({
    source,
    rect: { x: left + index * (width + RECORDING_GAP), y: strip.y, width, height },
  }));
}

/** The grid a call with no shared screen is drawn in: the squarest arrangement that holds
 *  them, filled row by row, with a short last row centred. */
function gridPlacements(
  sources: readonly RecordingSource[],
  inner: RecordingRect,
): RecordingPlacement[] {
  const columns = Math.ceil(Math.sqrt(sources.length));
  const rows = Math.ceil(sources.length / columns);
  const cellWidth = Math.floor((inner.width - (columns - 1) * RECORDING_GAP) / columns);
  const cellHeight = Math.floor((inner.height - (rows - 1) * RECORDING_GAP) / rows);
  return sources.map((source, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    // How many are on THIS row, so the last one is centred rather than left-aligned under a
    // full row above it.
    const onRow = Math.min(columns, sources.length - row * columns);
    const rowWidth = onRow * cellWidth + (onRow - 1) * RECORDING_GAP;
    const left = inner.x + Math.round((inner.width - rowWidth) / 2);
    return {
      source,
      rect: {
        x: left + column * (cellWidth + RECORDING_GAP),
        y: inner.y + row * (cellHeight + RECORDING_GAP),
        width: cellWidth,
        height: cellHeight,
      },
    };
  });
}

/**
 * The part of a source's picture to draw, and where in the tile to put it.
 *
 * A SCREEN is fitted whole and centred, because cropping a screen cuts off whatever is at
 * its edges — which is where a terminal's output and a browser's tabs live. A FACE is
 * cropped to fill its tile, because a letterboxed face is a small face in a black box.
 *
 * `source` is the rectangle to take from the picture and `dest` the one to draw it into,
 * which is exactly the pair `drawImage` takes.
 */
export function recordingDrawBox(
  picture: { width: number; height: number },
  tile: RecordingRect,
  fit: "contain" | "cover",
): { source: RecordingRect; dest: RecordingRect } {
  const whole = { x: 0, y: 0, width: picture.width, height: picture.height };
  if (picture.width <= 0 || picture.height <= 0) return { source: whole, dest: tile };
  const pictureRatio = picture.width / picture.height;
  const tileRatio = tile.width / tile.height;
  if (fit === "contain") {
    const width = pictureRatio > tileRatio ? tile.width : Math.round(tile.height * pictureRatio);
    const height = pictureRatio > tileRatio ? Math.round(tile.width / pictureRatio) : tile.height;
    return {
      source: whole,
      dest: {
        x: tile.x + Math.round((tile.width - width) / 2),
        y: tile.y + Math.round((tile.height - height) / 2),
        width,
        height,
      },
    };
  }
  // Cover: take the biggest centred crop of the picture that has the tile's own ratio.
  const width = pictureRatio > tileRatio ? Math.round(picture.height * tileRatio) : picture.width;
  const height = pictureRatio > tileRatio ? picture.height : Math.round(picture.width / tileRatio);
  return {
    source: {
      x: Math.round((picture.width - width) / 2),
      y: Math.round((picture.height - height) / 2),
      width,
      height,
    },
    dest: tile,
  };
}

/**
 * One finished recording, as the app holds it.
 *
 * It carries no MRI, no thread of Teams' own and no link: a recording is an artifact of this
 * machine, and the only thing it says about the call is what a reader needs to find it again
 * — which call, which conversation, when, how long, and who was in it.
 */
export type CallRecording = {
  /** Ours, minted when the recording starts. Never Teams' anything. */
  id: string;
  /** The call it was made in, so a second recording of one call is still two rows. */
  callId: string;
  /** The conversation it belongs to, or null for a meeting joined from a calendar link —
   *  which names no thread at all, so there is no history for the card to appear in (see
   *  {@link recordingBelongsInHistory}). */
  conversationId: string | null;
  /** What the call was called, at the moment recording started. */
  title: string;
  startedAtMs: number;
  endedAtMs: number;
  /** How long the recording itself runs — never how long the call did. */
  durationMs: number;
  /** The file's size in bytes, and the container the browser wrote. */
  size: number;
  mimeType: string;
  /** Who was in the call while it was being recorded, the user included, by name. It is a
   *  UNION over the recording rather than a snapshot of its first frame: somebody who joined
   *  half way through is in the file, so they are in the list. */
  participants: string[];
};

/** How long a recording has been going, as "0:07" / "12:45" / "1:02:03". The same shape the
 *  call's own duration takes, because they are read one under the other. */
export function recordingDurationLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** A file size in the units a person reads: "4.2 MB", "812 KB".
 *
 *  It matters more here than it usually would — these are the largest things this app keeps,
 *  they are kept in a browser, and the user is the only one who can decide one is no longer
 *  worth the room. */
export function recordingSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** What the file is called when the user saves it out.
 *
 *  It names the call and the moment, because a folder of downloads is where this lands and
 *  `recording.webm` is what nobody can find again. The title is reduced to what every
 *  filesystem accepts rather than escaped — a colleague's name with a slash in it is not
 *  worth a rule of its own. */
export function recordingFileName(
  recording: CallRecording,
  at = new Date(recording.startedAtMs),
): string {
  const slug = recording.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}`;
  return ["teams-lite", slug || "call", day, time].join("-") + ".webm";
}

/** When the recording was made, for the card: "6 Aug at 14:32". The reader's own locale. */
export function recordingWhenLabel(
  recording: CallRecording,
  locale?: string,
  timeZone?: string,
): string {
  const at = new Date(recording.startedAtMs);
  const day = at.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone });
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
  return `${day} at ${time}`;
}

/** Who was in it, in the fewest words that are true — the same rule the call's own bar
 *  follows, so the two read alike. */
export function recordingPeopleLabel(recording: CallRecording): string {
  const people = recording.participants.map((name) => name.trim()).filter(Boolean);
  if (people.length === 0) return "";
  if (people.length <= 3) return people.join(", ");
  return `${people.slice(0, 2).join(", ")} and ${people.length - 2} others`;
}

/**
 * Whether a call may be recorded right now.
 *
 * Only a call whose audio is up: before that there is no microphone open and no voice
 * arriving, so a recording would be a file of nothing — and the button is drawn from this,
 * so it is simply absent until there is something to record. It deliberately says nothing
 * about WHICH call: a 1:1, a group call and a meeting are all recorded the same way,
 * because they are all the same streams here.
 */
export function callCanBeRecorded(call: ActiveCall | null): boolean {
  return call?.phase === "connected";
}

/**
 * Whether this recording is drawn in a conversation's history.
 *
 * A recording of a meeting joined from a calendar LINK names no conversation — the service
 * resolves the thread from the code and never tells us — so it has no history to appear in,
 * and Settings › Call recordings is where it is reachable. It is the same rule the call's
 * own chat panel follows: the disclosure exists exactly where there is something behind it.
 */
export function recordingBelongsInHistory(
  recording: CallRecording,
  conversationId: string,
): boolean {
  return recording.conversationId === conversationId;
}

/** The recordings that belong in one conversation, oldest first — the order a history is
 *  read in. */
export function recordingsInConversation(
  recordings: readonly CallRecording[],
  conversationId: string,
): CallRecording[] {
  return recordings
    .filter((recording) => recordingBelongsInHistory(recording, conversationId))
    .sort((a, b) => a.endedAtMs - b.endedAtMs);
}

/** What every recording on this machine costs, in bytes. Drawn in Settings, because the
 *  room these take is the one thing about them the user may need to act on. */
export function recordingsTotalSize(recordings: readonly CallRecording[]): number {
  return recordings.reduce((total, recording) => total + recording.size, 0);
}

/** The words on the control before it is pressed. It states the two things the user decides
 *  with: where the file goes, and that the call is not told. */
export const RECORD_HINT =
  "Record this call to this browser. Nobody on the call is told — teams-lite records it " +
  "here, and Teams never sees it.";

/** And while it runs. It names the one thing that is true of a live recording and of no
 *  other state: pressing again keeps what has been recorded so far. */
export const RECORDING_HINT = "Stop recording and keep the video";

/** Why a recording could not be started, in one sentence for the notice.
 *
 *  The browser's own words are about objects the user has never heard of ("Failed to execute
 *  'start' on 'MediaRecorder'"), so the fact is stated instead — and the one recoverable
 *  cause it can have here, a browser that cannot record at all, is named. */
export function recordingFailureMessage(error: unknown): string {
  if (error instanceof RecordingUnsupportedError) return error.message;
  return "This call could not be recorded.";
}

/** Thrown when the browser has no `MediaRecorder` at all. Separate, because it is the one
 *  failure that will not go away on a second press — so the sentence has to say that
 *  rather than invite a retry. */
export class RecordingUnsupportedError extends Error {
  constructor() {
    super("This browser cannot record a call.");
    this.name = "RecordingUnsupportedError";
  }
}

/** What is said when a recording ends and the file is kept. One sentence, and it names the
 *  place it appeared, because that is where the user goes next. */
export function recordingSavedMessage(recording: CallRecording): string {
  const length = recordingDurationLabel(recording.durationMs);
  return recording.conversationId
    ? `Recording kept — ${length}, in this conversation.`
    : `Recording kept — ${length}, in Settings › Call recordings.`;
}

/** And when it ends with nothing in it. A `MediaRecorder` stopped in the same second it
 *  started writes no frames at all, and a 0-byte row in the history would be worse than a
 *  sentence saying so. */
export const RECORDING_EMPTY_MESSAGE = "That recording was too short to keep.";
