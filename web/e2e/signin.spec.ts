import { test, expect, gotoApp, emitBrokerStatus, armSignin, realErrors } from "./helpers";

// Signing in again without leaving the app.
//
// The failure behind it: the identity broker cannot mint a token from this machine's own
// Primary Refresh Token any more, so it asks a human — and it asks by drawing its own window
// on an X display, which no API redirects (SIGN-IN.md § 3). Before this the app said "it needs
// you to sign in to Intune again" and left the reader with an SSH session, an Xvfb, a VNC
// server and about forty minutes. These pin the surface that replaced it, against the mock's
// own drawn window, so no broker and no display is involved at all.
test.describe("signing in again", () => {
  // One mock process serves the whole run: a broker left broken raises the banner in every
  // later spec, and a sign-in left running puts a dialog over it.
  test.afterEach(async ({ page }) => {
    // The signin reset is LAST because it also puts the broker status back to null — which is
    // what the rest of the suite needs, since a non-null status is announced in every greeting
    // and this feature's own "done" sets one.
    await emitBrokerStatus(page, { ok: true });
    await armSignin(page, { reset: true });
  });

  test("offers the sign-in only for the failure a container restart cannot fix", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    const banner = page.locator('[data-testid="broker-banner"]');

    // A locked keyring: the restart is the remedy, and the sign-in is not offered beside it —
    // a banner with two buttons asks the reader to know which failure they have.
    await emitBrokerStatus(page, {
      ok: false,
      signature: "keyring_locked",
      message: "The identity broker's keyring is locked.",
      can_repair: true,
    });
    await expect(banner.getByTestId("broker-repair")).toBeVisible();
    await expect(banner.getByTestId("broker-signin")).toHaveCount(0);

    // The refusal only a human can answer: now the sign-in is the remedy, and the restart is
    // not offered.
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      can_repair: false,
      can_sign_in: true,
    });
    await expect(banner.getByTestId("broker-signin")).toBeVisible();
    await expect(banner.getByTestId("broker-repair")).toHaveCount(0);
    // And the words say what the press does, before it is pressed.
    await expect(banner.getByTestId("broker-repair-hint")).toContainText("Microsoft's own");
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("says WHY when a sign-in is what is needed and the machine cannot serve one", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    // The button stays visible and inert — a missing one reads as "nothing can be done"
    // without saying so — and the reason is IN FLOW, because on a phone a hover does not
    // exist. That is the mistake this banner already made once with a tooltip.
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      can_repair: false,
      can_sign_in: false,
      signin_blocker: "The identity broker draws its sign-in window on display :77, and nothing is serving that display.",
    });
    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner.getByTestId("broker-signin")).toBeDisabled();
    await expect(banner.getByTestId("broker-repair-hint")).toContainText("display :77");
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("finishes on its own when the machine can do it, and shows no page at all", async ({
    page,
    consoleErrors,
  }) => {
    // The common case against the real broker, and the one this feature is measured on: the
    // interactive call mints the token from the PRT and nobody types anything (SIGN-IN.md § 2).
    await armSignin(page, { outcome: "immediate" });
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      // Both halves, as the backend answers them for this failure: a container restart cannot
      // fix it (`can_repair` false) and a human can (`can_sign_in` true). The mock defaults
      // `can_repair` to "not ok", so leaving it out would offer the restart instead.
      can_repair: false,
      can_sign_in: true,
    });
    await page.getByTestId("broker-signin").click();

    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toBeVisible();
    // It ends `done`, and no window is ever drawn: a password prompt that appeared here would
    // be this app inventing a step.
    await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await expect(panel.getByTestId("signin-frame")).toHaveCount(0);
    await expect(panel.getByTestId("signin-title")).toContainText("works again");
    // And the banner goes, because the broker is healthy again.
    await expect(page.locator('[data-testid="broker-banner"]')).toHaveCount(0);
    // The panel closes on the reader's own press, not on its own: they have to be able to read
    // what happened.
    await panel.getByTestId("signin-close").click();
    await expect(panel).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("draws the broker's own window, takes typing, and ends when the page is submitted", async ({
    page,
    consoleErrors,
  }) => {
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      // Both halves, as the backend answers them for this failure: a container restart cannot
      // fix it (`can_repair` false) and a human can (`can_sign_in` true). The mock defaults
      // `can_repair` to "not ok", so leaving it out would offer the restart instead.
      can_repair: false,
      can_sign_in: true,
    });
    await page.getByTestId("broker-signin").click();

    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "waiting", { timeout: 10_000 });

    // The window arrives as a picture, at the size the broker's own window really is.
    const frame = panel.getByTestId("signin-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("data-window-width", "550");
    await expect(frame).toHaveAttribute("data-window-height", "675");
    // A real picture, decoded by the browser — not a broken image with a data URL on it.
    await expect
      .poll(async () => frame.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(550);

    // The words say whose page this is and what to do with the number, which is the one
    // instruction a reader cannot work out for themselves.
    await expect(panel.getByTestId("signin-detail")).toContainText("Microsoft's own sign-in page");
    await expect(panel.getByTestId("signin-detail")).toContainText("Authenticator");

    // Typing goes into the page: the mock draws one dot per character, so the FRAME changes.
    // That is what proves the keystrokes really landed rather than being counted here.
    const before = await frame.getAttribute("src");
    await panel.getByTestId("signin-keyboard").fill("hunter2");
    await expect.poll(async () => frame.getAttribute("src")).not.toBe(before);

    // And the page's own Sign in button finishes it. The click is sent in the WINDOW's
    // coordinates, scaled back from wherever the picture happens to be drawn — the arithmetic
    // `pointInWindow` exists for.
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    const scale = box!.width / 550;
    await page.mouse.click(box!.x + 417 * scale, box!.y + 293 * scale);

    await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    await expect(page.locator('[data-testid="broker-banner"]')).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("the reader can cancel, and nothing is claimed to have changed", async ({
    page,
    consoleErrors,
  }) => {
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      // Both halves, as the backend answers them for this failure: a container restart cannot
      // fix it (`can_repair` false) and a human can (`can_sign_in` true). The mock defaults
      // `can_repair` to "not ok", so leaving it out would offer the restart instead.
      can_repair: false,
      can_sign_in: true,
    });
    await page.getByTestId("broker-signin").click();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "waiting", { timeout: 10_000 });

    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "cancelled", { timeout: 10_000 });
    // Cancelling changed nothing, so the banner is still there and still offers the sign-in.
    await expect(panel.getByTestId("signin-detail")).toContainText("Nothing changed");
    await expect(page.getByTestId("broker-signin")).toBeVisible();
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("cancel ends a sign-in that has not drawn anything yet", async ({
    page,
    consoleErrors,
  }) => {
    // `starting` is the phase most sign-ins live in, and Cancel was offered there and did
    // NOTHING: no window existed to close, so the phase stayed `starting`, no sentence appeared,
    // and the session stayed live for ten minutes — so no new sign-in could be started either.
    await armSignin(page, { outcome: "hold" });
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      can_repair: false,
      can_sign_in: true,
    });
    await page.getByTestId("broker-signin").click();

    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "starting");
    await expect(panel.getByTestId("signin-frame")).toHaveCount(0);

    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "cancelled", { timeout: 10_000 });
    // And the next one really starts, rather than being refused as already running.
    await panel.getByTestId("signin-close").click();
    await armSignin(page, { outcome: "immediate" });
    await page.getByTestId("broker-signin").click();
    await expect(panel).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a panel the reader put away does not come back when the flow settles", async ({
    page,
    consoleErrors,
  }) => {
    // Dismissing leaves the flow alone on purpose — the reader may be reaching for their phone —
    // so the backend keeps reporting it. Without remembering the dismissal the modal reappeared
    // by itself when the flow ended, over whatever they had moved on to.
    await armSignin(page, { outcome: "hold" });
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      can_repair: false,
      can_sign_in: true,
    });
    await page.getByTestId("broker-signin").click();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "starting");

    // Escape puts the panel away — and it belongs to the DIALOG rather than being typed into
    // Microsoft's page, which one press used to do both of.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    // The banner is still there, because nothing was cancelled.
    await expect(page.getByTestId("broker-signin")).toBeVisible();

    // Now let the flow end. The panel must stay away.
    await page.getByTestId("broker-signin").click();
    await expect(panel).toBeVisible();
    await panel.getByTestId("signin-cancel").click();
    await expect(panel).toHaveAttribute("data-phase", "cancelled", { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await page.waitForTimeout(600);
    await expect(panel).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a refusal is reported where the button was pressed", async ({ page, consoleErrors }) => {
    // The machine cannot serve one at all: the broker's display is gone. An outward-ish action
    // that failed must never be left looking like it worked — the composer's own rule.
    await armSignin(page, { outcome: "refuse" });
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      // Both halves, as the backend answers them for this failure: a container restart cannot
      // fix it (`can_repair` false) and a human can (`can_sign_in` true). The mock defaults
      // `can_repair` to "not ok", so leaving it out would offer the restart instead.
      can_repair: false,
      can_sign_in: true,
    });
    await page.getByTestId("broker-signin").click();

    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toHaveAttribute("data-phase", "failed", { timeout: 10_000 });
    // The backend's own sentence, which names the cause — never a generic one.
    await expect(panel.getByTestId("signin-detail")).toContainText("display :77");
    await expect(panel.getByTestId("signin-frame")).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a sign-in in flight reaches a page that connects in the middle of it", async ({
    page,
    consoleErrors,
  }) => {
    // The normal way this is used: press it on the laptop, pick the phone up for the
    // Authenticator. So the state is the app's rather than one component's, and it rides the
    // greeting.
    await armSignin(page, { outcome: "window" });
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      // Both halves, as the backend answers them for this failure: a container restart cannot
      // fix it (`can_repair` false) and a human can (`can_sign_in` true). The mock defaults
      // `can_repair` to "not ok", so leaving it out would offer the restart instead.
      can_repair: false,
      can_sign_in: true,
    });
    await page.getByTestId("broker-signin").click();
    await expect(page.locator('[data-testid="signin-panel"]')).toHaveAttribute(
      "data-phase",
      "waiting",
      { timeout: 10_000 },
    );

    // A second page — the phone — opens on the same running sign-in.
    await page.reload();
    const panel = page.locator('[data-testid="signin-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toHaveAttribute("data-phase", "waiting");
    await expect(panel.getByTestId("signin-frame")).toBeVisible();
    await panel.getByTestId("signin-cancel").click();
    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
