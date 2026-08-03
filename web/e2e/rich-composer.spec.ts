import { test, expect, fetchCapturedSends, gotoApp, openConversationAt } from "./helpers";

// The composer defaults to the rich-text editor (TipTap). The shared `helpers`
// fixture opts every test out to the plain textarea; this suite clears that key
// before navigating so it exercises the real default: no stored preference →
// rich. Formatting has no permanent toolbar — it is keyboard-driven plus a
// select-to-format menu, exactly the workflow of "select text, Ctrl+B, bold".
test.describe("rich composer (default)", () => {
  test.beforeEach(async ({ page }) => {
    // Runs after the auto fixture set "0", so this removal wins → default rich.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("teams-composer-rich");
      } catch {
        /* ignore */
      }
    });
  });

  const editable = '[data-testid="composer-rich"] .tiptap-message';

  test("defaults to the rich editor, not the plain textarea", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await expect(page.locator('[data-testid="composer-rich"]')).toBeVisible();
    await expect(page.locator('[data-testid="composer"]')).toHaveCount(0);
    // No permanent formatting toolbar is rendered until text is selected.
    await expect(page.locator('[data-testid="composer-format-toggle"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("types and sends a message with Enter", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const marker = `rich-${Date.now()}`;
    await page.locator(editable).click();
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");
    const echoed = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(echoed).toBeVisible();
    await expect(echoed.first()).toHaveAttribute("data-mine", "true");
    // The editor is cleared after sending.
    await expect(page.locator(editable)).toHaveText("");
  });

  test("trims the blank lines off the body it sends", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const marker = `trim-${Date.now()}`;
    await page.locator(editable).click();
    // A Shift+Enter on the last line leaves a hard break, and Enter sends. The
    // reader must get the words, not the empty line under them.
    await page.keyboard.type(marker);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="message"]', { hasText: marker })).toBeVisible();
    const sends = await fetchCapturedSends(page);
    const sent = sends.filter((send) => send.content_html?.includes(marker)).pop();
    expect(sent?.content_html).toBe(`<p>${marker}</p>`);
  });

  test("Ctrl+B bolds the selection without any visible toolbar", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.locator(editable).click();
    await page.keyboard.type("bold me");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+b");
    // The selection is wrapped in <strong>, so the sent HTML carries the bold.
    await expect(page.locator(`${editable} strong`)).toHaveText("bold me");
  });

  test("toggling to plain keeps the typed text (no wiped message)", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.locator(editable).click();
    await page.keyboard.type("keep me");
    // Switch to the plain textarea — the draft carries over instead of vanishing.
    await page.locator('[data-testid="composer-format-toggle"]').click();
    await expect(page.locator('[data-testid="composer"]')).toHaveValue("keep me");
  });
});
