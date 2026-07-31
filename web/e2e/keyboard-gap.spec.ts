import { devices } from "@playwright/test";
import { test, expect, gotoApp, openConversationAt } from "./helpers";

// Chromium cannot emulate iOS WebKit. Use its stable mobile profile and replace
// VisualViewport below with the geometry that iOS reports for its keyboard.
test.use({ ...devices["Pixel 7"] });

test.describe("iOS keyboard spacing", () => {
  test.beforeEach(async ({ page }) => {
    // The browser runner cannot open a software keyboard. Replace only the Visual
    // Viewport API so the app receives the same resize event and geometry as iOS.
    await page.addInitScript(() => {
      localStorage.removeItem("teams-composer-rich");

      const viewport = new EventTarget() as EventTarget & {
        height: number;
        width: number;
        offsetTop: number;
        scale: number;
      };
      viewport.height = window.innerHeight;
      viewport.width = window.innerWidth;
      viewport.offsetTop = 0;
      viewport.scale = 1;
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      });
      Object.defineProperty(window, "__setTestVisualViewportHeight", {
        configurable: true,
        value: (height: number) => {
          viewport.height = height;
          viewport.dispatchEvent(new Event("resize"));
        },
      });
    });
  });

  test("removes the bottom safe-area gap while the rich editor has the keyboard", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const shell = page.locator('[data-testid="composer-shell"]');
    const editor = page.locator('[data-testid="composer-rich"] .tiptap-message');
    await expect(editor).toBeVisible();
    await editor.click();

    const closedPadding = await shell.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingBottom),
    );
    expect(closedPadding).toBeGreaterThan(0);
    const closedBottom = await shell.evaluate((element) => element.getBoundingClientRect().bottom);

    const fullVisualHeight = await page.evaluate(() => window.visualViewport!.height);
    await page.evaluate((height) => {
      const setHeight = (window as Window & { __setTestVisualViewportHeight: (height: number) => void })
        .__setTestVisualViewportHeight;
      setHeight(height - 300);
    }, fullVisualHeight);

    await expect(page.locator("html")).toHaveAttribute("data-virtual-keyboard-open", "");
    await expect
      .poll(() =>
        shell.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
      )
      .toBe(0);
    await expect
      .poll(() => shell.evaluate((element) => element.getBoundingClientRect().bottom))
      .toBe(closedBottom);

    await page.evaluate((height) => {
      const setHeight = (window as Window & { __setTestVisualViewportHeight: (height: number) => void })
        .__setTestVisualViewportHeight;
      setHeight(height);
    }, fullVisualHeight);
    await expect(page.locator("html")).not.toHaveAttribute("data-virtual-keyboard-open", "");
    await expect
      .poll(() =>
        shell.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
      )
      .toBe(closedPadding);
  });
});
