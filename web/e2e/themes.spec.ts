import { test, expect, gotoApp } from "./helpers";

test.describe("theme picker (Ctrl+P)", () => {
  test("selects a theme, applies it, and persists across reload", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "teams");

    await page.keyboard.press("Control+p");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();
    await input.fill("dracula");
    await input.press("Enter");

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
    // Persisted to localStorage…
    const stored = await page.evaluate(() => localStorage.getItem("teams-theme"));
    expect(stored).toBe("dracula");

    // …and survives a reload (the pre-hydration bootstrap applies it, no flash).
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  });

  test("reverts a live preview when dismissed without selecting", async ({ page }) => {
    await gotoApp(page);
    // Ensure a known committed theme first.
    await page.evaluate(() => localStorage.setItem("teams-theme", "teams"));
    await page.reload();
    await gotoApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "teams");

    await page.keyboard.press("Control+p");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();
    await input.fill("nord");
    // Highlighting previews the theme live (no commit yet).
    await expect
      .poll(() => page.locator("html").getAttribute("data-theme"))
      .toBe("nord");
    // Dismissing reverts to the committed theme.
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "teams");
  });
});
