// The word-effect easter egg in a real browser, where the real IntersectionObserver
// and the real CSS decide what happens.
//
// The unit tests pin the budget (src/lib/word-effect-motion.test.ts) against a stub
// observer, so they cannot see the two things that only a browser can answer: whether
// a word on screen is granted its motion at all, and whether the CSS still staggers
// the letters. A message with a hundred nicknames used to run twelve hundred
// animations and drop the app to 8 fps, so both halves are worth holding down.
import { test, expect, gotoApp, openConversationAt, emitLive } from "./helpers";
import { MAX_MOVING_WORDS } from "../src/lib/word-effect-motion";

const words = '[data-testid="message"] .effect-word';
const movingWords = `${words}[data-motion="on"]`;

test.describe("word effects", () => {
  test("a nickname on screen animates", async ({ page }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);
    await emitLive(page, { conversation: openId, content: "hello bébou", is_self: false });

    const word = page.locator(words, { hasText: "bébou" }).last();
    await expect(word).toBeVisible();
    await expect(word).toHaveAttribute("data-motion", "on");
    // Every letter is a span of its own, carrying its place in the ramp.
    await expect(word.locator(".effect-word-letter")).toHaveCount(5);
  });

  test("the letters animate on a stagger, one delay per animation", async ({ page }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);
    await emitLive(page, { conversation: openId, content: "hello bébou", is_self: false });

    const word = page.locator(movingWords, { hasText: "bébou" }).last();
    await expect(word).toBeVisible();
    const delays = await word.locator(".effect-word-letter").evaluateAll((letters) =>
      letters.map((letter) => getComputedStyle(letter).animationDelay),
    );
    // 90ms apart, and the same delay on both of the letter's animations — the
    // `animation` shorthand in a more specific rule silently resets this to zero.
    expect(delays).toEqual(["0s", "0.09s", "0.18s", "0.27s", "0.36s"]);
  });

  test("the corner glyphs keep their own phase", async ({ page }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);
    await emitLive(page, { conversation: openId, content: "bébou, baby-foot?", is_self: false });

    // Each pair of glyphs is deliberately out of phase, so the two never read as
    // one animation played twice — a phase the gating must not have eaten.
    const sparkle = page.locator(movingWords, { hasText: "bébou" }).last();
    await expect(sparkle).toBeVisible();
    expect(
      await sparkle.evaluate((word) => [
        getComputedStyle(word, "::before").animationDelay,
        getComputedStyle(word, "::after").animationDelay,
      ]),
    ).toEqual(["0s", "1.4s"]);

    const football = page.locator(movingWords, { hasText: "baby-foot" }).last();
    await expect(football).toBeVisible();
    expect(
      await football.evaluate((word) => [
        getComputedStyle(word, "::after").animationDirection,
        getComputedStyle(word, "::after").animationDelay,
      ]),
    ).toEqual(["reverse", "-1.8s"]);
  });

  test("a message full of nicknames decorates all of them and animates a few", async ({ page }) => {
    await gotoApp(page);
    const openId = await openConversationAt(page, 0);
    // A marker of its own, because the mock keeps what the earlier tests emitted.
    const marker = `flood-${Date.now()}`;
    const content = [marker, ...Array.from({ length: 100 }, () => "bebou")].join(" ");
    await emitLive(page, { conversation: openId, content, is_self: false });

    const bubble = page.locator('[data-testid="message"]', { hasText: marker }).last();
    await expect(bubble.locator(".effect-word")).toHaveCount(100);
    // Bring the whole bubble into view, so every one of its words is on screen and
    // asks for a slot — with the bubble half below the fold only the words in the
    // visible lines do, which is the budget working but not what this pins.
    await bubble.scrollIntoViewIfNeeded();
    // The look is on every word; the motion is rationed to the budget, which the
    // whole page shares — so it is the page that must hold to it, not this bubble.
    await expect(page.locator(movingWords)).toHaveCount(MAX_MOVING_WORDS);
    const still = bubble.locator(`.effect-word:not([data-motion="on"])`).last();
    await expect(still).toHaveClass(/sparkle-word/);
    const running = await still.locator(".effect-word-letter").first().evaluate((letter) => ({
      animationName: getComputedStyle(letter).animationName,
      // The word without motion keeps its color from the ramp.
      color: getComputedStyle(letter).color,
    }));
    expect(running.animationName).toBe("none");
    expect(running.color).not.toBe("rgb(0, 0, 0)");
  });
});
