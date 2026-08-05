import type { Locator, Page } from "@playwright/test";
import {
  test,
  expect,
  composerField,
  fillComposer,
  gotoApp,
  openCalendarTab,
  openConversationAt,
  realErrors,
  setTaskControl,
} from "./helpers";

// The task list: what the user was asked to do, beside the thread they were asked in
// (web/src/components/tasks-panel.tsx, over web/src/lib/tasks.ts).
//
// Everything here is LOCAL — a task reaches nobody, the scan reads messages and mail this
// app has already stored — so what this spec pins is not a consent gate but the four things
// a local surface still gets wrong: the way in (a button and a bare key, and the key must
// stay out of everything that is writing), the two decisions on a suggestion, the jump back
// to where the ask was made, and the layout claim the wide shape rests on — that opening the
// panel NARROWS the message pane instead of covering it.
//
// Every write is deliberately non-optimistic: the row repaints only once the backend has
// answered (see `saveTask` in lib/store.ts). So every assertion below is on the state the row
// itself reports (`data-task-state`) and the section it landed in — never on a beat waited
// out. A write that never landed times out here instead of passing.
//
// The mock serves the four RPCs and simulates a scan with no CLI and no tenant, which is what
// makes the whole surface reviewable (`web/mock/server.ts`). It is ONE process for the whole
// run, so every test that arms it or writes through it puts the list back in `afterEach`.

/** The panel itself. */
function panel(page: Page) {
  return page.locator('[data-testid="tasks-panel"]');
}

/** One section of the panel, by the key it states. */
function section(page: Page, key: "suggested" | "today" | "open" | "done") {
  return page.locator(`[data-testid="tasks-section"][data-section="${key}"]`);
}

/** A row by the id it carries, wherever it currently sits. */
function taskRow(page: Page, id: string) {
  return page.locator(`[data-testid="task-row"][data-task-id="${id}"]`);
}

/** Open the panel through its own control and wait for the list to have really been read.
 *  Through the button rather than the key, because it is the one way in a phone has. */
async function openTasksPanel(page: Page): Promise<void> {
  await page.locator('[data-testid="tasks-toggle"]').click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => page.locator('[data-testid="task-row"]').count()).toBeGreaterThan(0);
}

/**
 * The opacity a reader really sees: every ancestor's multiplied in.
 *
 * `opacity` is not inherited, so a button inside a transparent row computes its own `1` while
 * nobody can see it — and a hover reveal is written on the ROW (`opacity-0
 * group-hover:opacity-100`), never on the control. Asserting the element's own value therefore
 * passes for exactly the regression the phone case exists to catch; measured that, with the
 * reveal added on purpose. Playwright counts a transparent element as visible too, so neither
 * `toBeVisible` nor `toHaveCSS` covers this on its own.
 */
async function paintedOpacity(target: Locator): Promise<number> {
  return target.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity || "1");
    }
    return opacity;
  });
}

/** The box of a locator, which the layout cases compare across an interaction. */
async function box(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const measured = await target.boundingBox();
  expect(measured).not.toBeNull();
  return measured!;
}

test.describe("the task panel", () => {
  // One mock process serves the whole run, so a suggestion accepted, a task ticked off or a
  // scan's two extra rows would be there for every later spec. Put the list back whatever
  // the test did — including when it failed halfway through.
  test.afterEach(async ({ page }) => {
    await setTaskControl(page, { reset: true });
  });

  // ---- the way in ---------------------------------------------------------------------

  test("is closed on load and opens from its own control", async ({ page, consoleErrors }) => {
    await gotoApp(page);

    // Closed, and NOT MOUNTED: the panel is the only thing in this app that reads the task
    // list, so a panel that existed off-screen would make every page fetch tasks.
    await expect(panel(page)).toHaveCount(0);
    const toggle = page.locator('[data-testid="tasks-toggle"]');
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await openTasksPanel(page);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // The scan is offered from inside the panel, never from the sidebar: it is the panel's
    // own action and its report belongs beside it.
    await expect(panel(page).locator('[data-testid="tasks-scan"]')).toBeVisible();

    expect(realErrors(consoleErrors)).toEqual([]);
  });

  test("opens from a bare `t`, and closes again from it", async ({ page }) => {
    await gotoApp(page);

    // On the LIST, where there is no composer at all. Deliberate: opening a thread focuses
    // its composer a moment later (`focus("end")` in rich-editor.tsx), so a key pressed
    // straight after opening one races that focus — and a `t` that lands in the composer is a
    // letter, which is the case below. The reader's keyboard and the writer's are two things.
    await page.keyboard.press("t");
    await expect(panel(page)).toBeVisible();

    // The same key both ways: it is one toggle, and the button states which way it is up.
    await page.keyboard.press("t");
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="tasks-toggle"]')).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  test("Escape puts the panel away before it leaves the thread", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await openTasksPanel(page);

    // The panel is the thing on top — literally so on a phone, where it covers the
    // conversation — so Escape closes it and stops there. The thread is still open, which is
    // the half that would break if the panel's branch sat below the route one: Escape is also
    // "leave this conversation", and the user would lose both in one press.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="conversation-title"]')).not.toBeEmpty();
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
  });

  test("`t` typed into the composer is a letter, not the panel", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // The composer is a contenteditable rather than a <textarea>, which is the case a guard
    // written against tag names alone misses — and getting it wrong means a `t` in a sentence
    // opening a panel over the thread being written in.
    const field = composerField(page);
    await field.click();
    await page.keyboard.press("t");

    await expect(panel(page)).toHaveCount(0);
    await expect(field).toContainText("t");

    // Leave no draft behind: the store keeps one per conversation, and the sidebar shows it.
    await fillComposer(page, "");
  });

  // ---- the layout claim ---------------------------------------------------------------

  test("narrows the message pane instead of covering it", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    // Measured across the interaction, the way update.spec.ts measures its own button: the
    // panel is a flex sibling of the pane rather than an overlay, and the only proof of that
    // is where the pane ends up.
    const pane = page.locator('[data-testid="message-pane"]');
    const before = await box(pane);

    await openTasksPanel(page);

    const after = await box(pane);
    // The pane's own LEFT EDGE has not moved: it was not pushed off screen, and nothing was
    // laid over it.
    expect(after.x).toBeCloseTo(before.x, 0);
    // It gave up width to the panel, and what is left is still a conversation — the whole
    // point of the wide shape is being read beside a thread.
    expect(after.width).toBeLessThan(before.width - 100);
    expect(after.width).toBeGreaterThan(200);
    // And the panel begins where the pane ends, rather than on top of it.
    const aside = await box(panel(page));
    expect(aside.x).toBeGreaterThanOrEqual(after.x + after.width - 2);
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
  });

  // The breakpoint is 64rem, and it is spelled TWICE — `WIDE_QUERY` in tasks-panel.tsx and
  // the `lg:` prefixes on the aside's own classes — with nothing but ten lines of proximity
  // holding the two together. A mismatch is invisible until a tap opens a thread behind a
  // sheet that covers it, so both sides of the number are pinned here.
  test("is a side column at 64rem and a full-screen sheet below it", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);
    await openTasksPanel(page);

    // At the breakpoint exactly: a column beside a thread that is still on screen.
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect
      .poll(async () => (await box(panel(page))).x)
      .toBeGreaterThan(0);
    const column = await box(panel(page));
    expect(column.width).toBeLessThan(1024 / 2);
    const pane = await box(page.locator('[data-testid="message-pane"]'));
    expect(pane.width).toBeGreaterThan(100);
    await expect(page.locator('[data-testid="message"]').first()).toBeVisible();

    // A pixel under it: the sheet, covering the screen. 1023px is a two-column app that
    // cannot hold a thread beside a 22rem panel, which is the arithmetic behind `lg`.
    await page.setViewportSize({ width: 1023, height: 800 });
    await expect
      .poll(async () => (await box(panel(page))).width)
      .toBeGreaterThanOrEqual(1023);
    const sheet = await box(panel(page));
    expect(sheet.x).toBeCloseTo(0, 0);
    expect(sheet.height).toBeCloseTo(800, 0);
  });

  // ---- what the panel holds ------------------------------------------------------------

  test("renders its sections in the order suggested, today, open, done", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    // In DOM order, which is reading order: a decision to make first, then the day, then the
    // rest, then what is already behind them. Polled rather than read once: the rows are up by
    // the time `openTasksPanel` returns, and this must not quietly depend on that.
    await expect
      .poll(() =>
        page
          .locator('[data-testid="tasks-section"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section"))),
      )
      .toEqual(["suggested", "today", "open", "done"]);
  });

  test("Accept moves a suggestion into Open", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    const suggestion = section(page, "suggested").locator('[data-testid="task-row"]').first();
    const id = (await suggestion.getAttribute("data-task-id")) ?? "";
    expect(id).not.toBe("");
    // A suggestion is a decision rather than a task yet, so it carries the two buttons and
    // no checkbox: ticking off something nobody agreed to is a list that fills itself.
    await expect(suggestion.locator('[data-testid="task-check"]')).toHaveCount(0);
    await suggestion.locator('[data-testid="task-accept"]').click();

    // The row the BACKEND answered with, in the section that state belongs to — never an
    // optimistic repaint. This suggestion is undated, so Open is where it lands.
    await expect(taskRow(page, id)).toHaveAttribute("data-task-state", "open");
    await expect(section(page, "open").locator(`[data-task-id="${id}"]`)).toHaveCount(1);
    await expect(section(page, "suggested").locator(`[data-task-id="${id}"]`)).toHaveCount(0);
    // Accepted, so it is a task the user owns now and can tick off.
    await expect(taskRow(page, id).locator('[data-testid="task-check"]')).toBeVisible();
  });

  test("Dismiss takes the suggestion off the panel entirely", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    const suggestion = section(page, "suggested").locator('[data-testid="task-row"]').first();
    const id = (await suggestion.getAttribute("data-task-id")) ?? "";
    // Named, or the count below would be a count of nothing: `[data-task-id=""]` matches no row
    // whether or not Dismiss did anything at all.
    expect(id).not.toBe("");
    await suggestion.locator('[data-testid="task-dismiss"]').click();

    // `dismissed` is stored rather than deleted — so the same message is never suggested
    // twice — and shown NOWHERE: not in a section of its own, and not as a done task.
    await expect(taskRow(page, id)).toHaveCount(0);
    await expect(page.locator('[data-testid="task-row"][data-task-state="dismissed"]')).toHaveCount(
      0,
    );
    const keys = await page
      .locator('[data-testid="tasks-section"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section")));
    expect(keys).not.toContain("dismissed");
  });

  test("the checkbox moves a task to Done, and unchecking brings it back", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    // An UNDATED open task, so the round trip is a clean there-and-back: a dated one belongs
    // to Today on the way home, which is right and would say nothing about the checkbox.
    const undated = section(page, "open")
      .locator('[data-testid="task-row"]')
      .filter({ hasNot: page.locator('[data-testid="task-due"]') })
      .first();
    const id = (await undated.getAttribute("data-task-id")) ?? "";
    expect(id).not.toBe("");

    await undated.locator('[data-testid="task-check"]').click();
    await expect(taskRow(page, id)).toHaveAttribute("data-task-state", "done");
    await expect(section(page, "done").locator(`[data-task-id="${id}"]`)).toHaveCount(1);
    // The box says what it would do next, which is the only thing that makes it a checkbox.
    const check = taskRow(page, id).locator('[data-testid="task-check"]');
    await expect(check).toHaveAttribute("aria-checked", "true");

    await check.click();
    await expect(taskRow(page, id)).toHaveAttribute("data-task-state", "open");
    await expect(section(page, "open").locator(`[data-task-id="${id}"]`)).toHaveCount(1);
    await expect(taskRow(page, id).locator('[data-testid="task-check"]')).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  // ---- back to where the ask was made -------------------------------------------------

  test("Source opens the thread a task was asked in, and leaves the panel up", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    // Addressed by the href the row itself states, not by a fixture's title: a message task
    // and a mail task are told apart by exactly that, and it is the app's own claim about
    // where it is going.
    const link = panel(page).locator('[data-testid="task-source"][href^="/c/"]').first();
    const href = (await link.getAttribute("href")) ?? "";
    // Anchored on something the panel did NOT supply, or the case is circular: an href checked
    // against an id read out of that same href passes for a well-formed link to the wrong
    // conversation. The first `/c/` row is the seeded suggestion, which was asked in a 1:1 —
    // the `/m/` twin is anchored the same way, on the mail pane really opening.
    expect(href).toContain("1on1");
    await link.click();

    // The conversation named in the href is the one that opened — read from the composer's
    // own state, which is what every driver in this repo trusts over a URL alone.
    const id = decodeURIComponent(href.slice("/c/".length));
    await expect(page.locator('[data-testid="composer-shell"]')).toHaveAttribute(
      "data-conversation-id",
      id,
    );
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).pathname))
      .toBe(decodeURIComponent(href));
    // Wide, the thread appears in the pane BESIDE the panel — the arrangement the panel
    // exists for — so it stays open. Below `lg` it closes, which the phone case pins.
    await expect(panel(page)).toBeVisible();
  });

  test("Source opens the mail a task was asked in", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    const link = panel(page).locator('[data-testid="task-source"][href^="/m/"]').first();
    const href = (await link.getAttribute("href")) ?? "";
    expect(href).not.toBe("");
    await link.click();

    // A mail id is base64-ish and padded, so the router re-encodes it: compare the decoded
    // paths, or this passes and fails on punctuation rather than on the jump.
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).pathname))
      .toBe(decodeURIComponent(href));
    await expect(page.locator('[data-testid="mail-heading"]')).toBeVisible();
  });

  // ---- the scan -----------------------------------------------------------------------

  test("the scan says how many it found", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);
    const before = await page.locator('[data-testid="task-row"]').count();

    const scanButton = panel(page).locator('[data-testid="tasks-scan"]');
    await scanButton.click();
    // The button IS the progress: it says it is working and refuses a second sweep while it
    // is, so nothing else has to be drawn for a run that takes a while.
    await expect(scanButton).toHaveAttribute("data-running", "true");
    await expect(scanButton).toBeDisabled();

    // The count, in the panel that asked for it — and the suggestions it really wrote, which
    // arrive through `tasks_changed` rather than out of the answer, so a page that did not
    // press the button is updated by the same path.
    await expect(panel(page).locator('[data-testid="tasks-scan-found"]')).toContainText(
      "Found 2 tasks to look at.",
    );
    await expect(scanButton).not.toBeDisabled();
    await expect
      .poll(() => page.locator('[data-testid="task-row"]').count())
      .toBe(before + 2);
    await expect(page.locator('[data-testid="tasks-scan-error"]')).toHaveCount(0);
  });

  test("a scan that could not run says so beside the button", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    // The failure the panel's error line exists for. Armed on the mock, which disarms itself
    // on the attempt it refuses, so what the user presses next is a retry that works.
    await setTaskControl(page, { fail_once: true });
    await panel(page).locator('[data-testid="tasks-scan"]').click();

    // INSIDE the panel, beside the control that was pressed — never swallowed into a cue, and
    // never left to the status line, which is eleven truncated pixels at the foot of a sidebar
    // a phone does not show at all.
    const error = panel(page).locator('[data-testid="tasks-scan-error"]');
    await expect(error).toBeVisible();
    // Provider-neutral, like every string in this feature: WHICH CLI reads the messages is
    // the user's own setting, so naming one here would go stale the day they change it.
    await expect(error).toContainText("agent CLI");
    // The status line is on screen and does NOT carry it — asserted in that order, because
    // "does not contain" against an element that is not there is true of nothing.
    const statusBar = page.locator('[data-testid="status-bar"]');
    await expect(statusBar).toBeVisible();
    await expect(statusBar).not.toContainText("agent CLI");
    // A refused scan is not a count, and the two must never be on screen together.
    await expect(panel(page).locator('[data-testid="tasks-scan-found"]')).toHaveCount(0);

    // Under the header the button is in, and WITHIN ONE BUTTON of it: a sentence at the foot of
    // the panel is not beside the control that was pressed, and a band wide enough to allow one
    // would claim less than the paragraph above.
    const errorBox = await box(error);
    const buttonBox = await box(panel(page).locator('[data-testid="tasks-scan"]'));
    const aside = await box(panel(page));
    expect(errorBox.x).toBeGreaterThanOrEqual(aside.x - 1);
    expect(errorBox.y).toBeGreaterThanOrEqual(buttonBox.y);
    expect(errorBox.y - (buttonBox.y + buttonBox.height)).toBeLessThan(buttonBox.height);

    // And the way forward is the same button: a control whose only offer cannot succeed is no
    // way forward at all.
    const scanButton = panel(page).locator('[data-testid="tasks-scan"]');
    await expect(scanButton).not.toBeDisabled();
    await scanButton.click();
    await expect(panel(page).locator('[data-testid="tasks-scan-found"]')).toBeVisible();
    await expect(error).toHaveCount(0);
  });

  // ---- a first read that failed --------------------------------------------------------

  // The one state nobody has ever seen, and the one the panel must not draw as an empty
  // plate: "No tasks yet." is a claim about a list, and a list this page never managed to
  // read is not a list it may make a claim about. It is the same rule that keeps every write
  // non-optimistic — the difference between "nothing" and "we do not know".
  test("reports a first read that failed, rather than an empty plate", async ({ page }) => {
    await gotoApp(page);
    // Armed after the page is up and before the panel is opened: nothing else in this app
    // reads the list, so the panel's own first read is the one that refuses.
    await setTaskControl(page, { read_fails: true });

    await page.locator('[data-testid="tasks-toggle"]').click();
    await expect(panel(page)).toBeVisible();

    await expect(panel(page).locator('[data-testid="tasks-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="tasks-empty"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tasks-section"]')).toHaveCount(0);

    // Reopening is the retry, and it is the only one offered: the read happens when the panel
    // opens, so closing and opening again is what a user does and it has to work.
    await setTaskControl(page, { reset: true });
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await openTasksPanel(page);
    await expect(page.locator('[data-testid="tasks-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tasks-empty"]')).toHaveCount(0);
  });

  // Emptied outright is the OTHER state, and the line is the whole difference: this one the
  // page really does know.
  test("says the plate is empty only once it has read that it is", async ({ page }) => {
    await gotoApp(page);
    await setTaskControl(page, { empty: true });

    await page.locator('[data-testid="tasks-toggle"]').click();
    await expect(panel(page).locator('[data-testid="tasks-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="tasks-error"]')).toHaveCount(0);
  });

  // ---- the bare key, and the layers that own the keyboard -------------------------------

  // `t` is BARE, so anything with the keyboard must swallow it: a menu's own typeahead is
  // letters, and a `t` that reached the app behind one would toggle a panel nobody could see
  // being toggled. Nothing pinned this before — e2e/keyboard.spec.ts drives `j`/`k` with
  // nothing open — and the guard it rests on is one `closest()` selector.
  test("does not fire while a message's own menu owns the keyboard", async ({ page }) => {
    await gotoApp(page);
    await openConversationAt(page, 0);

    const bubble = page.locator('[data-testid="message"]').last();
    await bubble.hover();
    await bubble.locator('[data-testid="message-actions"]').click();
    await expect(page.locator('[data-testid="menu-reaction-picker"]')).toBeVisible();

    await page.keyboard.press("t");
    await expect(panel(page)).toHaveCount(0);

    // Out through the MOUSE, never Escape: Radix preventDefaults the key but lets it
    // propagate, and this app's Escape branch sits above the guard — so Escape here leaves
    // the conversation. e2e/delete-message.spec.ts dismisses this exact menu the same way. An
    // open menu is modal, so it is the only layer taking pointer events and (5, 5) hits
    // nothing.
    await page.mouse.click(5, 5);
    await expect(page.locator('[data-testid="menu-reaction-picker"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");

    // And the key WORKS here — which is what makes the assertion above worth anything. If the
    // guard were gone the press above would have opened the panel, and this one would close
    // it again. The composer is blurred first because it is where this app puts the focus when
    // a thread opens, and a `t` typed there is a letter (the case above says so).
    await composerField(page).blur();
    await page.keyboard.press("t");
    await expect(panel(page)).toBeVisible();
  });

  test("does not fire while the picture lightbox owns the keyboard", async ({ page }) => {
    await gotoApp(page);
    // The Media Gallery by name: the sidebar's order belongs to whatever the rest of the run
    // has sent, and this thread is the one with pictures in it.
    await page.keyboard.press("Control+k");
    const input = page.locator("[cmdk-input]");
    await expect(input).toBeVisible();
    await input.fill("Media Gallery");
    await input.press("Enter");
    await expect(page.locator('[data-testid="conversation-title"]')).toContainText("Media Gallery");

    const thumb = page.locator('[data-testid="message-image"]').first();
    await expect(thumb).toBeVisible();
    await thumb.click();
    // A NATIVE <dialog>, opened with showModal() and carrying no `role` attribute at all —
    // which is exactly why the guard's selector needs the bare `dialog` tag beside the two
    // roles. An attribute selector alone matches nothing here.
    const lightbox = page.locator('dialog[data-testid="image-lightbox"][open]');
    await expect(lightbox).toBeVisible();
    expect(await lightbox.getAttribute("role")).toBeNull();

    await page.keyboard.press("t");
    await expect(panel(page)).toHaveCount(0);

    // The lightbox catches Escape itself and stops it, so we stay in the thread — and the key
    // works again once it is gone, which is what makes the press above a real negative.
    await page.keyboard.press("Escape");
    await expect(lightbox).toHaveCount(0);
    await composerField(page).blur();
    await page.keyboard.press("t");
    await expect(panel(page)).toBeVisible();
  });

  // The ONE place the key is documented not to fire (`!onCalendar` in app.tsx): the calendar
  // reads `t` as "today", and two handlers on one key would run both — a jump in the grid and a
  // panel over it, from one press.
  test("does not fire on the Calendar tab, whose own `t` is Today", async ({ page }) => {
    await gotoApp(page);
    // The precondition, proved rather than assumed: the calendar is really the surface on
    // screen, with its events drawn (which is what `openCalendarTab` waits for).
    await openCalendarTab(page);
    await expect(page.locator('[data-testid="calendar-pane"]')).toBeVisible();

    await page.keyboard.press("t");
    await expect(panel(page)).toHaveCount(0);

    // The exception is about the KEY and not about the tab: the button still opens the panel
    // here, which is also what makes the press above a real negative.
    await openTasksPanel(page);
  });
});

// A phone, where the panel IS the screen: a 22rem column on a 390px device is the device.
// This app is used from one, so the shape and every control on a row have to work with no
// hover and no pointer at all.
test.describe("the task panel on a phone", () => {
  // A Pixel 7's screen and its touch screen, spelled out rather than spread from
  // `devices` — a device descriptor names a browser too, and naming one inside a describe
  // forces a new worker, which Playwright refuses. mobile.spec.ts spreads the whole device
  // because that file is a phone from top to bottom; this one is a phone in its last two
  // cases.
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

  test.afterEach(async ({ page }) => {
    await setTaskControl(page, { reset: true });
  });

  test("covers the screen, and its rows are reachable with no hover", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    // A full-screen sheet, over the conversation rather than beside it.
    const viewport = page.viewportSize()!;
    const sheet = await box(panel(page));
    expect(sheet.x).toBeCloseTo(0, 0);
    expect(sheet.y).toBeCloseTo(0, 0);
    expect(sheet.width).toBeCloseTo(viewport.width, 0);
    expect(sheet.height).toBeCloseTo(viewport.height, 0);

    // Nothing on a row hides behind hover — a coarse pointer has none, so an affordance that
    // needed one would be a control this phone does not have. Both decisions are on the row
    // before anything is pointed at it, and a real TAP (the browser's own touch handling, not
    // a dispatched pointer pair, which produces no click at all) carries one out.
    const suggestion = section(page, "suggested").locator('[data-testid="task-row"]').first();
    const id = (await suggestion.getAttribute("data-task-id")) ?? "";
    expect(id).not.toBe("");
    for (const control of ["task-accept", "task-dismiss"]) {
      const button = suggestion.locator(`[data-testid="${control}"]`);
      await expect(button).toBeVisible();
      // PAINTED, not merely visible: a reveal written the usual Tailwind way (`opacity-0
      // group-hover:opacity-100` on the row) leaves both the button's own opacity and
      // `toBeVisible` saying yes while the person holding the phone sees nothing there.
      expect(await paintedOpacity(button)).toBe(1);
    }
    await suggestion.locator('[data-testid="task-accept"]').tap();
    await expect(taskRow(page, id)).toHaveAttribute("data-task-state", "open");
    await expect(taskRow(page, id).locator('[data-testid="task-check"]')).toBeVisible();
  });

  test("is left through its own close button, which is the only way out here", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    // A phone has no Escape and no `t`, and the sheet covers the whole screen — so this button
    // is the ONLY way out of it. A broken one leaves the reader shut inside the panel with
    // their conversations behind it.
    await panel(page).locator('[data-testid="tasks-close"]').tap();

    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="tasks-toggle"]')).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // And what was behind it is back, rather than a blank screen.
    await expect(page.locator('[data-testid="conversation-row"]').first()).toBeVisible();
  });

  test("closes itself when a task's source is followed", async ({ page }) => {
    await gotoApp(page);
    await openTasksPanel(page);

    // Below the breakpoint the panel covers the thread, so a source that left it open would
    // open a conversation behind a sheet — a tap that looks like it did nothing. This is the
    // other side of the number `WIDE_QUERY` and the aside's `lg:` classes both spell.
    const link = panel(page).locator('[data-testid="task-source"][href^="/c/"]').first();
    const href = (await link.getAttribute("href")) ?? "";
    await link.click();

    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-shell"]')).toHaveAttribute(
      "data-conversation-id",
      decodeURIComponent(href.slice("/c/".length)),
    );
  });
});
