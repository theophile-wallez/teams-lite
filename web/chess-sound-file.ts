// Serves the CHESS BOARD's own SOUNDS to the app's own page.
//
// They are chess.com's recordings, and they are not in this app: the BACKEND fetches the twelve of
// them once per machine, verifies each against a digest it pins, and caches them under
// `~/.cache/teams-lite/chess-sounds/<version>/` (see src/chess_sound.rs and AGENTS.md § Chess in a
// conversation). This module is the last step of that chain — the bytes reaching the browser, from
// THIS app's origin rather than from chess.com's, so drawing a board tells them nothing.
//
// **IT CAN SERVE NOTHING BUT THE TWELVE PINNED FILES.** The name in the URL is matched against a
// list spelled here, and the path is built from the MATCH rather than from the request — so no `..`,
// no absolute path and no symlink game reaches a caller. It is the rail `engine-file.ts` holds for
// the engine and `gitlab_mr::UploadRef::parse` holds for an upload: a route that joined a caller's
// string to a directory would serve any file on this machine to anything that can reach the port.
//
// Used by the production Bun server (`server.ts`) and by the Vite dev server (`vite.config.ts`), so
// both topologies behave the same — the discipline `write-token.ts` already follows.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the page asks: `/__chess-sound/<version>/<name>`.
 *
 * The VERSION is in the path because the answer is cached for a year as immutable — the bytes are
 * pinned by a digest, so they can never change under one URL, and a build that pins other recordings
 * has to ask at a different address rather than be handed a browser cache of this one's. The `__`
 * prefix is this app's own mark for a route that belongs to the app rather than to the router.
 */
export const CHESS_SOUND_ROUTE = "/__chess-sound/";

/**
 * The version and the files this build will serve, and NOTHING else. Both are the ones
 * `src/chess_sound.rs` pins — `chess_sound::tests::the_sounds_and_their_route_agree` scans this file
 * so the two spellings cannot drift, because they are on opposite sides of a process boundary and a
 * mismatch here is a sound this backend fetched and the page cannot load.
 */
export const CHESS_SOUND_VERSION = "chesscom-default-94997488";
export const CHESS_SOUNDS_SERVED: string[] = [
  "game-start.mp3",
  "game-end.mp3",
  "capture.mp3",
  "castle.mp3",
  "premove.mp3",
  "move-self.mp3",
  "move-opponent.mp3",
  "move-check.mp3",
  "promote.mp3",
  "notify.mp3",
  "illegal.mp3",
  "tenseconds.mp3",
];

/** Env var a test uses to point the whole feature at a temporary directory. Read here and in
 *  `chess_sound::sounds_dir`, and nowhere else, so there is one answer to "where are they". */
const SOUND_DIR_ENV = "TEAMS_LITE_CHESS_SOUND_DIR";

/**
 * The directory the sounds live in. Mirrors `chess_sound::sounds_dir()`: the override first, then
 * XDG, then `$HOME/.cache`.
 */
export function chessSoundDir(): string | undefined {
  const override = process.env[SOUND_DIR_ENV];
  if (override && override.startsWith("/")) return override;
  const cache =
    process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.startsWith("/")
      ? process.env.XDG_CACHE_HOME
      : process.env.HOME
        ? join(process.env.HOME, ".cache")
        : undefined;
  return cache ? join(cache, "teams-lite", "chess-sounds", CHESS_SOUND_VERSION) : undefined;
}

/** The file one request names, or null when it names anything else. */
export function chessSoundFileFor(pathname: string): { path: string } | null {
  const prefix = `${CHESS_SOUND_ROUTE}${CHESS_SOUND_VERSION}/`;
  if (!pathname.startsWith(prefix)) return null;
  const asked = pathname.slice(prefix.length);
  // The MATCH decides the path, never the request: an exact name from the list above, or nothing.
  // So `..`, an absolute path and a name with a slash in it all answer null before any disk is
  // touched.
  if (!CHESS_SOUNDS_SERVED.includes(asked)) return null;
  const dir = chessSoundDir();
  if (!dir) return null;
  return { path: join(dir, asked) };
}

/** The address the page fetches one sound from — the one place this is spelled for a client. */
export function chessSoundUrl(name: string): string {
  return `${CHESS_SOUND_ROUTE}${CHESS_SOUND_VERSION}/${name}`;
}

/**
 * The answer for one sound.
 *
 * A file that is not there is a 404 with a sentence rather than a blank one: the sounds are fetched
 * when a reader first opens a board, so "not there" is the ordinary state of a machine nobody has
 * played on, and the page falls back to its own synthesized palette rather than going silent — so
 * this 404 is a normal event, not a fault, and whoever reads a network log should see which it is.
 *
 * It is cached HARD, because the bytes are pinned by a digest this build states and can never change
 * under this URL. That is what stops a phone re-reading them over the tailnet on every board.
 *
 * **IT NAMES NOTHING FROM BUN**, which is the rule `engine-file.ts` states and paid for: this module
 * is loaded by the production server, which is Bun, AND by `vite.config.ts`, which Vite evaluates
 * under NODE — so `Bun.file` here would throw `ReferenceError: Bun is not defined` inside the dev
 * middleware and take the whole dev server down on the first sound request.
 */
export function chessSoundFileResponse(pathname: string): Response | null {
  const file = chessSoundFileFor(pathname);
  if (!file) return null;
  if (!existsSync(file.path) || !statSync(file.path).isFile()) {
    return new Response("that board sound is not on this machine yet\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(new Uint8Array(readFileSync(file.path)), {
    headers: {
      "content-type": "audio/mpeg",
      // A year, immutable: the address carries the version and the bytes carry a pinned digest.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
