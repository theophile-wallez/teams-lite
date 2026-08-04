import { expect } from "@playwright/test";
import {
  emitCallInvite,
  gotoApp,
  openConversationNamed,
  resetCall,
  test,
} from "./helpers";

// Audio calling: the switch that is the consent, the button that places a call, the
// ringing card with a working Answer, and the bar while the call is up
// (web/src/components/call-bar.tsx and call-button.tsx, over web/src/lib/call.ts and
// call-media.ts — and src/calling.rs for the protocol).
//
// Nothing here registers anything with Teams, rings anybody, or opens a microphone. The
// mock reproduces the SIGNALING and the page pairs it with `simulatedCallMedia`, which it
// picks because the backend announced itself as a mock. So what this file pins is every
// rule that is ours to keep:
//
//   * calling is OFF until the user turns it on, and the button says so;
//   * a call can only be placed in a one-to-one chat;
//   * the ringing card can be answered, declined and muted;
//   * one call at a time.
//
// Every test ends by resetting the mock, because one mock process serves the whole run
// and a call left ringing would ring inside every later spec.

/** Turn calling on through the Settings switch — the only place the app offers it, and
 *  the consent gate for the whole feature. */
async function turnCallingOn(page: import("@playwright/test").Page): Promise<void> {
  await page.locator('[data-testid="open-settings"]').click();
  const toggle = page.locator('[data-testid="calling-toggle"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-testid="calling-state"]')).toContainText("registered");
}

test.describe("Audio calling", () => {
  test.afterEach(async ({ page }) => {
    await resetCall(page);
  });

  test("is off until the user turns it on, and the call button says where", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");

    // The button exists in a one-to-one chat even while calling is off — that is the
    // one case the user can fix, and a missing button would hide the feature.
    const button = page.locator('[data-testid="call-button"]');
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-label", /Settings/);

    await turnCallingOn(page);
    await openConversationNamed(page, "Ava Thompson");
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-label", /Call Ava Thompson/);
  });

  /** One microphone, one audio element, no roster: a group call is not offered at all,
   *  rather than offered and then refused. */
  test("offers no call button outside a one-to-one chat", async ({ page }) => {
    await gotoApp(page);
    await turnCallingOn(page);
    await openConversationNamed(page, "Platform Team");
    await expect(page.locator('[data-testid="call-button"]')).toHaveCount(0);
  });

  test("places a call, shows it connect, and hangs up", async ({ page }) => {
    await gotoApp(page);
    await turnCallingOn(page);
    await openConversationNamed(page, "Ava Thompson");

    await page.locator('[data-testid="call-button"]').click();

    // Dialling first: the user has to see that the call is going out before it is
    // answered, because the microphone opens at that moment.
    const bar = page.locator('[data-testid="call-bar"]');
    await expect(bar).toBeVisible();
    await expect(page.locator('[data-testid="call-peer"]')).toContainText("Ava Thompson");
    // Then the far side picks up and its SDP arrives, and the bar counts the duration
    // from the backend's own clock.
    await expect(bar).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    await expect(page.locator('[data-testid="call-duration"]')).toContainText(/^\d+:\d\d$/);

    // While a call is up the button is refused rather than starting a second one.
    await expect(page.locator('[data-testid="call-button"]')).toBeDisabled();

    await page.locator('[data-testid="call-hangup"]').click();
    await expect(bar).toHaveCount(0);
    // An ending the user caused says nothing back at them: they were there.
    await expect(page.locator('[data-testid="call-notice"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="call-button"]')).toBeEnabled();
  });

  test("answers a ringing call, mutes, and hangs up", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");
    const conversationId = await page
      .locator('[data-testid="composer-shell"]')
      .getAttribute("data-conversation-id");
    expect(conversationId).toBeTruthy();

    await emitCallInvite(page, conversationId!);

    const bar = page.locator('[data-testid="call-bar"]');
    await expect(bar).toHaveAttribute("data-phase", "ringing");
    await expect(page.locator('[data-testid="call-phase"]')).toContainText("Incoming call");

    // The awareness banner must NOT double up on the same conversation: two cards for
    // one call, one of them saying it cannot be answered, is the app arguing with itself.
    await expect(page.locator('[data-testid="incoming-call-banner"]')).toHaveCount(0);

    await page.locator('[data-testid="call-answer"]').click();
    await expect(bar).toHaveAttribute("data-phase", "connected");

    const mute = page.locator('[data-testid="call-mute"]');
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "false");

    await page.locator('[data-testid="call-hangup"]').click();
    await expect(bar).toHaveCount(0);
  });

  test("declines a ringing call without opening the microphone", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");
    const conversationId = await page
      .locator('[data-testid="composer-shell"]')
      .getAttribute("data-conversation-id");
    await emitCallInvite(page, conversationId!);

    const bar = page.locator('[data-testid="call-bar"]');
    await expect(bar).toHaveAttribute("data-phase", "ringing");
    // A ringing call has no mute: nothing is being sent yet, and a button that muted a
    // microphone that is not open would be a lie about what the machine is doing.
    await expect(page.locator('[data-testid="call-mute"]')).toHaveCount(0);

    await page.locator('[data-testid="call-hangup"]').click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('[data-testid="call-notice"]')).toHaveCount(0);
  });

  /** Turning calling off is the other half of the consent: the user's calls stop being
   *  offered here, and a call in flight ends rather than outliving the switch. */
  test("ends the call when calling is turned off", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");
    const conversationId = await page
      .locator('[data-testid="composer-shell"]')
      .getAttribute("data-conversation-id");
    await emitCallInvite(page, conversationId!);
    await expect(page.locator('[data-testid="call-bar"]')).toHaveAttribute(
      "data-phase",
      "ringing",
    );

    await page.locator('[data-testid="open-settings"]').click();
    const toggle = page.locator('[data-testid="calling-toggle"]');
    // The invite implied calling is on, which is the only state it could have arrived in.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await expect(page.locator('[data-testid="call-bar"]')).toHaveCount(0);
    // This ending the user did not ask for, so it is stated once.
    await expect(page.locator('[data-testid="call-notice"]')).toContainText("turned off");
  });
});
