import {
  test,
  expect,
  gotoApp,
  openConversationAt,
  emitReadReceipt,
  clearReadReceipts,
  realErrors,
} from "./helpers";

// Read receipts ("seen by") surface every OTHER member's read position as a small
// right-aligned avatar anchored below the last message they've read — mirroring
// Teams/Messenger. Driven here deterministically through the mock's gated hook,
// which broadcasts the backend's `read_receipt` event.
test.describe("read receipts", () => {
  // The mock is shared and stateful across the serial suite; wipe injected read
  // positions after each test so avatars never leak into another spec.
  test.afterEach(async ({ page }) => {
    await clearReadReceipts(page);
  });

  test("shows a reader's avatar below the newest message, named on hover", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);

    const row = page.locator('[data-testid="read-receipts"]');
    await expect(row).toHaveCount(0); // nothing seen yet

    // Riley reads the whole conversation (defaults anchor to the newest message).
    await emitReadReceipt(page, { conversation: conv, member: "Riley Carter", member_mri: "8:orgid:riley" });

    await expect(row).toBeVisible();
    const avatars = row.locator('[data-testid="read-receipt-avatar"]');
    await expect(avatars).toHaveCount(1);

    // Anchored at the bottom: the row sits below the last message bubble.
    const lastMsg = page.locator('[data-testid="message"]').last();
    const msgBox = await lastMsg.boundingBox();
    const rowBox = await row.boundingBox();
    expect(msgBox && rowBox).toBeTruthy();
    expect(rowBox!.y).toBeGreaterThan(msgBox!.y);

    // Hovering the avatar reveals who read it.
    await avatars.first().hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "Riley Carter" })).toBeVisible();

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("collapses several readers into a stack plus a +N overflow", async ({ page }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);

    // Six readers all caught up to the newest message — more than the stack shows.
    for (let i = 0; i < 6; i++) {
      await emitReadReceipt(page, {
        conversation: conv,
        member: `Reader ${i}`,
        member_mri: `8:orgid:reader-${i}`,
        read_time_ms: 1_000 + i, // deterministic order
      });
    }

    const row = page.locator('[data-testid="read-receipts"]');
    await expect(row).toBeVisible();
    // Four avatars shown, the rest folded into a "+2" chip.
    await expect(row.locator('[data-testid="read-receipt-avatar"]')).toHaveCount(4);
    await expect(row.getByTestId("read-receipts-more")).toHaveText("+2");
  });

  test("is scoped to the open conversation and clears on switching away", async ({ page }) => {
    await gotoApp(page);
    const first = await openConversationAt(page, 0);

    const secondRow = page.locator('[data-testid="conversation-row"]').nth(1);
    const second = await secondRow.getAttribute("data-conversation-id");
    expect(second).toBeTruthy();

    // Someone reads in a DIFFERENT conversation than the open one.
    await emitReadReceipt(page, { conversation: second!, member: "Riley Carter", member_mri: "8:orgid:riley" });
    await page.waitForTimeout(300);
    // The open pane stays quiet — receipts are single-conversation.
    await expect(page.locator('[data-testid="read-receipts"]')).toHaveCount(0);

    // Now a reader catches up in the OPEN conversation → the avatar appears.
    await emitReadReceipt(page, { conversation: first, member: "Jordan Lee", member_mri: "8:orgid:jordan" });
    await expect(page.locator('[data-testid="read-receipts"]')).toBeVisible();

    // Switching to the second conversation swaps in ITS receipts (Riley), and the
    // first conversation's avatars do not linger.
    await secondRow.click();
    await expect(page.locator('[data-testid="conversation-title"]')).not.toBeEmpty();
    const avatars = page.locator('[data-testid="read-receipt-avatar"]');
    await expect(avatars).toHaveCount(1);
    await avatars.first().hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "Riley Carter" })).toBeVisible();
  });
});
