import { expect } from "@playwright/test";
import { test, fetchAgentModes, gotoApp, setAgentProviders } from "./helpers";

// Settings → AI providers: which coding agent this machine may run, and on which model
// (see web/src/components/ai-providers-settings.tsx, src/agent_policy.rs).
//
// Every assertion about a stored choice goes through `/__test/agent`, not through the
// control that was just clicked: the row is only worth anything if the BACKEND kept the
// decision. The mock reports `claude` as installed and `opencode` as not, which is the
// state a real machine with one CLI is in — so both halves of the pane are exercised.
//
// The model list itself comes from the backend, per machine (`agent_models::choices`
// reads opencode's own catalogue), so the mock stands in for it with `claude`'s four
// aliases. What these specs pin is the control, not the catalogue: a chosen model is
// stored, the default is reachable, and a model nobody listed can still be typed.
//
// Nothing here runs an agent. That needs a real CLI and a real tenant, and
// `examples/agent_stream_probe.rs` is the sanctioned way to try it.

async function openProviders(page: import("@playwright/test").Page) {
  await gotoApp(page);
  await page.locator('[data-testid="open-settings"]').click();
  await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();
  const section = page.locator('[data-testid="ai-providers-settings"]');
  await expect(section).toBeVisible();
  return section;
}

test.describe("AI providers", () => {
  test("lists every provider, and marks the one this machine has no CLI for", async ({ page }) => {
    const section = await openProviders(page);
    const rows = section.locator('[data-testid="ai-provider"]');
    await expect(rows).toHaveCount(2);

    const claude = section.locator('[data-testid="ai-provider"][data-provider="claude"]');
    const opencode = section.locator('[data-testid="ai-provider"][data-provider="opencode"]');

    // Installed and on out of the box — the default the backend applies.
    await expect(claude).toHaveAttribute("data-available", "true");
    await expect(claude).toHaveAttribute("data-enabled", "true");
    await expect(claude.locator('[data-testid="ai-provider-toggle"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Not installed: the row says so, and its switch cannot be used — a control whose
    // only effect would be a silent thread is worse than none.
    await expect(opencode).toHaveAttribute("data-available", "false");
    await expect(
      opencode.locator('[data-testid="ai-provider-availability"][data-state="missing"]'),
    ).toBeVisible();
    await expect(opencode.locator('[data-testid="ai-provider-toggle"]')).toBeDisabled();
  });

  test("turning a provider off is stored by the backend", async ({ page }) => {
    const section = await openProviders(page);
    const claude = section.locator('[data-testid="ai-provider"][data-provider="claude"]');
    const toggle = claude.locator('[data-testid="ai-provider-toggle"]');

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    const stored = await fetchAgentModes(page);
    expect(stored.providers.find((p) => p.name === "claude")?.enabled).toBe(false);

    // And back on, because a switch that cannot be undone is not a setting.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const again = await fetchAgentModes(page);
    expect(again.providers.find((p) => p.name === "claude")?.enabled).toBe(true);
  });

  test("the select offers the machine's own models, and picking one stores it", async ({ page }) => {
    const section = await openProviders(page);
    const claude = section.locator('[data-testid="ai-provider"][data-provider="claude"]');
    const select = claude.locator('[data-testid="ai-provider-model-select"]');

    // No model chosen: the CLI keeps whatever it is configured for, and the row says
    // so rather than showing an empty control.
    await expect(select).toHaveAttribute("data-value", "");
    await expect(select).toContainText("Default");

    await select.click();
    // Each entry reads as a model: the vendor's name for it, and what it holds.
    const option = page.locator('[data-testid="ai-provider-model-option"][data-value="opus"]');
    await expect(option).toContainText("Opus 5");
    await expect(option).toContainText("1M context");
    await option.click();

    // The trigger shows the stored choice, and the BACKEND is what proves it.
    await expect(select).toHaveAttribute("data-value", "opus");
    await expect(select).toContainText("Opus 5");
    await expect
      .poll(async () => (await fetchAgentModes(page)).providers.find((p) => p.name === "claude")?.model)
      .toBe("opus");

    // Back to the CLI's own default, which is an entry of the list rather than an
    // empty field to clear.
    await select.click();
    await page.locator('[data-testid="ai-provider-model-default"]').click();
    await expect(select).toHaveAttribute("data-value", "");
    await expect
      .poll(async () => (await fetchAgentModes(page)).providers.find((p) => p.name === "claude")?.model)
      .toBe(null);
  });

  test("a model this machine does not list is still typed in, and a flag is refused", async ({
    page,
  }) => {
    const section = await openProviders(page);
    const claude = section.locator('[data-testid="ai-provider"][data-provider="claude"]');
    const select = claude.locator('[data-testid="ai-provider-model-select"]');
    const search = page.locator('[data-testid="ai-provider-model-search"]');
    const typed = page.locator('[data-testid="ai-provider-model-custom"]');

    // A full model id, not one of the aliases the backend lists: the list is a picker
    // and never the limit, so the search field doubles as the entry.
    await select.click();
    await search.fill("claude-opus-4-5");
    await typed.click();
    await expect(select).toHaveAttribute("data-value", "claude-opus-4-5");
    await expect
      .poll(async () => (await fetchAgentModes(page)).providers.find((p) => p.name === "claude")?.model)
      .toBe("claude-opus-4-5");

    // A model name must never become another flag on the CLI's command line. The
    // backend refuses it, and the row says why rather than pretending it saved.
    await select.click();
    await search.fill("--dangerously-skip-permissions");
    await typed.click();
    await expect(claude.locator('[data-testid="ai-provider-error"]')).toBeVisible();
    const stored = await fetchAgentModes(page);
    expect(stored.providers.find((p) => p.name === "claude")?.model).toBe("claude-opus-4-5");
    // And the trigger still shows what IS stored, not what was refused.
    await expect(select).toHaveAttribute("data-value", "claude-opus-4-5");
  });

  // The default provider: which single one a message's ⋯ menu offers. Claude Code out of
  // the box, and moved by naming the other one — there is always exactly one, so the row
  // that has it shows a chip and offers no switch to clear.
  test("claude is the default, and the other row takes it over", async ({ page }) => {
    // Both CLIs installed: a machine with one usable provider could not tell a default
    // apart from the only choice.
    await setAgentProviders(page, { available: { opencode: true } });
    try {
      const section = await openProviders(page);
      const claude = section.locator('[data-testid="ai-provider"][data-provider="claude"]');
      const opencode = section.locator('[data-testid="ai-provider"][data-provider="opencode"]');

      await expect(claude).toHaveAttribute("data-default", "true");
      await expect(claude.locator('[data-testid="ai-provider-default"]')).toHaveAttribute(
        "data-state",
        "on",
      );
      // Exactly one provider carries it, so the chip is not a switch: the way to move it
      // is the button on the other row.
      await expect(claude.locator('button[data-testid="ai-provider-default"]')).toHaveCount(0);

      await opencode.locator('[data-testid="ai-provider-default"][data-state="off"]').click();
      await expect(opencode).toHaveAttribute("data-default", "true");
      await expect(claude).toHaveAttribute("data-default", "false");
      // And the BACKEND is what proves it, not the chip that just moved.
      await expect.poll(async () => (await fetchAgentModes(page)).default_provider).toBe("opencode");
    } finally {
      await setAgentProviders(page, "reset");
    }
  });

  // A provider that would never answer must not be offered the default either: the menu
  // falls back to what does answer, so the setting would decide nothing.
  test("a provider that cannot answer is offered no default", async ({ page }) => {
    const section = await openProviders(page);
    const opencode = section.locator('[data-testid="ai-provider"][data-provider="opencode"]');
    await expect(opencode).toHaveAttribute("data-available", "false");
    await expect(opencode.locator('[data-testid="ai-provider-default"]')).toHaveCount(0);
  });

  test("a provider reads by its own name and mark", async ({ page }) => {
    const section = await openProviders(page);
    // "Claude", not "claude": the RPC spelling stays lowercase, and the pane is the one
    // place that reads as a product name.
    await expect(
      section.locator('[data-testid="ai-provider"][data-provider="claude"]'),
    ).toContainText("Claude");
    await expect(
      section.locator('[data-testid="ai-provider"][data-provider="opencode"]'),
    ).toContainText("OpenCode");
    // Each vendor's own artwork, which is what the eye finds before it reads.
    await expect(section.locator('[data-testid="claude-logo"]').first()).toBeVisible();
    await expect(section.locator('[data-testid="opencode-logo"]').first()).toBeVisible();
  });
});
