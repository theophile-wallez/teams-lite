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

    // FIRST CLICK. The row is the button and nothing else: it says an update exists —
    // never which build, since a commit sha is a fault code to whoever reads it — and it
    // carries what the download costs in its own title, because this may be a phone on a
    // metered connection, which is also why nothing downloads on its own.
    const button = page.getByTestId("update-button");
    await expect(button).toHaveText(/^\s*Update available\s*$/);
    await expect(button).not.toContainText("def5678");
    await expect(button).toHaveAttribute("title", "Downloads 133 MB.");
    await expect(page.getByTestId("update-detail")).toHaveCount(0);
    const before = await button.boundingBox();
    await button.click();

    // The progress is a fill inside the button, and the percent is on the button itself
    // so it can be read without measuring pixels. It takes the place of the words that
    // were pressed, and the button stays where it was while it does. The work is drawn as
    // an orb (thinking-orbs, on a 2D canvas) in place of the icon.
    await expect(control).toHaveAttribute("data-phase", "downloading");
    await expect(button).toHaveText(/Downloading… \d+%/);
    await expect(button).toBeDisabled();
    await expect(page.getByTestId("update-progress-fill")).toBeVisible();
    await expect(page.getByTestId("update-orb")).toBeVisible();
    const during = await button.boundingBox();
    expect(Math.abs((during?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(2);

    // SECOND CLICK. Downloaded, and now it is a restart — a separate, deliberate press.
    await expect(control).toHaveAttribute("data-phase", "ready", { timeout: 10_000 });
    const restart = page.getByTestId("update-button");
    await expect(restart).toHaveText(/Restart to update/);
    await expect(restart).toBeEnabled();
    await expect(restart).toHaveAttribute("title", /Installs the new build/);
    await expect(page.getByTestId("update-detail")).toHaveCount(0);
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

  // A FAILURE IS ALWAYS A WAY FORWARD, never a dead end. The real one: `latest` is a
  // rolling tag, CI replaced its asset while the app was up, and the transfer was checked
  // against the size measured at startup — so it could never match again and the only thing
  // the button offered was to try the same stale number once more. The backend now re-reads
  // the release before every attempt (`fetch_release_asset` in src/bin/server.rs); this is
  // the half the page owns — the failure says what happened, and the retry really succeeds.
  test("says what a failed download hit, and the retry gets there", async ({ page }) => {
    await gotoApp(page);
    const control = page.locator('[data-testid="update-control"]');
    await emitUpdate(page, { latest: "def5678", fail_once: true });

    await page.getByTestId("update-button").click();
    await expect(control).toHaveAttribute("data-phase", "failed");
    const button = page.getByTestId("update-button");
    await expect(button).toHaveText(/Update failed — try again/);
    await expect(button).toBeEnabled();
    // The reason gets a line of its own — a report nobody can hover is a report a phone
    // does not have — and it names what happened rather than blaming the network.
    const detail = page.getByTestId("update-detail");
    await expect(detail).toContainText("the release was replaced");
    await expect(detail).not.toContainText("cut short");

    await button.click();
    await expect(control).toHaveAttribute("data-phase", /downloading|ready/);
    await expect(control).toHaveAttribute("data-phase", "ready", { timeout: 10_000 });
    await expect(page.getByTestId("update-button")).toHaveText(/Restart to update/);
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

  // ---- what the update brings ---------------------------------------------------------
  // The changelog is a DISCLOSURE on the control: the row is still the button, and what a
  // reader asks for opens beside it rather than growing under it.

  test("discloses what the update brings, without moving the button", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await emitUpdate(page, { latest: "def5678" });
    const button = page.getByTestId("update-button");
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("data-changes", "yes");

    const before = await button.boundingBox();
    const panel = page.getByTestId("update-changes");
    await expect(panel).toHaveCount(0);

    await button.hover();
    await expect(panel).toBeVisible();

    // The authors' own words, grouped by the backend — this app re-derives neither.
    await expect(panel).toContainText("Fixed");
    await expect(panel).toContainText("never let a sender's own words name a file on disk");
    // The scope is drawn beside the summary, so a reader sees WHERE before WHAT.
    await expect(panel).toContainText("media");
    // And the heading counts, because that is what somebody hovers to ask: how much is
    // this? A commit sha answers nothing and appears nowhere.
    await expect(page.getByTestId("update-changes-summary")).toHaveText(
      "6 changes since your build",
    );
    await expect(panel).not.toContainText("def5678");

    // AND THE WORK IS A COUNT, not five lines of it. A refactor alters no behaviour, a test
    // proves what already shipped: drawn under their own headings at the size of the feature
    // above them, they spent the room this card has on changes nobody outside the code can
    // see. The release page keeps them one press away; here they are one line, so the six
    // the heading promises are still all accounted for.
    await expect(panel).not.toContainText("Documented");
    await expect(panel).not.toContainText("map video and screen sharing");
    await expect(page.getByTestId("update-changes-internal")).toHaveText(
      "and 1 internal change",
    );

    // THE BUTTON HAS NOT MOVED. The panel is portaled and anchored; a list that unfolded in
    // the row would shift the control the user is aiming at, which is the same reason the
    // download's cost is a title and not a line.
    const after = await button.boundingBox();
    expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
    expect(after?.height).toBeCloseTo(before?.height ?? 0, 0);

    // It closes on its own when the pointer leaves, and the click underneath is still the
    // update — a disclosure must not swallow the action it explains.
    await page.mouse.move(700, 320);
    await expect(panel).toBeHidden();
    await button.click();
    await expect(page.locator('[data-testid="update-control"][data-phase="ready"]')).toBeVisible({
      timeout: 30_000,
    });
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  // A phone has no hover, so the way in there is a long press — pinned in mobile.spec.ts,
  // beside the chat row's own hold, because one gesture must mean one thing across the app.

  // The list is bounded — a build a week behind is 130-odd commits — and a list that stops
  // without saying so reads as a complete one.
  test("says how much of a long list it is not showing", async ({ page }) => {
    await gotoApp(page);
    await emitUpdate(page, { latest: "def5678", changes_omitted: 37 });
    await page.getByTestId("update-button").hover();
    await expect(page.getByTestId("update-changes-summary")).toHaveText(
      "43 changes since your build — the newest 6 below",
    );
  });

  // The disclosure is the nicety; that an update EXISTS is the row's job. A comparison the
  // backend could not read must cost the first and never the second.
  test("still offers the update when nothing could be read about it", async ({ page }) => {
    await gotoApp(page);
    await emitUpdate(page, { latest: "def5678", changes: false });
    const button = page.getByTestId("update-button");
    await expect(button).toBeVisible();
    await expect(button).toHaveText(/Update available/);
    await expect(button).toHaveAttribute("data-changes", "no");
    await button.hover();
    await expect(page.getByTestId("update-changes")).toHaveCount(0);
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
