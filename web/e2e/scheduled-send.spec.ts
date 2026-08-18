import {
  test,
  expect,
  fetchCapturedSends,
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
const NOTE = '[data-testid="composer-schedule-note"]';
const ERROR = '[data-testid="composer-schedule-error"]';
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

test.describe("scheduling a send", () => {
  test.afterEach(async ({ page }) => {
    await setSendControl(page, { clear: true });
  });

  test("a preset sends the words with the moment, and nothing appears in the thread", async ({
    page,
  }) => {
    const conversation = await openComposer(page);
    await fillComposer(page, "the standup note");
    await page.locator(TRIGGER).click();
    await expect(page.locator(MENU)).toBeVisible();

    const preset = page.locator(PRESET).first();
    const at = Number(await preset.getAttribute("data-schedule-at"));
    expect(at).toBeGreaterThan(Date.now());
    await preset.click();
    // The menu closes on the press: the outcome is reported at the composer.
    await expect(page.locator(MENU)).toBeHidden();

    // The moment travelled with the words, in the one send this made.
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(0);
    const sends = await fetchCapturedSends(page);
    const sent = sends[sends.length - 1]!;
    expect(sent.conversation).toBe(conversation);
    expect(sent.content_html ?? sent.text).toContain("the standup note");
    expect(sent.scheduled_time).toBe(at);

    // The composer says WHERE the words went, because they left the box and Teams is
    // holding the message: nothing is in the thread yet.
    await expect(page.locator(NOTE)).toContainText("Scheduled for");
    // And the words are nowhere in the thread: Teams is holding the message, so this is
    // the one send that adds no row. What is asserted is the TEXT rather than a count of
    // the rows, because the history is virtualized — the number of mounted rows moves on
    // its own as the reader scrolls, so a count would be flaky rather than wrong.
    await expect(page.locator(MESSAGE).filter({ hasText: "the standup note" })).toHaveCount(0);
  });

  test("a custom moment travels, and the composer is emptied like any send", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "custom moment");
    await page.locator(TRIGGER).click();
    await page.locator(CUSTOM).fill(localValue(90));
    const expected = new Date(localValue(90)).getTime();
    await page.locator(CONFIRM).click();

    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(0);
    const sends = await fetchCapturedSends(page);
    expect(sends[sends.length - 1]!.scheduled_time).toBe(expected);
    // The words leave the box on a scheduled send exactly as they do on an ordinary one,
    // so the next Enter cannot post them a second time.
    await expect(page.locator('[data-testid="composer-rich"] .tiptap-message')).toHaveText("");
  });

  test("a moment that has passed is refused here, never by a round trip", async ({ page }) => {
    await openComposer(page);
    const before = (await fetchCapturedSends(page)).length;
    await fillComposer(page, "too late");
    await page.locator(TRIGGER).click();
    // The native picker's `min` bounds a reader; a value typed straight in does not, and
    // the backend would refuse it — so the menu refuses it first.
    await page.locator(CUSTOM).fill(localValue(-120));
    await page.locator(CONFIRM).click();
    await expect(page.locator(ERROR)).toContainText("passed");
    // Nothing was sent, and the menu is still open with the words still in the box.
    await expect(page.locator(MENU)).toBeVisible();
    expect((await fetchCapturedSends(page)).length).toBe(before);
  });

  test("the picker cannot offer a moment past the backend's own ceiling", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "far future");
    await page.locator(TRIGGER).click();
    const max = await page.locator(CUSTOM).getAttribute("max");
    const days = (new Date(max!).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    // 120 days, the ceiling `teams_send::parse_scheduled_time` enforces.
    expect(days).toBeGreaterThan(119);
    expect(days).toBeLessThan(121);
  });

  test("an ordinary send after a scheduled one is not scheduled too", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "later please");
    await page.locator(TRIGGER).click();
    await page.locator(PRESET).first().click();
    await expect(page.locator(NOTE)).toBeVisible();

    await fillComposer(page, "and this one now");
    await page.locator('[data-testid="composer-send"]').click();
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(1);
    const sends = await fetchCapturedSends(page);
    const now = sends[sends.length - 1]!;
    expect(now.content_html ?? now.text).toContain("and this one now");
    expect(now.scheduled_time).toBeUndefined();
    // And the note goes: that message IS in the thread, so nothing is waiting.
    await expect(page.locator(NOTE)).toHaveCount(0);
  });

  test("there is nothing to schedule in an empty composer", async ({ page }) => {
    await openComposer(page);
    await expect(page.locator(TRIGGER)).toBeDisabled();
    await fillComposer(page, "something");
    await expect(page.locator(TRIGGER)).toBeEnabled();
  });

  test("the menu says the one thing this app cannot do about a held message", async ({ page }) => {
    await openComposer(page);
    await fillComposer(page, "hint check");
    await page.locator(TRIGGER).click();
    // Teams holds the message and teams-lite lists nothing that is held, so the control
    // says where to cancel it BEFORE it is pressed.
    await expect(page.locator(MENU)).toContainText("Teams");
    await expect(page.locator(MENU)).toContainText("cancel");
  });
});
