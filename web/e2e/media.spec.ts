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
    const thumb = images.first();
    // The zoom library ignores the click until the picture has decoded, so wait
    // for it to actually load before clicking.
    await expect(thumb).toBeVisible();
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await thumb.click();

    // react-medium-image-zoom opens a native <dialog> portaled to <body>, so the
    // enlarged picture renders in the top layer, above the messages. Only the
    // clicked image's dialog carries the `open` attribute.
    const lightbox = page.locator("dialog[data-rmiz-modal][open]");
    await expect(lightbox).toBeVisible();
    await expect(lightbox).toHaveAttribute("role", "dialog");
    // The zoomed image shows the same proxied blob as the thumbnail.
    const zoomed = lightbox.locator("img[data-rmiz-modal-img]");
    await expect(zoomed).toBeVisible();
    await expect(zoomed).toHaveAttribute("src", /^blob:/);

    // Escape closes the lightbox and must NOT also fall through to the app's
    // global handler (which would leave the conversation). The library catches
    // Escape in the capture phase and stops propagation, so we stay put.
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
    const thumb = images.first();
    await expect(thumb).toBeVisible();
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    const lightbox = page.locator("dialog[data-rmiz-modal][open]");

    // Close button (the library's unzoom control, named via a11yNameButtonUnzoom).
    await thumb.click();
    await expect(lightbox).toBeVisible();
    await lightbox.getByRole("button", { name: "Close image preview" }).click();
    await expect(lightbox).toHaveCount(0);

    // Clicking the dimmed area around the picture (the modal content, not the
    // image itself) closes it.
    await thumb.click();
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

  test("frames an image-only message with an even mat on all four sides", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    // Two image-only messages: one from an attachment, one from an inline
    // <p><img></p> (how Teams delivers a pasted screenshot). Both must show the
    // same few px of hatch on every side — the media's in-bubble vertical margins
    // are neutralized inside the mat no matter how deep the picture sits.
    const mats = page.locator('[data-testid="image-mat"]');
    await expect.poll(() => mats.count(), { timeout: 10_000 }).toBe(2);

    for (let i = 0; i < 2; i++) {
      const mat = mats.nth(i);
      const image = mat.locator('[data-testid="message-image"]');
      await expect(image).toBeVisible();
      const gaps = await mat.evaluate((el) => {
        const img = el.querySelector("img")!;
        const outer = el.getBoundingClientRect();
        const inner = img.getBoundingClientRect();
        const round = (n: number) => Math.round(n * 100) / 100;
        return {
          top: round(inner.top - outer.top),
          right: round(outer.right - inner.right),
          bottom: round(outer.bottom - inner.bottom),
          left: round(inner.left - outer.left),
        };
      });
      expect(gaps.top).toBeCloseTo(gaps.left, 1);
      expect(gaps.bottom).toBeCloseTo(gaps.left, 1);
      expect(gaps.right).toBeCloseTo(gaps.left, 1);
      expect(gaps.left).toBeGreaterThan(0);
    }
  });

  test("renders a meeting recording as a video card without a bubble", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const rec = page.locator('[data-testid="message-recording"]');
    await expect(rec).toHaveCount(1);
    await expect(rec).toBeVisible();

    // The recording drops the bubble chrome (recording-only) and, since the
    // backend clears the recording's sender, shows no name floating above it.
    const msg = page.locator('[data-testid="message"][data-recording-only="true"]');
    await expect(msg).toHaveCount(1);
    await expect(msg).toHaveAttribute("data-mine", "false");
    await expect(msg.locator('[data-testid="sender-name"]')).toHaveCount(0);

    // The card is captioned with the recording title and badged with its length.
    await expect(rec).toContainText("Keynote #3 du Lab Eng X Gen AI");
    await expect(rec).toContainText("1 h 08 min");

    // The poster is authenticated hosted content, fetched through the media proxy
    // (a local blob src), the same path an image attachment takes.
    const poster = rec.locator("img");
    await expect(poster).toBeVisible();
    await expect(poster).toHaveAttribute("src", /^blob:/);

    // Clicking opens the recording's SharePoint player page in a new tab — we
    // stub window.open to capture the exact target without a real navigation.
    await page.evaluate(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((url: string) => {
        (window as unknown as { __opened: string[] }).__opened.push(String(url));
        return null;
      }) as typeof window.open;
    });
    await rec.click();
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened).toEqual([
      "https://siapartners1-my.sharepoint.com/:v:/g/personal/demo/IQCmMockRecording",
    ]);
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
