import {
  test,
  expect,
  gotoApp,
  openConversationAt,
  emitTyping,
  realErrors,
} from "./helpers";

// The typing indicator surfaces the backend's live `typing` presence (decoded
// from Teams `Control/Typing` frames) just above the composer. Driven here
// deterministically through the mock's gated test hook.
test.describe("typing indicator", () => {
  test("appears with the typist's name and clears on stop", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);
    const indicator = page.locator('[data-testid="typing-indicator"]');
    await expect(indicator).toHaveCount(0);

    await emitTyping(page, { conversation: conv, sender: "Riley Carter", sender_mri: "8:orgid:riley" });
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText("Riley is typing");

    await emitTyping(page, {
      conversation: conv,
      sender: "Riley Carter",
      sender_mri: "8:orgid:riley",
      is_typing: false,
    });
    await expect(indicator).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("coalesces multiple typists into one hint", async ({ page }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);
    const indicator = page.locator('[data-testid="typing-indicator"]');

    await emitTyping(page, { conversation: conv, sender: "Riley Carter", sender_mri: "8:orgid:riley" });
    await emitTyping(page, { conversation: conv, sender: "Jordan Lee", sender_mri: "8:orgid:jordan" });

    await expect(indicator).toContainText("Riley and Jordan are typing");
  });

  test("does not leak a typing hint from another conversation", async ({ page }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);
    const indicator = page.locator('[data-testid="typing-indicator"]');

    // Someone types in a DIFFERENT conversation than the open one.
    await emitTyping(page, {
      conversation: `${openId}-other`,
      sender: "Riley Carter",
      sender_mri: "8:orgid:riley",
    });
    // Give the event time to arrive; the open pane must stay quiet.
    await page.waitForTimeout(300);
    await expect(indicator).toHaveCount(0);
  });
});
