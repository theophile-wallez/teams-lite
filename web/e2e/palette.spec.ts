import { test, expect, gotoApp } from "./helpers";

test.describe("command palette (Ctrl+K)", () => {
  test("opens, filters, and jumps to a conversation", async ({ page }) => {
    await gotoApp(page);
    // Grab a known conversation name from the sidebar to search for.
    const name = (await page
      .locator('[data-testid="conversation-row"]')
      .first()
      .locator('[data-testid="conversation-name"]')
      .first()
      .textContent())?.trim();

    await page.keyboard.press("Control+k");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();

    await input.fill(name ?? "");
    // Selecting the top result opens that conversation.
    await input.press("Enter");
    await expect(page.locator("[cmdk-input]")).toHaveCount(0);
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText(name ?? "");
  });

  test("closes on Escape", async ({ page }) => {
    await gotoApp(page);
    await page.keyboard.press("Control+k");
    await expect(page.locator("[cmdk-input]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  });
});
