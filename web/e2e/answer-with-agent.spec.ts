import {
  test,
  expect,
  fetchCapturedSends,
  gotoApp,
  openConversationNamed,
  setAgentProviders,
} from "./helpers";
import type { Page } from "@playwright/test";

// "Answer with <agent>" in a message's ⋯ menu: the composer's agent tag, reached from the
// message instead of from the keyboard (see web/src/lib/agent-answer.ts).
//
// Three rules make it the same feature rather than a second one, and each is pinned
// below:
//
//   - it DRAFTS and never sends — the request is written, the Enter stays the user's;
//   - it is offered only where an agent would really answer, which is the thread's own
//     opt-in and nothing this menu may widen;
//   - the draft is a REPLY whose body opens with the plain prefix — the backend reads an
//     address wherever it stands (`agent_policy::split_prefix`), and the front is where a
//     sentence the user did not type should start — and the quote is how it knows which
//     message the request is about (`agent_policy::answering`).
//
// Everything happens in the "Agent Sandbox" thread — the one the backend's own policy opts
// in out of the box (`seedAgentSandbox` in web/mock/server.ts) — except the one test that
// proves the row is absent everywhere else.
test.describe("answer with an agent", () => {
  const editable = '[data-testid="composer-rich"] .tiptap-message';
  const chip = `${editable} [data-testid="agent-tag"]`;
  const row = '[data-testid="action-answer-with"]';

  /** Open the sandbox thread and empty the composer. The mock persists drafts, so
   *  whatever an earlier test left here is still in front of the caret. */
  async function openSandbox(page: Page) {
    await gotoApp(page);
    await openConversationNamed(page, "Agent Sandbox");
    await page.locator(editable).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(page.locator(editable)).toHaveText("");
  }

  /** Open the ⋯ menu of the thread's first message. */
  async function openMessageMenu(page: Page) {
    const bubble = page.locator('[data-testid="message"]').first();
    await expect(bubble).toBeVisible();
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    return bubble;
  }

  test("offers one row, wearing the mark of the agent it starts", async ({ page }) => {
    await openSandbox(page);
    await openMessageMenu(page);
    // The mock holds `claude` and not `opencode`, so a CLI this machine lacks is never
    // offered — exactly as in the composer's own list.
    await expect(page.locator(row)).toHaveCount(1);
    await expect(page.locator(row)).toHaveAttribute("data-agent", "claude");
    await expect(page.locator(row)).toContainText("Answer with Claude");
    // The vendor's own artwork, not a glyph of ours — it says which program the row starts.
    await expect(page.locator(`${row} [data-testid="claude-logo"]`)).toHaveCount(1);
  });

  // The menu names the DEFAULT provider and only it, even on a machine that holds two:
  // this is a column of actions on one message, and a row per vendor would ask the reader
  // to choose a program before they have said what they want. Settings › AI providers is
  // where that choice is made (see `defaultUsableBackends`).
  test("offers the default provider alone on a machine holding two", async ({ page }) => {
    await setAgentProviders(page, { available: { opencode: true } });
    try {
      await openSandbox(page);
      await openMessageMenu(page);
      await expect(page.locator(row)).toHaveCount(1);
      await expect(page.locator(row)).toHaveAttribute("data-agent", "claude");

      // Away from the menu through the MOUSE: an open menu is modal, so it is the only
      // layer taking pointer events, and Escape is read by the app as "leave this
      // conversation" (see delete-message.spec.ts for the same pair of reasons).
      await page.mouse.click(5, 5);
      await expect(page.locator('[data-testid="action-reply"]')).toHaveCount(0);
      await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");

      // The composer's own "@" is the other case: the user is reading that list, so it
      // still offers both PROVIDERS — and their own custom agents under them, which this menu
      // deliberately never grows a row for (see § CUSTOM AGENTS). The menu narrows; it never
      // narrows the keyboard.
      await page.locator(editable).click();
      await page.keyboard.type("@");
      const suggestions = page.locator(
        '[data-testid="mention-suggestion"][data-kind="agent"]:not([data-persona])',
      );
      await expect(suggestions).toHaveCount(2);

      // Name the other provider, and the menu follows. The reload clears the "@" with it.

      await setAgentProviders(page, { default: "opencode" });
      await openSandbox(page);
      await openMessageMenu(page);
      await expect(page.locator(row)).toHaveCount(1);
      await expect(page.locator(row)).toHaveAttribute("data-agent", "opencode");
    } finally {
      await setAgentProviders(page, "reset");
    }
  });

  test("offers nothing in a conversation nobody opted in", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Mention Demo");
    await openMessageMenu(page);
    // `off` is the default everywhere, and this menu is not a way around it: the consent
    // lives in the thread's own header.
    await expect(page.locator(row)).toHaveCount(0);
  });

  test("writes the request as a reply and sends nothing", async ({ page }) => {
    await openSandbox(page);
    const before = (await fetchCapturedSends(page)).length;
    await openMessageMenu(page);
    await page.locator(row).click();

    // The tag leads the draft, with the request the backend needs after it (a bare
    // prefix summons nothing), and the banner says which message the answer is about.
    await expect(page.locator(chip)).toHaveAttribute("data-agent", "claude");
    await expect(page.locator(editable)).toContainText("Answer this message.");
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    // Nothing left the machine: the send is the user's own Enter.
    expect((await fetchCapturedSends(page)).length).toBe(before);
  });

  test("keeps a half-written draft as the request", async ({ page }) => {
    await openSandbox(page);
    await page.locator(editable).click();
    await page.keyboard.type("what did they mean by that?");
    await openMessageMenu(page);
    await page.locator(row).click();

    // The user's own words are the request; only the tag is added, and at the front,
    // which is the one place it summons anything.
    await expect(page.locator(chip)).toHaveCount(1);
    await expect(page.locator(editable)).toContainText("what did they mean by that?");
    await expect(page.locator(editable)).not.toContainText("Answer this message.");
  });

  test("drops the request once the reader leaves the thread", async ({ page }) => {
    await openSandbox(page);
    await openMessageMenu(page);
    await page.locator(row).click();
    await expect(page.locator(chip)).toHaveCount(1);

    // Away to another thread and back. The request was spent where it was asked, so the
    // composer does not write the tag a second time over a draft the user has already
    // dealt with — the words they left are still theirs, as plain text.
    //
    // The header is clicked first only to take focus out of the field: the composer reads
    // Cmd/Ctrl+K as "add a link", so the palette below needs the caret elsewhere.
    await page.locator('[data-testid="conversation-title"]').click();
    await openConversationNamed(page, "Mention Demo");
    await openConversationNamed(page, "Agent Sandbox");
    await expect(page.locator(chip)).toHaveCount(0);
    await expect(page.locator(editable)).toContainText("Answer this message.");
  });

  test("the sent draft is a reply that summons the agent", async ({ page }) => {
    await openSandbox(page);
    await openMessageMenu(page);
    await page.locator(row).click();
    await expect(page.locator(chip)).toHaveCount(1);

    const marker = `answer-${Date.now()}`;
    await page.keyboard.type(` ${marker}`);
    await page.keyboard.press("Enter");

    const sends = await fetchCapturedSends(page);
    const sent = sends.filter((send) => send.content_html?.includes(marker)).pop();
    // The plain prefix opening the body, and nothing that would notify a colleague.
    expect(sent?.content_html).toContain("@claude Answer this message.");
    expect(sent?.content_html).not.toContain("data-agent-tag");
    expect(sent?.mentions ?? []).toEqual([]);

    // It really is a reply — the bubble quotes the message it answers…
    const mine = page.locator('[data-testid="message"]', { hasText: marker }).last();
    await expect(mine.locator('[data-testid="quote-sender"]')).toBeVisible();
    // …and really is a trigger: the mock answers it the way the backend does, quote and
    // all (`teams_read::strip_quoted_blocks` is what lets the prefix still open the body).
    const answering = page
      .locator('[data-testid="agent-stream"], [data-testid="agent-signature"]')
      .first();
    await expect(answering).toBeVisible({ timeout: 30_000 });

    // Wait for the run to END before the test does. One mock process serves the whole
    // run: a run still writing frames into this thread keeps re-rendering its bubble, and
    // the next spec to open the thread clicks a moving target.
    await expect(page.locator('[data-testid="agent-status"]')).toHaveCount(0, {
      timeout: 30_000,
    });
  });
});
