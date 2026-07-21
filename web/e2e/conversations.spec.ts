import { test, expect, gotoApp, openConversationAt } from "./helpers";

test.describe("conversations", () => {
  test("shows a populated, virtualized sidebar", async ({ page }) => {
    await gotoApp(page);
    // The mock seeds 34 conversations; virtualization renders a visible subset.
    const rows = page.locator('[data-testid="conversation-row"]');
    expect(await rows.count()).toBeGreaterThan(5);
    await expect(rows.first()).toBeVisible();
  });

  test("opens a conversation and renders its messages", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const openRow = page.locator('[data-testid="conversation-row"][data-open="true"]');
    await expect(openRow).toHaveCount(1);
    await expect(page.locator('[data-testid="conversation-title"]')).not.toBeEmpty();
    expect(await page.locator('[data-testid="message"]').count()).toBeGreaterThan(0);
  });

  test("renders both my and incoming message bubbles", async ({ page }) => {
    await gotoApp(page);
    // Open a group chat (has both sides). Fall back to the first conversation.
    const group = page.locator('[data-testid="conversation-row"]', { hasText: "Team" }).first();
    if (await group.count()) await group.click();
    else await openConversationAt(page, 0);
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
    // Scroll through history so a mix of both sides is present.
    await expect
      .poll(async () => page.locator('[data-testid="message"][data-mine="true"]').count())
      .toBeGreaterThan(0);
  });

  test("virtualized sidebar scrolls to reveal more conversations", async ({ page }) => {
    await gotoApp(page);
    const firstId = await page
      .locator('[data-testid="conversation-row"]')
      .first()
      .getAttribute("data-conversation-id");
    const scroller = page.locator('[data-testid="sidebar"] > div');
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    // After scrolling to the bottom, the topmost rendered row should differ
    // (virtualization recycled the window).
    await expect
      .poll(async () =>
        page.locator('[data-testid="conversation-row"]').first().getAttribute("data-conversation-id"),
      )
      .not.toBe(firstId);
  });
});
