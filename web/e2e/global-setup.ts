// Refuse to run the E2E suite against a real Teams account.
//
// `reuseExistingServer` is on outside CI, so whatever already listens on the mock's
// port gets adopted — and every spec that sends, edits or reacts then does so on
// the user's actual account, to real colleagues. The port default is no longer the
// backend's (see playwright.config.ts) and the app's WebSocket URL is now derived
// from it, but a squatted port is still possible, so check identity here.
// (See also the auto `mockBackendOnly` fixture in helpers.ts, which closes the page
// if the app dials anywhere else, `web/scripts/preview.ts` for one-off browser
// scripts, and `defaultWsUrl` in `src/lib/ws-client.ts`.)
//
// The two backends are trivially distinguishable over plain HTTP: the mock answers
// a GET with its name, the Rust backend speaks only WebSocket and returns nothing.
// We check that once, before any spec runs, and abort the whole run otherwise.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENGINE_SERVED } from "../engine-file";
import { ENGINE_DIR } from "../playwright.config";

const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "19457";
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/`;
/** What `web/mock/server.ts` answers to a plain GET. */
const MOCK_GREETING = "teams-lite mock backend";

/**
 * THE CHESS ENGINE, stood in for.
 *
 * A game against the computer loads a Worker from the path the backend names, out of the directory
 * `TEAMS_LITE_ENGINE_DIR` points at (see src/chess_engine.rs and web/engine-file.ts). The real
 * engine is 7.3 MB, so this run writes a STUB there instead — `web/mock/engine-stub.js`, with the
 * mock's own origin baked in so it can ask the mock for a LEGAL move.
 *
 * It is written under the PINNED file name, because that is the only name the route will serve: the
 * harness stands in for the bytes, never for the address. And it can never be reached in production:
 * the real backend verifies every file it installs against a digest it pins, so a stub cannot be
 * installed by one — only a directory a test named can hold it.
 */
function installEngineStub(): void {
  const stub = readFileSync(join(dirname(import.meta.filename), "..", "mock", "engine-stub.js"), "utf8");
  mkdirSync(ENGINE_DIR, { recursive: true });
  writeFileSync(
    join(ENGINE_DIR, ENGINE_SERVED[0]!.name),
    stub.replace("__MOCK_ORIGIN__", `http://127.0.0.1:${MOCK_PORT}`),
  );
}

export default async function globalSetup(): Promise<void> {
  installEngineStub();
  let body: string;
  try {
    body = await (await fetch(MOCK_URL)).text();
  } catch {
    // Nothing is listening yet: Playwright's own `webServer` will start the mock
    // (and would have failed with EADDRINUSE if the port were taken), so there is
    // no live backend to protect against here.
    return;
  }
  if (body.includes(MOCK_GREETING)) return;
  throw new Error(
    `Something other than the mock backend is listening on port ${MOCK_PORT} — very likely ` +
      `your real teams-lite backend. Running the suite against it would send real messages ` +
      `to real people. Start it on a free port instead, e.g.\n\n` +
      `  E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468 bun run test:e2e\n`,
  );
}
