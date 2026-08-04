import { test, expect, gotoApp } from "./helpers";
import type { Page } from "@playwright/test";

// Microsoft Teams gives a chat three settings that decide where it sits in the list and
// how loud it is — pinned, muted, hidden — and offers them from a "…" on the row. This
// covers that menu and the sections it fills.
//
// Every one of them is a LOCAL override here: the app mirrors what Teams reported until
// the user changes it, and writes nothing back (see `ChatPrefs` in lib/protocol.ts). So
// what a spec can assert is the app's own behaviour — where the row goes, what it looks
// like, and that the choice survives a reload.

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
  test("shows the Pinned, Recent and Hidden sections Teams shows", async ({ page }) => {
    await gotoApp(page);

    // The mock pins one 1:1 and one group, so both a Pinned and a Recent header are up.
    await expect(sectionHeader(page, "pinned")).toBeVisible();
    await expect(sectionHeader(page, "recent")).toBeVisible();
    // Every pinned row is IN the pinned section, and says so.
    const pinned = page.locator('[data-testid="conversation-row"][data-section="pinned"]');
    expect(await pinned.count()).toBeGreaterThan(0);
    await expect(pinned.first()).toHaveAttribute("data-pinned", "true");

    // The chat Teams itself hides is not in Recent: it is folded away at the foot,
    // which is where the user already put it (see `isHidden` in web/mock/server.ts).
    await expect(
      page.locator('[data-testid="conversation-row"]', { hasText: "Olivia Martins" }),
    ).toHaveCount(0);
    await scrollSidebarToEnd(page);
    const hidden = sectionHeader(page, "hidden");
    await expect(hidden).toBeVisible();
    await expect(hidden).toHaveText("Hidden chats (1)");
    // It opens folded, so nothing of it renders until it is asked for.
    await expect(hidden).toHaveAttribute("data-collapsed", "true");
    await hidden.click();
    const hiddenRow = page.locator('[data-testid="conversation-row"][data-section="hidden"]');
    await expect(hiddenRow).toHaveCount(1);
    await expect(hiddenRow).toContainText("Olivia Martins");
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

  test("muting a chat dims it, states why, and drops its unread marker", async ({ page }) => {
    await gotoApp(page);

    const unread = page
      .locator('[data-testid="conversation-row"][data-unread="true"]')
      .first();
    const id = (await unread.getAttribute("data-conversation-id")) ?? "";
    expect(id).toBeTruthy();

    await openChatMenu(page, id);
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
    // Out of the list: the section it went to is folded, so the row is gone entirely.
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

  test("a pin, a mute and a fold survive a reload", async ({ page }) => {
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
    await expect(row(page, id)).toHaveAttribute("data-section", "pinned");
    await expect(row(page, id)).toHaveAttribute("data-muted", "true");
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

    // A chat that is already read is offered no such item — the menu never states an
    // action with nothing to do.
    await openChatMenu(page, id);
    await expect(page.locator('[data-testid="chat-menu-mark-read"]')).toHaveCount(0);
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
