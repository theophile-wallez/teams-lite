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

const ISSUE_HREF = "https://linear.app/acme/issue/ENG-1/show-linear-links-as-cards";
const PROJECT_HREF = "https://linear.app/acme/project/chat-integrations-a05573177921";
const DOCUMENT_HREF = "https://linear.app/acme/document/link-previews-ebc85c4d4d74";

test.describe("Linear rich link previews", () => {
  test("renders cards for an issue, a project, and a document", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Linear Links");

    const cards = page.locator('[data-testid="linear-link-card"]');
    // Four seeded links (issue + project + document in sentences, plus a bare
    // issue) → four cards, populated by the backend `enrich_link`.
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(4);

    const issue = page.locator(`[data-testid="linear-link-card"][href="${ISSUE_HREF}"]`);
    await expect(issue).toHaveAttribute("data-kind", "issue");
    await expect(issue).toContainText("Show Linear links as rich cards");
    // The identifier is the handle people speak in, so the card must carry it.
    await expect(issue).toContainText("ENG-1");
    await expect(issue).toContainText("Engineering");

    // The raw link in the body is REPLACED by the card, not shown alongside it:
    // exactly one anchor points at the issue (the card), never two.
    await expect(page.locator(`a[href="${ISSUE_HREF}"]`)).toHaveCount(1);

    const project = page.locator(`[data-testid="linear-link-card"][href="${PROJECT_HREF}"]`);
    await expect(project).toHaveAttribute("data-kind", "project");
    await expect(project).toContainText("Chat integrations");

    const document = page.locator(`[data-testid="linear-link-card"][href="${DOCUMENT_HREF}"]`);
    await expect(document).toHaveAttribute("data-kind", "document");
    await expect(document).toContainText("Link previews — system design");

    // Linear's own logomark opens every card's source line, so a reader sees which
    // tracker a card came from — GitLab's card shares this frame on purpose. It is
    // named for a screen reader, and it renders even on a document, whose source
    // line carries nothing else.
    await expect(cards.locator('[data-testid="linear-logo"]')).toHaveCount(4);
    await expect(document.getByRole("img", { name: "Linear" })).toHaveCount(1);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("shows the workflow state, the priority, and a project's progress", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Linear Links");

    // ENG-1 in the mock: state category "unstarted", priority 1 → Urgent.
    const issue = page.locator(`[data-testid="linear-link-card"][href="${ISSUE_HREF}"]`);
    await expect(issue).toHaveAttribute("data-state-type", "unstarted");
    await expect(issue.locator('[data-testid="linear-state"]')).toContainText("Todo");
    const priority = issue.locator('[data-testid="linear-priority"]');
    await expect(priority).toHaveAttribute("data-priority", "1");
    await expect(priority).toContainText("Urgent");

    // ENG-3: priority 3 (Medium) earns no badge — the middle of the scale would
    // put one on nearly every card.
    const bare = page.locator('[data-testid="linear-link-card"][href*="ENG-3"]');
    await expect(bare).toHaveCount(1);
    await expect(bare.locator('[data-testid="linear-priority"]')).toHaveCount(0);
    // It is a sub-issue in the mock, which the card says in words.
    await expect(bare).toContainText("Sub-issue of ENG-100");

    // Only a project carries progress (mock: 0.42 → 42%).
    const progress = page
      .locator(`[data-testid="linear-link-card"][href="${PROJECT_HREF}"]`)
      .locator('[data-testid="linear-progress"]');
    await expect(progress).toHaveAttribute("data-percent", "42");
    await expect(progress).toContainText("42%");
    await expect(issue.locator('[data-testid="linear-progress"]')).toHaveCount(0);

    // A document has no state at all, so it renders no state pill.
    await expect(
      page
        .locator(`[data-testid="linear-link-card"][href="${DOCUMENT_HREF}"]`)
        .locator('[data-testid="linear-state"]'),
    ).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("shows a link-only message as just the card, without a bubble", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Linear Links");

    // The bare-link message renders with no bubble chrome (data-link-only), and
    // holds the integration card.
    const linkOnly = page.locator('[data-testid="message"][data-link-only="true"]');
    await expect(linkOnly).toHaveCount(1);
    await expect(linkOnly.locator('[data-testid="linear-link-card"]')).toHaveCount(1);

    // A message that has surrounding text keeps its bubble (not link-only).
    const issueCard = page.locator(`[data-testid="linear-link-card"][href="${ISSUE_HREF}"]`);
    const sentenceMessage = page.locator('[data-testid="message"]', { has: issueCard });
    await expect(sentenceMessage).not.toHaveAttribute("data-link-only", "true");
  });

  test("a GitLab link in the same app still gets a GitLab card", async ({ page }) => {
    // The two providers share one `enrich_link` and both have an "issue" kind, so
    // the `provider` tag is what keeps them apart. Assert they do not cross over.
    await gotoApp(page);
    await openByPalette(page, "GitLab Links");
    await expect
      .poll(() => page.locator('[data-testid="gitlab-link-card"]').count(), { timeout: 10_000 })
      .toBe(4);
    await expect(page.locator('[data-testid="linear-link-card"]')).toHaveCount(0);

    await openByPalette(page, "Linear Links");
    await expect
      .poll(() => page.locator('[data-testid="linear-link-card"]').count(), { timeout: 10_000 })
      .toBe(4);
    await expect(page.locator('[data-testid="gitlab-link-card"]')).toHaveCount(0);
  });
});

test.describe.serial("Linear settings", () => {
  test("saves an API key, reflects it, then restores it", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();

    // The section is headed by Linear's own mark, so it is recognised before it is
    // read. It is decorative here: the heading beside it already says "Linear".
    const sectionLogo = page.locator('[data-testid="settings-pane"] [data-testid="linear-logo"]');
    await expect(sectionLogo).toHaveCount(1);
    await expect(sectionLogo).toHaveAttribute("aria-hidden", "true");

    // The mock starts with a key configured (Linear has no anonymous read, so the
    // seeded previews need one), which the pane reports without revealing it.
    const remove = page.locator('[data-testid="linear-remove-token"]');
    await expect(remove).toBeVisible();
    await expect(page.locator('[data-testid="linear-token-input"]')).toHaveAttribute(
      "placeholder",
      /leave blank to keep/,
    );

    // Removing the key takes the remove action away with it.
    await remove.click();
    await expect(page.locator('[data-testid="linear-remove-token"]')).toHaveCount(0);
    // With no key there is nothing to enrich, so the seeded cards stop resolving.
    // Reloaded rather than merely navigated: the already-resolved cards live in
    // component state, and it is the fresh lookup that must come back empty.
    await gotoApp(page);
    await openByPalette(page, "Linear Links");
    await expect(page.locator('[data-testid="linear-link-card"]')).toHaveCount(0);
    // The links themselves are still there, as plain anchors.
    await expect(page.locator(`a[href="${ISSUE_HREF}"]`)).toHaveCount(1);

    // Put it back, so the specs above do not depend on running first (one worker,
    // one shared mock — see playwright.config.ts).
    await page.locator('[data-testid="open-settings"]').click();
    await page.locator('[data-testid="linear-token-input"]').fill("lin_api_e2e_test_key");
    await page.locator('[data-testid="linear-save"]').click();
    await expect(page.locator('[data-testid="linear-save-status"]')).toContainText("Saved");
    // The key field is write-only: it is cleared after saving.
    await expect(page.locator('[data-testid="linear-token-input"]')).toHaveValue("");
    await expect(page.locator('[data-testid="linear-remove-token"]')).toBeVisible();

    // And the previews come back.
    await openByPalette(page, "Linear Links");
    await expect
      .poll(() => page.locator('[data-testid="linear-link-card"]').count(), { timeout: 10_000 })
      .toBe(4);
  });
});
