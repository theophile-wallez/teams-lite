import { test, expect, gotoApp, openConversationNamed } from "./helpers";

// A reply's quote is a POINTER to a message, not a copy of it: clicking it takes the
// reader to the message it quotes, and the block itself is clamped to three lines so a
// quoted wall of text cannot bury the reply under it.
//
// Jumpability is a property of the PAYLOAD, not of the UI. Teams composes a reply with
// the quoted message's id — its ms-epoch compose time — in the blockquote's `itemid` and
// again in `itemprop="time"`, so a reply names its target. A FORWARD carries no author,
// no time and no id: the message it holds was said somewhere else, and this app cannot
// know where, so a forward is never offered as a control.
test.describe("a quote goes to what it quotes", () => {
  const QUOTE = '[data-testid="message-quote"]';
  const JUMPABLE = `${QUOTE}[data-quote-jumpable="true"]`;

  test("clicking a reply's quote scrolls to the quoted message and highlights it", async ({
    page,
  }) => {
    await gotoApp(page);
    // Named, not indexed: one mock process serves the whole run, so an earlier spec's
    // send has already moved the sidebar rows. "Mention Demo" seeds a reply that quotes
    // the message two rows above it.
    await openConversationNamed(page, "Mention Demo");

    const quote = page.locator(JUMPABLE).first();
    await expect(quote).toBeVisible();
    // The words the quote holds identify the message it points at, so the jump can be
    // checked against them rather than against an id the mock is free to renumber.
    const quoted = ((await quote.textContent()) ?? "").trim();
    expect(quoted).not.toEqual("");

    await quote.click();

    // Read the id in one shot: the highlight is a brief pulse (1.6 s), so waiting for
    // the element and then querying it separately can miss it as it fades.
    const targetId = await page
      .waitForFunction(() => {
        const node = document.querySelector('[data-message-id][data-highlighted="true"]');
        return node ? node.getAttribute("data-message-id") : null;
      })
      .then((handle) => handle.jsonValue());
    expect(targetId).toBeTruthy();

    const target = page.locator(`[data-message-id="${targetId}"]`);
    await expect(target).toBeInViewport();
    // The RIGHT message, not merely some message: the quote's own words are in it.
    // Compared on a slice, because the quote holds a shortened preview of the body.
    await expect(target).toContainText(quoted.slice(0, 20));
  });

  test("the keyboard reaches the jump, because the block is a control", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Mention Demo");

    const quote = page.locator(JUMPABLE).first();
    await expect(quote).toBeVisible();
    await expect(quote).toHaveAttribute("aria-label", "Go to the quoted message");
    await quote.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator('[data-message-id][data-highlighted="true"]')).toHaveCount(1);
  });

  test("a forward offers no jump, because its payload names nothing to go to", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Forwarded Messages");

    // The blocks are there and labelled — they are just not controls.
    await expect(page.locator(QUOTE).first()).toBeVisible();
    await expect(page.locator('[data-testid="quote-forwarded"]').first()).toBeVisible();
    await expect(page.locator(JUMPABLE)).toHaveCount(0);
  });

  test("a quoted body is clamped to three lines", async ({ page }) => {
    await gotoApp(page);
    await openConversationNamed(page, "Mention Demo");

    const quote = page.locator(JUMPABLE).first();
    await expect(quote).toBeVisible();
    // The clamp is CSS only: the whole quoted text stays in the DOM, so copying it and
    // find-in-page still see all of it, and the jump is how a reader gets the rest.
    // Read the computed style, because the class name alone proves no rule was applied.
    const clamp = await quote.evaluate((node) => {
      const held = node.querySelector<HTMLElement>(".line-clamp-3");
      if (!held) return null;
      const style = getComputedStyle(held);
      return { lines: style.webkitLineClamp, overflow: style.overflow, text: held.textContent };
    });
    expect(clamp?.lines).toEqual("3");
    expect(clamp?.overflow).toEqual("hidden");
    expect(clamp?.text ?? "").not.toEqual("");
  });
});
