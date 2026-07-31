import { test, expect, fetchCapturedSends, gotoApp, openConversationAt, setSendControl } from "./helpers";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");
const IMAGE_INPUT = '[data-testid="composer-image-input"]';
const IMAGE_PREVIEW = '[data-testid="composer-image-preview"]';

async function selectImage(page: import("@playwright/test").Page, name = "pixel.png") {
  await page.locator(IMAGE_INPUT).setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(page.locator(IMAGE_PREVIEW)).toBeVisible();
}

async function openComposer(page: import("@playwright/test").Page) {
  await gotoApp(page);
  await openConversationAt(page, 0);
  await setSendControl(page, { clear: true });
}

test.describe("composer images", () => {
  test.afterEach(async ({ page }) => {
    await setSendControl(page, { clear: true });
  });

  test("selects an image and removes its preview", async ({ page }) => {
    await openComposer(page);
    await selectImage(page);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveAttribute("alt", "pixel.png");

    await page.locator('[data-testid="composer-image-remove"]').click();
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-send"]')).toBeDisabled();
  });

  test("accepts an image pasted from the clipboard", async ({ page }) => {
    await openComposer(page);
    await page.locator('[data-testid="composer"]').evaluate((element, base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const file = new File([bytes], "pasted.png", { type: "image/png" });
      const clipboard = new DataTransfer();
      clipboard.items.add(file);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    }, PNG_BASE64);

    await expect(page.locator(IMAGE_PREVIEW)).toBeVisible();
    await expect(page.locator(IMAGE_PREVIEW)).toHaveAttribute("alt", "pasted.png");
  });

  test("sends an image without text and renders the AMS image echo", async ({ page }) => {
    await openComposer(page);
    const before = await page.locator('[data-testid="message"]').count();
    await selectImage(page, "image-only.png");
    await page.locator('[data-testid="composer-send"]').click();

    await expect(page.locator('[data-testid="message"]')).toHaveCount(before + 1);
    const message = page.locator('[data-testid="message"]').last();
    await expect(message).toHaveAttribute("data-mine", "true");
    await expect(message.locator('[data-testid="message-image"]')).toBeVisible();

    const sends = await fetchCapturedSends(page);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe("");
    expect(sends[0]?.image).toEqual({
      name: "image-only.png",
      content_type: "image/png",
      data_base64: PNG_BASE64,
    });
  });

  test("sends a caption with the image", async ({ page }) => {
    await openComposer(page);
    await selectImage(page, "captioned.png");
    await page.locator('[data-testid="composer"]').fill("A small caption");
    await page.locator('[data-testid="composer-send"]').click();

    const message = page.locator('[data-testid="message"]', { hasText: "A small caption" }).last();
    await expect(message).toBeVisible();
    await expect(message.locator('[data-testid="message-image"]')).toBeVisible();
    const sends = await fetchCapturedSends(page);
    expect(sends[0]?.text).toBe("A small caption");
    expect(sends[0]?.image?.name).toBe("captioned.png");
  });

  test("supports an image in rich mode", async ({ page }) => {
    await openComposer(page);
    await page.locator('[data-testid="composer-format-toggle"]').click();
    await expect(page.locator('[data-testid="composer-rich"]')).toBeVisible();
    await selectImage(page, "rich.png");
    await page.locator('[data-testid="composer-rich"] .tiptap-message').fill("Rich caption");
    await page.locator('[data-testid="composer-send"]').click();

    await expect(
      page.locator('[data-testid="message"]', { hasText: "Rich caption" }).last(),
    ).toBeVisible();
    const sends = await fetchCapturedSends(page);
    expect(sends[0]?.content_html).toContain("Rich caption");
    expect(sends[0]?.image?.name).toBe("rich.png");
  });

  test("rejects unsupported files and oversized images", async ({ page }) => {
    await openComposer(page);
    await page.locator(IMAGE_INPUT).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not an image"),
    });
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
    await expect(page.locator('[data-testid="status-bar"]')).toContainText(/image/i);

    await page.locator(IMAGE_INPUT).setInputFiles({
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(11 * 1024 * 1024),
    });
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
    await expect(page.locator('[data-testid="status-bar"]')).toContainText(/large|size/i);
    expect(await fetchCapturedSends(page)).toHaveLength(0);
  });

  test("does not submit the same image twice while send is pending", async ({ page }) => {
    await openComposer(page);
    await setSendControl(page, { delay_ms: 500, clear: true });
    await selectImage(page, "one-request.png");
    const send = page.locator('[data-testid="composer-send"]');
    await send.click();
    await send.click({ force: true });

    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBe(1);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
  });

  test("keeps the image and caption when send fails", async ({ page }) => {
    await openComposer(page);
    await setSendControl(page, { error: "mock image send failed", clear: true });
    await selectImage(page, "retry.png");
    const composer = page.locator('[data-testid="composer"]');
    await composer.fill("Keep this caption");
    await page.locator('[data-testid="composer-send"]').click();

    await expect(page.locator('[data-testid="status-bar"]')).toContainText("mock image send failed");
    await expect(page.locator(IMAGE_PREVIEW)).toBeVisible();
    await expect(composer).toHaveValue("Keep this caption");
    expect(await fetchCapturedSends(page)).toHaveLength(1);
  });
});
