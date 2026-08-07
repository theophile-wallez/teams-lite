import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  composerField,
  fetchCapturedSends,
  fillComposer,
  gotoApp,
  openConversationAt,
  setSendControl,
} from "./helpers";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_BASE64, "base64");
/** A picture with real pixels — the app's own icon, 192px tall, so a height cap on the
 *  thumbnail is something a box can be measured against. */
const TALL_PNG = fileURLToPath(new URL("../public/icons/icon-192.png", import.meta.url));
const IMAGE_INPUT = '[data-testid="composer-image-input"]';
const IMAGE_PREVIEW = '[data-testid="composer-image-preview"]';

async function selectImage(page: import("@playwright/test").Page, name = "pixel.png") {
  const before = await page.locator(IMAGE_PREVIEW).count();
  await page.locator(IMAGE_INPUT).setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(before + 1);
}

/** The pending pictures, by name, in the order the composer holds them. */
async function pendingImageNames(page: import("@playwright/test").Page): Promise<string[]> {
  return page
    .locator(IMAGE_PREVIEW)
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-image-name") ?? ""),
    );
}

/** Paste `names.length` images in ONE clipboard event — the shape a paste of several
 *  screenshots arrives in. */
async function pasteImages(page: import("@playwright/test").Page, names: string[]) {
  await composerField(page).evaluate(
    (element, payload) => {
      const bytes = Uint8Array.from(atob(payload.base64), (value) => value.charCodeAt(0));
      const clipboard = new DataTransfer();
      for (const name of payload.names) {
        clipboard.items.add(new File([bytes], name, { type: "image/png" }));
      }
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    },
    { base64: PNG_BASE64, names },
  );
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
    await expect(page.locator(`${IMAGE_PREVIEW} img`)).toHaveAttribute("alt", "pixel.png");

    await page.locator('[data-testid="composer-image-remove"]').click();
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-send"]')).toBeDisabled();
  });

  test("accepts an image pasted from the clipboard", async ({ page }) => {
    await openComposer(page);
    await pasteImages(page, ["pasted.png"]);

    await expect(page.locator(IMAGE_PREVIEW)).toBeVisible();
    await expect(page.locator(`${IMAGE_PREVIEW} img`)).toHaveAttribute("alt", "pasted.png");
  });

  // The bug the whole list exists for: a second paste used to REPLACE the first picture,
  // so a message meant to carry three screenshots carried the last one.
  test("keeps every pasted image, one paste after another", async ({ page }) => {
    await openComposer(page);
    await pasteImages(page, ["first.png"]);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(1);
    await pasteImages(page, ["second.png"]);
    await pasteImages(page, ["third.png"]);

    // In the order they were pasted, which is the order they go out in.
    await expect
      .poll(() => pendingImageNames(page))
      .toEqual(["first.png", "second.png", "third.png"]);
  });

  // Several are drawn smaller than one: ten thumbnails at the height a single one gets is
  // a composer that has eaten the conversation.
  //
  // It measures a picture TALLER than either cap — the app's own 192px icon, not the 1x1
  // pixel the rest of this file uses, whose intrinsic height is below both `max-h` values
  // and so proves nothing about them.
  test("draws several pictures smaller than a single one", async ({ page }) => {
    await openComposer(page);
    await page.locator(IMAGE_INPUT).setInputFiles(TALL_PNG);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(1);
    const thumbnail = page.locator(`${IMAGE_PREVIEW} img`).first();
    const alone = (await thumbnail.boundingBox())!.height;

    await page.locator(IMAGE_INPUT).setInputFiles(TALL_PNG);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(2);
    await expect.poll(async () => (await thumbnail.boundingBox())!.height).toBeLessThan(alone);
  });

  test("takes several images from one paste and sends them in order", async ({ page }) => {
    await openComposer(page);
    await pasteImages(page, ["a.png", "b.png", "c.png"]);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(3);

    await page.locator('[data-testid="composer-send"]').click();
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBe(1);
    const sends = await fetchCapturedSends(page);
    expect(sends[0]?.images?.map((image) => image.name)).toEqual(["a.png", "b.png", "c.png"]);
    // The message carries one picture per image, not one for the last of them.
    await expect(
      page
        .locator('[data-testid="message"][data-mine="true"]')
        .last()
        .locator('[data-testid="message-image"]'),
    ).toHaveCount(3);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
  });

  test("removes one image and keeps the others", async ({ page }) => {
    await openComposer(page);
    await pasteImages(page, ["keep-me.png", "drop-me.png", "keep-me-too.png"]);
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(3);

    await page
      .locator(`${IMAGE_PREVIEW}[data-image-name="drop-me.png"]`)
      .getByRole("button")
      .click();

    await expect.poll(() => pendingImageNames(page)).toEqual(["keep-me.png", "keep-me-too.png"]);
  });

  test("refuses an eleventh image and says so", async ({ page }) => {
    await openComposer(page);
    await pasteImages(
      page,
      Array.from({ length: 11 }, (_unused, index) => `shot-${index}.png`),
    );

    // The ten that fit are kept: the refusal costs the eleventh, not the batch — and not
    // the message, which still sends them (the send is the list's own path, pinned above
    // at three; nothing about it special-cases ten).
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(10);
    await expect(page.locator('[data-testid="composer-image-error"]')).toContainText("at most 10");
    // Deliberately NOT sent: one mock process serves the whole run, and a message ten
    // pictures tall left in this thread is shared state the specs after this one measure
    // — it makes the deep-link scroll in notifications.spec.ts time out.
    await expect(page.locator('[data-testid="composer-send"]')).toBeEnabled();
  });

  test("sends an image without text and renders the AMS image echo", async ({ page }) => {
    await openComposer(page);
    await selectImage(page, "image-only.png");
    await page.locator('[data-testid="composer-send"]').click();

    const sentImage = page
      .locator('[data-testid="message"][data-mine="true"]')
      .filter({ has: page.locator('[data-testid="message-image"]') })
      .last();
    await expect(sentImage).toBeVisible();

    const sends = await fetchCapturedSends(page);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe("");
    expect(sends[0]?.images).toHaveLength(1);
    expect(sends[0]?.images?.[0]).toMatchObject({
      name: "image-only.png",
      content_type: "image/png",
      data_base64: PNG_BASE64,
      width: 1,
      height: 1,
    });
  });

  test("sends a caption with the image", async ({ page }) => {
    await openComposer(page);
    await selectImage(page, "captioned.png");
    await fillComposer(page, "A small caption");
    await page.locator('[data-testid="composer-send"]').click();

    const message = page.locator('[data-testid="message"]', { hasText: "A small caption" }).last();
    await expect(message).toBeVisible();
    await expect(message.locator('[data-testid="message-image"]')).toBeVisible();
    // The field is the rich editor, so the caption travels as HTML beside the image.
    const sends = await fetchCapturedSends(page);
    expect(sends[0]?.content_html).toContain("A small caption");
    expect(sends[0]?.images?.[0]?.name).toBe("captioned.png");
  });

  test("sends a caption with the format bar open", async ({ page }) => {
    await openComposer(page);
    await page.locator('[data-testid="composer-format-toggle"]').click();
    await expect(page.locator('[data-testid="composer-toolbar"]')).toBeVisible();
    await selectImage(page, "rich.png");
    await fillComposer(page, "Rich caption");
    await page.locator('[data-testid="composer-send"]').click();

    await expect(
      page.locator('[data-testid="message"]', { hasText: "Rich caption" }).last(),
    ).toBeVisible();
    const sends = await fetchCapturedSends(page);
    expect(sends[0]?.content_html).toContain("Rich caption");
    expect(sends[0]?.images?.[0]?.name).toBe("rich.png");
  });

  test("rejects unsupported files and oversized images", async ({ page }) => {
    await openComposer(page);
    await page.locator(IMAGE_INPUT).setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not an image"),
    });
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-image-error"]')).toContainText(/image/i);

    await page.locator(IMAGE_INPUT).setInputFiles({
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(11 * 1024 * 1024),
    });
    await expect(page.locator(IMAGE_PREVIEW)).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-image-error"]')).toContainText(/smaller/i);
    expect(await fetchCapturedSends(page)).toHaveLength(0);
  });

  // One bad file in a batch costs that file and nothing else: the others are still
  // pictures the user asked to send.
  test("keeps the good images when one file in the batch is not an image", async ({ page }) => {
    await openComposer(page);
    await page.locator(IMAGE_INPUT).setInputFiles([
      { name: "good-one.png", mimeType: "image/png", buffer: PNG },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") },
      { name: "good-two.png", mimeType: "image/png", buffer: PNG },
    ]);

    await expect.poll(() => pendingImageNames(page)).toEqual(["good-one.png", "good-two.png"]);
    await expect(page.locator('[data-testid="composer-image-error"]')).toContainText(/image/i);
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

  // The send takes back exactly what left. A picture pasted while the request was
  // travelling is not one of them, so it stays in the box rather than being thrown away —
  // and the one that did leave goes, so the next Enter cannot post it twice.
  test("keeps an image pasted while the send is in flight", async ({ page }) => {
    await openComposer(page);
    await setSendControl(page, { delay_ms: 700, clear: true });
    await selectImage(page, "left.png");
    await page.locator('[data-testid="composer-send"]').click();
    await pasteImages(page, ["stayed.png"]);

    await expect.poll(() => pendingImageNames(page)).toEqual(["stayed.png"]);
    const sends = await fetchCapturedSends(page);
    expect(sends[0]?.images?.map((image) => image.name)).toEqual(["left.png"]);
  });

  test("keeps the image and caption when send fails", async ({ page }) => {
    await openComposer(page);
    await setSendControl(page, { error: "mock image send failed", clear: true });
    await selectImage(page, "retry.png");
    await fillComposer(page, "Keep this caption");
    await page.locator('[data-testid="composer-send"]').click();

    await expect(page.locator('[data-testid="status-bar"]')).toContainText("mock image send failed");
    // And beside the picture that did not leave, where the user is looking.
    await expect(page.locator('[data-testid="composer-send-error"]')).toContainText("Not sent");
    await expect(page.locator(IMAGE_PREVIEW)).toBeVisible();
    await expect(composerField(page)).toHaveText("Keep this caption");
    expect(await fetchCapturedSends(page)).toHaveLength(1);
  });
});
