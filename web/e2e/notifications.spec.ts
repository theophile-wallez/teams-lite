import { test, expect, gotoApp, emitNotification, realErrors } from "./helpers";

// The activity feed (`48:notifications`) is surfaced as a bell + panel in the
// sidebar header, never as a chat row. These specs drive the mock's notification
// hook to prove the bell badges, the panel lists entries, selecting one opens the
// source chat, and a live activity re-badges the bell after it has been seen.
test.describe("notifications", () => {
  test("the feed is not a conversation row", async ({ page }) => {
    await gotoApp(page);
    await expect(
      page.locator('[data-testid="conversation-row"][data-conversation-id="48:notifications"]'),
    ).toHaveCount(0);
  });

  test("bell badges unread and opens a panel of activity", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    const bell = page.locator('[data-testid="notifications-bell"]');
    await expect(bell).toBeVisible();
    // The mock seeds unread entries, so the badge shows before opening.
    await expect(page.locator('[data-testid="notifications-badge"]')).toBeVisible();

    await bell.click();
    const panel = page.locator('[data-testid="notifications-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-testid="notification-item"]').first()).toBeVisible();

    // Opening the panel marks everything seen -> the badge clears.
    await expect(page.locator('[data-testid="notifications-badge"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("selecting a notification opens the source conversation and scrolls to the message", async ({
    page,
  }) => {
    await gotoApp(page);
    await page.locator('[data-testid="notifications-bell"]').click();
    const first = page.locator('[data-testid="notification-item"]').first();
    await expect(first).toBeVisible();
    await first.click();

    await expect(page).toHaveURL(/\/c\//);
    await expect(page.locator('[data-testid="conversation-title"]')).not.toBeEmpty();

    // The mock's first notification targets a specific, non-bottom message
    // (`<convId>#100`); opening it must scroll that message into view.
    const convId = decodeURIComponent(page.url().split("/c/")[1] ?? "");
    expect(convId).not.toEqual("");
    const target = page.locator(`[data-message-id="${convId}#100"]`);
    await expect(target).toBeInViewport();
  });

  test("a live activity re-badges the bell after it was seen", async ({ page }) => {
    await gotoApp(page);
    // Open then close so the current feed is marked seen and the badge clears.
    await page.locator('[data-testid="notifications-bell"]').click();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="notifications-badge"]')).toHaveCount(0);

    // A brand-new activity arrives -> notifications_changed -> refetch -> badge.
    await emitNotification(page, { preview: "reacted to your latest message" });
    await expect(page.locator('[data-testid="notifications-badge"]')).toBeVisible();
  });
});
