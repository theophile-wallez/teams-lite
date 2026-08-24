import { expect, type Page } from "@playwright/test";
import {
  callFromMenu,
  disableCalling,
  emitCallInvite,
  fetchCapturedSends,
  gotoApp,
  openConversationNamed,
  resetCall,
  setSendControl,
  test,
} from "./helpers";

// Recording a call: teams-lite's own file, made in this page, kept in this browser, and
// drawn in the conversation for the one person who pressed record
// (web/src/components/call-stage.tsx and call-recording-card.tsx, over
// web/src/lib/call-recording.ts, call-recorder.ts and recording-store.ts).
//
// Nothing here reaches a tenant. The mock reproduces the signaling and the page pairs it
// with `simulatedCallMedia`, whose pictures are canvases and whose one voice is a silent
// oscillator — so a real `MediaRecorder` really writes a real webm out of them, with no
// camera, no microphone and no permission prompt. What this file pins is every rule that is
// ours to keep:
//
//   * a call is recorded only once its audio is up, and one press starts it;
//   * the control says, before it is pressed, that nobody on the call is told;
//   * stopping keeps the file, and it appears in the conversation as its own row — never as
//     a message, and never sent: the mock's send log stays empty across the whole flow;
//   * the row says only this user can see it, and where it is kept;
//   * hanging up while recording keeps the recording, because a file that exists nowhere
//     else must not depend on who ended the call — and what became of the FILE never covers
//     why the CALL ended;
//   * a reload keeps it, and deleting it — asked twice — takes it for good.
//
// Every test ends by resetting the mock, like every other calling spec: one mock process
// serves the whole run and a call left up would be live inside every later file.

/** Get into a connected call in a named conversation, which is the state a recording needs.
 *
 *  Calling itself needs no step: this app registers as a device the user's calls ring on at
 *  startup, so the row is live the moment the app is — it is a row of the conversation's own
 *  menu now rather than a glyph in its header, which is the one press this adds. */
async function callIsUp(page: Page, conversation = "Ava Thompson"): Promise<void> {
  await gotoApp(page);
  await openConversationNamed(page, conversation);
  await callFromMenu(page);
  const stage = page.locator('[data-testid="call-stage"]');
  await expect(stage).toBeVisible();
  await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 15_000 });
}

/** Record for a beat, then stop, and wait for the file to be written. */
async function recordFor(page: Page, ms: number): Promise<void> {
  const record = page.locator('[data-testid="call-record"]');
  await expect(record).toBeVisible();
  await record.click();
  await expect(record).toHaveAttribute("data-recording", "true");
  await page.waitForTimeout(ms);
  await record.click();
}

/**
 * Hang up, and wait for the page to be the conversation again.
 *
 * A live call is a PAGE over the whole app (§ A call is a page), so the recording's card in
 * the history is behind it until the call ends — which is when the user reaches for the card
 * anyway. A spec that clicked through the stage would be proving something no user can do.
 */
async function hangUp(page: Page): Promise<void> {
  await page.locator('[data-testid="call-hangup"]').first().click();
  await expect(page.locator('[data-testid="call-stage"]')).toHaveCount(0);
}

test.describe("Recording a call", () => {
  // The send log is the MOCK's, and one mock process serves the whole run — so "nothing was
  // sent" can only be asserted against a log this test emptied. Without it the claim is
  // "nothing in the entire run was sent", which every spec that sends a message breaks, and
  // whose failure names this flow rather than the specs that really wrote.
  test.beforeEach(async ({ page }) => {
    await setSendControl(page, { clear: true });
  });

  test.afterEach(async ({ page }) => {
    await resetCall(page);
  });

  test("is offered only once the call's audio is up, and says nobody is told", async ({ page }) => {
    await gotoApp(page);
    // A call that is RINGING is an offer, not a call: no microphone is open and there is
    // nothing to record, so there is no control at all.
    await openConversationNamed(page, "Ava Thompson");
    const conversation =
      (await page.locator('[data-testid="composer-shell"]').getAttribute("data-conversation-id")) ??
      "";
    await emitCallInvite(page, conversation);
    await expect(page.locator('[data-testid="call-bar"]')).toHaveAttribute("data-phase", "ringing");
    await expect(page.locator('[data-testid="call-record"]')).toHaveCount(0);

    await page.locator('[data-testid="call-answer"]').click();
    const stage = page.locator('[data-testid="call-stage"]');
    await expect(stage).toHaveAttribute("data-phase", "connected", { timeout: 15_000 });

    const record = page.locator('[data-testid="call-record"]');
    await expect(record).toBeVisible();
    await expect(record).toHaveAttribute("aria-label", /Record this call/);
    // The one fact the user decides with, before they press: this is not Teams' recording,
    // so the people on the call are not told.
    await expect(record).toHaveAttribute("title", /nobody on the call is told/i);
    await expect(record).toHaveAttribute("title", /Teams never sees it/i);
  });

  test("records on one press, counts its own time, and keeps the file on stop", async ({
    page,
  }) => {
    await callIsUp(page);
    const record = page.locator('[data-testid="call-record"]');
    await record.click();

    // While it runs the control IS the state: pressed, and counting from its own start
    // rather than from the call's.
    await expect(record).toHaveAttribute("data-recording", "true");
    await expect(record).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="call-record-elapsed"]')).toHaveText(/^\d+:\d\d$/);

    await page.waitForTimeout(1600);
    await record.click();

    // The recording is kept, and the app says so once.
    await expect(page.locator('[data-testid="call-recording-notice"]')).toContainText(
      /Recording kept/,
      { timeout: 15_000 },
    );
    // And the control is back to offering a new one.
    await expect(record).toHaveAttribute("aria-label", /Record this call/, { timeout: 15_000 });
  });

  test("appears in the conversation as its own row, and nothing was sent", async ({ page }) => {
    await callIsUp(page);
    await recordFor(page, 1600);

    // The card is in the conversation the call was in…
    const card = page.locator('[data-testid="call-recording"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('[data-testid="call-recording-video"]')).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await expect(card.locator('[data-testid="call-recording-duration"]')).toHaveText(/^\d+:\d\d$/);
    await expect(card.locator('[data-testid="call-recording-size"]')).not.toBeEmpty();
    // …and it says the two things the reader would otherwise assume.
    await expect(card.locator('[data-testid="call-recording-privacy"]')).toContainText(
      /Only you can see this/,
    );
    await expect(card.locator('[data-testid="call-recording-privacy"]')).toContainText(
      /kept in this browser/,
    );

    // It is NOT a message: no bubble, no reactions, and above all nothing left this machine.
    await expect(card.locator('[data-testid="message"]')).toHaveCount(0);
    expect(await fetchCapturedSends(page)).toEqual([]);
  });

  test("says what became of the file without covering why the call ended", async ({ page }) => {
    await callIsUp(page);
    await page.locator('[data-testid="call-record"]').click();
    await expect(page.locator('[data-testid="call-record"]')).toHaveAttribute(
      "data-recording",
      "true",
    );
    await page.waitForTimeout(1200);

    // A backend that stops taking calls ends this one for a reason the user did not choose —
    // and it ends the recording with it. Both are said, in notices of their own: the reason the
    // CALL ended is the half nobody can work out for themselves, so what became of the FILE
    // must never replace it.
    await disableCalling(page);
    await expect(page.locator('[data-testid="call-notice"]').first()).toContainText(
      /stopped taking calls/,
      { timeout: 15_000 },
    );
    await expect(page.locator('[data-testid="call-recording-notice"]')).toContainText(
      /Recording kept/,
      { timeout: 15_000 },
    );
  });

  test("survives the hangup that ended the call it was recording", async ({ page }) => {
    await callIsUp(page);
    const record = page.locator('[data-testid="call-record"]');
    await record.click();
    await expect(record).toHaveAttribute("data-recording", "true");
    await page.waitForTimeout(1600);

    // The user hangs up mid-recording — which is the ordinary way a recorded call ends.
    await page.locator('[data-testid="call-hangup"]').first().click();
    await expect(page.locator('[data-testid="call-stage"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="call-recording"]')).toBeVisible({ timeout: 15_000 });
    expect(await fetchCapturedSends(page)).toEqual([]);
  });

  test("is still there after a reload, and is listed in Settings", async ({ page }) => {
    await callIsUp(page);
    await recordFor(page, 1600);
    await expect(page.locator('[data-testid="call-recording"]')).toBeVisible({ timeout: 15_000 });
    await hangUp(page);

    // The file is this browser's, so a reload finds it again — which is the whole point of
    // keeping it rather than holding it in the page.
    await gotoApp(page);
    await openConversationNamed(page, "Ava Thompson");
    await expect(page.locator('[data-testid="call-recording"]')).toBeVisible({ timeout: 15_000 });

    // And Settings lists it, which is how a recording made in a link-joined meeting — and one
    // made months ago — is reachable at all.
    await page.locator('[data-testid="open-settings"]').click();
    const rows = page.locator('[data-testid="call-recording-row"]');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('[data-testid="call-recordings-total"]')).toContainText(
      /1 recording/,
    );
  });

  test("is deleted only when the user says so twice", async ({ page }) => {
    await callIsUp(page);
    await recordFor(page, 1600);
    const card = page.locator('[data-testid="call-recording"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    // The card is acted on once the call is over: until then the call's own page is over it.
    await hangUp(page);

    // The first press only arms: nothing is gone yet, and the way back is offered.
    await card.locator('[data-testid="call-recording-delete"]').click();
    await expect(card.locator('[data-testid="call-recording-delete-confirm"]')).toBeVisible();
    await card.locator('[data-testid="call-recording-delete-cancel"]').click();
    await expect(card).toBeVisible();

    // The second one is the whole deletion: there is nothing upstream to take it back from.
    await card.locator('[data-testid="call-recording-delete"]').click();
    await card.locator('[data-testid="call-recording-delete-confirm"]').click();
    await expect(page.locator('[data-testid="call-recording"]')).toHaveCount(0);
  });

  test("can be stopped from the folded window, which is the only control it adds there", async ({
    page,
  }) => {
    await callIsUp(page);
    await page.locator('[data-testid="call-record"]').click();
    await expect(page.locator('[data-testid="call-record"]')).toHaveAttribute(
      "data-recording",
      "true",
    );

    await page.locator('[data-testid="call-stage-minimize"]').click();
    await expect(page.locator('[data-testid="call-stage"]')).toHaveAttribute("data-mode", "mini");
    // Folded, the window keeps a stop: a recording the user cannot end without unfolding the
    // call is the mistake this app never makes with a microphone either. There is exactly ONE
    // of it — the two shapes crossfade, so the page's own control is gone by the time the
    // window's has arrived.
    const stop = page.locator('[data-testid="call-record"]');
    await expect(stop).toHaveCount(1);
    await stop.click();
    await expect(page.locator('[data-testid="call-recording-notice"]')).toContainText(
      /Recording kept/,
      { timeout: 15_000 },
    );
    // And with nothing to stop, the folded window offers no record control at all — it is
    // glanced at, and the rest of the page's controls are one click away.
    await expect(page.locator('[data-testid="call-record"]')).toHaveCount(0);
  });
});
