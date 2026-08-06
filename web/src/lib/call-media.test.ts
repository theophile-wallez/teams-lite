import { describe, expect, it } from "vitest";

import { sectionIsStopped } from "./call-media";

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
