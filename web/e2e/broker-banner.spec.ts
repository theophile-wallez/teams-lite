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
    // And what still works: the store is local, so the history is on screen behind
    // this banner. Saying the app can read nothing was wrong — and it was the reason
    // an outage read as a broken app rather than as a stale one.
    await expect(banner.getByTestId("broker-banner-message")).toContainText(
      "history stored on this machine",
    );

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

  // The backend asks the keyring before it restarts anything, and a keyring that is NOT locked
  // is a press it refuses in words: a restart would take sign-in down for a minute and fix
  // nothing. It used to skip silently (the installed unit's ExecCondition=), so a press on a
  // broker that had merely been slow did nothing and said nothing — an outward action that did
  // nothing, looking like one that worked. The refusal is armed on the mock's broker hook and
  // disarmed by the `afterEach` above, which every call of that hook resets.
  test("says why a press on a keyring that is not locked restarts nothing", async ({ page }) => {
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
      repair: "refuse",
    });
    const banner = page.locator('[data-testid="broker-banner"]');
    // The rule is stated before the press, so the refusal is not the first the reader hears of it.
    await expect(banner.getByTestId("broker-repair-hint")).toContainText(
      "only when that keyring is locked",
    );

    await banner.getByTestId("broker-repair").click();
    const refusal = banner.getByTestId("broker-repair-error");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("Not restarting the Intune container");
    await expect(refusal).toContainText("its login keyring is unlocked");
    // And nothing claims a repair is running: the button is the reader's again.
    await expect(banner.getByTestId("broker-repair")).toBeEnabled();
    await expect(banner.getByTestId("broker-repair")).toHaveText("Repair sign-in");
  });

  // The backend stays up through a repair now, so nothing reconnects this page and nothing
  // else would take "Repairing…" back: the end of the repair is the backend's own
  // `broker_status` with `repairing: false`, and the banner has to follow it. A repair that did
  // not help is exactly that event with sign-in still broken.
  test("hands the button back when a repair ends without fixing sign-in", async ({ page }) => {
    await gotoApp(page);
    const broken = {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
    };
    await emitBrokerStatus(page, { ...broken, repair: "hold" });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-repair").click();

    // While it runs: the button is busy, and the words say what the reader is waiting for —
    // sign-in, which comes back without them. Never that the app will go quiet and reconnect:
    // the backend is not restarted, so that would be a promise about something that does not
    // happen.
    await expect(banner.getByTestId("broker-repair")).toBeDisabled();
    const hint = banner.getByTestId("broker-repair-hint");
    await expect(hint).toContainText("Sign-in comes back on its own");
    await expect(hint).not.toContainText("reconnect");

    // The unit ended, and the keyring is still what it was.
    await emitBrokerStatus(page, { ...broken, repairing: false });
    await expect(banner.getByTestId("broker-repair")).toBeEnabled();
    await expect(banner.getByTestId("broker-repair")).toHaveText("Repair sign-in");
  });

  // The repair stops the container and boots it again, and the backend stays up through that
  // minute, still asking for tokens — so halfway through, the failure it reports is what a
  // stopped container looks like: no broker on the bus at all, which a restart does not fix.
  // Read from `can_repair` alone, the banner swapped "Repairing…" for "it needs you to sign in
  // to Intune again" in the middle of the repair the reader had just asked for. A running
  // repair outranks whatever the failure turns into meanwhile, and only for as long as it runs.
  test("keeps the repair on screen while the container it restarts is down", async ({ page }) => {
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
      repair: "hold",
    });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-repair").click();
    await expect(banner.getByTestId("broker-repair")).toBeDisabled();

    // The container is down: the token call finds no broker on the bus, a failure no restart
    // can fix — and the repair is still running.
    const unreachable = {
      ok: false,
      signature: "unreachable",
      message: "The identity broker is not reachable on the D-Bus session bus.",
      can_repair: false,
    };
    await emitBrokerStatus(page, { ...unreachable, repairing: true });
    await expect(banner).toHaveAttribute("data-signature", "unreachable");
    await expect(banner.getByTestId("broker-repair")).toBeDisabled();
    await expect(banner.getByTestId("broker-repair")).toContainText("Repairing…");
    const hint = banner.getByTestId("broker-repair-hint");
    await expect(hint).toContainText("Sign-in comes back on its own");
    await expect(banner).not.toContainText("sign in to Intune again");

    // The repair ended and the broker is still not there: from here the failure decides, and
    // this one is not a restart's to fix.
    await emitBrokerStatus(page, { ...unreachable, repairing: false });
    await expect(hint).toContainText("sign in to Intune again");
    await expect(banner.getByTestId("broker-repair")).toHaveText("Repair sign-in");
  });

  // A refused press takes back its OWN flag and nothing newer. The backend asks a D-Bus keyring
  // before it answers, so a status can cross the press on the wire — sign-in coming back on its
  // own retry, or another failure — and putting the snapshot from before the press back over
  // it drew a state that no longer existed, with nothing to ever correct it: the backend speaks
  // only on a change. A newer FAILURE stands in for the news here rather than `ok: true`,
  // because the banner then stays up to show the press has been answered — its button is the
  // reader's again — before anything is asserted about what the refusal left behind.
  test("a refused press does not put back a status older than the news", async ({ page }) => {
    await gotoApp(page);
    await emitBrokerStatus(page, {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
      repair: "refuse_late",
    });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-repair").click();
    await expect(banner.getByTestId("broker-repair")).toBeDisabled();

    // Newer news, while the press is still out: the mock broadcasts it, and only then refuses.
    await emitBrokerStatus(page, {
      ok: false,
      signature: "keyring_locked",
      message: "The identity broker's keyring is locked.",
    });
    // The refusal has landed once the press is no longer being asked.
    await expect(banner.getByTestId("broker-repair")).toBeEnabled();
    await expect(banner).toHaveAttribute("data-signature", "keyring_locked");
    await expect(banner.getByTestId("broker-banner-message")).toContainText(
      "The identity broker's keyring is locked.",
    );
    // And the refusal itself went with the state it answered: "its login keyring is unlocked"
    // under a banner saying the keyring is locked would contradict the line above it.
    await expect(banner.getByTestId("broker-repair-error")).toHaveCount(0);
  });

  // The sidebar is never unmounted and the keyring re-locks roughly every eighteen hours, so
  // whatever a press left behind — a "Repairing…", a refusal — and that outlived the outage it
  // was about greeted the NEXT one, a day later: a disabled button over a repair nobody had
  // asked for, or a sentence explaining a press nobody had made. Both halves are driven,
  // because the busy one is also taken back when the press is answered and only the refusal
  // proves the press's state really dies with the banner.
  test("does not carry the last outage's press into the next one", async ({ page }) => {
    await gotoApp(page);
    const broken = {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
    };
    const banner = page.locator('[data-testid="broker-banner"]');

    // A repair that worked: sign-in comes back and the banner goes.
    await emitBrokerStatus(page, broken);
    await banner.getByTestId("broker-repair").click();
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
    await emitBrokerStatus(page, broken);
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId("broker-repair")).toBeEnabled();
    await expect(banner.getByTestId("broker-repair")).toHaveText("Repair sign-in");

    // A press that was refused, and then an outage that ended some other way.
    await emitBrokerStatus(page, { ...broken, repair: "refuse" });
    await banner.getByTestId("broker-repair").click();
    await expect(banner.getByTestId("broker-repair-error")).toBeVisible();
    await emitBrokerStatus(page, { ok: true });
    await expect(banner).toHaveCount(0);
    await emitBrokerStatus(page, broken);
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId("broker-repair-error")).toHaveCount(0);
  });

  // The refusal is about the button above it, so a failure that moves to a remedy without
  // that button takes the sentence with it — and takes it for good: hidden rather than
  // dropped, it came back with the button when the failure moved back, under a press nobody
  // had made since.
  test("drops a refusal when the failure stops being one a restart could fix", async ({ page }) => {
    await gotoApp(page);
    const disconnected = {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
    };
    await emitBrokerStatus(page, { ...disconnected, repair: "refuse" });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-repair").click();
    await expect(banner.getByTestId("broker-repair-error")).toBeVisible();

    await emitBrokerStatus(page, {
      ok: false,
      signature: "refused",
      message: "The identity broker refused to sign in silently.",
      can_repair: false,
    });
    await expect(banner).toHaveAttribute("data-signature", "refused");
    await expect(banner.getByTestId("broker-repair-error")).toHaveCount(0);

    // The same failure as the press was made on, and the button with it — but not the sentence.
    await emitBrokerStatus(page, disconnected);
    await expect(banner).toHaveAttribute("data-signature", "disconnected");
    await expect(banner.getByTestId("broker-repair")).toBeEnabled();
    await expect(banner.getByTestId("broker-repair-error")).toHaveCount(0);
  });

  // A refusal says no repair is running. A repair something ELSE then starts — the health
  // check finding the keyring locked an hour later, the other backend, another page — makes
  // that the opposite of the truth, so the sentence goes with it, and does not come back when
  // that repair ends.
  test("never leaves a refusal under a repair something else started", async ({ page }) => {
    await gotoApp(page);
    const broken = {
      ok: false,
      signature: "disconnected",
      message: "The identity broker stopped answering. Its keyring is usually locked.",
    };
    await emitBrokerStatus(page, { ...broken, repair: "refuse" });
    const banner = page.locator('[data-testid="broker-banner"]');
    await banner.getByTestId("broker-repair").click();
    await expect(banner.getByTestId("broker-repair-error")).toBeVisible();

    await emitBrokerStatus(page, { ...broken, repairing: true });
    await expect(banner.getByTestId("broker-repair")).toContainText("Repairing…");
    await expect(banner.getByTestId("broker-repair-error")).toHaveCount(0);

    await emitBrokerStatus(page, { ...broken, repairing: false });
    await expect(banner.getByTestId("broker-repair")).toHaveText("Repair sign-in");
    await expect(banner.getByTestId("broker-repair-error")).toHaveCount(0);
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
    // And the remedy is ON SCREEN with no hover and no focus. This sentence was a
    // tooltip once, which is a sentence a phone does not have — and this is the one
    // broker failure the reader has to act on themselves, so it is the one that must
    // never be behind a pointer.
    const hint = banner.getByTestId("broker-repair-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("sign in to Intune again");
  });

  test("says something when the chat list is empty", async ({ page }) => {
    // The other half of the same bug: a blank scroll box was the whole of the app's
    // answer to "where did my chats go".
    await gotoApp(page);
    await expect(page.locator('[data-testid="conversation-row"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="chats-empty"]')).toHaveCount(0);
  });
});
