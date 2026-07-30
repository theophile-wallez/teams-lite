import { test, expect, gotoApp, emitBrokerStatus, realErrors } from "./helpers";

// When the identity broker stops minting tokens, the app used to show an empty
// sidebar and say nothing: the socket stays up, the live dot stays green, and the only
// hint was a truncated 11 px `error:` line that a pending-update notice replaces
// outright. That happened twice on the real machine. The banner is the fix, and the
// button is the remedy — driven here through the mock's gated test hook, so no Intune
// container is involved at all.
test.describe("broker banner", () => {
  // The mock is shared and adopted across runs, so a broker left broken would raise
  // the banner in every later spec.
  test.afterEach(async ({ page }) => {
    await emitBrokerStatus(page, { ok: true });
  });

  test("stays hidden while sign-in works", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    // A backend that never failed emits nothing, and silence must read as "fine".
    await expect(page.locator('[data-testid="broker-banner"]')).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("explains a broken sign-in and offers the repair", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner).toHaveCount(0);

    await emitBrokerStatus(page, {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
    });

    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-signature", "disconnected");
    // The words a person can act on, not a raw error string.
    await expect(banner.getByTestId("broker-banner-message")).toContainText("keyring");
    await expect(banner.getByTestId("broker-banner-message")).toContainText("can't read your chats");

    // Pressing it disables the button and says what is happening. The mock reports a
    // healthy broker a beat later, which is what clears the banner — the same way the
    // real backend's `broker_status` does after the container comes back.
    const repair = banner.getByTestId("broker-repair");
    await expect(repair).toBeEnabled();
    await repair.click();
    await expect(banner.getByTestId("broker-repair")).toBeDisabled();
    await expect(banner).toHaveCount(0, { timeout: 10_000 });

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("keeps the button inert for a failure a restart cannot fix", async ({ page }) => {
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      can_repair: false,
    });

    const banner = page.locator('[data-testid="broker-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-signature", "refused");
    // Present but disabled: a missing button would read as "nothing can be done"
    // without ever saying so.
    await expect(banner.getByTestId("broker-repair")).toBeDisabled();
  });

  test("says something when the chat list is empty", async ({ page }) => {
    // The other half of the same bug: a blank scroll box was the whole of the app's
    // answer to "where did my chats go".
    await gotoApp(page);
    await expect(page.locator('[data-testid="conversation-row"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="chats-empty"]')).toHaveCount(0);
  });
});
