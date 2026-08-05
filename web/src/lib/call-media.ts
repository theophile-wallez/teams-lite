/**
 * The audio half of a call: the microphone, one `RTCPeerConnection`, and the remote
 * audio element.
 *
 * This is the ONLY place in the app that touches WebRTC, and the only place that opens
 * the microphone. Everything it produces or consumes is one SDP string, which the
 * backend carries to and from the Teams calling service (see `./call.ts` and
 * NATIVE-CALLING.md). Three things about it are load-bearing:
 *
 * - **The SDP goes out whole, candidates included.** This protocol has no trickle
 *   channel: the far side is given one blob and never hears about a candidate that
 *   arrives later. So the offer (or answer) is only handed over once ICE gathering is
 *   done, or once {@link GATHER_TIMEOUT_MS} says it has waited long enough — a call that
 *   waits forever for one unreachable server is worse than a call that offers the
 *   candidates it already has.
 * - **The SDP is rewritten in exactly ONE respect, and the service named it.**
 *   `application/sdp-ngc-1.0` is a label on ordinary WebRTC SDP — the codecs, the
 *   fingerprint, the candidates and the ICE credentials all travel as Chrome wrote them —
 *   but the transport profile does not: a browser's `UDP/TLS/RTP/SAVPF` is answered
 *   `conversationEnd 410, UnrecognizedTransportProfile`, and the answer comes back in the
 *   service's own spelling, which Chrome then refuses. Both directions go through
 *   `./ms-sdp.ts`, which is where that difference is written down. Nothing else about the
 *   blob is touched, and nothing about it is guessed: a rewrite belongs there only once
 *   the service has refused what it replaces.
 * - **Every remote stream gets its own element.** A meeting sends one stream per voice,
 *   so the call plays as many as it is sent (see {@link RemoteAudio}).
 * - **Stopping releases the microphone.** The browser shows a recording indicator for as
 *   long as a track is live, so every path out of a call — hang up, the far side hanging
 *   up, an error, the page closing — goes through {@link CallMedia.stop}.
 *
 * The mock backend has no media at all, so this module exports the interface twice: the
 * real implementation, and a simulated one the app uses when the backend announced
 * itself as the mock. That is what makes the whole calling surface reviewable with
 * nothing leaving the machine.
 */

import { fromMsSdp, labelsByMid, SHARING_LABEL, toMsSdp } from "./ms-sdp";

/** How long to wait for ICE gathering before sending what we have. Chrome finishes a
 *  host+srflx gather in well under a second; the wait only bites when a configured
 *  server is unreachable, and then it is a ceiling rather than a delay. */
const GATHER_TIMEOUT_MS = 2500;

/**
 * One video stream arriving on the call, and the section it arrived on.
 *
 * The `mid` and the `streamMsid` are what a SUBSCRIPTION is addressed by: the service is
 * told "put source 2473 on the section named 3, whose stream you called this". Neither
 * exists before the answer is applied, which is why a subscription is strictly afterwards
 * (NATIVE-CALLING.md § 10.2).
 */
export type RemoteVideo = {
  /** The section's own mid, as the service's offer named it. */
  mid: string;
  /** The receive stream's id, as the browser reported it on the `track` event. */
  streamMsid: string;
  /** `main-video` for a camera, `applicationsharing-video` for a screen — the service's own
   *  label for the section, which is the only thing that tells the two apart. */
  label: string;
  /** True when the label says this section carries somebody's screen. */
  sharing: boolean;
  stream: MediaStream;
};

/** One live call's media. */
export type CallMedia = {
  /** The SDP this side produced — the offer for an outgoing call, the answer for an
   *  incoming one. Complete, with candidates. */
  readonly localSdp: string;
  /** Apply the far side's SDP answer (outgoing calls only). */
  setRemoteAnswer(sdp: string): Promise<void>;
  /**
   * Answer a media offer the service made mid-call, and return the answer to post back.
   *
   * This is how a colleague's screen and a colleague's camera arrive: the service
   * renegotiates on its own, its offer already carries the sections, and answering is the
   * only thing left to do (NATIVE-CALLING.md § 10.3a). Returns `null` when the offer cannot
   * be answered right now — a second offer while the first is still being applied, or a call
   * already stopped — because dropping one is recoverable and the service sends another.
   */
  answerRemoteOffer(sdp: string): Promise<string | null>;
  /** Stop sending audio, or start again. The backend publishes the same state so the
   *  other side sees the crossed-out microphone. */
  setMuted(muted: boolean): void;
  /** Release the microphone and tear everything down. Safe to call twice. */
  stop(): void;
  /** Whether the peer connection is carrying media right now. */
  readonly connectionState: RTCPeerConnectionState;
  /** Every video stream arriving right now, newest state. */
  readonly remoteVideo: RemoteVideo[];
  /** Called whenever {@link remoteVideo} changes, so the UI can redraw its tiles. */
  onRemoteVideoChange?: (videos: RemoteVideo[]) => void;
};

/** What starting media needs. `remoteOffer` is present when answering a call. */
export type CallMediaOptions = {
  iceServers: RTCIceServer[];
  remoteOffer?: string;
  /** Called when the transport state changes, so the UI can say a call dropped. */
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
};

/** Thrown when the user refused the microphone, or the machine has none. It is a
 *  separate type because it is the one failure the UI must explain rather than report:
 *  a call without a microphone is not a bug. */
export class MicrophoneUnavailableError extends Error {
  constructor(cause: unknown) {
    super("teams-lite could not open the microphone.");
    this.name = "MicrophoneUnavailableError";
    this.cause = cause;
  }
}

/**
 * Open the microphone, negotiate, and return the SDP to hand the backend.
 *
 * Answering (`remoteOffer` given) and placing differ by two lines — the remote
 * description and which of `createAnswer`/`createOffer` runs — so they are one function:
 * everything else, from the microphone constraints to the gather wait to the teardown on
 * failure, has to be identical or one direction quietly loses a rail.
 */
export async function startCallMedia(options: CallMediaOptions): Promise<CallMedia> {
  const stream = await openMicrophone();
  const pc = new RTCPeerConnection({ iceServers: options.iceServers });
  try {
    // One element per remote STREAM, not one for the call. A meeting sends the voices
    // it wants us to hear as separate streams (the service's own
    // `multipleAudioStreams`), so a single element would play one person and drop the
    // rest — and a one-to-one call is just the case where there is exactly one.
    const remoteAudio = new RemoteAudio();
    const remoteVideo = new RemoteVideoTracks();
    pc.addEventListener("track", (event) => {
      const [remote] = event.streams;
      if (!remote) return;
      // AUDIO plays itself, from an element this module owns. VIDEO is handed to the UI
      // instead: a `<video>` has to be somewhere the user can see, and where that is is not
      // this module's decision.
      if (event.track.kind === "video") remoteVideo.add(event, remote);
      else remoteAudio.play(remote);
    });
    if (options.onConnectionStateChange) {
      pc.addEventListener("connectionstatechange", () =>
        options.onConnectionStateChange?.(pc.connectionState),
      );
    }
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

    if (options.remoteOffer) {
      await pc.setRemoteDescription({ type: "offer", sdp: fromMsSdp(options.remoteOffer) });
      await pc.setLocalDescription(await pc.createAnswer());
    } else {
      await pc.setLocalDescription(await pc.createOffer());
    }
    await waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw new Error("the browser produced no SDP");
    // Out through the service's own spelling. The service refuses a browser's transport
    // profile outright (`UnrecognizedTransportProfile`), so this is not a nicety.
    return liveCallMedia(pc, stream, remoteAudio, remoteVideo, toMsSdp(localSdp));
  } catch (error) {
    // Never leave the microphone open behind a failure: the browser would keep showing
    // the recording indicator for a call that does not exist.
    stopTracks(stream);
    pc.close();
    throw error;
  }
}

/** The microphone, asked for the way a phone call asks for it: one mono channel with
 *  the browser's own cleanup on, which is what makes a laptop speaker usable. */
async function openMicrophone(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (error) {
    throw new MicrophoneUnavailableError(error);
  }
}

/** Wait until ICE gathering is complete, or until {@link GATHER_TIMEOUT_MS}.
 *
 *  Resolves rather than rejects on the timeout: the SDP gathered so far is still worth
 *  sending, and a host candidate alone connects a call on the same network. */
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

/**
 * Every voice on the call, one `<audio>` element per remote stream.
 *
 * Owned here and made here: an `<audio>` in the React tree would be unmounted by any
 * navigation, and the call would go silent while it was still up.
 *
 * Keyed by stream id, so a stream announced twice (a renegotiation re-fires `track`)
 * plays once, and a meeting that adds a fifth voice adds a fifth element rather than
 * replacing the fourth. Each element removes itself when its stream ends, and
 * {@link RemoteAudio.stop} removes whatever is left.
 */
class RemoteAudio {
  private elements = new Map<string, HTMLAudioElement>();

  play(stream: MediaStream): void {
    const existing = this.elements.get(stream.id);
    if (existing) {
      existing.srcObject = stream;
      return;
    }
    const audio = document.createElement("audio");
    audio.autoplay = true;
    // Nothing to look at, and nothing for a screen reader to announce: the bar in the
    // UI is what says a call is up.
    audio.hidden = true;
    audio.setAttribute("data-testid", "call-remote-audio");
    audio.srcObject = stream;
    document.body.append(audio);
    this.elements.set(stream.id, audio);
    // A voice that leaves the call takes its element with it, so a long meeting does
    // not accumulate one dead element per person who came and went.
    stream.addEventListener("removetrack", () => {
      if (stream.getAudioTracks().length === 0) this.drop(stream.id);
    });
  }

  private drop(id: string): void {
    const audio = this.elements.get(id);
    if (!audio) return;
    audio.srcObject = null;
    audio.remove();
    this.elements.delete(id);
  }

  stop(): void {
    for (const id of [...this.elements.keys()]) this.drop(id);
  }
}

/**
 * Every video stream arriving on the call, keyed by the section it arrived on.
 *
 * Unlike {@link RemoteAudio} this owns no element: a `<video>` has to be somewhere the user
 * can see, and where that is belongs to the UI. What this owns is the MAPPING — which mid,
 * which stream id, which label — because that is what a source request is addressed by and
 * it exists nowhere else.
 *
 * Keyed by mid rather than by stream id, because the service reuses a section: when a
 * subscription moves from one person to another the same mid carries a new stream, and a map
 * keyed by stream would grow a dead entry per switch.
 */
class RemoteVideoTracks {
  private byMid = new Map<string, RemoteVideo>();
  private labels = new Map<string, string>();
  onChange?: (videos: RemoteVideo[]) => void;

  /** Remember what the service's own offer called each section, before answering it. */
  learnLabels(offerSdp: string): void {
    for (const [mid, label] of labelsByMid(offerSdp)) this.labels.set(mid, label);
  }

  add(event: RTCTrackEvent, stream: MediaStream): void {
    const mid = event.transceiver?.mid;
    // A section with no mid cannot be subscribed to — the request names it — so there is
    // nothing useful to keep. It should not happen: the service's offer states every mid.
    if (!mid) return;
    const label = this.labels.get(mid) ?? "";
    this.byMid.set(mid, {
      mid,
      streamMsid: stream.id,
      label,
      sharing: label === SHARING_LABEL,
      stream,
    });
    // A track that ends takes its tile with it, so a screen somebody stopped sharing does
    // not stay on screen as a frozen last frame.
    event.track.addEventListener("ended", () => {
      if (this.byMid.get(mid)?.stream === stream) {
        this.byMid.delete(mid);
        this.notify();
      }
    });
    this.notify();
  }

  get videos(): RemoteVideo[] {
    return [...this.byMid.values()];
  }

  private notify(): void {
    this.onChange?.(this.videos);
  }

  clear(): void {
    this.byMid.clear();
    this.labels.clear();
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function liveCallMedia(
  pc: RTCPeerConnection,
  stream: MediaStream,
  remoteAudio: RemoteAudio,
  remoteVideo: RemoteVideoTracks,
  localSdp: string,
): CallMedia {
  let stopped = false;
  // One at a time. The service can offer twice in a row, and `setRemoteDescription` on a
  // connection already applying one throws — so offers are queued rather than raced.
  let negotiating: Promise<unknown> = Promise.resolve();
  const media: CallMedia = {
    localSdp,
    async setRemoteAnswer(sdp: string): Promise<void> {
      // A late answer for a call already gone is not an error worth throwing: the
      // teardown has already released everything.
      if (stopped) return;
      // `have-local-offer` is the only state an answer applies to. Anything else means
      // the answer arrived twice, and applying it again rolls the call back.
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: fromMsSdp(sdp) });
    },
    async answerRemoteOffer(sdp: string): Promise<string | null> {
      const run = negotiating.then(async () => {
        if (stopped) return null;
        // The labels come off the OFFER, and they are read before it is applied: the
        // service says which section is a screen and which is a camera, the browser's own
        // description says neither, and the answer has to put each one back.
        remoteVideo.learnLabels(sdp);
        const labels = labelsByMid(sdp);
        await pc.setRemoteDescription({ type: "offer", sdp: fromMsSdp(sdp) });
        await pc.setLocalDescription(await pc.createAnswer());
        // No wait for ICE here, deliberately: the transport is already up and this
        // renegotiation adds sections to it, not candidates. Waiting would delay a
        // colleague's screen by the gather timeout for nothing.
        const answer = pc.localDescription?.sdp;
        return answer ? toMsSdp(answer, labels) : null;
      });
      negotiating = run.catch(() => {});
      return run;
    },
    setMuted(muted: boolean): void {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopTracks(stream);
      pc.close();
      remoteAudio.stop();
      remoteVideo.clear();
    },
    get connectionState() {
      return stopped ? "closed" : pc.connectionState;
    },
    get remoteVideo() {
      return stopped ? [] : remoteVideo.videos;
    },
  };
  remoteVideo.onChange = (videos) => media.onRemoteVideoChange?.(videos);
  return media;
}

/**
 * The same interface with no media behind it, for the mock backend.
 *
 * It opens no microphone and produces a syntactically real (but inert) SDP, so the whole
 * signaling flow, the in-call bar, mute and hang-up are exercised with nothing leaving
 * the machine and no permission prompt. The app only ever picks this when the backend
 * announced itself as the mock (`backend_info`), which no real backend does.
 */
export function simulatedCallMedia(): CallMedia {
  let stopped = false;
  const media: CallMedia = {
    localSdp: SIMULATED_SDP,
    async setRemoteAnswer(): Promise<void> {},
    // A renegotiation IS reproduced, because it is the whole path a shared screen arrives
    // on and the mock is the only place that path can be reviewed. The answer is inert and
    // the video is drawn from a canvas the mock's own offer names, so a tile appears with no
    // tenant, no camera and no permission prompt.
    async answerRemoteOffer(sdp: string): Promise<string | null> {
      if (stopped) return null;
      for (const [mid, label] of labelsByMid(sdp)) {
        // Only the sections that carry a PICTURE. The offer labels its audio and its data
        // sections too, and a stand-in that made a tile for those drew an empty rectangle
        // for the call's own voices — which is exactly the sort of thing a mock is supposed
        // to catch before a real meeting does.
        if (!VIDEO_LABELS.includes(label)) continue;
        const stream = simulatedVideoStream();
        media.remoteVideo.push({
          mid,
          streamMsid: stream.id,
          label,
          sharing: label === SHARING_LABEL,
          stream,
        });
      }
      media.onRemoteVideoChange?.(media.remoteVideo);
      return SIMULATED_SDP;
    },
    // Muting is the one thing that needs no stand-in: there is no track to disable, and
    // the state the UI draws comes from the backend either way.
    setMuted(): void {},
    stop(): void {
      stopped = true;
      media.remoteVideo.length = 0;
    },
    get connectionState(): RTCPeerConnectionState {
      return stopped ? "closed" : "connected";
    },
    // A plain array here rather than a getter: the mock pushes into it, and the whole point
    // of this object is that it needs no peer connection behind it.
    remoteVideo: [],
  };
  return media;
}

/**
 * A moving picture with no camera and no tenant: a canvas nobody draws on, captured.
 *
 * `captureStream` gives a real `MediaStream` with a real video track, so every consumer —
 * the tile, the `<video>` element, the stream id a subscription would name — behaves exactly
 * as it does live. It is blank, which is the honest thing for a stand-in to be.
 */
function simulatedVideoStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#1f1f1f";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  // One frame per second: this stands in for a picture, and a mock that burned a core
  // animating it would slow every capture that opens a call.
  return canvas.captureStream(1);
}

/** The labels that name a section carrying a picture. The service labels every section,
 *  audio and data included, so a reader that wants video has to say which. */
const VIDEO_LABELS = ["main-video", SHARING_LABEL];

/** A minimal, valid audio offer. Never sent anywhere real: the mock is the only backend
 *  that ever sees it. */
const SIMULATED_SDP = [
  "v=0",
  "o=- 0 0 IN IP4 127.0.0.1",
  "s=teams-lite-mock",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=sendrecv",
  "",
].join("\r\n");
