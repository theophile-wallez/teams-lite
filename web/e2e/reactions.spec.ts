import { test, expect, gotoApp, openConversationAt, emitReaction } from "./helpers";

test.describe("message reactions", () => {
  test("adds from the menu, highlights the active reaction, and toggles it off there", async ({
    page,
  }) => {
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

    // Reacting closes the menu. Wait for it to fully dismiss before reopening —
    // clicking the trigger while the close animation is still running races with
    // Radix's toggle and can leave the menu shut (a real user is never that fast).
    await expect(page.locator('[data-testid="menu-reaction-picker"]')).toHaveCount(0);

    // Reopening the menu now marks our reaction as active (highlighted).
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    const activeOption = page.locator(
      '[data-testid="menu-reaction-picker"] [data-testid="reaction-option-heart"]',
    );
    await expect(activeOption).toHaveAttribute("data-active", "true");

    // Clicking the active reaction again removes it (toggle off from the menu).
    await activeOption.click();
    await expect(bubble.locator('[data-testid="reaction-chip-heart"]')).toHaveCount(0);
  });

  test("reacts from the menu, then removes via the chip", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const original = `chip-react-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(original);
    await composer.press("Enter");

    const bubble = page.locator('[data-testid="message"]', { hasText: original });
    await expect(bubble).toBeVisible();

    // The ⋯ menu is the only reaction surface: nothing appears on hover alone.
    await bubble.hover();
    await expect(page.locator('[data-testid="menu-reaction-picker"]')).toHaveCount(0);
    await bubble.locator('[data-testid="message-actions"]').click();
    await page
      .locator('[data-testid="menu-reaction-picker"] [data-testid="reaction-option-like"]')
      .click();

    const chip = bubble.locator('[data-testid="reaction-chip-like"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-mine", "true");

    // Clicking our own chip removes the reaction.
    await chip.click();
    await expect(bubble.locator('[data-testid="reaction-chip-like"]')).toHaveCount(0);
  });

  test("reacts with any Teams emoji from the full picker, served locally", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const original = `emoji-picker-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(original);
    await composer.press("Enter");

    const bubble = page.locator('[data-testid="message"]', { hasText: original });
    await expect(bubble).toBeVisible();

    // Every emoji image must come from our own origin — and actually be served
    // there. The Apple set is synced into public/emoji at install time precisely
    // so the app never depends on a CDN (see scripts/sync-emoji-assets.ts), which
    // only holds if the build ships those files too.
    const external: string[] = [];
    const missing: string[] = [];
    page.on("request", (r) => {
      if (/jsdelivr|unpkg|emoji-datasource/i.test(r.url())) external.push(r.url());
    });
    page.on("response", (r) => {
      if (r.url().includes("/emoji/apple/") && !r.ok()) missing.push(`${r.status()} ${r.url()}`);
    });

    // The menu's quick row offers six reactions; the rest are behind "More
    // reactions".
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="menu-reaction-picker"] [data-testid="reaction-more"]').click();

    // Search narrows to one emoji, Enter picks it — emoji-mart lives in a shadow
    // root, so drive it the way a user does rather than by internal markup.
    const picker = page.locator('[data-testid="emoji-picker"]');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    const search = picker.locator('input[type="search"]');
    await search.fill("fire");
    await search.press("Enter");

    // 🔥 is `fire` in Microsoft's reaction catalog — the key that reaches Teams.
    const chip = bubble.locator('[data-testid="reaction-chip-fire"]');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-mine", "true");
    await expect(chip.locator("img")).toHaveAttribute("src", "/emoji/apple/64/1f525.png");
    // Picking closes the picker.
    await expect(picker).toHaveCount(0);
    expect(external).toEqual([]);
    expect(missing).toEqual([]);

    // The menu closes behind the picker it hands off to, and Escape dismisses the
    // picker without reacting.
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="menu-reaction-picker"] [data-testid="reaction-more"]').click();
    await expect(picker).toBeVisible();
    await expect(page.locator('[data-testid="menu-reaction-picker"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
  });

  test("renders an extended reaction key received from Teams", async ({ page }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);

    const target = page.locator('[data-testid="message"]').first();
    const messageId = await target.getAttribute("data-message-id");

    // Real tenants send far more than the six classic keys: Teams' own animated
    // names (`rofl`) and its `<code points>_<name>` form for plain Unicode.
    await emitReaction(page, {
      conversation: conv,
      message_id: messageId!,
      key: "1f389_partypopper",
      count: 2,
      mine: false,
    });

    const chip = target.locator('[data-testid="reaction-chip-1f389_partypopper"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("2");
    // 🎉, not the neutral 👍 fallback.
    await expect(chip.locator("img")).toHaveAttribute("src", "/emoji/apple/64/1f389.png");
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
