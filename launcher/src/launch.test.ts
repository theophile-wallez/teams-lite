// The command line of `teams`, and the two aliases that must keep working.
import { describe, expect, test } from "bun:test";
import { parseArgs } from "./launch";

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
});
