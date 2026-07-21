import { test, expect, gotoApp } from "./helpers";

test.describe("keyboard navigation", () => {
  test("arrow/j/k move the selection and Enter opens; Escape leaves", async ({ page }) => {
    await gotoApp(page);
    const rows = page.locator('[data-testid="conversation-row"]');

    // Default selection is the first row.
    await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");

    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");

    await page.keyboard.press("j");
    await expect(rows.nth(2)).toHaveAttribute("data-selected", "true");

    await page.keyboard.press("ArrowUp");
    await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");

    // Enter opens the selected conversation.
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="conversation-row"][data-open="true"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();

    // Escape leaves the conversation.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="conversation-row"][data-open="true"]')).toHaveCount(0);
  });
});
