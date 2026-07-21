import { defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
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

const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "8420";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "4399";
const executablePath = resolveChromium();

export default defineConfig({
  testDir: "./e2e",
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
      command: `PORT=${MOCK_PORT} MOCK_LIVE_MS=0 MOCK_TEST_HOOKS=1 bun run mock/server.ts`,
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
      timeout: 180_000,
      env: { PORT: WEB_PORT, HOST: "127.0.0.1" },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
