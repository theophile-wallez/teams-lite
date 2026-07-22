import { test, expect, gotoApp } from "./helpers";

// The Ctrl+P appearance picker offers System / Light / Dark. The OS scheme is
// pinned to light in playwright.config.ts, so the default "System" resolves to
// the light theme.
test.describe("appearance picker (Ctrl+P)", () => {
  test("selects Dark, applies it, and persists across reload", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.keyboard.press("Control+p");
    const dark = page.locator('[data-testid="appearance-option"][data-value="dark"]');
    await expect(dark).toBeVisible();
    await dark.click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // Persisted to localStorage…
    const stored = await page.evaluate(() => localStorage.getItem("teams-theme"));
    expect(stored).toBe("dark");

    // …and survives a reload (the pre-hydration bootstrap applies it, no flash).
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("System follows the (light) OS scheme", async ({ page }) => {
    await gotoApp(page);
    // Start from a known Dark state, then pick System.
    await page.evaluate(() => localStorage.setItem("teams-theme", "dark"));
    await page.reload();
    await gotoApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.keyboard.press("Control+p");
    const system = page.locator('[data-testid="appearance-option"][data-value="system"]');
    await expect(system).toBeVisible();
    await system.click();

    // OS scheme is pinned to light in the config, so System resolves to light.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const stored = await page.evaluate(() => localStorage.getItem("teams-theme"));
    expect(stored).toBe("system");
  });

  test("reverts a live preview when dismissed without choosing", async ({ page }) => {
    await gotoApp(page);
    // Ensure a known committed appearance first.
    await page.evaluate(() => localStorage.setItem("teams-theme", "light"));
    await page.reload();
    await gotoApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.keyboard.press("Control+p");
    const dark = page.locator('[data-testid="appearance-option"][data-value="dark"]');
    await expect(dark).toBeVisible();
    // Hovering previews live (no commit yet).
    await dark.hover();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    // Dismissing reverts to the committed appearance.
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
