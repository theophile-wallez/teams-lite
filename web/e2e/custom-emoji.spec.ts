import { test, expect, composerField, gotoApp, openConversationNamed } from "./helpers";
import type { Locator, Page } from "@playwright/test";

/**
 * Custom emoji — Slack-style art the user adds to THIS machine, typed as `:shipit:`.
 *
 * Eight rules are really promises, and each gets one test:
 *
 *  1. a code the pack holds becomes art in a sent message; one it does not hold stays text;
 *  2. an inbound custom emoji is drawn from the message's OWN art, never from the pack;
 *  3. a code inside `<code>` and a code inside a reply quote both stay text;
 *  4. an emoji-only message renders jumbo;
 *  5. the `:` list offers custom emoji above the Unicode ones, and Enter inserts the chip;
 *  6. a taken name is refused with Slack's own sentence;
 *  7. delete asks twice, and the confirming label is "Delete Emoji";
 *  8. one Backspace removes a whole chip.
 *
 * Everything happens in the "Custom Emoji" thread, which the mock seeds for this feature
 * alone (`seedCustomEmojiThread` in web/mock/server.ts): it carries the colleague's message
 * with real inline emoji markup that rules 2 and 3 need, and it is the one thread no other
 * spec asserts on — so the six messages these tests send perturb nothing.
 *
 * `afterEach` puts the pack back to what a fresh mock seeds: one mock process serves the
 * whole run, so a pack left changed would move every later spec's picker and composer.
 */

/** The port the mock is expected on — mirrors `playwright.config.ts`. */
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "19457";

/** The art of `:shipit:` as a message draws it. `alt` is the code the body carried, which
 *  is the one thing both the pack's art and a message's own art agree on — so it names the
 *  glyph without saying where its bytes came from (rule 2 is exactly that difference). */
const SHIPIT_ART = 'img[alt=":shipit:"]';

/** The pack's own art for one code, as the composer's chip draws it. */
function packArt(page: Page, name: string): Locator {
  return page.locator(`[data-testid="composer-rich"] img[data-emoji-name="${name}"]`);
}

function messages(page: Page): Locator {
  return page.locator('[data-testid="message"]');
}

/** Put the pack back to the three emoji a fresh mock seeds, through its gated test hook. */
async function resetCustomEmoji(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "custom_emoji", clear: true },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Open this feature's own thread and empty the composer.
 *
 * The field is cleared on purpose: one mock process serves the whole run and it persists
 * drafts, so whatever an earlier test left here is still in front of the caret — and a ":"
 * that does not follow whitespace is not an emoji code at all (`emojiQueryBefore`).
 */
async function openEmojiThread(page: Page): Promise<Locator> {
  await gotoApp(page);
  await openConversationNamed(page, "Custom Emoji");
  const field = composerField(page);
  await field.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(field).toHaveText("");
  return field;
}

/** The id of the newest bubble in the thread. */
function newestId(page: Page): Promise<string | null> {
  return messages(page).last().getAttribute("data-message-id");
}

/**
 * Send what the composer holds, and hand back the bubble it arrived as.
 *
 * The new message is recognised by its `data-message-id` changing rather than by a count:
 * the history is virtualized, so rows mount and unmount as it scrolls and a count says
 * nothing — while the newest row is always drawn, because sending scrolls to it.
 */
async function sendAndAwaitEcho(page: Page): Promise<Locator> {
  const before = await newestId(page);
  // A keystroke that missed the field would send an empty body, which goes nowhere — and
  // the wait below would then time out saying only that no message arrived.
  await expect(composerField(page)).not.toHaveText("");
  await page.keyboard.press("Enter");
  await expect.poll(() => newestId(page), { timeout: 10_000 }).not.toBe(before);
  const id = await newestId(page);
  return page.locator(`[data-testid="message"][data-message-id="${id}"]`);
}

/** Open Settings and wait for the custom emoji section. */
async function openEmojiSettings(page: Page): Promise<Locator> {
  await gotoApp(page);
  await page.locator('[data-testid="open-settings"]').click();
  await expect(page.locator('[data-testid="settings-pane"]')).toBeVisible();
  const section = page.locator('[data-testid="custom-emoji-settings"]');
  await expect(section).toBeVisible();
  return section;
}

test.describe("custom emoji", () => {
  test.afterEach(async ({ page }) => {
    await resetCustomEmoji(page);
  });

  test("a code the pack holds becomes art; one it does not hold stays text", async ({
    page,
  }) => {
    const field = await openEmojiThread(page);

    await page.keyboard.type("shipping it :shipit:");
    const art = await sendAndAwaitEcho(page);
    await expect(art.locator(SHIPIT_ART)).toHaveCount(1);
    await expect(art).toContainText("shipping it");
    // The code is GONE from the words: it became the picture, rather than sitting beside it.
    await expect(art).not.toContainText(":shipit:");

    // A code the pack does not hold is left alone — no art, and the colons still read.
    await field.click();
    await page.keyboard.type("no such thing as :notanemoji:");
    const plain = await sendAndAwaitEcho(page);
    await expect(plain).toContainText(":notanemoji:");
    await expect(plain.locator("img")).toHaveCount(0);
  });

  test("an inbound custom emoji is drawn from the message's own art, not from the pack", async ({
    page,
  }) => {
    const field = await openEmojiThread(page);

    // The seeded colleague message carries real Teams emoji markup, with its own `src`.
    const inbound = messages(page).filter({ hasText: "thanks!" }).last();
    await expect(inbound).toHaveAttribute("data-mine", "false");
    const drawnArt = inbound.locator(SHIPIT_ART);
    await expect(drawnArt).toBeVisible();

    // The SAME code drawn from the pack, on the same page: the composer's own chip, whose
    // art comes from `custom_emoji_image` and nothing else.
    await field.click();
    await page.keyboard.type(":shipit");
    await expect(page.locator('[data-testid="emoji-suggestion-shipit"]')).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(packArt(page, "shipit")).toBeVisible();

    const drawn = await drawnArt.getAttribute("src");
    const fromPack = await packArt(page, "shipit").getAttribute("src");
    // Proxied Teams content never reaches the DOM as its own URL — the bytes come through
    // the backend and become a blob — so what says WHERE a glyph came from is WHICH blob it
    // is. The pack holds one per code, so a renderer that looked `:shipit:` up in the pack
    // would hand this bubble the very URL the chip beside it is using. It does not: the
    // colleague's own art is what is on screen.
    expect(drawn).toMatch(/^blob:/);
    expect(fromPack).toMatch(/^blob:/);
    expect(drawn).not.toBe(fromPack);

    // Leave no chip in the draft for the next spec to type in front of.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
  });

  test("a code inside <code> and a code inside a reply quote stay text", async ({ page }) => {
    const field = await openEmojiThread(page);

    // Inside code: Slack does not draw an emoji there either, so the backend skips the
    // region (`custom_emoji::SKIPPED_TAGS`). The mark comes from the composer's own format
    // bar, which keeps focus in the field as it toggles.
    const formatToggle = page.locator('[data-testid="composer-format-toggle"]');
    await formatToggle.click();
    const codeButton = page
      .locator('[data-testid="composer-toolbar"]')
      .getByRole("button", { name: "Inline code" });
    // The toggle is an ordinary button, so opening the bar took the caret with it. The code
    // is typed FIRST and then marked over the selection, which is also the only way the
    // mark reliably takes: a collapsed caret in an empty paragraph has no range to mark.
    await field.click();
    await page.keyboard.type(":shipit:");
    await page.keyboard.press("ControlOrMeta+a");
    await codeButton.click();
    await expect(codeButton).toHaveAttribute("aria-pressed", "true");
    await expect(field.locator("code")).toHaveText(":shipit:");
    const coded = await sendAndAwaitEcho(page);
    await formatToggle.click();
    await expect(page.locator('[data-testid="composer-toolbar"]')).toHaveCount(0);
    await expect(coded.locator("code")).toHaveText(":shipit:");
    await expect(coded.locator(SHIPIT_ART)).toHaveCount(0);

    // Inside a reply QUOTE: the quote holds the words somebody already wrote, so drawing
    // our art into them would rewrite them.
    await coded.hover();
    await coded.locator('[data-testid="message-actions"]').click();
    await page.locator('[data-testid="action-reply"]').click();
    await expect(page.locator('[data-testid="reply-banner"]')).toBeVisible();
    // Reply hands focus to the composer itself; the click is what makes that a fact rather
    // than a race with the menu's own closing animation.
    await field.click();
    await page.keyboard.type("and :shipit:");
    const reply = await sendAndAwaitEcho(page);

    const quote = reply.locator('[data-testid="message-quote"]');
    await expect(quote).toContainText(":shipit:");
    await expect(quote.locator(SHIPIT_ART)).toHaveCount(0);
    // The reply's OWN words did become art, so the two skips above are skips — not a
    // substitution that never ran at all.
    await expect(reply.locator(SHIPIT_ART)).toHaveCount(1);
  });

  test("an emoji-only message renders jumbo", async ({ page }) => {
    const field = await openEmojiThread(page);

    // A mixed message first: its glyph is the inline size to measure against, so the test
    // pins the RATIO rather than a pixel count that a font change would move.
    await page.keyboard.type("inline :shipit: here");
    const inline = await sendAndAwaitEcho(page);
    await expect(inline.locator(SHIPIT_ART)).toBeVisible();
    const inlineBox = await inline.locator(SHIPIT_ART).boundingBox();

    await field.click();
    await page.keyboard.type(":shipit:");
    const alone = await sendAndAwaitEcho(page);
    await expect(alone.locator(SHIPIT_ART)).toBeVisible();
    const jumboBox = await alone.locator(SHIPIT_ART).boundingBox();

    expect(inlineBox).not.toBeNull();
    expect(jumboBox).not.toBeNull();
    expect(jumboBox!.height).toBeGreaterThan(inlineBox!.height * 2);
  });

  test("the : list offers custom emoji above the Unicode ones, and Enter inserts the chip", async ({
    page,
  }) => {
    const field = await openEmojiThread(page);

    // `:ship` matches both bands, and matches them under the same NAME: the pack holds
    // `ship` as an alias of `shipit`, and Unicode has a `:ship:` of its own. So the order
    // is only readable from each row's kind.
    await page.keyboard.type(":ship");
    const list = page.locator('[data-testid="emoji-suggestions"]');
    await expect(list).toBeVisible();

    const rows = list.locator('[role="option"]');
    const kinds: (string | null)[] = [];
    for (let i = 0; i < (await rows.count()); i += 1) {
      kinds.push(await rows.nth(i).getAttribute("data-kind"));
    }
    expect(kinds).toContain("custom");
    expect(kinds).toContain("unicode");
    // EVERY custom row sits above every Unicode one — the user's own emoji are what they
    // meant, and a Unicode shortcode that happens to share the name must not outrank them.
    expect(kinds.lastIndexOf("custom")).toBeLessThan(kinds.indexOf("unicode"));
    await expect(rows.first()).toHaveAttribute("data-testid", "emoji-suggestion-shipit");

    // Enter takes the active row, and what lands in the composer is the CHIP, not the code.
    await page.keyboard.press("Enter");
    await expect(packArt(page, "shipit")).toBeVisible();
    await expect(field).not.toContainText(":ship");

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
  });

  test("a taken name is refused with Slack's own sentence", async ({ page }) => {
    const section = await openEmojiSettings(page);

    await section.locator('[data-testid="add-custom-emoji"]').click();
    const dialog = page.locator('[data-testid="add-emoji-dialog"]');
    await expect(dialog).toBeVisible();

    // `shipit` is already in the pack, and an emoji is never silently overwritten.
    await dialog.locator('[data-testid="add-emoji-name"]').fill("shipit");
    await expect(dialog.locator('[data-testid="add-emoji-error"]')).toHaveText(
      "If your emoji name is taken, choose another.",
    );
    await expect(dialog.locator('[data-testid="add-emoji-save"]')).toBeDisabled();

    // And it is about the name being TAKEN: a free one clears the sentence.
    await dialog.locator('[data-testid="add-emoji-name"]').fill("shipit-too");
    await expect(dialog.locator('[data-testid="add-emoji-error"]')).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("delete asks twice, and the confirming label is Delete Emoji", async ({ page }) => {
    const section = await openEmojiSettings(page);

    const row = section.locator('[data-testid="custom-emoji-row-partyparrot"]');
    await expect(row).toBeVisible();

    // The first select does not act: it arms the second, which is the one that calls. An
    // emoji is used in messages that are already sent, and nothing here brings it back.
    await row.locator('[data-testid="custom-emoji-delete-partyparrot"]').click();
    await expect(row).toBeVisible();
    const confirm = row.locator('[data-testid="custom-emoji-confirm-delete"]');
    await expect(confirm).toHaveText("Delete Emoji");

    await confirm.click();
    await expect(row).toHaveCount(0);
  });

  test("one Backspace removes a whole chip", async ({ page }) => {
    const field = await openEmojiThread(page);

    await page.keyboard.type(":shipit");
    await expect(page.locator('[data-testid="emoji-suggestion-shipit"]')).toBeVisible();
    await page.keyboard.press("Enter");
    const chip = packArt(page, "shipit");
    await expect(chip).toHaveCount(1);

    // Insertion leaves a trailing space, so the first Backspace deletes that space.
    await page.keyboard.press("Backspace");
    await expect(chip).toHaveCount(1);

    // And then ONE keystroke takes the whole chip: half an emoji code names nothing, so
    // there is nothing to shorten the way a mentioned name shortens.
    await page.keyboard.press("Backspace");
    await expect(chip).toHaveCount(0);
    await expect(field).toHaveText("");
  });
});
