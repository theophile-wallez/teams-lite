import { test, expect, emitPresenceHours, gotoApp } from "./helpers";

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

/** The two hour fields, and the line that says what they buy. */
function fromField(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="available-from"]');
}
function toField(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="available-to"]');
}
function state(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="always-available-state"]');
}

/** Set both hours, which is the one shape the backend stores. The hint names the window
 *  whichever side of it the clock is on, so it is what says the write landed. */
async function setHours(
  page: import("@playwright/test").Page,
  from: string,
  to: string,
): Promise<void> {
  await fromField(page).fill(from);
  await toField(page).fill(to);
  await expect(page.locator('[data-testid="available-hours-hint"]')).toContainText(
    `${from} – ${to}`,
  );
}

/** Hand the hours back to "all day", so one mock process serves the whole run. */
async function clearHours(page: import("@playwright/test").Page): Promise<void> {
  await page.locator('[data-testid="available-all-day"]').click();
  await expect(fromField(page)).toHaveValue("");
  await expect(toField(page)).toHaveValue("");
}

/** One minute of the browser's own day, as `HH:MM`. The mock decides `available_now` on
 *  this process's clock, so a window is aimed relative to now rather than hard-coded —
 *  a spec pinned to 08:00-19:00 would pass all day and fail every night. */
function nowPlusMinutes(offset: number): string {
  const at = new Date(Date.now() + offset * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
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

  // The hours are the point of the feature: green at 03:00 is a dot with nobody behind
  // it. The window is stored, it survives a reload, and the pane says which state it is
  // in — because the machine that decides is the backend, not this tab.
  test("keeps hours, and says nothing is published outside them", async ({ page }) => {
    await gotoApp(page);
    await setAlwaysAvailable(page, true);

    // A window that is running right now: green, and the line names its end.
    const start = nowPlusMinutes(-60);
    const end = nowPlusMinutes(60);
    await setHours(page, start, end);
    await expect(state(page)).toContainText(`green until ${end}`);
    await expect(page.locator('[data-testid="always-available-dot"]')).toHaveClass(
      /bg-emerald-500/,
    );

    // The hours live on the backend, like the switch: a reload must find them.
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    await expect(fromField(page)).toHaveValue(start);
    await expect(toField(page)).toHaveValue(end);

    // A window that has not come round yet: the switch stays on, and NOTHING is
    // published — which the dot and the sentence both say.
    const laterStart = nowPlusMinutes(120);
    const laterEnd = nowPlusMinutes(180);
    await setHours(page, laterStart, laterEnd);
    await expect(state(page)).toContainText(`nothing published until ${laterStart}`);
    await expect(page.locator('[data-testid="always-available-dot"]')).not.toHaveClass(
      /bg-emerald-500/,
    );
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");

    // One end on its own is not a window: nothing is stored, and the pane asks for the
    // other end rather than publishing a guess.
    await fromField(page).fill("");
    await expect(page.locator('[data-testid="available-hours-hint"]')).toContainText(
      "Set both times",
    );
    await expect(state(page)).toContainText(`nothing published until ${laterStart}`);

    // All day is the absence of a window, and the switch alone is then what it always was.
    await fromField(page).fill(laterStart);
    await expect(state(page)).toContainText(laterStart);
    await clearHours(page);
    await expect(state(page)).toContainText("all day");

    // Leave the shared mock as it was found.
    await setAlwaysAvailable(page, false);
  });

  // The hours turn with nobody clicking anything — that is the whole point of them — so the
  // pane has to follow the backend rather than what it last asked for. Without this a
  // Settings pane left open across 19:00 would keep claiming a green dot the backend had
  // already withdrawn.
  test("follows the hours turning while nobody is touching the pane", async ({ page }) => {
    await gotoApp(page);
    await setAlwaysAvailable(page, true);
    const dot = page.locator('[data-testid="always-available-dot"]');
    await expect(dot).toHaveClass(/bg-emerald-500/);

    // The backend's own 19:00: the window is now behind us, and it says so unasked.
    await emitPresenceHours(page, { from: nowPlusMinutes(120), to: nowPlusMinutes(180) });
    await expect(state(page)).toContainText("nothing published until");
    await expect(dot).not.toHaveClass(/bg-emerald-500/);
    // And the fields follow it too — the pane never shows hours the backend does not hold.
    await expect(fromField(page)).toHaveValue(nowPlusMinutes(120));

    // Leave the shared mock as it was found.
    await clearHours(page);
    await setAlwaysAvailable(page, false);
  });
});
