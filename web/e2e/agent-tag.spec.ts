import { test, expect, fetchCapturedSends, gotoApp } from "./helpers";
import type { Page } from "@playwright/test";

// Tagging an AGENT in the composer: the same "@" that mentions a colleague also offers
// the CLIs this machine can run, and a picked one becomes a chip in that vendor's own
// colour (see web/src/components/agent-tag-extension.ts).
//
// What the specs below pin is the difference between the two kinds of tag, because it is
// the whole point of having two:
//
//   - a person mention travels as a PAIR (an indexed span plus who it names) and notifies
//     somebody;
//   - an agent tag travels as the PLAIN PREFIX and notifies nobody — it starts a program
//     on the backend's machine, which is what `agent_policy::split_prefix` reads back.
//
// Everything happens in the "Agent Sandbox" thread, the one the backend's own policy opts
// in out of the box (`seedAgentSandbox` in web/mock/server.ts). No test switches anything
// on first, so this also pins that default — and no other spec types in that thread.
test.describe("agent tags", () => {
  const editable = '[data-testid="composer-rich"] .tiptap-message';
  const suggestions = '[data-testid="mention-suggestions"]';
  const options = '[data-testid="mention-suggestion"]';
  const agentOptions = `${options}[data-kind="agent"]`;
  const chip = `${editable} [data-testid="agent-tag"]`;

  /** Open the sandbox thread and empty the composer.
   *
   *  The field is cleared on purpose: one mock process serves the whole run and it
   *  persists drafts, so whatever an earlier test left here is still in front of the
   *  caret — and a leftover word is not a mention query. */
  async function openSandbox(page: Page) {
    await gotoApp(page);
    await page.keyboard.press("Control+k");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();
    await input.fill("Agent Sandbox");
    await input.press("Enter");
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText(
      "Agent Sandbox",
    );
    await page.locator(editable).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(page.locator(editable)).toHaveText("");
    return page.locator(editable);
  }

  test("an @ opening the message offers the agent above the people", async ({ page }) => {
    await openSandbox(page);
    await page.keyboard.type("@");
    await expect(page.locator(suggestions)).toBeVisible();
    // The mock holds `claude` and not `opencode`, so exactly one agent is offered: a row
    // is drawn for a CLI that would really answer, never for one this machine lacks.
    await expect(page.locator(agentOptions)).toHaveCount(1);
    await expect(page.locator(agentOptions)).toHaveAttribute("data-agent", "claude");
    await expect(page.locator(options).first()).toHaveAttribute("data-kind", "agent");
    // The people are still there, under it.
    await expect(page.locator(`${options}[data-kind="person"]`).first()).toBeVisible();
  });

  test("no agent is offered once the @ is not the start of the message", async ({ page }) => {
    await openSandbox(page);
    // The backend summons an agent from the prefix the message OPENS with, so a chip
    // anywhere else would promise a run that never happens.
    await page.keyboard.type("as we said @cl");
    await expect(page.locator(agentOptions)).toHaveCount(0);
    // …and the same query at the start does offer it, so this is the position and not
    // the letters.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("@cl");
    await expect(page.locator(agentOptions)).toHaveCount(1);
  });

  test("the picked agent becomes one chip carrying its mark and its name", async ({ page }) => {
    await openSandbox(page);
    await page.keyboard.type("@cl");
    await page.locator(agentOptions).click();
    await expect(page.locator(suggestions)).toHaveCount(0);
    await expect(page.locator(chip)).toHaveAttribute("data-agent", "claude");
    await expect(page.locator(chip)).toContainText("Claude");
    // The vendor's own artwork, not a generic glyph — the mark is what says which
    // program the message would start.
    await expect(page.locator(`${chip} [data-testid="claude-logo"]`)).toHaveCount(1);
    // It is not a mention: a mention promises to notify a person, and this notifies none.
    await expect(page.locator(`${editable} .composer-mention`)).toHaveCount(0);
  });

  test("one Backspace removes the tag whole", async ({ page }) => {
    await openSandbox(page);
    await page.keyboard.type("@cl");
    await page.locator(agentOptions).click();
    await expect(page.locator(chip)).toHaveCount(1);
    // Insertion leaves a trailing space (the prefix needs one), so the first keystroke
    // deletes that space. Then the tag goes in one — there is no half of a prefix.
    await page.keyboard.press("Backspace");
    await expect(page.locator(chip)).toHaveCount(1);
    await page.keyboard.press("Backspace");
    await expect(page.locator(chip)).toHaveCount(0);
    await expect(page.locator(editable)).toHaveText("");
  });

  test("the sent message carries the plain prefix, no mention — and summons the agent", async ({
    page,
  }) => {
    await openSandbox(page);
    await page.keyboard.type("@cl");
    await page.locator(agentOptions).click();
    const marker = `tag-${Date.now()}`;
    await page.keyboard.type(`${marker} which port?`);
    await page.keyboard.press("Enter");

    const sends = await fetchCapturedSends(page);
    const sent = sends.filter((send) => send.content_html?.includes(marker)).pop();
    // The body is what the user would have typed by hand: no markup that would show as
    // coloured text in another client while summoning nothing.
    expect(sent?.content_html).toContain(`@claude ${marker}`);
    expect(sent?.content_html).not.toContain("schema.skype.com/Mention");
    expect(sent?.content_html).not.toContain("data-agent-tag");
    expect(sent?.mentions ?? []).toEqual([]);

    // And it really is a trigger: the mock answers it the way the backend does, so the
    // thread shows the reply the tag asked for.
    const answering = page
      .locator('[data-testid="agent-stream"], [data-testid="agent-signature"]')
      .first();
    await expect(answering).toBeVisible({ timeout: 30_000 });
  });
});
