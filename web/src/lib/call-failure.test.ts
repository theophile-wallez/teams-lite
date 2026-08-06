import { describe, it, expect } from "vitest";
import { callFailureMessage, captureDroppedMessage } from "./call-failure";
import { MicrophoneUnavailableError } from "./call-media";

// What the user is told when a call, a join or a capture did not happen. The rule is the
// one ./send-failure.test.ts pins for the other outward action: every sentence says what
// did not happen, and none of them hands the user a word written for whoever holds the
// socket.

describe("callFailureMessage", () => {
  it("always answers one non-empty sentence", () => {
    for (const raw of ["", "boom", "not connected", "call_place: no such call"]) {
      const message = callFailureMessage(new Error(raw));
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("still says something when the failure carried no words", () => {
    // The service really does answer 400 with an empty body, and a silent notice would
    // leave the user's click looking like it worked.
    expect(callFailureMessage(new Error(""))).toMatch(/nothing said why/);
    expect(callFailureMessage(new Error("call_join: "))).toMatch(/nothing said why/);
  });

  it("explains a refused microphone rather than reporting it", () => {
    // The common failure, and not a bug: the browser asks once and the answer sticks.
    const message = callFailureMessage(new MicrophoneUnavailableError(new Error("NotAllowedError")));
    expect(message).toMatch(/microphone/i);
    expect(message).toMatch(/Allow it for this site/);
  });

  it("turns the socket's own words into what they cost the call", () => {
    // This IS the sentence that used to float over the chat list: two words, naming
    // neither what did not happen nor what to do.
    for (const raw of ["not connected", "connection closed", "closed"]) {
      expect(callFailureMessage(new Error(raw))).toMatch(/backend is not reachable/);
    }
  });

  it("says a timeout is worth retrying", () => {
    expect(callFailureMessage(new Error("timeout: call_prepare"))).toMatch(/did not answer/);
  });

  it("names the reload a dead write token needs, and never the token", () => {
    const raw = "call_place: this method needs the write token";
    const message = callFailureMessage(new Error(raw));
    expect(message).toMatch(/Reload the app/);
    expect(message).not.toMatch(/token/i);
  });

  it("says a read-only backend refuses, without naming its variable", () => {
    const message = callFailureMessage(new Error("refused: TEAMS_LITE_READ_ONLY=1 is set"));
    expect(message).toMatch(/read-only/);
    expect(message).not.toMatch(/TEAMS_LITE_READ_ONLY/);
  });

  it("points a broken sign-in at itself", () => {
    expect(callFailureMessage(new Error("could not acquire a chat token: keyring"))).toMatch(
      /Sign-in is broken/,
    );
  });

  it("drops the RPC name off a backend refusal and keeps the rest word for word", () => {
    expect(
      callFailureMessage(
        new Error("call_prepare: calling is not connected yet — turn it on in Settings"),
      ),
    ).toBe("calling is not connected yet — turn it on in Settings");
    expect(callFailureMessage(new Error("call_offer_media: the service refused it"))).toBe(
      "the service refused it",
    );
  });

  it("leaves a colon that is not an RPC name alone", () => {
    // A sentence may carry a colon of its own, and eating half of it would change what it
    // said. Only a leading snake_case word counts.
    for (const raw of [
      "the meeting starts at 10:30",
      "https://teams.microsoft.com refused it",
      "Camera: refused",
    ]) {
      expect(callFailureMessage(new Error(raw))).toBe(raw);
    }
  });

  it("keeps a failure nobody wrote a sentence for", () => {
    // An unrecognised failure is exactly the one the user has to be able to report.
    expect(callFailureMessage(new Error("ICE gathering produced no candidates"))).toBe(
      "ICE gathering produced no candidates",
    );
  });

  it("reads an opaque Event rather than stringifying it", () => {
    // A browser WebSocket failure arrives as an Event, which stringifies to "[object Event]".
    expect(callFailureMessage(new Event("error"))).toBe("connection error");
    expect(callFailureMessage({})).toBe("unknown error");
  });
});

describe("captureDroppedMessage", () => {
  it("names the capture and the one action left", () => {
    // Not a failure of anything the user did: the meeting accepted the section and then
    // dropped it, so the picture stops with no click behind it. A camera that switches
    // itself off in silence reads as this app losing their input.
    expect(captureDroppedMessage("camera")).toMatch(/dropped your camera/);
    expect(captureDroppedMessage("camera")).toMatch(/Turn it on again/);
    expect(captureDroppedMessage("screen")).toMatch(/screen share/);
    expect(captureDroppedMessage("screen")).toMatch(/Share it again/);
  });

  it("hands the user no word written for whoever holds the socket", () => {
    // The rule this whole module exists for. "The transceiver is stopped" is what the
    // browser says, and it reached a real user as the outcome of switching a camera off.
    for (const kind of ["camera", "screen"] as const) {
      expect(captureDroppedMessage(kind)).not.toMatch(/transceiver|sdp|section|m-line/i);
    }
  });
});
