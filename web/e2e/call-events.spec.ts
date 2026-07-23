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

test.describe("call events", () => {
  test("renders call events as centered system lines, not chat bubbles", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Call Events");

    // The fixture has four call events (group ended, large ended, missed, 1:1
    // ended) plus one ordinary chat bubble.
    const events = page.locator('[data-testid="system-event"]');
    await expect.poll(() => events.count(), { timeout: 10_000 }).toBe(4);

    // A system line is never a chat bubble: no mine/theirs, no sender name.
    for (const attr of ["data-mine", "data-testid"]) {
      await expect(events.first()).not.toHaveAttribute(attr, "message");
    }
    await expect(events.locator('[data-testid="sender-name"]')).toHaveCount(0);

    // Labels no longer carry "N participants" — that is now the avatar stack.
    await expect(page.getByText("Call ended · 10 min", { exact: true })).toBeVisible();
    await expect(page.getByText("participants", { exact: false })).toHaveCount(0);
    // The missed call is flagged and carries no duration or avatars.
    const missed = page.locator('[data-system-event="call"][data-call-event="missed"]');
    await expect(missed).toHaveCount(1);
    await expect(missed).toContainText("Missed call");
    await expect(missed.locator('[data-testid="call-avatar"]')).toHaveCount(0);
    // The 1:1 call shows only the duration.
    await expect(page.getByText("Call ended · 23 min", { exact: true })).toBeVisible();

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("shows an overlapping avatar stack, capped at five with a +N overflow", async ({
    page,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Call Events");

    // The five-person call shows exactly five avatars and no overflow chip.
    const five = page.locator('[data-testid="system-event"]', {
      has: page.getByText("Call ended · 10 min", { exact: true }),
    });
    await expect(five.locator('[data-testid="call-avatar"]')).toHaveCount(5);
    await expect(five.locator('[data-testid="call-participants-more"]')).toHaveCount(0);

    // The seven-person call caps at five avatars and adds a "+2" chip.
    const large = page.locator('[data-testid="system-event"]', {
      has: page.getByText("Call ended · 1 h", { exact: true }),
    });
    await expect(large.locator('[data-testid="call-avatar"]')).toHaveCount(5);
    await expect(large.locator('[data-testid="call-participants-more"]')).toHaveText("+2");
  });

  test("hovering an avatar reveals the participant, and +N opens the full roster", async ({
    page,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Call Events");

    const large = page.locator('[data-testid="system-event"]', {
      has: page.getByText("Call ended · 1 h", { exact: true }),
    });

    // Hovering an avatar reveals a card with the participant's name.
    await large.locator('[data-testid="call-avatar"]').first().hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "Leonor GROELL" })).toBeVisible();

    // Clicking the "+2" opens a dialog listing every participant.
    await large.locator('[data-testid="call-participants-more"]').click();
    const modal = page.locator('[data-testid="call-participants-modal"]');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-testid="call-participant-row"]')).toHaveCount(7);
    await expect(modal).toContainText("Souhail LYAMANI");
    await expect(modal).toContainText("James BASSE");

    // Escape closes it.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  });
});
