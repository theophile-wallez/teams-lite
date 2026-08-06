import { expect } from "@playwright/test";
import {
  calendarEvent,
  dropCallCapture,
  emitCallInvite,
  gotoApp,
  openCalendarTab,
  openCalendarView,
  openConversationNamed,
  refuseNextCallMedia,
  resetCall,
  test,
} from "./helpers";

// Audio calling: the switch that is the consent, the button that places a call, the
// ringing card with a working Answer, and the PAGE the call becomes once it is up
// (web/src/components/call-bar.tsx, call-stage.tsx and call-button.tsx, over
// web/src/lib/call.ts, call-stage.ts and call-media.ts — and src/calling.rs for the
// protocol).
//
// Nothing here registers anything with Teams, rings anybody, or opens a microphone. The
// mock reproduces the SIGNALING and the page pairs it with `simulatedCallMedia`, which it
// picks because the backend announced itself as a mock. So what this file pins is every
// rule that is ours to keep:
//
//   * calling is OFF until the user turns it on, and the button says so;
//   * what a conversation offers is decided by the conversation: ring the person, ring the
//     whole group, or JOIN the meeting the thread was minted for;
//   * the ringing card can be answered and declined, and a live call is muted from its
//     own page;
//   * a call that is up takes the screen, folds into a window that is dragged, and comes
//     back from where it was left;
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

  /** A group chat is CALLED, and the label says what that reaches: every member at once,
   *  which is the fact the user needs before a click nothing takes back. */
  test("rings the whole group from a group chat", async ({ page }) => {
    await gotoApp(page);
    await turnCallingOn(page);
    await openConversationNamed(page, "Platform Team");
    const button = page.locator('[data-testid="call-button"]');
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-label", /everybody in Platform Team/);

    await button.click();
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toBeVisible();
    // The CONVERSATION is named, not a person: a group of five has no one name, and the
    // roster is what answers "who" — once somebody picks up.
    await expect(page.locator('[data-testid="call-peer"]')).toContainText("Platform Team");
    await expect(page.locator('[data-testid="call-phase"]')).toContainText("Calling…");
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    await expect(page.locator('[data-testid="call-phase"]')).toContainText(/With /);

    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);
  });

  /** The meeting in the chat list is JOINED, from the thread itself — no calendar, and no
   *  link to find. It is the one control that thread gets: joining and ringing everybody
   *  invited answer the same question, and only one of them is what the thread is for. */
  test("joins the meeting a meeting chat was opened for", async ({ page }) => {
    await gotoApp(page);
    await turnCallingOn(page);
    // The header control of an ordinary chat first, so the box the meeting's own must match
    // is measured rather than assumed.
    await openConversationNamed(page, "Platform Team");
    const callBox = await page.locator('[data-testid="call-button"]').boundingBox();

    await openConversationNamed(page, "Design Sync");
    // No ring here, and the Join button states WHICH meeting it joins — the thread — so a
    // driver can prove its target before an outward click.
    await expect(page.locator('[data-testid="call-button"]')).toHaveCount(0);
    const join = page.locator('[data-testid="meeting-join-here"]');
    await expect(join).toBeEnabled();
    // It is the SAME control other chats have, to the pixel: this is one row of header
    // controls, and walking into a meeting chat must not move the thing the user is aiming
    // at. The words live in the tooltip and in the label a screen reader gets.
    await expect(join).toHaveAttribute("data-shape", "icon");
    await expect(join).toHaveAttribute("aria-label", /Join this meeting/);
    const joinBox = await join.boundingBox();
    expect(joinBox?.width).toBe(callBox?.width);
    expect(joinBox?.height).toBe(callBox?.height);
    expect(joinBox?.x).toBe(callBox?.x);
    const conversationId = await page
      .locator('[data-testid="composer-shell"]')
      .getAttribute("data-conversation-id");
    expect(conversationId).toMatch(/^19:meeting_/);
    await expect(join).toHaveAttribute("data-meeting-thread", conversationId!);
    // And no link, because none exists here: an address is stated in one shape only.
    await expect(join).not.toHaveAttribute("data-join-url", /./);

    await join.click();
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toBeVisible();
    // The thread's own name is the meeting's title — the backend reads it from the store
    // rather than the page minting a second spelling of it.
    await expect(page.locator('[data-testid="call-peer"]')).toContainText("Design Sync");
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });

    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);
  });

  /** Notes is the one chat with nobody in it, so it offers neither. */
  test("offers nothing in the chat with oneself", async ({ page }) => {
    await gotoApp(page);
    await turnCallingOn(page);
    await openConversationNamed(page, "Notes");
    await expect(page.locator('[data-testid="call-button"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="meeting-join-here"]')).toHaveCount(0);
  });

  test("places a call, shows it connect, and hangs up", async ({ page }) => {
    await gotoApp(page);
    await turnCallingOn(page);
    await openConversationNamed(page, "Ava Thompson");

    await page.locator('[data-testid="call-button"]').click();

    // Dialling first: the user has to see that the call is going out before it is
    // answered, because the microphone opens at that moment. It is already the page —
    // everything after the ring is the stage's, and the ring is the only offer.
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute("data-mode", "full");
    await expect(page.locator('[data-testid="call-peer"]')).toContainText("Ava Thompson");
    // Then the far side picks up and its SDP arrives, and the page counts the duration
    // from the backend's own clock.
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    await expect(page.locator('[data-testid="call-duration"]')).toContainText(/^\d+:\d\d$/);

    // While a call is up the button is refused rather than starting a second one. It is
    // behind the stage, so the assertion is about the control rather than about a click.
    await expect(page.locator('[data-testid="call-button"]')).toBeDisabled();

    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);
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

    // Answering hands the call to the page: the card is the offer, and the offer is over.
    await page.locator('[data-testid="call-answer"]').click();
    await expect(bar).toHaveCount(0);
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected");

    const mute = page.locator('[data-testid="call-mute"]').first();
    await expect(mute).toHaveAttribute("aria-pressed", "false");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "false");

    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);
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
    const notice = page.locator('[data-testid="call-notice"]');
    await expect(notice).toContainText("turned off");

    // And then it GOES, without anybody dismissing it. As a card it had no timer at all:
    // `not connected` sat over the chat list until the next call was placed, which is the
    // whole reason a notice is a notice and not state (web/src/lib/notice.ts).
    await expect(notice).toHaveCount(0, { timeout: NOTICE_GONE_MS });
  });

});

/** Long enough for the slowest notice (`ERROR_NOTICE_MS`) plus its exit, short enough
 *  that a notice which never left still fails this. */
const NOTICE_GONE_MS = 15_000;

/** How long a notice takes to slide in and stop moving — sonner's own 400ms transition,
 *  plus a frame. Well inside the notice's life, so a box read after it is the settled one. */
const NOTICE_SETTLE_MS = 450;

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
    // The link out is still there, and still a link — under the footer's "Open in", which
    // is where every way out of this app lives now that the panel holds two controls.
    await details.locator('[data-testid="calendar-event-open-in"]').click();
    await expect(page.locator('[data-testid="calendar-event-join"]')).toHaveAttribute(
      "target",
      "_blank",
    );
    await page.keyboard.press("Escape");
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
    const join = page.locator('[data-testid="meeting-join-here"]');
    // From the calendar the address is the LINK the event carries, and it is stated on the
    // button for the same reason the chat's thread is: an outward click a driver cannot
    // prove its target for is one it must not make. One shape at a time, never both.
    await expect(join).toHaveAttribute("data-join-url", /meetup-join/);
    await expect(join).not.toHaveAttribute("data-meeting-thread", /./);
    // A calendar event's panel keeps the LABELLED button: it sits beside a link that opens
    // real Teams, and there the words are what tell the two apart.
    await expect(join).toHaveAttribute("data-shape", "pill");
    await expect(join).toContainText("Join here");
    await join.click();

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toBeVisible();
    // The meeting's own title, not a person: a meeting is not somebody.
    await expect(page.locator('[data-testid="call-peer"]')).toContainText("Architecture guild");
    // The lobby is its own state, and the user is told nobody has let them in yet.
    await expect(page.locator('[data-testid="call-phase"]')).toContainText("Waiting to be let in");
    // Nothing to answer: a meeting is joined, never offered.
    await expect(page.locator('[data-testid="call-answer"]')).toHaveCount(0);
    // And no chat: this meeting was joined from a LINK, which names no thread at all — the
    // service resolves one from the code and never tells us, so there is nothing behind a
    // tab and no tab is drawn.
    await expect(page.locator('[data-testid="call-stage-chat-toggle"]')).toHaveCount(0);

    // Admitted, then the roster arrives and the page says who is there.
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    await expect(page.locator('[data-testid="call-phase"]')).toContainText(/With \d+ others|With /, {
      timeout: 10_000,
    });

    // While a meeting is up, nothing else can start: one microphone. The calendar is behind
    // the page now, so this is the user's own way back to it — fold the call, and the button
    // over there says no.
    await page.locator('[data-testid="call-stage-minimize"]').click();
    await expect(stage).toHaveAttribute("data-mode", "mini");
    await calendarEvent(page, "ev-overlap-a").click();
    await expect(page.locator('[data-testid="meeting-join-here"]')).toBeDisabled();

    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);
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
    await expect(page.locator('[data-testid="call-stage"]')).toHaveAttribute(
      "data-phase",
      "connected",
      { timeout: 10_000 },
    );

    // Nothing is drawn until there is something to draw: the picture region exists only when
    // a stream does, which is the same rule the agent transcript follows. Before that the
    // page carries the avatar card, and the two never share the room — which is the half that
    // can be asserted without racing the stream that is already on its way.
    const pictures = page.locator('[data-testid="call-video"]');
    await expect(pictures).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="call-stage-avatar"]')).toHaveCount(0);

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

    // Leaving takes the picture with it: an element left holding a stopped stream shows its
    // last frame for good, which reads as a call that is still up.
    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(pictures).toHaveCount(0);
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
    await expect(page.locator('[data-testid="call-stage"]')).toHaveAttribute(
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
    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(page.locator('[data-testid="call-video-local"]')).toHaveCount(0);
  });

  /**
   * A capture the service REFUSES, mid-call. Two things about it, and the card this notice
   * replaced got both wrong: it was drawn only while no call was live, so a mid-call
   * refusal was the one failure nobody was ever told about — and wherever the reason goes
   * now, it must not land on the controls the user acts with.
   */
  test("says why a capture was refused, clear of the controls it is about", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-testid="open-settings"]').click();
    await page.locator('[data-testid="calling-toggle"]').click();
    await page.goBack();
    await expect(page.locator('[data-testid="settings-pane"]')).toHaveCount(0);
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    const camera = page.locator('[data-testid="call-camera"]');
    await expect(camera).toBeVisible();

    await refuseNextCallMedia(page);
    await camera.click();

    const notice = page.locator('[data-testid="call-notice"]');
    await expect(notice).toContainText("refused");
    // In the service's own words, minus the RPC name it opens them with — that is written
    // for whoever holds the socket, and it reads as a fault code here (lib/call-failure.ts).
    await expect(notice).not.toContainText("call_offer_media");

    // WHERE it lands, measured rather than read off a class list. The promise is that a
    // notice never covers the controls it is about; the call's own controls are the page's
    // header, so the notice has to come to rest wholly below it.
    //
    // Measured once, and FIRST, because a notice does not stay: it slides in, waits out
    // `ERROR_NOTICE_MS` and slides back out, so a box read late is one of a notice leaving
    // and a box read after that is no box at all. One settle, then one measurement.
    await expect(notice).toHaveAttribute("data-mounted", "true");
    await page.waitForTimeout(NOTICE_SETTLE_MS);
    const noticeBox = await notice.boundingBox();
    const headerBox = await stage.locator("header").boundingBox();
    expect(noticeBox).toBeTruthy();
    expect(headerBox).toBeTruthy();
    expect(noticeBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);

    // The meeting is untouched: a picture that could not go out is no reason to end it, and
    // the capture was released rather than left running behind a button that says off.
    await expect(stage).toHaveAttribute("data-phase", "connected");
    await expect(camera).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('[data-testid="call-video-local"]')).toHaveCount(0);

    // And the click after it works: ONE refusal, so the surface is seen recovering.
    await camera.click();
    await expect(camera).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-testid="call-hangup"]').first().click();
  });

  /**
   * A capture the MEETING takes away, mid-call. It is the mirror of the refusal above: the
   * click worked, the picture went out, and then the service dropped the section — and it is
   * the failure nothing on the page would otherwise report, because all the user sees is
   * their own preview stopping.
   *
   * It reached a real user as the browser's own sentence, "The transceiver is stopped", the
   * next time they switched the camera OFF — a report of a click that had worked, about an
   * object they have never heard of.
   */
  test("releases a capture the meeting dropped, and says why it went off", async ({ page }) => {
    await page.goto("/");
    await turnCallingOn(page);
    await page.goBack();
    await expect(page.locator('[data-testid="settings-pane"]')).toHaveCount(0);
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    const camera = page.locator('[data-testid="call-camera"]');
    await camera.click();
    await expect(camera).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="call-video-local"]')).toHaveCount(1);

    await dropCallCapture(page, "camera");

    // RELEASED, without a click: a camera whose light is on with nowhere to send, under a
    // button that says the meeting can see it, is the worst shape this surface has.
    await expect(camera).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('[data-testid="call-video-local"]')).toHaveCount(0);
    // And SAID, because nothing else here would tell them — with the one action left.
    const notice = page.locator('[data-testid="call-notice"]');
    await expect(notice).toContainText("dropped your camera");
    await expect(notice).toContainText("Turn it on again");
    // In the user's own words: no transceiver, no SDP, no RPC name.
    await expect(notice).not.toContainText("transceiver");

    // The meeting is untouched, and the camera goes back on — the section is gone, not broken.
    await expect(stage).toHaveAttribute("data-phase", "connected");
    await camera.click();
    await expect(camera).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-testid="call-hangup"]').first().click();
  });
});

/**
 * The call as a PAGE, and as the window that page folds into
 * (web/src/components/call-stage.tsx, over web/src/lib/call-stage.ts).
 *
 * What is pinned here is the shape of the surface rather than the signaling — the joins
 * above already prove that. The two shapes are ONE element, so the geometry is measured
 * rather than assumed: a fold that re-mounted the call would drop the picture and the
 * microphone with it.
 */
test.describe("The call's own page", () => {
  test.afterEach(async ({ page }) => {
    await resetCall(page);
  });

  test("takes the screen, folds into a window that is dragged, and comes back from there", async ({
    page,
  }) => {
    await joinTheMeetingChat(page);
    const stage = page.locator('[data-testid="call-stage"]');
    const viewport = page.viewportSize()!;

    // The page IS the screen: a call is what the user is doing for as long as it runs.
    await expect(stage).toHaveAttribute("data-mode", "full");
    const full = (await stage.boundingBox())!;
    expect(Math.round(full.width)).toBe(viewport.width);
    expect(Math.round(full.height)).toBe(viewport.height);

    // Folded: a window, wholly on screen and clear of every edge.
    await page.locator('[data-testid="call-stage-minimize"]').click();
    await expect(stage).toHaveAttribute("data-mode", "mini");
    await expect(page.locator('[data-testid="call-stage-expand"]')).toBeVisible();
    await settle(page);
    const mini = (await stage.boundingBox())!;
    // Its own width on a desktop, and a 16:9 picture plus the control bar under it —
    // whatever the width, because a picture that is not 16:9 is one with black edges.
    expect(Math.round(mini.width)).toBe(320);
    expect(Math.round(mini.height)).toBe(Math.round((320 * 9) / 16) + 44);
    expect(mini.x).toBeGreaterThanOrEqual(8);
    expect(mini.y).toBeGreaterThanOrEqual(8);
    expect(mini.x + mini.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(mini.y + mini.height).toBeLessThanOrEqual(viewport.height - 8);

    // The app behind it is usable again, which is the whole point of folding: the
    // conversation's own composer is back, and there is exactly one of it.
    await expect(page.locator('[data-testid="composer-shell"]')).toHaveCount(1);

    // Dragged by its picture, and it stays where it was dropped.
    await dragStage(page, mini, { x: 300, y: 200 });
    const dropped = (await stage.boundingBox())!;
    expect(dropped.x).toBeLessThan(mini.x - 100);
    expect(dropped.y).toBeLessThan(mini.y - 100);

    // And back to the page. It is the SAME element throughout — nothing was re-mounted, so
    // the call it names has not changed.
    const callId = await stage.getAttribute("data-call-id");
    await page.locator('[data-testid="call-stage-expand"]').click();
    await expect(stage).toHaveAttribute("data-mode", "full");
    await settle(page);
    expect(await stage.getAttribute("data-call-id")).toBe(callId);
    expect(Math.round((await stage.boundingBox())!.width)).toBe(viewport.width);
  });

  /** Escape gives back what the last click took. It never ends the call: the one action on
   *  this surface that cannot be undone is the one a stray keystroke must not reach. */
  test("closes the panel on Escape, then folds — and never hangs up", async ({ page }) => {
    await joinTheMeetingChat(page);
    const stage = page.locator('[data-testid="call-stage"]');

    await page.locator('[data-testid="call-stage-people"]').click();
    await expect(page.locator('[data-testid="call-stage-panel"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="call-stage-panel"]')).toHaveCount(0);
    await expect(stage).toHaveAttribute("data-mode", "full");

    await page.keyboard.press("Escape");
    await expect(stage).toHaveAttribute("data-mode", "mini");
    // Still in the call, which is the half that matters.
    await expect(stage).toHaveAttribute("data-phase", "connected");
  });

  test("says who is in the meeting, and what each of them is sending", async ({ page }) => {
    await joinTheMeetingChat(page);
    await page.locator('[data-testid="call-stage-people"]').click();
    const rows = page.locator('[data-testid="call-stage-participant"]');
    // The roster the service reported, plus the user themselves — who is always in it and
    // always first: a meeting they are alone in still holds one person.
    await expect(rows).toHaveCount(4, { timeout: 10_000 });
    await expect(rows.first()).toHaveAttribute("data-you", "true");
    await expect(rows.first()).toContainText("You");
    await expect(page.locator('[data-testid="call-stage-people-panel"]')).toContainText("· 4");

    // What somebody is sending comes from the ROSTER's own streams: the mock gives the first
    // person a camera and the second a screen, and both are stated whether or not this page
    // has subscribed to either.
    await expect(rows.nth(1)).toContainText("Ava Thompson");
    await expect(rows.nth(1).locator('[aria-label="Camera on"]')).toHaveCount(1);
    await expect(rows.nth(2).locator('[aria-label="Sharing a screen"]')).toHaveCount(1);

    // Naming the tab again closes it, like every other toggle in this app.
    await page.locator('[data-testid="call-stage-people"]').click();
    await expect(page.locator('[data-testid="call-stage-panel"]')).toHaveCount(0);
  });

  /**
   * The meeting's chat, beside the picture — and the ONE composer.
   *
   * The panel adds no second composer: it takes the app's own, which is what carries the
   * live sentinel a sanctioned driver proves its target with. Two of them would give that
   * question two answers, so the count is the assertion.
   */
  test("opens the meeting's chat beside the picture by default, and keeps one composer", async ({
    page,
  }) => {
    await joinTheMeetingChat(page);
    const composer = page.locator('[data-testid="composer-shell"]');
    const thread = await composer.getAttribute("data-conversation-id");
    expect(thread).toMatch(/^19:meeting_/);

    // No click: a call in a conversation opens with that conversation beside it
    // (`initialCallStagePanel`).
    await expect(page.locator('[data-testid="call-stage-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="call-stage-transcript"]')).toBeVisible();
    await expect(page.locator('[data-testid="call-stage-chat-toggle"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // One composer, and it is the MEETING's: the panel renders the app's own thread, so the
    // sentinel still names exactly the conversation the words would go to.
    await expect(composer).toHaveCount(1);
    await expect(composer).toHaveAttribute("data-conversation-id", thread!);
    // The words really can be written here — the send itself stays the user's own Enter.
    await expect(page.locator('[data-testid="composer-send"]')).toBeVisible();

    // And the toggle still closes it, which hands the composer straight back to the
    // conversation behind the page.
    await page.locator('[data-testid="call-stage-chat-toggle"]').click();
    await expect(page.locator('[data-testid="call-stage-transcript"]')).toHaveCount(0);
    await expect(composer).toHaveCount(1);
    await expect(composer).toHaveAttribute("data-conversation-id", thread!);

    // Then open again, from the click this time.
    await page.locator('[data-testid="call-stage-chat-toggle"]').click();
    await expect(page.locator('[data-testid="call-stage-transcript"]')).toBeVisible();
  });
});

/** Join the meeting the chat list holds. It is the one call in the mock that has a roster,
 *  a picture and a thread of its own — which is everything this page draws. */
async function joinTheMeetingChat(page: import("@playwright/test").Page): Promise<void> {
  await gotoApp(page);
  await turnCallingOn(page);
  await openConversationNamed(page, "Design Sync");
  await page.locator('[data-testid="meeting-join-here"]').click();
  await expect(page.locator('[data-testid="call-stage"]')).toHaveAttribute(
    "data-phase",
    "connected",
    { timeout: 10_000 },
  );
}

/** Drag the folded window by its picture — never by its bar, where the controls are. */
async function dragStage(
  page: import("@playwright/test").Page,
  from: { x: number; y: number; width: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
  await settle(page);
}

/** Let the stage's morph finish. The two shapes are one animated element, so a geometry
 *  read mid-flight is a reading of the transition rather than of the result. */
async function settle(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForTimeout(700);
}
