import { devices, type Locator, type Page } from "@playwright/test";
import { test, expect, composerField, gotoApp, openConversationAt } from "./helpers";

// The mobile, single-pane layout. Emulate an Android Chrome phone (narrow
// viewport + touch, so the `md` breakpoint resolves to the mobile layout and
// coarse-pointer affordances turn on). Below `md` the conversation list is the
// home screen and a conversation covers it as a separate "page"; there is no
// persistent second column and no transition between the two pages.
test.use({ ...devices["Pixel 7"] });

/** The detail pane's left edge, used to tell whether it is on-screen (x≈0) or
 *  parked off the right edge (x≈viewport width). */
async function paneLeft(page: Page): Promise<number> {
  const box = await page.locator('[data-testid="detail-pane"]').boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
}

async function touchGesture(
  page: Page,
  target: Locator,
  moves: Array<{ x: number; y: number; delay?: number }> = [],
  holdMs = 0,
): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const dispatch = (type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number) =>
    target.dispatchEvent(type, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });

  await dispatch("pointerdown", start.x, start.y);
  if (holdMs) await page.waitForTimeout(holdMs);
  for (const move of moves) {
    await dispatch("pointermove", start.x + move.x, start.y + move.y);
    if (move.delay) await page.waitForTimeout(move.delay);
  }
  const end = moves.at(-1) ?? { x: 0, y: 0 };
  await dispatch("pointerup", start.x + end.x, start.y + end.y);
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

  test("tapping a conversation shows the chat over the list", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // The chat page is now the active pane, flush to the left edge.
    await expect(page.locator('[data-testid="detail-pane"]')).toHaveAttribute("data-open", "true");
    await expect.poll(() => paneLeft(page)).toBeLessThan(2);
    await expect(page.locator('[data-testid="conversation-title"]')).toBeVisible();
    // The header back button (left of the person's name) is now available.
    await expect(page.locator('[data-testid="back-to-list"]')).toBeVisible();
  });

  test("neither page animates: the switch has no transition", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // Both pages are plain: the detail pane arrives in place and the list stays put,
    // so nothing slides, drifts or lags behind the tap.
    for (const testId of ["detail-pane", "sidebar"]) {
      const duration = await page
        .locator(`[data-testid="${testId}"]`)
        .evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(duration).toBe("0s");
    }
    const listLeft = (await page.locator('[data-testid="sidebar"]').boundingBox())!.x;
    expect(Math.abs(listLeft)).toBeLessThan(2);
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

    const composer = composerField(page);
    await expect(composer).toBeVisible();
    const box = await composer.boundingBox();
    const height = page.viewportSize()!.height;
    expect(box).not.toBeNull();
    // The whole composer is above the bottom of the (dynamic) viewport.
    expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
  });

  test("a long press opens message actions without a permanent ellipsis", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const firstMessage = page.locator('[data-testid="message"]').first();
    await expect(firstMessage.locator('[data-testid="message-actions"]')).not.toBeVisible();

    await touchGesture(page, firstMessage, [], 550);

    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-copy"]')).toBeVisible();
  });

  test("a long press on a chat row opens its Teams settings menu", async ({ page }) => {
    await gotoApp(page);

    // The "…" belongs to a pointer, so a phone never shows it — the hold is the way in.
    const row = page.locator('[data-testid="conversation-row"]').first();
    await expect(page.locator('[data-testid="chat-menu"]').first()).not.toBeVisible();

    await touchGesture(page, row, [], 550);

    await expect(page.locator('[data-testid="chat-menu-pin"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-menu-mute"]')).toBeVisible();
    // The hold opened the menu and nothing else: the chat stayed shut.
    await expect(page.locator('[data-testid="detail-pane"]')).not.toHaveAttribute(
      "data-open",
      "true",
    );
  });

  test("a short tap on a chat row opens the chat, not its menu", async ({ page }) => {
    await gotoApp(page);

    await touchGesture(page, page.locator('[data-testid="conversation-row"]').first());

    await expect(page.locator('[data-testid="chat-menu-pin"]')).toHaveCount(0);
  });

  test("a short tap does not open message actions", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    await touchGesture(page, page.locator('[data-testid="message"]').first());

    await expect(page.locator('[data-testid="action-reply"]')).toHaveCount(0);
  });

  test("an incoming message swipes inward to reply", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const message = page.locator('[data-testid="message"][data-mine="false"]').first();
    await touchGesture(page, message, [{ x: 24, y: 1 }, { x: 70, y: 2 }]);

    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    await expect.poll(() => message.evaluate((element) => getComputedStyle(element).transform)).toBe(
      "none",
    );
  });

  test("a sent message swipes inward to reply", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const message = page.locator('[data-testid="message"][data-mine="true"]').first();
    await touchGesture(page, message, [{ x: -24, y: 1 }, { x: -70, y: 2 }]);

    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    await expect.poll(() => message.evaluate((element) => getComputedStyle(element).transform)).toBe(
      "none",
    );
  });

  test("vertical movement scrolls without starting a reply", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const message = page.locator('[data-testid="message"][data-mine="false"]').first();
    await touchGesture(page, message, [{ x: 2, y: -25 }, { x: 3, y: -70 }]);

    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });
});
