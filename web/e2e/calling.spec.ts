import { expect } from "@playwright/test";
import {
  calendarEvent,
  emitCallInvite,
  gotoApp,
  openCalendarTab,
  openCalendarView,
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

test.describe("Joining a meeting", () => {
  test.afterEach(async ({ page }) => {
    await resetCall(page);
  });

  /** The calendar keeps its link to real Teams. This app joins with a microphone and
   *  nothing else, so a meeting with a shared screen is still one to open there — both
   *  actions exist, and neither replaces the other. */
  test("offers Join here beside the link to Teams, and says why when it cannot", async ({
    page,
  }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();

    const details = page.locator('[data-testid="calendar-event-details"]');
    await expect(details).toBeVisible();
    // The link out is still there, and still a link.
    await expect(details.locator('[data-testid="calendar-event-join"]')).toHaveAttribute(
      "target",
      "_blank",
    );
    // The in-app join exists, and is refused while calling is off — the one case the
    // user can fix.
    const join = details.locator('[data-testid="meeting-join-here"]');
    await expect(join).toBeVisible();
    await expect(join).toBeDisabled();
    await expect(join).toHaveAttribute("aria-label", /Settings/);
  });

  test("joins a meeting: the lobby, then the meeting, then who is in it", async ({ page }) => {
    await gotoApp(page);
    // Turning calling on is the consent for this too: joining opens the microphone to
    // everybody in the meeting.
    await page.locator('[data-testid="open-settings"]').click();
    await page.locator('[data-testid="calling-toggle"]').click();
    await expect(page.locator('[data-testid="calling-toggle"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Settings owns the detail pane while it is open, so leave it the way the user
    // would before opening the calendar.
    await page.goBack();
    await expect(page.locator('[data-testid="settings-pane"]')).toHaveCount(0);

    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();

    const bar = page.locator('[data-testid="call-bar"]');
    await expect(bar).toBeVisible();
    // The meeting's own title, not a person: a meeting is not somebody.
    await expect(page.locator('[data-testid="call-peer"]')).toContainText("Architecture guild");
    // The lobby is its own state, and the user is told nobody has let them in yet.
    await expect(page.locator('[data-testid="call-phase"]')).toContainText("Waiting to be let in");
    // Nothing to answer: a meeting is joined, never offered.
    await expect(page.locator('[data-testid="call-answer"]')).toHaveCount(0);

    // Admitted, then the roster arrives and the bar says who is there.
    await expect(bar).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    await expect(page.locator('[data-testid="call-phase"]')).toContainText(/With \d+ others|With /, {
      timeout: 10_000,
    });

    // While a meeting is up, nothing else can start: one microphone.
    await calendarEvent(page, "ev-overlap-a").click();
    await expect(page.locator('[data-testid="meeting-join-here"]')).toBeDisabled();

    await page.locator('[data-testid="call-hangup"]').click();
    await expect(bar).toHaveCount(0);
  });

  /**
   * The picture. The service renegotiates on its own, the page answers it and subscribes,
   * and a colleague's shared screen and camera appear — the whole receive path
   * (NATIVE-CALLING.md § 10.3a), with no tenant and no camera behind it.
   */
  test("draws a colleague's shared screen and camera once the service offers them", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('[data-testid="open-settings"]').click();
    await page.locator('[data-testid="calling-toggle"]').click();
    await expect(page.locator('[data-testid="calling-toggle"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.goBack();
    await expect(page.locator('[data-testid="settings-pane"]')).toHaveCount(0);

    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();
    await expect(page.locator('[data-testid="call-bar"]')).toHaveAttribute(
      "data-phase",
      "connected",
      { timeout: 10_000 },
    );

    // Nothing is drawn until there is something to draw: the stage exists only when a
    // stream does, which is the same rule the agent transcript follows.
    const stage = page.locator('[data-testid="call-video"]');
    await expect(stage).toBeVisible({ timeout: 10_000 });

    // A SHARED SCREEN, named after the person the subscription asked for — the section
    // itself never says whose picture it carries.
    const shared = page.locator('[data-testid="call-video-frame"][data-sharing="true"]');
    await expect(shared).toHaveCount(1);
    await expect(shared).toHaveAttribute("data-label", "applicationsharing-video");
    await expect(shared).toContainText("Liam Nguyen is sharing");

    // And a CAMERA, which is a different label and a different size.
    const camera = page.locator('[data-testid="call-video-frame"][data-sharing="false"]');
    await expect(camera).toHaveCount(1);
    await expect(camera).toHaveAttribute("data-label", "main-video");
    await expect(camera).toContainText("Ava Thompson");
    // The audio section is labelled too, and it must never become a tile: an empty
    // rectangle for the call's own voices is worse than no rectangle.
    await expect(page.locator('[data-testid="call-video-frame"]')).toHaveCount(2);

    // Every frame really holds a stream. `srcObject` is the only way to attach one, so a
    // tile drawn without it would look identical and show nothing for ever.
    const attached = await page
      .locator('[data-testid="call-video-frame"] video')
      .evaluateAll((nodes) => nodes.map((node) => !!(node as HTMLVideoElement).srcObject));
    expect(attached).toEqual([true, true]);
    // And it is MUTED: the voices arrive on their own elements, and a video playing them
    // again would double every one.
    const muted = await page
      .locator('[data-testid="call-video-frame"] video')
      .evaluateAll((nodes) => nodes.every((node) => (node as HTMLVideoElement).muted));
    expect(muted).toBe(true);

    // Leaving takes the picture with it: a element left holding a stopped stream shows its
    // last frame for good, which reads as a call that is still up.
    await page.locator('[data-testid="call-hangup"]').click();
    await expect(stage).toHaveCount(0);
  });

  /**
   * Sending: the camera and the screen. Each is one click, each click is the consent for that
   * one action, and the browser asks its own permission under it — against the mock the
   * preview is a canvas, so nothing opens and no picker appears.
   */
  test("sends the camera and the screen, and says so to every client", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-testid="open-settings"]').click();
    await page.locator('[data-testid="calling-toggle"]').click();
    await page.goBack();
    await expect(page.locator('[data-testid="settings-pane"]')).toHaveCount(0);
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();

    // Nothing is offered while the call is still joining: the service refuses new media on a
    // call that is not established, so a button there would report a refusal the user could
    // do nothing about.
    await expect(page.locator('[data-testid="call-camera"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="call-bar"]')).toHaveAttribute(
      "data-phase",
      "connected",
      { timeout: 10_000 },
    );
    const camera = page.locator('[data-testid="call-camera"]');
    const share = page.locator('[data-testid="call-share"]');
    await expect(camera).toBeVisible();
    await expect(share).toBeVisible();
    // Off until asked. A camera that came on with the call would be the worst thing here.
    await expect(camera).toHaveAttribute("aria-pressed", "false");
    await expect(share).toHaveAttribute("aria-pressed", "false");

    await camera.click();
    await expect(camera).toHaveAttribute("aria-pressed", "true");
    // The sender sees their own picture. A screen share shows whatever else is on that
    // screen, so the only way to know what the meeting sees is to see it too.
    const mine = page.locator('[data-testid="call-video-local"]');
    await expect(mine).toHaveCount(1);
    await expect(mine).toHaveAttribute("data-kind", "camera");

    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "true");
    await expect(mine).toHaveCount(2);
    await expect(page.locator('[data-testid="call-video-local"][data-kind="screen"]')).toBeVisible();

    // Both buttons read the BACKEND's `call.sending`, not this page's own memory — which is
    // what makes a second page, and a phone that reconnects mid-call, draw them the same way.
    // That both are pressed after one round trip each is the observable half of it.
    await expect(camera).toHaveAttribute("aria-pressed", "true");
    await expect(share).toHaveAttribute("aria-pressed", "true");

    // And off again, which is the same path in reverse.
    await camera.click();
    await expect(camera).toHaveAttribute("aria-pressed", "false");
    await expect(mine).toHaveCount(1);
    await expect(page.locator('[data-testid="call-video-local"][data-kind="screen"]')).toBeVisible();

    // Leaving takes every preview with it, and releases every capture.
    await page.locator('[data-testid="call-hangup"]').click();
    await expect(page.locator('[data-testid="call-video-local"]')).toHaveCount(0);
  });
});