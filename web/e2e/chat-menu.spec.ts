import { test, expect, gotoApp } from "./helpers";
import type { Page } from "@playwright/test";

// Microsoft Teams gives a chat three settings that decide where it sits in the list and
// how loud it is — pinned, muted, hidden — and offers them from a "…" on the row. This
// covers that menu and the sections it fills.
//
// The read marker is the fourth thing that menu holds, and the one that is asymmetric:
// marking a chat READ is published (`mark_read` moves the user's horizon forward), while
// marking it UNREAD stays here, because no horizon ever goes backwards.
//
// The three do NOT reach the same place, and the split is measured rather than chosen
// (see src/teams_chat_settings.rs): the MUTE is published to Teams and read back from it,
// while the pin and the hide are local overrides this app holds itself. So the mute is
// asserted through the backend — the mock stores what the RPC publishes — and the other
// two through the app's own behaviour, including across a reload.

/** A chat row, by the id the sidebar states on it. */
function row(page: Page, id: string) {
  return page.locator(`[data-testid="conversation-row"][data-conversation-id="${id}"]`);
}

/** One section header of the chat list. */
function sectionHeader(page: Page, section: "pinned" | "recent" | "hidden") {
  return page.locator(`[data-testid="chat-section-header"][data-section="${section}"]`);
}

/** Open the "…" menu on the row for `id`, revealing it on hover the way a person does.
 *  Returns nothing: the items are addressed by their own test ids. */
async function openChatMenu(page: Page, id: string): Promise<void> {
  const target = row(page, id);
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  // An item that was just clicked closes the menu with an animation, and the trigger
  // TOGGLES — so a click that lands while the last panel is still closing is swallowed
  // and the menu stays shut. A person never outruns that; a spec does.
  await expect(page.locator('[data-testid="chat-menu-pin"]')).toHaveCount(0);
  await page.locator(`[data-testid="chat-menu"][data-conversation-id="${id}"]`).click();
  await expect(page.locator('[data-testid="chat-menu-pin"]')).toBeVisible();
}

/** Scroll the chat list until the row (or header) is in the DOM: the list is
 *  virtualized, so what is far enough down does not exist yet. */
async function scrollSidebarToEnd(page: Page): Promise<void> {
  const scroller = page.locator('[data-testid="sidebar-scroll"]');
  for (let i = 0; i < 30; i += 1) {
    const done = await scroller.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return el.scrollTop === before;
    });
    if (done) return;
    await page.waitForTimeout(100);
  }
}

/** Back to the head of the chat list, where Pinned and the newest Recent chats are. */
async function scrollSidebarToTop(page: Page): Promise<void> {
  await page.locator('[data-testid="sidebar-scroll"]').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(150);
}

test.describe("chat sections and the row menu", () => {
  test("shows the Pinned and Recent sections Teams shows", async ({ page }) => {
    await gotoApp(page);

    // The mock pins one 1:1 and one group, so both a Pinned and a Recent header are up.
    await expect(sectionHeader(page, "pinned")).toBeVisible();
    await expect(sectionHeader(page, "recent")).toBeVisible();
    // Every pinned row is IN the pinned section, and says so.
    const pinned = page.locator('[data-testid="conversation-row"][data-section="pinned"]');
    expect(await pinned.count()).toBeGreaterThan(0);
    await expect(pinned.first()).toHaveAttribute("data-pinned", "true");

    // Nothing is hidden until the user hides something HERE — Teams' own `hidden` flag
    // is not a hide, and reading it as one buried every 1:1 chat on the real account
    // (95 of 95, see `chatIsHidden`). The mock marks Olivia Martins hidden exactly to
    // pin that: the row belongs in Recent all the same.
    await expect(sectionHeader(page, "hidden")).toHaveCount(0);
    const flagged = page
      .locator('[data-testid="conversation-row"]', { hasText: "Olivia Martins" })
      .first();
    await flagged.scrollIntoViewIfNeeded();
    await expect(flagged).toHaveAttribute("data-section", "recent");
  });

  test("pinning from the menu lifts the chat into Pinned, and unpinning returns it", async ({
    page,
  }) => {
    await gotoApp(page);

    const target = page.locator('[data-testid="conversation-row"][data-section="recent"]').first();
    const id = (await target.getAttribute("data-conversation-id")) ?? "";
    expect(id).toBeTruthy();

    await openChatMenu(page, id);
    await page.locator('[data-testid="chat-menu-pin"]').click();
    await expect(row(page, id)).toHaveAttribute("data-section", "pinned");
    await expect(row(page, id)).toHaveAttribute("data-pinned", "true");

    // The same item now offers the way back, and takes it.
    await openChatMenu(page, id);
    await expect(page.locator('[data-testid="chat-menu-pin"]')).toHaveText("Unpin");
    await page.locator('[data-testid="chat-menu-pin"]').click();
    await expect(row(page, id)).toHaveAttribute("data-section", "recent");
    await expect(row(page, id)).not.toHaveAttribute("data-pinned", "true");
  });

  test("muting a chat publishes it, dims the row, and drops its unread marker", async ({
    page,
  }) => {
    await gotoApp(page);

    const unread = page
      .locator('[data-testid="conversation-row"][data-unread="true"]')
      .first();
    const id = (await unread.getAttribute("data-conversation-id")) ?? "";
    expect(id).toBeTruthy();

    await openChatMenu(page, id);
    // The mute goes out through `set_chat_muted`; the mock stores it on the
    // conversation, exactly as the tenant does, so the row below reflects the ACCOUNT.
    await page.locator('[data-testid="chat-menu-mute"]').click();

    const muted = row(page, id);
    await expect(muted).toHaveAttribute("data-muted", "true");
    // A muted chat raises no unread marker, and the crossed bell says why the row went
    // quiet — a dim name alone would read as "read".
    await expect(muted).not.toHaveAttribute("data-unread", "true");
    await expect(muted.locator('[data-testid="conversation-muted-glyph"]')).toBeVisible();

    await openChatMenu(page, id);
    await expect(page.locator('[data-testid="chat-menu-mute"]')).toHaveText("Unmute");
    await page.locator('[data-testid="chat-menu-mute"]').click();
    await expect(row(page, id)).not.toHaveAttribute("data-muted", "true");
    await expect(row(page, id)).toHaveAttribute("data-unread", "true");
  });

  test("hiding a chat puts it away, and the Hidden section brings it back", async ({ page }) => {
    await gotoApp(page);

    const target = page.locator('[data-testid="conversation-row"][data-section="recent"]').first();
    const id = (await target.getAttribute("data-conversation-id")) ?? "";

    await openChatMenu(page, id);
    await page.locator('[data-testid="chat-menu-hide"]').click();
    // Out of the list: the Hidden section it created opens folded, so the row is gone.
    await expect(row(page, id)).toHaveCount(0);

    await scrollSidebarToEnd(page);
    await sectionHeader(page, "hidden").click();
    await expect(row(page, id)).toHaveAttribute("data-section", "hidden");

    // From there the menu offers the way back, and the chat returns to Recent.
    await openChatMenu(page, id);
    await expect(page.locator('[data-testid="chat-menu-hide"]')).toHaveText("Show chat");
    await page.locator('[data-testid="chat-menu-hide"]').click();
    // It lands back among the newest chats, which is at the head of the list — and the
    // list is virtualized, so the row only exists once that end is on screen again.
    await scrollSidebarToTop(page);
    await expect(row(page, id)).toHaveAttribute("data-section", "recent");
  });

  test("a pin and a fold survive a reload, and so does a published mute", async ({ page }) => {
    await gotoApp(page);

    // A chat the mock does NOT already report as muted, so that "Mute" is what the item
    // offers: the seed mutes a few, and an earlier spec's message can lift one of them
    // to the head of Recent.
    const target = page
      .locator('[data-testid="conversation-row"][data-section="recent"]:not([data-muted="true"])')
      .first();
    const id = (await target.getAttribute("data-conversation-id")) ?? "";
    await openChatMenu(page, id);
    await page.locator('[data-testid="chat-menu-pin"]').click();
    await openChatMenu(page, id);
    await page.locator('[data-testid="chat-menu-mute"]').click();
    await expect(row(page, id)).toHaveAttribute("data-muted", "true");
    // Fold the Pinned section too, since the fold is persisted the same way.
    await sectionHeader(page, "pinned").click();
    await expect(sectionHeader(page, "pinned")).toHaveAttribute("data-collapsed", "true");

    // The overrides are client-side, so they hold even though the backend still reports
    // the chat as unpinned and unmuted.
    await page.reload();
    await gotoApp(page);
    await expect(sectionHeader(page, "pinned")).toHaveAttribute("data-collapsed", "true");
    await sectionHeader(page, "pinned").click();
    // The pin and the fold are this browser's, held in localStorage; the mute is the
    // account's, and comes back from the backend rather than from the page.
    await expect(row(page, id)).toHaveAttribute("data-section", "pinned");
    await expect(row(page, id)).toHaveAttribute("data-muted", "true");

    // Leave the shared mock as it was found: an account-level setting outlives this
    // spec's page, so a mute left on would follow every later spec (see
    // e2e/helpers.ts — one mock serves the whole run).
    await openChatMenu(page, id);
    await page.locator('[data-testid="chat-menu-mute"]').click();
    await expect(row(page, id)).not.toHaveAttribute("data-muted", "true");
  });

  test("marks an unread chat read without opening it", async ({ page }) => {
    await gotoApp(page);

    const unread = page
      .locator('[data-testid="conversation-row"][data-unread="true"]')
      .first();
    const id = (await unread.getAttribute("data-conversation-id")) ?? "";

    await openChatMenu(page, id);
    await page.locator('[data-testid="chat-menu-mark-read"]').click();
    await expect(row(page, id)).not.toHaveAttribute("data-unread", "true");
    // Nothing was opened: the detail pane still says so.
    await expect(page.locator('[data-testid="conversation-title"]')).toHaveCount(0);

    // One slot, and it now states the other action: a read chat is offered "Mark as
    // unread" and never a "Mark as read" with nothing to do.
    await openChatMenu(page, id);
    await expect(page.locator('[data-testid="chat-menu-mark-read"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="chat-menu-mark-unread"]')).toBeVisible();
  });

  test("marks a read chat unread HERE, and it survives a reload", async ({ page }) => {
    await gotoApp(page);

    // A chat Microsoft Teams reports as read: the marker this test sets exists nowhere
    // but this browser, since `mark_read` can only ever publish a horizon that moves
    // FORWARD (see `chatIsUnread`).
    const read = page
      .locator('[data-testid="conversation-row"]:not([data-unread="true"]):not([data-muted="true"])')
      .first();
    const id = (await read.getAttribute("data-conversation-id")) ?? "";

    await openChatMenu(page, id);
    await page.locator('[data-testid="chat-menu-mark-unread"]').click();
    await expect(row(page, id)).toHaveAttribute("data-unread", "true");
    // And the pair turns over: the same slot now offers the way back.
    await openChatMenu(page, id);
    await expect(page.locator('[data-testid="chat-menu-mark-read"]')).toBeVisible();
    await page.keyboard.press("Escape");

    // It is persisted like the pin and the fold, so it outlives the page — nothing
    // about the account changed, so nothing brings it back but this browser.
    await gotoApp(page);
    await expect(row(page, id)).toHaveAttribute("data-unread", "true");

    // OPENING the chat is what a person means by having read it, and it takes the
    // marker back — the one way out that needs no menu.
    await row(page, id).click();
    await expect(row(page, id)).not.toHaveAttribute("data-unread", "true");
  });

  test("folding a section takes its chats off the keyboard's path too", async ({ page }) => {
    await gotoApp(page);

    // The selection starts on the first row on screen, which is the first pinned chat.
    const first = page.locator('[data-testid="conversation-row"]').first();
    const pinnedId = await first.getAttribute("data-conversation-id");
    await expect(first).toHaveAttribute("data-selected", "true");

    await sectionHeader(page, "pinned").click();
    // With Pinned folded, the first row is a Recent one, and Enter opens THAT chat —
    // the selection is an index into the list as rendered.
    const nowFirst = page.locator('[data-testid="conversation-row"]').first();
    await expect(nowFirst).toHaveAttribute("data-section", "recent");
    const recentId = await nowFirst.getAttribute("data-conversation-id");
    expect(recentId).not.toBe(pinnedId);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(recentId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
