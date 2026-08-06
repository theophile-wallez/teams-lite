// The command line of `teams`, and the two aliases that must keep working.
import { describe, expect, test } from "bun:test";
import { main, parseArgs, USAGE, viteDevEnv, type EntryDeps, type LaunchOptions } from "./launch";

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

  // An argv this command cannot honour must not resolve to "launch the app anyway" — the
  // failure `parseArgs`'s own comment records: `teams chats -n 40 --json`, meant for a
  // different `teams`, started a whole second app on the default web port.
  test("an unknown argument is refused, not ignored", () => {
    expect(() => parseArgs(["chats", "-n", "40", "--json"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["login"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    // `--web` is the one argument whose ACCEPTANCE is load-bearing now that strays throw.
    expect(() => parseArgs(["--web"])).not.toThrow();
    // `--help` answers the question a refusal would send them to anyway.
    expect(parseArgs(["--help", "chats"]).help).toBe(true);
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

// What `teams` does with an argv, in the order it does it. The one thing that matters here
// is that a refusal ends the command BEFORE anything is served: what it replaced was a
// second web server on the default port, handing its pages a dead backend's write token.
//
// Running the real binary to prove it is not available — `.claude/hooks/
// guard-live-automation.sh` blocks the launcher with any argv but `--help`, and rightly, so
// the decisions are driven through `main`'s injected deps instead.
describe("main", () => {
  function fakeEntry() {
    const said = { out: [] as string[], err: [] as string[], codes: [] as number[] };
    const served: LaunchOptions[] = [];
    const deps: EntryDeps = {
      out: (text) => void said.out.push(text),
      err: (text) => void said.err.push(text),
      exit: (code) => void said.codes.push(code),
      run: async (options) => void served.push(options),
    };
    return { deps, said, served };
  }

  test("an argv it cannot honour is refused, and NOTHING is served", async () => {
    const { deps, said, served } = fakeEntry();
    await main(["chats", "-n", "40", "--json"], deps);
    expect(served).toEqual([]);
    expect(said.codes).toEqual([2]);
    // The reason, and the usage under it: a caller that meant another `teams` is told what
    // this one takes rather than left with a stack trace.
    expect(said.err[0]).toMatch(/unknown argument/);
    expect(said.err[0]).toContain("teams [options]");
    expect(said.out).toEqual([]);
  });

  test("--help is answered on stdout, and serves nothing", async () => {
    const { deps, said, served } = fakeEntry();
    await main(["--help"], deps);
    expect(served).toEqual([]);
    expect(said.out).toEqual([USAGE]);
    expect(said.codes).toEqual([0]);
  });

  test("an argv it knows is served, with what was parsed", async () => {
    const { deps, said, served } = fakeEntry();
    await main(["--port", "8080", "--no-open"], deps);
    expect(said.codes).toEqual([]);
    expect(served).toHaveLength(1);
    expect(served[0]?.port).toBe(8080);
    expect(served[0]?.open).toBe(false);
  });
});
