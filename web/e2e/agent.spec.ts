import { expect } from "@playwright/test";
import { test, fetchAgentModes, gotoApp, openConversationAt } from "./helpers";

// The per-conversation switch that lets the local agent answer an `@claude` message
// (see web/src/components/agent-menu.tsx, src/agent_policy.rs), and how the answer is
// drawn as it is written (web/src/components/agent-reply.tsx).
//
// The switch IS the consent gate of the feature: turning it on tells the machine it may
// post an answer under the user's name in that thread. So what this spec pins is the
// default (off, in a conversation nobody named) and the round-trip through the backend
// — never a local guess about the state.
//
// The reply is driven through the mock, which reproduces the flow rather than running a
// CLI: it posts the placeholder, narrates the run on `agent_stream` and edits the message
// on the way (see `simulateMockAgentRun` in web/mock/server.ts). Against the real tenant
// that end is exercised by `examples/agent_stream_probe.rs`, pinned to the sandbox
// channel and nowhere else.

test.describe("The local agent switch", () => {
  test("is off in a conversation nobody opted in, and names the prefix to type", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const trigger = page.locator('[data-testid="agent-menu"]');
    await expect(trigger).toBeVisible();
    // Off is the backend's own default for every conversation but the sandbox, and the
    // trigger publishes the mode so a wrong state is visible without opening anything.
    await expect(trigger).toHaveAttribute("data-agent-mode", "off");

    await trigger.click();
    const toggle = page.locator('[data-testid="agent-mode-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // The mock reports both CLIs as installed, so the hint is the instruction rather
    // than a refusal.
    await expect(page.locator('[data-testid="agent-hint"]')).toContainText("@claude");
  });

  test("opts the open conversation in, and the backend's answer is what shows", async ({
    page,
  }) => {
    await gotoApp(page);
    // A different conversation from the test above: one mock process serves the whole
    // run, so each test owns its own thread and neither depends on the other's order.
    const conversationId = await openConversationAt(page, 1);

    await page.locator('[data-testid="agent-menu"]').click();
    const toggle = page.locator('[data-testid="agent-mode-toggle"]');
    await toggle.click();

    // The menu stays open through the round-trip, so the user sees the switch settle.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-testid="agent-menu"]')).toHaveAttribute(
      "data-agent-mode",
      "reply",
    );

    // What the BACKEND stored, not what the page remembers clicking.
    const stored = await fetchAgentModes(page);
    expect(
      stored.conversations.find((c) => c.conversation === conversationId)?.mode,
    ).toBe("reply");
    // The sandbox stays opted in on its own, which is the one built-in exception.
    expect(stored.conversations.find((c) => c.conversation === stored.sandbox)?.mode).toBe(
      "reply",
    );

    // And off again, because a consent that cannot be withdrawn is not one.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  // The second half of the same consent: what the agent may READ. Before this existed,
  // the allowlist was reachable through a hand-crafted RPC only — which is the same as
  // unreachable, so an `@claude` question about Grafana was refused with nothing the
  // user could switch.
  test("grants one read-only group of tools, and takes it back", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 2);

    await page.locator('[data-testid="agent-menu"]').click();
    const files = page.locator('[data-testid="agent-tool-grant-files"]');
    const grafana = page.locator('[data-testid="agent-tool-grant-grafana"]');
    // The read-only default is what the backend starts at, and the only group on.
    await expect(files).toHaveAttribute("data-granted", "true");
    await expect(grafana).toHaveAttribute("data-granted", "false");

    await grafana.click();
    await expect(grafana).toHaveAttribute("data-granted", "true");

    // What the BACKEND stored, tool by tool — a switch that only changed the page would
    // leave the call refused.
    await expect
      .poll(async () => (await fetchAgentModes(page)).tools)
      .toContain("mcp__grafana__query_prometheus");
    // Granting one group keeps the other: the RPC replaces the whole list, so this is
    // where a lost tool would show.
    expect((await fetchAgentModes(page)).tools).toContain("Read");

    await grafana.click();
    await expect(grafana).toHaveAttribute("data-granted", "false");
    await expect
      .poll(async () => (await fetchAgentModes(page)).tools)
      .not.toContain("mcp__grafana__query_prometheus");
    await expect(files).toHaveAttribute("data-granted", "true");
  });
});

test.describe("The local agent's answer", () => {
  /** Opt the open thread in through its own header — the only place the app offers it. */
  async function optIn(page: import("@playwright/test").Page): Promise<void> {
    await page.locator('[data-testid="agent-menu"]').click();
    await page.locator('[data-testid="agent-mode-toggle"]').click();
    await expect(page.locator('[data-testid="agent-menu"]')).toHaveAttribute(
      "data-agent-mode",
      "reply",
    );
    // Closed with a click, not Escape: the app reads Escape as "close the conversation".
    await page.locator('[data-testid="agent-menu"]').click();
  }

  test("is written into the thread, on the side of what arrives", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 2);
    await optIn(page);

    await page.locator('[data-testid="composer"]').fill("@claude which port is it?");
    await page.keyboard.press("Enter");

    // The run is on screen before a word of the answer is: the mark of the CLI that is
    // answering, and a line saying what it is doing.
    const stream = page.locator('[data-testid="agent-stream"]');
    await expect(stream).toBeVisible();
    await expect(page.locator('[data-testid="agent-status"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="agent-coin"][data-backend="claude"]').first(),
    ).toBeVisible();

    // THE thing this UI exists to get right. The reply went out through the user's own
    // account, so the wire calls it theirs — but they did not write it, and it takes the
    // side of everything that arrives rather than of everything they sent.
    //
    // Located by its signature, which is on the bubble from the placeholder onward — the
    // stream is an overlay and goes when the run ends, so a locator built on it would
    // stop matching exactly when the answer is complete.
    const bubble = page.locator('[data-testid="message"]', {
      has: page.locator('[data-testid="agent-signature"]'),
    });
    await expect(bubble).toHaveAttribute("data-mine", "false");

    // A tool call is named while it runs, which is the whole point of streaming the run
    // rather than only the text. `.first()` because one call replaces the last through an
    // exit animation, so both chips are briefly mounted.
    await expect(page.locator('[data-testid="agent-activity"]').first()).toContainText("Grep");

    // The answer arrives, and it is the CLI's own words — formatted, not a run-on line.
    await expect(stream).toHaveAttribute("data-phase", "writing");
    await expect(bubble).toContainText("19420", { timeout: 20_000 });

    // And when the run ends the overlay goes: the posted message is the record, and it
    // renders on its own from then on (which is what every reply this app never watched
    // being written does).
    await expect(page.locator('[data-testid="agent-status"]')).toHaveCount(0, {
      timeout: 20_000,
    });
    const signature = page.locator('[data-testid="agent-signature"]');
    await expect(signature).toBeVisible();
    await expect(signature).toContainText("via teams-lite");
    // Said ONCE. The posted message carries the same words as its last line — they are
    // what a colleague reads in a real Teams client — and the bubble replaces that line
    // with the mark rather than showing both.
    const shown = (await bubble.innerText()).match(/via teams-lite/g) ?? [];
    expect(shown).toHaveLength(1);
  });

  test("answers nothing in a conversation nobody opted in", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 3);

    await page.locator('[data-testid="composer"]').fill("@claude are you there?");
    await page.keyboard.press("Enter");
    // Our own message lands, and nothing answers it. `off` is the default everywhere but
    // the sandbox, and this is the gate that makes the switch mean something.
    await expect(page.locator('[data-testid="message"]').last()).toContainText(
      "are you there?",
    );
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-testid="agent-stream"]')).toHaveCount(0);
  });
});
