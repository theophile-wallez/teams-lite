// End-to-end smoke test: drive the real web UI in a headless browser against the
// mock backend, exercising the full path (SSR -> hydrate -> WebSocket -> render).
//
/// <reference lib="dom" />
//
// This is a manual/CI-opt-in verification (not part of `bun run test`), because
// it needs a Chromium binary. Point CHROME_PATH at one, or it falls back to the
// Playwright cache. Env: WEB_URL (default http://127.0.0.1:4399).
//
// Usage (see scripts/e2e-run.sh which orchestrates the servers):
//   CHROME_PATH=/path/to/chrome bun run scripts/e2e-smoke.ts

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:4399";

function resolveChrome(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache", "ms-playwright");
  const candidates = [
    join(base, "chromium-1228", "chrome-linux64", "chrome"),
    join(base, "chromium-1228", "chrome-linux", "chrome"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("no Chromium found; set CHROME_PATH");
}

function fail(msg: string): never {
  console.error(`E2E FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: resolveChrome(),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });

  // 1. The app hydrates, connects to the mock backend, and renders the sidebar.
  //    Conversation rows are buttons with aria-current; wait for several to load.
  await page.waitForFunction(
    () => document.querySelectorAll("aside button").length > 5,
    undefined,
    { timeout: 15000 },
  );
  const convCount = await page.locator("aside button").count();
  console.log(`  ✓ sidebar rendered ${convCount} conversations`);

  // 2. Open the first conversation; the message pane should render bubbles.
  await page.locator("aside button").first().click();
  await page.waitForFunction(
    () => {
      const h2 = document.querySelector("section h2");
      return !!h2 && (h2.textContent ?? "").length > 0;
    },
    undefined,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll("section p").length > 0,
    undefined,
    { timeout: 10000 },
  );
  const title = (await page.locator("section h2").first().textContent())?.trim();
  console.log(`  ✓ opened conversation "${title}" with messages`);

  // 3. Type a message and send it; the optimistic echo should appear.
  const marker = `e2e-${Date.now()}`;
  const composer = page.locator("textarea");
  await composer.click();
  await composer.fill(marker);
  await composer.press("Enter");
  await page.waitForFunction(
    (text) => document.body.innerText.includes(text),
    marker,
    { timeout: 10000 },
  );
  console.log(`  ✓ sent a message and saw it echoed (${marker})`);

  // 4. Command palette (Ctrl+K) opens and filters.
  await page.keyboard.press("Control+K");
  await page.waitForSelector('[cmdk-input]', { timeout: 5000 });
  console.log("  ✓ Ctrl+K command palette opens");
  await page.keyboard.press("Escape");

  // 5. Theme picker (Ctrl+P) changes the data-theme attribute.
  await page.keyboard.press("Control+P");
  await page.waitForSelector("[cmdk-input]", { timeout: 5000 });
  await page.keyboard.type("dracula");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.documentElement.getAttribute("data-theme") === "dracula",
    undefined,
    { timeout: 5000 },
  );
  console.log("  ✓ Ctrl+P theme picker switches themes (dracula)");

  const fatalErrors = errors.filter(
    (e) => !e.includes("favicon") && !/Download the React DevTools/i.test(e),
  );
  if (fatalErrors.length > 0) fail(`console errors:\n${fatalErrors.join("\n")}`);

  console.log("\nE2E PASS: full interactive path works against the mock backend.");
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await browser.close();
}
