/**
 * THE ROUTE that hands the chess engine's bytes to the page (`web/engine-file.ts`).
 *
 * Two kinds of rule are pinned here, and both are about a boundary this file sits on:
 *
 *   - WHAT IT WILL SERVE. The path is built from a MATCH against a two-entry list, never from the
 *     request, so a name with `..` or a slash in it answers nothing before any disk is touched.
 *   - WHICH RUNTIMES IT RUNS IN. It is imported by the production Bun server AND by `vite.config.ts`,
 *     which Vite evaluates under Node — so anything Bun-only in it takes the dev server down.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENGINE_ROUTE,
  ENGINE_SERVED,
  ENGINE_VERSION,
  engineDir,
  engineFileFor,
  engineWorkerPath,
} from "../../engine-file";

const HERE = new URL(".", import.meta.url).pathname;
const SOURCE = readFileSync(join(HERE, "..", "..", "engine-file.ts"), "utf8");
/** The source with its comments taken out — the module explains the Bun rule in its own prose, and a
 *  scan that read that would fail on the sentence that states the rule it is checking. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const previous = process.env.TEAMS_LITE_ENGINE_DIR;
afterEach(() => {
  if (previous === undefined) delete process.env.TEAMS_LITE_ENGINE_DIR;
  else process.env.TEAMS_LITE_ENGINE_DIR = previous;
});

describe("what the route will serve", () => {
  it("answers the two pinned files, at the versioned path", () => {
    process.env.TEAMS_LITE_ENGINE_DIR = "/tmp/engine-test";
    for (const served of ENGINE_SERVED) {
      const match = engineFileFor(`${ENGINE_ROUTE}${ENGINE_VERSION}/${served.name}`);
      expect(match, served.name).toEqual({
        path: `/tmp/engine-test/${served.name}`,
        type: served.type,
      });
    }
  });

  it("answers NOTHING for a name it does not hold, however it is written", () => {
    process.env.TEAMS_LITE_ENGINE_DIR = "/tmp/engine-test";
    for (const asked of [
      "../../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
      "/etc/passwd",
      "stockfish-18-lite-single.js.map",
      "sub/stockfish-18-lite-single.js",
      "",
    ]) {
      expect(engineFileFor(`${ENGINE_ROUTE}${ENGINE_VERSION}/${asked}`), asked).toBeNull();
    }
    // And a version other than this build's, which is what makes the `immutable` cache safe: a
    // browser holding last build's bytes has to ask at last build's address, and gets nothing.
    expect(engineFileFor(`${ENGINE_ROUTE}17.0.0/${ENGINE_SERVED[0]!.name}`)).toBeNull();
    expect(engineFileFor(`/engine/${ENGINE_SERVED[0]!.name}`)).toBeNull();
  });

  it("takes the directory from an ABSOLUTE override only", () => {
    process.env.TEAMS_LITE_ENGINE_DIR = "relative/engine";
    expect(engineDir()).not.toBe("relative/engine");
    // The version is part of the cache path, so two builds never share a directory.
    process.env.TEAMS_LITE_ENGINE_DIR = "";
    expect(engineDir()).toContain(`/teams-lite/engine/${ENGINE_VERSION}`);
  });

  it("spells the worker's address in ONE place", () => {
    expect(engineWorkerPath(ENGINE_SERVED[0]!.name)).toBe(
      `${ENGINE_ROUTE}${ENGINE_VERSION}/${ENGINE_SERVED[0]!.name}`,
    );
  });

  it("serves the glue and its wasm as a PAIR, differing only in the suffix", () => {
    // The engine's own glue derives its wasm URL from its own location by replacing `.js` with
    // `.wasm`, so the two names must differ in nothing else — nothing in this app ever spells the
    // wasm address, which is why a unit test stands in for it.
    const [glue, wasm] = ENGINE_SERVED;
    expect(glue!.name.endsWith(".js")).toBe(true);
    expect(wasm!.name).toBe(glue!.name.replace(/\.js$/, ".wasm"));
    expect(wasm!.type).toBe("application/wasm");
  });
});

describe("the runtimes it has to run in", () => {
  it("NAMES NOTHING FROM BUN, because Vite evaluates it under Node", () => {
    // `Bun.file` here threw `ReferenceError: Bun is not defined` inside the dev middleware and took
    // the whole dev server down on the first engine request — a board that worked in production and
    // killed the server in dev. One spelling, valid in both runtimes, is the whole point of the
    // module being shared.
    expect(CODE).not.toMatch(/\bBun\./);
  });
});
