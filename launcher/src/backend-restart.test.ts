// The launcher's half of Settings › This app: replace the backend child, and refuse a frame
// that is not about the child we own.
import { describe, expect, test } from "bun:test";
import { handleBackendRestartEvent, type BackendRestartDeps } from "./backend-restart";
import { ATTACHED_BACKEND_CANNOT_RESTART } from "./backend";

const OUR_PORT = 19420;

/** A restart that records whether it was asked for. */
function recordingDeps(overrides: Partial<BackendRestartDeps> = {}) {
  const steps: string[] = [];
  const logs: string[] = [];
  const deps: BackendRestartDeps = {
    restart: async () => {
      steps.push("restart");
    },
    port: OUR_PORT,
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps, steps, logs };
}

const frame = (data: unknown) => JSON.stringify({ event: "backend_restart", data });

describe("handleBackendRestartEvent", () => {
  test("restarts the backend when the frame names our own child", async () => {
    const { deps, steps, logs } = recordingDeps();
    handleBackendRestartEvent(frame({ port: OUR_PORT }), deps);
    await Bun.sleep(0);
    expect(steps).toEqual(["restart"]);
    expect(logs.join("\n")).toContain("back up");
  });

  // This socket is a local one that anything on the machine can open a frame on, and this
  // machine really does run several backends (19420 staged, 19421 dev, 19422 released). A
  // launcher that acted on any frame would restart a backend nobody asked about.
  test("ignores a frame that is not a restart for the backend we own", async () => {
    for (const raw of [
      undefined,
      "not json",
      JSON.stringify({ event: "update_restart", data: { binary: "/x/teams" } }),
      frame({}),
      frame({ port: 19422 }),
      frame({ port: String(OUR_PORT) }),
    ]) {
      const { deps, steps } = recordingDeps();
      handleBackendRestartEvent(raw, deps);
      await Bun.sleep(0);
      expect(steps).toEqual([]);
    }
  });

  // The web server is untouched by all of this, so a backend that does not come back leaves
  // the page served and the failure readable. It must never take the app down with it.
  test("says so when the backend does not come back", async () => {
    const { deps, logs } = recordingDeps({
      restart: () => Promise.reject(new Error(ATTACHED_BACKEND_CANNOT_RESTART)),
    });
    handleBackendRestartEvent(frame({ port: OUR_PORT }), deps);
    await Bun.sleep(0);
    expect(logs.join("\n")).toContain("did not come back");
    expect(logs.join("\n")).toContain("attached");
  });
});
