import { test, expect, gotoApp, openConversationAt } from "./helpers";

/** Vertical offset of a message (by its stable data-message-id) relative to the
 *  top of the scroll viewport. Mirrors findMessageNode's dataset scan so we
 *  don't have to CSS-escape ids that contain `:`, `@`, and `#`. Returns NaN when
 *  the message isn't in the DOM. */
async function relativeTop(scrollerSelector: string, page: import("@playwright/test").Page, id: string) {
  return page.locator(scrollerSelector).evaluate((el, messageId) => {
    const nodes = el.querySelectorAll<HTMLElement>("[data-message-id]");
    let node: HTMLElement | null = null;
    for (const n of nodes) {
      if (n.dataset.messageId === messageId) {
        node = n;
        break;
      }
    }
    if (!node) return Number.NaN;
    return node.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, id);
}

test.describe("history (infinite scroll)", () => {
  test("loads older messages when scrolling up, and reaches the start", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const messages = page.locator('[data-testid="message"]');
    const initial = await messages.count();
    // The mock returns the newest 40 and reports has_more.
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThanOrEqual(40);

    const scroller = page.locator('[data-testid="message-scroll"]');

    // Scroll to the top repeatedly to pull older pages until the backlog (120)
    // is exhausted or we plateau — proving both backfill and the end-of-history.
    let last = initial;
    for (let i = 0; i < 6; i++) {
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await expect
        .poll(() => messages.count(), { timeout: 8_000 })
        .toBeGreaterThanOrEqual(last);
      const now = await messages.count();
      if (now === last && now >= 120) break;
      last = now;
    }

    // We should have loaded well beyond the first page.
    expect(last).toBeGreaterThan(initial);
  });

  test("keeps the reading position anchored when older messages load (no jump to top)", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const scrollerSel = '[data-testid="message-scroll"]';
    const scroller = page.locator(scrollerSel);
    const messages = page.locator('[data-testid="message"]');

    // The message at the top of the first page — the one the user is looking at
    // when they reach the top.
    const oldestId = await messages.first().getAttribute("data-message-id");
    expect(oldestId).toBeTruthy();
    const before = await messages.count();

    // Jump to the very top: the exact case where the browser suppresses its own
    // scroll anchoring, so only our JS re-anchoring can hold the position.
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect.poll(() => messages.count(), { timeout: 8_000 }).toBeGreaterThan(before);

    // After the backfill, that same message must stay pinned near the top of the
    // viewport — not shoved a full page down by the freshly prepended block
    // (which is what "teleporting to the top of the new messages" looked like).
    const relTop = await relativeTop(scrollerSel, page, oldestId!);
    expect(Number.isNaN(relTop)).toBeFalsy();
    expect(relTop).toBeGreaterThan(-50);
    expect(relTop).toBeLessThan(300);

    // And we are neither pinned to the very bottom nor sitting at the raw top.
    const pos = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      toBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }));
    expect(pos.toBottom).toBeGreaterThan(4);
  });

  test("prefetches older history a couple of screens before the top", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const scroller = page.locator('[data-testid="message-scroll"]');
    const messages = page.locator('[data-testid="message"]');

    // Build a tall enough backlog that we can sit a couple of screens below the
    // top without actually being at the top. Stop as soon as it's tall enough so
    // we don't exhaust the 120-message backlog (which would leave nothing to
    // prefetch).
    await expect
      .poll(async () => {
        const tall = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight * 3.5);
        if (!tall) await scroller.evaluate((el) => (el.scrollTop = 0));
        return tall;
      }, { timeout: 8_000 })
      .toBeTruthy();

    // Wait for any in-flight backfill/anchoring to settle before measuring.
    await expect
      .poll(async () => {
        const a = await messages.count();
        await page.waitForTimeout(150);
        const b = await messages.count();
        return a === b ? a : -1;
      }, { timeout: 8_000 })
      .toBeGreaterThan(0);

    // Park ~1.5 screens from the top: comfortably past the old 160px trigger, but
    // inside the new multi-screen look-ahead.
    const before = await messages.count();
    await scroller.evaluate((el) => (el.scrollTop = Math.round(el.clientHeight * 1.5)));

    // A background prefetch should grow the backlog without the user ever having
    // to reach the very top.
    await expect.poll(() => messages.count(), { timeout: 8_000 }).toBeGreaterThan(before);
    const reachedTop = await scroller.evaluate((el) => el.scrollTop <= 1);
    expect(reachedTop).toBeFalsy();
  });
});
