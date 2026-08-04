// The launcher's half of an in-app update: the restart, and what must never trigger it.
import { describe, expect, test } from "bun:test";
import { handleBackendEvent, relaunch, relaunchArgs, type RelaunchDeps } from "./update";
import { backendEnv, isCompiledBinary, LAUNCHER_BIN_ENV } from "./backend";

/** A relaunch that records what it was asked to do, in order. */
function recordingDeps(overrides: Partial<RelaunchDeps> = {}) {
  const steps: string[] = [];
  const logs: string[] = [];
  const deps: RelaunchDeps = {
    stopWeb: () => steps.push("stopWeb"),
    stopBackend: async () => {
      steps.push("stopBackend");
    },
    execPath: "/home/u/.teams-lite/bin/teams-bin",
    args: ["--port", "19440"],
    start: (command) => steps.push(`start:${command.join(" ")}`),
    exit: () => steps.push("exit"),
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps, steps, logs };
}

describe("relaunchArgs", () => {
  test("adds --no-open, because the user is already looking at the page", () => {
    expect(relaunchArgs(["--port", "19440"])).toEqual(["--port", "19440", "--no-open"]);
  });

  test("never repeats it, whichever way the user spelled their own choice", () => {
    expect(relaunchArgs(["--no-open"])).toEqual(["--no-open"]);
    expect(relaunchArgs(["--open", "-p", "9"])).toEqual(["-p", "9", "--no-open"]);
  });
});

describe("relaunch", () => {
  // THE ORDER IS THE FEATURE. Both listeners have to be down before the new build
  // starts, or it exits on EADDRINUSE and the user is left with no app at all — and the
  // exit has to come after the spawn, or nothing starts.
  test("frees both ports, then starts the new build, then exits", async () => {
    const { deps, steps } = recordingDeps();
    await relaunch(deps);
    expect(steps).toEqual([
      "stopWeb",
      "stopBackend",
      "start:/home/u/.teams-lite/bin/teams-bin --port 19440 --no-open",
      "exit",
    ]);
  });

  test("a listener that will not stop is not a reason to strand the old build", async () => {
    const { deps, steps, logs } = recordingDeps({
      stopWeb: () => {
        throw new Error("already gone");
      },
    });
    await relaunch(deps);
    expect(steps).toEqual([
      "stopBackend",
      "start:/home/u/.teams-lite/bin/teams-bin --port 19440 --no-open",
      "exit",
    ]);
    expect(logs.join("\n")).toContain("could not stop the web server");
  });

  // The swap already happened, so the build IS installed. Say the one thing the user can
  // act on rather than leaving them to guess why the app went away.
  test("a spawn that fails still exits, and says the update is installed", async () => {
    const { deps, steps, logs } = recordingDeps({
      start: () => {
        throw new Error("no such file");
      },
    });
    await relaunch(deps);
    expect(steps).toEqual(["stopWeb", "stopBackend", "exit"]);
    expect(logs.join("\n")).toContain("run `teams` again");
  });
});

describe("handleBackendEvent", () => {
  const frame = (data: unknown) => JSON.stringify({ event: "update_restart", data });

  test("ignores anything that is not an apply for this binary", async () => {
    for (const raw of [
      undefined,
      "not json",
      JSON.stringify({ event: "message", data: {} }),
      frame({}),
      frame({ binary: "/somewhere/else/teams" }),
    ]) {
      const { deps, steps } = recordingDeps();
      handleBackendEvent(raw, deps);
      await Bun.sleep(0);
      expect(steps).toEqual([]);
    }
  });

  // A source run has nothing to restart onto: `process.execPath` is bun, the argv
  // carries a script, and no release was installed over anything.
  test("refuses to restart a source run", async () => {
    const { deps, steps, logs } = recordingDeps({ execPath: process.execPath });
    handleBackendEvent(frame({ binary: process.execPath }), deps);
    await Bun.sleep(0);
    if (isCompiledBinary()) {
      expect(steps).not.toEqual([]);
    } else {
      expect(steps).toEqual([]);
      expect(logs.join("\n")).toContain("source run");
    }
  });
});

describe("backendEnv", () => {
  // Under `bun run` the executable is bun, and replacing THAT is not an update of
  // teams-lite — so the variable stays absent, which is also how the backend knows not
  // to offer a button (see `self_install` in src/update.rs).
  test("names the binary to replace only for a compiled build", () => {
    const env = backendEnv(false);
    if (isCompiledBinary()) {
      expect(env[LAUNCHER_BIN_ENV]).toBe(process.execPath);
    } else {
      expect(env[LAUNCHER_BIN_ENV]).toBeUndefined();
    }
  });

  test("keepAlive is the only other thing it adds", () => {
    expect(backendEnv(true).TEAMS_NO_IDLE_EXIT).toBe("1");
    expect(backendEnv(false).TEAMS_NO_IDLE_EXIT).toBeUndefined();
  });
});
