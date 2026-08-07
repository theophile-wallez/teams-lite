import { test, expect, gotoApp, openConversationNamed } from "./helpers";
import type { Page } from "@playwright/test";

// A TRACKER REFERENCE in somebody's words: a Linear issue (`ENG-1`) or a GitLab merge
// request (`!42`) written as text, drawn as the chip that goes to the thing it names — Linear
// for an issue, THIS APP's own merge-request page for a merge request (see
// web/src/lib/tracker-ref.ts).
//
// The pure rules are unit-tested in tracker-ref.test.ts. What these specs pin is what only a
// running app can say:
//
//   * the chip is drawn on the surfaces the feature promises — a chat message, an agent's own
//     answer, a merge request's description — and the words the author wrote are still there;
//   * a merge-request chip NAVIGATES inside the app, so the reader lands on the page that
//     holds the diff and the pipeline rather than on GitLab's;
//   * a Linear chip leaves for Linear, in a tab of its own;
//   * the project a bare `!42` belongs to comes from the surface it is written on.
test.describe("tracker references", () => {
  const chip = '[data-testid="tracker-ref"]';
  const gitlabChip = `${chip}[data-tracker="gitlab"]`;
  const linearChip = `${chip}[data-tracker="linear"]`;

  /** The seeded thread that names both trackers in words: a bare `!99`, `ENG-1`, and one
   *  word — `UTF-8` — that only looks like a reference. */
  async function openTrackerThread(page: Page) {
    await gotoApp(page);
    await openConversationNamed(page, "GitLab Links");
    await expect(page.locator(chip).first()).toBeVisible();
  }

  test("draws a bare merge request reference and a Linear identifier as chips", async ({
    page,
  }) => {
    await openTrackerThread(page);
    const bubble = page.locator('[data-testid="message"]:has([data-testid="tracker-ref"])').last();

    // `!99` names a merge request of the project the message itself names — GitLab's own rule
    // for a bare reference — and it points at THIS app's page for it.
    const mr = bubble.locator(`${gitlabChip}[data-reference="!99"]`);
    await expect(mr).toHaveAttribute("href", "/mr/acme%2Fwebapp!99");
    await expect(mr).toHaveText("!99");

    // The project came from the QUOTE, whose own URL is drawn as the chip for the merge request
    // it addresses: a quoted line is one line, and a URL fills it.
    const quoted = bubble.locator('[data-testid="message-quote"]').locator(gitlabChip);
    await expect(quoted).toHaveAttribute("href", "/mr/acme%2Fwebapp!42");

    // `ENG-1` goes to Linear, addressed in the workspace the backend reported.
    const issue = bubble.locator(linearChip);
    await expect(issue).toHaveAttribute("href", "https://linear.app/acme/issue/ENG-1");
    await expect(issue).toHaveAttribute("target", "_blank");
    await expect(issue).toHaveText("ENG-1");

    // And the words around them are untouched, `UTF-8` included: a word that only looks like
    // an identifier stays the word it is, and nothing the author wrote was replaced.
    await expect(bubble).toContainText("UTF-8 is untouched");
    await expect(bubble.locator(`${chip}:text-is("UTF-8")`)).toHaveCount(0);
  });

  test("a merge request chip opens this app's own page for it", async ({ page }) => {
    await openTrackerThread(page);
    const bubble = page.locator('[data-testid="message"]:has([data-testid="tracker-ref"])').last();
    await bubble.locator(`${gitlabChip}[data-reference="!99"]`).click();

    // The route changed — no reload, no link out — and the page that came up is the merge
    // request the chip named.
    await expect(page).toHaveURL(/\/mr\/acme%2Fwebapp!99/);
    await expect(page.locator('[data-testid="gitlab-pane"]')).toBeVisible();
  });

  test("a reference in an agent's own answer is a chip, and one in code is not", async ({
    page,
  }) => {
    // Where this began: an agent writes `acme/webapp!596` and `ENG-1` as bare words, because
    // that is what a person writes — there is no markup in the answer to restore a chip from.
    await gotoApp(page);
    await openConversationNamed(page, "Agent Sandbox");
    const editable = page.locator('[data-testid="composer-rich"] .tiptap-message');
    await editable.click();
    await page.keyboard.type("@claude which port does the backend listen on?");
    await page.keyboard.press("Enter");

    const reply = page
      .locator('[data-testid="message"]:has([data-testid="agent-signature"])')
      .last();
    await expect(reply.locator(gitlabChip)).toBeVisible({ timeout: 30_000 });
    await expect(reply.locator(gitlabChip)).toHaveAttribute("href", "/mr/acme%2Fwebapp!596");
    await expect(reply.locator(linearChip)).toHaveAttribute(
      "href",
      "https://linear.app/acme/issue/ENG-1",
    );
    // The answer also writes `!596` inside a code span, explaining how to name one. That is
    // syntax, so it stays syntax: the chips are the two above and no more.
    await expect(reply.locator(chip)).toHaveCount(2);
    await expect(reply.locator("code", { hasText: "!596" })).toBeVisible();
  });

  test("a merge request's own description resolves a bare reference against its project", async ({
    page,
  }) => {
    // The surface says which project the words are in, which is the one thing a chat message
    // has no way to say (see `TrackerProjectProvider`).
    await gotoApp(page);
    await page.locator('[data-testid="tab-gitlab"]').click();
    await page.locator('[data-testid="gitlab-row"][data-iid="596"]').click();
    const description = page.locator('[data-testid="gitlab-description"]');
    await expect(description).toBeVisible();

    await expect(description.locator(gitlabChip)).toHaveAttribute("href", "/mr/acme%2Fwebapp!595");
    await expect(description.locator(linearChip)).toHaveAttribute(
      "href",
      "https://linear.app/acme/issue/ENG-1",
    );
    // The same rule as everywhere else: the word that only looks like one is left alone.
    await expect(description).toContainText("UTF-8");
    await expect(description.locator(`${chip}:text-is("UTF-8")`)).toHaveCount(0);
  });
});
