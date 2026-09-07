import {
  test,
  expect,
  clearComposer,
  composerField,
  fetchCapturedSends,
  fillComposer,
  gotoApp,
  openConversationNamed,
  realErrors,
} from "./helpers";
import type { Page } from "@playwright/test";

// THREADS IN A CHAT: a reply is folded out of the running history and into the thread it
// answers, the root carries a foot row saying what is behind it, and the panel beside the
// conversation is where it is read (§ A CHAT HAS THREADS TOO).
//
// The fixture is `Thread Demo` — a chat with one thread whose two replies are FOLDED
// (`thread_only`) and one that is a BROADCAST, so both halves of the rule are on screen and
// neither can pass by accident. It is named rather than indexed, for the reason
// `openConversationNamed` states: one mock process serves the whole run, and the sidebar's
// order is shared state.
const THREAD_CHAT = "Thread Demo";

/** The words of the root the fixture's thread hangs under. */
const ROOT_WORDS = "staging deploy is stuck";
/** A folded reply's own words: in the thread, and nowhere in the running history. */
const FOLDED_WORDS = "index rebuild";
/** A broadcast reply's words: in the thread AND in the running history. */
const BROADCAST_WORDS = "Deploy is green";

function history(page: Page) {
  return page.locator('[data-testid="message-scroll"]');
}
function panel(page: Page) {
  return page.locator('[data-testid="threads-panel"]');
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
    // The panel says WHICH thread it is showing, by the root's own words: a chat message has
    // no title, so the heading falls back to them.
    await expect(page.locator('[data-testid="threads-panel-heading"]')).toContainText("staging");

    // AND NO REPLY DRAWS A QUOTE OF THE ROOT inside the root's own panel. The quote is in
    // every one of their bodies — in a chat it is HOW a reply says which thread it is in — but
    // drawn here it would state one thing as many times as there are replies, two centimetres
    // under the post itself. It is the rule `threadReplyQuotes` already holds for a channel.
    await expect(panel(page).locator('[data-testid="message-quote"]')).toHaveCount(0);
    // The history behind it still draws the broadcast reply's own quote: there the root may be
    // a screen away, so the quote is the only thing that says which thread the answer is from.
    await expect(
      history(page).locator('[data-testid="message-quote"]').first(),
    ).toBeVisible();

    await page.locator('[data-testid="threads-panel-close"]').click();
    await expect(panel(page)).toHaveCount(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("opening the panel aims the composer at that thread, and closing takes the aim back", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);

    await page.locator('[data-testid="post-replies"]').click();
    // There is ONE composer in this app, so the panel does not bring a second: opening it
    // aims the app's own, and the banner is the one authority on where the next Enter lands.
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    await expect(page.locator('[data-testid="composer-shell"]')).toHaveCount(1);
    // The caret is in the field already, in the same task as the click that asked.
    await expect(composerField(page)).toBeFocused();

    await page.locator('[data-testid="threads-panel-close"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });

  test("a chat reply offers 'Also send to the chat', unticked, and the send says which", async ({
    page,
  }) => {
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);
    await clearComposer(page);

    await page.locator('[data-testid="post-replies"]').click();
    const box = page.locator('[data-testid="reply-broadcast"] input[type="checkbox"]');
    // UNTICKED by default, which is Slack's own default and the whole point of the feature:
    // the noise a thread keeps out of the running history is what it is for.
    await expect(box).not.toBeChecked();

    await fillComposer(page, "folded answer");
    await composerField(page).press("Enter");
    await expect
      .poll(async () => (await fetchCapturedSends(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const sends = await fetchCapturedSends(page);
    const last = sends.at(-1)!;
    expect(last.reply_to).toBeTruthy();
    expect(last.thread_only).toBe(true);

    // …and TICKING it sends the same reply with no flag at all, which is a reply drawn where
    // every other client draws it.
    await page.locator('[data-testid="post-replies"]').first().click();
    await expect(box).not.toBeChecked();
    // The LABEL is what is pressed, not the input: the row's 44px target is a pseudo-element
    // grown over it (the technique the thread foot row already uses), so it is what a pointer
    // really lands on — which is also true of a reader's thumb.
    await page.locator('[data-testid="reply-broadcast"]').click();
    await expect(box).toBeChecked();
    await fillComposer(page, "broadcast answer");
    await composerField(page).press("Enter");
    await expect
      .poll(async () => (await fetchCapturedSends(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(sends.length);
    const after = await fetchCapturedSends(page);
    expect(after.at(-1)!.thread_only).toBeUndefined();
    await clearComposer(page);
  });

  test("a CHANNEL is offered no broadcast box — a reply there is filed by address", async ({
    page,
  }) => {
    await gotoApp(page);
    await page.locator('[data-testid="tab-channels"]').click();
    const channel = page.locator('[data-testid="channel-row"]').first();
    await channel.click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // The posts layout's own reply row aims the composer at a thread; the box must not be
    // there, because broadcasting a channel reply would mean posting a SECOND message.
    const reply = page.locator('[data-testid="thread-reply"]').first();
    if ((await reply.count()) > 0) {
      await reply.click();
      await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
      await expect(page.locator('[data-testid="reply-broadcast"]')).toHaveCount(0);
    }
  });

  test("a threaded reply of the reader's own is not shown twice", async ({ page }) => {
    // The optimistic half and the echo are two things that could each draw the reply, and the
    // fold has to survive both: a reply the reader just sent must appear in the panel and
    // nowhere in the history behind it.
    await gotoApp(page);
    await openConversationNamed(page, THREAD_CHAT);
    await clearComposer(page);
    await page.locator('[data-testid="post-replies"]').click();
    await fillComposer(page, "a reply of my own");
    await composerField(page).press("Enter");

    await expect(panel(page).getByText("a reply of my own")).toBeVisible({ timeout: 10_000 });
    await expect(history(page).getByText("a reply of my own")).toHaveCount(0);
    await clearComposer(page);
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
    // A row says WHERE the thread is and WHAT has happened in it — the same three facts the
    // foot row under the root carries.
    await expect(mine).toContainText(THREAD_CHAT);
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
