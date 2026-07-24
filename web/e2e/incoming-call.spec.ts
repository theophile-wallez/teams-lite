import { test, expect, gotoApp, openConversationAt, emitCall, realErrors } from "./helpers";

// The incoming-call banner surfaces the backend's live `call` event so the user
// knows a call is ringing. It is AWARENESS only — teams-lite has no media stack,
// so "Answer" is deliberately disabled and the useful action just opens the chat.
// Driven here deterministically through the mock's gated test hook.
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
    // Awareness only: "Answer" is present but cannot be clicked.
    await expect(banner.getByTestId("incoming-call-answer")).toBeDisabled();
    // The call's participants ride along as an avatar stack.
    await expect(banner.locator('[data-testid="call-avatar"]')).toHaveCount(2);

    await banner.getByTestId("incoming-call-dismiss").click();
    await expect(banner).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
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
