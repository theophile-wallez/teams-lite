import { test, expect, gotoApp } from "./helpers";

// Opening an unread chat has to READ it. Teams owns the unread flag, so until the app
// published the user's read position nothing moved it: the marker came back on every
// sync, which is the bug this covers (see `mark_read` in src/bin/server.rs).
//
// Ghost mode is the same flow with the network half skipped — the marker clears here
// and a ghost icon says the sender was never told. The mock has no tenant to report a
// read state to, so what a spec can assert is the app's own behaviour: the marker, the
// badge, and that the choice survives a reload.

/** The first unread row in the sidebar, which the mock's seed always has several of. */
function unreadRow(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="conversation-row"][data-unread="true"]').first();
}

/** Flip Ghost mode through the Settings pane and come back to the conversation list. */
async function setGhostMode(page: import("@playwright/test").Page, on: boolean): Promise<void> {
  await page.locator('[data-testid="open-settings"]').click();
  const toggle = page.locator('[data-testid="ghost-mode-toggle"]');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
}

test.describe("read state", () => {
  test("opening an unread conversation clears its marker", async ({ page }) => {
    await gotoApp(page);

    const row = unreadRow(page);
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-conversation-id");

    await row.click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // The row for that conversation is no longer unread — and it stays that way, since
    // the backend's own list refresh follows the mark.
    // Scoped to the sidebar row: the composer shell carries the same id (it is how
    // the live sandbox driver proves which chat a keystroke lands in).
    const opened = page.locator(
      `[data-testid="conversation-row"][data-conversation-id="${id}"]`,
    );
    await expect(opened).not.toHaveAttribute("data-unread", "true");
    // Read normally, so no ghost: Teams was told.
    await expect(opened.locator('[data-testid="ghost-read-mark"]')).toHaveCount(0);
  });

  test("Ghost mode marks a chat read here only, and says so on the row", async ({ page }) => {
    await gotoApp(page);
    await setGhostMode(page, true);

    // Back to the list, then read an unread chat with Ghost mode on.
    const row = unreadRow(page);
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-conversation-id");
    await row.click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Scoped to the sidebar row: the composer shell carries the same id (it is how
    // the live sandbox driver proves which chat a keystroke lands in).
    const opened = page.locator(
      `[data-testid="conversation-row"][data-conversation-id="${id}"]`,
    );
    await expect(opened).not.toHaveAttribute("data-unread", "true");
    await expect(opened.locator('[data-testid="ghost-read-mark"]')).toBeVisible();

    // One mock process serves the whole run: leave the setting as it was found, or
    // every later spec silently runs in Ghost mode.
    await setGhostMode(page, false);
  });

  test("Ghost mode is off by default and persists once chosen", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    const toggle = page.locator('[data-testid="ghost-mode-toggle"]');
    // Off by default: opening a chat reads it on Teams too, like every chat client.
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // The choice lives on the backend, not in this tab — a reload must find it on.
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="ghost-mode-toggle"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await setGhostMode(page, false);
  });
});
