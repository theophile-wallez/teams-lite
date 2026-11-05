import {
  test,
  expect,
  gotoApp,
  emitBrokerStatus,
  armSignin,
  armIntune,
  realErrors,
} from "./helpers";

// The SELF-CONTAINED image runs its own Intune container (src/intune_embedded.rs), so the banner
// grows two states only that mode has — the container being started, and a container nobody has
// enrolled — and the sign-in panel grows a second kind: the Intune portal's window, served
// exactly as the broker's is. These pin both against the mock's drawn portal, so no container,
// no portal and no tenant is involved at all. What the mock CANNOT stand for is the real portal:
// nobody has driven one through these frames, which is the user's own press.
test.describe("an embedded backend's own Intune container", () => {
  // One mock process serves the whole run: an embedded status left armed changes what every
  // later spec's banner offers, and an enrollment left running puts a dialog over it. The signin
  // reset is LAST because it puts the whole broker status — `intune` with it — back to null.
  test.afterEach(async ({ page }) => {
    await armIntune(page, { reset: true });
    await emitBrokerStatus(page, { ok: true });
    await armSignin(page, { reset: true });
  });

  test("a host-mode status draws exactly what it always drew", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    // `intune` absent is a host-mode backend (and one too old to know about embedded mode): the
    // failure no restart fixes keeps its sentence, and none of the embedded states appears.
    await emitBrokerStatus(page, {
      ok: false,
      signature: "no_account",
      message: "The identity broker holds no account.",
      can_repair: false,
    });
    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner.getByTestId("broker-repair")).toBeDisabled();
    await expect(banner.getByTestId("broker-repair-hint")).toContainText("sign in to Intune again");
    for (const id of [
      "broker-enroll",
      "broker-starting",
      "broker-stopped",
      "broker-enroll-show",
      "broker-portal-signin",
      "broker-embedded-other",
    ]) {
      await expect(banner.getByTestId(id)).toHaveCount(0);
    }
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("says the container is being started, with no button, and names the first start's cost", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "unreachable",
      message: "The identity broker could not be reached.",
      can_repair: false,
    });
    await armIntune(page, { helper: "boot", initialized: false, running: false });

    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner.getByTestId("broker-starting")).toContainText("Setting up the Intune container");
    // The size of the pull is said BEFORE the reader decides the app has hung.
    await expect(banner.getByTestId("broker-repair-hint")).toContainText("1.7 GB");
    // Nothing to press: the boot is already the remedy, and it is under way.
    await expect(banner.getByRole("button")).toHaveCount(0);

    // A later start of a container already set up says so without the download.
    await armIntune(page, { helper: "boot", initialized: true, running: false });
    await expect(banner.getByTestId("broker-starting")).toContainText("Starting the Intune container");
    await expect(banner.getByTestId("broker-repair-hint")).not.toContainText("1.7 GB");
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a container that is down and not starting is not sent to sign in to Intune", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "unreachable",
      message: "The identity broker could not be reached.",
      can_repair: false,
    });
    await armIntune(page, { helper: null, initialized: true, registered: true, running: false });
    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner.getByTestId("broker-stopped")).toContainText("not running");
    await expect(banner.getByTestId("broker-repair-hint")).not.toContainText("sign in to Intune");
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("enrolls the device through the portal's own window, and the banner goes", async ({
    page,
    consoleErrors,
  }) => {
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    // Up, and enrolled nowhere: what the broker of a fresh container answers is "no account".
    await armIntune(page, { helper: null, initialized: true, registered: false, running: true });

    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner.getByTestId("broker-enroll")).toHaveText("Enroll this device");
    // The one remedy, and nothing beside it: a sign-in cannot sign anybody in on a device with
    // no registration, and two buttons would ask the reader to know which one they need.
    await expect(banner.getByTestId("broker-signin")).toHaveCount(0);
    await expect(banner.getByTestId("broker-repair")).toHaveCount(0);
    await banner.getByTestId("broker-enroll").click();

    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-kind", "enroll");
    // The banner stops offering the press the moment it is made.
    await expect(banner.getByTestId("broker-enroll")).toHaveCount(0);

    await expect(panel).toHaveAttribute("data-phase", "waiting", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-title")).toHaveText("Enroll this device");
    await expect(panel.getByTestId("signin-detail")).toContainText("Intune portal");
    const frame = panel.getByTestId("signin-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("alt", /Intune portal/);
    await expect
      .poll(async () => frame.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(550);

    // Typing reaches the portal, exactly as it reaches the broker's page: the frame changes.
    const before = await frame.getAttribute("src");
    await panel.getByTestId("signin-keyboard").fill("hunter2");
    await expect.poll(async () => frame.getAttribute("src")).not.toBe(before);

    // The pretend portal's own Enroll button registers the container — and the portal stays
    // open, as the real one carries on after the registration lands. The panel says so and hands
    // the close to the reader.
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    const scale = box!.width / 550;
    await page.mouse.click(box!.x + 417 * scale, box!.y + 293 * scale);
    await expect(panel).toHaveAttribute("data-registered", "true", { timeout: 10_000 });
    await expect(panel).toHaveAttribute("data-phase", "waiting");
    await expect(panel.getByTestId("signin-title")).toContainText("registered");
    await expect(panel.getByTestId("signin-cancel")).toHaveText("Close the portal");

    // Closing it on a registered container is an enrollment that WORKED, not a cancelled one.
    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-title")).toContainText("enrolled");
    await expect(banner).toHaveCount(0);
    await panel.getByTestId("signin-close").click();
    await expect(panel).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an enrollment the reader put away can be shown again, and cancelling changes nothing", async ({
    page,
    consoleErrors,
  }) => {
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await armIntune(page, { helper: null, initialized: true, registered: false, running: true });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-enroll").click();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "waiting", { timeout: 10_000 });

    // Escape puts the panel away and leaves the portal open — the reader may be reaching for
    // their phone. The banner then offers the panel back rather than a second enrollment.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(banner.getByTestId("broker-enroll")).toHaveCount(0);
    await banner.getByTestId("broker-enroll-show").click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-phase", "waiting");

    // Cancel before anything was registered. The press is CARRIED OUT, not assumed: the backend
    // asks the portal's helper to close the portal and settles once it has, so for that moment the
    // panel says it is closing and offers nothing to press — no window, and no second Cancel.
    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-stopping", "true");
    await expect(panel.getByTestId("signin-title")).toHaveText("Closing the Intune portal…");
    await expect(panel.getByTestId("signin-cancel")).toHaveCount(0);
    await expect(panel.getByTestId("signin-frame")).toHaveCount(0);
    await expect(panel).toHaveAttribute("data-phase", "cancelled", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-detail")).toContainText("nothing was registered");
    // The slot is the HELPER's until it has exited, and its release is a status of its own: the
    // banner says the portal is closing — never that it is still open, which would contradict the
    // panel — and offers no press the backend would refuse…
    await expect(banner.getByTestId("broker-repair-hint")).toContainText("still closing");
    await expect(banner.getByTestId("broker-enroll")).toHaveCount(0);
    await panel.getByTestId("signin-close").click();
    // …and the offer comes back off that second status, with nothing else pressed.
    await expect(banner.getByTestId("broker-enroll")).toBeVisible({ timeout: 10_000 });
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a registered container whose broker holds no account is offered the portal to sign in again", async ({
    page,
    consoleErrors,
  }) => {
    // An imported backup whose broker account did not come along, or an account removed in the
    // portal: enrolled, and nothing can sign anybody in. It used to fall through to the host-mode
    // sentence — "sign in to Intune again", with a tool this image does not have.
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await armIntune(page, { helper: null, initialized: true, registered: true, running: true });

    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner.getByTestId("broker-portal-signin")).toHaveText(
      "Sign in through the Intune portal",
    );
    await expect(banner.getByTestId("broker-repair-hint")).not.toContainText("sign in to Intune again");
    // It is not an enrollment: the device is enrolled, and enrolling it again would replace that.
    await expect(banner.getByTestId("broker-enroll")).toHaveCount(0);
    await banner.getByTestId("broker-portal-signin").click();

    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-kind", "enroll");
    await expect(panel).toHaveAttribute("data-purpose", "account");
    await expect(panel).toHaveAttribute("data-phase", "waiting", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-title")).toHaveText("Sign in through the Intune portal");
    await expect(panel.getByTestId("signin-cancel")).toHaveText("Close the portal");
    const frame = panel.getByTestId("signin-frame");
    await expect(frame).toBeVisible();

    // The pretend portal's own button signs the account in; closing the portal is how the reader
    // finishes, and the backend asks the broker then.
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    const scale = box!.width / 550;
    await page.mouse.click(box!.x + 417 * scale, box!.y + 293 * scale);
    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-title")).toHaveText("Sign-in works again");
    await expect(banner).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an account signed in through the portal is found when the broker's silent call refuses at first", async ({
    page,
    consoleErrors,
  }) => {
    // A FRESH account has no refresh token yet for this client and resource, so the broker's
    // silent call refuses and only an interactive call mints — from the PRT, with nobody in front
    // of it. The interactive call needs the turn the portal session holds: the backend asks it
    // UNDER that turn, then releases it, then asks the funnel. Asked the other way round, the
    // funnel's rescue stood down on the held turn and the panel said "still broken" over a sign-in
    // that had worked — while the enrollment's own follow-up took the banner down seconds later.
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await armIntune(page, {
      helper: null,
      initialized: true,
      registered: true,
      running: true,
      account_probe: "refuses",
    });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-portal-signin").click();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-purpose", "account");
    await expect(panel).toHaveAttribute("data-phase", "waiting", { timeout: 10_000 });
    const frame = panel.getByTestId("signin-frame");
    await expect(frame).toBeVisible();
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    const scale = box!.width / 550;
    await page.mouse.click(box!.x + 417 * scale, box!.y + 293 * scale);
    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-title")).toHaveText("Sign-in works again");
    await expect(banner).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a portal closed with no account signed in says sign-in is still broken, and offers it again", async ({
    page,
    consoleErrors,
  }) => {
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await armIntune(page, { helper: null, initialized: true, registered: true, running: true });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-portal-signin").click();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "waiting", { timeout: 10_000 });
    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "cancelled", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-detail")).toContainText("still holds no account");
    await panel.getByTestId("signin-close").click();
    await expect(banner.getByTestId("broker-portal-signin")).toBeVisible({ timeout: 10_000 });
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an embedded failure nothing here can mend is never sent to sign in to Intune", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "other",
      message: "The identity broker failed in a way this app does not recognise.",
      can_repair: false,
    });
    await armIntune(page, { helper: null, initialized: true, registered: true, running: true });
    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner.getByTestId("broker-embedded-other")).toContainText("up and enrolled");
    await expect(banner.getByTestId("broker-repair-hint")).toContainText("log says why");
    await expect(banner.getByTestId("broker-repair-hint")).not.toContainText("sign in to Intune");
    // No dead button either: there is nothing here to press.
    await expect(banner.getByRole("button")).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an enrollment that cannot start is reported in the panel the press opened", async ({
    page,
    consoleErrors,
  }) => {
    await armSignin(page, { outcome: "refuse" });
    await gotoApp(page);
    await armIntune(page, { helper: null, initialized: true, registered: false, running: true });
    await page.getByTestId("broker-enroll").click();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "failed", { timeout: 10_000 });
    await expect(panel).toHaveAttribute("data-kind", "enroll");
    await expect(panel.getByTestId("signin-title")).toContainText("Enrollment did not finish");
    // The backend's own sentence, which names what is in the way.
    await expect(panel.getByTestId("signin-detail")).toContainText("busy");
    await expect(panel.getByTestId("signin-frame")).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("an enrollment in flight reaches a page that connects in the middle of it", async ({
    page,
    consoleErrors,
  }) => {
    // The same rule a sign-in follows: the session is the app's, and rides the greeting.
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await armIntune(page, { helper: null, initialized: true, registered: false, running: true });
    await page.getByTestId("broker-enroll").click();
    await expect(page.locator('[data-testid="signin-panel"]')).toHaveAttribute(
      "data-phase",
      "waiting",
      { timeout: 10_000 },
    );
    await page.reload();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toHaveAttribute("data-kind", "enroll");
    await expect(panel.getByTestId("signin-frame")).toBeVisible();
    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "cancelled", { timeout: 10_000 });
    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
