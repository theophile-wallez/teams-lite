import { expect, test } from "./helpers";

/**
 * GLARE, MEASURED IN A REAL BROWSER — the mechanism the camera fix rests on.
 *
 * Everything else about sending a camera needs the tenant, and every measurement of it so far
 * needed the user's own click. This half does not: the failure is entirely between this app and
 * `RTCPeerConnection`, so a real Chromium is the whole apparatus, and what it settles is the claim
 * the fix is built on — that applying a remote OFFER while an offer of ours is pending destroys the
 * section our camera is in, and reports nothing.
 *
 * It was asserted from documentation before this. That is not the same as knowing: the spec says a
 * remote offer in `have-local-offer` triggers an implicit rollback, and what the app needed to know
 * is what that leaves BEHIND — whether the transceiver ends up `stopped` (which
 * `LocalSenders.stoppedKinds` would catch and report) or merely reverted (which nothing catches).
 * The answer decides whether the bug is silent, and it is measured here rather than reasoned about.
 *
 * NO APP, NO BACKEND, NO TENANT. Two peer connections in one page, a canvas for a camera, and the
 * app's own predicate imported to decide the fix. The page is `about:blank`, so nothing here can
 * reach a conversation at all — which is also why this file needs no MOCK sentinel: it never opens
 * a socket, and the auto fixture in ./helpers closes any page that does.
 *
 * The camera is a CANVAS `captureStream`, deliberately, rather than Chromium's fake device: a real
 * `MediaStreamTrack` of kind `video` is the whole requirement, and a canvas needs no launch flag
 * and no permission, so this spec cannot be broken by the browser resolution in
 * playwright.config.ts.
 *
 * **WHAT IT MEASURED**, and every field of it is the bug:
 *
 *     applying theirs: { directionBeforeTheirOffer: "sendonly", currentDirectionAfter: null,
 *                        directionAfter: "sendonly", videoSectionInLocalSdpAfter: false,
 *                        signalingStateAfter: "stable",       trackStillAttached: true }
 *     dropping theirs: { directionBeforeTheirOffer: "sendonly", currentDirectionAfter: null,
 *                        directionAfter: "sendonly", videoSectionInLocalSdpAfter: true,
 *                        signalingStateAfter: "have-local-offer", trackStillAttached: true }
 *
 * Read the first row as the app reads it. `direction` is STILL `sendonly` and nothing is `stopped`,
 * so `sectionIsStopped` answers false and `LocalSenders.stoppedKinds` finds nothing to release.
 * `signalingState` is back to `stable`, so the connection looks perfectly healthy. The track is
 * still attached, so the camera light is on and the preview is moving. And the video section is
 * NOT IN OUR OWN DESCRIPTION AT ALL. Every surface the app could look at says the camera is being
 * sent, and there is no section for it — which is why this survived a month of measurement against
 * the real tenant, where the only visible symptom was a picture nobody ever saw.
 *
 * **WHAT THIS DOES NOT PIN, said rather than implied.** It measures the BROWSER, not the app: that
 * the mechanism is real and that refusing theirs is what keeps ours. That the app really refuses is
 * `remoteOfferWouldRollBackOurs`' own unit test plus the one call site in `answerRemoteOffer`. The
 * two together are the whole claim; neither alone is. And nothing here reaches the tenant, so
 * whether the service then ANSWERS our offer is still open — `bun run join-live -- --pair` is what
 * measures that (NATIVE-CALLING.md § THE PAIR).
 */

/** What one run of the exchange reports back. Every field is read off a real connection. */
type GlareReading = {
  /** `sendonly` while our camera is really in the offer — the state the far side must answer. */
  directionBeforeTheirOffer: string;
  /** What the transceiver's NEGOTIATED direction is after the remote offer landed. */
  currentDirectionAfter: string | null;
  /** What its REQUESTED direction is after that. `stopped` here is what would make the loss
   *  reportable; anything else is what makes it silent. */
  directionAfter: string;
  /** Whether the section is still in the description this side would now send. */
  videoSectionInLocalSdpAfter: boolean;
  /** The signaling state after, which says whether our offer still stands. */
  signalingStateAfter: string;
  /** Whether the track is still attached to the sender — it is, which is why the camera light
   *  stays on while nothing goes out. */
  trackStillAttached: boolean;
};

/**
 * Run the exchange once, either applying the far side's offer (the defect) or refusing it (the fix).
 *
 * Written as source text rather than a closure for the reason every WebRTC probe in this repo is:
 * this file is typed for node, where `RTCPeerConnection` does not exist.
 */
const EXCHANGE = (applyTheirOffer: boolean) => `(async () => {
  const canvasTrack = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 120;
    const ctx = canvas.getContext("2d");
    // Something has to be drawn, or Chromium may not produce a frame at all.
    setInterval(() => { ctx.fillStyle = "#0a0"; ctx.fillRect(0, 0, 160, 120); }, 100);
    return canvas.captureStream(15).getVideoTracks()[0];
  };
  const silentTrack = () => {
    const audio = new AudioContext();
    const destination = audio.createMediaStreamDestination();
    audio.createOscillator().connect(destination);
    return destination.stream.getAudioTracks()[0];
  };

  const us = new RTCPeerConnection();
  const them = new RTCPeerConnection();
  us.addTrack(silentTrack());
  them.addTrack(silentTrack());

  // 1. THE CALL, negotiated with audio alone — which is the only shape this service has ever
  //    accepted a join in, so it is the state a camera is really turned on from.
  await us.setLocalDescription(await us.createOffer());
  await them.setRemoteDescription(us.localDescription);
  await them.setLocalDescription(await them.createAnswer());
  await us.setRemoteDescription(them.localDescription);
  if (us.signalingState !== "stable") throw new Error("the audio call did not settle: " + us.signalingState);

  // 2. THE CAMERA. A section that does not exist yet, added mid-call, exactly as
  //    LocalSenders.start does it.
  const sender = us.addTransceiver(canvasTrack(), { direction: "sendonly" });
  await us.setLocalDescription(await us.createOffer());
  const directionBeforeTheirOffer = sender.direction;
  // Our offer is now pending: applied locally, and a round trip away from being answered.
  if (us.signalingState !== "have-local-offer") throw new Error("expected have-local-offer");

  // 3. AND THE SERVICE RENEGOTIATES ON ITS OWN, which it does every few seconds — so its offer
  //    lands inside the window our own offer is waiting in.
  await them.setLocalDescription(await them.createOffer());
  const theirOffer = them.localDescription;
  ${applyTheirOffer ? `await us.setRemoteDescription(theirOffer);
  await us.setLocalDescription(await us.createAnswer());` : `// THE FIX: ours is pending, so theirs is dropped. The service offers again.`}

  const local = us.localDescription ? us.localDescription.sdp : "";
  return {
    directionBeforeTheirOffer,
    currentDirectionAfter: sender.currentDirection,
    directionAfter: sender.direction,
    videoSectionInLocalSdpAfter: /^m=video [1-9]/m.test(local),
    signalingStateAfter: us.signalingState,
    trackStillAttached: !!sender.sender.track,
  };
})()`;

test.describe("glare, in a real browser", () => {
  test("applying the service's offer while ours is pending loses the camera, and says nothing", async ({
    page,
  }) => {
    await page.goto("about:blank");
    const reading = (await page.evaluate(EXCHANGE(true))) as GlareReading;

    // The camera really was in our offer.
    expect(reading.directionBeforeTheirOffer).toBe("sendonly");

    // AND IT IS GONE. The section this side would now describe carries no live video at all:
    // the implicit rollback undid the transceiver we had just added, so the answer we produce
    // describes the service's audio-only offer instead.
    expect(reading.videoSectionInLocalSdpAfter).toBe(false);
    expect(reading.currentDirectionAfter).not.toBe("sendonly");

    // AND THIS IS WHY IT IS SILENT — the half that could only be guessed at before. A section the
    // far side REJECTS is left `stopped`, which `LocalSenders.stoppedKinds` reads and
    // `releaseDroppedSections` reports. A section a rollback undid is not stopped, so nothing in
    // the app has anything to notice: the capture is not released, the button is not corrected,
    // and no sentence is ever said.
    expect(reading.directionAfter).not.toBe("stopped");
    expect(reading.currentDirectionAfter).not.toBe("stopped");

    // And the camera is still running behind it, which is the state the user sees: the light on,
    // the preview moving, the button saying the meeting can see them, and nothing being sent.
    expect(reading.trackStillAttached).toBe(true);
  });

  test("dropping it instead keeps the camera in an offer the service can still answer", async ({
    page,
  }) => {
    await page.goto("about:blank");
    const reading = (await page.evaluate(EXCHANGE(false))) as GlareReading;

    expect(reading.directionBeforeTheirOffer).toBe("sendonly");
    // Our offer still stands, whole, with the camera in it — so the answer the service does send
    // completes it. That is the entire difference the fix makes.
    expect(reading.signalingStateAfter).toBe("have-local-offer");
    expect(reading.videoSectionInLocalSdpAfter).toBe(true);
    expect(reading.directionAfter).toBe("sendonly");
    expect(reading.trackStillAttached).toBe(true);
  });
});
