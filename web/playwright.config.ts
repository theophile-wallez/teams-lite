import { defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Resolve a Chromium binary without a network install: prefer CHROME_PATH, then
// the newest chromium in the Playwright browser cache. Setting launchOptions.
// executablePath bypasses Playwright's version-pinned browser resolution, so the
// suite runs offline against whatever Chromium is already on the machine.
function resolveChromium(): string | undefined {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
    .sort();
  for (const d of dirs.reverse()) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = join(base, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// The mock's port must NEVER default to 19420: that is the real backend's port, and
// with `reuseExistingServer` on outside CI the suite would silently "reuse" a
// running dev backend and send real messages to real people. It did, once.
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "19457";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "19447";
// The app's WebSocket target is baked at BUILD time, so it must be derived from
// MOCK_PORT here. Moving the mock's port without this is exactly how the suite
// ended up driving a real account: the mock moved, the app kept dialing 19420.
const MOCK_WS_URL = `ws://127.0.0.1:${MOCK_PORT}`;
// WHERE THE CHESS ENGINE IS, for this run only: a temporary directory the setup writes a STUB
// worker into (see e2e/global-setup.ts). It must never be the real cache — a machine that has
// really fetched Stockfish would otherwise load 7.3 MB of WebAssembly into every spec, and one
// that has not would behave differently from one that has.
export const ENGINE_DIR = join(tmpdir(), `teams-lite-e2e-engine-${MOCK_PORT}`);
// WHERE THE BOARD'S SOUNDS ARE, for this run only: a directory that stays EMPTY. It must never be
// the real cache, for the reason above and one more of its own — the recordings are chess.com's and
// are not in this repository, so a machine that has really played chess would load them and one that
// has not would fall back to synthesis, and the suite would behave differently on the two. Empty
// means every spec exercises the fallback, which is the state that must never be silent.
export const CHESS_SOUND_DIR = join(tmpdir(), `teams-lite-e2e-chess-sound-${MOCK_PORT}`);
const executablePath = resolveChromium();

export default defineConfig({
  testDir: "./e2e",
  // Hard gate: abort the run if anything other than the mock answers on
  // MOCK_PORT (i.e. the real backend), before a single spec can send a message.
  globalSetup: "./e2e/global-setup.ts",
  // The mock backend is a single shared, stateful process, so run serially to
  // keep injected live-events and drafts isolated between tests.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    headless: true,
    // Pin the emulated OS scheme to light so the default "System" appearance
    // resolves deterministically to the light theme in tests.
    colorScheme: "light",
    trace: "on-first-retry",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
  ],
  webServer: [
    {
      // Deterministic mock: no random live feed, test hooks enabled so specs can
      // inject live events on demand.
      // `MOCK_AGENT_STEP_MS` hurries the simulated agent run along: the mock paces it
      // for a human watching a screenshot. Not to the floor, though — a spec asserts on
      // the tool call that is running, and a phase that lasts 150 ms is a phase a
      // reader could not see either.
      command: `PORT=${MOCK_PORT} MOCK_LIVE_MS=0 MOCK_TEST_HOOKS=1 MOCK_AGENT_STEP_MS=150 bun run mock/server.ts`,
      url: `http://127.0.0.1:${MOCK_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // Build the SSR app, then serve it with the production Bun server — the
      // same output shipped in the binary. Self-contained so `playwright test`
      // works with no prior build step.
      command: "bun run build && bun run start",
      url: `http://127.0.0.1:${WEB_PORT}/`,
      reuseExistingServer: !process.env.CI,
      // The command builds BOTH bundles (client + SSR) before it serves anything,
      // and a cold build measures ~3 min on a machine with no warm Vite cache — a
      // fresh worktree, or a checkout that just changed branch. A tighter budget
      // fails the whole suite on the build step, which reads as a broken app.
      timeout: 420_000,
      // VITE_TEAMS_WS_URL is consumed by the BUILD (baked into the client bundle),
      // which is why it must be set here and not just for the mock process.
      //
      // That is also why this run leaves a bundle behind that must never be served
      // to a real user: it dials the mock. The build records the pin and
      // `web/server.ts` refuses such a bundle — so THIS harness, the one that meant
      // it, is the one place that opts back in (see web/build-info.ts).
      env: {
        PORT: WEB_PORT,
        HOST: "127.0.0.1",
        VITE_TEAMS_WS_URL: MOCK_WS_URL,
        TEAMS_LITE_ALLOW_PINNED_BUILD: "1",
        // The engine's own files, for this run: the stub, never the real cache (see above).
        TEAMS_LITE_ENGINE_DIR: ENGINE_DIR,
        // And the board's sounds: an empty directory, never the real cache (see above).
        TEAMS_LITE_CHESS_SOUND_DIR: CHESS_SOUND_DIR,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
