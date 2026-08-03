import { test, expect, gotoApp, openConversationAt } from "./helpers";

test.describe("messaging", () => {
  test("sends a message and shows the echoed bubble", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const marker = `send-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(marker);
    await composer.press("Enter");
    // The mock echoes the sent message ~150ms later as one of ours.
    const echoed = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(echoed).toBeVisible();
    await expect(echoed.first()).toHaveAttribute("data-mine", "true");
    // The composer is cleared after sending.
    await expect(composer).toHaveValue("");
  });

  // The live sentinel. `web/scripts/sandbox-live.ts` may type into the user's real
  // account in exactly one conversation, and it proves which one is open by reading
  // this attribute before every keystroke — so it has to name the thread that is
  // actually on screen, and it has to follow a switch (AGENTS.md § Sending messages).
  test("the composer names the conversation it would post to", async ({ page }) => {
    await gotoApp(page);
    const shell = page.locator('[data-testid="composer-shell"]');

    const first = await openConversationAt(page, 0);
    expect(first).not.toBe("");
    await expect(shell).toHaveAttribute("data-conversation-id", first);

    const second = await openConversationAt(page, 1);
    expect(second).not.toBe(first);
    await expect(shell).toHaveAttribute("data-conversation-id", second);
  });

  test("Shift+Enter inserts a newline instead of sending", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const before = await page.locator('[data-testid="message"]').count();
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.type("line one");
    await composer.press("Shift+Enter");
    await composer.type("line two");
    await expect(composer).toHaveValue("line one\nline two");
    // No message was sent.
    expect(await page.locator('[data-testid="message"]').count()).toBe(before);
  });

  test("replies to a message via the actions menu", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const target = page.locator('[data-testid="message"]').first();
    await target.hover();
    await target.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();

    const marker = `reply-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.fill(marker);
    await composer.press("Enter");
    await expect(page.locator('[data-testid="message"]', { hasText: marker })).toBeVisible();
    // The banner clears once the reply is sent.
    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });

  test("Escape cancels a pending reply", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const target = page.locator('[data-testid="message"]').first();
    await target.hover();
    await target.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    await page.locator('[data-testid="composer"]').press("Escape");
    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });

  test("copies a message to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoApp(page);
    await openConversationAt(page, 0);
    const target = page.locator('[data-testid="message"]').first();
    await target.hover();
    await target.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-copy"]').click();
    // The app reports success in the status bar.
    await expect(page.locator('[data-testid="status-bar"]')).toContainText("copied");
  });
});
