import { test, expect, gotoApp, openConversationAt, emitReaction } from "./helpers";

test.describe("message reactions", () => {
  test("adds a reaction from the actions menu, then toggles it off", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // Send a fresh message of our own so we have a deterministic target.
    const original = `react-me-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(original);
    await composer.press("Enter");

    const bubble = page.locator('[data-testid="message"]', { hasText: original });
    await expect(bubble).toBeVisible();

    // Open the actions menu and pick an emoji from its reaction bar.
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await page
      .locator('[data-testid="menu-reaction-picker"] [data-testid="reaction-option-heart"]')
      .click();

    // A chip appears under the message: count 1, highlighted as ours.
    const chip = bubble.locator('[data-testid="reaction-chip-heart"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("1");
    await expect(chip).toHaveAttribute("data-mine", "true");

    // Clicking our own chip toggles the reaction off.
    await chip.click();
    await expect(bubble.locator('[data-testid="reaction-chip-heart"]')).toHaveCount(0);
  });

  test("reveals a hover reaction picker and reacts with it", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const original = `hover-react-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(original);
    await composer.press("Enter");

    const bubble = page.locator('[data-testid="message"]', { hasText: original });
    await expect(bubble).toBeVisible();

    // Hovering the bubble reveals the floating picker after a short dwell.
    await bubble.hover();
    const picker = page.locator('[data-testid="reaction-picker"]');
    await expect(picker).toBeVisible({ timeout: 5_000 });
    await picker.locator('[data-testid="reaction-option-like"]').click();

    const chip = bubble.locator('[data-testid="reaction-chip-like"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-mine", "true");
  });

  test("shows a reaction received on a message from someone else", async ({ page }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);

    // Target an existing message and inject a reaction from another person.
    const target = page.locator('[data-testid="message"]').first();
    const messageId = await target.getAttribute("data-message-id");
    expect(messageId).toBeTruthy();

    await emitReaction(page, {
      conversation: conv,
      message_id: messageId!,
      key: "laugh",
      count: 3,
      mine: false,
    });

    const chip = target.locator('[data-testid="reaction-chip-laugh"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("3");
    // Not ours, so the "mine" highlight attribute is absent.
    await expect(chip).not.toHaveAttribute("data-mine", "true");
  });
});
