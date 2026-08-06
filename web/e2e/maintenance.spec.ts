import { test, expect, gotoApp, emitMaintenance, emitUpdate, realErrors } from "./helpers";

// Settings › This app: ask GitHub now whether a newer build exists, and restart the backend.
//
// Both rows exist because this app is read from a phone and the machine it runs on is
// somewhere else — everything either one does used to need a terminal on that machine. And
// both are rows in a COLUMN of controls, so what they say and when they say it is the whole
// difficulty: a sentence that appears moves everything under it, and one that never appears
// makes a button look like it does nothing.
//
// It all runs against the mock: there is no GitHub here and nothing to restart, so what the
// mock reproduces is the ANSWER and then the socket going — which is exactly what the page
// reacts to.
test.describe("Settings › This app", () => {
  // The mock is a shared process and `reuseExistingServer` adopts it across runs, so an
  // armed refusal — or a release left announced — would reach every later spec.
  test.afterEach(async ({ page }) => {
    await emitMaintenance(page, { reset: true });
    await emitUpdate(page, { available: false });
  });

  const openThisApp = async (page: Parameters<typeof gotoApp>[0]) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-settings"]').click();
    const section = page.locator('[data-testid="maintenance-settings"]');
    await expect(section).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    return section;
  };

  test("neither row says anything until it is pressed", async ({ page, consoleErrors }) => {
    await openThisApp(page);
    // The row is the button: a line under it is for what HAPPENED, and nothing has.
    await expect(page.getByTestId("update-check-message")).toHaveCount(0);
    await expect(page.getByTestId("restart-backend-message")).toHaveCount(0);
    await expect(page.getByTestId("update-check-button")).toHaveText(/Check for updates/);
    await expect(page.getByTestId("restart-backend-button")).toHaveText(/^\s*Restart\s*$/);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // The answer this app could not give at all before: a poll that finds nothing new changes
  // nothing on screen, so pressing anything and seeing no reaction was the whole experience.
  test("says this is the newest build, and never names a commit", async ({
    page,
    consoleErrors,
  }) => {
    await openThisApp(page);
    await page.getByTestId("update-check-button").click();
    const message = page.getByTestId("update-check-message");
    await expect(message).toHaveText("This is the newest build.");
    await expect(message).not.toContainText("abc1234");
    await expect(message).not.toContainText("def5678");
    // And it stays pressable: a check is a read.
    await expect(page.getByTestId("update-check-button")).toBeEnabled();
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // A release the backend finds is offered by the sidebar's own control — the one place the
  // download and the restart onto it live. This row says it exists and points there rather
  // than growing a second update button.
  test("a release found by the check raises the sidebar's own update row", async ({
    page,
    consoleErrors,
  }) => {
    await emitUpdate(page, { latest: "def5678" });
    await openThisApp(page);
    // Armed through the hook, which is the mock's stand-in for GitHub; the ROW comes from
    // the press, exactly as it comes from a poll in the real backend.
    await page.getByTestId("update-check-button").click();
    await expect(page.getByTestId("update-check-message")).toContainText("newer build");
    await expect(page.getByTestId("update-check-message")).toContainText("sidebar");
    await expect(page.getByTestId("update-control")).toBeVisible();
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a check that could not be made says so, in the reason's own words", async ({
    page,
    consoleErrors,
  }) => {
    await emitMaintenance(page, { check: "failed" });
    await openThisApp(page);
    await page.getByTestId("update-check-button").click();
    await expect(page.getByTestId("update-check-message")).toContainText("Could not reach GitHub");
    // The button is the way out of it, and it is still there.
    await expect(page.getByTestId("update-check-button")).toBeEnabled();
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // THE RESTART, and the proof it happened: the socket goes and comes back. Nothing else on
  // this page can tell a restart that was carried out from one nobody acted on.
  test("restarts the backend, and reports it once the socket is back", async ({
    page,
    consoleErrors,
  }) => {
    await openThisApp(page);
    const button = page.getByTestId("restart-backend-button");
    await button.click();
    await expect(page.getByTestId("restart-backend-message")).toContainText("reconnects");
    await expect(button).toBeDisabled();
    // The mock drops every socket a beat after answering — the real backend's own
    // `RESTART_ANSWER_GRACE` — and the page's ordinary reconnect is what ends the wait.
    await expect(page.getByTestId("restart-backend-message")).toContainText(
      "The backend restarted.",
      { timeout: 20_000 },
    );
    await expect(button).toBeEnabled();
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // A run dies with the process and nothing can resume it, so the first press is answered
  // with what it would cost rather than carried out. The count comes from the BACKEND: this
  // page knows only about the runs it happened to watch, and the common case is a reply the
  // user asked for from their phone.
  test("asks twice while a local agent is writing a reply", async ({ page, consoleErrors }) => {
    await emitMaintenance(page, { runs: 2 });
    await openThisApp(page);
    const button = page.getByTestId("restart-backend-button");
    await button.click();

    const message = page.getByTestId("restart-backend-message");
    await expect(message).toContainText("2 replies are being written");
    await expect(message).toContainText("interrupted");
    await expect(button).toHaveText(/Restart anyway/);
    await expect(button).toBeEnabled();

    // The second press is the user answering for that reply, and it carries `force`.
    await button.click();
    await expect(message).toContainText("reconnects");
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // The one refusal the user cannot press through: a backend nobody watches would not come
  // back, so it is never taken down — and the sentence names the shape they are in rather
  // than a control that does not exist.
  test("refuses where nothing would start the backend again", async ({
    page,
    consoleErrors,
  }) => {
    await emitMaintenance(page, { refuse: true });
    await openThisApp(page);
    await page.getByTestId("restart-backend-button").click();
    const message = page.getByTestId("restart-backend-message");
    await expect(message).toContainText("Nothing here would start this backend again");
    await expect(message).toContainText("the way it was started");
    // The RPC's own name and its `refused:` opening are for whoever holds the socket, not
    // for the person who pressed a button.
    await expect(message).not.toContainText("restart_backend");
    await expect(message).not.toContainText("refused:");
    await expect(page.getByTestId("restart-backend-button")).toBeEnabled();
    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
