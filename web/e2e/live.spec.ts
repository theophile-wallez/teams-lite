import { test, expect, gotoApp, openConversationAt, emitLive } from "./helpers";

test.describe("live events", () => {
  test("an incoming message appears in the open conversation", async ({ page }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);

    const marker = `live-open-${Date.now()}`;
    await emitLive(page, { conversation: openId, content: marker, is_self: false });

    await expect(page.locator('[data-testid="message"]', { hasText: marker })).toBeVisible();
    await expect(
      page.locator('[data-testid="message"]', { hasText: marker }).first(),
    ).toHaveAttribute("data-mine", "false");
  });

  test("a message to another conversation reorders the sidebar and updates its preview", async ({
    page,
  }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);

    // Choose a different conversation than the one we're viewing.
    const rows = page.locator('[data-testid="conversation-row"]');
    let otherId = openId;
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const id = await rows.nth(i).getAttribute("data-conversation-id");
      if (id && id !== openId) {
        otherId = id;
        break;
      }
    }
    expect(otherId).not.toBe(openId);

    const marker = `live-other-${Date.now()}`;
    await emitLive(page, { conversation: otherId, content: marker, is_self: false });

    // That conversation now has the newest activity, so it sorts to the top and
    // its preview reflects the new message.
    const top = rows.first();
    await expect.poll(() => top.getAttribute("data-conversation-id")).toBe(otherId);
    await expect(top).toContainText(marker);
  });
});
