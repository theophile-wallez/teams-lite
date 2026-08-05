// The launcher's half of "can this app act at all": whose write token we serve, and what
// we say when our backend does not accept it. See write-lock.ts for the failure this
// covers — an app whose reads all work and whose every send is refused.
import { describe, expect, test } from "bun:test";
import {
  parseWriteLock,
  readWriteLock,
  serveWriteToken,
  UNKNOWN_WRITE_LOCK,
  writeLockWarning,
  type WriteLockReport,
} from "./write-lock";

const WS = "ws://127.0.0.1:19420";

describe("serveWriteToken", () => {
  test("serves the token we pinned for the backend we spawned", () => {
    const env: Record<string, string | undefined> = {};
    serveWriteToken(env, "TEAMS_LITE_WRITE_TOKEN", "tok");
    expect(env.TEAMS_LITE_WRITE_TOKEN).toBe("tok");
  });

  // The load-bearing half. We inherit our parent's environment, and for an in-app update
  // that parent is the launcher this process replaced — whose token died with its backend.
  // Left in place, web/write-token.ts would serve it in front of the file that holds the
  // right one, and every send would be refused with nothing looking wrong.
  test("removes an INHERITED token when we only attached to a backend", () => {
    const env: Record<string, string | undefined> = { TEAMS_LITE_WRITE_TOKEN: "a-dead-token" };
    serveWriteToken(env, "TEAMS_LITE_WRITE_TOKEN", null);
    expect(env.TEAMS_LITE_WRITE_TOKEN).toBeUndefined();
    expect("TEAMS_LITE_WRITE_TOKEN" in env).toBe(false);
  });
});

describe("parseWriteLock", () => {
  test("reads the three states the backend states", () => {
    expect(parseWriteLock({ state: "held", pinned: true })).toEqual({ state: "held", pinned: true });
    expect(parseWriteLock({ state: "foreign", pinned: false })).toEqual({
      state: "foreign",
      pinned: false,
    });
    expect(parseWriteLock({ state: "read_only", pinned: false }).state).toBe("read_only");
  });

  // A backend too old to know the question answers an error, not a state — and a guess
  // about the user's install is worse than silence.
  test("anything else is unknown, and unknown says nothing", () => {
    for (const raw of [undefined, null, "pong", {}, { state: "ok" }, { state: 3 }]) {
      expect(parseWriteLock(raw)).toEqual(UNKNOWN_WRITE_LOCK);
    }
    expect(writeLockWarning(UNKNOWN_WRITE_LOCK, WS)).toBeNull();
  });
});

describe("writeLockWarning", () => {
  test("the healthy case is silence", () => {
    expect(writeLockWarning({ state: "held", pinned: true }, WS)).toBeNull();
    expect(writeLockWarning({ state: "held", pinned: false }, WS)).toBeNull();
  });

  // Two causes, two ways out, and the state cannot tell them apart on its own: a PINNED
  // token is in no file, so no reload helps and another instance has to go.
  test("a foreign PINNED token names the other instance, and the port to escape it", () => {
    const warning = writeLockWarning({ state: "foreign", pinned: true }, WS);
    expect(warning).toContain("does not accept the token this app serves");
    expect(warning).toContain("another teams-lite instance");
    expect(warning).toContain("TEAMS_LITE_PORT");
    expect(warning).not.toContain("Restart this app");
  });

  // A PUBLISHED token is readable, so this instance is serving the wrong one — which a
  // restart of this app re-reads. Never "reload the page": the page would ask the same
  // server the same question and get the same answer.
  test("a foreign PUBLISHED token is this app serving the wrong source", () => {
    const warning = writeLockWarning({ state: "foreign", pinned: false }, WS);
    expect(warning).toContain("Restart this app");
    expect(warning).not.toContain("another teams-lite instance");
    expect(warning?.toLowerCase()).not.toContain("reload the page");
  });

  test("read-only says so, and never blames the install", () => {
    const warning = writeLockWarning({ state: "read_only", pinned: false }, WS);
    expect(warning).toContain("TEAMS_LITE_READ_ONLY=1");
    expect(warning).toContain("send nothing");
  });

  // The token is what this whole mechanism keeps from other processes, so it must not
  // travel into a console line or a unit's journal either.
  test("never prints the token", () => {
    const reports: WriteLockReport[] = [
      { state: "foreign", pinned: true },
      { state: "foreign", pinned: false },
      { state: "read_only", pinned: false },
    ];
    for (const report of reports) {
      expect(writeLockWarning(report, WS) ?? "").not.toContain("write_token");
    }
  });
});

describe("readWriteLock", () => {
  test("presents the token our own server hands the page, and reads the answer", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const report = await readWriteLock({
      tokenUrl: "http://127.0.0.1:19440/__write-token",
      wsUrl: WS,
      fetchToken: async () => "tok",
      ask: async (_ws, _method, params) => {
        asked.push(params);
        return { state: "held", pinned: true };
      },
    });
    expect(asked).toEqual([{ write_token: "tok" }]);
    expect(report).toEqual({ state: "held", pinned: true });
  });

  // A server that has no token at all is exactly the attached-instance case: the page
  // would present nothing, so the question is asked with nothing and `foreign` is true.
  test("asks with no token when our server has none", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const report = await readWriteLock({
      tokenUrl: "http://127.0.0.1:19440/__write-token",
      wsUrl: WS,
      fetchToken: async () => null,
      ask: async (_ws, _method, params) => {
        asked.push(params);
        return { state: "foreign", pinned: true };
      },
    });
    expect(asked).toEqual([{ write_token: undefined }]);
    expect(report.state).toBe("foreign");
  });

  // Our own web server binds its port after we start it (Vite takes seconds), so a first
  // refused connection proves nothing about the write lock.
  test("waits for our own server, then gives up saying nothing", async () => {
    let tries = 0;
    const slept: number[] = [];
    const report = await readWriteLock({
      tokenUrl: "http://127.0.0.1:19440/__write-token",
      wsUrl: WS,
      fetchToken: async () => {
        tries++;
        throw new Error("connection refused");
      },
      ask: async () => ({ state: "foreign", pinned: true }),
      attempts: 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(tries).toBe(3);
    expect(slept).toEqual([1_000, 1_000]);
    expect(report).toEqual(UNKNOWN_WRITE_LOCK);
  });

  test("stops waiting as soon as the endpoint answers", async () => {
    let tries = 0;
    const report = await readWriteLock({
      tokenUrl: "http://127.0.0.1:19440/__write-token",
      wsUrl: WS,
      fetchToken: async () => {
        tries++;
        if (tries < 2) throw new Error("connection refused");
        return "tok";
      },
      ask: async () => ({ state: "held", pinned: true }),
      attempts: 5,
      sleep: async () => {},
    });
    expect(tries).toBe(2);
    expect(report.state).toBe("held");
  });
});
