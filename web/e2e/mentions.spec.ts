import { test, expect, fetchCapturedSends, gotoApp } from "./helpers";
import type { Page } from "@playwright/test";

/** Open a conversation by name via the command palette — robust to sidebar ordering
 *  and virtualization (the shared mock is mutated by other specs). */
async function openByPalette(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+k");
  const input = page.locator("[cmdk-input]");
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator("[cmdk-input]")).toHaveCount(0);
  await expect(page.locator('[data-testid="conversation-title"]')).toContainText(name);
}

// @mentions in the composer, the Teams way: "@" opens a list of the people this thread
// can mention, a picked person becomes one chip, and Backspace eats that chip one word
// at a time before removing it.
test.describe("@mentions", () => {
  const editable = '[data-testid="composer-rich"] .tiptap-message';
  const suggestions = '[data-testid="mention-suggestions"]';
  const options = '[data-testid="mention-suggestion"]';
  // The row's name only. A row also renders the person's avatar, whose initials are
  // text too, so reading the whole row would give "ATAva Thompson".
  const optionNames = '[data-testid="mention-suggestion-name"]';
  const chip = `${editable} .composer-mention`;

  /** Open the thread, empty the composer and type "@", then wait for the list.
   *
   *  The field is cleared on purpose: one mock process serves the whole run and it
   *  persists drafts, so whatever an earlier spec left in this thread is still there —
   *  and a leftover word in front of the caret is not a mention query. */
  async function openMentionList(page: Page) {
    await gotoApp(page);
    await openByPalette(page, "Mention Demo");
    await page.locator(editable).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(page.locator(editable)).toHaveText("");
    await page.keyboard.type("@");
    await expect(page.locator(suggestions)).toBeVisible();
    return page.locator(editable);
  }

  test("a bare @ offers the people in the thread", async ({ page }) => {
    await openMentionList(page);
    await expect.poll(() => page.locator(options).count()).toBeGreaterThan(0);
    // Never ourselves: a mention of oneself notifies nobody.
    await expect(page.locator(options, { hasText: "You" })).toHaveCount(0);
  });

  test("typing narrows the list, and Enter inserts the person as one chip", async ({ page }) => {
    await openMentionList(page);
    const first = (await page.locator(optionNames).first().textContent()) ?? "";
    await page.keyboard.type(first.slice(0, 3));
    await expect(page.locator(optionNames).first()).toHaveText(first);
    await page.keyboard.press("Enter");
    // The list closes, the typed "@…" is gone, and the person is a chip.
    await expect(page.locator(suggestions)).toHaveCount(0);
    await expect(page.locator(chip)).toHaveText(first);
    await expect(page.locator(editable)).not.toContainText("@");
  });

  test("Escape leaves the @ as plain text", async ({ page }) => {
    await openMentionList(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(suggestions)).toHaveCount(0);
    await expect(page.locator(editable)).toContainText("@");
    await expect(page.locator(chip)).toHaveCount(0);
  });

  test("Backspace shortens the name one word at a time, then removes the mention", async ({
    page,
  }) => {
    await openMentionList(page);
    await page.locator(options).first().click();
    const full = (await page.locator(chip).textContent()) ?? "";
    const words = full.trim().split(/\s+/);
    expect(words.length).toBeGreaterThan(1);

    // Insertion leaves a trailing space, so the first Backspace deletes that space.
    await page.keyboard.press("Backspace");
    await expect(page.locator(chip)).toHaveText(full);

    // From here one keystroke drops one word, and the mention stays a mention.
    for (let kept = words.length - 1; kept >= 1; kept -= 1) {
      await page.keyboard.press("Backspace");
      await expect(page.locator(chip)).toHaveText(words.slice(0, kept).join(" "));
    }
    // The last word gone means the mention itself goes.
    await page.keyboard.press("Backspace");
    await expect(page.locator(chip)).toHaveCount(0);
  });

  test("a sent mention carries who it names, and renders as a mention", async ({ page }) => {
    await openMentionList(page);
    await page.locator(options).first().click();
    const name = (await page.locator(chip).textContent()) ?? "";
    const marker = `at-${Date.now()}`;
    await page.keyboard.type(marker);
    await page.keyboard.press("Enter");

    // The echoed message shows the mention as a mention, not as bare text.
    const echoed = page.locator('[data-testid="message"]', { hasText: marker });
    await expect(echoed).toBeVisible();
    await expect(echoed.first().locator(".mention-chip")).toHaveText(name);

    // And the send itself named the person: the span in the body carries only an
    // index, so this list is what makes Teams notify them.
    const sends = await fetchCapturedSends(page);
    const sent = sends.filter((send) => send.content_html?.includes(marker)).pop();
    expect(sent?.mentions).toHaveLength(1);
    expect(sent?.mentions?.[0]?.display_name).toBe(name);
    expect(sent?.mentions?.[0]?.mri).toMatch(/^8:/);
    expect(sent?.content_html).toContain(`itemid="${sent?.mentions?.[0]?.itemid}"`);
    expect(sent?.content_html).toContain("schema.skype.com/Mention");
  });

  test("a shortened mention sends the short name and still names the person", async ({ page }) => {
    await openMentionList(page);
    await page.locator(options).first().click();
    const full = (await page.locator(chip).textContent()) ?? "";
    const firstWord = full.trim().split(/\s+/)[0]!;
    // Delete the trailing space, then every word after the first.
    const drops = full.trim().split(/\s+/).length;
    for (let i = 0; i < drops; i += 1) await page.keyboard.press("Backspace");
    await expect(page.locator(chip)).toHaveText(firstWord);

    const marker = `short-${Date.now()}`;
    await page.keyboard.type(` ${marker}`);
    await page.keyboard.press("Enter");
    const sends = await fetchCapturedSends(page);
    const sent = sends.filter((send) => send.content_html?.includes(marker)).pop();
    expect(sent?.mentions?.[0]?.display_name).toBe(firstWord);
    expect(sent?.content_html).toContain(`>${firstWord}</span>`);
  });

  test("a name Teams split across spans reads as one chip", async ({ page }) => {
    // Teams sends a full name as one span PER WORD, all naming one MRI, and only
    // tints them in its own client — so the split shows up here as two chips. The
    // seeded message holds both cases: one person over two spans, then two people.
    await gotoApp(page);
    await openByPalette(page, "Mention Demo");
    // The history is virtualized and one mock serves the whole run, so the seeded
    // message sits above whatever the specs before this one sent: scroll up to it.
    const message = page.locator('[data-testid="message"]', { hasText: "ping me" }).first();
    const scroller = page.locator('[data-testid="message-scroll"]');
    await expect
      .poll(
        async () => {
          if ((await message.count()) > 0) return true;
          await scroller.evaluate((el) => {
            el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight);
          });
          await page.waitForTimeout(150);
          return (await message.count()) > 0;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const chips = message.locator(".mention-chip");
    // Four spans, three chips: the name's two words are one, and the two people
    // after them keep one chip each (merging those would leave two chips).
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveText(/Clément\s+BOSLE/);
    // And the merged chip still names the person its first span pointed at.
    const trigger = message.locator('[data-testid="person-hover-trigger"]', {
      has: page.locator(".mention-chip"),
    });
    await expect(trigger.first()).toHaveAttribute("data-person-mri", "8:orgid:clement");
  });

  test("an email address is not a mention", async ({ page }) => {
    await gotoApp(page);
    await openByPalette(page, "Mention Demo");
    await page.locator(editable).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("write to ada@example.com");
    await expect(page.locator(suggestions)).toHaveCount(0);
  });
});
