import { test, expect, expectCardFitsItsPane, gotoApp, realErrors } from "./helpers";
import type { Page } from "@playwright/test";

/** The seeded merge request whose every field is as long as a real one's — a deep
 *  group path, a branch named after its ticket (mirrors LONG_GITLAB_PATH in the
 *  mock). It is the card a narrow width has to survive. */
const LONG_MR = "https://gitlab.com/acme/platform/infrastructure/dlq-to-dynamodb-lambda/-/merge_requests/6";

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
  test("renders cards for a merge request, an issue, and a project", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");

    const cards = page.locator('[data-testid="gitlab-link-card"]');
    // Five seeded links (MR + issue + project in sentences, plus a bare MR and the
    // long-shape one) → five cards, populated by the backend `enrich_link`.
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(5);

    const mrHref = "https://gitlab.com/acme/webapp/-/merge_requests/42";
    const mr = page.locator(`[data-testid="gitlab-link-card"][href="${mrHref}"]`);
    await expect(mr).toHaveCount(1);
    await expect(mr).toContainText("Add rich link previews for GitLab");
    await expect(mr).toContainText("!42");

    // The raw link in the body is REPLACED by the card, not shown alongside it:
    // exactly one anchor points at the MR (the card), never two.
    await expect(page.locator(`a[href="${mrHref}"]`)).toHaveCount(1);

    await expect(
      page.locator('[data-testid="gitlab-link-card"][href*="/-/issues/7"]'),
    ).toContainText("#7");
    await expect(
      page.locator('[data-testid="gitlab-link-card"][href="https://gitlab.com/acme/webapp"]'),
    ).toContainText("acme/webapp");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("shows a CI pipeline badge on merge requests, but not on issues", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");

    // The MR card carries its pipeline status (mock: !42 → success → "Passed").
    const mr = page.locator(
      '[data-testid="gitlab-link-card"][href="https://gitlab.com/acme/webapp/-/merge_requests/42"]',
    );
    const mrPipeline = mr.locator('[data-testid="gitlab-pipeline-status"]');
    await expect(mrPipeline).toHaveAttribute("data-status", "success");
    await expect(mrPipeline).toContainText("Passed");

    // The bare MR !99 is still in progress (mock: !99 → running → "Running"); this
    // is the state the UI keeps polling until it turns terminal.
    const runningPipeline = page
      .locator('[data-testid="gitlab-link-card"][href="https://gitlab.com/acme/webapp/-/merge_requests/99"]')
      .locator('[data-testid="gitlab-pipeline-status"]');
    await expect(runningPipeline).toHaveAttribute("data-status", "running");
    await expect(runningPipeline).toContainText("Running");

    // Issues have no pipeline, so their card renders no badge.
    const issue = page.locator('[data-testid="gitlab-link-card"][href*="/-/issues/7"]');
    await expect(issue).toHaveCount(1);
    await expect(issue.locator('[data-testid="gitlab-pipeline-status"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("names the author as the colleague the app knows, with their face", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");

    // A merge request opened by somebody this app's own Teams knows: the card draws the
    // colleague — their real face, through the backend like every other avatar here — rather
    // than a bare name (see § A GitLab user who is also a colleague in AGENTS.md).
    const mr = page.locator(
      '[data-testid="gitlab-link-card"][href="https://gitlab.com/acme/webapp/-/merge_requests/42"]',
    );
    const author = mr.locator('[data-testid="gitlab-card-author"]');
    await expect(author).toHaveAttribute("data-author", "Mia Chen");
    await expect(author.locator("img[data-picture='face']")).toBeVisible();

    // And an author only GitLab knows keeps GitLab's own name, over initials: nothing is ever
    // fetched from the instance for a picture.
    const issue = page
      .locator('[data-testid="gitlab-link-card"][href*="/-/issues/7"]')
      .locator('[data-testid="gitlab-card-author"]');
    await expect(issue).toHaveAttribute("data-author", "Grace Hopper");
    await expect(issue.locator("img")).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("shows a link-only message as just the card, without a bubble", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");

    // The bare-link message renders with no bubble chrome (data-link-only), and
    // holds the integration card.
    const linkOnly = page.locator('[data-testid="message"][data-link-only="true"]');
    await expect(linkOnly).toHaveCount(2);
    await expect(linkOnly.locator('[data-testid="gitlab-link-card"]')).toHaveCount(2);

    // A message that has surrounding text keeps its bubble (not link-only).
    const mrCard = page.locator(
      '[data-testid="gitlab-link-card"][href="https://gitlab.com/acme/webapp/-/merge_requests/42"]',
    );
    const sentenceMessage = page.locator('[data-testid="message"]', { has: mrCard });
    await expect(sentenceMessage).not.toHaveAttribute("data-link-only", "true");
  });
});

// The card on a PHONE, which is where it is usually read. Every line of it holds
// text that has no break in it — a group path, a branch, a reference — so a card
// that cannot shrink its lines runs off the side of the screen, taking its state
// and pipeline badges with it.
test.describe("GitLab card at phone width", () => {
  // A phone's viewport, and only the viewport: a `devices[…]` preset names a browser
  // type too, which Playwright refuses inside a describe. Width is what this measures.
  test.use({ viewport: { width: 412, height: 915 } });

  test("the long-shape card fits the conversation, badges and all", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");

    const card = page.locator(`[data-testid="gitlab-link-card"][href="${LONG_MR}"]`);
    await expect(card).toBeVisible();
    // The parts a narrow card would push out of sight are the ones worth naming.
    await expect(card).toContainText("!6");
    await expect(card.locator('[data-testid="gitlab-pipeline-status"]')).toBeVisible();

    await expectCardFitsItsPane(card, page.locator('[data-testid="message-pane"]'));
  });

  test("every card in the thread fits, not only the long one", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");

    const pane = page.locator('[data-testid="message-pane"]');
    const cards = page.locator('[data-testid="gitlab-link-card"]');
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(5);
    for (let i = 0; i < 5; i += 1) {
      await expectCardFitsItsPane(cards.nth(i), pane);
    }
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
