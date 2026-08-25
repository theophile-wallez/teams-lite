// Serves the CHESS ENGINE's own files to the app's own page.
//
// The engine is Stockfish as WebAssembly, and it is not in this app: it is 7.3 MB the BACKEND
// fetches on the user's press, verifies against a digest it pins, and caches under
// `~/.cache/teams-lite/engine/<version>/` (see src/chess_engine.rs and AGENTS.md § Playing
// STOCKFISH). This module is the last step of that chain — the bytes reaching the browser.
//
// **IT IS AN HTTP ROUTE RATHER THAN A BLOB, and the engine's own glue is why.** The build this app
// pins is a plain Worker script that finds its `.wasm` from its OWN location: it reads
// `self.location.hash`, and failing that replaces the `.js` of `location.pathname` with `.wasm`. So
// a Worker created from `/engine/stockfish-18-lite-single.js` loads its wasm from the sibling path
// with no configuration at all — same origin, no CORS, no blob whose `location` is a different
// shape on every engine.
//
// **IT CAN SERVE NOTHING BUT THE TWO PINNED FILES.** The name in the URL is matched against a list
// spelled here, and the path is built from the MATCH rather than from the request — so no `..`, no
// absolute path and no symlink game reaches a caller. It is the rail `gitlab_mr::UploadRef::parse`
// holds for an upload and `chess_engine::engine_path` holds on the Rust side: a route that joined a
// caller's string to a directory would serve any file on this machine to anything that can reach
// the port.
//
// Used by the production Bun server (`server.ts`) and by the Vite dev server (`vite.config.ts`), so
// both topologies behave the same — the discipline `write-token.ts` already follows.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the page asks: `/__engine/<version>/<name>`.
 *
 * The VERSION is in the path because the answer is cached for a year as immutable — the bytes are
 * pinned by a digest, so they can never change under one URL, and a build that pins a different
 * engine has to ask at a different address rather than be handed a browser cache of this one's. The
 * `__` prefix is this app's own mark for a route that belongs to the app rather than to the router
 * (see `/__write-token`).
 */
export const ENGINE_ROUTE = "/__engine/";

/**
 * The files this build will serve, and NOTHING else. The names, the sizes and the version are the
 * ones `src/chess_engine.rs` pins — `chess_engine::tests::the_engine_and_its_route_agree` scans this
 * file so the two spellings cannot drift, because they are on opposite sides of a process boundary
 * and a mismatch here is an engine the page cannot load.
 */
export const ENGINE_VERSION = "18.0.0-lite-single-a8fbc05e";
export const ENGINE_SERVED: { name: string; type: string }[] = [
  { name: "stockfish-18-lite-single.js", type: "text/javascript; charset=utf-8" },
  { name: "stockfish-18-lite-single.wasm", type: "application/wasm" },
];

/** Env var a test uses to point the whole feature at a temporary directory. Read here and in
 *  `chess_engine::engine_dir`, and nowhere else, so there is one answer to "where is the engine". */
const ENGINE_DIR_ENV = "TEAMS_LITE_ENGINE_DIR";

/**
 * The directory the engine's files live in. Mirrors `chess_engine::engine_dir()`: the override
 * first, then XDG, then `$HOME/.cache`.
 */
export function engineDir(): string | undefined {
  const override = process.env[ENGINE_DIR_ENV];
  if (override && override.startsWith("/")) return override;
  const cache =
    process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.startsWith("/")
      ? process.env.XDG_CACHE_HOME
      : process.env.HOME
        ? join(process.env.HOME, ".cache")
        : undefined;
  return cache ? join(cache, "teams-lite", "engine", ENGINE_VERSION) : undefined;
}

/** The file one request names, or null when it names anything else. */
export function engineFileFor(pathname: string): { path: string; type: string } | null {
  const prefix = `${ENGINE_ROUTE}${ENGINE_VERSION}/`;
  if (!pathname.startsWith(prefix)) return null;
  const asked = pathname.slice(prefix.length);
  // The MATCH decides the path, never the request: an exact name from the list above, or nothing.
  // So `..`, an absolute path and a name with a slash in it all answer null before any disk is
  // touched — a route that joined a caller's string to a directory would serve any file on this
  // machine to anything that can reach the port.
  const served = ENGINE_SERVED.find((file) => file.name === asked);
  const dir = engineDir();
  if (!served || !dir) return null;
  return { path: join(dir, served.name), type: served.type };
}

/** The URL the page loads the WORKER from — the one place this address is spelled for a client. */
export function engineWorkerPath(name: string): string {
  return `${ENGINE_ROUTE}${ENGINE_VERSION}/${name}`;
}

/**
 * The answer for one engine file.
 *
 * A file that is not there is a 404 with a sentence rather than a blank one: the engine is fetched
 * on the user's press, so "not there" is the ordinary state of a machine nobody has asked for one
 * on, and whoever reads a network log should see why.
 *
 * It is cached HARD — the bytes are pinned by a digest this build states, so they can never change
 * under a URL — which is what stops a phone re-reading 7.3 MB over the tailnet on every board.
 *
 * **IT NAMES NOTHING FROM BUN, and that is not a preference.** This module is loaded by the
 * production server, which is Bun, AND by `vite.config.ts`, which Vite evaluates under NODE — so
 * `Bun.file` here threw `ReferenceError: Bun is not defined` inside the dev middleware and took the
 * whole dev server down on the first engine request. It reached a capture run before it reached a
 * reader, and the shape of the fix is the shape the module already promised: one spelling, valid in
 * both runtimes. The cost is that the file is read into memory rather than streamed — 7.3 MB, once
 * per page, behind a year of `immutable`.
 */
export function engineFileResponse(pathname: string): Response | null {
  const file = engineFileFor(pathname);
  if (!file) return null;
  if (!existsSync(file.path) || !statSync(file.path).isFile()) {
    return new Response("the chess engine is not on this machine — ask the app to fetch it\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(new Uint8Array(readFileSync(file.path)), {
    headers: {
      "content-type": file.type,
      // A year, immutable: the name carries the version and the bytes carry a pinned digest.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
