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
    const [cardBox, groupBox] = [await card.boundingBox(), await group.boundingBox()];
    expect(cardBox && groupBox).toBeTruthy();
    // The card is inset from the panel by the panel's own padding alone, equally on
    // both sides — a card with a box of its own would be inset much further, and a
    // narrower card would not be centered in it.
    const leftInset = cardBox!.x - groupBox!.x;
    const rightInset = groupBox!.x + groupBox!.width - (cardBox!.x + cardBox!.width);
    expect(leftInset).toBeGreaterThan(0);
    expect(Math.abs(leftInset - rightInset)).toBeLessThan(2);
    expect(leftInset).toBeLessThan(20);

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
    expect(sent?.reply_to).toBeTruthy();
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
