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
 *  4. an emoji among words is text-sized, and a message that is NOTHING but emoji is drawn
 *     large with the bubble chrome dropped — one decision, so both halves are asserted;
 *  4b. the reaction row offers the pack's own art, and the chip that lands IS that art;
 *  5. the `:` list offers custom emoji above the Unicode ones, and Enter inserts the chip;
 *  5b. a LONE `:` opens the pack alone, Tab picks from it, and Enter still SENDS;
 *  6. a taken name is refused with Slack's own sentence;
 *  7. delete asks twice, and the confirming label is "Delete Emoji";
 *  8. one Backspace removes a whole chip;
 *  9. a picture pasted into Settings too big to be an emoji is SHRUNK rather than refused,
 *     and the dialog says so.
 *
 * Everything happens in the "Custom Emoji" thread, which the mock seeds for this feature
 * alone (`seedCustomEmojiThread` in web/mock/server.ts): it carries the colleague's message
 * with real inline emoji markup that rules 2 and 3 need, and it is the one thread no other
 * spec asserts on. The six messages these tests send perturb nothing for a second reason
 * too, and it is not this file's doing: a fixture thread's sidebar time is frozen at its
 * seed, so posting here cannot lift it above the chat that `openConversationAt(page, 0)`
 * means in ~90 other places. That it CAN is how this spec once turned reactions.spec.ts red
 * — see `addFixtureConversation`.
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

/**
 * Paste one picture of `width`x`height` into the Add Emoji dialog's paste area.
 *
 * It is drawn IN the page rather than encoded here: what this test needs is a real PNG too
 * big to be an emoji, and a browser already has an encoder. The picture is noise rather
 * than a flat fill, so it weighs something — a single colour compresses to a few hundred
 * bytes, and a picture inside the weight cap would prove only half the rule.
 */
async function pasteEmojiImage(page: Page, width: number, height: number): Promise<void> {
  await page.locator('[data-testid="add-emoji-dropzone"]').evaluate(
    (element, size) =>
      new Promise<void>((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("no 2d context"));
          return;
        }
        for (let x = 0; x < size.width; x += 4) {
          for (let y = 0; y < size.height; y += 4) {
            context.fillStyle = `rgb(${(x * 7) % 256},${(y * 11) % 256},${(x + y) % 256})`;
            context.fillRect(x, y, 4, 4);
          }
        }
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("no blob"));
            return;
          }
          const clipboard = new DataTransfer();
          clipboard.items.add(new File([blob], "big.png", { type: "image/png" }));
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboard,
            }),
          );
          resolve();
        }, "image/png");
      }),
    { width, height },
  );
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

  test("an emoji-only message is drawn large and loses the bubble chrome", async ({ page }) => {
    const field = await openEmojiThread(page);

    // A mixed message: emoji among words. It stays text-sized, because it is punctuation in
    // a sentence and a glyph twice the height of the line it sits on is not readable.
    await page.keyboard.type("inline :shipit: here");
    const inline = await sendAndAwaitEcho(page);
    const inlineImg = inline.locator(SHIPIT_ART);
    await expect(inlineImg).toBeVisible();

    // A message that is nothing but emoji. Here the content IS the surface, so it is drawn
    // large and the bubble's own fill and padding go — the treatment link-, image-, card-
    // and recording-only messages already get.
    await field.click();
    await page.keyboard.type(":shipit:");
    const alone = await sendAndAwaitEcho(page);
    const aloneImg = alone.locator(SHIPIT_ART);
    await expect(aloneImg).toBeVisible();

    // BOTH halves are asserted because either one alone is a bug that shipped on the way
    // here: a large emoji still inside a padded bubble reads as an uploaded picture in a
    // frame, and a text-sized one inside a bare row reads as a mistake.
    //
    // Half one — the size. Measured as a RATIO of the two rendered heights rather than
    // against a pixel count, which the bubble's font size would move. The classes are
    // 1.15em against 2.75em, so the real ratio is ~2.4; 1.5 is the loosest bound that
    // still fails if the two ever draw at one size.
    const inlineBox = await inlineImg.boundingBox();
    const aloneBox = await aloneImg.boundingBox();
    expect(inlineBox).not.toBeNull();
    expect(aloneBox).not.toBeNull();
    expect(aloneBox!.height).toBeGreaterThan(inlineBox!.height * 1.5);

    // Half two — the chrome. The bubble's fill is what says "this is a message body", and an
    // emoji-only message drops it: the `bare` flag `emojiOnly` feeds skips the whole
    // rounded/padded/filled block. Read as a computed colour, so it fails the moment
    // `emojiOnly` stops reaching `bare` — a class-name assertion would not, since the
    // classes are composed conditionally and a stale one would still read as present.
    const bubbleFill = (bubble: Locator) =>
      bubble.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    // The message with words in it has a real colour behind it.
    const inlineFill = await bubbleFill(inline);
    expect(inlineFill).not.toBe("transparent");
    expect(inlineFill).not.toMatch(/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/);
    // The emoji-only one has nothing behind it at all.
    const aloneFill = await bubbleFill(alone);
    expect(aloneFill === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(aloneFill)).toBe(
      true,
    );

    // If BOTH heights come back equal, suspect the server before the code: a web server
    // another run left listening is adopted by `reuseExistingServer`, and its SSR handler
    // still holds the module graph it imported — which may predate this rule entirely. That
    // has already been misread as a code fault twice. Check what is serving the web port
    // (see § Automation safety on checking the port) before looking here.
  });

  test("the reaction row offers the pack's art, and the chip that lands is that art", async ({
    page,
  }) => {
    await openEmojiThread(page);

    // A message of our own, so this test's reaction lands nowhere another one looks.
    await page.keyboard.type(`react to me ${Date.now()}`);
    const bubble = await sendAndAwaitEcho(page);

    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    const row = page.locator('[data-testid="menu-reaction-picker"]');
    const option = row.locator('[data-testid="reaction-option-custom-shipit"]');

    // The row draws the PACK's own art. It used to point an `<img>` at
    // `/api/custom-emoji/<name>`, a route no server in this repo serves, so what a reader
    // got was the literal `:shipit:` text inside a 28 px button.
    await expect(option.locator("img")).toHaveAttribute("alt", ":shipit:");
    // Once per picture: `ship` is an alias of `shipit`, and one of six slots spent on a
    // second copy of the same art is a slot wasted.
    await expect(row.locator('[data-testid="reaction-option-custom-ship"]')).toHaveCount(0);
    await option.click();

    // The chip's KEY names the AMS object the art was uploaded to. It used to name the
    // emoji instead (`tlcustom-shipit`), which no reader could resolve — so everybody,
    // the user included, was shown the fallback 👍 while the art was never uploaded at all.
    const chip = bubble.locator('[data-testid^="reaction-chip-tlcustom-"]');
    await expect(chip).toBeVisible();
    expect(await chip.getAttribute("data-testid")).toContain("tlcustom-https://");
    // …and the NAME rides beside the address, after a `#`. That is what lets a colleague's
    // pack hold the emoji they were reacted at rather than only draw it — measured accepted
    // and stored byte for byte by the tenant in examples/custom_emoji_reaction_probe.rs.
    expect(await chip.getAttribute("data-testid")).toContain("#shipit");
    await expect(bubble.locator('[data-testid="reaction-chip-like"]')).toHaveCount(0);

    // And the chip IS art, fetched through the media proxy: proxied bytes reach the DOM as
    // a blob and never as their own URL, so a blob src is the proof that the key's URL went
    // to `loadMedia` rather than into an `<img>` the browser fetched itself.
    const art = chip.locator("img");
    await expect(art).toHaveAttribute("src", /^blob:/);
    await expect(art).not.toHaveAttribute("alt", "👍");

    // The chip hands its own key back, verbatim — no second upload, no re-mint — and the
    // reaction goes. It used to mint a DIFFERENT key here and clear one nobody had set,
    // which left Teams holding the reaction while the local row dropped it.
    await chip.click();
    await expect(bubble.locator('[data-testid^="reaction-chip-tlcustom-"]')).toHaveCount(0);
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
    // Within the band, the pack's own order — which is BY NAME, because that is how the
    // store hands it back (`ORDER BY name ASC`). So the alias `ship` precedes `shipit`.
    await expect(rows.first()).toHaveAttribute("data-testid", "emoji-suggestion-ship");

    // Enter takes the active row, and what lands in the composer is the CHIP, not the code.
    // The chip carries the name of the row that was PICKED — `ship` — while the body it
    // serializes to holds the alias target `:shipit:`, which is the backend's business.
    await page.keyboard.press("Enter");
    await expect(packArt(page, "ship")).toBeVisible();
    await expect(field).not.toContainText(":ship");

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
  });

  test("a lone : offers the pack, in order, and Tab takes a row from it", async ({ page }) => {
    const field = await openEmojiThread(page);

    // Nothing typed after the colon. Somebody who has just added their first emoji does
    // not know its name yet, so the colon alone has to answer "what do I have?".
    await page.keyboard.type(":");
    const list = page.locator('[data-testid="emoji-suggestions"]');
    await expect(list).toBeVisible();

    const rows = list.locator('[role="option"]');
    // The mock seeds three emoji, and every row is one of them: a Unicode shortcode
    // matches an empty prefix too, so all 1800 of them would otherwise be the list.
    await expect(rows).toHaveCount(3);
    await expect(list.locator('[data-kind="unicode"]')).toHaveCount(0);
    // Sorted BY NAME, which is how the store hands the pack back (`ORDER BY name ASC`) and
    // how `emojiSuggestions` sorts it whatever the backend gave: partyparrot, ship, shipit.
    const names = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")),
    );
    expect(names).toEqual([
      "emoji-suggestion-partyparrot",
      "emoji-suggestion-ship",
      "emoji-suggestion-shipit",
    ]);

    // TAB picks here, and Enter does not — see the test below for why.
    await page.keyboard.press("Tab");
    await expect(packArt(page, "partyparrot")).toBeVisible();

    // A space after the colon is prose, not a query: "note: " closes the list again.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(": ");
    await expect(list).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(field).toHaveText("");
  });

  test("Enter SENDS a sentence that ends in a colon, rather than picking an emoji", async ({
    page,
  }) => {
    // French writes a space before a colon, so "voici :" is an ordinary sentence with the
    // menu standing open over it. Enter must post the words. One typed letter hands the key
    // back to the list, which is the case the test above covers.
    await openEmojiThread(page);

    await page.keyboard.type("les emojis custom, ça marche comme ça :");
    await expect(page.locator('[data-testid="emoji-suggestions"]')).toBeVisible();

    const sent = await sendAndAwaitEcho(page);
    await expect(sent).toContainText("comme ça :");
    // No art anywhere in it: nothing was picked.
    await expect(sent.locator('img[itemtype="http://schema.skype.com/Emoji"]')).toHaveCount(0);
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

  test("keeping the emoji people send is ON, and the switch is the way back", async ({
    page,
  }) => {
    const section = await openEmojiSettings(page);
    const toggle = section.locator('[data-testid="emoji-auto-import-toggle"]');

    // ON out of the box, like the backend's own default: a colleague's emoji that has to
    // be picked out of a menu one at a time is a pack nobody fills. A switch drawn `off`
    // for the moment before the settings land would say the opposite of what is happening.
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(section).toContainText("theirs arrives as :name-2:");

    // The one thing the switch is for: the pack decides what `:shipit:` posts under the
    // user's own name, so they get to say whether their threads may fill it.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // Off, the manual row in a message's own menu is what is left, and the copy says so.
    await expect(section).toContainText("Add to my emoji");
    await expect(section.locator('[data-testid="emoji-auto-import-error"]')).toHaveCount(0);

    // Back on, because one mock process serves the whole run and this is shared state.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
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

  test("a pasted picture too big to be an emoji is shrunk, and the dialog says so", async ({
    page,
  }) => {
    const section = await openEmojiSettings(page);
    await section.locator('[data-testid="add-custom-emoji"]').click();
    const dialog = page.locator('[data-testid="add-emoji-dialog"]');
    await expect(dialog).toBeVisible();

    await pasteEmojiImage(page, 900, 600);

    // This picture used to be REFUSED — 900 px is over the 512 px cap. It is redrawn at
    // Slack's own emoji size instead, with the shape kept: 900x600 is 3:2, so the long
    // side lands on 128 and the short one follows.
    await expect(dialog.locator('[data-testid="add-emoji-shrunk"]')).toHaveText(
      "Shrunk from 900×600 to 128×85 to fit.",
    );
    await expect(dialog.locator('[data-testid="add-emoji-error"]')).toHaveCount(0);

    await dialog.locator('[data-testid="add-emoji-name"]').fill("bigpaste");
    await dialog.locator('[data-testid="add-emoji-save"]').click();
    await expect(dialog).toHaveCount(0);

    // What reached the STORE is the shrunk art rather than what was pasted. The row draws
    // the pack's own bytes, so the picture's intrinsic width is what says which one it is —
    // and the backend measures the same bytes itself, so a save that went through is a
    // picture inside both caps.
    const art = section.locator('[data-testid="custom-emoji-row-bigpaste"] img');
    await expect(art).toBeVisible();
    await expect
      .poll(() => art.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(128);
  });
});
