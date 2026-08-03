import { test, expect, gotoApp, realErrors } from "./helpers";
import type { Page } from "@playwright/test";

// The chat header carries the other party's live presence, like Teams: the badge
// on their avatar, the state in words beside their name. It is a 1:1 affordance
// only — a group and a channel name no single person — and it appears only once the
// state is actually known.
//
// The mock derives a presence from the MRI (see `mockPresence`), so each seeded
// person has a fixed state: "Ava Thompson" is in a meeting, "Emma Rossi" is the
// person the service has no answer for.

/** Open a conversation by name through the command palette — robust to sidebar
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

const header = (page: Page) => page.locator('[data-testid="message-pane"] > header');
const status = (page: Page) => page.locator('[data-testid="header-presence"]');

test.describe("presence in the chat header", () => {
  test("a 1:1 header states the other party's presence, in words and as a badge", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Ava Thompson");

    await expect(status(page)).toHaveText("In a meeting", { timeout: 10_000 });
    await expect(header(page).locator('[data-testid="presence-badge"]')).toHaveAttribute(
      "data-tone",
      "busy",
    );

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a group chat has no single presence to show", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openByPalette(page, "Platform Team");

    await expect(status(page)).toHaveCount(0);
    await expect(header(page).locator('[data-testid="presence-badge"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a presence the service cannot answer is stated by nothing at all", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Emma Rossi");

    // Give the lookup time to land: the point is that an unknown state stays
    // silent, not that the header is slow.
    await page.waitForTimeout(1_000);
    await expect(status(page)).toHaveCount(0);
    await expect(header(page).locator('[data-testid="presence-badge"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
