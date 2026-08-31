import {
  test,
  expect,
  clearComposer,
  composerField,
  clearScheduledMessages,
  fetchCapturedSends,
  fillComposer,
  gotoApp,
  openChannelsTab,
  openConversationAt,
  fetchTestChannels,
  realErrors,
  sendFromComposer,
  setSendControl,
} from "./helpers";
import type { Page } from "@playwright/test";

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
      const group = groups.nth(i);
      // A team the user folded in Teams opens folded, so unfold it before reading it.
      if ((await group.getAttribute("data-collapsed")) === "true") {
        await group.locator('[data-testid="team-header"]').click();
      }
      await expect(group.locator('[data-testid="channel-name"]').first()).toHaveText("General");
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
    await sendFromComposer(page, marker);

    // The mock echoes the sent message back as one of ours (same path as chats).
    const echoed = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(echoed.first()).toBeVisible();
    await expect(echoed.first()).toHaveAttribute("data-mine", "true");
    await expect(composerField(page)).toHaveText("");
  });

  test("pinning a channel lifts it into the Pinned section and back", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    // The mock pins nothing, so there is no Pinned section to start — and there is no
    // Favorites section at all: Teams has none (see channelIsShown in protocol.ts).
    await expect(page.locator('[data-testid="pinned-group"]')).toHaveCount(0);

    const firstRow = page.locator('[data-testid="channel-row"]').first();
    const channelId = await firstRow.getAttribute("data-channel-id");
    const channelName = (
      (await firstRow.locator('[data-testid="channel-name"]').textContent()) ?? ""
    ).trim();
    expect(channelId).toBeTruthy();

    // Reveal (on hover) and click the row's pin toggle.
    await firstRow.hover();
    await page.locator('[data-testid="channel-pin"]').first().click();

    // The channel is lifted into the Pinned section and marked pinned, and is no
    // longer listed under its team group.
    const pinned = page.locator('[data-testid="pinned-group"]');
    await expect(pinned).toBeVisible();
    await expect(pinned.locator('[data-testid="channel-name"]').first()).toHaveText(channelName);
    await expect(pinned.locator(`[data-channel-id="${channelId}"]`)).toHaveAttribute(
      "data-pinned",
      "true",
    );
    await expect(
      page.locator(`[data-testid="team-group"] [data-channel-id="${channelId}"]`),
    ).toHaveCount(0);

    // Unpinning returns it to its team and drops the now-empty Pinned section.
    await pinned.locator('[data-testid="channel-pin"]').first().click();
    await expect(page.locator('[data-testid="pinned-group"]')).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="team-group"] [data-channel-id="${channelId}"]`),
    ).toHaveCount(1);
  });

  test("a pinned channel persists across a reload", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    const firstRow = page.locator('[data-testid="channel-row"]').first();
    const channelId = await firstRow.getAttribute("data-channel-id");
    await firstRow.hover();
    await page.locator('[data-testid="channel-pin"]').first().click();
    await expect(page.locator('[data-testid="pinned-group"]')).toBeVisible();

    // The pin override is persisted client-side, so it survives a reload even though
    // the backend still reports the channel as unpinned.
    await page.reload();
    await openChannelsTab(page);

    const pinned = page.locator('[data-testid="pinned-group"]');
    await expect(pinned).toBeVisible();
    await expect(pinned.locator(`[data-channel-id="${channelId}"]`)).toHaveAttribute(
      "data-pinned",
      "true",
    );
  });

  test("keeps a channel Teams hides out of the team list, under Hidden channels", async ({
    page,
  }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    // The mock hides exactly one channel (Engineering · Archive — see HIDDEN_CHANNELS
    // in web/mock/server.ts), so the treatment is pinned to one known row.
    const engineering = page
      .locator('[data-testid="team-group"]')
      .filter({ has: page.locator('[data-testid="team-name"]', { hasText: "Engineering" }) })
      .first();
    const hidden = engineering.locator('[data-testid="hidden-group"]');
    await expect(hidden).toBeVisible();
    await expect(hidden.locator('[data-testid="hidden-name"]')).toHaveText("Hidden channels (1)");

    // It starts folded: the user hid the channel in Teams, so it is out of the way —
    // and it is nowhere in the team's own list of channels.
    await expect(hidden.locator('[data-testid="hidden-header"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(hidden.locator('[data-testid="channel-row"]')).toHaveCount(0);
    await expect(engineering.locator('[data-testid="channel-name"]', { hasText: "Archive" })).toHaveCount(0);

    // One click reveals it, and the row says it is a hidden one. It is still a normal
    // channel: it opens through the same pipeline.
    await hidden.locator('[data-testid="hidden-header"]').click();
    const row = hidden.locator('[data-testid="channel-row"]');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-hidden", "true");
    await expect(row.locator('[data-testid="channel-name"]')).toHaveText("Archive");
    await row.click();
    await expect(page.locator('[data-testid="conversation-title"]')).toHaveText("Archive");

    // No other row claims to be hidden.
    await expect(page.locator('[data-testid="channel-row"][data-hidden="true"]')).toHaveCount(1);
  });

  test("collapses a team section and remembers it across a reload", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    // Every team starts expanded, the way Microsoft Teams opens on a full tree.
    const group = page.locator('[data-testid="team-group"]').first();
    const header = group.locator('[data-testid="team-header"]');
    await expect(header).toHaveAttribute("aria-expanded", "true");
    const shown = await group.locator('[data-testid="channel-row"]').count();
    expect(shown).toBeGreaterThan(0);

    // The whole header is the toggle: one click folds the team's channels away.
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator('[data-testid="channel-row"]')).toHaveCount(0);

    // The collapsed state is persisted client-side, so it survives a reload.
    await page.reload();
    await openChannelsTab(page);
    const reopened = page.locator('[data-testid="team-group"]').first();
    await expect(reopened.locator('[data-testid="team-header"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(reopened.locator('[data-testid="channel-row"]')).toHaveCount(0);

    // Expanding it brings every channel back.
    await reopened.locator('[data-testid="team-header"]').click();
    await expect(reopened.locator('[data-testid="channel-row"]')).toHaveCount(shown);
  });

  test("opens a team folded when the user folded it in Teams", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    // The mock folds exactly one team (Product — see TEAM_SEEDS in web/mock/server.ts),
    // mirroring the `isCollapsed` its own Teams client reports for it.
    const folded = page
      .locator('[data-testid="team-group"]')
      .filter({ has: page.locator('[data-testid="team-name"]', { hasText: "Product" }) })
      .first();
    await expect(folded).toHaveAttribute("data-collapsed", "true");
    await expect(folded.locator('[data-testid="team-header"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(folded.locator('[data-testid="channel-row"]')).toHaveCount(0);

    // Every other team opens, because Teams reports them open.
    const open = page.locator('[data-testid="team-group"]:not([data-collapsed="true"])');
    expect(await open.count()).toBeGreaterThan(1);

    // A fold made HERE wins from then on: unfolding the folded team survives a reload,
    // even though the backend still reports it as folded in Teams.
    await folded.locator('[data-testid="team-header"]').click();
    await expect(folded.locator('[data-testid="channel-row"]').first()).toBeVisible();
    await page.reload();
    await openChannelsTab(page);
    const reopened = page
      .locator('[data-testid="team-group"]')
      .filter({ has: page.locator('[data-testid="team-name"]', { hasText: "Product" }) })
      .first();
    await expect(reopened.locator('[data-testid="team-header"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("reads a channel the user muted in Teams as muted", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    // The mock mutes exactly one channel (Design · Critique — see CHANNEL_ALERTS
    // in web/mock/server.ts), so the treatment is pinned to one known row.
    const muted = page.locator('[data-testid="channel-row"][data-muted="true"]');
    await expect(muted).toHaveCount(1);
    await expect(muted.locator('[data-testid="channel-name"]')).toHaveText("Critique");

    // A muted channel states why it is quiet, and never claims attention: no
    // unread marker, whatever its read state.
    await expect(muted.locator('[data-testid="channel-muted-glyph"]')).toBeVisible();
    await expect(muted).not.toHaveAttribute("data-unread", "true");

    // Every other channel keeps the normal treatment.
    const others = page.locator('[data-testid="channel-row"]:not([data-muted="true"])');
    expect(await others.count()).toBeGreaterThan(0);
    await expect(others.locator('[data-testid="channel-muted-glyph"]')).toHaveCount(0);
  });

  test("renders an app-card post on the thread's own card, not in a card inside it", async ({
    page,
  }) => {
    await gotoApp(page);
    await openChannelsTab(page);

    // The mock seeds exactly one card post in a channel (Engineering · Incidents —
    // see seedChannelAlertThread in web/mock/server.ts): a monitoring alert relayed
    // by a bot, which is what a whole notifications channel consists of.
    await page
      .locator('[data-testid="channel-row"]')
      .filter({ hasText: "Incidents" })
      .first()
      .click();
    const card = page.locator('[data-testid="card-attachment"]').first();
    await expect(card).toBeVisible();

    // The thread's card is the post's surface, so the card draws none of its own
    // and spans the post instead of sitting in a smaller box inside it.
    await expect(card).toHaveAttribute("data-on-panel", "true");
    const group = page.locator('[data-testid="thread-group"]').filter({ has: card });
    const name = group.locator('[data-testid="sender-name"]').first();
    const [cardBox, groupBox, nameBox] = [
      await card.boundingBox(),
      await group.boundingBox(),
      await name.boundingBox(),
    ];
    expect(cardBox && groupBox && nameBox).toBeTruthy();
    // The card spans the POST's own column: flush with the panel's inner right edge, and
    // starting where the author's name starts. It used to be measured as EQUAL insets from
    // the panel on both sides, which was a proxy for "it spans the panel" — and the proxy
    // stopped being true when a post in a thread gained a face down its left (see
    // `threadPost`). The two edges it really has to line up with are what is asserted now: a
    // card with a box of its own would be inset much further from both.
    const rightInset = groupBox!.x + groupBox!.width - (cardBox!.x + cardBox!.width);
    expect(rightInset).toBeGreaterThan(0);
    expect(rightInset).toBeLessThan(20);
    expect(Math.abs(cardBox!.x - nameBox!.x)).toBeLessThan(2);

    // The card's content is untouched by the flattening: its title, its markdown
    // and its link action all still render.
    await expect(card.locator('[data-testid="card-title"]')).toContainText(
      "ContainerCannotStartNonProd",
    );
    await expect(card.locator('[data-testid="card-action"]')).toHaveAttribute("href", /grafana/);
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

// A CHANNEL THREAD is a thread, not a stretch of chat — Teams' and Discord's own shape, and
// what this surface used to draw instead was a chat inside a box: the reader's own answer on
// the opposite side of the card from a colleague's, a centred block mark between every reply,
// and no way into the thread at all, so answering an announcement opened a second untitled
// thread beside it. See `ThreadGroup` in components/message-pane.tsx for the surface, the
// `threadPost` prop in message-bubble.tsx for a post, and `teams_send::parse_thread_root` for
// how a reply is filed under the announcement rather than beside it.
test.describe("a channel thread", () => {
  /**
   * Open the first channel and one thread in it that HOLDS replies, LOCKED ON by its own
   * root id.
   *
   * The history is virtualized, so `…thread-group").first()` is not one card — it re-resolves
   * to whatever happens to be mounted, and expanding a thread grows its row and moves the set.
   * A locator built on `data-thread-root` is the same card before and after the click.
   */
  async function openThreadWithReplies(page: Page) {
    await gotoApp(page);
    await openChannelsTab(page);
    await page.locator('[data-testid="channel-row"]').first().click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    // The newest threads are the ones on screen when a channel opens, so no scroll is needed
    // and none is made: a scroll is what unmounts the card the test is about.
    const root = await page
      .locator('[data-testid="thread-group"]')
      .filter({ has: page.locator('[data-testid="thread-toggle"]') })
      .last()
      .getAttribute("data-thread-root");
    expect(root).toBeTruthy();
    const thread = page.locator(`[data-thread-root="${root}"]`);
    await thread.locator('[data-testid="thread-toggle"]').click();
    await expect(thread.locator('[data-testid="thread-replies"]')).toBeVisible();
    return thread;
  }

  test("draws every post in ONE column, whoever wrote it", async ({ page }) => {
    await openThreadWithReplies(page);
    // Open every thread on screen that holds replies, so the measurement covers both sides:
    // the fixtures put the reader's own posts and colleagues' in the same threads, and which
    // ONE thread happens to hold both is not something a spec should depend on.
    const toggles = page.locator('[data-testid="thread-toggle"][aria-expanded="false"]');
    for (let i = await toggles.count(); i > 0; i -= 1) await toggles.first().click();

    const posts = page.locator('[data-testid="thread-group"] [data-testid="message"]');
    expect(await posts.count()).toBeGreaterThan(4);

    // A chat says WHO with a SIDE, and inside one thread that reads as two people arguing
    // across the card rather than as a list of what was said about one announcement. So both
    // sides are here…
    const mine = await posts.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-mine") === "true"),
    );
    expect(mine).toContain(true);
    expect(mine).toContain(false);

    // …and each LEVEL of the thread is one column, whoever wrote the post in it: the root
    // posts share an x and the replies share an x, indented under them. Two columns is the
    // whole geometry — a chat's two SIDES would be one more, decided by authorship.
    const column = (selector: string) =>
      page.locator(selector).evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().left)),
      );
    const replyLefts = await column(
      '[data-testid="thread-replies"] [data-testid="message"]',
    );
    const allLefts = await column('[data-testid="thread-group"] [data-testid="message"]');
    const rootLefts = allLefts.filter((x) => !replyLefts.includes(x));
    expect(new Set(rootLefts).size).toBe(1);
    expect(new Set(replyLefts).size).toBe(1);
    expect(replyLefts[0]!).toBeGreaterThan(rootLefts[0]!);

    // And no post carries a fill of its own: the thread's card is the surface.
    const fills = await posts.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor),
    );
    for (const fill of fills) expect(fill).toBe("rgba(0, 0, 0, 0)");
  });

  test("names each post's author and its moment, and never both twice", async ({ page }) => {
    const thread = await openThreadWithReplies(page);
    const first = thread.locator('[data-testid="message"]').first();
    // WHO — on the reader's OWN post too, which a chat bubble never labels because its side
    // says so. Here nothing else does.
    await expect(first.locator('[data-testid="sender-name"]')).toBeVisible();
    // …and WHEN, beside the name, with the exact moment on its title so a relative label
    // still answers which day it was.
    const when = first.locator('[data-testid="thread-post-time"]');
    await expect(when).toBeVisible();
    await expect(when).not.toHaveText("");
    await expect(when).toHaveAttribute("title", /\d/);
    const [nameBox, whenBox] = [
      await first.locator('[data-testid="sender-name"]').boundingBox(),
      await when.boundingBox(),
    ];
    expect(whenBox!.x).toBeGreaterThan(nameBox!.x);

    // And NO centred block mark inside the thread. The marks are a pass over one running
    // conversation; a channel holds several at once, so one falling between two replies cut
    // the answers to a single announcement into stamped fragments.
    await expect(thread.locator('[data-testid="message-time"]')).toHaveCount(0);
  });

  test("a reply from the thread's own row lands IN that thread", async ({ page }) => {
    const thread = await openThreadWithReplies(page);
    const before = await thread.locator('[data-testid="message"]').count();

    // The way in is the thread's own row: there is one composer in this app, so the row aims
    // that one — and says so, because the box is a screen below the thread it posts into.
    await thread.locator('[data-testid="thread-reply"]').click();
    await expect(thread).toHaveAttribute("data-reply-target", "true");
    await expect(page.locator('[data-testid="reply-banner"]')).toContainText("Replying in");

    const body = `in-thread-${Date.now()}`;
    await sendFromComposer(page, body);
    // The WIRE is what proves it: the address of the thread, and no quote — a reply to the
    // announcement inside the announcement's own thread would state it twice.
    await expect
      .poll(async () => (await fetchCapturedSends(page)).some((s) => s.content_html?.includes(body)))
      .toBe(true);
    const sent = (await fetchCapturedSends(page))
      .filter((s) => s.content_html?.includes(body))
      .pop();
    expect(sent?.thread_root).toBeTruthy();
    expect(sent?.reply_to).toBeUndefined();

    // And the echo joins THAT thread rather than opening one of its own at the foot of the
    // channel, which is the defect the whole feature exists to fix.
    await expect.poll(() => thread.locator('[data-testid="message"]').count()).toBe(before + 1);
    await expect(thread.locator('[data-testid="message"]').last()).toContainText(body);
  });

  test("a reply to another REPLY quotes it, and still lands in the same thread", async ({
    page,
  }) => {
    const thread = await openThreadWithReplies(page);
    // A long thread holds several conversations, so answering one reply keeps the quote —
    // it is the only thing that says which of them is being answered.
    const reply = thread.locator('[data-testid="thread-replies"] [data-testid="message"]').first();
    await reply.hover();
    await reply.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toContainText("Replying to");

    const body = `answering-a-reply-${Date.now()}`;
    await sendFromComposer(page, body);
    await expect
      .poll(async () => (await fetchCapturedSends(page)).some((s) => s.content_html?.includes(body)))
      .toBe(true);
    const sent = (await fetchCapturedSends(page))
      .filter((s) => s.content_html?.includes(body))
      .pop();
    expect(sent?.reply_to).toBeTruthy();
    expect(sent?.thread_root).toBeTruthy();
  });

  test("the reply row clears the touch floor and opens a folded thread", async ({ page }) => {
    await gotoApp(page);
    await openChannelsTab(page);
    await page.locator('[data-testid="channel-row"]').first().click();
    const root = await page
      .locator('[data-testid="thread-group"]')
      .filter({ has: page.locator('[data-testid="thread-toggle"]') })
      .last()
      .getAttribute("data-thread-root");
    const thread = page.locator(`[data-thread-root="${root}"]`);
    // Folded: nobody answers a conversation they cannot read, so the press opens it too.
    await expect(thread.locator('[data-testid="thread-replies"]')).toHaveCount(0);
    const row = thread.locator('[data-testid="thread-reply"]');
    // 44px under a thumb — the floor every target this app draws for one holds.
    const box = await row.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await row.click();
    await expect(thread.locator('[data-testid="thread-replies"]')).toBeVisible();
    await expect(thread).toHaveAttribute("data-reply-target", "true");
  });

  test("the card's chrome is ONE row, and the accent is spent on the thread being answered", async ({
    page,
  }) => {
    const thread = await openThreadWithReplies(page);
    const toggle = thread.locator('[data-testid="thread-toggle"]');
    const reply = thread.locator('[data-testid="thread-reply"]');

    // Every box in ONE pass over the DOM, because the replies SLIDE IN when the thread is
    // expanded: two sequential `boundingBox()` calls sample two different frames, and the
    // whole assertion here is that the two share a row. One read proves that whether or not
    // the card is still moving — which is sharper than waiting for it to settle.
    const { a, b, card } = await thread.evaluate((el) => {
      const box = (selector: string) => {
        const found = el.querySelector(selector);
        if (!found) throw new Error(`the thread card holds no ${selector}`);
        const { x, y, width, height } = found.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        a: box('[data-testid="thread-toggle"]'),
        b: box('[data-testid="thread-reply"]'),
        card: { width: el.getBoundingClientRect().width },
      };
    });

    // ONE row. It used to be two — an accent pill counting the replies, then a full-width
    // Reply under it — so a card whose words were one line spent three rows on chrome.
    expect(Math.round(a.y + a.height / 2)).toBe(Math.round(b.y + b.height / 2));
    expect(b.x).toBeGreaterThan(a.x + a.width - 1);
    // Neither spans the card: a full-width row is what made "Reply" the loudest thing on it.
    expect(b.width).toBeLessThan(card.width / 2);

    // Both still clear the touch floor, which is what a foot row of meta must not cost.
    expect(a.height).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);

    // And NEITHER carries the accent at rest — every card in the history would otherwise
    // wear the app's one accent for a disclosure. It is spent on the one thing that earns
    // it: the thread the next Enter lands in, which is why the two are compared rather
    // than a colour being spelled out here.
    const ink = (target: typeof toggle) => target.evaluate((el) => getComputedStyle(el).color);
    const rest = await ink(toggle);
    expect(await ink(reply)).toBe(rest);
    await reply.click();
    await expect(thread).toHaveAttribute("data-reply-target", "true");
    expect(await ink(reply)).not.toBe(rest);
    // …and the count beside it stays quiet: one accent, on one thing.
    expect(await ink(toggle)).toBe(rest);
  });

  test("a reacted post draws its chips IN FLOW, under the words", async ({ page }) => {
    // A post in a thread has no bubble, so the chip row has no edge to straddle: hung off
    // one it sat in a 28px reserved band under a full-width post, with a 30px pill alone in
    // it, and read as an enormous free-floating emoji. Measured on the real tenant.
    await gotoApp(page);
    await openChannelsTab(page);
    // Engineering · Incidents is the one channel whose thread the mock seeds with reactions
    // (see `seedChannelAlertThread`), because until this the fixtures held none at all and so
    // this surface could not be captured or asserted.
    await page
      .locator('[data-testid="channel-row"]')
      .filter({ hasText: "Incidents" })
      .first()
      .click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    // Found by the alert CARD it opens with rather than by the reaction, because the reacted
    // posts are its replies: a folded card holds none, so a locator built on the chips could
    // never find the thread that has to be expanded to draw them.
    const thread = page
      .locator('[data-testid="thread-group"]')
      .filter({ has: page.locator('[data-testid="card-attachment"]') })
      .last();
    await thread.locator('[data-testid="thread-toggle"]').click();
    const post = thread
      .locator('[data-testid="message"]')
      .filter({ has: page.locator('[data-testid="message-reactions"]') })
      .first();
    const row = post.locator('[data-testid="message-reactions"]');
    await expect(row).toBeVisible();
    // IN FLOW: the row is an ordinary block, so it is inside its post's own box rather than
    // hanging below it, and the post reserves no band for an overhang.
    await expect(row).toHaveAttribute("data-in-flow", "true");
    expect(await row.evaluate((el) => getComputedStyle(el).position)).toBe("static");
    // Both rects in ONE pass, for the reason the test above states: the replies slide in, so
    // two sequential reads are two frames and the assertion is about their relative geometry.
    const { rowBox, postBox } = await post.evaluate((el) => {
      const found = el.querySelector('[data-testid="message-reactions"]');
      if (!found) throw new Error("the post holds no reaction row");
      const chips = found.getBoundingClientRect();
      const own = el.getBoundingClientRect();
      return {
        rowBox: { x: chips.x, bottom: chips.bottom },
        postBox: { x: own.x, bottom: own.bottom },
      };
    });
    expect(rowBox.bottom).toBeLessThanOrEqual(postBox.bottom + 1);
    // …and it starts at the post's own left edge, so it reads as that post's last line.
    expect(Math.round(rowBox.x)).toBe(Math.round(postBox.x));

    // A pill sized for a 12px meta line rather than for a bubble's 30px one, and carrying ONE
    // hairline: a border beside a shadow is the pairing the fine shadow exists instead of.
    const chips = row.locator("button");
    const chip = chips.first();
    const chipBox = await chip.boundingBox();
    expect(chipBox!.height).toBeLessThanOrEqual(26);
    for (const each of await chips.all()) {
      expect(await each.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
    }
    // A fill of its own too: `--reaction-chip` is 72% white, so on a card that IS white the
    // lone circle read as a bare emoji sitting in the words.
    const cardFill = await thread.evaluate((el) => getComputedStyle(el).backgroundColor);
    for (const each of await chips.all()) {
      const fill = await each.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(fill).not.toBe(cardFill);
      expect(fill).not.toBe("rgba(0, 0, 0, 0)");
    }
    // OURS is told apart by an accent hairline as well as by its fill — the tint alone is an
    // 8-point lift in blue, which is why the bubble chip never rested on it either. The
    // fixture puts ours first and a colleague's beside it, so the two are compared.
    const shadows = await chips.evaluateAll((els) =>
      els.map((el) => `${getComputedStyle(el).boxShadow}`),
    );
    await expect(chip).toHaveAttribute("data-mine", "true");
    await expect(chips.nth(1)).not.toHaveAttribute("data-mine", "true");
    expect(shadows[0]).not.toBe(shadows[1]);
  });

  test("the @ list offers the CHANNEL itself, and the send says it is one", async ({ page }) => {
    // The reader asked for "the alerting group" in the list, which in Teams is a CHANNEL
    // mention: the widest thing one press here reaches, because it notifies whoever follows
    // the channel. So the whole of this test is that it is offered where it works, drawn as
    // what it is, and posted as what it is — a channel mention described as a person is blue
    // text notifying nobody, which is the silent half of the mention pair.
    await gotoApp(page);
    await openChannelsTab(page);
    const row = page.locator('[data-testid="channel-row"]').first();
    const channelName = ((await row.locator('[data-testid="channel-name"]').textContent()) ?? "")
      .trim();
    await row.click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // A bare "@" offers it FIRST among the mention targets: one fixed row a reader learns
    // once, above a list of people that grows.
    const field = page.locator('[data-testid="composer-rich"] .tiptap-message');
    await field.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("@");
    const suggestions = page.locator('[data-testid="mention-suggestions"]');
    await expect(suggestions).toBeVisible();
    const channelRow = suggestions.locator('[data-testid="mention-suggestion"][data-kind="channel"]');
    await expect(channelRow).toHaveCount(1);
    await expect(channelRow).toHaveAttribute("data-mri", /@thread\.tacv2$/);
    // It says what the press COSTS before it is made, which is the one fact the reader
    // cannot undo after — and it is NOT drawn as a person: an avatar seeded from a thread id
    // is a face for a colleague who does not exist.
    await expect(channelRow).toContainText("notifies the channel");
    expect(await channelRow.locator("img").count()).toBe(0);

    await channelRow.click();
    await expect(suggestions).toHaveCount(0);
    const body = `channel-mention-${Date.now()}`;
    await page.keyboard.type(` ${body}`);
    await page.locator('[data-testid="composer-send"]').click();

    await expect
      .poll(async () => (await fetchCapturedSends(page)).some((s) => s.content_html?.includes(body)), {
        timeout: 10_000,
      })
      .toBe(true);
    const sent = (await fetchCapturedSends(page))
      .filter((s) => s.content_html?.includes(body))
      .pop();
    // The PAIR, and the kind that makes it a channel mention rather than a colleague: the
    // body carries an indexed span, the list says what that index names, and the mri is the
    // conversation itself — which is the one thing the backend checks it against, so a
    // channel the reader is not writing in can never be notified from here.
    expect(sent?.mentions).toHaveLength(1);
    expect(sent?.mentions?.[0]?.kind).toBe("channel");
    expect(sent?.mentions?.[0]?.mri).toBe(sent?.conversation);
    expect(sent?.mentions?.[0]?.display_name).toBe(channelName);
    expect(sent?.content_html).toContain(`itemid="${sent?.mentions?.[0]?.itemid}"`);
    expect(sent?.content_html).toContain("schema.skype.com/Mention");
  });

  test("a CHAT never offers the channel row, because there is no channel to name", async ({
    page,
  }) => {
    // The backend refuses a channel mention in a chat whatever a page offers, so this is the
    // page agreeing with that rail rather than a second, softer copy of it — and a row that
    // reported a refusal is exactly what this app draws nothing instead of.
    await gotoApp(page);
    await openConversationAt(page, 0);
    const field = page.locator('[data-testid="composer-rich"] .tiptap-message');
    await field.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("@");
    await expect(page.locator('[data-testid="mention-suggestions"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="mention-suggestion"][data-kind="channel"]'),
    ).toHaveCount(0);
  });

  test("a CHAT reply is untouched: a quote, and no thread address", async ({ page }) => {
    // A chat has no threads, so nothing about this change may reach it — a chat reply is the
    // quote it has always been, and a `thread_root` there is refused by the backend outright.
    await gotoApp(page);
    await openConversationAt(page, 0);
    const message = page.locator('[data-testid="message"]').first();
    await message.hover();
    await message.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toContainText("Replying to");

    const body = `chat-reply-${Date.now()}`;
    await sendFromComposer(page, body);
    await expect
      .poll(async () => (await fetchCapturedSends(page)).some((s) => s.content_html?.includes(body)))
      .toBe(true);
    const sent = (await fetchCapturedSends(page))
      .filter((s) => s.content_html?.includes(body))
      .pop();
    expect(sent?.reply_to).toBeTruthy();
    expect(sent?.thread_root).toBeUndefined();
    // And the reader's own message still takes its own side of the room, which is what says
    // whose it is in a chat.
    await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
      "data-mine",
      "true",
    );
  });
});

// A channel post has a TITLE and a chat message does not — Teams' own split, and the whole
// differentiation this surface used to be missing: the composer was the same box in both,
// and an inbound title was drawn as 13px metadata above the words. See lib/post-subject.ts
// for the rule and `teams_send::SUBJECT` for what the title is on the wire.
test.describe("a channel post's title", () => {
  const subjectField = '[data-testid="composer-subject"]';

  /** Open a channel that is not the app-card one, so the post drawn is an ordinary one. */
  async function openChannel(page: Page): Promise<void> {
    await gotoApp(page);
    await openChannelsTab(page);
    await page.locator('[data-testid="channel-row"]').first().click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
  }

  test("is offered on a channel post, and never in a chat", async ({ page }) => {
    await openChannel(page);
    await expect(page.locator(subjectField)).toBeVisible();
    // The backend's own ceiling, so the field refuses the 251st character rather than
    // collecting a title the send is refused for.
    await expect(page.locator(subjectField)).toHaveAttribute("maxlength", "250");
    // And it is aimed at with a thumb: the touch floor every other target here clears.
    const box = await page.locator(subjectField).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // A chat message has no title anywhere in Teams, and the backend refuses one.
    await page.locator('[data-testid="tab-chats"]').click();
    await openConversationAt(page, 0);
    await expect(page.locator('[data-testid="composer-shell"]')).toBeVisible();
    await expect(page.locator(subjectField)).toHaveCount(0);
  });

  test("is not offered on a REPLY, never travels on one, and survives the cancel", async ({
    page,
  }) => {
    await openChannel(page);
    await setSendControl(page, { clear: true });
    await page.locator(subjectField).fill("Ship the US envs");

    // A reply belongs to a thread that is already named by its first post, so there is no
    // title to write — and the backend refuses one on a reply.
    const message = page.locator('[data-testid="message"]').first();
    await message.hover();
    await message.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    await expect(page.locator(subjectField)).toHaveCount(0);

    // And what the hidden field holds does not travel with the reply: the backend REFUSES a
    // titled reply, so a regression here is a reply that cannot be sent at all.
    const body = `reply-${Date.now()}`;
    await sendFromComposer(page, body);
    await expect
      .poll(async () =>
        (await fetchCapturedSends(page)).some((s) => s.content_html?.includes(body)),
      )
      .toBe(true);
    const sent = (await fetchCapturedSends(page))
      .filter((send) => send.content_html?.includes(body))
      .pop();
    // A reply in a CHANNEL is a post in a thread, addressed by that thread's root rather
    // than carrying a quote of it: the quote used to be what made a reply a reply here, and
    // it filed the answer as a NEW thread at the foot of the channel (see
    // `teams_send::parse_thread_root`). What the title rule needs either way is that nothing
    // titled travels with it — and the backend refuses BOTH pairs, so a regression here is a
    // reply that cannot be sent at all.
    expect(sent?.thread_root).toBeTruthy();
    expect(sent?.reply_to).toBeUndefined();
    expect(sent?.subject).toBeUndefined();

    // The field was hidden, not emptied: the reader had not finished with it, and the send
    // that ended the reply brings it back with the words still in it.
    await expect(page.locator(subjectField)).toHaveValue("Ship the US envs");
  });

  test("a press on the title puts the caret in the title", async ({ page }) => {
    // The box focuses the message field on any click that is not a control — so a press on
    // the title used to fall through to it, which made the field unusable by pointer.
    await openChannel(page);
    await page.locator(subjectField).click();
    await page.keyboard.type("Typed into the title");
    await expect(page.locator(subjectField)).toHaveValue("Typed into the title");
    await expect(composerField(page)).toHaveText("");

    // Enter belongs to the message: in the title it moves to the words rather than posting
    // a titled nothing.
    await page.keyboard.press("Enter");
    await page.keyboard.type("and this is the body");
    await expect(page.locator(subjectField)).toHaveValue("Typed into the title");
    await expect(composerField(page)).toContainText("and this is the body");

    // And Escape in the title does the same rather than reaching the shell, whose Escape
    // LEAVES the conversation — which would take the title with it, since the words are a
    // persisted draft and the title is not.
    await page.locator(subjectField).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(subjectField)).toBeVisible();
    await expect(page.locator(subjectField)).toHaveValue("Typed into the title");
  });

  test("travels as a property of the message and is drawn as a heading", async ({ page }) => {
    await openChannel(page);
    const title = `Release ${Date.now()}`;
    const body = `body-${Date.now()}`;
    // An empty box — an earlier test's draft in this channel survives, and Send is enabled
    // by the WORDS, which is the thing being asserted next.
    await clearComposer(page);
    await page.locator(subjectField).fill(title);
    // A title alone is not a post: Send stays disabled until there are words.
    await expect(page.locator('[data-testid="composer-send"]')).toBeDisabled();
    await sendFromComposer(page, body);

    // The send carried the title as its own field. That is the crux: the title is
    // `properties.subject` on the message, never words inside its body — so a colleague's
    // own client draws a titled post rather than a bold first line.
    const sentBody = (sends: Awaited<ReturnType<typeof fetchCapturedSends>>) =>
      sends.filter((send) => send.content_html?.includes(body)).pop();
    await expect
      .poll(async () => sentBody(await fetchCapturedSends(page))?.subject, { timeout: 10_000 })
      .toBe(title);
    const sent = sentBody(await fetchCapturedSends(page));
    expect(sent?.content_html ?? "").not.toContain(title);

    // And the echo is drawn as a titled post: the heading above the words, in the size a
    // heading has. Measured rather than trusted from the class list, because "it reads as a
    // title" is the whole feature — at the 13px it used to be it read as metadata.
    const group = page.locator('[data-testid="thread-group"]').filter({ hasText: body });
    const heading = group.locator('[data-testid="thread-subject"]');
    await expect(heading).toHaveText(title);
    const headingSize = await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const bubble = group.locator("[data-message-id]").first();
    const bodySize = await bubble.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(headingSize).toBeGreaterThan(bodySize);
    expect(headingSize).toBeGreaterThanOrEqual(16);
    // The title is not in the post's own words either — the differentiation is real, not
    // the same sentence twice.
    await expect(bubble).not.toContainText(title);

    // The title that left is taken back with the words, so the next post does not inherit it.
    await expect(page.locator(subjectField)).toHaveValue("");
  });

  test("a title being rewritten while the send travels is left alone", async ({ page }) => {
    // The rule the words follow (`removeSentWords`): a send takes back exactly what left,
    // and only while the field still holds it. Hold the send and rewrite the title meanwhile.
    await openChannel(page);
    await setSendControl(page, { delay_ms: 700, clear: true });
    const body = `held-${Date.now()}`;
    await page.locator(subjectField).fill("First thoughts");
    await fillComposer(page, body);
    await composerField(page).press("Enter");
    await page.locator(subjectField).fill("Second thoughts");
    // The title that LEFT was the first one, so the rewrite survives the send that finishes
    // after it — an unconditional clear would erase words nobody sent.
    await expect
      .poll(async () => (await fetchCapturedSends(page)).some((s) => s.subject === "First thoughts"))
      .toBe(true);
    await expect(page.locator(subjectField)).toHaveValue("Second thoughts");
    await setSendControl(page, { clear: true });
  });

  test("survives the scheduled queue, in both actions", async ({ page }) => {
    // A message Teams is HOLDING is re-sent by "Send now" and handed back by "Edit"
    // (§ Sending a message LATER), so both have to carry the title the service stored —
    // otherwise the reader re-posts their own announcement with the heading removed.
    await openChannel(page);
    await setSendControl(page, { clear: true });
    const title = `Queued release ${Date.now()}`;
    const body = `queued-${Date.now()}`;
    await page.locator(subjectField).fill(title);
    await fillComposer(page, body);
    await page.locator('[data-testid="composer-schedule"]').click();
    await page.locator('[data-testid="composer-schedule-preset"]').first().click();
    await expect(page.locator('[data-testid="composer-schedule-note"]')).toBeVisible();

    // SEND NOW: the same title goes out with the words.
    await page.locator('[data-testid="composer-schedule-open-list"]').click();
    const row = page
      .locator('[data-testid="scheduled-message-row"]')
      .filter({ hasText: body });
    await row.locator('[data-testid="scheduled-send-now"]').click();
    await expect
      .poll(async () =>
        (await fetchCapturedSends(page)).some((s) => s.subject === title && !s.scheduled_time),
      )
      .toBe(true);
    await page.keyboard.press("Escape");

    // EDIT: the title comes back to the field with the words, ready to be re-timed.
    const second = `queued-again-${Date.now()}`;
    await page.locator(subjectField).fill(title);
    await fillComposer(page, second);
    await page.locator('[data-testid="composer-schedule"]').click();
    await page.locator('[data-testid="composer-schedule-preset"]').first().click();
    await page.locator('[data-testid="composer-schedule-open-list"]').click();
    await page
      .locator('[data-testid="scheduled-message-row"]')
      .filter({ hasText: second })
      .locator('[data-testid="scheduled-edit"]')
      .click();
    await expect(page.locator('[data-testid="scheduled-messages-dialog"]')).toBeHidden();
    await expect(composerField(page)).toHaveText(second);
    await expect(page.locator(subjectField)).toHaveValue(title);

    // One mock process serves the whole run: a queued message left behind sits in every
    // later spec's banner.
    await clearScheduledMessages(page);
  });

  test("belongs to the conversation it was written in", async ({ page }) => {
    await openChannel(page);
    await page.locator(subjectField).fill("Only for this channel");
    // Walking away drops it, exactly as a pasted picture is dropped: a title belongs to the
    // post being written, and must not follow the reader into somebody else's channel.
    await page.locator('[data-testid="channel-row"]').nth(1).click();
    await expect(page.locator(subjectField)).toHaveValue("");
  });
});

/**
 * A CHANNEL IS DRAWN THE WAY TEAMS DRAWS IT: as titled POSTS, or as a running CONVERSATION
 * whose replies live behind a threads panel. The channel itself says which
 * (`properties.chatModalityType`, measured on 70 of this tenant's channels), so these specs
 * hold both surfaces on one mock — `Engineering/Frontend` is the conversational fixture and
 * every other seeded channel is posts.
 */
test.describe("a channel's layout", () => {
  const panel = '[data-testid="threads-panel"]';
  const repliesRow = '[data-testid="post-replies"]';

  /** Open a channel by NAME, from the Channels tab — never by index, because which index a
   *  layout sits at is exactly what must not matter to a spec, and never by a name matched
   *  across every tab, because the chat list is walked first. */
  async function openNamedChannel(page: Page, name: string): Promise<void> {
    await gotoApp(page);
    await openChannelsTab(page);
    await page.locator('[data-testid="channel-row"]').filter({ hasText: name }).first().click();
    await expect
      .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
  }

  test("draws a conversational channel as bubbles and a posts channel as cards", async ({
    page,
  }) => {
    await openNamedChannel(page, "Research");
    // No thread CARDS at all: a conversational channel's main column is its top-level posts,
    // and their answers are in the panel.
    await expect(page.locator('[data-testid="thread-group"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
    // And the block time marks come BACK, because the column really is one running
    // conversation again — the reason a channel drawn as threads has none.
    await expect
      .poll(() => page.locator('[data-testid="message-time"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // The other layout is untouched, in the same mock and one click away.
    await page.locator('[data-testid="channel-row"]').filter({ hasText: "Incidents" }).first().click();
    await expect
      .poll(() => page.locator('[data-testid="thread-group"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect(page.locator(repliesRow)).toHaveCount(0);
  });

  test("offers no post TITLE in a conversational channel", async ({ page }) => {
    // Teams' conversational channel has a chat's own composer. A field there would draw a
    // heading nothing else on that surface has, and title a post that reads as a message.
    await openNamedChannel(page, "Research");
    await expect(page.locator('[data-testid="composer-subject"]')).toHaveCount(0);
    // …and the posts layout still has one, so this is the LAYOUT deciding rather than the
    // field having been dropped for every channel.
    await page.locator('[data-testid="channel-row"]').filter({ hasText: "Incidents" }).first().click();
    await expect(page.locator('[data-testid="composer-subject"]')).toBeVisible();
  });

  test("says who answered, how many and when — and opens the panel", async ({ page }) => {
    await openNamedChannel(page, "Research");
    const row = page.locator(repliesRow).first();
    await expect(row).toBeVisible();
    // The three facts a reader decides to open a thread on. The count is words, never "1
    // replies"; the moment is the same phrasing a block mark uses.
    await expect(row).toContainText(/\d+ (reply|replies)/);
    await expect(row).toContainText("Last reply");
    // A face per replier, and no more than the row can hold.
    const faces = await row.locator("img, [data-testid='avatar-initials'], span[aria-hidden]").count();
    expect(faces).toBeGreaterThan(0);
    // 44px under a thumb, the floor every target this app draws for one clears.
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);

    await row.click();
    await expect(page.locator(panel)).toBeVisible();
    // WHICH thread it is showing, and the thread's own words in the header.
    const root = await page.locator(panel).getAttribute("data-thread-root");
    expect(root).toBeTruthy();
    await expect(page.locator('[data-testid="threads-panel-heading"]')).not.toBeEmpty();
    // The post, the line counting its replies, and the replies themselves.
    await expect(page.locator('[data-testid="threads-panel-divider"]')).toContainText(
      /\d+ (reply|replies)/,
    );
    await expect
      .poll(() => page.locator(`${panel} [data-testid="message"]`).count())
      .toBeGreaterThan(1);
  });

  test("aims the ONE composer at the thread it opened, and takes that aim back", async ({
    page,
  }) => {
    await openNamedChannel(page, "Research");
    await page.locator(repliesRow).first().click();
    await expect(page.locator(panel)).toBeVisible();
    // There is one composer in this app: the panel brings none of its own, so opening it aims
    // that one — otherwise the reader's next Enter would post to the CHANNEL and land as a new
    // untitled thread beside the post rather than as an answer under it.
    await expect(page.locator('[data-testid="composer-shell"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();

    await page.locator('[data-testid="threads-panel-close"]').click();
    await expect(page.locator(panel)).toHaveCount(0);
    // Closing takes the aim back: words written with no panel on screen belong to the channel.
    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });

  test("replaces the conversation on a phone rather than squeezing it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openNamedChannel(page, "Research");
    await page.locator(repliesRow).first().click();
    const panelBox = await page.locator(panel).boundingBox();
    expect(panelBox).not.toBeNull();
    // The whole width, and the history is not on screen beside it at all. HIDDEN rather than
    // unmounted, deliberately: the conversation keeps its loaded history and its scroll
    // position, so closing the panel returns the reader to where they were rather than to a
    // pane that has to load itself again.
    expect(panelBox!.width).toBeGreaterThan(300);
    await expect(page.locator('[data-testid="message-scroll"]')).toBeHidden();
    // Its close is the way back to the conversation.
    await page.locator('[data-testid="threads-panel-close"]').click();
    await expect(page.locator('[data-testid="message-scroll"]')).toBeVisible();
  });
});
