import { test, expect, gotoApp, emitUpdate, realErrors } from "./helpers";

// The update is two clicks: download the new build, then restart onto it. It used to be
// an eleven-pixel link asking the user to go and reinstall the app by hand, in the status
// line, where it also hid whatever that line was trying to say.
//
// Everything here runs against the mock's own update — no GitHub, no binary, and no
// restart, because a mock has nothing to restart. That last part is not a gap: it is the
// `installed` phase the real backend reports when nothing puts the app back up, so the
// spec exercises a state the app really has.
test.describe("in-app update", () => {
  // The mock is shared and adopted across runs, so an update left armed would add this
  // row to every later sidebar — and move every layout assertion under it.
  test.afterEach(async ({ page }) => {
    await emitUpdate(page, { available: false });
  });

  test("says nothing while this build is current", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await expect(page.locator('[data-testid="update-control"]')).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("offers the download, then the restart, and shows the progress between them", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    const control = page.locator('[data-testid="update-control"]');
    await expect(control).toHaveCount(0);

    await emitUpdate(page, { latest: "def5678" });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("data-phase", "idle");

    // FIRST CLICK. The button says an update exists and what it costs — never which
    // build, since a commit sha is a fault code to whoever reads it. The cost is stated
    // because this may be a phone on a metered connection, which is also why nothing
    // downloads on its own.
    const button = page.getByTestId("update-button");
    await expect(button).toHaveText(/^\s*Update available\s*$/);
    await expect(button).not.toContainText("def5678");
    await expect(page.getByTestId("update-detail")).toContainText("Downloads 133 MB.");
    const before = await button.boundingBox();
    await button.click();

    // The progress is a fill inside the button, and the percent is on the button itself
    // so it can be read without measuring pixels. It takes the place of the words that
    // were pressed, and the button stays where it was while it does.
    await expect(control).toHaveAttribute("data-phase", "downloading");
    await expect(button).toHaveText(/Downloading… \d+%/);
    await expect(button).toBeDisabled();
    await expect(page.getByTestId("update-progress-fill")).toBeVisible();
    const during = await button.boundingBox();
    expect(Math.abs((during?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);

    // SECOND CLICK. Downloaded, and now it is a restart — a separate, deliberate press.
    await expect(control).toHaveAttribute("data-phase", "ready", { timeout: 10_000 });
    const restart = page.getByTestId("update-button");
    await expect(restart).toHaveText(/Restart to update/);
    await expect(restart).toBeEnabled();
    await restart.click();

    // Restarting, then — because nothing here restarts an app — the honest end state,
    // which names the one thing left for the user to do.
    await expect(control).toHaveAttribute("data-phase", "restarting");
    await expect(page.getByTestId("update-button")).toBeDisabled();
    await expect(control).toHaveAttribute("data-phase", "installed", { timeout: 10_000 });
    await expect(page.getByTestId("update-note")).toContainText("Update installed");
    await expect(page.getByTestId("update-detail")).toContainText("next time you start it");
    await expect(page.getByTestId("update-button")).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // An install this app cannot replace — the staged always-on service, which runs
  // artifacts built from a checkout — keeps exactly what it had before there was a
  // button. Never a dead button, and never a click that would report success while the
  // service kept running what it had.
  test("keeps a link for an install it cannot replace itself", async ({ page }) => {
    await gotoApp(page);
    await emitUpdate(page, { can_install: false, latest: "def5678" });

    const control = page.locator('[data-testid="update-control"]');
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("data-shape", "link");
    const link = page.getByTestId("update-link");
    await expect(link).toHaveText(/Update available/);
    await expect(link).not.toContainText("def5678");
    await expect(link).toHaveAttribute("href", /releases/);
    await expect(page.getByTestId("update-button")).toHaveCount(0);
  });

  // A phone that opens the app in the middle of a download has to draw the bar it is
  // already in: the backend replays both the release and the phase on every connection,
  // and this is the half of that contract the page has to keep.
  test("a page that opens mid-download joins the progress", async ({ page }) => {
    await gotoApp(page);
    await emitUpdate(page, { latest: "def5678" });
    await page.getByTestId("update-button").click();
    await expect(page.locator('[data-testid="update-control"]')).toHaveAttribute(
      "data-phase",
      "downloading",
    );

    await page.reload();
    const control = page.locator('[data-testid="update-control"]');
    // Either still downloading, or already finished while the page was reloading — both
    // are the state the backend held, and neither is an untouched button.
    await expect(control).toHaveAttribute("data-phase", /downloading|ready/);
  });

  // A restart ends with the backend gone and a NEW one answering — current, so it
  // announces no update. The page has to end up with an empty row rather than the
  // "Restarting…" it was drawing when the socket went away (that phase deliberately
  // survives a disconnect, which is exactly what would make it stick).
  test("stops saying anything once the app has come back on the new build", async ({ page }) => {
    await gotoApp(page);
    const control = page.locator('[data-testid="update-control"]');
    await emitUpdate(page, { latest: "def5678" });
    await page.getByTestId("update-button").click();
    await expect(control).toHaveAttribute("data-phase", "ready", { timeout: 10_000 });
    await page.getByTestId("update-button").click();
    await expect(control).toHaveAttribute("data-phase", "restarting");

    await emitUpdate(page, { restarted: true });

    await expect(control).toHaveCount(0, { timeout: 30_000 });
    // And the app is working again, not merely quiet.
    await expect(page.locator('[data-testid="conversation-row"]').first()).toBeVisible();
  });

  // The notice used to live in the status line, where it REPLACED the connection text —
  // and hid a real `error:` during a sign-in outage. It has its own row now.
  test("never covers the status line", async ({ page }) => {
    await gotoApp(page);
    await emitUpdate(page, { latest: "def5678" });
    await expect(page.locator('[data-testid="update-control"]')).toBeVisible();
    const status = page.locator('[data-testid="status-bar"]');
    await expect(status).toBeVisible();
    await expect(status).not.toContainText("Update");
    await expect(status.locator('[data-testid="live-dot"]')).toBeVisible();
  });
});
