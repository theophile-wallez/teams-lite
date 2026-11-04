import { expect, type Page } from "@playwright/test";
import { test, fetchAgentModes, gotoApp, setAgentCli } from "./helpers";

// Settings → AI providers: installing an agent CLI from the app, and keeping it current (see
// web/src/components/agent-cli-install.tsx, src/agent_cli.rs).
//
// The mock downloads nothing and runs nothing: it walks a pretend install through the phases a real
// one passes and sends the frames a real one sends. Out of the box `claude` is the user's own install
// and `opencode` is missing and installable — the state the container image is in for one provider.
// Every spec here arms the mock's `{kind:"agent_cli"}` hook or presses an install, so every one of
// them resets it: one mock process serves the whole run, and an install left behind changes every
// later Settings pane.
//
// What is pinned is the page's half: which press a row offers, that what it costs is stated before
// it is made, that a refusal is said where it was pressed, and that every decision is the
// BACKEND's — read back through `/__test/agent` rather than off the control that was clicked.

async function openProviders(page: Page) {
  await gotoApp(page);
  await page.locator('[data-testid="open-settings"]').click();
  await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();
  const section = page.locator('[data-testid="ai-providers-settings"]');
  await expect(section).toBeVisible();
  return section;
}

function row(section: ReturnType<Page["locator"]>, provider: string) {
  return section.locator(`[data-testid="ai-provider"][data-provider="${provider}"]`);
}

test.describe("Installing an agent CLI", () => {
  test.afterEach(async ({ page }) => {
    await setAgentCli(page, "reset");
  });

  test("a CLI the machine lacks is offered an install that says what it costs", async ({ page }) => {
    const section = await openProviders(page);
    const opencode = row(section, "opencode");
    const action = opencode.locator('[data-testid="agent-cli-action"]');
    await expect(action).toHaveAttribute("data-kind", "install");
    await expect(action).toHaveText("Install");
    // The cost is stated BESIDE the press, before it is made — the size and whose it is.
    await expect(opencode.locator('[data-testid="agent-cli-cost"]')).toContainText(
      "about 80 MB from the opencode project",
    );
    await expect(opencode).toContainText("install it to have it answer");

    // And the user's own install is offered nothing: it is theirs to update.
    await expect(row(section, "claude").locator('[data-testid="agent-cli-action"]')).toHaveCount(0);
  });

  test("an install draws its bar, and ends with the provider able to answer", async ({ page }) => {
    await setAgentCli(page, { hold: true });
    const section = await openProviders(page);
    const opencode = row(section, "opencode");
    await opencode.locator('[data-testid="agent-cli-action"]').click();

    // Held halfway through its download, so the bar is a bar rather than a flash.
    const progress = opencode.locator('[data-testid="agent-cli-progress"]');
    await expect(progress).toBeVisible();
    await expect(opencode.locator('[data-testid="agent-cli-progress-label"]')).toHaveText(
      "Downloading… 50%",
    );
    await expect(opencode.locator('[data-testid="agent-cli"]')).toHaveAttribute("data-phase", "downloading");
    // The provider cannot be switched on mid-install: nothing answers yet.
    await expect(opencode.locator('[data-testid="ai-provider-toggle"]')).toBeDisabled();

    await setAgentCli(page, { release: true });
    await expect(opencode).toHaveAttribute("data-available", "true");
    await expect(opencode.locator('[data-testid="agent-cli"]')).toHaveAttribute("data-managed", "true");
    await expect(opencode.locator('[data-testid="ai-provider-version"]')).toHaveText("1.19.5");
    await expect(opencode.locator('[data-testid="ai-provider-toggle"]')).toBeEnabled();
    await expect(progress).toHaveCount(0);

    // The app never signs a CLI in; it says how the user does, where the app runs.
    await expect(opencode.locator('[data-testid="agent-cli-login-command"]')).toHaveText(
      "teams-lite-agent opencode auth login",
    );

    // And the BACKEND holds it.
    const state = await fetchAgentModes(page);
    expect(state.clis.find((cli) => cli.name === "opencode")).toEqual({
      name: "opencode",
      managed: true,
      version: "1.19.5",
    });
  });

  test("an install that is refused says why where it was pressed", async ({ page }) => {
    await setAgentCli(page, { fail: "the volume holding /data is full — free some room on it, then try again" });
    const section = await openProviders(page);
    const opencode = row(section, "opencode");
    await opencode.locator('[data-testid="agent-cli-action"]').click();

    await expect(opencode.locator('[data-testid="agent-cli-error"]')).toContainText("the volume holding /data is full");
    await expect(opencode).toHaveAttribute("data-available", "false");
    // The press is still there to try again once the cause is mended.
    await expect(opencode.locator('[data-testid="agent-cli-action"]')).toHaveAttribute("data-kind", "install");
  });

  test("a newer release of the copy this app installed is offered as an update", async ({ page }) => {
    await setAgentCli(page, { installed: { opencode: "1.19.4" }, latest: { opencode: "1.19.5" } });
    const section = await openProviders(page);
    const opencode = row(section, "opencode");
    const action = opencode.locator('[data-testid="agent-cli-action"]');
    await expect(action).toHaveAttribute("data-kind", "update");
    await expect(action).toHaveText("Update to 1.19.5");
    await expect(opencode.locator('[data-testid="ai-provider-version"]')).toHaveText("1.19.4");

    await action.click();
    await expect(opencode.locator('[data-testid="ai-provider-version"]')).toHaveText("1.19.5");
    await expect(action).toHaveCount(0);
  });

  test("a machine its vendor publishes no build for is offered no install", async ({ page }) => {
    await setAgentCli(page, { installable: { opencode: false } });
    const section = await openProviders(page);
    const opencode = row(section, "opencode");
    await expect(opencode.locator('[data-testid="agent-cli-action"]')).toHaveCount(0);
    await expect(opencode).toContainText("so it can never answer");
  });

  test("removing the copy this app installed gives the install back", async ({ page }) => {
    await setAgentCli(page, { installed: { opencode: "1.19.5" } });
    const section = await openProviders(page);
    const opencode = row(section, "opencode");
    await expect(opencode).toHaveAttribute("data-available", "true");

    await opencode.locator('[data-testid="agent-cli-remove"]').click();
    await expect(opencode).toHaveAttribute("data-available", "false");
    await expect(opencode.locator('[data-testid="agent-cli-action"]')).toHaveAttribute("data-kind", "install");
    const state = await fetchAgentModes(page);
    expect(state.clis.find((cli) => cli.name === "opencode")?.version).toBeNull();
  });

  test("keeping them current is a switch the backend stores, drawn only once one was installed", async ({
    page,
  }) => {
    const section = await openProviders(page);
    // Nothing this app installed, so nothing for the switch to decide.
    await expect(section.locator('[data-testid="agent-cli-updates"]')).toHaveCount(0);

    await setAgentCli(page, { installed: { opencode: "1.19.5" } });
    const updates = section.locator('[data-testid="agent-cli-updates"]');
    await expect(updates).toBeVisible();
    const toggle = updates.locator('[data-testid="agent-cli-auto-update"]');
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await fetchAgentModes(page)).cli_auto_update).toBe(false);

    await updates.locator('[data-testid="agent-cli-check"]').click();
    await expect(updates.locator('[data-testid="agent-cli-checked"]')).toHaveText("Checked just now");
  });
});
