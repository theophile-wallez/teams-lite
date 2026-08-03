// The adaptive/connector card surface, end to end: a bot's card reaches the bubble
// as markdown, and the markdown is what the reader sees rendered — not its source.
// The fixture mirrors the alert Grafana relays through the Workflows bot, which is
// the shape that reads worst when the text is printed verbatim (see the module
// comment of src/lib/card-markdown.ts).
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

/** The alert card in the App Cards fixture (the one posted by "Workflows"). */
function alertCard(page: Page) {
  return page
    .locator('[data-testid="card-attachment"]')
    .filter({ hasText: "ContainerRestartStorm" });
}

test.describe("App cards", () => {
  test("renders a bot card's markdown — bold labels and labelled links", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "App Cards");

    const card = alertCard(page);
    await expect(card).toHaveCount(1);

    // The severity is emphasis, not four asterisks in the middle of a sentence.
    await expect(card.locator("strong").first()).toHaveText("critical");
    await expect(card).not.toContainText("**critical**");

    // A link shows its two-word label; the 200-character Grafana URL is its target.
    const logs = card.locator("a").filter({ hasText: "Logs" }).first();
    await expect(logs).toHaveAttribute("href", /grafana\.example\.com\/explore\?left=/);
    await expect(logs).toHaveAttribute("target", "_blank");
    await expect(logs).toHaveAttribute("rel", "noopener noreferrer");
    await expect(card).not.toContainText("%22datasource%22");

    // Each of the card's blocks is its own paragraph, so the alert does not read as
    // one unbroken wall of text.
    await expect(card.locator('[data-testid="card-text"] p')).not.toHaveCount(1);

    // A card with content of its own is never titled with the generic "Card" label.
    await expect(card.locator('[data-testid="card-title"]')).toHaveCount(0);

    // The card's own action stays a real, labelled button.
    await expect(card.locator('[data-testid="card-action"]')).toContainText("View URL");

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
