import { describe, expect, it } from "vitest";
import type { BackendRestartResult, UpdateCheckResult } from "./protocol";
import {
  checkMessage,
  checkView,
  restartForces,
  restartPhaseFor,
  restartView,
  RESTART_STALLED_MS,
  type RestartPhase,
} from "./maintenance";

const outcome = (over: Partial<UpdateCheckResult> = {}): UpdateCheckResult => ({
  outcome: "current",
  ...over,
});

describe("checkView", () => {
  it("says nothing before it is pressed: the row is the button", () => {
    const view = checkView({ kind: "idle" });
    expect(view.label).toBe("Check for updates");
    expect(view.message).toBe("");
    expect(view.busy).toBe(false);
  });

  it("is inert while it asks", () => {
    expect(checkView({ kind: "asking" }).busy).toBe(true);
  });

  // The whole point of the row: a poll that finds nothing new changes nothing on screen, so
  // without a sentence here "am I up to date?" is a question the app cannot answer.
  it("answers every outcome, the two that are not news included", () => {
    for (const kind of ["available", "current", "busy", "unknown", "unsupported"] as const) {
      const view = checkView({ kind: "answered", result: outcome({ outcome: kind }) });
      expect(view.message.length).toBeGreaterThan(0);
      expect(view.busy).toBe(false);
      // Pressable again: a check is a read, and asking twice costs one request.
      expect(view.label).toBe("Check again");
    }
  });

  it("carries GitHub's own reason when the request could not be made", () => {
    const view = checkView({
      kind: "answered",
      result: outcome({ outcome: "failed", error: "403 rate limit exceeded" }),
    });
    expect(view.message).toContain("403 rate limit exceeded");
  });

  it("still says something when a failure carried no reason at all", () => {
    expect(checkMessage(outcome({ outcome: "failed" }))).toBe("Could not reach GitHub.");
  });

  // Where the update is TAKEN is the sidebar's own control, which is the one place the
  // download and the restart live. This row points at it rather than growing a second one.
  it("points at the control that takes the update, and never names a build", () => {
    const message = checkMessage(outcome({ outcome: "available" }));
    expect(message).toContain("sidebar");
    expect(message).not.toMatch(/[0-9a-f]{7}/);
  });

  // A refused REQUEST is not the same as GitHub being unreachable, and the backend's own
  // words are written for whoever holds the socket: the RPC name and `refused:` go.
  it("turns a refused request into a sentence", () => {
    const view = checkView({
      kind: "failed",
      error: new Error("update_check: refused: this backend answers no reads"),
    });
    expect(view.message).toBe("This backend answers no reads");
  });
});

describe("restartView", () => {
  it("says nothing before it is pressed", () => {
    const view = restartView({ kind: "idle" });
    expect(view.label).toBe("Restart");
    expect(view.message).toBe("");
    expect(view.busy).toBe(false);
  });

  // The one state nothing else in this app has: the backend refused once because a reply is
  // being written, and the second press is the user answering that.
  it("arms on an agent that is mid-reply, and says what the press costs", () => {
    const view = restartView({ kind: "armed", runs: 1 });
    expect(view.label).toBe("Restart anyway");
    expect(view.message).toContain("A reply is being written");
    expect(view.message).toContain("interrupted");
    expect(view.busy).toBe(false);
  });

  it("counts them when there are several", () => {
    expect(restartView({ kind: "armed", runs: 3 }).message).toContain("3 replies are");
  });

  it("only the armed state forces the next press", () => {
    const phases: RestartPhase[] = [
      { kind: "idle" },
      { kind: "asking" },
      { kind: "restarting" },
      { kind: "done" },
      { kind: "stalled" },
      { kind: "failed", error: new Error("x") },
    ];
    for (const phase of phases) expect(restartForces(phase)).toBe(false);
    expect(restartForces({ kind: "armed", runs: 1 })).toBe(true);
  });

  it("waits with the socket, and says what ends the wait", () => {
    const view = restartView({ kind: "restarting" });
    expect(view.busy).toBe(true);
    expect(view.message).toContain("reconnects");
  });

  it("reports a restart that really happened", () => {
    expect(restartView({ kind: "done" }).message).toBe("The backend restarted.");
  });

  // An outward action that failed must never be left looking like it worked — and here the
  // failure is the quiet one: the backend accepted, asked, and nothing carried it out.
  it("says nothing happened when nothing took the backend down", () => {
    const view = restartView({ kind: "stalled" });
    expect(view.message).toContain("Nothing restarted the backend");
    expect(view.busy).toBe(false);
  });

  it("keeps the backend's reason when there is nothing to restart it", () => {
    const view = restartView({
      kind: "failed",
      error: new Error(
        "restart_backend: refused: nothing here would start this backend again — it was " +
          "started by hand, so restart it the way it was started",
      ),
    });
    expect(view.message).toBe(
      "Nothing here would start this backend again — it was started by hand, so restart it " +
        "the way it was started",
    );
  });

  it("says something even for a failure that carried no words", () => {
    expect(restartView({ kind: "failed", error: undefined }).message).toContain("did not happen");
  });
});

describe("restartPhaseFor", () => {
  it("an accepted restart waits for the socket", () => {
    expect(restartPhaseFor({ restarted: true, via: "launcher" })).toEqual({ kind: "restarting" });
  });

  // The count is a fact only the backend holds: this page knows about the runs it happened to
  // watch, and the common case is a reply asked for from the user's phone.
  it("a refusal about an agent arms, with the backend's own count", () => {
    expect(restartPhaseFor({ restarted: false, blocked: "agent", runs: 2 })).toEqual({
      kind: "armed",
      runs: 2,
    });
  });

  it("reads a blocked answer with no count as one reply", () => {
    const phase = restartPhaseFor({ restarted: false, blocked: "agent" });
    expect(phase).toEqual({ kind: "armed", runs: 1 });
  });

  // A `restarted: false` this page cannot read must never draw a restart in flight: that
  // would claim something the backend did not say.
  it("never reads an unknown refusal as a restart", () => {
    const unknown = { restarted: false } as BackendRestartResult;
    expect(restartPhaseFor(unknown)).toEqual({ kind: "stalled" });
  });
});

describe("RESTART_STALLED_MS", () => {
  // It has to outlast a real restart, and a supervised one grows its own delay per
  // consecutive restart (`RestartSteps` in the backend unit). A window shorter than that
  // would report a working restart as one nothing carried out.
  it("outlasts a supervisor's first backoff by a margin", () => {
    expect(RESTART_STALLED_MS).toBeGreaterThan(20_000);
    // And it still ends: a spinner with no end is the state this exists to avoid.
    expect(RESTART_STALLED_MS).toBeLessThanOrEqual(120_000);
  });
});
