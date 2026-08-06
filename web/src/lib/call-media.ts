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
 *   so the call plays as many as it is sent (see {@link RemoteAudio}). Those streams are
 *   also READABLE ({@link CallAudio}), because a recording of the call has to carry every
 *   voice in it and this is the only place they exist — reading them plays nothing.
 * - **Stopping releases the microphone.** The browser shows a recording indicator for as
 *   long as a track is live, so every path out of a call — hang up, the far side hanging
 *   up, an error, the page closing — goes through {@link CallMedia.stop}.
 *
 * The mock backend has no media at all, so this module exports the interface twice: the
 * real implementation, and a simulated one the app uses when the backend announced
 * itself as the mock. That is what makes the whole calling surface reviewable with
 * nothing leaving the machine.
 */

import { fromMsSdp, labelsByMid, rejectedLabels, SHARING_LABEL, toMsSdp } from "./ms-sdp";

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

/** The two things this app can send beyond a microphone. */
export type SendKind = "camera" | "screen";

/**
 * Why a capture ended without this app asking. The two are told apart because one of them
 * has to be EXPLAINED and the other must not be.
 */
export type SendingEndedReason =
  /** The browser's own "Stop sharing" bar. The user pressed it, so there is nothing to say:
   *  a notice here would report their own click back to them. */
  | "browser"
  /** The far side DROPPED the section. The user turned the capture on, nothing on this page
   *  took it off, and the only thing that can tell them is a sentence. */
  | "dropped"
  /**
   * The far side never accepted the section at all: it was rejected in the very answer to
   * the offer that added it, so the picture never went anywhere.
   *
   * Told apart from a drop because the two need OPPOSITE advice, and this app gave the
   * wrong one to a real user: a share the meeting refused was reported as one it had
   * dropped, so they were told to share it again — which failed in exactly the same way,
   * in the same second. A capture that never worked is not a capture that stopped.
   */
  | "refused";

/** What one of those looks like locally, for the preview the sender sees. */
export type LocalVideo = {
  kind: SendKind;
  stream: MediaStream;
};

/**
 * Every VOICE on the call, as streams: the user's own microphone, and one stream per
 * person the service is sending.
 *
 * It exists for exactly one reader — the recorder (see {@link ./call-recorder}) — because a
 * recording of a call has to carry the audio of everybody in it, and the audio of everybody
 * in it exists nowhere else: the remote streams play through elements this module owns and
 * the microphone is a local variable. Nothing else reads it, and nothing here plays it: the
 * `<audio>` elements are still the only thing that makes a call audible.
 */
export type CallAudio = {
  /** The user's own microphone, or null once the call is over. */
  microphone: MediaStream | null;
  /** One stream per remote voice, in the order they arrived. */
  remote: MediaStream[];
};

/** One live call's media. */
export type CallMedia = {
  /** The SDP this side produced — the offer for an outgoing call, the answer for an
   *  incoming one. Complete, with candidates. */
  readonly localSdp: string;
  /** Apply the far side's SDP answer (outgoing calls only). */
  setRemoteAnswer(sdp: string): Promise<void>;
  /**
   * Whether the first offer/answer exchange has completed, so this connection is carrying
   * media.
   *
   * It is what tells THE answer — the one that makes a call a call — from the answer to a
   * renegotiation of ours, which is a camera or a screen on a call that is already up. The
   * two arrive on the same frame and need opposite reactions: without the first, nothing
   * will ever be heard and the call is over; without a later one, one picture is missing
   * and the call is untouched. Read off the connection itself rather than counted, because
   * a count would have to be kept in step with every path that applies a description.
   */
  readonly negotiated: boolean;
  /**
   * Take back an offer of ours the far side answered in a way this browser cannot read, and
   * release what that offer was carrying.
   *
   * The answer is gone, so the offer will never be completed: the connection is rolled back
   * to the state it was in before the attempt — otherwise it sits in `have-local-offer` and
   * every later renegotiation is rolled back under it by the browser instead — and every
   * capture is released, because a camera whose light is on while nothing is sent is the
   * failure {@link onSendingEnded} already exists for.
   *
   * Returns the kinds it released and the offer that says what this side sends now, for the
   * caller to post: only the caller can reach the backend.
   */
  abandonLocalOffer(): Promise<{ released: SendKind[]; offer: string | null }>;
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
  /** Every voice on the call right now — the microphone, and each remote stream. See
   *  {@link CallAudio}. */
  readonly audio: CallAudio;
  /** Called when a voice joins or leaves, so a recording already running picks up the
   *  person who spoke up after it started. */
  onAudioChange?: (audio: CallAudio) => void;
  /**
   * Open the camera (or the screen) and return the OFFER to hand the backend.
   *
   * The call was negotiated with audio alone, so this adds a section that does not exist yet
   * and the service only accepts that on an established call. The browser asks its own
   * permission first, which is the second gate under the user's click.
   *
   * Throws {@link CaptureUnavailableError} when they refuse it or there is no device — a
   * refusal is not a bug and the UI explains it rather than reporting it.
   */
  startSending(kind: SendKind): Promise<string>;
  /**
   * Stop sending one of them, and return the offer that says so — or `null` when it was not
   * being sent.
   *
   * The track is stopped HERE whatever the offer does afterwards: a camera whose light stays
   * on because a POST failed is the worst possible outcome of turning it off.
   */
  stopSending(kind: SendKind): Promise<string | null>;
  /** What this page is sending, for the preview the sender sees. */
  readonly localVideo: LocalVideo[];
  /** Called when {@link localVideo} changes — including when the BROWSER stops a screen
   *  share from its own bar, which no click of ours would report. */
  onLocalVideoChange?: (videos: LocalVideo[]) => void;
  /**
   * Called when a capture ended WITHOUT this app asking — the browser's own "Stop sharing",
   * or a section the far side dropped.
   *
   * `offer` is the renegotiation that takes the section down, for the caller to post. It
   * exists because only the caller can reach the backend, and the service has to be told or
   * the meeting keeps a section that carries nothing. `reason` decides whether the user is
   * told anything at all (see {@link SendingEndedReason}).
   */
  onSendingEnded?: (kind: SendKind, offer: string | null, reason: SendingEndedReason) => void;
};

/** What starting media needs. `remoteOffer` is present when answering a call. */
export type CallMediaOptions = {
  iceServers: RTCIceServer[];
  remoteOffer?: string;
  /**
   * Whether this call is between exactly TWO people, which decides whether the sections a
   * camera and a screen go out on are negotiated NOW (see {@link LocalSenders.reserve}).
   *
   * It is the real client's own split: `numVideoChannels` is `1` on a one-to-one and its
   * `addModalities` forces both modalities inactive at the first negotiation, while a
   * CONFERENCE offers audio alone and adds a section when somebody turns a capture on.
   * Defaults to false, which is the behaviour this app already had.
   */
  oneToOne?: boolean;
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

/** Thrown when the camera or the screen could not be opened — refused, or absent.
 *
 *  Separate from the microphone's for the same reason that one is separate: refusing to show
 *  a camera is a decision, not a fault, and a call carries on without it. The message names
 *  which one, because "could not open the camera" and "could not share the screen" send the
 *  reader to different places. */
export class CaptureUnavailableError extends Error {
  constructor(
    readonly kind: SendKind,
    cause: unknown,
  ) {
    super(
      kind === "camera"
        ? "teams-lite could not open the camera."
        : "teams-lite could not capture the screen.",
    );
    this.name = "CaptureUnavailableError";
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
  // One element per remote STREAM, not one for the call. A meeting sends the voices it wants
  // us to hear as separate streams (the service's own `multipleAudioStreams`), so a single
  // element would play one person and drop the rest — and a one-to-one call is just the case
  // where there is exactly one.
  //
  // All three live OUTSIDE the try, so the teardown below can reach them: a failure between
  // here and the offer must release every capture, not only the microphone.
  const remoteAudio = new RemoteAudio();
  const remoteVideo = new RemoteVideoTracks();
  // A CONFERENCE filters the video codecs it offers and a one-to-one does not, which is the
  // client's own split — so the kind is decided once, here, and every section follows it.
  const senders = new LocalSenders(!options.oneToOne);
  try {
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
      // Their offer already holds the sections a camera and a screen go out on — the real
      // client puts them in every first offer — so ours are ADOPTED from it rather than added
      // later. Read from the offer as it arrived, because the labels are what name them.
      senders.adopt(pc, labelsByMid(options.remoteOffer));
    } else {
      // The sections a capture will need, negotiated NOW while nothing is being sent — on a
      // one-to-one, which is where the client reserves them and where a section added later
      // was refused. A conference offers audio alone, exactly as the client does.
      if (options.oneToOne) senders.reserve(pc);
      await pc.setLocalDescription(await pc.createOffer());
    }
    await waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw new Error("the browser produced no SDP");
    // Out through the service's own spelling. The service refuses a browser's transport
    // profile outright (`UnrecognizedTransportProfile`), so this is not a nicety — and the
    // reserved sections travel with their own labels, since `applicationsharing-video` is
    // not derivable from an `m=video` line.
    return liveCallMedia(
      pc,
      stream,
      remoteAudio,
      remoteVideo,
      senders,
      toMsSdp(localSdp, senders.labels()),
    );
  } catch (error) {
    // Never leave the microphone open behind a failure: the browser would keep showing
    // the recording indicator for a call that does not exist.
    stopTracks(stream);
    senders.stopAll();
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
  /** The streams themselves, kept beside their elements for the recorder. An element's
   *  `srcObject` would answer the same question, but reading media back out of the DOM to
   *  hand it to a mixer is a dependency on how this class happens to play a voice. */
  private streamsById = new Map<string, MediaStream>();
  /** Called when a voice joins or leaves. The recorder listens so a person who unmutes
   *  themselves five minutes in is in the recording too. */
  onChange?: () => void;

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
    this.streamsById.set(stream.id, stream);
    // A voice that leaves the call takes its element with it, so a long meeting does
    // not accumulate one dead element per person who came and went.
    stream.addEventListener("removetrack", () => {
      if (stream.getAudioTracks().length === 0) this.drop(stream.id);
    });
    this.onChange?.();
  }

  /** Every remote voice, in the order it arrived. */
  get streams(): MediaStream[] {
    return [...this.streamsById.values()];
  }

  private drop(id: string): void {
    const audio = this.elements.get(id);
    if (!audio) return;
    audio.srcObject = null;
    audio.remove();
    this.elements.delete(id);
    this.streamsById.delete(id);
    this.onChange?.();
  }

  stop(): void {
    for (const id of [...this.elements.keys()]) this.drop(id);
  }
}

/** The kinds whose section is negotiated up front, in the order the client lists them: a
 *  camera, then a screen (see {@link LocalSenders.reserve}). */
const RESERVED_KINDS: readonly SendKind[] = ["camera", "screen"];

/**
 * The video codecs a CONFERENCE offers, in the client's own order.
 *
 * `allowedVideoCodecsMultiparty: [{video/H264}, {video/AV1}, {video/rtx}]` with
 * `filterCodecsInSdpMultiparty: true` — so the offer a real client sends into a meeting or a
 * group call carries these three and nothing else, while Chrome's own offer also carries VP8,
 * VP9 and every payload it can decode. A ONE-TO-ONE is filtered by neither
 * (`allowedVideoCodecs: []`, `filterCodecsInSdp: false`), which is why this is not applied
 * there: the client lets Chrome's whole list travel on a two-party call.
 *
 * `rtx` is in the list and has to stay: it is retransmission for the codecs above it, and a
 * video stream without it loses a frame to every dropped packet.
 */
const CONFERENCE_VIDEO_CODECS = ["video/h264", "video/av1", "video/rtx"];

/**
 * The codecs to offer a conference, picked out of what this browser can do.
 *
 * Pure, so the order and the omissions are unit-tested: `setCodecPreferences` takes the list
 * in the order it will appear on the wire, and a browser's own list is longer and differently
 * ordered on every machine. An empty answer means "say nothing" — a browser holding none of
 * them cannot send a picture this service reads whatever this app asks for.
 */
export function conferenceVideoCodecs(
  available: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  return CONFERENCE_VIDEO_CODECS.flatMap((mimeType) =>
    available.filter((codec) => codec.mimeType.toLowerCase() === mimeType),
  );
}

/**
 * Which capture, if any, a section carrying this label is for — the whole decision
 * {@link LocalSenders.adopt} makes about an incoming offer.
 *
 * The LABEL is the only thing that answers it: a camera and a screen are both `m=video`, and
 * the service reads that label rather than the kind. A section labelled anything else —
 * `main-audio`, `data`, or a name this app has not heard of — is not ours to send on, and
 * claiming one would put the user's screen on a section the far side described otherwise.
 */
export function reservedKindFor(label: string | undefined): SendKind | undefined {
  return RESERVED_KINDS.find((kind) => SEND_LABELS[kind] === label);
}

/** The service's own label for each kind this app can send. It is not derivable from the
 *  m-line — both are `m=video` — and it is what the service reads to tell them apart. */
const SEND_LABELS: Record<SendKind, string> = {
  camera: "main-video",
  screen: SHARING_LABEL,
};

/**
 * Open one of the two capture devices.
 *
 * The camera is asked for at a size a tile in a meeting is drawn at rather than at whatever
 * the device offers: a 4K webcam encoded at 4K to be shown 128 px wide costs the user's
 * upload and their battery for nothing. The screen is asked for unconstrained in size,
 * because a screen is text and downscaled text is unreadable — which is the entire reason
 * somebody shares one.
 */
async function openCapture(kind: SendKind): Promise<MediaStream> {
  try {
    if (kind === "camera") {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
        audio: false,
      });
    }
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } },
      // NEVER the system audio. The user is already on this call with their microphone, and a
      // second audio track from the screen would put every sound on their machine into a
      // meeting they only meant to show a picture to.
      audio: false,
    });
  } catch (error) {
    throw new CaptureUnavailableError(kind, error);
  }
}

/**
 * Whether the far side has DROPPED a section, so nothing here may touch it again.
 *
 * The service can reject a section this app offered — a rejected m-line in its answer, or an
 * offer of its own that leaves it out — and the browser then STOPS that transceiver: it
 * carries nothing, it loses its mid, and every setter on it throws `InvalidStateError`. So a
 * stopped section is read as ABSENT: never written to, never handed back for reuse, and a
 * capture turned on again gets a new one. It used to be written to, and the browser's own
 * sentence about an object the user has never heard of — "The transceiver is stopped" —
 * reached them as the report of a camera they had just switched off.
 */
export function sectionIsStopped(
  transceiver: Pick<RTCRtpTransceiver, "direction" | "currentDirection">,
): boolean {
  // Both halves, because the spec states the stop in `currentDirection` while a browser's
  // own `direction` getter reports it too, and either one saying so is the answer.
  return transceiver.currentDirection === "stopped" || transceiver.direction === "stopped";
}

/**
 * What this page is sending, and the transceivers it goes out on.
 *
 * A transceiver is REUSED per kind: a camera turned off and on again takes the section it
 * already had, because every added section is one more m-line the far side must accept and
 * the count would otherwise only grow. A section the far side dropped is the one exception —
 * see {@link sectionIsStopped}.
 */
class LocalSenders {
  /**
   * Whether this call is a CONFERENCE — a meeting, or a group chat's call.
   *
   * It decides one thing: which video codecs a section offers (see
   * {@link CONFERENCE_VIDEO_CODECS}). The client filters them there and nowhere else.
   */
  constructor(private readonly conference: boolean) {}

  private live = new Map<SendKind, { transceiver: RTCRtpTransceiver; stream: MediaStream }>();
  /** Sections of a kind that was switched off. Kept so switching it on reuses one, and so
   *  its LABEL survives: the section is still in the SDP, and relabelling it would describe
   *  a different stream on a section the far side already knows. */
  private idle = new Map<SendKind, RTCRtpTransceiver>();
  /** The kinds whose section the far side has ACCEPTED at least once, so a capture that
   *  really carried a picture can be told from one that never did. Cleared per kind when it
   *  is switched off, because the next section is negotiated again from nothing. */
  private accepted = new Set<SendKind>();
  onChange?: (videos: LocalVideo[]) => void;
  /** Called when the BROWSER ends a capture by itself — the "Stop sharing" bar it draws over
   *  every screen share, which no click of ours passes through. */
  onEndedByBrowser?: (kind: SendKind) => void;

  /**
   * Negotiate the sections a capture will need, before anything is being sent.
   *
   * **This is what the real client does, and the reason a screen share was refused without
   * it.** Its own `addModalities` forces `video` and `sharing` to `inactive` on the first
   * negotiation of a one-to-one call, so every section exists from the very first offer — a
   * captured audio-only join carries `a=group:BUNDLE 0 1 … 12`, twelve sections of which
   * carry nothing. This app offered one audio section and then asked the service to accept a
   * NEW `applicationsharing-video` mid-call; the service answered by zeroing its port, and
   * the user's share never went anywhere (NATIVE-CALLING.md § 10.8).
   *
   * So a capture is an ACTIVATION from here on: {@link start} finds the section already
   * negotiated and swaps a track into it, which is the reinviteless shape the client's own
   * `removeSender` reads. `inactive` is what makes that safe — a reserved section publishes
   * nothing about the user, and no camera or screen is opened until they ask.
   */
  reserve(pc: RTCPeerConnection): void {
    for (const kind of RESERVED_KINDS) {
      if (this.live.has(kind) || this.idle.has(kind)) continue;
      this.idle.set(kind, this.addVideoSection(pc, { direction: "inactive" }));
    }
  }

  /**
   * Add one video section, offering the codecs this call's kind offers.
   *
   * Every section this app sends on comes through here, so the codec list cannot be forgotten
   * on one of the two paths — which is the class of bug the reserved sections were added for.
   */
  private addVideoSection(pc: RTCPeerConnection, init: RTCRtpTransceiverInit): RTCRtpTransceiver {
    const transceiver = pc.addTransceiver("video", init);
    this.restrictCodecs(transceiver);
    return transceiver;
  }

  /**
   * Offer a CONFERENCE the three video codecs a real client offers it, in its own order.
   *
   * A browser offers everything it can decode — VP8, VP9, AV1, H.264 — and the service is
   * given a section it did not ask for in a list it does not use. Its own offers carry
   * `H264/90000` alone, and the client filters its outgoing list to match on every multiparty
   * call. This is the one place that list is applied, and a browser that refuses the call
   * keeps its own preferences: a section offering too much is better than no section.
   */
  private restrictCodecs(transceiver: RTCRtpTransceiver): void {
    if (!this.conference) return;
    const capabilities = RTCRtpReceiver.getCapabilities?.("video");
    if (!capabilities || typeof transceiver.setCodecPreferences !== "function") return;
    const wanted = conferenceVideoCodecs(capabilities.codecs);
    // Nothing to say when the browser has none of them — H.264 is the one that matters, and a
    // browser without it cannot send a picture this service reads whatever we ask for.
    if (wanted.length === 0) return;
    try {
      transceiver.setCodecPreferences(wanted);
    } catch {
      // A browser that refuses the list keeps its own, which is what happened before this.
    }
  }

  /**
   * Take over the sections an INCOMING offer already carries, by the label each one states.
   *
   * The far side is a real Teams client, so its offer holds the same layout {@link reserve}
   * builds — there is nothing to add, and adding one anyway is what the service refuses. A
   * section is claimed only when its label names one of ours and nothing holds that kind yet:
   * this runs once, at the start of a call, and a second claim would take a section a live
   * capture is using.
   */
  adopt(pc: RTCPeerConnection, labels: Map<string, string>): void {
    for (const transceiver of pc.getTransceivers()) {
      const mid = transceiver.mid;
      if (!mid || sectionIsStopped(transceiver)) continue;
      const kind = reservedKindFor(labels.get(mid));
      if (!kind || this.live.has(kind) || this.idle.has(kind)) continue;
      this.idle.set(kind, transceiver);
    }
  }

  async start(pc: RTCPeerConnection, kind: SendKind): Promise<void> {
    const stream = await openCapture(kind);
    // A capture that is starting has not been accepted by anybody yet, even when it takes
    // back a section the far side once agreed to: the direction changed, so the section is
    // negotiated again and the answer to THAT is what says whether a picture goes out.
    this.accepted.delete(kind);
    const [track] = stream.getVideoTracks();
    if (!track) throw new CaptureUnavailableError(kind, new Error("the capture had no video"));
    // The browser's own bar stops a share without telling this app anything. Without this the
    // meeting would keep a section carrying nothing while the button still said on.
    track.addEventListener("ended", () => this.onEndedByBrowser?.(kind));
    const reuse = this.reusable(kind);
    if (reuse) {
      this.idle.delete(kind);
      await reuse.sender.replaceTrack(track);
      reuse.direction = "sendonly";
      this.live.set(kind, { transceiver: reuse, stream });
    } else {
      const transceiver = this.addVideoSection(pc, {
        direction: "sendonly",
        streams: [stream],
      });
      await transceiver.sender.replaceTrack(track);
      this.live.set(kind, { transceiver, stream });
    }
    this.notify();
  }

  /** A section of this kind to take back, if there is one that still carries anything.
   *
   *  A stopped one is forgotten rather than reused, so a rejected section cannot be written
   *  to and the dead ones cannot pile up. */
  private reusable(kind: SendKind): RTCRtpTransceiver | undefined {
    const held = this.live.get(kind)?.transceiver ?? this.idle.get(kind);
    if (!held) return undefined;
    if (!sectionIsStopped(held)) return held;
    this.idle.delete(kind);
    return undefined;
  }

  /** The kinds whose section the far side has DROPPED. Read after a remote description is
   *  applied: it is the only moment a transceiver of ours can be stopped. */
  stoppedKinds(): SendKind[] {
    return [...this.live]
      .filter(([, held]) => sectionIsStopped(held.transceiver))
      .map(([kind]) => kind);
  }

  /**
   * Write down which sections the far side has ACCEPTED, from the description just applied.
   *
   * `currentDirection` is the negotiated direction, so it says `sendonly` on a section the
   * far side agreed to receive and `stopped` on one it threw out. It has to be read at this
   * moment: a section rejected LATER is stopped too, and by then the two cannot be told
   * apart — which is the whole difference between a share that stopped and a share that
   * never worked.
   */
  noteAccepted(): void {
    for (const [kind, held] of this.live) {
      if (held.transceiver.currentDirection === "sendonly") this.accepted.add(kind);
    }
  }

  /** Whether a section of this kind has ever carried a picture to the far side. */
  wasAccepted(kind: SendKind): boolean {
    return this.accepted.has(kind);
  }

  /** Stop one, and say whether there was anything to stop. */
  async stop(kind: SendKind): Promise<boolean> {
    const held = this.live.get(kind);
    if (!held) return false;
    // The TRACK first, always. Everything after this can fail, and the camera light going out
    // must not depend on any of it.
    for (const track of held.stream.getTracks()) track.stop();
    this.live.delete(kind);
    // A section the far side already dropped is neither kept for reuse nor written to: both
    // would throw, and the throw used to reach the user as the browser's own words.
    if (!sectionIsStopped(held.transceiver)) {
      this.idle.set(kind, held.transceiver);
      await held.transceiver.sender.replaceTrack(null).catch(() => {});
      held.transceiver.direction = "inactive";
    }
    this.notify();
    return true;
  }

  /** The label each of our own sections must carry, keyed by mid. Read AFTER
   *  `setLocalDescription`, because a transceiver has no mid before one. */
  labels(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [kind, held] of this.live) {
      if (held.transceiver.mid) out.set(held.transceiver.mid, SEND_LABELS[kind]);
    }
    for (const [kind, transceiver] of this.idle) {
      if (transceiver.mid) out.set(transceiver.mid, SEND_LABELS[kind]);
    }
    return out;
  }

  get videos(): LocalVideo[] {
    return [...this.live].map(([kind, held]) => ({ kind, stream: held.stream }));
  }

  get kinds(): SendKind[] {
    return [...this.live.keys()];
  }

  private notify(): void {
    this.onChange?.(this.videos);
  }

  stopAll(): void {
    for (const held of this.live.values()) {
      for (const track of held.stream.getTracks()) track.stop();
    }
    this.live.clear();
    this.idle.clear();
    this.accepted.clear();
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

  /** Every label learned so far. An offer of OURS has to restate them: a section the service
   *  named is one the far side already knows by that name. */
  knownLabels(): Map<string, string> {
    return new Map(this.labels);
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
  senders: LocalSenders,
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
      senders.noteAccepted();
      releaseDroppedSections();
    },
    get negotiated() {
      // `currentRemoteDescription` is the last description that was ANSWERED — the offer
      // this side answered when it took the call, or the answer it applied when it placed
      // one. It is null until one of those happened and it never goes back to null, which
      // is exactly the question `negotiated` asks.
      return pc.currentRemoteDescription !== null;
    },
    async abandonLocalOffer(): Promise<{ released: SendKind[]; offer: string | null }> {
      if (stopped) return { released: [], offer: null };
      // The rollback is queued with every other description change, because it is one: run
      // beside a renegotiation being applied it would be the glare the queue exists for.
      const run = negotiating.then(async () => {
        // Only an offer of OURS can be taken back, and only while it is still pending. The
        // answer may have arrived twice, and the second one finds nothing to roll back.
        if (pc.signalingState === "have-local-offer") {
          await pc.setLocalDescription({ type: "rollback" });
        }
      });
      negotiating = run.catch(() => {});
      // A rollback that fails changes nothing about what must happen next: the captures are
      // released either way, or the user is left with a camera light and no picture going out.
      await run.catch(() => {});
      const released = senders.kinds;
      for (const kind of released) await senders.stop(kind);
      // An offer carrying nothing of ours is one the far side asked for. There is nothing to
      // take back from the service and nothing for the caller to post.
      if (released.length === 0) return { released, offer: null };
      return { released, offer: await offerLocalMedia() };
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
      const answer = await run;
      // Their offer can leave a section of OURS out. It is read once the offer is applied and
      // outside the queue above, because taking a capture down enqueues an offer of its own.
      senders.noteAccepted();
      releaseDroppedSections();
      return answer;
    },
    setMuted(muted: boolean): void {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    async startSending(kind: SendKind): Promise<string> {
      if (stopped) throw new CaptureUnavailableError(kind, new Error("the call is over"));
      await senders.start(pc, kind);
      const offer = await offerLocalMedia();
      if (!offer) throw new CaptureUnavailableError(kind, new Error("no offer was produced"));
      return offer;
    },
    async stopSending(kind: SendKind): Promise<string | null> {
      if (stopped) return null;
      if (!(await senders.stop(kind))) return null;
      return offerLocalMedia();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopTracks(stream);
      senders.stopAll();
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
    get localVideo() {
      return stopped ? [] : senders.videos;
    },
    get audio(): CallAudio {
      // A call that is over has no voices, microphone included: every track on it has been
      // stopped, and handing a stopped track to a mixer records silence under a name.
      return stopped
        ? { microphone: null, remote: [] }
        : { microphone: stream, remote: remoteAudio.streams };
    },
  };

  /**
   * Make the offer that says what this side is now sending.
   *
   * It is serialized behind the same queue the incoming renegotiations use, because they are
   * the same connection and the same signaling state: an offer built while an answer is being
   * applied is glare, and the browser throws rather than guessing.
   *
   * Every section's label is restated — the ones the service named on its own offers, and
   * ours — because a label is per section and an offer that dropped one would rename a stream
   * the far side already knows.
   */
  async function offerLocalMedia(): Promise<string | null> {
    const run = negotiating.then(async () => {
      if (stopped) return null;
      await pc.setLocalDescription(await pc.createOffer());
      const local = pc.localDescription?.sdp;
      if (!local) return null;
      const labels = new Map([...remoteVideo.knownLabels(), ...senders.labels()]);
      return toMsSdp(local, labels);
    });
    negotiating = run.catch(() => {});
    return run;
  }

  /**
   * Release every capture whose section the far side DROPPED.
   *
   * A rejected section is the worst shape this surface has: the camera light stays on, the
   * preview keeps moving and the button still says the meeting can see it, while nothing is
   * being sent at all. It is the browser's own "Stop sharing" from the other end — this app
   * did not ask for it either — so it ends down the same path, which releases the capture and
   * hands the caller the offer that tells the service.
   */
  function releaseDroppedSections(): void {
    for (const kind of senders.stoppedKinds()) {
      // WHICH of the two it is, read before the release: a section the far side accepted and
      // then took away is a picture that stopped, and one it never accepted is a picture that
      // never went out. Telling the user to share it again is right for the first and sends
      // them into the same failure for the second.
      const reason: SendingEndedReason = senders.wasAccepted(kind) ? "dropped" : "refused";
      void media.stopSending(kind).then((offer) => media.onSendingEnded?.(kind, offer, reason));
    }
  }

  remoteVideo.onChange = (videos) => media.onRemoteVideoChange?.(videos);
  senders.onChange = (videos) => media.onLocalVideoChange?.(videos);
  // A voice arriving or leaving. Nothing about how the call SOUNDS depends on this — the
  // elements play it either way — so the only reader is a recording already running.
  remoteAudio.onChange = () => media.onAudioChange?.(media.audio);
  // The browser's own "Stop sharing" bar. It ends the track and nothing else: this app has to
  // notice, take the section down and tell the service, or the meeting keeps a section that
  // carries nothing while the button still says on.
  senders.onEndedByBrowser = (kind) => {
    void media.stopSending(kind).then((offer) => media.onSendingEnded?.(kind, offer, "browser"));
  };
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
export function simulatedCallMedia(options: { answering: boolean }): CallMedia {
  let stopped = false;
  // The same reading the live one takes off its own connection: a call this side ANSWERED
  // was negotiated the moment it was taken, and a call it placed is negotiated when the
  // answer arrives. Passed in rather than assumed, because an accepted call sees no answer
  // frame at all — and a stand-in that reported `false` there would let a spec pass on a
  // reaction the real thing never has.
  let negotiated = options.answering;
  // One SILENT voice, made once. It stands in for the microphone so that everything
  // downstream of a call's audio — the recorder's mixer above all — runs against a real
  // `MediaStream` with a real audio track here, exactly as it does live. Silent, because
  // that is the honest thing for a stand-in to be, and because a tone would come out of the
  // reviewer's speakers.
  const microphone = simulatedAudioStream();
  const media: CallMedia = {
    localSdp: SIMULATED_SDP,
    async setRemoteAnswer(sdp: string): Promise<void> {
      // The one refusal a browser makes on the BLOB rather than on the state: a description
      // it cannot parse is thrown out whole. It is reproduced because an answer this side
      // cannot read is what a screen share really met on this tenant, and the service that
      // sends one is a real tenant — so this is the only place that reaction is reviewable.
      if (!sdp.startsWith("v=0")) throw new Error("Failed to parse SessionDescription.");
      negotiated = true;
      // A section rejected in the ANSWER to an offer of ours was never accepted at all,
      // which is what a screen share really met on this tenant. The live path reads that off
      // its own transceiver; the stand-in has none, so it reads the wire — as it already does
      // for a section the far side takes away later.
      releaseRejected(sdp, "refused");
    },
    get negotiated() {
      return negotiated;
    },
    async abandonLocalOffer(): Promise<{ released: SendKind[]; offer: string | null }> {
      // No connection to roll back — what the stand-in owns is what was being sent, and
      // releasing it is the half the surface shows.
      const released = media.localVideo.map((video) => video.kind);
      for (const kind of released) await media.stopSending(kind);
      return { released, offer: released.length === 0 ? null : SIMULATED_SDP };
    },
    // A renegotiation IS reproduced, because it is the whole path a shared screen arrives
    // on and the mock is the only place that path can be reviewed. The answer is inert and
    // the video is drawn from a canvas the mock's own offer names, so a tile appears with no
    // tenant, no camera and no permission prompt.
    async answerRemoteOffer(sdp: string): Promise<string | null> {
      if (stopped) return null;
      // A section this side is SENDING can be dropped by the offer too, and against a real
      // tenant the browser reports that by stopping the transceiver. There is none here, so
      // the stand-in reads the same fact off the wire: a rejected section, by its label.
      releaseRejected(sdp, "dropped");
      const rejected = rejectedLabels(sdp);
      for (const [mid, label] of labelsByMid(sdp)) {
        // Only the sections that carry a PICTURE. The offer labels its audio and its data
        // sections too, and a stand-in that made a tile for those drew an empty rectangle
        // for the call's own voices — which is exactly the sort of thing a mock is supposed
        // to catch before a real meeting does.
        if (!VIDEO_LABELS.includes(label)) continue;
        // A REJECTED section carries no picture, so it gets no tile. The offer still writes
        // it down, label and all, which is the whole reason a reader has to check the port.
        if (rejected.has(label)) continue;
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
    // Sending is reproduced too, and it opens NOTHING: the preview is a canvas, so a capture
    // asks no permission and no camera light comes on. That is what lets the buttons, the
    // preview and the offer be reviewed without a device — and a mock that called
    // `getDisplayMedia` would put a picker in front of every capture run.
    async startSending(kind: SendKind): Promise<string> {
      if (stopped) throw new CaptureUnavailableError(kind, new Error("the call is over"));
      if (!media.localVideo.some((video) => video.kind === kind)) {
        media.localVideo.push({ kind, stream: simulatedVideoStream() });
        media.onLocalVideoChange?.(media.localVideo);
      }
      return SIMULATED_SDP;
    },
    async stopSending(kind: SendKind): Promise<string | null> {
      const at = media.localVideo.findIndex((video) => video.kind === kind);
      if (at === -1) return null;
      for (const track of media.localVideo[at]!.stream.getTracks()) track.stop();
      media.localVideo.splice(at, 1);
      media.onLocalVideoChange?.(media.localVideo);
      return SIMULATED_SDP;
    },
    localVideo: [],
    stop(): void {
      stopped = true;
      media.remoteVideo.length = 0;
      for (const video of media.localVideo) {
        for (const track of video.stream.getTracks()) track.stop();
      }
      media.localVideo.length = 0;
      for (const track of microphone.getTracks()) track.stop();
    },
    get audio(): CallAudio {
      // The stand-in has one voice and it is the user's own: the mock sends no remote audio
      // at all, so a recording made against it carries the picture and one silent channel.
      return stopped ? { microphone: null, remote: [] } : { microphone, remote: [] };
    },
    get connectionState(): RTCPeerConnectionState {
      return stopped ? "closed" : "connected";
    },
    // A plain array here rather than a getter: the mock pushes into it, and the whole point
    // of this object is that it needs no peer connection behind it.
    remoteVideo: [],
  };

  /**
   * Release every capture whose section `sdp` rejects — the section still written down with
   * its port zeroed, which is how either side says one is gone.
   *
   * WHICH signal carried the rejection is what decides the reason, and in the stand-in that
   * reading is exact: an ANSWER to an offer of ours rejects a section that was never
   * accepted, and an OFFER of the far side's takes away one it had accepted before.
   */
  function releaseRejected(sdp: string, reason: SendingEndedReason): void {
    const rejected = rejectedLabels(sdp);
    for (const kind of ["camera", "screen"] as const) {
      if (!rejected.has(SEND_LABELS[kind])) continue;
      if (!media.localVideo.some((video) => video.kind === kind)) continue;
      void media.stopSending(kind).then((offer) => media.onSendingEnded?.(kind, offer, reason));
    }
  }

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

/**
 * A voice with nobody behind it: an oscillator at zero gain, captured.
 *
 * The twin of {@link simulatedVideoStream}, and for the same reason — a real
 * `MediaStreamTrack` behaves for every consumer exactly as a microphone's does, so the code
 * that mixes a call's audio is the code the mock exercises. The gain is 0, so the track
 * carries samples and every one of them is silence.
 *
 * The context is left as the browser gives it. A recording starts from a click, and the
 * recorder resumes what it is handed (see `call-recorder.ts`), so nothing here has to know
 * about the autoplay policy.
 */
function simulatedAudioStream(): MediaStream {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const silence = context.createGain();
  silence.gain.value = 0;
  const oscillator = context.createOscillator();
  oscillator.connect(silence).connect(destination);
  oscillator.start();
  return destination.stream;
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
