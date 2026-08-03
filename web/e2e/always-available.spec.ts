import { test, expect, gotoApp } from "./helpers";

// "Always available" keeps the user's own Teams status green: the backend registers
// this machine as an endpoint reporting Available and refreshes it every two minutes
// (see `set_always_available` in src/bin/server.rs).
//
// The mock has no tenant to publish presence to — it only remembers the flag, which is
// exactly what makes driving this switch safe. So what a spec can assert is the app's
// own behaviour: off by default, both directions of the switch, and that the choice
// lives on the backend rather than in the tab.

/** The switch in the Settings pane. */
function toggle(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="always-available-toggle"]');
}

/** Open Settings and leave the switch in `on`. */
async function setAlwaysAvailable(
  page: import("@playwright/test").Page,
  on: boolean,
): Promise<void> {
  await page.locator('[data-testid="open-settings"]').click();
  await expect(toggle(page)).toBeVisible();
  if ((await toggle(page).getAttribute("aria-checked")) !== String(on)) {
    await toggle(page).click();
  }
  await expect(toggle(page)).toHaveAttribute("aria-checked", String(on));
}

test.describe("always available", () => {
  test("is off by default, and says Teams decides the status", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();

    const section = page.locator('[data-testid="always-available-settings"]');
    await expect(section).toBeVisible();
    // Off by default: a status the user never asked for is a claim about them.
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    await expect(section).toContainText("Teams decides your status");
  });

  test("turning it on shows the green dot, and the choice survives a reload", async ({
    page,
  }) => {
    await gotoApp(page);
    await setAlwaysAvailable(page, true);

    // The dot is the one bit of the pane that says the status is now green.
    await expect(page.locator('[data-testid="always-available-dot"]')).toHaveClass(
      /bg-emerald-500/,
    );

    // The setting lives on the backend, not in this tab — a reload must find it on.
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");

    // Turning it off is the same outward call, and it must come back off.
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");

    // One mock process serves the whole run: leave the setting as it was found.
    await setAlwaysAvailable(page, false);
  });
});
