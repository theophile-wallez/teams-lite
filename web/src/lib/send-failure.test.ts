// A failed send must say what happened, in words the person who pressed the button can
// act on. These pin the mapping; the composer draws whatever comes out of it.
import { describe, it, expect } from "vitest";
import { sendFailureMessage } from "./send-failure";

describe("sendFailureMessage", () => {
  it("always says the message did not leave", () => {
    for (const raw of ["", "boom", "timeout: send", "not connected"]) {
      expect(sendFailureMessage(new Error(raw))).toMatch(/^Not sent/);
    }
  });

  // The client re-reads the token and retries on its own, so this text is only reached
  // when the fresh one was refused too — and then a reload is the one thing left.
  it("tells the user to reload when the write lock refuses this page", () => {
    const refusal =
      "refused: `send` needs the write token this backend published for the user's own frontends.";
    expect(sendFailureMessage(new Error(refusal))).toBe(
      "Not sent — this page is no longer allowed to write. Reload the app.",
    );
  });

  it("names a read-only backend as the reason, since nothing in the page changes it", () => {
    const refusal =
      "refused: `send` acts on the real Teams account and this server runs read-only (TEAMS_LITE_READ_ONLY=1).";
    expect(sendFailureMessage(new Error(refusal))).toMatch(/read-only/);
  });

  it("separates a dead socket from a backend that did not answer", () => {
    expect(sendFailureMessage(new Error("not connected"))).toMatch(/not reachable/);
    expect(sendFailureMessage(new Error("connection closed"))).toMatch(/not reachable/);
    expect(sendFailureMessage(new Error("timeout: send"))).toMatch(/did not answer/);
  });

  it("reads a broken sign-in as what it costs the message", () => {
    const broker =
      "acquire skype token: The identity broker refused to sign in silently.: no accessToken";
    expect(sendFailureMessage(new Error(broker))).toMatch(/sign-in is broken/);
  });

  // An unrecognised failure keeps its own words: that is the one the user has to be able
  // to report, and a vague sentence would delete the only evidence.
  it("keeps a failure it does not recognise", () => {
    expect(sendFailureMessage(new Error("413 Payload Too Large"))).toBe(
      "Not sent — 413 Payload Too Large",
    );
    expect(sendFailureMessage(undefined)).toBe("Not sent.");
  });
});
