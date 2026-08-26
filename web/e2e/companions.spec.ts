import { test, expect, gotoApp, openConversationNamed } from "./helpers";

// Settings › Companions: whether THIS BROWSER draws the little creature a conversation keeps.
//
// The switch is a per-browser preference with no backend half at all (src/lib/pet-visibility.ts),
// so what needs a browser to check is exactly the half a unit test cannot reach: that the value
// really lands in `localStorage` and is really read back — the write is `petsShownValue`'s and the
// read is `coercePetsShown`'s, two functions in two files, and a preference that forgets is worse
// than none. The reload is the whole point of the first test.
//
// Nothing is reset afterwards: Playwright gives each test its own context, so this browser's
// storage never reaches another spec.
test.describe("Settings › Companions", () => {
  const openCompanions = async (page: Parameters<typeof gotoApp>[0]) => {
    await page.locator('[data-testid="open-settings"]').click();
    const section = page.locator('[data-testid="companions-settings"]');
    await expect(section).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    return section;
  };

  test("is on in a fresh browser, and an off survives a reload", async ({ page }) => {
    await gotoApp(page);
    const toggle = (await openCompanions(page)).getByTestId("companions-toggle");

    // A fresh browser has no entry, which reads as DEFAULT_PETS_SHOWN: the creatures are drawn
    // out of the box, because a feature nothing draws until a setting is found is one nobody has.
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // HIDING IS NOT DESPAWNING, and the row says so where the reader has just acted.
    await expect(page.getByTestId("companions-settings")).toContainText(
      "still in the thread and your colleagues still see it",
    );

    // The half no unit test can reach: through real storage, and back out of it on a page that
    // was built from nothing. A writer that spelled its own value would pass every unit test
    // and reset the preference right here.
    await page.reload();
    await gotoApp(page);
    await expect((await openCompanions(page)).getByTestId("companions-toggle")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("is drawn in a conversation with no pet", async ({ page }) => {
    await gotoApp(page);
    // Pet Corner is the thread the creatures live in, and it holds none until somebody spawns
    // one — so this is the state the rule is about: Settings is where a reader goes to turn a
    // thing off before they have ever met it, so the section carries no condition and no empty
    // state. (Task 6's overlay must keep that true: nothing it draws belongs in this section.)
    await openConversationNamed(page, "Pet Corner");

    const section = await openCompanions(page);
    await expect(section.getByTestId("companions-toggle")).toBeVisible();
    // And the scope is stated BEFORE the press, not only in the off state: this is the one fact
    // a reader decides with, and it is on screen while the switch is still on.
    await expect(section).toContainText("never takes a pet away from the thread");
  });
});
