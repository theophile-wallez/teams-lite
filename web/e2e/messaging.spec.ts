import {
  test,
  expect,
  clearComposer,
  composerField,
  fetchCapturedSends,
  fillComposer,
  gotoApp,
  openConversationAt,
  sendFromComposer,
  setSendControl,
} from "./helpers";
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    /** The page's real Clipboard, kept aside where a test hides it from the app. */
    realClipboard: Clipboard;
  }
}

/** Open a conversation by name via the command palette. A copy test names its thread and
 *  its message: the sidebar's order and the newest row are both shared state — one mock
 *  process serves the whole run — while a seeded body is the same words every time. */
async function openByPalette(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+k");
  const input = page.locator("[cmdk-input]");
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  await expect(page.locator('[data-testid="conversation-title"]')).toContainText(name);
}

/** A seeded message of the Media Gallery, named by its own words. */
const SEEDED = "screenshot from the incident";

/** Copy that message through its "…" menu, and answer with the words its bubble shows —
 *  what the clipboard is then held against. */
async function copySeededMessage(page: Page): Promise<string> {
  const target = page.locator('[data-testid="message"]', { hasText: SEEDED }).first();
  await expect(target).toBeVisible();
  const said = squashed((await target.textContent()) ?? "");
  await target.hover();
  await target.locator('[data-testid="message-actions"]').click();
  await page.locator('[data-testid="action-copy"]').click();
  return said;
}

/** A value on the clipboard that the copy under test must replace. The clipboard outlives
 *  a test, so an assertion that only reads it back passes on the PREVIOUS test's copy —
 *  which is a Copy that writes nothing looking exactly like one that works. */
const STALE = "nothing was copied";

/** One space for every run of whitespace: a body spanning two blocks is copied with a
 *  newline between them and rendered without one, and this test is about the words. */
function squashed(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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

  // A send takes as long as the network takes, and the reader keeps typing into the box
  // meanwhile — or their phone's keyboard commits a correction as Enter is pressed. The
  // words that LEFT must go and the words that did not must stay: clearing everything
  // erases what nobody sent, and clearing nothing shows the message that just left, so
  // the next Enter posts it twice.
  test("takes the sent words out and keeps the ones typed after them", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await setSendControl(page, { clear: true, delay_ms: 600 });

    await fillComposer(page, "this one leaves");
    const field = composerField(page);
    await field.press("Enter");
    await page.keyboard.type(" and this one stays");

    await expect(page.locator('[data-testid="message"]', { hasText: "this one leaves" })).toBeVisible();
    await expect(field).toHaveText("and this one stays");
    await setSendControl(page, { clear: true });
    await clearComposer(page);
  });

  // Enter hammered is one message. A send takes as long as the network takes and the key
  // repeats meanwhile, so every press after the first lands on a box that still holds the
  // words — and each one of those posted the message again, under the user's name, in front
  // of everybody in the thread. It is the sharpest shape of the rule above: the composer
  // refuses a send while one is out, and the refusal must hold for a press that arrives in
  // the same millisecond as the answer to the one before it.
  test("posts one message when Enter is hammered", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await setSendControl(page, { clear: true, delay_ms: 400 });

    const words = `hammered-${Date.now()}`;
    await fillComposer(page, words);
    const field = composerField(page);
    for (let i = 0; i < 8; i += 1) await field.press("Enter");

    await expect(page.locator('[data-testid="message"]', { hasText: words })).toHaveCount(1);
    await expect(field).toHaveText("");
    // The bubble is one because the SEND was one: a page that posted twice and drew one
    // row would pass an assertion about the thread alone.
    const sends = (await fetchCapturedSends(page)).filter((s) =>
      `${s.text}${s.content_html ?? ""}`.includes(words),
    );
    expect(sends).toHaveLength(1);
    await setSendControl(page, { clear: true });
    await clearComposer(page);
  });

  // The other half of the same rule: a draft REWRITTEN while the message travelled is the
  // reader's, whole. The sent range no longer describes anything that left, so nothing is
  // taken out of it — the words on screen are the ones they mean to send next.
  test("leaves a draft rewritten while the message travelled", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await setSendControl(page, { clear: true, delay_ms: 600 });

    await fillComposer(page, "the first one");
    const field = composerField(page);
    await field.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("a different message");

    await expect(page.locator('[data-testid="message"]', { hasText: "the first one" })).toBeVisible();
    await expect(field).toHaveText("a different message");
    await setSendControl(page, { clear: true });
    await clearComposer(page);
  });

  // Reply, then type: the caret has to be in the box by the time the next keystroke
  // arrives, or the answer the reader writes goes nowhere.
  test("the keystrokes that follow a Reply land in the composer", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    // The box starts empty and unfocused, which is the state this test is about.
    await clearComposer(page);

    const target = page.locator('[data-testid="message"]').first();
    await target.hover();
    await target.locator('[data-testid="message-actions"]').click();
    // No wait: this is somebody who clicks Reply and writes.
    await page.locator('[data-testid="action-reply"]').click();
    await page.keyboard.type("straight into the box");
    await expect(composerField(page)).toHaveText("straight into the box");

    await page.keyboard.press("Escape");
    await clearComposer(page);
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

  // The CLIPBOARD is what this asserts, not the sentence about it. Reading the status
  // line alone is how a Copy that reported success and wrote nothing survived.
  test("copies a message to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");
    await page.evaluate((stale) => navigator.clipboard.writeText(stale), STALE);

    const said = await copySeededMessage(page);
    await expect(page.locator('[data-testid="status-bar"]')).toContainText("copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).not.toBe(STALE);
    expect(said).toContain(squashed(copied));
  });

  // The async Clipboard API is not everywhere: it needs a secure context, and a
  // plain-HTTP front is a supported way to open this app (the launcher takes `--host`),
  // so `navigator.clipboard` is undefined there and the write was simply lost — reported
  // by one line at the foot of the sidebar, which reads as a Copy that does nothing.
  test("copies through the selection path when the clipboard API is missing", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // What an insecure origin looks like to the APP: no `writeText` at all. The real one
    // is kept aside for the test itself, which seeds the clipboard and reads it back —
    // hiding it from the app is the point, hiding it from both proves nothing.
    await page.addInitScript(() => {
      const real = navigator.clipboard;
      Object.defineProperty(window, "realClipboard", { configurable: true, value: real });
      Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => ({}) });
    });
    await gotoApp(page);
    await openByPalette(page, "Media Gallery");
    const clipboard = () => page.evaluate(() => window.realClipboard.readText());
    await page.evaluate((stale) => window.realClipboard.writeText(stale), STALE);

    const said = await copySeededMessage(page);
    await expect(page.locator('[data-testid="status-bar"]')).toContainText("copied");
    const copied = await clipboard();
    expect(copied).not.toBe(STALE);
    expect(said).toContain(squashed(copied));
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

  /**
   * The other half of the coarse-pointer rule in `web/e2e/mobile.spec.ts`: a MOUSE keeps
   * text selection, because that is how words are copied out of a message there. The two
   * assertions are one decision — dropping the `(pointer: coarse)` query in app.css would
   * take selection away from every desktop reader, and only this one says so.
   */
  test("a message stays selectable under a mouse", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const select = await page
      .locator('[data-testid="message"]')
      .first()
      .evaluate((element) => getComputedStyle(element).userSelect);

    expect(select).not.toBe("none");
  });
});
