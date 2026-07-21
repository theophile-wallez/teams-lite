import { test, expect, gotoApp, openConversationAt } from "./helpers";

test.describe("editing a message", () => {
  test("edits my own message in place from the actions menu", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // First send a fresh message of our own so we have a deterministic target.
    const original = `edit-me-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(original);
    await composer.press("Enter");

    const bubble = page.locator('[data-testid="message"]', { hasText: original });
    await expect(bubble).toBeVisible();

    // Open the actions menu and start editing.
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-edit"]').click();

    // The bubble becomes an in-place editor seeded with the current text.
    const input = page.locator('[data-testid="message-edit-input"]');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(original);

    // Replace the text and save with Enter. Use a distinct token (not a
    // superset of the original) so the "old text is gone" assertion is exact.
    const edited = `edited-${Date.now()}`;
    await input.fill(edited);
    await input.press("Enter");

    // The bubble now shows the new content, and the old text is gone.
    await expect(page.locator('[data-testid="message"]', { hasText: edited })).toBeVisible();
    await expect(page.locator('[data-testid="message-edit-input"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="message"]', { hasText: original })).toHaveCount(0);
  });

  test("Escape cancels an in-place edit without changing the message", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const original = `keep-me-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(original);
    await composer.press("Enter");

    const bubble = page.locator('[data-testid="message"]', { hasText: original });
    await expect(bubble).toBeVisible();
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-edit"]').click();

    const input = page.locator('[data-testid="message-edit-input"]');
    await input.fill("discarded text");
    await input.press("Escape");

    await expect(page.locator('[data-testid="message-edit-input"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="message"]', { hasText: original })).toBeVisible();
  });

  test("does not offer Edit on someone else's message", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const incoming = page.locator('[data-testid="message"][data-mine="false"]').first();
    await expect(incoming).toBeVisible();
    await incoming.hover();
    await incoming.locator('[data-testid="message-actions"]').click();

    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-edit"]')).toHaveCount(0);
  });
});
