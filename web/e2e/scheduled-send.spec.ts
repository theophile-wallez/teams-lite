import {
  test,
  expect,
  composerField,
  fetchCapturedSends,
  clearScheduledMessages,
  fillComposer,
  gotoApp,
  openConversationAt,
  setSendControl,
} from "./helpers";

const TRIGGER = '[data-testid="composer-schedule"]';
const MENU = '[data-testid="composer-schedule-menu"]';
const PRESET = '[data-testid="composer-schedule-preset"]';
const CUSTOM = '[data-testid="composer-schedule-custom"]';
const CONFIRM = '[data-testid="composer-schedule-confirm"]';
const CUSTOM_OPEN = '[data-testid="composer-schedule-custom-open"]';
const CUSTOM_DIALOG = '[data-testid="composer-schedule-custom-dialog"]';
const BANNER = '[data-testid="composer-schedule-note"]';
const OPEN_LIST = '[data-testid="composer-schedule-open-list"]';
const ERROR = '[data-testid="composer-schedule-error"]';
const DIALOG = '[data-testid="scheduled-messages-dialog"]';
const ROW = '[data-testid="scheduled-message-row"]';
const MESSAGE = '[data-testid="message"]';

async function openComposer(page: import("@playwright/test").Page): Promise<string> {
  await gotoApp(page);
  const id = await openConversationAt(page, 0);
  await setSendControl(page, { clear: true });
  return id;
}

/** The value a native datetime-local input wants, `minutes` from now in LOCAL time —
 *  which is what the picker means, so a UTC spelling would aim at another hour. */
function localValue(minutes: number): string {
  const when = new Date(Date.now() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** Queue the words for the first preset the menu offers, and hand back the moment. */
async function scheduleFirstPreset(
  page: import("@playwright/test").Page,
  words: string,
): Promise<number> {
  await fillComposer(page, words);
  await page.locator(TRIGGER).click();
  const preset = page.locator(PRESET).first();
  const at = Number(await preset.getAttribute("data-schedule-at"));
  await preset.click();
  await expect(page.locator(MENU)).toBeHidden();
  await expect(page.locator(BANNER)).toBeVisible();
  return at;
}

test.describe("scheduling a send", () => {
  test.beforeEach(async ({ page }) => {
    // Each test owns the queue it makes. Without this the banner and the list carry every
    // earlier test's messages, and an assertion about "nothing is queued now" counts
    // somebody else's — one mock process serves the whole run.
    await clearScheduledMessages(page);
  });

  test.afterEach(async ({ page }) => {
    await setSendControl(page, { clear: true });
    await clearScheduledMessages(page);
  });

  test("a preset queues the words, and the thread gets NOTHING", async ({ page }) => {
    const conversation = await openComposer(page);
    const at = await scheduleFirstPreset(page, "the standup note");
    expect(at).toBeGreaterThan(Date.now());

    // The moment travelled with the words, in the one send this made.
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(0);
    const sends = await fetchCapturedSends(page);
    const sent = sends[sends.length - 1]!;
    expect(sent.conversation).toBe(conversation);
    expect(sent.scheduled_time).toBe(at);

    // The banner says WHERE the words went and offers the list, because a queued message is
    // in no thread at all — this line is the only thing on screen accounting for them.
    await expect(page.locator(BANNER)).toContainText("will be sent");
    await expect(page.locator(OPEN_LIST)).toBeVisible();
    // And the thread never draws it, on the live frame or after a reload.
    await expect(page.locator(MESSAGE).filter({ hasText: "the standup note" })).toHaveCount(0);
    await page.reload();
    await openConversationAt(page, 0);
    await expect(page.locator(MESSAGE).filter({ hasText: "the standup note" })).toHaveCount(0);
  });

  test("the banner is still there after a reload, and is not two banners", async ({ page }) => {
    await openComposer(page);
    await scheduleFirstPreset(page, "waiting across a reload");
    await page.reload();
    await openConversationAt(page, 0);
    // Read from the queue at startup, so a thread with something waiting says so before
    // anything is queued in THIS page.
    await expect(page.locator(BANNER)).toHaveCount(1);
    await expect(page.locator(BANNER)).toContainText("will be sent");
  });

  test("the list names the thread, the words and when it goes", async ({ page }) => {
    await openComposer(page);
    await scheduleFirstPreset(page, "queued for the list");
    await page.locator(OPEN_LIST).click();

    await expect(page.locator(DIALOG)).toBeVisible();
    const row = page.locator(ROW).filter({ hasText: "queued for the list" });
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-testid="scheduled-message-when"]')).toContainText("Send ");
    await expect(row.locator('[data-testid="scheduled-message-preview"]')).toContainText(
      "queued for the list",
    );
  });

  test("SEND NOW delivers it and takes it out of the list", async ({ page }) => {
    await openComposer(page);
    await scheduleFirstPreset(page, "actually send this now");
    await page.locator(OPEN_LIST).click();
    const row = page.locator(ROW).filter({ hasText: "actually send this now" });
    await row.locator('[data-testid="scheduled-send-now"]').click();

    // Gone from the list, and now really in the thread.
    await expect(row).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      page.locator(MESSAGE).filter({ hasText: "actually send this now" }),
    ).toHaveCount(1);
  });

  test("EDIT cancels it and hands the words back to the composer", async ({ page }) => {
    await openComposer(page);
    await scheduleFirstPreset(page, "let me rewrite this");
    await page.locator(OPEN_LIST).click();
    const row = page.locator(ROW).filter({ hasText: "let me rewrite this" });
    await row.locator('[data-testid="scheduled-edit"]').click();

    // The dialog closes onto the conversation, with the words in the box.
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(composerField(page)).toHaveText("let me rewrite this");
    // Nothing is queued any more, and the banner — which is DERIVED from the queue rather
    // than from the send that made one — says so by not being there.
    await expect(page.locator(BANNER)).toHaveCount(0);
    // It is the only shape the service allows: an edit RELEASES a held message and a
    // reschedule is refused outright, so the words come back rather than being edited in
    // place — see examples/scheduled_send_probe.rs.
    await expect(page.locator(MESSAGE).filter({ hasText: "let me rewrite this" })).toHaveCount(0);
  });

  test("DELETE asks twice, and never delivers the message", async ({ page }) => {
    await openComposer(page);
    await scheduleFirstPreset(page, "this one is dropped");
    await page.locator(OPEN_LIST).click();
    const row = page.locator(ROW).filter({ hasText: "this one is dropped" });

    // The first press only ARMS it — the pattern a message's own Delete uses.
    await row.locator('[data-testid="scheduled-delete"]').click();
    await expect(row).toHaveCount(1);
    await row.locator('[data-testid="scheduled-delete-confirm"]').click();
    await expect(row).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(MESSAGE).filter({ hasText: "this one is dropped" })).toHaveCount(0);
  });

  test("the send control is ONE pill: Send, and the chevron beside it", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "geometry");
    const send = await page.locator('[data-testid="composer-send"]').boundingBox();
    const later = await page.locator(TRIGGER).boundingBox();
    expect(send).not.toBeNull();
    expect(later).not.toBeNull();
    // Touching, same height, and the chevron on the RIGHT — one control split in two rather
    // than two buttons the reader has to tell apart.
    expect(later!.x).toBeGreaterThan(send!.x);
    expect(Math.abs(later!.x - (send!.x + send!.width))).toBeLessThan(2);
    expect(Math.abs(later!.height - send!.height)).toBeLessThan(2);
    // And the halves are the SAME width, which is what keeps the two glyphs far enough apart
    // to aim at: the chevron was 24px against Send's 32px, so its glyph sat 12px from the
    // hairline and a press meant for Send landed on the menu.
    expect(Math.abs(later!.width - send!.width)).toBeLessThan(2);
  });

  test("CUSTOM TIME opens a dialog, and USING the picker does not dismiss it", async ({
    page,
  }) => {
    await openComposer(page);
    await fillComposer(page, "custom moment");
    await page.locator(TRIGGER).click();
    // The row opens the dialog and closes the menu — the menu itself never holds the field.
    await page.locator(CUSTOM_OPEN).click();
    await expect(page.locator(CUSTOM_DIALOG)).toBeVisible();
    await expect(page.locator(MENU)).toBeHidden();

    // The bug this shape exists for: the browser's own calendar is not in the document, so
    // a press on the picker used to read as a press OUTSIDE the popover and dismiss it,
    // taking the half-filled field away. Pressing into the field, and on its calendar
    // affordance at the right-hand edge, must both leave the dialog standing.
    await page.locator(CUSTOM).click();
    await expect(page.locator(CUSTOM_DIALOG)).toBeVisible();
    const box = (await page.locator(CUSTOM).boundingBox())!;
    await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
    await expect(page.locator(CUSTOM_DIALOG)).toBeVisible();
    await expect(page.locator(CUSTOM)).toBeVisible();

    // Cancel is the way out that always works. Escape belongs to the FIELD first — a native
    // date input consumes it to dismiss its own calendar — so a dialog whose only exit was
    // Escape would read as stuck while the picker had focus.
    await page.locator('[data-testid="composer-schedule-custom-cancel"]').click();
    await expect(page.locator(CUSTOM_DIALOG)).toBeHidden();
    expect((await fetchCapturedSends(page)).length).toBe(0);
  });

  test("a custom moment travels, and the composer is emptied like any send", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "custom moment");
    await page.locator(TRIGGER).click();
    await page.locator(CUSTOM_OPEN).click();
    await page.locator(CUSTOM).fill(localValue(90));
    const expected = new Date(localValue(90)).getTime();
    await page.locator(CONFIRM).click();
    await expect(page.locator(CUSTOM_DIALOG)).toBeHidden();

    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(0);
    const sends = await fetchCapturedSends(page);
    expect(sends[sends.length - 1]!.scheduled_time).toBe(expected);
    await expect(composerField(page)).toHaveText("");
  });

  test("a moment that has passed is refused here, never by a round trip", async ({ page }) => {
    await openComposer(page);
    const before = (await fetchCapturedSends(page)).length;
    await fillComposer(page, "too late");
    await page.locator(TRIGGER).click();
    await page.locator(CUSTOM_OPEN).click();
    await page.locator(CUSTOM).fill(localValue(-120));
    await page.locator(CONFIRM).click();
    await expect(page.locator(ERROR)).toContainText("passed");
    // The refusal is stated where the moment was typed, and the dialog keeps it: nothing was
    // sent, so the reader can correct the value rather than start again.
    await expect(page.locator(CUSTOM_DIALOG)).toBeVisible();
    expect((await fetchCapturedSends(page)).length).toBe(before);
  });

  test("the picker cannot offer a moment past the backend's own ceiling", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "far future");
    await page.locator(TRIGGER).click();
    await page.locator(CUSTOM_OPEN).click();
    const max = await page.locator(CUSTOM).getAttribute("max");
    const days = (new Date(max!).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(119);
    expect(days).toBeLessThan(121);
  });

  test("an ordinary send after a scheduled one is not scheduled too", async ({ page }) => {
    await openComposer(page);
    await scheduleFirstPreset(page, "later please");

    await fillComposer(page, "and this one now");
    await page.locator('[data-testid="composer-send"]').click();
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(1);
    const sends = await fetchCapturedSends(page);
    const now = sends[sends.length - 1]!;
    expect(now.content_html ?? now.text).toContain("and this one now");
    expect(now.scheduled_time).toBeUndefined();
    await expect(page.locator(MESSAGE).filter({ hasText: "and this one now" })).toHaveCount(1);
    // The banner STAYS, because "later please" is still queued — it reports the queue and
    // not the last send, so an ordinary send in between cannot make it lie either way.
    await expect(page.locator(BANNER)).toBeVisible();
  });

  test("the menu says what a queued message costs before it is pressed", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "hint check");
    await page.locator(TRIGGER).click();
    await expect(page.locator(MENU)).toContainText("Schedule message");
    await expect(page.locator(MENU)).toContainText("Custom time");
    // Nobody sees it until then, and it can be cancelled — the two facts a reader decides
    // with, on the control rather than after the press.
    await expect(page.locator(MENU)).toContainText("Nobody sees it");
    await expect(page.locator(MENU)).toContainText("Cancel");
  });

  test("there is nothing to schedule in an empty composer", async ({ page }) => {
    await openComposer(page);
    await expect(page.locator(TRIGGER)).toBeDisabled();
    await fillComposer(page, "something");
    await expect(page.locator(TRIGGER)).toBeEnabled();
  });

});
