// The command line of `teams`, and the two aliases that must keep working.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, viteDevEnv } from "./launch";

describe("parseArgs", () => {
  test("defaults to the web app on 19440, loopback, browser opened", () => {
    const options = parseArgs([]);
    expect(options).toEqual({ port: 19440, host: "127.0.0.1", open: true, dev: false, help: false });
  });

  test("reads the port and the host in both spellings", () => {
    expect(parseArgs(["--port", "8080"]).port).toBe(8080);
    expect(parseArgs(["--port=8080"]).port).toBe(8080);
    expect(parseArgs(["-p", "8080"]).port).toBe(8080);
    expect(parseArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseArgs(["--host=0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseArgs(["-H", "0.0.0.0"]).host).toBe("0.0.0.0");
  });

  test("keeps the default when a port is not a number", () => {
    expect(parseArgs(["--port", "nonsense"]).port).toBe(19440);
  });

  test("--no-open suppresses the browser", () => {
    expect(parseArgs(["--no-open"]).open).toBe(false);
  });

  test("--dev asks for Vite, and --web-dev is the old spelling of it", () => {
    expect(parseArgs(["--dev"]).dev).toBe(true);
    expect(parseArgs(["--web-dev"]).dev).toBe(true);
  });

  // `--web` selected the web app back when a terminal UI was the default. The web
  // app IS the app now, so the flag has to stay harmless rather than unknown: it
  // sits in people's shell history, in their notes and in their scripts.
  test("--web stays accepted, and changes nothing", () => {
    expect(parseArgs(["--web"])).toEqual(parseArgs([]));
    expect(parseArgs(["--web", "--port", "1234"]).port).toBe(1234);
  });

  test("--help runs nothing", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  // An argv this command cannot honour must not resolve to "launch the app anyway".
  //
  // This is a real failure and it lasted a day: a script on this machine ran
  // `teams chats -n 40 --json` — the CLI of a DIFFERENT teams — and the arguments meant
  // nothing here, so what was left was a bare launch. It took the default web port with a
  // second server whose pages were handed the write token FILE of a dead backend, so every
  // send and every update from that door came back refused; and it printed no JSON, so the
  // caller blocked on its output until somebody noticed.
  test("an unknown argument is refused, not ignored", () => {
    expect(() => parseArgs(["chats", "-n", "40", "--json"])).toThrow(/unknown arguments/);
    expect(() => parseArgs(["login"])).toThrow(/no subcommands/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument:/);
    // A value belongs to the option before it, and is never read as a stray word.
    expect(() => parseArgs(["--port", "8080", "--host", "0.0.0.0"])).not.toThrow();
    // `--help` answers the question a refusal would send them to anyway.
    expect(parseArgs(["--help", "chats"]).help).toBe(true);
  });

  // A refusal has to happen BEFORE anything is served, which is the whole point of it:
  // the failure it replaces was a second web server on the default port. That ordering
  // lives in index.ts, on the other side of a `process.exit`, and it cannot be exercised
  // from a test runner — running the launcher with an argv it would refuse is exactly what
  // `.claude/hooks/guard-live-automation.sh` blocks, and rightly. So the shape is read out
  // of the entry point, the way the Rust side pins what a spawned task does.
  test("the entry point refuses before it launches anything", () => {
    const entry = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const refusal = entry.indexOf("process.exit(2)");
    const launch = entry.indexOf("await launch(");
    expect(refusal).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(refusal);
    // And the throw is caught rather than left to the runtime: a stack trace is not an
    // answer to "you passed an argument I do not have".
    expect(entry).toMatch(/try\s*\{\s*options\s*=\s*parseArgs\(/);
    expect(entry).toContain("console.error(USAGE)");
  });

  // `teams --dev` starts BOTH halves, so it is the one command that has to introduce
  // them to each other. It did not: it passed Vite its own port and host and left the
  // socket to `web/package.json`'s default, which is the hands-on DEV pair's 19421 —
  // while the backend it had just spawned was on 19420. Vite came up fine and the
  // browser reported the backend unreachable, which reads as a broken app rather than
  // as a missing environment variable.
  test("--dev tells Vite which backend it just started, not a hardcoded port", () => {
    const previous = process.env.TEAMS_LITE_PORT;
    try {
      process.env.TEAMS_LITE_PORT = "19499";
      const env = viteDevEnv({ port: 19440, host: "127.0.0.1" }, {});
      // The socket follows the backend this launcher owns, wherever it was moved to.
      expect(env.VITE_TEAMS_WS_URL).toBe("ws://127.0.0.1:19499");
      // And the web server's own listener is still its own business.
      expect(env.PORT).toBe("19440");
      expect(env.HOST).toBe("127.0.0.1");
    } finally {
      if (previous === undefined) delete process.env.TEAMS_LITE_PORT;
      else process.env.TEAMS_LITE_PORT = previous;
    }
  });

  test("--dev never leaves the socket to the dev pair's default", () => {
    // The regression this guards is silent: 19421 is a real port with a real backend
    // on a developer's machine, so the wrong value looks plausible in a log.
    const env = viteDevEnv({ port: 19440, host: "127.0.0.1" }, {});
    expect(env.VITE_TEAMS_WS_URL).toBeDefined();
    expect(env.VITE_TEAMS_WS_URL).not.toContain("19421");
  });
});
