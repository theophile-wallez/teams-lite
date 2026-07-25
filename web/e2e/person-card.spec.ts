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

const card = (page: Page) => page.locator('[data-testid="person-card"]');

test.describe("person card on hover", () => {
  test("hovering a sender's name reveals who they are and their presence", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Mention Demo");

    // Nothing is fetched or shown until someone actually hovers.
    await expect(card(page)).toHaveCount(0);

    const senderName = page.locator('[data-testid="sender-name"]').first();
    await senderName.hover();

    await expect(card(page)).toBeVisible({ timeout: 10_000 });
    // The name is there immediately (it comes from the message); the directory
    // fills in the rest.
    await expect(page.locator('[data-testid="person-card-name"]')).not.toBeEmpty();
    await expect(page.locator('[data-testid="person-card-email"]')).toContainText("@example.com");
    await expect(page.locator('[data-testid="person-card-presence"]')).not.toBeEmpty();
    await expect(page.locator('[data-testid="presence-badge"]').first()).toHaveAttribute(
      "data-tone",
      /available|busy|away|offline|oof/,
    );

    // Moving away dismisses it.
    await page.locator('[data-testid="conversation-title"]').hover();
    await expect(card(page)).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an @mention of a person opens their card; a channel mention does not", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Mention Demo");

    // The first seeded message mentions a person AND the channel itself. Only the
    // person is a hover target — a thread is not somebody.
    const firstMessage = page.locator('[data-testid="message"]').first();
    const triggers = firstMessage.locator('[data-testid="person-hover-trigger"]');
    // The sender's name plus exactly one of the two mentions.
    await expect(triggers).toHaveCount(2);

    const mention = triggers.nth(1);
    await expect(mention).toHaveAttribute("data-person-mri", /^8:/);
    await mention.hover();
    await expect(card(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="person-card-title"]')).not.toBeEmpty();

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("the quoted author of a reply is hoverable too", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openByPalette(page, "Mention Demo");

    const quoteSender = page.locator('[data-testid="quote-sender"]').first();
    await expect(quoteSender).toBeVisible();
    await quoteSender.hover();

    await expect(card(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="person-card-name"]')).not.toBeEmpty();

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("the card is reachable by keyboard", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openByPalette(page, "Mention Demo");

    // Radix opens a hover card on trigger focus, so a keyboard user gets the same
    // information as a mouse user.
    await page.locator('[data-testid="person-hover-trigger"]').first().focus();
    await expect(card(page)).toBeVisible({ timeout: 10_000 });

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
