import { test, expect, gotoApp, realErrors } from "./helpers";

test.describe("app boot", () => {
  test("server-renders the shell with title, theme, and favicon", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("teams-lite");
    // SSR sets the default (light) theme on <html> before any JS runs.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator('head link[rel="icon"]')).toHaveCount(1);
    // Fetched WITH cookies, or a sign-in proxy in front of the app answers it with a redirect and
    // the app cannot be installed (see __root.tsx).
    await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute("crossorigin", "use-credentials");
  });

  test("connects to the backend and loads conversations", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator('[data-testid="live-dot"]')).toHaveAttribute("data-state", "connected");
    await expect(page.locator('[data-testid="status-bar"]')).toContainText("conversations");
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  });

  test("runs without console errors", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await page.locator('[data-testid="conversation-row"]').first().click();
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("favicon resolves (no 404)", async ({ page }) => {
    const ico = await page.request.get("/favicon.ico");
    expect(ico.ok()).toBeTruthy();
    const svg = await page.request.get("/favicon.svg");
    expect(svg.ok()).toBeTruthy();
  });
});
