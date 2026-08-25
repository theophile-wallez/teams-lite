import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHESS_SOUNDS_SERVED,
  CHESS_SOUND_ROUTE,
  CHESS_SOUND_VERSION,
  chessSoundDir,
  chessSoundFileFor,
  chessSoundFileResponse,
  chessSoundUrl,
} from "./chess-sound-file";

// A directory of our own, pointed at through the same override `chess_sound::sounds_dir` reads — so
// nothing here says anything about this machine's real cache.
const DIR = join("/tmp", `teams-lite-sound-route-${process.pid}`);
const PREFIX = `${CHESS_SOUND_ROUTE}${CHESS_SOUND_VERSION}/`;

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  process.env.TEAMS_LITE_CHESS_SOUND_DIR = DIR;
});

afterEach(() => {
  delete process.env.TEAMS_LITE_CHESS_SOUND_DIR;
  rmSync(DIR, { recursive: true, force: true });
});

describe("the route", () => {
  it("serves ONE of the twelve pinned names and nothing else", () => {
    for (const name of CHESS_SOUNDS_SERVED) {
      expect(chessSoundFileFor(`${PREFIX}${name}`)?.path, name).toBe(join(DIR, name));
    }
    expect(CHESS_SOUNDS_SERVED).toHaveLength(12);
  });

  it("refuses every shape of a path that is not a pinned name", () => {
    // The MATCH decides the path, never the request — so nothing below touches a disk at all. A
    // route that joined a caller's string to a directory would serve any file on this machine.
    for (const asked of [
      "../../../etc/passwd",
      "../engine/stockfish-18-lite-single.wasm",
      "capture.mp3/../../secret",
      "/etc/passwd",
      "",
      "capture",
      "CAPTURE.MP3",
      // A real chess.com file this build does not pin: still not ours to serve.
      "game-win-long.mp3",
    ]) {
      expect(chessSoundFileFor(`${PREFIX}${asked}`), asked).toBeNull();
      expect(chessSoundFileResponse(`${PREFIX}${asked}`), asked).toBeNull();
    }
  });

  it("answers nothing at all for another route, so the caller can fall through", () => {
    // `server.ts` and the dev plugin both test the answer for null and carry on; a 404 here would
    // swallow every other path in the app.
    for (const path of [
      "/",
      "/c/19:abc@thread.v2",
      "/__engine/18.0.0-lite-single-a8fbc05e/stockfish-18-lite-single.js",
      // The right file under a DIFFERENT version: the address carries one on purpose, and a build
      // that pinned other recordings must not be handed this one's.
      `${CHESS_SOUND_ROUTE}chesscom-default-00000000/capture.mp3`,
    ]) {
      expect(chessSoundFileResponse(path), path).toBeNull();
    }
  });

  it("says a sound is not here yet rather than answering blank", () => {
    // The ordinary state of a machine nobody has played on: the backend has not fetched them, and the
    // page falls back to its synthesized palette. A normal event, so it says which it is.
    const response = chessSoundFileResponse(`${PREFIX}capture.mp3`);
    expect(response?.status).toBe(404);
    expect(response?.headers.get("content-type")).toContain("text/plain");
  });

  it("serves the bytes as audio, cached for a year", () => {
    writeFileSync(join(DIR, "capture.mp3"), Buffer.from([0xff, 0xfb, 0x00, 0x00]));
    const response = chessSoundFileResponse(`${PREFIX}capture.mp3`);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("audio/mpeg");
    // Immutable, because the address carries the version and the bytes carry a digest the backend
    // pinned — which is what stops a phone re-reading them over the tailnet on every board.
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("puts the version in the directory as well as in the address", () => {
    // Two builds pinning different recordings must not share a cache, or the second would serve the
    // first's bytes from a URL it told the browser to keep for a year.
    delete process.env.TEAMS_LITE_CHESS_SOUND_DIR;
    process.env.XDG_CACHE_HOME = "/tmp/xdg-for-a-test";
    expect(chessSoundDir()).toBe(`/tmp/xdg-for-a-test/teams-lite/chess-sounds/${CHESS_SOUND_VERSION}`);
    delete process.env.XDG_CACHE_HOME;
  });

  it("spells the address in ONE place", () => {
    // The page is handed a route by the backend and appends a name; this is the same spelling, and it
    // is what `chess_sound::status_json` states.
    expect(chessSoundUrl("capture.mp3")).toBe(`${PREFIX}capture.mp3`);
    expect(PREFIX.startsWith("/__chess-sound/")).toBe(true);
  });
});
