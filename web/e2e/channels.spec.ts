import {
  test,
  expect,
  gotoApp,
  openChannelsTab,
  fetchTestChannels,
  realErrors,
} from "./helpers";

// Channels are a Microsoft Teams-style, first-class surface: a separate sidebar
// tab holding a team → channel tree, cleanly split from the Chats list. These
// specs prove the separation end to end — the tab switch, the grouped tree, that
// opening a channel reuses the shared message pipeline, and (the crux of the
// feature) that a channel thread never leaks into the normal conversation list.
test.describe("channels", () => {
  test("has a Channels tab that reveals the team → channel tree", async ({ page }) => {
    await gotoApp(page);

    await expect(page.locator('[data-testid="tab-chats"]')).toBeVisible();
    await expect(page.locator('[data-testid="tab-channels"]')).toBeVisible();

    // Chats is the default tab: the chat list is showing, no channel rows exist
    // (the inactive panel is unmounted, not merely hidden).
    await expect(page.locator('[data-testid="sidebar-scroll"]')).toBeVisible();
    await expect(page.locator('[data-testid="channel-row"]')).toHaveCount(0);

    await openChannelsTab(page);

    // The channel tree replaces the chat list, grouped into several teams.
    await expect(page.locator('[data-testid="sidebar-scroll"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="team-group"]').first()).toBeVisible();
    expect(await page.locator('[data-testid="team-group"]').count()).toBeGreaterThan(1);
  });

  test("groups channels by team with General first", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    // Every team lists its General channel first (the backend's General-first
    // sort, which the sidebar grouping preserves).
    const groups = page.locator('[data-testid="team-group"]');
    const count = await groups.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      const firstChannel = groups.nth(i).locator('[data-testid="channel-name"]').first();
      await expect(firstChannel).toHaveText("General");
    }
  });

  test("opens a channel and shows its messages under a team header", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    const row = page.locator('[data-testid="channel-row"]').first();
    const channelName = ((await row.locator('[data-testid="channel-name"]').textContent()) ?? "").trim();
    expect(channelName.length).toBeGreaterThan(0);
    await row.click();

    // The header shows the channel name and a channel-specific subtitle, distinct
    // from a chat's; its backlog loads through the shared message pipeline.
    await expect(page.locator('[data-testid="conversation-title"]')).toHaveText(channelName);
    await expect(page.locator('[data-testid="channel-subtitle"]')).toContainText("Channel");
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });

  test("channel threads never appear in the Chats list", async ({ page }) => {
    await gotoApp(page);

    const channels = await fetchTestChannels(page);
    expect(channels.length).toBeGreaterThan(0);
    // Every channel is a channel thread (`@thread.tacv2`), the routing discriminant.
    for (const c of channels) expect(c.id.endsWith("@thread.tacv2")).toBeTruthy();
    const channelIds = new Set(channels.map((c) => c.id));

    // Scroll the entire virtualized Chats list, collecting every rendered row id,
    // and assert not one is a channel thread.
    const scroller = page.locator('[data-testid="sidebar-scroll"]');
    const seen = new Set<string>();
    const collect = async () => {
      const ids = await page
        .locator('[data-testid="conversation-row"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-conversation-id") ?? ""));
      for (const id of ids) seen.add(id);
    };
    const total = await scroller.evaluate((el) => el.scrollHeight);
    for (let y = 0; y <= total; y += 400) {
      await scroller.evaluate((el, yy) => (el.scrollTop = yy), y);
      await collect();
    }

    expect(seen.size).toBeGreaterThan(5);
    for (const id of seen) {
      expect(channelIds.has(id)).toBeFalsy();
      expect(id.endsWith("@thread.tacv2")).toBeFalsy();
    }
  });

  test("sends a message in a channel through the shared pipeline", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);
    await page.locator('[data-testid="channel-row"]').first().click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    const marker = `chan-${Date.now()}`;
    const composer = page.locator('[data-testid="composer"]');
    await composer.click();
    await composer.fill(marker);
    await composer.press("Enter");

    // The mock echoes the sent message back as one of ours (same path as chats).
    const echoed = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(echoed.first()).toBeVisible();
    await expect(echoed.first()).toHaveAttribute("data-mine", "true");
    await expect(composer).toHaveValue("");
  });

  test("runs clean with no console errors", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openChannelsTab(page);
    await page.locator('[data-testid="channel-row"]').first().click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
