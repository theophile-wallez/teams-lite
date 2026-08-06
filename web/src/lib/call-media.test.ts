import { describe, expect, it } from "vitest";

import { conferenceVideoCodecs, reservedKindFor, sectionIsStopped } from "./call-media";
import { rejectedLabels, SHARING_LABEL } from "./ms-sdp";

// A section the far side DROPPED. The service can reject a section this app offered, and the
// browser then stops that transceiver: it carries nothing and every setter on it throws. So
// this app has to read one as absent — the alternative reached a real user as the browser's
// own sentence, "Failed to set the 'direction' property on 'RTCRtpTransceiver': The
// transceiver is stopped", reported as the outcome of switching a camera OFF.

describe("sectionIsStopped", () => {
  it("says so when the section was stopped", () => {
    // The spec states it in `currentDirection`, and a browser's own `direction` getter
    // reports it too. Either one is the answer, because a section this app cannot write to is
    // gone whichever half of the object says it.
    expect(sectionIsStopped({ direction: "sendonly", currentDirection: "stopped" })).toBe(true);
    expect(sectionIsStopped({ direction: "stopped", currentDirection: "stopped" })).toBe(true);
  });

  it("keeps a live section, and an idle one", () => {
    // `sendonly` is a camera that is on; `inactive` is the section a camera switched off
    // leaves behind, which is REUSED the next time it is switched on.
    expect(sectionIsStopped({ direction: "sendonly", currentDirection: "sendonly" })).toBe(false);
    expect(sectionIsStopped({ direction: "inactive", currentDirection: "inactive" })).toBe(false);
  });

  it("keeps a section that has not been negotiated yet", () => {
    // `currentDirection` is null until the first answer applies. A section read as stopped
    // there would be added and dropped in the same breath, so the camera would never go out.
    expect(sectionIsStopped({ direction: "sendonly", currentDirection: null })).toBe(false);
  });
});

// How the same fact reads on the WIRE: the section still written down, its port zeroed. The
// live path never needs this — it asks the transceiver — but the simulated media has none, so
// it is what makes the failure above reviewable with no tenant and no camera.

describe("rejectedLabels", () => {
  const section = (port: string, label: string) =>
    [`m=video ${port} RTP/SAVP 107`, "c=IN IP4 0.0.0.0", "a=mid:2", `a=label:${label}`].join("\r\n");

  it("names the labels of the rejected sections only", () => {
    const sdp = ["v=0", "t=0 0", section("3481", "main-video"), section("0", SHARING_LABEL)].join(
      "\r\n",
    );
    expect([...rejectedLabels(sdp)]).toEqual([SHARING_LABEL]);
  });

  it("finds nothing in an ordinary offer", () => {
    const sdp = ["v=0", "t=0 0", section("3481", "main-video")].join("\r\n");
    expect(rejectedLabels(sdp).size).toBe(0);
  });
});

// The sections a camera and a screen go out on are negotiated with the CALL, not added when
// somebody presses share: the real client's `addModalities` forces both modalities inactive at
// the first negotiation of a one-to-one, and this app's screen share was refused by the service
// for adding one mid-call instead (NATIVE-CALLING.md § 10.8). An INCOMING offer already holds
// that layout, so the sections are adopted from it — and which one is which is a question only
// the label answers.

describe("reservedKindFor", () => {
  it("reads a screen and a camera off their labels", () => {
    // Both are `m=video`: the kind cannot tell them apart, and the service reads the label.
    expect(reservedKindFor(SHARING_LABEL)).toBe("screen");
    expect(reservedKindFor("main-video")).toBe("camera");
  });

  it("claims nothing else, whatever the section is", () => {
    // The service labels its audio and its data sections too, and it names sections this app
    // has never heard of. Sending a screen on one of those would describe the wrong stream.
    for (const label of ["main-audio", "data", "x-data", "applicationsharing-audio", "", undefined]) {
      expect(reservedKindFor(label)).toBeUndefined();
    }
  });
});

// The codecs a CONFERENCE offers. A browser offers everything it can decode — VP8, VP9, AV1,
// H.264 — and the real client filters its multiparty offer down to three
// (`allowedVideoCodecsMultiparty` with `filterCodecsInSdpMultiparty: true`), while its own
// offers carry `H264/90000` alone. A one-to-one is filtered by neither.

describe("conferenceVideoCodecs", () => {
  const codec = (mimeType: string): RTCRtpCodec => ({ mimeType, clockRate: 90_000 });
  // What Chrome really hands back, in roughly its own order.
  const chrome = [
    codec("video/VP8"),
    codec("video/rtx"),
    codec("video/VP9"),
    codec("video/AV1"),
    codec("video/H264"),
    codec("video/red"),
    codec("video/ulpfec"),
  ];

  it("offers the client's three, in the client's order", () => {
    // H.264 FIRST: it is the codec the service's own video sections use, so it must be the
    // one a section leads with rather than the one buried under VP8.
    expect(conferenceVideoCodecs(chrome).map((c) => c.mimeType)).toEqual([
      "video/H264",
      "video/AV1",
      "video/rtx",
    ]);
  });

  it("keeps rtx, because retransmission is not optional", () => {
    // Dropping it would cost a frame per lost packet on a stream nobody can ask to repeat.
    expect(conferenceVideoCodecs(chrome).some((c) => c.mimeType === "video/rtx")).toBe(true);
  });

  it("drops everything the client does not offer a conference", () => {
    const offered = conferenceVideoCodecs(chrome).map((c) => c.mimeType);
    for (const dropped of ["video/VP8", "video/VP9", "video/red", "video/ulpfec"]) {
      expect(offered).not.toContain(dropped);
    }
  });

  it("matches a codec whatever case the browser spells it in", () => {
    // Chrome writes `video/H264`, the client's own table `video/H264`, and a browser is free
    // to write either. A case-sensitive compare would silently offer nothing at all.
    expect(conferenceVideoCodecs([codec("VIDEO/h264")]).length).toBe(1);
  });

  it("says nothing rather than something when the browser has none of them", () => {
    // An empty list must never be handed to `setCodecPreferences`: it would offer no video
    // codec at all, which is worse than offering too many.
    expect(conferenceVideoCodecs([codec("video/VP8")])).toEqual([]);
    expect(conferenceVideoCodecs([])).toEqual([]);
  });
});
