import { expect } from "@playwright/test";
import { test, fetchAgentModes, gotoApp, openConversationAt } from "./helpers";

// The per-conversation switch that lets the local agent answer an `@claude` message
// (see web/src/components/agent-menu.tsx, src/agent_policy.rs).
//
// The switch IS the consent gate of the feature: turning it on tells the machine it may
// post an answer under the user's name in that thread. So what this spec pins is the
// default (off, in a conversation nobody named) and the round-trip through the backend
// — never a local guess about the state. The reply itself is not driven here: it runs a
// CLI on the backend's machine, which the mock has none of; `examples/agent_stream_probe
// .rs` is what exercises that end, against the sandbox channel and nothing else.

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
