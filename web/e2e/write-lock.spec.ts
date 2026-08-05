import { test, expect, gotoApp, emitWriteLock, realErrors } from "./helpers";

// The state in which this app looks perfectly healthy and cannot act: the page holds a
// write token its backend does not accept, so every read answers and every send, reaction,
// read marker and update is refused (see write-lock-banner.tsx for how an instance gets
// there). It reached a user as "Update failed — try again", and the app said nothing else.
//
// The mock gates nothing, so `held` is what it answers by default and the banner is absent
// from every other spec. The states below are armed through its test hook, which is the
// only way this surface can be looked at at all.
test.describe("the write lock", () => {
  // One mock process serves the whole run, so a banner left armed would sit above every
  // later sidebar — and move every layout assertion under it.
  test.afterEach(async ({ page }) => {
    await emitWriteLock(page, { reset: true });
  });

  test("says nothing when this page holds the backend's own token", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await expect(page.getByTestId("write-lock-banner")).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // A read-only backend refuses every write too — but there nothing is misconfigured, the
  // refusal IS the feature, and no banner would give the reader anything to do.
  test("says nothing on a deliberately read-only backend", async ({ page }) => {
    await emitWriteLock(page, { state: "read_only", pinned: false });
    await gotoApp(page);
    await expect(page.getByTestId("write-lock-banner")).toHaveCount(0);
  });

  test("names what the reader cannot do, and what mends it", async ({ page, consoleErrors }) => {
    await emitWriteLock(page, { state: "foreign", pinned: true });
    await gotoApp(page);

    const banner = page.getByTestId("write-lock-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("This window can read, but not send");
    // A PINNED token is in no file, so no reload of anything here would ever match it:
    // another instance owns that backend, and the way out is outside this app.
    await expect(banner).toHaveAttribute("data-pinned", "true");
    await expect(page.getByTestId("write-lock-banner-message")).toContainText(
      "Another teams-lite instance",
    );
    await expect(page.getByTestId("write-lock-banner-hint")).toContainText("Stop the other");
    // Never the secret it is about, in either half of the banner.
    await expect(banner).not.toContainText("write_token");

    // And the app still WORKS: this is a window that reads everything, which is exactly
    // why it needs saying.
    await expect(page.locator('[data-testid="conversation-row"]').first()).toBeVisible();
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // A published token is readable, so the fault is on this side and the sentence has to say
  // so — it is this app serving the wrong one, which only a restart of the app re-reads.
  test("blames this app when the backend's token was published", async ({ page }) => {
    await emitWriteLock(page, { state: "foreign", pinned: false });
    await gotoApp(page);

    const banner = page.getByTestId("write-lock-banner");
    await expect(banner).toHaveAttribute("data-pinned", "false");
    await expect(page.getByTestId("write-lock-banner-message")).toContainText(
      "This app is handing this window",
    );
    await expect(page.getByTestId("write-lock-banner-hint")).toContainText("Restart the app");
  });

  // The user mends this outside the app, so the one action it can offer is to look again —
  // and the banner has to go on its own when they have.
  test("checks again, and empties itself once the token is accepted", async ({ page }) => {
    await emitWriteLock(page, { state: "foreign", pinned: true });
    await gotoApp(page);
    const banner = page.getByTestId("write-lock-banner");
    await expect(banner).toBeVisible();

    // Still wrong: the banner stands rather than clearing itself hopefully.
    await page.getByTestId("write-lock-check").click();
    await expect(banner).toBeVisible();

    await emitWriteLock(page, { reset: true });
    await page.getByTestId("write-lock-check").click();
    await expect(banner).toHaveCount(0);
  });
});
