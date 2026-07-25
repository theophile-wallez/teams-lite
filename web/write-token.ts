// Hands the backend's write token to the app's own browser page.
//
// The Rust backend refuses `send`/`edit`/`react` unless the request carries a
// capability token it publishes for the user's own frontends: reading this backend
// is open (useful), writing posts to real people as the user (dangerous). See the
// write lock in `src/bin/server.rs`.
//
// The browser cannot read that token from disk, so the server that serves the app
// exposes it on one endpoint — used by the production Bun server (`server.ts`) and
// by the Vite dev server (`vite.config.ts`), so both topologies behave the same.
//
// Honest limits: any process running as the user can call this endpoint, exactly as
// it can read the token file or the SQLite store. The lock is here to make an
// ACCIDENTAL write impossible — a script that stumbles onto the backend has no
// token and gets refused — not to defend against a local process that deliberately
// goes looking for a secret it was never handed. AGENTS.md § Automation safety
// forbids that, and `.claude/hooks/guard-live-automation.sh` blocks the usual ways.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The endpoint the client fetches once at startup (see `lib/store.ts`). */
export const WRITE_TOKEN_ROUTE = "/__write-token";

/** Env var a launcher may use to pin the token for backend and frontend alike. */
const WRITE_TOKEN_ENV = "TEAMS_LITE_WRITE_TOKEN";

/**
 * Where the backend publishes the token (0600). Mirrors `write_token_path()` in
 * `src/bin/server.rs`: runtime dir first, then the data dir.
 */
function tokenPaths(): string[] {
  const bases = [
    process.env.XDG_RUNTIME_DIR,
    process.env.XDG_DATA_HOME,
    process.env.HOME ? join(process.env.HOME, ".local", "share") : undefined,
  ];
  return bases
    .filter((base): base is string => !!base && base.startsWith("/"))
    .map((base) => join(base, "teams-lite", "write-token"));
}

/** The token, from the environment or the file the backend published. */
export function readWriteToken(): string | null {
  const fromEnv = process.env[WRITE_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  for (const path of tokenPaths()) {
    if (!existsSync(path)) continue;
    try {
      const token = readFileSync(path, "utf8").trim();
      if (token) return token;
    } catch {
      // Unreadable (wrong owner, races with a backend restart): try the next one.
    }
  }
  return null;
}

/**
 * The response for {@link WRITE_TOKEN_ROUTE}. 404 when there is no token — the
 * mock backend needs none, and a client without one simply cannot write.
 */
export function writeTokenResponse(): Response {
  const token = readWriteToken();
  if (!token) return new Response("no write token published", { status: 404 });
  return new Response(JSON.stringify({ token }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
