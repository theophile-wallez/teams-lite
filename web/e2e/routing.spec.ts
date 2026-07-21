import { test, expect, gotoApp, openConversationAt } from "./helpers";

// The open conversation lives in the URL (`/c/<conversation-id>`). These specs
// prove the router is real: opening reflects into the path, deep links restore
// the conversation on a fresh load, and back-navigation returns to the list.
test.describe("url routing", () => {
  test("opening a conversation puts its id in the path", async ({ page }) => {
    await gotoApp(page);
    const id = await openConversationAt(page, 0);
    // Teams ids contain ':' and '@', which the router percent-encodes.
    await expect(page).toHaveURL(new RegExp(`/c/${escapeForRegExp(encodeURIComponent(id))}$`));
  });

  test("a deep link restores the open conversation on load", async ({ page }) => {
    await gotoApp(page);
    const id = await openConversationAt(page, 0);
    const title = await page.locator('[data-testid="conversation-title"]').textContent();

    // Reload the current /c/<id> URL from scratch: the conversation reopens.
    await page.reload();
    await expect
      .poll(() => page.locator('[data-testid="conversation-row"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(3);
    await expect(page.locator('[data-testid="conversation-row"][data-open="true"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="conversation-title"]')).toHaveText(title ?? "");
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
  });

  test("Escape returns to the list and clears the path", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="conversation-row"][data-open="true"]')).toHaveCount(0);
  });

  test("browser back closes the conversation", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="conversation-row"][data-open="true"]')).toHaveCount(0);
  });
});

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
