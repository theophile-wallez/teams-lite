import { describe, expect, it } from "vitest";
import {
  AUTH_RELOAD_INTERVAL_MS,
  sessionVerdict,
  signInRemedy,
  type SessionVerdict,
} from "./auth-wall";
import { hasUnsentWork, reportUnsentWork } from "./unsent-work";

describe("what the probe's answer says", () => {
  it("is a sign-in when a proxy redirects or answers 401", () => {
    expect(sessionVerdict({ type: "opaqueredirect", status: 0 })).toBe("signed-out");
    expect(sessionVerdict({ type: "basic", status: 401 })).toBe("signed-out");
  });

  it("is this app's own server whenever it answered — the token route answers 200 or 404", () => {
    expect(sessionVerdict({ type: "basic", status: 200 })).toBe("reachable");
    expect(sessionVerdict({ type: "basic", status: 404 })).toBe("reachable");
  });

  it("is a refusal, not a sign-in, on 403 — reloading into it changes nothing", () => {
    expect(sessionVerdict({ type: "basic", status: 403 })).toBe("reachable");
  });

  it("is nothing answering on a failed fetch or a gateway's 5xx", () => {
    expect(sessionVerdict(null)).toBe("unreachable");
    expect(sessionVerdict({ type: "basic", status: 502 })).toBe("unreachable");
    expect(sessionVerdict({ type: "error", status: 0 })).toBe("unreachable");
  });
});

describe("what the page does when the sign-in in front of it expired", () => {
  const now = 10 * AUTH_RELOAD_INTERVAL_MS;
  const base = {
    verdict: "signed-out" as SessionVerdict,
    visible: true,
    lastReloadAt: null,
    now,
    wouldLoseWork: false,
  };

  it("reloads, for a visible page with nothing to lose", () => {
    expect(signInRemedy(base)).toBe("reload");
  });

  it("does nothing for anything but an expired sign-in", () => {
    expect(signInRemedy({ ...base, verdict: "reachable" })).toBe("none");
    expect(signInRemedy({ ...base, verdict: "unreachable" })).toBe("none");
    expect(signInRemedy({ ...base, verdict: "reachable", wouldLoseWork: true })).toBe("none");
  });

  it("asks rather than throw away unsent words, pictures or a live call — visible or not", () => {
    expect(signInRemedy({ ...base, wouldLoseWork: true })).toBe("ask");
    expect(signInRemedy({ ...base, wouldLoseWork: true, visible: false })).toBe("ask");
  });

  it("waits for a page nobody is looking at, which asks again when it wakes", () => {
    expect(signInRemedy({ ...base, visible: false })).toBe("none");
  });

  it("never reloads twice inside the interval: a wall it cannot satisfy is a question, not a loop", () => {
    expect(signInRemedy({ ...base, lastReloadAt: now - 1000 })).toBe("ask");
    expect(signInRemedy({ ...base, lastReloadAt: now - AUTH_RELOAD_INTERVAL_MS })).toBe("reload");
    // A clock that went backwards is no evidence that a reload was long ago.
    expect(signInRemedy({ ...base, lastReloadAt: now + 60_000 })).toBe("ask");
  });
});

describe("what a reload would throw away", () => {
  it("is asked of every surface that reports, for as long as it reports", () => {
    expect(hasUnsentWork()).toBe(false);
    let holding = false;
    const stop = reportUnsentWork(() => holding);
    expect(hasUnsentWork()).toBe(false);
    holding = true;
    expect(hasUnsentWork()).toBe(true);
    stop();
    expect(hasUnsentWork()).toBe(false);
  });

  it("counts a reporter that throws as holding work: one press is cheaper than lost words", () => {
    const stop = reportUnsentWork(() => {
      throw new Error("unmounted mid-read");
    });
    expect(hasUnsentWork()).toBe(true);
    stop();
  });
});
