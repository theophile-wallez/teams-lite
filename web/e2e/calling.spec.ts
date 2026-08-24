import { expect } from "@playwright/test";
import { CALL_END_UNREACHABLE } from "../src/lib/call";
import {
  calendarEvent,
  callFromMenu,
  closeConversationMenu,
  conversationMenuTrigger,
  disableCalling,
  answerCallMediaUnreadably,
  callSharingOrder,
  dropCallCapture,
  emitCallInvite,
  endCallWithReason,
  gotoApp,
  holdCallStart,
  joinMeetingFromMenu,
  openCalendarTab,
  openCalendarView,
  openConversationMenu,
  openConversationNamed,
  refuseNextCallMedia,
  rejectCallCapture,
  resetCall,
  test,
} from "./helpers";

// Audio calling: the row that places a call, the
// ringing card with a working Answer, and the PAGE the call becomes once it is up
// (web/src/components/call-bar.tsx, call-stage.tsx and conversation-menu.tsx, over
// web/src/lib/call.ts, call-stage.ts and call-media.ts — and src/calling.rs for the
// protocol).
//
// A CHAT's call is a ROW of the conversation's own menu rather than a control in its header,
// so every test that places one opens that menu first (`callFromMenu` / `joinMeetingFromMenu`
// in ./helpers). A CALENDAR event is untouched: it keeps its own labelled "Join here" beside
// its way out to real Teams, and the specs on that surface press it directly.
//
// Nothing here registers anything with Teams, rings anybody, or opens a microphone. The
// mock reproduces the SIGNALING and the page pairs it with `simulatedCallMedia`, which it
// picks because the backend announced itself as a mock. So what this file pins is every
// rule that is ours to keep:
//
//   * calling is ON with no switch to find, and a window that cannot call says so;
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

test.describe("Audio calling", () => {
  test.afterEach(async ({ page }) => {
    await resetCall(page);
  });

  test("is on the moment the app is open, with no switch to find", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");

    // No step in between but the menu the header's controls became: the backend registered as
    // a device the user's calls ring on at startup, the way every other Teams client they are
    // signed in on does, so the row is live the moment the app is.
    await openConversationMenu(page);
    const button = page.locator('[data-testid="call-button"]');
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-label", /Call Ava Thompson/);
    // And it states WHOM it rings, out of the app's own state — the same promise the Join
    // row makes about its meeting and the composer about its conversation. It is what
    // lets `scripts/call-live.ts` prove its target before an outward click, so it is
    // measured against the composer's own answer rather than against a fixture's id.
    const open = await page
      .locator('[data-testid="composer-shell"]')
      .getAttribute("data-conversation-id");
    expect(open).toBeTruthy();
    await expect(button).toHaveAttribute("data-conversation-id", open!);
    // Nothing says the call cannot be placed, which is the other half of "no switch to find".
    await expect(page.locator('[data-testid="conversation-call-reason"]')).toHaveCount(0);
    // Closed with its own trigger before the pane behind it is used: a press elsewhere would
    // be spent dismissing the menu instead of reaching what it landed on.
    await closeConversationMenu(page);

    // And Settings offers nothing about it, because there is nothing to offer.
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="calling-settings"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="calling-toggle"]')).toHaveCount(0);
  });

  /** A window whose backend does not call at all — a read-only one, or the second install
   *  beside the user's app. The control stays and says so: the feature exists, this window
   *  is not where it happens, and the sentence never sends them to a switch. */
  test("says so in a window that cannot take calls", async ({ page }) => {
    await gotoApp(page);
    await disableCalling(page);
    await openConversationNamed(page, "Ava Thompson");

    await openConversationMenu(page);
    const button = page.locator('[data-testid="call-button"]');
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-label", /cannot take calls/);
    await expect(button).not.toHaveAttribute("aria-label", /Settings/);
    // And the sentence is drawn as a ROW under the one it explains, which is what the menu
    // bought: it used to be a tooltip, and a disabled control fires no pointer events — so on
    // a phone the whole explanation was a sentence that did not exist.
    const reason = page.locator('[data-testid="conversation-call-reason"]');
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(/cannot take calls/);
    await expect(reason).not.toContainText(/Settings/);
    await closeConversationMenu(page);

    // A meeting is the other half of the same sentence.
    await openConversationNamed(page, "Design Sync");
    await openConversationMenu(page);
    const join = page.locator('[data-testid="meeting-join-here"]');
    await expect(join).toBeDisabled();
    await expect(page.locator('[data-testid="conversation-call-reason"]')).toContainText(
      /cannot take calls/,
    );
    await closeConversationMenu(page);
  });

  /** A group chat is CALLED, and the label says what that reaches: every member at once,
   *  which is the fact the user needs before a click nothing takes back. */
  test("rings the whole group from a group chat", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Platform Team");
    await openConversationMenu(page);
    const button = page.locator('[data-testid="call-button"]');
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute("aria-label", /everybody in Platform Team/);
    // The WORDS say it too, which is the one thing a menu has and a row of glyphs did not: both
    // actions wear the handset, so the label is what tells a ring from a join.
    await expect(button).toContainText(/everybody/i);

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
    // The header's own control in an ordinary chat first, so what the meeting's must match is
    // measured rather than assumed.
    //
    // WHAT IS MEASURED CHANGED WITH THE MENU, and the premise is what changed rather than the
    // point. This used to compare the CALL button's box with the JOIN button's, because the
    // header held a row of controls and walking into a meeting chat must not move the thing
    // the reader aims at — two components, one slot, so the pixels were the only proof. There
    // is one control in that slot now and it is the same element in every conversation, so the
    // comparison to make is the TRIGGER against itself across the two threads: that is the
    // promise the menu was built to keep, and the reason a call costs a second press.
    await openConversationNamed(page, "Platform Team");
    const chatTrigger = await conversationMenuTrigger(page).boundingBox();

    await openConversationNamed(page, "Design Sync");
    const meetingTrigger = await conversationMenuTrigger(page).boundingBox();
    expect(meetingTrigger?.width).toBe(chatTrigger?.width);
    expect(meetingTrigger?.height).toBe(chatTrigger?.height);
    expect(meetingTrigger?.x).toBe(chatTrigger?.x);
    expect(meetingTrigger?.y).toBe(chatTrigger?.y);

    await openConversationMenu(page);
    // No ring here, and the Join row states WHICH meeting it joins — the thread — so a
    // driver can prove its target before an outward click.
    await expect(page.locator('[data-testid="call-button"]')).toHaveCount(0);
    const join = page.locator('[data-testid="meeting-join-here"]');
    await expect(join).toBeEnabled();
    await expect(join).toHaveAttribute("aria-label", /Join this meeting/);
    // Inside the menu the WORDS are what tell a join from a ring, which is what a row buys and
    // what two 20px handsets side by side could not say at all.
    await expect(join).toContainText(/join the meeting/i);
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
    await openConversationNamed(page, "Notes");
    // OPENED, which is what makes this an assertion at all: with the menu shut every row is out
    // of the DOM, so a bare count of zero would pass just as happily in the 1:1 that DOES ring
    // somebody. The menu being open is asserted with it, for the same reason.
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="call-button"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="meeting-join-here"]')).toHaveCount(0);
    // Absent, not disabled-with-a-reason: there is nobody to ring, which is a fact about the
    // conversation rather than about this window.
    await expect(page.locator('[data-testid="conversation-call-reason"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="agent-mode-toggle"]')).toBeVisible();
    await closeConversationMenu(page);
  });

  test("places a call, shows it connect, and hangs up", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");

    await callFromMenu(page);

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

    // While a call is up the row is refused rather than starting a second one, and it SAYS why.
    // The call has to be FOLDED to read it: a live call is a page over the whole app, so the
    // header behind it is not something a reader — or a driver — can press. That is the honest
    // way to this state and the reader's own way to it, and it is what the fold exists for.
    await page.locator('[data-testid="call-stage-minimize"]').click();
    await expect(stage).toHaveAttribute("data-mode", "mini");
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="call-button"]')).toBeDisabled();
    await expect(page.locator('[data-testid="conversation-call-reason"]')).toContainText(
      "one call at a time",
    );
    await closeConversationMenu(page);

    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);
    // An ending the user caused says nothing back at them: they were there.
    await expect(page.locator('[data-testid="call-notice"]')).toHaveCount(0);
    // And the slot is free again, which is a row that can be pressed and no reason under it.
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="call-button"]')).toBeEnabled();
    await expect(page.locator('[data-testid="conversation-call-reason"]')).toHaveCount(0);
    await closeConversationMenu(page);
  });

  /**
   * A call that rang NOTHING: the person has no client signed in, so the service invites
   * nobody and ends the conversation a beat later.
   *
   * It is the ending the user cannot tell from a fault of this app's — measured against the
   * tenant, the call dies two seconds after they press it — and all they were told was "The
   * call ended.", five times in a row. So the sentence has to name the person and the cause.
   */
  test("says a call rang nothing, and whose devices were not there", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");
    await callFromMenu(page);
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toBeVisible();
    // Wait for the call to be UP before the service ends it, like every other test here.
    // Measured against the tenant, this ending arrives on an established call — it is
    // answered with an SDP and ended two seconds later — and a `stage` that is merely
    // visible is a call still DIALING: a start is three awaits long (reserve, open the
    // microphone, post the offer), so an end injected inside it made the page's own
    // `call_place` land on a call the mock had already dropped, and the notice said
    // "no such call" instead of who could not be reached. Flaky one run in three.
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });

    await endCallWithReason(page, CALL_END_UNREACHABLE);

    const notice = page.locator('[data-testid="call-notice"]');
    await expect(notice).toContainText("Ava Thompson could not be reached");
    await expect(notice).toContainText("no device of theirs is signed in");
    // The service's own words never reach the user: "addParticipantFailure" and a sub-code
    // are written for whoever holds the socket (lib/call-failure.ts makes the same promise).
    await expect(notice).not.toContainText(/addParticipant|subCode|endpoint/);
    // And the call is gone, so the next one can be placed.
    await expect(stage).toHaveCount(0);
    await expectCallCanBePlaced(page);
  });

  /** A call stopped a second after it was placed. The user is inside one of the waits a
   *  start is made of, and what they did is the ordinary mis-click — so the app owes them
   *  silence, and owes the person they nearly rang a call that never rings.
   *
   *  Both halves used to fail: the start ran on to the end, the backend refused the offer
   *  for a call it had already let go, and that refusal was floated at the user as a fault
   *  ("no such call — call_prepare first") for a call they stopped themselves. */
  test("says nothing when the user stops a call while it is still starting", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");

    // The reservation answers late: the stage is up and dialling, and the offer has not
    // gone out yet — the window a microphone and an ICE gather really take.
    await holdCallStart(page, "prepare", 900);
    await callFromMenu(page);

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute("data-phase", "dialing");
    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);

    // The wait IS the assertion: the refusal arrived when the held step came back, which
    // is after the click that caused it. Long enough to cover the hold and the two frames
    // a placed call would have answered with.
    await page.waitForTimeout(1_600);
    await expect(page.locator('[data-testid="call-notice"]')).toHaveCount(0);
    await expect(stage).toHaveCount(0);
    // And the slot is free: a machine still holding a reservation refuses the next call.
    await expectCallCanBePlaced(page);
  });

  /** The other half of the same click, one step later: the invite is already on the wire.
   *  Nothing here can prove what the service was told — that is `hang_up_orphan` in
   *  src/bin/server.rs, which ends the placed call on the links its answer carried — but
   *  the page must not connect a call the user stopped, and must still say nothing. */
  test("does not connect a call the user stopped while the invite went out", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");

    await holdCallStart(page, "place", 900);
    await callFromMenu(page);

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "dialing");
    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);

    await page.waitForTimeout(1_600);
    await expect(stage).toHaveCount(0);
    await expect(page.locator('[data-testid="call-notice"]')).toHaveCount(0);
    await expectCallCanBePlaced(page);
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

  /** A machine that stops taking calls takes the call with it: it stops being a device
   *  the user's calls ring on, and a call in flight cannot outlive that. It is what the
   *  app does as it shuts down, and the ending is one the user did not ask for — so it is
   *  stated, once. */
  test("ends the call when this machine stops taking calls", async ({ page }) => {
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

    await disableCalling(page);

    await expect(page.locator('[data-testid="call-bar"]')).toHaveCount(0);
    // This ending the user did not ask for, so it is stated once.
    const notice = page.locator('[data-testid="call-notice"]');
    await expect(notice).toContainText("stopped taking calls");

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
    // The in-app join is live, because this backend takes calls — there is no switch to
    // find, and the event states the meeting it joins.
    const join = details.locator('[data-testid="meeting-join-here"]');
    await expect(join).toBeVisible();
    await expect(join).toBeEnabled();
    await expect(join).toHaveAttribute("aria-label", /Join this meeting/);

    // And in a window whose backend does not take calls at all — a read-only one, or the
    // second install — it stays, disabled, saying that rather than naming a switch.
    await disableCalling(page);
    await expect(join).toBeDisabled();
    await expect(join).toHaveAttribute("aria-label", /cannot take calls/);
  });

  test("joins a meeting: the lobby, then the meeting, then who is in it", async ({ page }) => {
    await gotoApp(page);

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

  /**
   * A SCREEN asks the meeting to present before it offers a picture.
   *
   * A meeting shows one screen at a time, so sharing one is a session and not a track: measured
   * on 2026-08-06, a meeting rejected an `applicationsharing-video` section outright — no mid,
   * no label, a zeroed port — from an endpoint that had never asked to present, with the
   * section labelled correctly and offering the codecs a client offers.
   *
   * The ORDER is what this pins, because no screen can show it: a page that offered the media
   * first would look exactly right and share nothing at all.
   */
  test("asks the meeting to present before it offers the picture, and gives the session back", async ({
    page,
  }) => {
    await page.goto("/");
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    const share = page.locator('[data-testid="call-share"]');
    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "true");

    // The session FIRST, the section after it. Offering the other way round is the failure
    // this whole path exists for.
    expect(await callSharingOrder(page)).toEqual(["start_sharing", "offer_media"]);

    // A CAMERA asks for NO session: it is a track, and a meeting carries as many as it has
    // people. Only the one screen is a session — so its own offer adds a section and no
    // second modality, however many times the sections are re-stated.
    const sessions = async () =>
      (await callSharingOrder(page)).filter((step) => step === "start_sharing").length;
    await page.locator('[data-testid="call-camera"]').click();
    await expect(page.locator('[data-testid="call-camera"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await sessions()).toBe(1);

    // And it is GIVEN BACK on the way out, so the next share is granted one. The mock refuses
    // a second session while one is held, so a stop that never happened makes this click fail.
    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "false");
    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "true");
    expect(await sessions()).toBe(2);
    // Still the session first: the second share asked again before it offered again.
    expect((await callSharingOrder(page)).slice(-2)).toEqual(["start_sharing", "offer_media"]);

    await page.locator('[data-testid="call-hangup"]').first().click();
  });

  /**
   * A share while a COLLEAGUE is presenting: the session changes hands, and theirs stops.
   *
   * A meeting shows one screen at a time, and that is a rule about the meeting rather than a
   * reason to refuse the user: measured 2026-08-06 against a colleague's real share, the
   * service granted this endpoint the role and offered their `applicationsharing-video`
   * section straight back at PORT 0. It is what every Teams client does, so it is what this
   * app does — it used to REFUSE the press, which took the one action the user came for away
   * in the very state they wanted it in.
   *
   * One click, and no arming: Teams asks nobody, and the colleague can take it straight back.
   * What the app owes them is the sentence BEFORE the press, which is what the control carries.
   */
  test("takes the share off a colleague who holds it, and says so before the press", async ({
    page,
  }) => {
    await page.goto("/");
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    // Their screen, on the stage: the state this press is about.
    const theirs = page.locator('[data-testid="call-video-frame"][data-sharing="true"]');
    await expect(theirs).toHaveCount(1, { timeout: 10_000 });

    // What the press COSTS, in the control's own words and naming the person it costs it to.
    const share = page.locator('[data-testid="call-share"]');
    await expect(share).toHaveAttribute("title", /this stops the screen Liam Nguyen is sharing/);

    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "true");
    // Their picture goes, because the service zeroes their section — and the ROSTER says so
    // too, which is the half a reader sees when they never subscribed to the picture.
    await expect(theirs).toHaveCount(0);
    await expect(page.locator('[data-testid="call-video-local"][data-kind="screen"]')).toBeVisible();
    await page.locator('[data-testid="call-stage-people"]').click();
    await expect(
      page.locator('[data-testid="call-stage-participant"] [aria-label="Sharing a screen"]'),
    ).toHaveCount(1);
    // The one row that says it is the user's own: the share moved, it did not double.
    await expect(
      page.locator(
        '[data-testid="call-stage-participant"][data-you="true"] [aria-label="Sharing a screen"]',
      ),
    ).toHaveCount(1);

    // And nothing FAILED: the press is not a refusal any more, so there is no notice at all.
    await expect(page.locator('[data-testid="call-notice"]')).toHaveCount(0);
    // The control says only what it does now — the cost is spent, so the sentence is gone.
    await expect(share).toHaveAttribute("title", "Stop sharing the screen");

    await page.locator('[data-testid="call-hangup"]').first().click();
  });

  /**
   * A capture the meeting never ACCEPTS: the section rejected in the answer to the very offer
   * that added it. This is what a screen share really met on this tenant.
   *
   * It is not the drop above, and the difference is the advice. The app used to call this a
   * drop, so the user was told to share it again — and the second share met the same refusal
   * in the same second. Nothing was ever shown, so the sentence has to say that and name what
   * is really left.
   */
  test("says a capture the meeting never accepted was never shown", async ({ page }) => {
    await page.goto("/");
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();

    await page.locator('[data-testid="meeting-join-here"]').click();
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    const share = page.locator('[data-testid="call-share"]');
    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "true");

    await rejectCallCapture(page, "screen");

    // Released, like a drop — and SAID differently, which is the whole point of the split.
    await expect(share).toHaveAttribute("aria-pressed", "false");
    const notice = page.locator('[data-testid="call-notice"]');
    await expect(notice).toContainText("would not accept your screen share");
    await expect(notice).toContainText("nothing was shown");
    // Never the drop's advice: sharing again meets the same refusal, and it did.
    await expect(notice).not.toContainText("Share it again");
    // The call is untouched, exactly as it is for every other failure in a renegotiation.
    await expect(stage).toHaveAttribute("data-phase", "connected");
    await page.locator('[data-testid="call-hangup"]').first().click();
  });

  /**
   * A mid-call answer this browser CANNOT READ, which is what a screen share really met on
   * this tenant — and the one that cost a user their call.
   *
   * They shared their screen in a real call, the service answered, the browser threw the
   * answer out, and this app hung up: an error message, and then they could not hear their
   * coworker. The rule the whole surface is built on says the opposite — audio is already up,
   * so a renegotiation that fails costs one picture and nothing else — and the reaction to
   * THE answer is what that rule was written against, not the reaction to a later one.
   */
  test("keeps the call when a mid-call answer cannot be read, and releases the picture", async ({
    page,
  }) => {
    await page.goto("/");
    await openCalendarTab(page);
    await openCalendarView(page, "day");
    await calendarEvent(page, "ev-overlap-a").click();
    await page.locator('[data-testid="meeting-join-here"]').click();

    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    const share = page.locator('[data-testid="call-share"]');
    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="call-video-local"]')).toHaveCount(1);

    await answerCallMediaUnreadably(page);

    // The picture is RELEASED, and the service is told: the offer will never be completed,
    // so a capture behind a button that says the meeting can see it is a light on for
    // nothing. The button reads the BACKEND's own `sending`, so this is also the proof that
    // the take-back offer went out.
    await expect(share).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator('[data-testid="call-video-local"]')).toHaveCount(0);

    // Said, with the half the user needs most: they are still in the call. Everything they
    // can see — the share stopping, an error arriving — says otherwise.
    const notice = page.locator('[data-testid="call-notice"]');
    await expect(notice).toContainText("your screen share stopped");
    await expect(notice).toContainText("still in the call");

    // And THE CALL IS STILL UP, which is the rule this test exists for. It is asserted after
    // the reaction rather than before it: the failure it guards against released nothing and
    // said nothing, so the assertions above are what a regression trips on first, and this
    // one is what the whole surface promises.
    await expect(stage).toHaveAttribute("data-phase", "connected");
    // In the user's own words. The browser's own sentence about a session description is
    // written for whoever reads a console.
    await expect(notice).not.toContainText("SessionDescription");

    // And sharing again works: the connection was rolled back to where it stood, not left
    // holding an offer nothing will ever answer.
    await share.click();
    await expect(share).toHaveAttribute("aria-pressed", "true");
    await expect(stage).toHaveAttribute("data-phase", "connected");
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
  await openConversationNamed(page, "Design Sync");
  await joinMeetingFromMenu(page);
  await expect(page.locator('[data-testid="call-stage"]')).toHaveAttribute(
    "data-phase",
    "connected",
    { timeout: 10_000 },
  );
}

/**
 * That the app is ready to place the NEXT call — the state four of these tests end on, because
 * a machine still holding a reservation refuses one and says nothing about why.
 *
 * It opens the menu, reads the row, and closes it again: the row exists only while the menu
 * does, so "the control is enabled" is now two presses' worth of work and belongs in one place.
 */
async function expectCallCanBePlaced(page: import("@playwright/test").Page): Promise<void> {
  await openConversationMenu(page);
  await expect(page.locator('[data-testid="call-button"]')).toBeEnabled();
  await expect(page.locator('[data-testid="conversation-call-reason"]')).toHaveCount(0);
  await closeConversationMenu(page);
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
