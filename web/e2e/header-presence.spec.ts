import { test, expect, gotoApp, realErrors } from "./helpers";
import type { Page } from "@playwright/test";

// The chat header carries the other party's live presence, like Teams: the badge on
// their avatar, and nothing else. The dot states the whole thing — its tone, its
// glyph and its label — so no words sit next to the name. It is a 1:1 affordance
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
const badge = (page: Page) => header(page).locator('[data-testid="presence-badge"]');

test.describe("presence in the chat header", () => {
  test("a 1:1 header states the other party's presence as a badge, and in no words", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Ava Thompson");

    await expect(badge(page)).toHaveAttribute("data-tone", "busy", { timeout: 10_000 });
    // The dot is the only statement of the state, so it carries the words itself
    // rather than putting them beside the name.
    await expect(badge(page)).toHaveAttribute("aria-label", "In a meeting");
    await expect(badge(page)).toHaveAttribute("title", "In a meeting");
    await expect(header(page)).not.toContainText("In a meeting");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a group chat has no single presence to show", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openByPalette(page, "Platform Team");

    await expect(badge(page)).toHaveCount(0);

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
    await expect(badge(page)).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
