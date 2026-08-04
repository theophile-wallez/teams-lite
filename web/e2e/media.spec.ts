import { test, expect, gotoApp, realErrors, setMediaDelay } from "./helpers";
import type { Locator, Page } from "@playwright/test";

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

/** The first chat image of the open conversation, once its bytes have decoded —
 *  the lightbox measures the thumbnail to fly the picture out of it. */
async function loadedThumb(page: Page) {
  const images = page.locator('[data-testid="message-image"]');
  await expect.poll(() => images.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const thumb = images.first();
  await expect(thumb).toBeVisible();
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  return thumb;
}

/** The picture's box once it has stopped moving. The lightbox flies the picture
 *  out of its thumbnail over 300 ms, so a box measured on the frame the dialog
 *  opens is a box in mid-flight. */
async function settledBox(picture: Locator): Promise<{ width: number; height: number }> {
  let last = { width: -1, height: -1 };
  await expect
    .poll(async () => {
      const box = (await picture.boundingBox())!;
      const stable = Math.abs(box.width - last.width) < 0.5;
      last = { width: box.width, height: box.height };
      return stable;
    })
    .toBe(true);
  return last;
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
    // The chip names the document family with its own icon, not a generic page.
    await expect(file.locator('[data-testid="file-type-icon"]')).toHaveAttribute(
      "data-file-kind",
      "pdf",
    );
  });

  test("gives each shared file the icon of its own type", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    // The last message of the thread carries five files of five families — the last
    // of them named with no extension at all, which falls back to the MIME type.
    const stack = page
      .locator("[data-message-id]")
      .filter({ hasText: "All the workshop material" })
      .locator('[data-testid="message-attachments"]');
    const icons = stack.locator('[data-testid="file-type-icon"]');
    await expect.poll(() => icons.count()).toBe(5);
    const kinds = await icons.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-file-kind")),
    );
    expect(kinds).toEqual(["word", "excel", "powerpoint", "archive", "audio"]);
  });

  test("opens an image in the lightbox and dismisses it with Escape", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const thumb = await loadedThumb(page);
    await thumb.click();

    // The lightbox is a native <dialog> portaled to <body> and opened with
    // showModal(), so the enlarged picture renders in the top layer, above the
    // messages. Only the clicked image's dialog is in the DOM at all.
    const lightbox = page.locator('dialog[data-testid="image-lightbox"][open]');
    await expect(lightbox).toBeVisible();
    // The enlarged picture shows the same proxied blob as the thumbnail.
    const zoomed = lightbox.locator('[data-testid="image-lightbox-image"]');
    await expect(zoomed).toBeVisible();
    await expect(zoomed).toHaveAttribute("src", /^blob:/);

    // Escape closes the lightbox and must NOT also fall through to the app's
    // global handler (which would leave the conversation). The lightbox catches
    // Escape in the capture phase and stops propagation, so we stay put.
    await page.keyboard.press("Escape");
    await expect(lightbox).toHaveCount(0);
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText("Media Gallery");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("closes the lightbox via the close button and the void around the picture", async ({
    page,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const thumb = await loadedThumb(page);
    const lightbox = page.locator('dialog[data-testid="image-lightbox"][open]');

    await thumb.click();
    await expect(lightbox).toBeVisible();
    await lightbox.getByRole("button", { name: "Close image preview" }).click();
    await expect(lightbox).toHaveCount(0);

    // Clicking the dim void around the picture closes it — the top-left corner is
    // outside the centred picture whatever its aspect ratio.
    await thumb.click();
    await expect(lightbox).toBeVisible();
    await lightbox.click({ position: { x: 8, y: 8 } });
    await expect(lightbox).toHaveCount(0);
  });

  test("zooms the open picture in and out with the wheel", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const thumb = await loadedThumb(page);
    await thumb.click();
    const lightbox = page.locator('dialog[data-testid="image-lightbox"][open]');
    await expect(lightbox).toHaveAttribute("data-phase", "open");
    const picture = lightbox.locator('[data-testid="image-lightbox-image"]');
    const fitted = await settledBox(picture);

    // Scrolling up magnifies the picture rather than dismissing it.
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, -300);
    await expect.poll(() => lightbox.getAttribute("data-zoom")).not.toBe("1.00");
    await expect(lightbox).toBeVisible();
    const magnified = await settledBox(picture);
    expect(magnified.width).toBeGreaterThan(fitted.width);

    // Scrolling back down returns to the fit box, and stops there: the picture
    // never shrinks away, and the wheel never closes the lightbox.
    await page.mouse.wheel(0, 900);
    await expect.poll(() => lightbox.getAttribute("data-zoom")).toBe("1.00");
    await expect(lightbox).toBeVisible();
    const back = await settledBox(picture);
    expect(back.width).toBeCloseTo(fitted.width, 0);
  });

  test("a click on a magnified picture returns to fit, and one more closes", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    const thumb = await loadedThumb(page);
    await thumb.click();
    const lightbox = page.locator('dialog[data-testid="image-lightbox"][open]');
    await expect(lightbox).toHaveAttribute("data-phase", "open");
    const picture = lightbox.locator('[data-testid="image-lightbox-image"]');

    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, -300);
    await expect.poll(() => lightbox.getAttribute("data-zoom")).not.toBe("1.00");

    // Magnified, the picture itself is the way back out of the zoom. Clicked
    // through the mouse at the middle of the viewport, because a magnified
    // picture reaches past the viewport and has no clickable corner of its own.
    await expect(picture).toBeVisible();
    await page.mouse.click(640, 360);
    await expect.poll(() => lightbox.getAttribute("data-zoom")).toBe("1.00");
    await expect(lightbox).toBeVisible();

    // …and at fit, it closes.
    await page.mouse.click(640, 360);
    await expect(lightbox).toHaveCount(0);
  });

  test("grows a picture that is smaller than the viewport", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");

    // A 64×48 raster picture: the thumbnail is its own 64 px, and opening it must
    // show something bigger than that. See MAX_UPSCALE in lib/image-zoom.ts.
    const message = page.locator("[data-message-id]").filter({ hasText: "The exported icon" });
    const thumb = message.locator('[data-testid="message-image"]');
    await expect(thumb).toBeVisible();
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    const small = (await thumb.boundingBox())!;
    expect(small.width).toBeLessThan(200);

    await thumb.click();
    const lightbox = page.locator('dialog[data-testid="image-lightbox"][open]');
    await expect(lightbox).toHaveAttribute("data-phase", "open");
    const picture = lightbox.locator('[data-testid="image-lightbox-image"]');
    const grown = await settledBox(picture);

    expect(grown.width).toBeGreaterThan(small.width * 2);
    // Grown by the picture's own ratio, so it is not stretched.
    expect(grown.width / grown.height).toBeCloseTo(small.width / small.height, 1);
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

  // Why this is a test and not a detail: the history is VIRTUALIZED, so every row is
  // measured as it mounts and the rows below it are placed from that measurement. A
  // picture that arrives after its row was measured therefore grows the row and shoves
  // everything below — the reader is reading one message and holding another a frame
  // later. Teams states the picture's size on the tag, so the space is reserved before
  // a byte of it loads and the two heights are the same height.
  test("holds a picture's space before it loads, so the row never grows", async ({ page }) => {
    // Hold the bytes back, which is what makes the "before" state observable at all.
    await setMediaDelay(page, 4_000);
    try {
      await gotoApp(page);
      await openByPalette(page, "Media Gallery");

      const withText = page
        .locator('[data-testid="message"]', { hasText: "screenshot from the incident" })
        .first();
      await expect(withText).toBeVisible();

      // Before: the picture is still in flight, and its box is already held open.
      const placeholder = withText.locator('[data-testid="message-image-placeholder"]');
      await expect(placeholder).toBeVisible();
      const before = (await withText.boundingBox())!.height;

      // After: the bytes land and the picture replaces the box it was holding.
      const image = withText.locator('[data-testid="message-image"]');
      await expect(image).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);
      const after = (await withText.boundingBox())!.height;

      // The row is the same height it was, within a pixel of layout rounding.
      //
      // Both halves of the fix are needed to hold this, and this fixture measured
      // each one: with no reservation at all the placeholder was a fixed 128px box
      // against a 200px picture, and with a reservation written as `min(width, 100%)`
      // the bubble still grew 39px, because a percentage width contributes nothing to
      // a shrink-to-fit parent's intrinsic width.
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    } finally {
      // Owed to every later spec — one mock process serves the whole run.
      await setMediaDelay(page, 0);
    }
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
