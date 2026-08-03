import {
  test,
  expect,
  composerField,
  fetchCapturedSends,
  fillComposer,
  gotoApp,
  openConversationAt,
} from "./helpers";

// The composer has ONE field and it is always the rich-text editor: Ctrl/Cmd+B
// bolds in every state of the box. The `Type` button decides only whether the
// format buttons are visible — they sit in the composer's own top section when it
// is on, and over the selection when it is off. So these specs prove three things:
// the field is rich by default, the button shows and hides a bar without touching
// the text, and the shortcuts keep working with the bar closed.
test.describe("rich composer", () => {
  const TOOLBAR = '[data-testid="composer-toolbar"]';
  const TOGGLE = '[data-testid="composer-format-toggle"]';

  test("is the rich editor, with no plain textarea left to fall back to", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await expect(page.locator('[data-testid="composer-rich"]')).toBeVisible();
    await expect(page.locator('textarea[data-testid="composer"]')).toHaveCount(0);
    // The format bar starts closed, so the box reads as lean as a plain field.
    await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(TOOLBAR)).toHaveCount(0);
  });

  test("types and sends a message with Enter", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const marker = `rich-${Date.now()}`;
    await fillComposer(page, marker);
    await page.keyboard.press("Enter");
    const echoed = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(echoed).toBeVisible();
    await expect(echoed.first()).toHaveAttribute("data-mine", "true");
    // The editor is cleared after sending.
    await expect(composerField(page)).toHaveText("");
  });

  test("trims the blank lines off the body it sends", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const marker = `trim-${Date.now()}`;
    // A Shift+Enter on the last line leaves a hard break, and Enter sends. The
    // reader must get the words, not the empty line under them.
    await fillComposer(page, marker);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="message"]', { hasText: marker })).toBeVisible();
    const sends = await fetchCapturedSends(page);
    const sent = sends.filter((send) => send.content_html?.includes(marker)).pop();
    expect(sent?.content_html).toBe(`<p>${marker}</p>`);
  });

  test("Ctrl+B bolds the selection with the format bar closed", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await expect(page.locator(TOOLBAR)).toHaveCount(0);
    await fillComposer(page, "bold me");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+b");
    // The selection is wrapped in <strong>, so the sent HTML carries the bold.
    await expect(composerField(page).locator("strong")).toHaveText("bold me");
  });

  test("the format button shows the buttons in the composer's top section", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.locator(TOGGLE).click();

    const toolbar = page.locator(TOOLBAR);
    await expect(toolbar).toBeVisible();
    await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "true");
    for (const label of ["Bold", "Italic", "Underline", "Link", "Bulleted list"]) {
      await expect(toolbar.getByRole("button", { name: label })).toBeVisible();
    }
    // It is a TOP section: the buttons sit above the field they format.
    const bar = await toolbar.boundingBox();
    const field = await composerField(page).boundingBox();
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(field!.y + 1);

    // And it formats: select the typed words, then click Bold.
    await fillComposer(page, "bar bold");
    await page.keyboard.press("ControlOrMeta+a");
    await toolbar.getByRole("button", { name: "Bold" }).click();
    await expect(composerField(page).locator("strong")).toHaveText("bar bold");
  });

  test("the bar's buttons follow the caret, not only the typing", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.locator(TOGGLE).click();
    const bold = page.locator(TOOLBAR).getByRole("button", { name: "Bold" });

    await fillComposer(page, "bold");
    await page.keyboard.press("ControlOrMeta+a");
    await bold.click();
    await expect(bold).toHaveAttribute("aria-pressed", "true");

    // Leave the bold word and write a plain one: the button lets go on its own.
    await page.keyboard.press("End");
    await bold.click();
    await page.keyboard.type(" plain");
    await expect(bold).toHaveAttribute("aria-pressed", "false");

    // Walk the caret back into the bold word: the button lights up again, with no
    // edit at all. A bar that only tracked edits would keep saying "not bold".
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await expect(bold).toHaveAttribute("aria-pressed", "true");
  });

  test("showing the buttons leaves the text where it was", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const field = composerField(page);
    await fillComposer(page, "do not move me");
    const before = await field.boundingBox();

    await page.locator(TOGGLE).click();
    await expect(page.locator(TOOLBAR)).toBeVisible();
    const after = await field.boundingBox();

    // The box grows upwards from its own bottom edge, so the words keep their
    // place: same left edge, same baseline, same padding around them.
    expect(after!.x).toBe(before!.x);
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    expect(after!.height).toBe(before!.height);
    await expect(field).toHaveText("do not move me");
  });

  test("hiding the buttons keeps the text and the shortcuts", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.locator(TOGGLE).click();
    await expect(page.locator(TOOLBAR)).toBeVisible();

    const field = composerField(page);
    await fillComposer(page, "keep me");
    await page.locator(TOGGLE).click();

    // The bar is gone; the field, its text and its formatting are not.
    await expect(page.locator(TOOLBAR)).toHaveCount(0);
    await expect(field).toHaveText("keep me");
    await field.click(); // the toggle took the focus; the caret goes back to the words
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+b");
    await expect(field.locator("strong")).toHaveText("keep me");
  });

  test("remembers whether the buttons are shown", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await page.locator(TOGGLE).click();
    await expect(page.locator(TOOLBAR)).toBeVisible();

    await gotoApp(page);
    await openConversationAt(page, 0);
    await expect(page.locator(TOOLBAR)).toBeVisible();
    await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "true");
  });
});
