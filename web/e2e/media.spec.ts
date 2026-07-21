import { test, expect, gotoApp, realErrors } from "./helpers";
import type { Page } from "@playwright/test";

/** Open a conversation by name via the command palette — robust to sidebar
 *  ordering and virtualization (the shared mock is mutated by other specs). */
async function openByPalette(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+k");
  const input = page.locator("[cmdk-input]");
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  await expect(page.locator('[data-testid="conversation-title"]')).toContainText(name);
}

test.describe("media (images + attachments)", () => {
  test("renders inline images and image attachments through the media proxy", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    // The Media Gallery has an inline pasted screenshot and an image shared as an
    // attachment — two images, both loaded as blob URLs via the backend proxy.
    const images = page.locator('[data-testid="message-image"]');
    await expect.poll(() => images.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect(images.first()).toBeVisible();
    // A local blob src proves the bytes were fetched through the backend media
    // proxy (the browser never loaded the authenticated hosted-content URL).
    await expect(images.first()).toHaveAttribute("src", /^blob:/);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("shows a shared file as a labeled chip", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const file = page.locator('[data-testid="message-file"]').first();
    await expect(file).toBeVisible();
    await expect(file).toContainText("quarterly-report.pdf");
  });
});
