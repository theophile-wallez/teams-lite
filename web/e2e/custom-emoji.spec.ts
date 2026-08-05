import { test, expect, gotoApp, realErrors } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * Custom emoji: Slack-style emoji the user adds to this app, for this machine only.
 *
 * These specs pin the eight rules that are really promises:
 * 1. A code the pack holds becomes art in a sent message; a code it does not hold stays text.
 * 2. An inbound emoji is drawn from the message's OWN src, not a pack blob.
 * 3. A code inside a code block and a code inside a reply quote stay text.
 * 4. An emoji-only message renders jumbo.
 * 5. The `:` list offers custom emoji above Unicode ones, and Enter inserts the chip.
 * 6. A taken name is refused with Slack's own sentence.
 * 7. Delete asks twice and the confirming label is "Delete Emoji".
 * 8. One Backspace removes a whole chip.
 *
 * Every test clears what it added. One mock process serves the whole run, so a pack left
 * behind would change every later spec's composer, picker and sidebar.
 */

const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "19457";
const editable = '[data-testid="composer-rich"] .tiptap-message';
const AGENT_SANDBOX = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/** Clear all custom emoji through the mock's test hook. */
async function clearCustomEmoji(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "custom_emoji", clear: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** Open a conversation by id via the command palette. */
async function openConversationById(page: Page, id: string): Promise<void> {
  await page.keyboard.press("Control+k");
  const input = page.locator("[cmdk-input]");
  await expect(input).toBeVisible();
  await input.fill(id);
  await input.press("Enter");
  await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  const shell = page.locator('[data-testid="composer-shell"]');
  await expect(shell).toBeVisible();
}

/** Open Settings. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="open-settings"]').click();
  await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();
}

/** Add a custom emoji through the mock's add RPC. */
async function addCustomEmoji(page: Page, name: string, data?: string): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: {
      kind: "custom_emoji_add",
      name,
      source: "test",
      data_base64:
        data ??
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("custom emoji", () => {
  test.afterEach(async ({ page }) => {
    await clearCustomEmoji(page);
  });

  test("a code the pack holds becomes art; a code it does not hold stays text", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    // The mock seeds :shipit:, so that code becomes an image.
    await openConversationById(page, AGENT_SANDBOX);
    await page.locator(editable).click();
    await page.keyboard.type("got it :shipit:");
    await page.keyboard.press("Enter");

    await page.locator('[data-testid="message-body"]:has-text("got it")').last().waitFor();
    const sentMessage = page.locator('[data-testid="message-body"]:has-text("got it")').last();
    await expect(sentMessage.locator('img[alt=":shipit:"]')).toBeVisible({ timeout: 5_000 });

    // A code the pack does not hold stays plain text.
    await page.locator(editable).click();
    await page.keyboard.type(":notanemoji:");
    await page.keyboard.press("Enter");

    await page.locator('[data-testid="message-body"]:has-text("notanemoji")').last().waitFor();
    const plainMessage = page.locator('[data-testid="message-body"]:has-text("notanemoji")').last();
    await expect(plainMessage).toContainText(":notanemoji:");
    await expect(plainMessage.locator('img[alt=":notanemoji:"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an inbound custom emoji is drawn from the message's own src, not a pack blob", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    // The Agent Sandbox conversation has an inbound message with custom emoji.
    await openConversationById(page, AGENT_SANDBOX);

    const inboundMessage = page
      .locator('[data-testid="message-body"]', {
        has: page.locator('img[alt=":shipit:"]'),
      })
      .first();
    await expect(inboundMessage).toBeVisible({ timeout: 10_000 });
    const img = inboundMessage.locator('img[alt=":shipit:"]');
    const src = await img.getAttribute("src");
    // The src must be from Teams (the message's own src), not a blob URL from our pack.
    expect(src).toContain("https://eu-api.asm.skype.com");
    expect(src).not.toContain("blob:");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a code inside a code block and inside a reply quote stay text", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openConversationById(page, AGENT_SANDBOX);

    // A code block: ```\n:shipit:\n```
    await page.locator(editable).click();
    await page.keyboard.type("```");
    await page.keyboard.press("Enter");
    await page.keyboard.type(":shipit:");
    await page.keyboard.press("Enter");
    await page.keyboard.type("```");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    const messages = page.locator("[data-message-id]");
    const count = await messages.count();
    const codeBlockMessage = messages.nth(count - 1);
    await expect(codeBlockMessage.locator("pre code")).toContainText(":shipit:");
    await expect(codeBlockMessage.locator('img[alt=":shipit:"]')).toHaveCount(0);

    // A reply quote. Send a message with :shipit:, then reply to it.
    await page.locator(editable).click();
    await page.keyboard.type(":shipit:");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const count2 = await messages.count();
    const shipitMessage = messages.nth(count2 - 1);
    await shipitMessage.hover();
    const actions = shipitMessage.locator('[data-testid="message-actions"]');
    await actions.click();
    await page.locator('[data-testid="action-reply"]').click();
    await page.waitForTimeout(300);
    await page.keyboard.type("replying to that");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    const count3 = await messages.count();
    const replyMessage = messages.nth(count3 - 1);
    const quote = replyMessage.locator('[data-testid="message-quote"]');
    await expect(quote).toBeVisible();
    // The quote should contain :shipit: as text, not as an image.
    await expect(quote).toContainText(":shipit:");
    await expect(quote.locator('img[alt=":shipit:"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an emoji-only message renders jumbo", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openConversationById(page, AGENT_SANDBOX);

    // Send a message that is ONLY :shipit:
    await page.locator(editable).click();
    await page.keyboard.type(":shipit:");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    const messages = page.locator("[data-message-id]");
    const count = await messages.count();
    const emojiOnlyMessage = messages.nth(count - 1);
    const img = emojiOnlyMessage.locator('img[alt=":shipit:"]');
    await expect(img).toBeVisible();

    // Check that it has jumbo size. The implementation passes jumbo prop to CustomEmoji.
    const body = emojiOnlyMessage.locator('[data-testid="message-body"]');
    const size = await body.getAttribute("data-emoji-size");
    expect(size).toBe("jumbo");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("the : list offers custom emoji above Unicode ones, and Enter inserts the chip", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openConversationById(page, AGENT_SANDBOX);

    // Type `:ship` to trigger the suggestion list. The mock has :shipit: and :ship:
    // (alias), and Unicode has :ship: too. Custom emoji should appear above Unicode.
    await page.locator(editable).click();
    await page.keyboard.type(":ship");
    await page.waitForSelector('[data-testid="emoji-suggestions"]', { timeout: 5_000 });

    const suggestions = page.locator('[data-testid^="emoji-suggestion-"]');
    const count = await suggestions.count();
    expect(count).toBeGreaterThan(0);

    // The first suggestion should be a custom emoji (shipit or ship).
    const firstSuggestion = suggestions.first();
    const firstText = await firstSuggestion.textContent();
    expect(firstText).toMatch(/ship/i);

    // Press Enter to insert the chip.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    // The composer should now contain a chip.
    const chip = page.locator('[data-testid="composer-rich"] .custom-emoji-chip');
    await expect(chip).toBeVisible();

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a taken name is refused with Slack's own sentence", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openConversationById(page, AGENT_SANDBOX);

    // Open the Add Emoji dialog via the reaction picker path.
    const messages = page.locator("[data-message-id]");
    await expect(messages.first()).toBeVisible({ timeout: 10_000 });
    const firstMessage = messages.first();
    await firstMessage.hover();
    await firstMessage.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-react"]').click();
    await page.waitForSelector('[data-testid="emoji-picker"]');
    await page.locator('[data-testid="add-emoji"]').click();
    await page.waitForSelector('[data-testid="add-emoji-dialog"]');

    // Fill in the name field with a name that already exists (e.g., "shipit").
    await page.locator('[data-testid="add-emoji-name"]').fill("shipit");

    // Set a file.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "test.png",
      mimeType: "image/png",
      buffer: png,
    });

    // Try to save.
    await page.locator('[data-testid="add-emoji-save"]').click();
    await page.waitForTimeout(500);

    // Check for the error message.
    const error = page.locator('[data-testid="add-emoji-error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText("If your emoji name is taken, choose another.");

    // Close the dialog.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("delete asks twice and the confirming label is Delete Emoji", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);

    // Add a custom emoji first.
    await addCustomEmoji(page, "testdelete");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="conversation-row"]');

    // Open Settings › Custom emoji.
    await openSettings(page);
    const section = '[data-testid="custom-emoji-settings"]';
    await page.locator(section).scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="custom-emoji-row-testdelete"]')).toBeVisible({
      timeout: 10_000,
    });

    // Click the delete button.
    await page.locator('[data-testid="custom-emoji-delete-testdelete"]').click();
    await page.waitForTimeout(300);

    // The first click should arm the confirmation. Look for the confirm button.
    const confirmButton = page.locator('[data-testid="custom-emoji-confirm-delete"]');
    await expect(confirmButton).toBeVisible();
    const confirmText = await confirmButton.textContent();
    expect(confirmText).toContain("Delete Emoji");

    // Click the confirmation button.
    await confirmButton.click();
    await page.waitForTimeout(500);

    // The emoji should be gone.
    await expect(page.locator('[data-testid="custom-emoji-row-testdelete"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("one Backspace removes a whole chip", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openConversationById(page, AGENT_SANDBOX);

    // Type `:shipit` to insert a chip.
    await page.locator(editable).click();
    await page.keyboard.type(":shipit");
    await page.waitForSelector('[data-testid="emoji-suggestions"]', { timeout: 5_000 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    // The chip should be visible.
    const chip = page.locator('[data-testid="composer-rich"] .custom-emoji-chip');
    await expect(chip).toBeVisible();

    // Press Backspace once.
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);

    // The chip should be gone entirely.
    await expect(chip).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
