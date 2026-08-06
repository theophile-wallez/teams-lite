import {
  test,
  expect,
  gotoApp,
  openConversationAt,
  openConversationNamed,
  emitCall,
  realErrors,
} from "./helpers";

// The incoming-call banner surfaces the backend's live `call` event so the user knows a
// call is ringing in a conversation nothing rang here. Every action on it really happens:
// a ringing MEETING is joined from the card, and every other conversation is opened — there
// is no control on it that cannot be pressed. Driven here deterministically through the
// mock's gated test hook.
test.describe("incoming call banner", () => {
  test("rings for an incoming call and clears on dismiss", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);
    const banner = page.locator('[data-testid="incoming-call-banner"]');
    await expect(banner).toHaveCount(0);

    await emitCall(page, {
      conversation: conv,
      caller: "Riley Carter",
      participants: ["Riley Carter", "Jordan Lee"],
      participant_count: 2,
    });
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId("incoming-call-title")).toContainText("Incoming call");
    // An ordinary chat's call is not addressable from here — its thread names no meeting —
    // so the card offers the chat and nothing else. It carries NO disabled control: it used
    // to hold an "Answer" that could never be pressed, from before this app could call at
    // all, and a button nobody can press says less than no button.
    await expect(banner.locator('[data-testid="meeting-join-here"]')).toHaveCount(0);
    await expect(banner.locator("button:disabled")).toHaveCount(0);
    await expect(banner.getByTestId("incoming-call-open")).toBeEnabled();
    // The call's participants ride along as an avatar stack.
    await expect(banner.locator('[data-testid="call-avatar"]')).toHaveCount(2);

    await banner.getByTestId("incoming-call-dismiss").click();
    await expect(banner).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  /** The one ringing conversation this card can act on: a meeting's thread IS its join
   *  address, so the meeting is joined from the card the user is deciding at. */
  test("joins the meeting a ringing meeting chat names", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Design Sync");
    const thread = await page
      .locator('[data-testid="composer-shell"]')
      .getAttribute("data-conversation-id");
    expect(thread).toMatch(/^19:meeting_/);

    await emitCall(page, { conversation: thread!, caller: "Riley Carter" });
    const banner = page.locator('[data-testid="incoming-call-banner"]');
    await expect(banner).toBeVisible();

    // The app's own Join control, carrying the rails it already has: the address it states
    // for a driver to prove before an outward click, and never a disabled row.
    const join = banner.locator('[data-testid="meeting-join-here"]');
    await expect(join).toBeEnabled();
    await expect(join).toHaveAttribute("data-meeting-thread", thread!);
    await expect(join).not.toHaveAttribute("data-join-url", /./);
    // One row, one height — measured rather than trusted, because the two controls come
    // from two components and a card asking one question must not read as two designs.
    const joinBox = await join.boundingBox();
    const openBox = await banner.getByTestId("incoming-call-open").boundingBox();
    expect(joinBox?.height).toBe(openBox?.height);

    await join.click();
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 10_000 });
    // One call, one card: the awareness card for the conversation this call is in goes, so
    // the app never argues with itself about the same meeting.
    await expect(banner).toHaveCount(0);

    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(stage).toHaveCount(0);
    // The meeting is still ringing as far as awareness knows, so end it: one mock process
    // serves the whole run, and a card left up would stand over every later spec.
    await emitCall(page, { conversation: thread!, event: "ended" });
    await expect(banner).toHaveCount(0);
  });

  test("clears the banner when the call ends", async ({ page }) => {
    await gotoApp(page);
    const conv = await openConversationAt(page, 0);
    const banner = page.locator('[data-testid="incoming-call-banner"]');

    await emitCall(page, { conversation: conv, caller: "Riley Carter" });
    await expect(banner).toBeVisible();

    // A terminal call event (the call ended) dismisses the ringing banner.
    await emitCall(page, { conversation: conv, event: "ended", caller: "Riley Carter" });
    await expect(banner).toHaveCount(0);
  });

  test("Open chat jumps to the ringing conversation and clears the banner", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const secondRow = page.locator('[data-testid="conversation-row"]').nth(1);
    const secondId = await secondRow.getAttribute("data-conversation-id");
    expect(secondId).toBeTruthy();

    // A call rings in a DIFFERENT conversation than the open one.
    await emitCall(page, { conversation: secondId!, caller: "Jordan Lee" });
    const banner = page.locator('[data-testid="incoming-call-banner"]');
    await expect(banner).toBeVisible();

    await banner.getByTestId("incoming-call-open").click();
    // Opening the chat navigates to that conversation and clears the banner.
    await expect(banner).toHaveCount(0);
    await expect(page).toHaveURL(/\/c\//);
  });
});
