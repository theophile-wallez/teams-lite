import {
  test,
  expect,
  emitReaction,
  fetchCapturedSends,
  gotoApp,
  openConversationNamed,
  sendFromComposer,
} from "./helpers";
import {
  SEAL_COMPOSER_HINT,
  SEAL_FORGET_WARNING,
  SEAL_MISMATCH_HINT,
  SEAL_SHARING_NOTE,
  SEAL_STORAGE_NOTE,
} from "../src/lib/seal";
import type { Locator, Page } from "@playwright/test";

/**
 * A SEALED chat: the words of every message this app posts are encrypted before they reach
 * Teams (see AGENTS.md § A SEALED chat).
 *
 * What these specs are really about is that **the page holds no crypto at all**. The backend is
 * the encryption boundary, so everything on this side is a reading of two things it is told —
 * `seal` on each message, and `seal_status` for the conversations — and the only secret that
 * ever crosses the socket is a passphrase the reader asked to SEE. So nothing below asserts on
 * a ciphertext, a key or a derivation: it asserts on what the reader is shown, and on the one
 * thing a browser can prove that a unit test cannot — that the rows really open and really lock
 * back up when a passphrase arrives and goes.
 *
 * Two threads, and the split is deliberate:
 *
 *  - **"Sealed Chat"** is the mock's own fixture (`seedSealedThread`), which carries all FOUR
 *    message states at once — ordinary, opened, damaged, and locked under a passphrase this
 *    machine does not hold. That last one is what makes the mismatch reachable with no write at
 *    all, and it is why the fixture can never show the PLAIN composer hint: the disagreement is
 *    permanent there.
 *  - **"Plain Text"** is an ordinary chat the specs seal themselves, which is the flow a reader
 *    really walks — and the only place the first passphrase, the generated one and the plain
 *    hint exist. Nothing is ever SENT into it, so it gains no row.
 *
 * `afterEach` calls the `{kind:"seal"}` reset. One mock process serves the whole run, so a chat
 * left sealed would change what every later spec's composer says about the message it is about
 * to send — and a message sent into the fixture is a row every later spec would count.
 *
 * **TWO TESTS HERE ARE RED, and deliberately so: the COMPOSER half of this feature is not
 * built.** `SEAL_COMPOSER_HINT` and `SEAL_MISMATCH_HINT` are decided in `lib/seal.ts`, argued in
 * AGENTS.md § A SEALED chat as rules the app holds, and drawn by nothing —
 * `web/src/components/composer.tsx` never reads `sealIsOn` or `sealKeyDisagrees`. They are the
 * two named here, and both are load-bearing rather than cosmetic:
 *
 *   - "the COMPOSER says the words are encrypted and a picture is NOT" — a picture is uploaded
 *     to Microsoft's object store unsealed and is deliberately allowed, so a chat that looked
 *     sealed while carrying a readable screenshot is a lie the composer is the only surface
 *     placed to correct;
 *   - "the COMPOSER carries the mismatch while the thread disagrees with this machine" — the one
 *     warning NO press reaches, for the reader who was given the wrong passphrase months ago and
 *     writes today. Without it, two people seal past each other in silence.
 *
 * They are left asserting rather than skipped, because a skipped test is a rule nobody is
 * reminded of. Every other rule the page owns passes.
 */

/** The port the mock is expected on — mirrors `playwright.config.ts`. */
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "19457";

/** The passphrase the mock holds for its sealed fixture (`MOCK_SEAL_PASSPHRASE`). Spelled here
 *  rather than imported: `web/mock/server.ts` starts a server on import. */
const HELD = "hq7m-tvbe-2xkr-9pfd-swn4";
/** The one the COLLEAGUE rotated to, which the mock deliberately never stores
 *  (`MOCK_SEAL_OTHER_PASSPHRASE`). Typing it is what opens the locked row. */
const THEIRS = "kbzq-4wtn-9mrd-3sfv-hp6e";
/** A third passphrase, held by nobody, so it opens nothing the fixture already carries — which
 *  is the whole of the mismatch this feature exists to catch. */
const A_STRANGER = "zzzz-yyyy-xxxx-wwww-vvvv";

/** The words of the two sealed rows of the fixture (`MOCK_SEAL_OPENED_WORDS` /
 *  `MOCK_SEAL_LOCKED_WORDS`), which is how a spec tells "readable" from "withheld" without
 *  trusting the attribute that claims it. */
const OPENED_WORDS = "The invoice numbers are in the sheet I shared";
const LOCKED_WORDS = "I changed the passphrase this morning";

/** The floor every target in this app holds under a thumb, measured with one pixel of slack for
 *  the browser's own sub-pixel rounding. */
const TOUCH_FLOOR_PX = 43;

/** A PHONE with a finger: a narrow viewport AND a coarse pointer.
 *
 *  It is the three fields of Playwright's own Pixel 7 rather than the whole device, because a
 *  device descriptor carries `defaultBrowserType` and that one forces a new worker, which a
 *  describe-level `use` is not allowed to do. The subset is `preview.ts`'s own `PHONE` and for
 *  its reason: this app reads the pointer and the width, and nothing in it reads a UA string. */
const PHONE = { viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true } as const;

function messages(page: Page): Locator {
  return page.locator('[data-testid="message"]');
}

/** The rows of the fixture, by the state each is in rather than by index: the assertions below
 *  are about WHICH state a row is drawn in, so naming them by index would let a reordered
 *  fixture pass a test about the wrong bubble. */
function sealedRow(page: Page, state: "opened" | "locked" | "damaged"): Locator {
  return page.locator(`[data-testid="message"][data-seal="${state}"]`);
}

/** Put every conversation's seal state back the way the mock declares it, and the sealed
 *  fixture back to its seed. */
async function resetSeal(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "seal" },
  });
  expect(res.ok()).toBeTruthy();
}

/** Open the sealed fixture and wait for all four of its rows.
 *
 *  The count is waited on rather than assumed: `openConversationNamed` returns as soon as ONE
 *  bubble is drawn, and a spec that read `data-seal` a frame early would find three rows and
 *  pass on the wrong one. */
async function openSealedChat(page: Page): Promise<void> {
  await gotoApp(page);
  await openConversationNamed(page, "Sealed Chat");
  await expect(messages(page)).toHaveCount(4);
}

/** Open the chat these specs seal themselves, and empty its composer.
 *
 *  The field is cleared for the reason every other spec clears it: the mock persists drafts for
 *  the whole run, so whatever an earlier test left here is still in front of the caret. */
async function openPlainChat(page: Page): Promise<void> {
  await gotoApp(page);
  await openConversationNamed(page, "Plain Text");
  const field = page.locator('[data-testid="composer-rich"] .tiptap-message');
  await field.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(field).toHaveText("");
}

/** Open the seal dialog from the conversation's own menu — the one place a chat is sealed, and
 *  the surface that says who is in the conversation the reader is deciding about. */
async function openSealDialog(page: Page): Promise<Locator> {
  await page.locator('[data-testid="conversation-menu"]').click();
  await page.locator('[data-testid="conversation-seal"]').click();
  const dialog = page.locator('[data-testid="seal-dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Close it, and wait for it to be gone: Radix unmounts the content, which is what drops the
 *  passphrase this dialog was holding — so a spec that reopened too early would read the state
 *  of a dialog that is still on its way out. */
async function closeSealDialog(page: Page): Promise<void> {
  await page.locator('[data-testid="seal-close"]').click();
  await expect(page.locator('[data-testid="seal-dialog"]')).toHaveCount(0);
}

/** The composer's own box, which is where every sentence about the next message is drawn. */
function composerShell(page: Page): Locator {
  return page.locator('[data-testid="composer-shell"]');
}

test.describe("a sealed chat", () => {
  test.afterEach(async ({ page }) => {
    await resetSeal(page);
  });

  test("the FOUR states are four different rows, each saying its own next move", async ({
    page,
  }) => {
    await openSealedChat(page);

    // An ordinary message, from before the chat was sealed: no mark at all. It is the row that
    // makes the padlock mean something — a mark on every bubble would say nothing.
    const ordinary = messages(page).first();
    await expect(ordinary).not.toHaveAttribute("data-seal", /./);
    await expect(ordinary).toContainText("everything here was in the clear");

    // OPENED: sealed, and this machine holds the passphrase, so the words are here.
    await expect(sealedRow(page, "opened")).toHaveCount(1);
    await expect(sealedRow(page, "opened")).toContainText(OPENED_WORDS);

    // The three failures are three SENTENCES, because the reader's next move differs. Collapsing
    // them into "this message cannot be read" is what makes an encrypted chat feel broken.
    const locked = sealedRow(page, "locked");
    await expect(locked.locator('[data-testid="sealed-message"]')).toContainText(
      "Encrypted with a passphrase this app does not have",
    );
    const damaged = sealedRow(page, "damaged");
    await expect(damaged.locator('[data-testid="sealed-message"]')).toContainText(
      "these bytes could not be read",
    );

    // Only the missing passphrase has an action, because it is the only one anything mends. No
    // passphrase repairs broken bytes, so offering the row there would be an affordance that
    // could only ever fail.
    await expect(locked.locator('[data-testid="sealed-add-passphrase"]')).toBeVisible();
    await expect(damaged.locator('[data-testid="sealed-add-passphrase"]')).toHaveCount(0);

    // A withheld row keeps NONE of the words, and the locked one's `content` is empty on the
    // wire — so this is also the assertion that no ciphertext was drawn in their place.
    await expect(locked).not.toContainText(LOCKED_WORDS);
    await expect(locked).not.toContainText(/[A-Za-z0-9_-]{40,}/);

    // And neither is blamed on this client. A locked body is EMPTY, so read as an ordinary
    // message it matches every clause of the unsupported test — which would say the app cannot
    // show a payload it understands perfectly.
    await expect(page.locator('[data-testid="message"][data-unsupported="true"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Unsupported message");
  });

  test("the PADLOCK marks what went through the seal, and only that", async ({ page }) => {
    await openSealedChat(page);

    // It is drawn per MESSAGE rather than once above the thread, which is the opposite of the
    // rule the time mark follows — because a sealed chat holds both kinds of row at once, and
    // which of the two a row is, is exactly the reader's question.
    await expect(page.locator('[data-testid="seal-mark"]')).toHaveCount(1);
    await expect(sealedRow(page, "opened").locator('[data-testid="seal-mark"]')).toBeVisible();
    await expect(messages(page).first().locator('[data-testid="seal-mark"]')).toHaveCount(0);

    // It says what it means to a pointer and to a screen reader alike: a bare glyph beside
    // somebody's words is a mark nobody can look up.
    await expect(sealedRow(page, "opened").locator('[data-testid="seal-mark"]')).toHaveAttribute(
      "aria-label",
      /encrypted before it reached teams/i,
    );

    // A withheld row draws no padlock of its own beside the sentence — the sentence IS the
    // statement, and the mark would claim the message reached the reader.
    await expect(sealedRow(page, "locked").locator('[data-testid="seal-mark"]')).toHaveCount(0);
  });

  test("a LOCKED row is inert: no actions, and no reaction chip", async ({ page }) => {
    await openSealedChat(page);
    const locked = sealedRow(page, "locked");
    const opened = sealedRow(page, "opened");

    // Reply, edit, copy, delete and the quick reactions all live in the one menu, so its
    // absence is the whole rule: every one of those acts on a body, and this row has none here.
    await locked.hover();
    await expect(locked.locator('[data-testid="message-actions"]')).toHaveCount(0);
    // The control, so the assertion above is not passing on a thread whose menus never render.
    await opened.hover();
    await expect(opened.locator('[data-testid="message-actions"]')).toBeVisible();

    // A chip is a control that toggles a reaction on the message under it, and this row is a
    // statement about a body that is not here — so one already on it is not drawn either. The
    // colleague's reaction is real (the mock re-broadcasts the message), which is why it is
    // taken off again below rather than left for the next spec: the seal reset does not undo it.
    const lockedId = await locked.getAttribute("data-message-id");
    const openedId = await opened.getAttribute("data-message-id");
    await emitReaction(page, {
      conversation: "19:sealed-demo@thread.v2",
      message_id: lockedId ?? "",
      key: "like",
    });
    await emitReaction(page, {
      conversation: "19:sealed-demo@thread.v2",
      message_id: openedId ?? "",
      key: "like",
    });
    // The OPENED row draws it, which is what proves the locked one's absence is a decision.
    await expect(opened.locator('[data-testid="reaction-chip-like"]')).toBeVisible();
    await expect(locked.locator('[data-testid="reaction-chip-like"]')).toHaveCount(0);

    await emitReaction(page, {
      conversation: "19:sealed-demo@thread.v2",
      message_id: lockedId ?? "",
      key: "like",
      count: 0,
    });
    await emitReaction(page, {
      conversation: "19:sealed-demo@thread.v2",
      message_id: openedId ?? "",
      key: "like",
      count: 0,
    });
    await expect(opened.locator('[data-testid="reaction-chip-like"]')).toHaveCount(0);
  });

  test("SEALING a chat from the header menu", async ({ page }) => {
    await openPlainChat(page);
    const dialog = await openSealDialog(page);
    // It opens on the state the BACKEND is in, not on one it remembered: no passphrase here yet.
    await expect(dialog).toHaveAttribute("data-seal-state", "new");
    // The two facts the reader decides with are stated BEFORE the press, because handing a
    // passphrase out is the part of this that cannot be taken back.
    await expect(dialog.locator('[data-testid="seal-sharing-note"]')).toContainText(
      SEAL_SHARING_NOTE,
    );
    await expect(dialog.locator('[data-testid="seal-storage-note"]')).toContainText(
      SEAL_STORAGE_NOTE,
    );
    // And the one part of a sealed message that is NOT covered, said at the moment they decide
    // to seal at all.
    await expect(dialog.locator('[data-testid="seal-picture-note"]')).toContainText(
      SEAL_COMPOSER_HINT,
    );

    await dialog.locator('[data-testid="seal-passphrase-field"]').fill(HELD);
    await dialog.locator('[data-testid="seal-apply"]').click();
    // A first passphrase opens nothing it could fail to open, so no warning is earned — the
    // common case, and the one that must never be dressed as a problem.
    await expect(page.locator('[data-testid="seal-mismatch"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="seal-dialog"]')).toHaveCount(0);

    // The menu says where the chat now stands, which is how it is found again — and it is read
    // from the backend's own answer rather than from the press that was just made.
    await page.locator('[data-testid="conversation-menu"]').click();
    await expect(page.locator('[data-testid="conversation-seal"]')).toContainText("Encryption on");
    await page.locator('[data-testid="conversation-menu"]').click();
    // The message the reader is about to write is sealed, and the row they wrote before it is
    // not, so the state is a fact about the CONVERSATION rather than about any message in it.
    await expect(messages(page).first()).not.toHaveAttribute("data-seal", /./);
  });

  test("the COMPOSER says the words are encrypted and a picture is NOT", async ({ page }) => {
    // A picture's bytes are uploaded to Microsoft's own object store, so nothing in this feature
    // can cover them — it is ALLOWED rather than refused, which is the user's own decision, and a
    // message that looked sealed while carrying a readable screenshot would be a lie. So the one
    // place that can say it is the composer, on every message rather than once when the chat was
    // sealed months ago.
    await openPlainChat(page);
    // Nothing about sealing is claimed before the reader asks for it: a page that has not heard
    // from the backend draws NOTHING, because a hopeful padlock would tell the reader their next
    // message is encrypted while it goes out in the clear.
    await expect(composerShell(page)).not.toContainText(SEAL_COMPOSER_HINT);

    const dialog = await openSealDialog(page);
    await dialog.locator('[data-testid="seal-passphrase-field"]').fill(HELD);
    await dialog.locator('[data-testid="seal-apply"]').click();
    await expect(page.locator('[data-testid="seal-dialog"]')).toHaveCount(0);

    await expect(composerShell(page)).toContainText(SEAL_COMPOSER_HINT);
  });

  test("a GENERATED passphrase is shown once, and revealable afterwards", async ({ page }) => {
    await openPlainChat(page);
    const dialog = await openSealDialog(page);

    // The empty field is the app's own offer: a passphrase it makes carries its own entropy and
    // does not lean on what somebody invented.
    await expect(dialog.locator('[data-testid="seal-passphrase-field"]')).toHaveValue("");
    await dialog.locator('[data-testid="seal-apply"]').click();

    // The one time a passphrase crosses the socket is this answer, so the dialog STAYS OPEN:
    // reading it out is the whole of what is left to do.
    const readout = dialog.locator('[data-testid="seal-generated-passphrase"]');
    await expect(dialog.locator('[data-testid="seal-generated"]')).toBeVisible();
    const generated = ((await readout.textContent()) ?? "").trim();
    // Drawn in its own groups, so it survives being read aloud and typed into a phone.
    expect(generated).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){4}$/);
    // The press that would make a SECOND one stands down while the first is on screen: nobody
    // means to rotate the key a moment after being shown it.
    await expect(dialog.locator('[data-testid="seal-apply"]')).toHaveCount(0);
    await expect(dialog.locator('[data-testid="seal-close"]')).toContainText("Done");

    await closeSealDialog(page);

    // NOTHING about one visit survives into the next: a passphrase left in state would be back
    // on screen the next time this control was pressed.
    const again = await openSealDialog(page);
    await expect(again).toHaveAttribute("data-seal-state", "on");
    await expect(again.locator('[data-testid="seal-generated"]')).toHaveCount(0);
    await expect(again).not.toContainText(generated);

    // It is REVEALABLE, which is what lets somebody who joins in March be given something —
    // a passphrase this app could not show again would force a rotation just to share it.
    const row = again.locator('[data-testid="seal-key-row"]');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-seal-key-current", "true");
    await row.locator('[data-testid="seal-reveal"]').click();
    await expect(row.locator('[data-testid="seal-revealed-passphrase"]')).toHaveText(
      new RegExp(generated.replace(/-/g, "\\s*-\\s*")),
    );
    // And it hides again on the same press, because a passphrase left on screen is one anybody
    // walking past the machine reads.
    await row.locator('[data-testid="seal-reveal"]').click();
    await expect(row.locator('[data-testid="seal-revealed-passphrase"]')).toHaveCount(0);
    await closeSealDialog(page);
  });

  test("a passphrase that opens NOTHING already here is reported, at the dialog", async ({
    page,
  }) => {
    await openSealedChat(page);
    const dialog = await openSealDialog(page);
    await expect(dialog).toHaveAttribute("data-seal-state", "on");

    // A third passphrase, held by nobody: `seal_set` reads which keys the thread's own messages
    // carry BEFORE it writes, so the reader is told while they are still in front of the field
    // that mends it — rather than after they have written a message nobody can read.
    await dialog.locator('[data-testid="seal-passphrase-field"]').fill(A_STRANGER);
    await dialog.locator('[data-testid="seal-apply"]').click();

    const mismatch = dialog.locator('[data-testid="seal-mismatch"]');
    await expect(mismatch).toBeVisible();
    await expect(mismatch).toContainText("does not open the messages already here");
    await expect(mismatch).toContainText("Ask whoever wrote them for theirs");
    // The dialog is held open for it: this is the one thing that has to be read before the next
    // message is written.
    await expect(dialog).toBeVisible();
    await closeSealDialog(page);
  });

  test("the COMPOSER carries the mismatch while the thread disagrees with this machine", async ({
    page,
  }) => {
    // The other side of the same failure, and the one NO WRITE REACHES: somebody given the wrong
    // passphrase months ago, writing today. `sealSetMismatch` fires on a press and cannot help
    // them — they press nothing — so this warning is the whole of what stops the sharpest failure
    // this feature has: two people each sealing under their own passphrase, every message each
    // posts unreadable to the other, and neither told.
    //
    // The fixture is already in that state — it seals under one key while a colleague's message
    // in it carries another — so this needs no press at all, which is exactly the point.
    await openSealedChat(page);
    await expect(sealedRow(page, "locked")).toHaveCount(1);
    await expect(composerShell(page)).toContainText(SEAL_MISMATCH_HINT);

    // And it GOES when the disagreement does, rather than sitting there for the rest of the run:
    // adding the colleague's own passphrase is what mends it.
    const dialog = await openSealDialog(page);
    await dialog.locator('[data-testid="seal-passphrase-field"]').fill(THEIRS);
    await dialog.locator('[data-testid="seal-apply"]').click();
    await expect(page.locator('[data-testid="seal-dialog"]')).toHaveCount(0);
    await expect(sealedRow(page, "locked")).toHaveCount(0);

    await expect(composerShell(page)).not.toContainText(SEAL_MISMATCH_HINT);
    // Still sealed, so the ordinary hint stays: the mismatch went, not the encryption.
    await expect(composerShell(page)).toContainText(SEAL_COMPOSER_HINT);
  });

  test("a LOCKED row's own press opens the same dialog, and the passphrase opens the row", async ({
    page,
  }) => {
    await openSealedChat(page);
    // Reached from the bubble rather than the header, because that is where the reader is when
    // they meet the problem — and it is the same dialog, so there is one place a passphrase is
    // added rather than two.
    await sealedRow(page, "locked").locator('[data-testid="sealed-add-passphrase"]').click();
    const dialog = page.locator('[data-testid="seal-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-testid="seal-passphrase-field"]').fill(THEIRS);
    await dialog.locator('[data-testid="seal-apply"]').click();

    // Every message that key sealed is readable at once — the promise the row makes, and the one
    // thing only a browser can prove: the store keeps the ciphertext and decrypts on READ, so
    // there is nothing to migrate when a key arrives.
    await expect(sealedRow(page, "locked")).toHaveCount(0);
    const wasLocked = page.locator('[data-testid="message"]', { hasText: LOCKED_WORDS });
    await expect(wasLocked).toHaveAttribute("data-seal", "opened");
    await expect(wasLocked.locator('[data-testid="seal-mark"]')).toBeVisible();
    await expect(page.locator('[data-testid="sealed-message"]')).toHaveCount(1); // the damaged one
    // Both passphrases are kept, oldest first, and the one just added is current.
    const again = await openSealDialog(page);
    await expect(again.locator('[data-testid="seal-key-row"]')).toHaveCount(2);
    await expect(
      again.locator('[data-testid="seal-key-row"][data-seal-key-current="true"]'),
    ).toHaveCount(1);
    await closeSealDialog(page);
  });

  test("turning sealing OFF keeps every passphrase, so the history stays readable", async ({
    page,
  }) => {
    await openSealedChat(page);
    await expect(sealedRow(page, "opened")).toContainText(OPENED_WORDS);
    const dialog = await openSealDialog(page);

    await dialog.locator('[data-testid="seal-off"]').click();
    // Kept open, and the line above the keys is where the change is said: the reader has just
    // altered what happens to their next message.
    await expect(dialog).toHaveAttribute("data-seal-state", "off");
    await expect(dialog.locator('[data-testid="seal-current"]')).toContainText(
      "New messages here are not encrypted",
    );
    // The key is still there — that is the whole difference from forgetting one.
    await expect(dialog.locator('[data-testid="seal-key-row"]')).toHaveCount(1);
    await closeSealDialog(page);

    // And the messages already in the thread open exactly as they did. What stopped is the
    // sealing of NEW ones, which is why the composer says nothing any more.
    await expect(sealedRow(page, "opened")).toContainText(OPENED_WORDS);
    await expect(sealedRow(page, "opened").locator('[data-testid="seal-mark"]')).toBeVisible();
    await expect(composerShell(page)).not.toContainText(SEAL_COMPOSER_HINT);
    // The menu says which of the three states this is, so it is not mistaken for a chat that
    // was never sealed at all.
    await page.locator('[data-testid="conversation-menu"]').click();
    await expect(page.locator('[data-testid="conversation-seal"]')).toContainText("Encryption off");
    await page.locator('[data-testid="conversation-menu"]').click();
  });

  test("FORGETTING a passphrase asks twice, and locks its messages back up", async ({ page }) => {
    await openSealedChat(page);
    const dialog = await openSealDialog(page);
    const row = dialog.locator('[data-testid="seal-key-row"]');

    // The first press arms nothing but the sentence saying what the second one costs — the one
    // act in this feature that no later click takes back.
    await row.locator('[data-testid="seal-forget"]').click();
    await expect(row.locator('[data-testid="seal-forget-warning"]')).toContainText(
      SEAL_FORGET_WARNING,
    );
    await expect(row.locator('[data-testid="seal-forget-confirm"]')).toBeVisible();

    // And it can be stood down, which is what makes the two presses a question rather than a
    // delay.
    await row.locator('[data-testid="seal-forget-cancel"]').click();
    await expect(row.locator('[data-testid="seal-forget-warning"]')).toHaveCount(0);
    await expect(row).toHaveCount(1);

    await row.locator('[data-testid="seal-forget"]').click();
    await row.locator('[data-testid="seal-forget-confirm"]').click();

    // The passphrase is gone, so the chat holds none — and a chat with no key is not sealed.
    await expect(page.locator('[data-testid="seal-key-row"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="seal-dialog"]')).toHaveAttribute(
      "data-seal-state",
      "new",
    );
    await closeSealDialog(page);

    // What the warning SAID, watched happening: the message this passphrase opened is withheld
    // again, with its words gone, and it names the passphrase it now needs. It is the assertion
    // this whole spec exists for — a unit test can pin the sentence, and only a browser can prove
    // the words really go.
    await expect(sealedRow(page, "opened")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(OPENED_WORDS);
    await expect(sealedRow(page, "locked")).toHaveCount(2);
    // And the chat is offered afresh rather than left claiming a seal no key backs.
    await page.locator('[data-testid="conversation-menu"]').click();
    await expect(page.locator('[data-testid="conversation-seal"]')).toContainText(
      "Encrypt this chat",
    );
    await page.locator('[data-testid="conversation-menu"]').click();
  });

  test("a CHANNEL and NOTES are never offered one", async ({ page }) => {
    // A channel's history is drawn as THREADS, so a sealed post has to answer a different
    // question about where the padlock sits — and the backend refuses it, so a row here would be
    // a control that reports a refusal. Notes has nobody to share a passphrase with.
    await gotoApp(page);
    await openConversationNamed(page, "Notes");
    await page.locator('[data-testid="conversation-menu"]').click();
    await expect(page.locator('[data-testid="agent-mode-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="conversation-seal"]')).toHaveCount(0);
    await page.locator('[data-testid="conversation-menu"]').click();

    await page.locator('[data-testid="tab-channels"]').click();
    await page.locator('[data-testid="channel-row"]').first().click();
    await page.locator('[data-testid="conversation-menu"]').click();
    await expect(page.locator('[data-testid="agent-mode-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="conversation-seal"]')).toHaveCount(0);
    await page.locator('[data-testid="conversation-menu"]').click();
  });

  test("the page adds NO readable word to the body it posts", async ({ page }) => {
    // The body of a sealed message is one opaque token and nothing else: a sentence saying
    // "sealed with teams-lite" would be the one readable part of it, telling the tenant which
    // client the user runs and telling everybody this conversation has something to hide. The
    // page sends PLAINTEXT over the local socket — the backend seals it — so what this pins is
    // that nothing on this side added a notice to it on the way.
    await openSealedChat(page);
    await sendFromComposer(page, "the numbers are in the sheet");

    await expect(messages(page)).toHaveCount(5);
    const sent = (await fetchCapturedSends(page)).at(-1);
    expect(sent?.content_html).toContain("the numbers are in the sheet");
    expect(sent?.content_html).not.toMatch(/encrypt|sealed|passphrase|teams-lite/i);
    // And the row it came back as wears the mark, because it really went through the seal.
    await expect(messages(page).last()).toHaveAttribute("data-seal", "opened");
    await expect(messages(page).last().locator('[data-testid="seal-mark"]')).toBeVisible();
  });

  test("SETTINGS lists the sealed chat, and the push preview hides the words by default", async ({
    page,
  }) => {
    await openSealedChat(page);
    await page.locator('[data-testid="open-settings"]').click();
    const section = page.locator('[data-testid="seal-settings"]');
    await expect(section).toBeVisible();

    // The list belongs here because a conversation has to be FOUND — a colleague who moved
    // teams, a group chat 400 rows down — and the passphrase outlives every one of those.
    const row = section.locator('[data-testid="seal-conversation-row"]');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-conversation-id", "19:sealed-demo@thread.v2");
    await expect(row).toHaveAttribute("data-sealing", "true");
    await expect(row).toContainText("Sealed Chat");
    // The same rows as the dialog's, so "Show" and "Forget" behave identically wherever they
    // are pressed and forgetting asks twice in one place rather than in two.
    await expect(row.locator('[data-testid="seal-key-row"]')).toHaveCount(1);
    await row.locator('[data-testid="seal-reveal"]').click();
    await expect(row.locator('[data-testid="seal-revealed-passphrase"]')).toContainText("hq7m");

    // The user sealed that chat, so a preview of it on a locked screen is the one thing they did
    // not ask for. It still notifies — silence would be worse — with the words withheld. The
    // state is read from `aria-checked`, which is the one a screen reader is given and therefore
    // the one that has to be right; the switch is deliberately not FLIPPED here, because this
    // setting has no test hook to put it back and one mock process serves the whole run.
    const words = section.locator('[data-testid="sealed-push-words-toggle"]');
    await expect(words).toHaveAttribute("aria-checked", "false");
    await expect(section).toContainText("says who wrote, and not what they said");
  });

  test("a machine with no seal at all says NOTHING about sealing", async ({ page }) => {
    // `null` is both "the backend has not answered" and "this build has no seal", and both must
    // draw nothing: a section about encryption on a machine that has none would be a claim about
    // a feature that is not there, and a hopeful padlock would tell the reader their next
    // message is encrypted while it goes out in the clear. The reset leaves no sealed chat but
    // the fixture, so what this checks is the EMPTY list rather than an absent one.
    await gotoApp(page);
    await openConversationNamed(page, "Plain Text");
    await expect(composerShell(page)).not.toContainText(SEAL_COMPOSER_HINT);
    await expect(composerShell(page)).not.toContainText(SEAL_MISMATCH_HINT);
    await expect(page.locator('[data-testid="seal-mark"]')).toHaveCount(0);

    await page.locator('[data-testid="conversation-menu"]').click();
    await expect(page.locator('[data-testid="conversation-seal"]')).toContainText(
      "Encrypt this chat",
    );
    await page.locator('[data-testid="conversation-menu"]').click();
  });

  // A PHONE with a finger, and it has to be a real device rather than a narrow window: every
  // press in this dialog grows to the touch floor behind `@media (pointer: coarse)`, so
  // `setViewportSize` alone captures the DESKTOP sizes in a narrow column and the test would
  // pass on a 36px button. That is not a hypothetical — it is what the first run of this file
  // measured: `seal-apply` came back 36px tall in a 390px window. `test.use` is a describe-level
  // option, which is why this one test has a block of its own.
  test.describe("on a phone", () => {
    test.use(PHONE);

    test("every press in the dialog clears the touch floor", async ({ page }) => {
      // This app is read from a phone, and a passphrase read off a laptop is typed in on one.
      // The field is 16px so iOS does not zoom the page on focus, and every target is 44px — the
      // floor a menu row, a dialog's close and a slider's thumb already hold.
      await openSealedChat(page);
      const dialog = await openSealDialog(page);

      const field = dialog.locator('[data-testid="seal-passphrase-field"]');
      const box = await field.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
      expect(
        Number(await field.evaluate((el) => getComputedStyle(el).fontSize.replace("px", ""))),
      ).toBeGreaterThanOrEqual(16);

      // Every press the dialog can offer at once: seal again, stop sealing, show a passphrase,
      // and forget one. Each is asserted by name, because "the buttons are big enough" over a
      // collection is a test that passes when one of them is not drawn at all.
      for (const id of ["seal-apply", "seal-close", "seal-off", "seal-reveal", "seal-forget"]) {
        const target = dialog.locator(`[data-testid="${id}"]`).first();
        const targetBox = await target.boundingBox();
        expect(targetBox, `${id} is drawn`).not.toBeNull();
        expect(targetBox!.height, `${id} clears the touch floor`).toBeGreaterThanOrEqual(
          TOUCH_FLOOR_PX,
        );
      }

      // And the dialog fits the screen it is drawn on: a passphrase whose Copy button is off the
      // right edge is one nobody can share, which is the whole reason it can be shown again.
      const width = page.viewportSize()!.width;
      const content = await dialog.boundingBox();
      expect(content!.x).toBeGreaterThanOrEqual(-1);
      expect(content!.x + content!.width).toBeLessThanOrEqual(width + 1);

      // The two presses that arm the destructive act are the same size as the rest: this is the
      // one act here nothing takes back, and a 28px "Forget it for good" beside a 44px "Keep it"
      // is a mis-tap that costs a thread's history.
      await dialog.locator('[data-testid="seal-forget"]').first().click();
      for (const id of ["seal-forget-confirm", "seal-forget-cancel"]) {
        const armed = await dialog.locator(`[data-testid="${id}"]`).first().boundingBox();
        expect(armed, `${id} is drawn`).not.toBeNull();
        expect(armed!.height, `${id} clears the touch floor`).toBeGreaterThanOrEqual(
          TOUCH_FLOOR_PX,
        );
      }
      await dialog.locator('[data-testid="seal-forget-cancel"]').first().click();
      await closeSealDialog(page);
    });
  });
});
