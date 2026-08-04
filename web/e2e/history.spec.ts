import { test, expect, emitLive, gotoApp, openConversationAt } from "./helpers";

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

/**
 * Sample the history once per animation frame while wheeling it upward, and
 * report how far the content moved on frames the wheel did *not* drive.
 *
 * Following one message's on-screen position is the only honest measure of
 * smoothness: `scrollTop` legitimately jumps when a page is prepended (the
 * viewport is moved down by the height that appeared above it), and what the eye
 * notices is the message under it moving when nothing asked it to.
 */
async function wheelUpAndMeasure(
  page: import("@playwright/test").Page,
  opts: { notches: number; intervalMs: number; cpuThrottle?: number },
) {
  // The defect this measures is a race between two paints: the virtualizer
  // corrects `scrollTop` inside a row measurement, and the row positions that
  // correction accounts for arrive with the next render. On an idle machine with
  // a 40-message fixture that render usually still makes the same frame, so the
  // race has to be forced — which is exactly what a real conversation does to it
  // (taller rows, avatars, receipts, a busier main thread).
  const cdp = opts.cpuThrottle ? await page.context().newCDPSession(page) : null;
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: opts.cpuThrottle! });

  await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    const probe = { frames: [], notches: [] };
    window.__scrollProbe = probe;
    const anchorAt = () => {
      const box = el.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      let best = null;
      let bestDistance = Infinity;
      for (const node of el.querySelectorAll("[data-message-id]")) {
        const distance = Math.abs(node.getBoundingClientRect().top - middle);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { id: node.dataset.messageId, y: node.getBoundingClientRect().top };
        }
      }
      return best;
    };
    const tick = () => {
      const anchor = anchorAt();
      probe.frames.push({
        t: performance.now(),
        anchor: anchor ? anchor.id : null,
        y: anchor ? anchor.y : 0,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);

  await page.mouse.move(700, 450);
  for (let i = 0; i < opts.notches; i++) {
    await page.evaluate(`window.__scrollProbe.notches.push(performance.now())`);
    await page.mouse.wheel(0, -90);
    await page.waitForTimeout(opts.intervalMs);
  }
  await page.waitForTimeout(400);
  await cdp?.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp?.detach();

  // A notch keeps the content moving for a while (Chromium animates wheel
  // scrolling), so only frames well clear of one count as idle.
  return page.evaluate(`(() => {
    const { frames, notches } = window.__scrollProbe;
    const driven = (t) => notches.some((n) => t >= n - 20 && t <= n + 120);
    let worst = 0;
    let total = 0;
    let idle = 0;
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1];
      const frame = frames[i];
      if (frame.anchor === null || frame.anchor !== prev.anchor || driven(frame.t)) continue;
      idle++;
      const moved = Math.abs(frame.y - prev.y);
      total += moved;
      worst = Math.max(worst, moved);
    }
    return { idleFrames: idle, worst: Math.round(worst), total: Math.round(total) };
  })()`) as Promise<{ idleFrames: number; worst: number; total: number }>;
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

  test("scrolls up without the content twitching as older pages are measured", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await settled(page);

    // Wheel up through the backlog: pages are prefetched and their rows are
    // measured for the first time as they enter the window, which is when the
    // virtualizer corrects `scrollTop`. That correction used to paint a frame
    // before the row positions it compensates, jerking the history by the
    // estimate error (up to ~40px) over and over on the way up.
    // One notch every 150ms: fast enough to keep pulling pages, slow enough that
    // most frames are idle and can be held to "nothing moved".
    const motion = await wheelUpAndMeasure(page, {
      notches: 30,
      intervalMs: 150,
      cpuThrottle: 8,
    });

    // Enough idle frames for the measurement to mean something.
    expect(motion.idleFrames).toBeGreaterThan(20);
    // Nothing may move while the wheel is idle. A pixel or two of tolerance
    // covers sub-pixel layout rounding; the regression is an order of magnitude
    // above that.
    expect(motion.worst).toBeLessThanOrEqual(4);
    expect(motion.total).toBeLessThanOrEqual(12);
  });

  test("offers a jump back to the newest message while scrolled up", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await settled(page);

    const scroller = page.locator('[data-testid="message-scroll"]');
    const jump = page.locator('[data-testid="jump-to-latest"]');

    // Opening a conversation lands on its newest message, so the button is mounted
    // (it fades rather than unmounts) but hidden and inert.
    await expect(jump).toHaveAttribute("data-visible", "false");

    // Read upward, a couple of screens: now the newest message is off-screen and
    // the button is the way back to it.
    await scroller.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight * 2);
    });
    await expect(jump).toHaveAttribute("data-visible", "true");

    await jump.click();

    // Back at the bottom — and the button takes itself away again.
    await expect(jump).toHaveAttribute("data-visible", "false");
    await expect
      .poll(
        () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
        { timeout: 4_000 },
      )
      .toBeLessThanOrEqual(120);
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

  test("follows an incoming message when the reader is already at the bottom", async ({ page }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);
    await settled(page);

    const scroller = page.locator('[data-testid="message-scroll"]');
    // A row measured after the pane landed on the newest message leaves a few px
    // of slack, and a reader who wheels down stops wherever the wheel stops. Both
    // read as "at the bottom", so the test parks in that band rather than exactly
    // on the last pixel — which is the case the follow used to miss.
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 40));
    const marker = `follow-bottom-${await loadedCount(page)}`;
    await emitLive(page, { conversation: openId, content: marker, is_self: false });

    const bubble = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(bubble).toBeVisible();

    // The new message is what the reader is looking at: it sits inside the
    // viewport rather than below its lower edge.
    await expect
      .poll(
        () =>
          bubble.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const view = document
              .querySelector('[data-testid="message-scroll"]')!
              .getBoundingClientRect();
            return box.bottom - view.bottom;
          }),
        { timeout: 4_000 },
      )
      .toBeLessThanOrEqual(0);
    // Following is not a jump-to-latest either: the button never appears.
    await expect(page.locator('[data-testid="jump-to-latest"]')).toHaveAttribute(
      "data-visible",
      "false",
    );
  });

  test("leaves the reading position alone when a message arrives while scrolled up", async ({
    page,
  }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);
    await settled(page);

    const scroller = page.locator('[data-testid="message-scroll"]');
    // Read a screen up: the reader is deliberately away from the bottom, so a live
    // message must not pull them off what they are reading.
    await scroller.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight);
    });
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(200);

    const marker = `stay-put-${await loadedCount(page)}`;
    await emitLive(page, { conversation: openId, content: marker, is_self: false });
    // Give the append a few frames to do the wrong thing, if it were going to.
    await page.waitForTimeout(600);

    // The viewport did not move, and the way back to the newest message is the
    // button — which the arrival is what puts there.
    const after = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(4);
    await expect(page.locator('[data-testid="jump-to-latest"]')).toHaveAttribute(
      "data-visible",
      "true",
    );
  });
});
