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
 * - **The SDP is not rewritten.** `application/sdp-ngc-1.0` is a label the service puts
 *   on ordinary WebRTC SDP, so what Chrome produced is what goes out. Munging it here
 *   would be guessing at a service that already accepts it.
 * - **Stopping releases the microphone.** The browser shows a recording indicator for as
 *   long as a track is live, so every path out of a call — hang up, the far side hanging
 *   up, an error, the page closing — goes through {@link CallMedia.stop}.
 *
 * The mock backend has no media at all, so this module exports the interface twice: the
 * real implementation, and a simulated one the app uses when the backend announced
 * itself as the mock. That is what makes the whole calling surface reviewable with
 * nothing leaving the machine.
 */

/** How long to wait for ICE gathering before sending what we have. Chrome finishes a
 *  host+srflx gather in well under a second; the wait only bites when a configured
 *  server is unreachable, and then it is a ceiling rather than a delay. */
const GATHER_TIMEOUT_MS = 2500;

/** One live call's media. */
export type CallMedia = {
  /** The SDP this side produced — the offer for an outgoing call, the answer for an
   *  incoming one. Complete, with candidates. */
  readonly localSdp: string;
  /** Apply the far side's SDP answer (outgoing calls only). */
  setRemoteAnswer(sdp: string): Promise<void>;
  /** Stop sending audio, or start again. The backend publishes the same state so the
   *  other side sees the crossed-out microphone. */
  setMuted(muted: boolean): void;
  /** Release the microphone and tear everything down. Safe to call twice. */
  stop(): void;
  /** Whether the peer connection is carrying media right now. */
  readonly connectionState: RTCPeerConnectionState;
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
    const remoteAudio = createRemoteAudioElement();
    pc.addEventListener("track", (event) => {
      const [remote] = event.streams;
      if (remote) remoteAudio.srcObject = remote;
    });
    if (options.onConnectionStateChange) {
      pc.addEventListener("connectionstatechange", () =>
        options.onConnectionStateChange?.(pc.connectionState),
      );
    }
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

    if (options.remoteOffer) {
      await pc.setRemoteDescription({ type: "offer", sdp: options.remoteOffer });
      await pc.setLocalDescription(await pc.createAnswer());
    } else {
      await pc.setLocalDescription(await pc.createOffer());
    }
    await waitForIceGathering(pc);

    const localSdp = pc.localDescription?.sdp;
    if (!localSdp) throw new Error("the browser produced no SDP");
    return liveCallMedia(pc, stream, remoteAudio, localSdp);
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

/** The element the far side's voice comes out of.
 *
 *  Made here and owned here: an `<audio>` in the React tree would be unmounted by any
 *  navigation, and the call would go silent while it was still up. */
function createRemoteAudioElement(): HTMLAudioElement {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  // Nothing to look at, and nothing for a screen reader to announce: the bar in the UI
  // is what says a call is up.
  audio.hidden = true;
  audio.setAttribute("data-testid", "call-remote-audio");
  document.body.append(audio);
  return audio;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function liveCallMedia(
  pc: RTCPeerConnection,
  stream: MediaStream,
  remoteAudio: HTMLAudioElement,
  localSdp: string,
): CallMedia {
  let stopped = false;
  return {
    localSdp,
    async setRemoteAnswer(sdp: string): Promise<void> {
      // A late answer for a call already gone is not an error worth throwing: the
      // teardown has already released everything.
      if (stopped) return;
      // `have-local-offer` is the only state an answer applies to. Anything else means
      // the answer arrived twice, and applying it again rolls the call back.
      if (pc.signalingState !== "have-local-offer") return;
      await pc.setRemoteDescription({ type: "answer", sdp });
    },
    setMuted(muted: boolean): void {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopTracks(stream);
      pc.close();
      remoteAudio.srcObject = null;
      remoteAudio.remove();
    },
    get connectionState() {
      return stopped ? "closed" : pc.connectionState;
    },
  };
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
  return {
    localSdp: SIMULATED_SDP,
    async setRemoteAnswer(): Promise<void> {},
    // Muting is the one thing that needs no stand-in: there is no track to disable, and
    // the state the UI draws comes from the backend either way.
    setMuted(): void {},
    stop(): void {
      stopped = true;
    },
    get connectionState(): RTCPeerConnectionState {
      return stopped ? "closed" : "connected";
    },
  };
}

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
