import { devices } from "@playwright/test";
import { test, expect, gotoApp, openConversationAt } from "./helpers";

// The mobile, single-pane layout. Emulate an Android Chrome phone (narrow
// viewport + touch, so the `md` breakpoint resolves to the mobile layout and
// coarse-pointer affordances turn on). Below `md` the conversation list is the
// home screen and a conversation slides in over it as a separate "page"; there
// is no persistent second column.
test.use({ ...devices["Pixel 7"] });

/** The detail pane's left edge, used to tell whether it is on-screen (x≈0) or
 *  parked off the right edge (x≈viewport width). */
async function paneLeft(page: import("@playwright/test").Page): Promise<number> {
  const box = await page.locator('[data-testid="detail-pane"]').boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
}

test.describe("mobile single-pane layout", () => {
  test("the conversation list is the home screen and the chat is off-screen", async ({ page }) => {
    await gotoApp(page);
    const width = page.viewportSize()!.width;

    // The list fills the screen; the detail pane is parked off the right edge.
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await expect(page.locator('[data-testid="detail-pane"]')).not.toHaveAttribute(
      "data-open",
      "true",
    );
    expect(await paneLeft(page)).toBeGreaterThanOrEqual(width - 1);
    // No back button while on the list.
    await expect(page.locator('[data-testid="back-to-list"]')).toHaveCount(0);
  });

  test("tapping a conversation slides the chat in over the list", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // The chat page is now the active pane, flush to the left edge.
    await expect(page.locator('[data-testid="detail-pane"]')).toHaveAttribute("data-open", "true");
    await expect.poll(() => paneLeft(page)).toBeLessThan(2);
    await expect(page.locator('[data-testid="conversation-title"]')).toBeVisible();
    // The header back button (left of the person's name) is now available.
    await expect(page.locator('[data-testid="back-to-list"]')).toBeVisible();
  });

  test("the header back button returns to the conversation list", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    await page.locator('[data-testid="back-to-list"]').click();

    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => paneLeft(page)).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
    await expect(page.locator('[data-testid="back-to-list"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="conversation-row"]').first()).toBeVisible();
  });

  test("the composer stays fully within the viewport (bottom bar never hides it)", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const composer = page.locator('[data-testid="composer"]');
    await expect(composer).toBeVisible();
    const box = await composer.boundingBox();
    const height = page.viewportSize()!.height;
    expect(box).not.toBeNull();
    // The whole composer is above the bottom of the (dynamic) viewport.
    expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
  });

  test("message actions are reachable by tap on touch devices", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const firstMessage = page.locator('[data-testid="message"]').first();
    const actions = firstMessage.locator('[data-testid="message-actions"]');
    // On a coarse pointer the actions trigger is always shown (no hover needed).
    await expect(actions).toBeVisible();
    await actions.click();
    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-copy"]')).toBeVisible();
  });
});
