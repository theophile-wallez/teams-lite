import { expect } from "@playwright/test";
import { test, fetchAgentModes, gotoApp } from "./helpers";

// Settings → AI providers: which coding agent this machine may run, and on which model
// (see web/src/components/ai-providers-settings.tsx, src/agent_policy.rs).
//
// Every assertion about a stored choice goes through `/__test/agent`, not through the
// control that was just clicked: the row is only worth anything if the BACKEND kept the
// decision. The mock reports `claude` as installed and `opencode` as not, which is the
// state a real machine with one CLI is in — so both halves of the pane are exercised.
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

  test("a suggestion picks the model, and the default can be restored", async ({ page }) => {
    const section = await openProviders(page);
    const claude = section.locator('[data-testid="ai-provider"][data-provider="claude"]');

    // No model chosen: the CLI keeps whatever it is configured for.
    await expect(claude.locator('[data-testid="ai-provider-model-input"]')).toHaveValue("");

    await claude.locator('[data-testid="ai-provider-model-suggestion"][data-value="opus"]').click();
    await expect(claude.locator('[data-testid="ai-provider-model-input"]')).toHaveValue("opus");
    await expect
      .poll(async () => (await fetchAgentModes(page)).providers.find((p) => p.name === "claude")?.model)
      .toBe("opus");

    await claude.locator('[data-testid="ai-provider-model-clear"]').click();
    await expect(claude.locator('[data-testid="ai-provider-model-input"]')).toHaveValue("");
    await expect
      .poll(async () => (await fetchAgentModes(page)).providers.find((p) => p.name === "claude")?.model)
      .toBe(null);
  });

  test("a typed model is saved, and a name that could pass for a flag is refused", async ({
    page,
  }) => {
    const section = await openProviders(page);
    const claude = section.locator('[data-testid="ai-provider"][data-provider="claude"]');
    const input = claude.locator('[data-testid="ai-provider-model-input"]');
    const save = claude.locator('[data-testid="ai-provider-model-save"]');

    // A full model id, not just an alias: the field is free-form on purpose.
    await input.fill("claude-opus-4-5");
    await save.click();
    await expect
      .poll(async () => (await fetchAgentModes(page)).providers.find((p) => p.name === "claude")?.model)
      .toBe("claude-opus-4-5");

    // A model name must never become another flag on the CLI's command line. The
    // backend refuses it, and the row says why rather than pretending it saved.
    await input.fill("--dangerously-skip-permissions");
    await save.click();
    await expect(claude.locator('[data-testid="ai-provider-error"]')).toBeVisible();
    const stored = await fetchAgentModes(page);
    expect(stored.providers.find((p) => p.name === "claude")?.model).toBe("claude-opus-4-5");
  });
});
