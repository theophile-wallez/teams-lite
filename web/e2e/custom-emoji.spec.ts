import { test, expect, gotoApp, realErrors } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * Custom emoji: Slack-style emoji the user adds to this app, for this machine only.
 *
 * These specs pin the rules that are really promises:
 * - An inbound emoji is drawn from the message's OWN src, not a pack blob.
 * - A taken name is refused with Slack's own sentence.
 * - Delete asks twice and the confirming label is "Delete Emoji".
 *
 * Every test clears what it added. One mock process serves the whole run, so a pack left
 * behind would change every later spec's composer, picker and sidebar.
 */

const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "19457";

/** Clear all custom emoji through the mock's test hook. */
async function clearCustomEmoji(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "custom_emoji", clear: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** Open the first conversation via the sidebar. */
async function openFirstConversation(page: Page): Promise<string> {
  const row = page.locator('[data-testid="conversation-row"]').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const id = (await row.getAttribute("data-conversation-id")) ?? "";
  await row.click();
  const shell = page.locator('[data-testid="composer-shell"]');
  await expect(shell).toBeVisible();
  return id;
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

  test("an inbound custom emoji is drawn from the message's own src, not a pack blob", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openFirstConversation(page);

    // The mock seeds one inbound message with a custom emoji in its body, carrying
    // the src the server sent. That src must be what the rendered <img> shows, not
    // a blob URL from the pack — this is the rule that keeps this app from redrawing
    // a colleague's words with the reader's own picture.
    const inboundMessage = page
      .locator('[data-testid="message-body"]', {
        has: page.locator('img[alt=":shipit:"]'),
      })
      .first();
    await expect(inboundMessage).toBeVisible({ timeout: 10_000 });
    const img = inboundMessage.locator('img[alt=":shipit:"]');
    const src = await img.getAttribute("src");
    expect(src).toContain("https://eu-api.asm.skype.com");
    expect(src).not.toContain("blob:");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a taken name is refused with Slack's own sentence", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openFirstConversation(page);

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
    await page.waitForTimeout(200);

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
});
