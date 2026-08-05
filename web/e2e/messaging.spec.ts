import {
  test,
  expect,
  composerField,
  fetchCapturedSends,
  fillComposer,
  gotoApp,
  openConversationAt,
  sendFromComposer,
  setSendControl,
} from "./helpers";

test.describe("messaging", () => {
  test("sends a message and shows the echoed bubble", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const marker = `send-${Date.now()}`;
    await sendFromComposer(page, marker);
    // The mock echoes the sent message ~150ms later as one of ours.
    const echoed = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(echoed).toBeVisible();
    await expect(echoed.first()).toHaveAttribute("data-mine", "true");
    // The composer is cleared after sending.
    await expect(composerField(page)).toHaveText("");
  });

  // The live sentinel. `web/scripts/sandbox-live.ts` may type into the user's real
  // account in exactly one conversation, and it proves which one is open by reading
  // this attribute before every keystroke — so it has to name the thread that is
  // actually on screen, and it has to follow a switch (AGENTS.md § Sending messages).
  test("the composer names the conversation it would post to", async ({ page }) => {
    await gotoApp(page);
    const shell = page.locator('[data-testid="composer-shell"]');

    const first = await openConversationAt(page, 0);
    expect(first).not.toBe("");
    await expect(shell).toHaveAttribute("data-conversation-id", first);

    const second = await openConversationAt(page, 1);
    expect(second).not.toBe(first);
    await expect(shell).toHaveAttribute("data-conversation-id", second);
  });

  test("Shift+Enter inserts a newline instead of sending", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    // Count what the backend RECEIVED, not the rows on screen: the history is
    // virtualized, so a second composer line pushes one row out of the viewport and
    // a row count would read that as a message going missing.
    const before = (await fetchCapturedSends(page)).length;
    // Replace the field rather than append: one mock serves the whole run, and it
    // keeps a draft per conversation, so an earlier spec may have left text here.
    await fillComposer(page, "line one");
    const composer = composerField(page);
    await composer.press("Shift+Enter");
    await page.keyboard.type("line two");
    // `innerText` renders the hard break as the newline it is.
    expect((await composer.innerText()).trim()).toBe("line one\nline two");
    // No message was sent.
    expect((await fetchCapturedSends(page)).length).toBe(before);
  });

  test("replies to a message via the actions menu", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const target = page.locator('[data-testid="message"]').first();
    await target.hover();
    await target.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();

    const marker = `reply-${Date.now()}`;
    await sendFromComposer(page, marker);
    await expect(page.locator('[data-testid="message"]', { hasText: marker })).toBeVisible();
    // The banner clears once the reply is sent.
    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });

  test("Escape cancels a pending reply", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    const target = page.locator('[data-testid="message"]').first();
    await target.hover();
    await target.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    await composerField(page).press("Escape");
    await expect(page.locator('[data-testid="reply-banner"]')).toHaveCount(0);
  });

  test("copies a message to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoApp(page);
    await openConversationAt(page, 0);
    const target = page.locator('[data-testid="message"]').first();
    await target.hover();
    await target.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-copy"]').click();
    // The app reports success in the status bar.
    await expect(page.locator('[data-testid="status-bar"]')).toContainText("copied");
  });

  // A send that fails is the one failure this app must not swallow. It used to be
  // reported by the status line alone — eleven truncated pixels at the foot of the
  // sidebar, and on a phone not on screen at all — so pressing Send chimed, kept the
  // words in the box, and said nothing about why.
  test("says why a message did not leave, at the composer", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await setSendControl(page, { error: "mock send refused", clear: true });

    await fillComposer(page, "This one must not vanish");
    await page.locator('[data-testid="composer-send"]').click();

    const failure = page.locator('[data-testid="composer-send-error"]');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("Not sent");
    await expect(failure).toContainText("mock send refused");
    // The words stay in the box, so the user can retry rather than retype.
    await expect(composerField(page)).toHaveText("This one must not vanish");

    // A send that works answers it, and walking to another thread drops it: the
    // failure belongs to the conversation it happened in.
    await setSendControl(page, { clear: true });
    await sendFromComposer(page, `recovered-${Date.now()}`);
    await expect(failure).toHaveCount(0);
  });

  test("leaves a failed send behind when the user walks to another thread", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await setSendControl(page, { error: "mock send refused", clear: true });
    await fillComposer(page, "stays here");
    await page.locator('[data-testid="composer-send"]').click();
    await expect(page.locator('[data-testid="composer-send-error"]')).toBeVisible();

    await setSendControl(page, { clear: true });
    await openConversationAt(page, 1);
    await expect(page.locator('[data-testid="composer-send-error"]')).toHaveCount(0);
  });
});
