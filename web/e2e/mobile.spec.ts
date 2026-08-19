import { devices, type Locator, type Page } from "@playwright/test";
import {
  test,
  expect,
  clearScheduledMessages,
  composerField,
  emitUpdate,
  fillComposer,
  gotoApp,
  openConversationAt,
  openConversationNamed,
  resetCall,
  setSendControl,
} from "./helpers";

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

  // What the update brings is disclosed on HOVER, which a phone does not have — and this
  // app is used from one. So the hold is the way in here too, and a tap stays the update
  // itself: the same split the chat row above makes.
  test("a long press on the update button discloses what it brings", async ({ page }) => {
    await gotoApp(page);
    await emitUpdate(page, { latest: "def5678" });
    const button = page.getByTestId("update-button");
    await expect(button).toBeVisible();
    const panel = page.getByTestId("update-changes");

    await touchGesture(page, button, [], 550);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("never let a sender's own words name a file on disk");
    // The hold opened the panel and nothing else: 130 MB did not start downloading.
    await expect(page.locator('[data-testid="update-control"]')).toHaveAttribute(
      "data-phase",
      "idle",
    );

    await emitUpdate(page, { available: false });
  });

  test("a short tap on the update button is the update, not the disclosure", async ({ page }) => {
    await gotoApp(page);
    await emitUpdate(page, { latest: "def5678" });
    const button = page.getByTestId("update-button");
    await expect(button).toBeVisible();

    // A real tap, not a dispatched pointer pair: the point of this one is that the CLICK
    // still happens, and only the browser's own touch handling produces it.
    await button.tap();
    await expect(page.getByTestId("update-changes")).toHaveCount(0);
    await expect(page.locator('[data-testid="update-control"]')).not.toHaveAttribute(
      "data-phase",
      "idle",
    );

    await emitUpdate(page, { available: false });
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

  /**
   * A CALL folded away on a phone has to leave the phone usable, which is the whole reason
   * folding exists. The window is a share of a narrow viewport rather than its own desktop
   * width — 320px over 412px is not a call folded away, it is the app with a hole punched in
   * it (`miniSize` in web/src/lib/call-stage.ts).
   */
  test("a folded call leaves most of a phone's screen to the conversation", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Design Sync");
    await page.locator('[data-testid="meeting-join-here"]').click();
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });

    // Full first: on a phone the call takes the whole screen, exactly as it does anywhere.
    const viewport = page.viewportSize()!;
    const full = (await stage.boundingBox())!;
    expect(Math.round(full.width)).toBe(viewport.width);

    await page.locator('[data-testid="call-stage-minimize"]').click();
    await expect(stage).toHaveAttribute("data-mode", "mini");
    // The morph is one animated element, so the geometry is read once it has settled.
    await page.waitForTimeout(700);
    const mini = (await stage.boundingBox())!;
    expect(mini.width).toBeLessThan(viewport.width * 0.65);
    expect(mini.x + mini.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(mini.y + mini.height).toBeLessThanOrEqual(viewport.height - 8);

    await resetCall(page);
  });

  /**
   * The hold that opens the actions menu is the app's, so the BROWSER's own long-press
   * gestures are given up here: Android selects the word under the finger and raises its
   * magnifier, iOS raises the selection callout — and the reader who held a bubble to react
   * got that instead of the reaction row. Copying is not lost: it is a row in the menu the
   * hold opens. Asserted on the computed style, because a synthetic pointer event never
   * starts a real browser selection and so can never see this. `-webkit-touch-callout` rides
   * beside it in app.css and is deliberately not asserted: desktop Chromium does not
   * implement the property, so it computes to "" here whatever the stylesheet says — iOS is
   * the only place it means anything.
   */
  test("a message gives up the browser's own long-press gestures", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const select = await page
      .locator('[data-testid="message"]')
      .first()
      .evaluate((element) => getComputedStyle(element).userSelect);

    expect(select).toBe("none");
  });

  /**
   * A dialog's close is 16px of ink, which under a thumb is a control the reader cannot hit —
   * it was reported on the scheduled-messages list, and the fix is the shared `DialogContent`,
   * so every dialog in the app carries it. The target is a pseudo-element, which no bounding
   * box reports, so what is measured is the thing the reader does: a tap short of the ink,
   * INSIDE the dialog, still closes it. Inside on both axes on purpose — a point outside the
   * dialog would be dismissed by the overlay and prove nothing.
   */
  test("a dialog's close carries a thumb-sized target", async ({ page }) => {
    await clearScheduledMessages(page);
    await gotoApp(page);
    await openConversationAt(page, 0);
    await setSendControl(page, { clear: true });
    await fillComposer(page, "the standup note");
    await page.locator('[data-testid="composer-schedule"]').click();
    await page.locator('[data-testid="composer-schedule-preset"]').first().click();
    await page.locator('[data-testid="composer-schedule-open-list"]').click();

    const dialog = page.locator('[data-testid="scheduled-messages-dialog"]');
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole("button", { name: "Close" });
    const ink = (await close.boundingBox())!;
    // A pointer 10px down-left of the ink: well outside the 16px glyph, and inside the 14px
    // the target reaches rather than exactly on its edge — a boundary pixel is decided by the
    // dialog's own fractional width, so 14 here passed or failed by luck of rounding.
    const x = ink.x - 10;
    const y = ink.y + ink.height + 10;
    const hit = await page.evaluate(
      (at) => document.elementFromPoint(at.x, at.y)?.closest("button")?.textContent ?? "",
      { x, y },
    );
    expect(hit).toBe("Close");

    await page.touchscreen.tap(x, y);
    await expect(dialog).toBeHidden();

    await setSendControl(page, { clear: true });
    await clearScheduledMessages(page);
  });
});
