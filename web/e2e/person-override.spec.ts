import {
  test,
  expect,
  gotoApp,
  clearPersonOverrides,
  emitTyping,
  realErrors,
} from "./helpers";
import type { Page } from "@playwright/test";

/**
 * Renaming somebody, and giving them a face — for this app only.
 *
 * Microsoft Teams holds neither: a colleague's display name and photo belong to them.
 * So both are LOCAL overrides, and what these specs pin is that ONE change reaches
 * every surface at once. That is the whole claim of the feature, and the reason the
 * resolution lives in the backend's own reads rather than at each render site: a rename
 * that showed in the bubble but not in the sidebar would be worse than no rename.
 *
 * They also pin the honesty half. The card that offers the rename keeps saying what
 * Teams calls the person, because a nickname the user cannot see through is one they
 * cannot undo.
 *
 * Every test clears what it set. One mock process serves the whole run, so a rename
 * left behind would rename that person for every later spec — and a spec asserting a
 * fixture's real name would then fail with no visible cause.
 */

const editable = '[data-testid="composer-rich"] .tiptap-message';
const dialog = '[data-testid="person-edit-dialog"]';

/** Open a conversation by name via the command palette — robust to sidebar ordering
 *  and virtualization (the shared mock is mutated by other specs). */
async function openByPalette(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+k");
  const input = page.locator("[cmdk-input]");
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator("[cmdk-input]")).toHaveCount(0);
}

/** The conversation the app itself says is open — its own state, not our assumption. */
async function openConversationId(page: Page): Promise<string> {
  const shell = page.locator('[data-testid="composer-shell"]');
  await expect(shell).toBeVisible();
  return (await shell.getAttribute("data-conversation-id")) ?? "";
}

/** Open the rename dialog from a person's card, given the locator to hover.
 *  Returns the name the card showed and the MRI the card was opened for. */
async function openRenameDialog(
  page: Page,
  trigger = page.locator('[data-testid="person-hover-trigger"]').first(),
): Promise<{ name: string; mri: string }> {
  const mri = (await trigger.getAttribute("data-person-mri")) ?? "";
  await trigger.hover();
  await expect(page.locator('[data-testid="person-card"]')).toBeVisible({ timeout: 10_000 });
  const name = (await page.locator('[data-testid="person-card-name"]').textContent()) ?? "";
  await page.locator('[data-testid="person-card-edit"]').click();
  await expect(page.locator(dialog)).toBeVisible();
  return { name: name.trim(), mri };
}

/** Type a nickname into the open dialog and save it. An empty name is a clear. */
async function saveName(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="person-name-field"]').fill(name);
  await page.locator('[data-testid="person-edit-save"]').click();
  await expect(page.locator(dialog)).toHaveCount(0);
}

test.describe("renaming a person, here only", () => {
  test.afterEach(async ({ page }) => {
    await clearPersonOverrides(page);
  });

  test("one rename reaches the bubble, the mention list and the typing line", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    // A group chat, so sender names are shown above the bubbles at all.
    await openByPalette(page, "Mention Demo");
    const conversation = await openConversationId(page);

    const { name: realName, mri } = await openRenameDialog(page);
    expect(realName).not.toBe("");
    expect(mri).toMatch(/^8:/);

    // The dialog says who this is, so the rename is never made blind.
    await expect(page.locator('[data-testid="person-teams-name"]')).toContainText(realName);

    await saveName(page, "Renamed Person");

    // 1. Every message they ever sent. The store freezes a message's sender at
    //    insert, so this only holds because the name is resolved on the way out.
    await expect(
      page.locator('[data-testid="sender-name"]', { hasText: "Renamed Person" }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="sender-name"]', { hasText: realName })).toHaveCount(0);

    // 2. The @mention list, or the user could not find them by the name they gave.
    await page.locator(editable).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("@Renamed");
    await expect(page.locator('[data-testid="mention-suggestions"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="mention-suggestion-name"]', { hasText: "Renamed Person" }),
    ).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");

    // 3. The typing line, which resolves a name from an MRI and nothing else. It
    //    shows a first name, so the nickname's first word is what lands there.
    await emitTyping(page, { conversation, sender_mri: mri, sender: realName, is_typing: true });
    await expect(page.locator('[data-testid="typing-indicator"]')).toContainText("Renamed");
    await emitTyping(page, { conversation, sender_mri: mri, is_typing: false });

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a renamed 1:1 is retitled, and its card still says who they are", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    // A 1:1's title IS the other person, so renaming them retitles the thread — and
    // the header offers their card for exactly that reason.
    await openByPalette(page, "Ava Thompson");
    const header = page.locator('[data-testid="conversation-title"]');
    await expect(header).toHaveText("Ava Thompson");

    await openRenameDialog(page, header);
    await saveName(page, "Renamed Partner");

    await expect(header).toHaveText("Renamed Partner", { timeout: 10_000 });

    // The card keeps stating the real name, so the user can always tell who this is.
    await header.hover();
    await expect(page.locator('[data-testid="person-card-name"]')).toHaveText("Renamed Partner");
    await expect(page.locator('[data-testid="person-card-renamed-from"]')).toContainText(
      "Ava Thompson",
    );

    // …and every other surface fed by the conversation list moved with it. The palette
    // is asserted rather than the sidebar row because the sidebar is virtualized — a
    // row scrolled out of view is not in the DOM — and both read the same label through
    // `convLabel`, so finding the thread by its new name proves the list itself moved.
    // Last in the test: Escape closes the open thread as well as the palette.
    await page.keyboard.press("Control+k");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();
    await input.fill("Renamed Partner");
    await expect(page.locator("[cmdk-item]", { hasText: "Renamed Partner" }).first()).toBeVisible({
      timeout: 10_000,
    });
    // Searching for who Teams calls them finds nothing: the list holds one name, the
    // one the user chose.
    await input.fill("Ava Thompson");
    await expect(page.locator("[cmdk-item]", { hasText: "Ava Thompson" })).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("clearing the name puts the real one back", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openByPalette(page, "Ava Thompson");
    const header = page.locator('[data-testid="conversation-title"]');
    await expect(header).toHaveText("Ava Thompson");

    await openRenameDialog(page, header);
    await saveName(page, "Temporarily Renamed");
    await expect(header).toHaveText("Temporarily Renamed", { timeout: 10_000 });

    // Re-open and empty the field: an empty name is a clear, not an empty name.
    await openRenameDialog(page, header);
    await saveName(page, "");
    await expect(header).toHaveText("Ava Thompson", { timeout: 10_000 });

    // With nothing overridden, the card stops claiming Teams calls them anything else.
    await header.hover();
    await expect(page.locator('[data-testid="person-card"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="person-card-renamed-from"]')).toHaveCount(0);

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("a custom picture replaces their photo, and can be taken back", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Ava Thompson");
    const header = page.locator('[data-testid="conversation-title"]');
    await expect(header).toHaveText("Ava Thompson");
    await openRenameDialog(page, header);

    // A one-pixel PNG, which is all the store needs and all an `<img>` needs.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.locator('[data-testid="person-avatar-input"]').setInputFiles({
      name: "face.png",
      mimeType: "image/png",
      buffer: png,
    });
    // The preview shows the picked file before it is stored anywhere.
    await expect(page.locator(`${dialog} img`)).toBeVisible();
    await page.locator('[data-testid="person-edit-save"]').click();
    await expect(page.locator(dialog)).toHaveCount(0);

    // The card is served the stored bytes — the avatar cache never evicts on its own,
    // so this only holds because the change drops the entry for that person.
    await header.hover();
    await expect(page.locator('[data-testid="person-card"] img')).toBeVisible({ timeout: 10_000 });

    // Taking it back is offered, and leaves the name alone.
    await openRenameDialog(page, header);
    await page.locator('[data-testid="person-avatar-reset"]').click();
    await page.locator('[data-testid="person-edit-save"]').click();
    await expect(page.locator(dialog)).toHaveCount(0);
    await expect(header).toHaveText("Ava Thompson");

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("Settings lists everybody renamed, and undoes it from there", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Ava Thompson");
    const header = page.locator('[data-testid="conversation-title"]');
    await expect(header).toHaveText("Ava Thompson");

    // Nothing renamed yet: the pane says so rather than showing an empty box.
    await page.locator('[data-testid="open-settings"]').click();
    const section = page.locator('[data-testid="renamed-people-settings"]');
    await expect(section).toBeVisible();
    await expect(page.locator('[data-testid="renamed-people-empty"]')).toBeVisible();

    // Rename from the card, then come back: the list is where a decision made months
    // ago is still reversible, which is the whole reason it exists — a nickname makes
    // the person hard to find by the name Teams had.
    await page.goBack();
    await expect(header).toHaveText("Ava Thompson");
    await openRenameDialog(page, header);
    await saveName(page, "Renamed In Settings");
    await expect(header).toHaveText("Renamed In Settings", { timeout: 10_000 });

    await page.locator('[data-testid="open-settings"]').click();
    const row = page.locator('[data-testid="renamed-person-row"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Renamed In Settings");
    // …and it still says who Teams calls them.
    await expect(row).toContainText("Ava Thompson");

    // Undoing it from here empties the list, without going back to the thread.
    await row.click();
    await expect(page.locator(dialog)).toBeVisible();
    await saveName(page, "");
    await expect(page.locator('[data-testid="renamed-people-empty"]')).toBeVisible({
      timeout: 10_000,
    });

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("the dialog refuses a file that is not one of the four image formats", async ({
    page,
    consoleErrors,
  }) => {
    await gotoApp(page);
    await openByPalette(page, "Ava Thompson");
    await openRenameDialog(page, page.locator('[data-testid="conversation-title"]'));

    // SVG is a document, not a bitmap, and the backend's allowlist leaves it out —
    // so the user is told here rather than by a refusal from the socket.
    await page.locator('[data-testid="person-avatar-input"]').setInputFiles({
      name: "logo.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8"),
    });
    await expect(page.locator('[data-testid="person-edit-error"]')).toContainText(
      "PNG, JPEG, GIF, or WebP",
    );
    // Nothing was picked, so there is nothing to save.
    await expect(page.locator('[data-testid="person-edit-save"]')).toBeDisabled();

    expect(realErrors(consoleErrors)).toEqual([]);
  });
});
