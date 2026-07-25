import { test, expect, gotoApp, openConversationAt } from "./helpers";

/** How much history the pane has loaded. The message list is virtualized, so the
 *  number of rendered bubbles tracks the viewport, not the backlog — the pane
 *  publishes the loaded count on the scroller instead. */
async function loadedCount(page: import("@playwright/test").Page) {
  return page
    .locator('[data-testid="message-scroll"]')
    .evaluate((el) => Number((el as HTMLElement).dataset.loadedCount ?? 0));
}

/** Scroll geometry of the history viewport. */
async function geometry(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="message-scroll"]').evaluate((el) => ({
    loaded: Number((el as HTMLElement).dataset.loadedCount ?? 0),
    top: el.scrollTop,
    height: el.scrollHeight,
    client: el.clientHeight,
  }));
}

/** Wait until the loaded history stops growing, so a measurement isn't taken in
 *  the middle of an in-flight backfill. */
async function settled(page: import("@playwright/test").Page) {
  await expect
    .poll(
      async () => {
        const a = await loadedCount(page);
        await page.waitForTimeout(200);
        return (await loadedCount(page)) === a ? a : -1;
      },
      { timeout: 8_000 },
    )
    .toBeGreaterThan(0);
}

test.describe("history (infinite scroll)", () => {
  test("loads older messages when scrolling up, and reaches the start", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const initial = await loadedCount(page);
    // The mock returns the newest 40 and reports has_more.
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThanOrEqual(40);

    const scroller = page.locator('[data-testid="message-scroll"]');

    // Scroll to the top repeatedly to pull older pages until the backlog (120)
    // is exhausted or we plateau — proving both backfill and the end-of-history.
    let last = initial;
    for (let i = 0; i < 8; i++) {
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await expect.poll(() => loadedCount(page), { timeout: 8_000 }).toBeGreaterThanOrEqual(last);
      const now = await loadedCount(page);
      if (now === last && now >= 120) break;
      last = now;
    }

    // We should have loaded well beyond the first page.
    expect(last).toBeGreaterThan(initial);

    // And virtualization must hold: the whole backlog is loaded, but only the rows
    // around the viewport are mounted.
    const rendered = await page.locator('[data-testid="message"]').count();
    expect(rendered).toBeLessThan(last);
    expect(rendered).toBeLessThan(60);
  });

  test("keeps the reading position anchored when older messages load (no jump to top)", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await settled(page);

    const before = await geometry(page);

    // Jump to the very top: the exact case where the browser suppresses its own
    // scroll anchoring, so only the virtualizer's re-anchoring holds the position.
    const scroller = page.locator('[data-testid="message-scroll"]');
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await expect.poll(() => loadedCount(page), { timeout: 8_000 }).toBeGreaterThan(before.loaded);
    await settled(page);

    const after = await geometry(page);
    const added = after.height - before.height;
    expect(added).toBeGreaterThan(0);

    // The freshly prepended block sits *above* the reader: anchoring means the
    // viewport moved down by (about) the height that was added, so the same
    // messages stay under their eyes. Snapping to the top of the newly loaded page
    // — the regression this guards — would leave scrollTop near 0 instead.
    expect(after.top).toBeGreaterThan(added * 0.5);
    expect(after.top).toBeLessThan(added + 400);

    // And we are neither pinned to the very bottom nor sitting at the raw top.
    expect(after.top).toBeGreaterThan(4);
    expect(after.height - after.top - after.client).toBeGreaterThan(4);
  });

  test("prefetches older history a couple of screens before the top", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const scroller = page.locator('[data-testid="message-scroll"]');

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
    await settled(page);

    // Park ~1.5 screens from the top: comfortably past the old 160px trigger, but
    // inside the new multi-screen look-ahead.
    const before = await loadedCount(page);
    await scroller.evaluate((el) => (el.scrollTop = Math.round(el.clientHeight * 1.5)));

    // A background prefetch should grow the backlog without the user ever having
    // to reach the very top.
    await expect.poll(() => loadedCount(page), { timeout: 8_000 }).toBeGreaterThan(before);
    const reachedTop = await scroller.evaluate((el) => el.scrollTop <= 1);
    expect(reachedTop).toBeFalsy();
  });
});
