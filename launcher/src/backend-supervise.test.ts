import { describe, expect, test } from "bun:test";

import { backendLogPath, superviseBackend, type SupervisorDeps } from "./backend";

// THE BACKEND IS WATCHED, and it was not.
//
// `launch()` spawned it as a child and never looked at it again: `waitForExit` existed but
// was only ever awaited by a restart or an update, both of which ASK for the exit. So a
// backend that died for any other reason left the launcher serving the app against a dead
// socket, for ever — measured on the always-on instance at 11 h 40 min with no backend
// behind it, every page saying "Backend lost", and nothing on the machine able to change it.
//
// What is pinned here is the pair of refusals as much as the respawn: a supervisor that
// restarted on EVERY exit would race the Settings restart and the in-app update, and two
// backends fighting for one port is worse than the outage being fixed.

/** A supervisor rig whose child has already exited, so the reaction is what is measured. */
function rig(over: Partial<SupervisorDeps> = {}) {
  const log: string[] = [];
  let starts = 0;
  const waits: number[] = [];
  const deps: SupervisorDeps = {
    exited: () => Promise.resolve(),
    gone: () => false,
    current: () => true,
    start: async () => {
      starts += 1;
    },
    log: (message) => log.push(message),
    wait: async (ms) => {
      waits.push(ms);
    },
    logPath: "/tmp/x.log",
    ...over,
  };
  return { deps, log, waits, starts: () => starts };
}

describe("superviseBackend", () => {
  test("brings the backend back when it dies on its own", async () => {
    const r = rig();
    await superviseBackend(r.deps);
    expect(r.starts()).toBe(1);
    // And it SAYS so, both halves: the death, and that it came back. A silent respawn is a
    // backend that restarts in a loop with nothing in the log to explain it.
    expect(r.log.join("\n")).toContain("exited on its own");
    expect(r.log.join("\n")).toContain("back up");
    // Pointing at the file that holds the reason, which is the whole of what a reader does next.
    expect(r.log.join("\n")).toContain("/tmp/x.log");
  });

  test("stands down when the exit was ASKED for", async () => {
    // A Settings restart and an in-app update both kill the child themselves and spawn their
    // own replacement. `stop()` bumps the generation BEFORE it kills, so by the time the
    // dying child's exit is seen it is no longer current — and a respawn here would be a
    // second backend racing theirs for one port.
    const r = rig({ current: () => false });
    await superviseBackend(r.deps);
    expect(r.starts()).toBe(0);
    expect(r.log).toEqual([]);
  });

  test("stands down when the launcher itself is going away", async () => {
    // The update's own last step. Respawning here would leave an orphan holding the port that
    // the new build is about to bind, which is the failure the update's ordering exists for.
    const r = rig({ gone: () => true });
    await superviseBackend(r.deps);
    expect(r.starts()).toBe(0);
  });

  test("retries a start that fails, and never throws", async () => {
    // `startBackend` throws after waiting a minute for the port. An unhandled rejection here
    // would take the web server down with it — so the failure is said and tried again, because
    // giving up is exactly the behaviour that caused the outage.
    let attempts = 0;
    const r = rig({
      start: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("still not listening");
      },
    });
    await superviseBackend(r.deps);
    expect(attempts).toBe(3);
    expect(r.waits.length).toBe(2);
    // A pause between attempts, so a backend that cannot start is not a busy loop.
    expect(r.waits.every((ms) => ms > 0)).toBe(true);
    expect(r.log.filter((l) => l.includes("could not start it")).length).toBe(2);
  });

  test("stops retrying the moment the exit becomes somebody else's", async () => {
    // The race the generation exists for: a stop lands WHILE a start is in flight. Both
    // refusals are re-read on every pass, so the loop leaves rather than spawning over it.
    let attempts = 0;
    let current = true;
    const r = rig({
      current: () => current,
      start: async () => {
        attempts += 1;
        current = false;
        throw new Error("nope");
      },
    });
    await superviseBackend(r.deps);
    expect(attempts).toBe(1);
  });
});

// ONE LOG FILE PER PORT, and both halves of that were got wrong.
//
// A `BunFile` handed to `spawn` truncates, and each writer keeps its own offset — so the two
// send-capable installs on this machine spliced their output into one file, with whole lines
// overwritten mid-word and one run's startup banner appearing at two offsets as though it had
// happened twice. Reading a real outage out of that took an hour.

describe("backendLogPath", () => {
  test("keeps the historical name for the default port", () => {
    const port = process.env.TEAMS_LITE_PORT;
    delete process.env.TEAMS_LITE_PORT;
    try {
      // Every doc, every error message and every reader's muscle memory holds this path.
      expect(backendLogPath()).toBe("/tmp/teams-lite-server.log");
    } finally {
      if (port !== undefined) process.env.TEAMS_LITE_PORT = port;
    }
  });

  test("gives any other backend a file of its own", () => {
    const port = process.env.TEAMS_LITE_PORT;
    process.env.TEAMS_LITE_PORT = "19422";
    try {
      expect(backendLogPath()).toBe("/tmp/teams-lite-server-19422.log");
    } finally {
      if (port === undefined) delete process.env.TEAMS_LITE_PORT;
      else process.env.TEAMS_LITE_PORT = port;
    }
  });
});
