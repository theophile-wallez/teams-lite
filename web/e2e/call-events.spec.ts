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

    // The fixture has three call events (group ended, missed, 1:1 ended) plus one
    // ordinary chat bubble.
    const events = page.locator('[data-testid="system-event"]');
    await expect.poll(() => events.count(), { timeout: 10_000 }).toBe(3);

    // A system line is never a chat bubble: no mine/theirs, no sender name.
    for (const attr of ["data-mine", "data-testid"]) {
      await expect(events.first()).not.toHaveAttribute(attr, "message");
    }
    await expect(events.locator('[data-testid="sender-name"]')).toHaveCount(0);

    // The group call that ended shows its duration and participant count.
    await expect(page.getByText("Call ended · 10 min · 5 participants")).toBeVisible();
    // The missed call is flagged and carries no duration.
    const missed = page.locator('[data-system-event="call"][data-call-event="missed"]');
    await expect(missed).toHaveCount(1);
    await expect(missed).toContainText("Missed call");
    // The 1:1 call shows only the duration (no participant count).
    await expect(page.getByText("Call ended · 23 min", { exact: true })).toBeVisible();

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
