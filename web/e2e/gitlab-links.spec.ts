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

test.describe("GitLab rich link previews", () => {
  test("renders a card for a merge request, an issue, and a project", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");

    const cards = page.locator('[data-testid="gitlab-link-card"]');
    // Three seeded links → three cards, populated by the backend `enrich_link`.
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(3);

    const mr = page.locator('[data-testid="gitlab-link-card"][data-kind="merge_request"]');
    await expect(mr).toHaveCount(1);
    await expect(mr).toContainText("Add rich link previews for GitLab");
    await expect(mr).toContainText("!42");
    // The card links to the merge request it describes.
    await expect(mr).toHaveAttribute("href", "https://gitlab.com/acme/webapp/-/merge_requests/42");

    const issue = page.locator('[data-testid="gitlab-link-card"][data-kind="issue"]');
    await expect(issue).toHaveCount(1);
    await expect(issue).toContainText("#7");

    const project = page.locator('[data-testid="gitlab-link-card"][data-kind="project"]');
    await expect(project).toHaveCount(1);
    await expect(project).toContainText("acme/webapp");

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});

test.describe.serial("Settings page", () => {
  test("opens from the sidebar and shows the GitLab section", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();

    const pane = page.locator('[data-testid="settings-pane"]');
    await expect(pane).toBeVisible();
    // The message pane is replaced while the sidebar stays put.
    await expect(page.locator('[data-testid="message-pane"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await expect(page.locator('[data-testid="gitlab-host-input"]')).toHaveValue("gitlab.com");
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("saves a token, reflects it, then removes it", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();

    // Save a token: the write-only field clears and the status confirms.
    await page.locator('[data-testid="gitlab-token-input"]').fill("glpat-e2e-test-token");
    await page.locator('[data-testid="gitlab-save"]').click();
    await expect(page.locator('[data-testid="gitlab-save-status"]')).toContainText("Saved");
    // The token field is write-only: it is cleared after saving.
    await expect(page.locator('[data-testid="gitlab-token-input"]')).toHaveValue("");
    // A "saved" state exposes the remove action.
    const remove = page.locator('[data-testid="gitlab-remove-token"]');
    await expect(remove).toBeVisible();

    // Remove the token: the remove action disappears again.
    await remove.click();
    await expect(page.locator('[data-testid="gitlab-remove-token"]')).toHaveCount(0);
  });

  test("clicking a conversation leaves the settings pane", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();

    await page.locator('[data-testid="conversation-row"]').first().click();
    await expect(page.locator('[data-testid="settings-pane"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="message-pane"]')).toBeVisible();
  });
});
