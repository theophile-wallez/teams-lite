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

  test("opens an image in the lightbox and dismisses it with Escape", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const images = page.locator('[data-testid="message-image"]');
    await expect.poll(() => images.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await images.first().click();

    // The zoomed image shows the same proxied blob, over a modal backdrop.
    const lightbox = page.locator('[data-testid="image-lightbox"]');
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toHaveAttribute("role", "dialog");
    const zoomed = page.locator('[data-testid="lightbox-image"]');
    await expect(zoomed).toBeVisible();
    await expect(zoomed).toHaveAttribute("src", /^blob:/);

    // Escape closes the lightbox and must NOT also fall through to the app's
    // global handler (which would leave the conversation).
    await page.keyboard.press("Escape");
    await expect(lightbox).toHaveCount(0);
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText("Media Gallery");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("closes the lightbox via the close button and the backdrop", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const images = page.locator('[data-testid="message-image"]');
    await expect.poll(() => images.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    const lightbox = page.locator('[data-testid="image-lightbox"]');

    // Close button.
    await images.first().click();
    await expect(lightbox).toBeVisible();
    await page.getByRole("button", { name: "Close image preview" }).click();
    await expect(lightbox).toHaveCount(0);

    // Clicking the dimmed backdrop (the padding area, not the image) closes it.
    await images.first().click();
    await expect(lightbox).toBeVisible();
    await lightbox.click({ position: { x: 8, y: 8 } });
    await expect(lightbox).toHaveCount(0);
  });

  test("renders an image-only message without a bubble, mine and incoming alike", async ({
    page,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    // An image I sent with no text drops the bubble chrome and carries no name.
    const mine = page.locator('[data-testid="message"][data-image-only="true"][data-mine="true"]');
    await expect(mine).toHaveCount(1);
    await expect(mine.locator('[data-testid="message-image"]')).toHaveCount(1);
    await expect(mine.locator('[data-testid="sender-name"]')).toHaveCount(0);

    // An image someone else sent with no text also drops the bubble, but keeps
    // the sender name floating in the void above the picture.
    const incoming = page.locator(
      '[data-testid="message"][data-image-only="true"][data-mine="false"]',
    );
    await expect(incoming).toHaveCount(1);
    await expect(incoming.locator('[data-testid="message-image"]')).toHaveCount(1);
    await expect(incoming.locator('[data-testid="sender-name"]')).toBeVisible();
  });

  test("keeps the bubble for a message that mixes an image with text", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    // The inline screenshot arrives with a sentence around it, so it is NOT
    // image-only and keeps its bubble.
    const withText = page
      .locator('[data-testid="message"]', { hasText: "screenshot from the incident" })
      .first();
    await expect(withText.locator('[data-testid="message-image"]')).toHaveCount(1);
    await expect(withText).not.toHaveAttribute("data-image-only", "true");
  });
});
