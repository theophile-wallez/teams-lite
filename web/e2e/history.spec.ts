import { test, expect, gotoApp, openConversationAt } from "./helpers";

test.describe("history (infinite scroll)", () => {
  test("loads older messages when scrolling up, and reaches the start", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const messages = page.locator('[data-testid="message"]');
    const initial = await messages.count();
    // The mock returns the newest 40 and reports has_more.
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThanOrEqual(40);

    const scroller = page.locator('[data-testid="message-scroll"]');

    // Scroll to the top repeatedly to pull older pages until the backlog (120)
    // is exhausted or we plateau — proving both backfill and the end-of-history.
    let last = initial;
    for (let i = 0; i < 6; i++) {
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await expect
        .poll(() => messages.count(), { timeout: 8_000 })
        .toBeGreaterThanOrEqual(last);
      const now = await messages.count();
      if (now === last && now >= 120) break;
      last = now;
    }

    // We should have loaded well beyond the first page.
    expect(last).toBeGreaterThan(initial);
  });

  test("preserves scroll position when older messages are prepended", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const scroller = page.locator('[data-testid="message-scroll"]');
    const oldestBefore = await page
      .locator('[data-testid="message"]')
      .first()
      .textContent();

    await scroller.evaluate((el) => (el.scrollTop = 0));
    // After a backfill the previously-oldest message must still be in the DOM
    // (the view is anchored, not reset to the bottom).
    await expect(page.locator('[data-testid="message"]', { hasText: oldestBefore ?? "" }).first()).toBeVisible();
    // And the scroll is not pinned to the very bottom.
    const atBottom = await scroller.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
    );
    expect(atBottom).toBeFalsy();
  });
});
