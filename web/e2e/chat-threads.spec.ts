import {
  test,
  expect,
  clearComposer,
  composerField,
  fetchCapturedSends,
  gotoApp,
  openConversationNamed,
  realErrors,
  sendFromThreadComposer,
  threadComposerField,
} from "./helpers";
import type { Page } from "@playwright/test";

// THREADS IN A CHAT: a message can be answered IN A THREAD instead of in the conversation, the
// root then carries a foot row saying what is behind it, and the panel beside the conversation
// is where the thread is read and answered — in a reply bar of its own (§ A CHAT HAS THREADS
// TOO).
//
// **THREADING IS AN OPTION.** Reply answers in the chat, exactly as it always did; "Reply in
// thread" is the row beside it. That is what these specs pin first, because it shipped the other
// way round and the wrong default takes a reader's message out of the history they put it in.
//
// The fixture is `Thread Demo` — a chat with one thread whose two replies are FOLDED
// (`thread_only`) and one that is a BROADCAST, so both halves of the fold are on screen and
// neither can pass by accident. It is named rather than indexed, for the reason
// `openConversationNamed` states: one mock process serves the whole run, and the sidebar's order
// is shared state.
const THREAD_CHAT = "Thread Demo";

/** The words of the root the fixture's thread hangs under. */
const ROOT_WORDS = "staging deploy is stuck";
/** A folded reply's own words: in the thread, and nowhere in the running history. */
const FOLDED_WORDS = "index rebuild";
/** A broadcast reply's words: in the thread AND in the running history. */
const BROADCAST_WORDS = "Deploy is green";
/** The NAME the fixture's thread was given, on the reply that started it. */
const THREAD_NAME = "Staging migration timeout";
/** A message of the fixture that is in NO thread, so starting one from it offers a name. */
const UNNAMED_WORDS = "lunch at one";

function history(page: Page) {
  return page.locator('[data-testid="message-scroll"]');
}
function panel(page: Page) {
  return page.locator('[data-testid="threads-panel"]');
}

/** Take the OPTION on the newest message of the open chat: start (or join) its thread. */
async function replyInThread(page: Page) {
  const bubble = page.locator('[data-testid="message-scroll"] [data-testid="message"]').last();
  await bubble.hover();
  await bubble.locator('[data-testid="message-actions"]').click();
  await page.locator('[data-testid="action-reply-in-thread"]').click();
  await expect(panel(page)).toBeVisible();
}

test.describe("threads in a chat", () => {
  test("folds a reply out of the running history and into its thread", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);

    // The ROOT is in the history, and so is the BROADCAST reply — the reply whose author
    // ticked "Also send to the chat" is in both places, which is what the tick is for.
    // `.first()` because that broadcast reply QUOTES the root, so the root's own words are on
    // screen twice by design: once as the message and once inside the quote above the answer.
    await expect(history(page).getByText(ROOT_WORDS).first()).toBeVisible();
    await expect(history(page).getByText(BROADCAST_WORDS)).toBeVisible();
    // The FOLDED replies are in neither the history nor anywhere else on screen yet: the
    // whole point of the fold.
    await expect(history(page).getByText(FOLDED_WORDS)).toHaveCount(0);

    // What says a thread is there: the foot row under the root, counting it.
    const foot = page.locator('[data-testid="post-replies"]');
    await expect(foot).toHaveCount(1);
    await expect(foot).toContainText("3 replies");

    // A press opens the panel, and every reply is in it — folded and broadcast alike, since
    // the flag decides the running history and never the thread.
    await foot.click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText(FOLDED_WORDS)).toBeVisible();
    await expect(panel(page).getByText(BROADCAST_WORDS)).toBeVisible();
    // The panel says WHICH thread it is showing — by its NAME, where somebody gave it one.
    await expect(page.locator('[data-testid="threads-panel-heading"]')).toHaveText(THREAD_NAME);

    // AND NO REPLY DRAWS A QUOTE OF THE ROOT inside the root's own panel. The quote is in
    // every one of their bodies — in a chat it is HOW a reply says which thread it is in — but
    // drawn here it would state one thing as many times as there are replies, two centimetres
    // under the post itself. It is the rule `threadReplyQuotes` already holds for a channel.
    await expect(panel(page).locator('[data-testid="message-quote"]')).toHaveCount(0);
    // The history behind it still draws the broadcast reply's own quote: there the root may be
    // a screen away, so the quote is the only thing that says which thread the answer is from.
    await expect(history(page).locator('[data-testid="message-quote"]').first()).toBeVisible();

    await page.locator('[data-testid="threads-panel-close"]').click();
    await expect(panel(page)).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("THREADING IS AN OPTION: Reply answers in the chat, a second row starts the thread", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);
    await clearComposer(page);

    const bubble = page.locator('[data-testid="message-scroll"] [data-testid="message"]').last();
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    // BOTH rows are there, and Reply comes first: it is the answer most people want, and it is
    // the row they have always pressed.
    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-reply-in-thread"]')).toBeVisible();

    // Reply aims the bar under the CONVERSATION and opens no thread at all.
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    // …and it carries no broadcast box: a reply written there is already in the running
    // history, so there is nothing for the box to ask.
    await expect(page.locator('[data-testid="reply-broadcast"]')).toHaveCount(0);
    await page.locator('[data-testid="reply-cancel"]').click();

    // The OPTION opens the thread instead, and leaves the conversation's own bar alone.
    await replyInThread(page);
    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });

  test("the thread has a reply bar of its OWN, and the conversation keeps its own", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);
    await page.locator('[data-testid="post-replies"]').click();

    // TWO BARS, which is the shape the reference has: one to answer the thread, one to post to
    // the chat. A single bar under the conversation while a thread stands open beside it reads
    // as belonging to neither column.
    await expect(page.locator('[data-testid="thread-composer-shell"]')).toHaveCount(1);
    // …and the LIVE SENTINEL still resolves to exactly one element, which is what a sanctioned
    // live driver proves its target with (§ Automation safety).
    await expect(page.locator('[data-testid="composer-shell"]')).toHaveCount(1);
    // It states which thread it posts into, for the reason the panel does.
    await expect(page.locator('[data-testid="thread-composer-shell"]')).toHaveAttribute(
      "data-thread-root",
      /.+/,
    );
    // The caret is in the THREAD's field already, in the same task as the click that asked.
    await expect(threadComposerField(page)).toBeFocused();

    // The two boxes hold their own words: typing in one leaves the other empty.
    await threadComposerField(page).fill("into the thread");
    await expect(composerField(page)).toHaveText("");
    await page.locator('[data-testid="threads-panel-close"]').click();
    await expect(page.locator('[data-testid="thread-composer-shell"]')).toHaveCount(0);
    // …and re-opening the thread finds the half-written reply where it was left.
    await page.locator('[data-testid="post-replies"]').click();
    await expect(threadComposerField(page)).toHaveText("into the thread");
    await threadComposerField(page).fill("");
  });

  test("a thread's reply is FOLDED, and 'Also send to the chat' is how it is not", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);
    await page.locator('[data-testid="post-replies"]').click();

    const box = page.locator('[data-testid="reply-broadcast"] input[type="checkbox"]');
    // UNTICKED, which is what having chosen a thread means: the answer belongs in it.
    await expect(box).not.toBeChecked();
    const before = (await fetchCapturedSends(page)).length;
    await sendFromThreadComposer(page, "folded answer");
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(before);
    const sends = await fetchCapturedSends(page);
    expect(sends.at(-1)!.reply_to).toBeTruthy();
    expect(sends.at(-1)!.thread_only).toBe(true);

    // …and TICKING it sends the same reply with no flag at all, which is a reply drawn where
    // every other client draws it. The LABEL is what is pressed, not the input: the row's 44px
    // target is a pseudo-element grown over it, so it is what a pointer really lands on.
    await page.locator('[data-testid="reply-broadcast"]').click();
    await expect(box).toBeChecked();
    await sendFromThreadComposer(page, "broadcast answer");
    await expect
      .poll(async () => (await fetchCapturedSends(page)).length)
      .toBeGreaterThan(sends.length);
    expect((await fetchCapturedSends(page)).at(-1)!.thread_only).toBeUndefined();
  });

  test("a threaded reply lands in the thread and not in the history behind it", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);
    await page.locator('[data-testid="post-replies"]').click();

    const marker = `mine-${Date.now()}`;
    await sendFromThreadComposer(page, marker);
    await expect(panel(page).getByText(marker)).toBeVisible({ timeout: 10_000 });
    await expect(history(page).getByText(marker)).toHaveCount(0);
  });

  test("THE TWO BARS SIT ON ONE BASELINE", async ({ page }) => {
    // Each column ends in its own reply bar, so the two must line up: the row used to hold the
    // history alone with the one composer BELOW it, which left the thread's bar floating a
    // composer's height above the chat's and reading as a box hanging in the middle of the
    // screen. It was reported that way, so it is measured rather than eyeballed.
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);
    await page.locator('[data-testid="post-replies"]').click();

    const chat = await page.locator('[data-testid="composer-shell"]').boundingBox();
    const inThread = await page.locator('[data-testid="thread-composer-shell"]').boundingBox();
    expect(chat).not.toBeNull();
    expect(inThread).not.toBeNull();
    // Their FEET, which is what a reader compares. A couple of pixels of rounding is fine; a
    // composer's height is not.
    expect(Math.abs(chat!.y + chat!.height - (inThread!.y + inThread!.height))).toBeLessThan(4);
  });

  test("a thread can be NAMED, by the reply that starts it", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);

    // A thread that HAS a name offers no field: a second name would rename nothing.
    await page.locator('[data-testid="post-replies"]').click();
    await expect(page.locator('[data-testid="thread-composer-subject"]')).toHaveCount(0);
    await page.locator('[data-testid="threads-panel-close"]').click();

    // A message in NO thread offers one, which is where Discord asks for it too.
    const fresh = page
      .locator('[data-testid="message-scroll"] [data-testid="message"]')
      .filter({ hasText: UNNAMED_WORDS })
      .first();
    await fresh.hover();
    await fresh.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply-in-thread"]').click();
    const name = page.locator('[data-testid="thread-composer-subject"]');
    await expect(name).toBeVisible();
    // The conversation's OWN bar offers none: a chat message has no title, and the backend
    // refuses one on anything but a reply (`parse_subject`).
    await expect(page.locator('[data-testid="composer-subject"]')).toHaveCount(0);

    const before = (await fetchCapturedSends(page)).length;
    await name.fill("Lunch plan");
    await sendFromThreadComposer(page, "one o'clock works");
    await expect.poll(async () => (await fetchCapturedSends(page)).length).toBeGreaterThan(before);
    // The name rides in the send as the message's own SUBJECT — Teams' own property, which the
    // read path already decodes on every message.
    const sent = (await fetchCapturedSends(page)).at(-1)!;
    expect(sent.subject).toBe("Lunch plan");
    expect(sent.reply_to).toBeTruthy();
    // …and the panel it named now says so, rather than the root's opening words.
    await expect(page.locator('[data-testid="threads-panel-heading"]')).toHaveText("Lunch plan", {
      timeout: 10_000,
    });
  });

  test("a CHANNEL is offered neither the option nor the box", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="tab-channels"]').click();
    await page.locator('[data-testid="channel-row"]').first().click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // A channel reply is filed by ADDRESS, so it is already out of the channel's own column and
    // there is no second act to offer: no "Reply in thread" row, and no broadcast box (which
    // would mean posting a SECOND message to the channel root).
    const bubble = page.locator('[data-testid="message"]').first();
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await expect(page.locator('[data-testid="action-reply"]')).toBeVisible();
    await expect(page.locator('[data-testid="action-reply-in-thread"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});

test.describe("the threads view", () => {
  test("is reached from the row under the search field and lists the reader's threads", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);

    await page.locator('[data-testid="open-threads"]').click();
    await expect(page.locator('[data-testid="threads-pane"]')).toBeVisible();
    // It is a ROUTE, so the URL says so — which is what makes it survive a reload and be
    // sendable to somebody.
    expect(new URL(page.url()).pathname).toBe("/threads");

    const rows = page.locator('[data-testid="threads-row"]');
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    // The fixture's own thread is one of them: the reader replied in it.
    const mine = rows.filter({ hasText: ROOT_WORDS });
    await expect(mine).toHaveCount(1);
    // A row says WHERE the thread is, what it is CALLED where somebody named it, and WHAT has
    // happened in it — the same three facts the foot row under the root carries.
    await expect(mine).toContainText(THREAD_CHAT);
    await expect(mine.locator('[data-testid="threads-row-name"]')).toHaveText(THREAD_NAME);
    await expect(mine).toContainText("replies");
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a press opens that thread in its own conversation", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-threads"]').click();
    const row = page.locator('[data-testid="threads-row"]').filter({ hasText: ROOT_WORDS });
    await expect(row).toHaveCount(1);
    const conversation = await row.getAttribute("data-conversation-id");

    await row.click();
    // The conversation, with the thread's own panel open beside it — the press said "open
    // this thread", which is a different ask from a deep link that merely shows a message.
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText(THREAD_CHAT);
    await expect(panel(page)).toBeVisible({ timeout: 10_000 });
    await expect(panel(page)).toHaveAttribute("data-thread-root", /.+/);
    expect(new URL(page.url()).pathname).toBe(`/c/${encodeURIComponent(conversation ?? "")}`);
  });

  test("survives a reload, because it is a route", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-testid="open-threads"]').click();
    await expect(page.locator('[data-testid="threads-pane"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-testid="threads-pane"]')).toBeVisible({ timeout: 15_000 });
  });
});
