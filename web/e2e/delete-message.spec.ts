import { test, expect, gotoApp, openConversationAt } from "./helpers";

test.describe("deleting a message", () => {
  test("deletes my own message from the actions menu, after a confirmation", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // Send a fresh message of our own so the target is deterministic.
    const original = `delete-me-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(original);
    await composer.press("Enter");

    const bubble = page.locator('[data-testid="message"]', { hasText: original });
    await expect(bubble).toBeVisible();

    // The first select arms the confirmation; the menu stays open and the message
    // is still there, because deleting is irreversible.
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-delete"]').click();
    const confirm = page.locator('[data-testid="action-delete-confirm"]');
    await expect(confirm).toBeVisible();
    await expect(page.locator('[data-testid="message"]', { hasText: original })).toBeVisible();

    // The second one deletes: the bubble becomes the placeholder, and the body is
    // no longer in the page.
    await confirm.click();
    const placeholder = page.locator('[data-testid="deleted-message"]');
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText("You deleted this message");
    await expect(page.locator('[data-testid="message"]', { hasText: original })).toHaveCount(0);

    // We cached the body before deleting it, so the placeholder can unveil it.
    await placeholder.locator('[data-testid="deleted-reveal"]').click();
    await expect(page.locator('[data-testid="message"]', { hasText: original })).toBeVisible();
  });

  test("keeps the message when the confirmation is dismissed", async ({ page }) => {
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
    await page.locator('[data-testid="action-delete"]').click();
    await expect(page.locator('[data-testid="action-delete-confirm"]')).toBeVisible();

    // A click away closes the menu without deleting — and disarms it, so the reopened
    // menu offers "Delete" again rather than the confirmation. The click goes through
    // the mouse rather than a locator: an open menu is modal, so it is the only layer
    // taking pointer events. (Escape closes it too, but the app also reads Escape as
    // "leave this conversation".)
    await page.mouse.click(5, 5);
    await expect(page.locator('[data-testid="action-delete-confirm"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="message"]', { hasText: original })).toBeVisible();

    // The whole menu is gone, and the page takes pointer events again: a modal menu
    // holds `pointer-events: none` on the body until its close animation ends, and a
    // reopen attempted inside that window clicks nothing at all.
    await expect(page.locator('[data-testid="menu-reaction-picker"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");

    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await expect(page.locator('[data-testid="action-delete"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-delete-confirm"]')).toHaveCount(0);
  });

  test("does not offer Delete on someone else's message", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const incoming = page.locator('[data-testid="message"][data-mine="false"]').first();
    await expect(incoming).toBeVisible();
    await incoming.hover();
    await incoming.locator('[data-testid="message-actions"]').click();

    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-delete"]')).toHaveCount(0);
  });
});
