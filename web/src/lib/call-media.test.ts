import { describe, expect, it } from "vitest";

import { reservedKindFor, sectionIsStopped } from "./call-media";
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
