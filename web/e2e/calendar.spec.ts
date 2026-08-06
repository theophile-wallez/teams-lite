import type { Locator } from "@playwright/test";
import {
  test,
  expect,
  gotoApp,
  openCalendarTab,
  openCalendarView,
  calendarEvent,
  calendarEvents,
  emitCalendarChange,
  fetchTestCalendar,
  realErrors,
  toggleCalendarSetting,
} from "./helpers";

// The calendar is a fourth first-class sidebar surface next to Chats, Channels and
// Mail, on the same local-first pipeline and the same WebSocket — and strictly
// READ-ONLY.
//
// These specs cover the flow (tab → grid → views → navigation → details → live
// reconciliation) and, just as importantly, the property that makes a calendar safe
// to point at a real account: there is NO affordance that could write. Creating an
// event mails an invitation to every attendee and answering one mails the organizer,
// so the absence of those buttons is a feature under test, not an omission.
test.describe("calendar", () => {
  // The mock is one shared, stateful process and two specs below reschedule and
  // remove events on it. Re-seed after each so the suite is repeatable against a
  // reused mock (`reuseExistingServer` is on outside CI).
  test.afterEach(async ({ page }) => {
    if (page.isClosed()) return;
    await emitCalendarChange(page, { reset: true });
  });

  test("has a Calendar tab that reveals the working week", async ({ page }) => {
    await gotoApp(page);

    await expect(page.locator('[data-testid="tab-calendar"]')).toBeVisible();
    // Lazy: nothing is loaded until the tab is opened.
    await expect(page.locator('[data-testid="calendar-pane"]')).toHaveCount(0);

    await openCalendarTab(page);

    // The working week is the default view: this is a work calendar, so five columns
    // and no weekend.
    await expect(page.locator('[data-testid="calendar-time-grid"]')).toBeVisible();
    const columns = page.locator('[data-testid="calendar-day-column"]');
    await expect(columns).toHaveCount(5);
    expect(await weekdaysOf(columns)).toEqual([1, 2, 3, 4, 5]);

    // And the month grid is still there, one keystroke away, with six full weeks so its
    // height never jumps between months.
    await openCalendarView(page, "month");
    await expect(page.locator('[data-testid="calendar-day"]')).toHaveCount(30);
    await expect(page.locator('[data-testid="calendar-day"][data-today="true"]')).toHaveCount(
      isWeekendToday() ? 0 : 1,
    );
  });

  test("offers no way to create or answer an event", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);

    // The reference design has a "New event" button; this app cannot have one.
    await expect(page.getByRole("button", { name: /new event/i })).toHaveCount(0);
    // Nor any of the invitation responses, which would mail the organizer.
    for (const label of [/^accept$/i, /^decline$/i, /^tentative$/i]) {
      await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }
    // And the surface says what it is, in its own chrome rather than only in a panel
    // the user has to open.
    await expect(page.locator('[data-testid="calendar-read-only"]')).toBeVisible();
    await expect(page.locator('[data-testid="calendar-pane"]')).toContainText(/read-only/i);
  });

  test("shows only the default calendar until another is switched on", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);

    const { calendars } = await fetchTestCalendar(page);
    const primary = calendars.find((c) => c.is_default)!;
    const other = calendars.find((c) => !c.is_default)!;

    const toggle = (id: string) => page.locator(`[data-testid="calendar-toggle"][data-calendar-id="${id}"]`);
    await expect(toggle(primary.id)).toHaveAttribute("aria-checked", "true");
    await expect(toggle(other.id)).toHaveAttribute("aria-checked", "false");

    const before = await calendarEvents(page).count();
    await toggle(other.id).click();
    await expect(toggle(other.id)).toHaveAttribute("aria-checked", "true");
    // More events are drawn once a second calendar is visible.
    await expect
      .poll(() => calendarEvents(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(before);

    // And switching it back off removes them again.
    await toggle(other.id).click();
    await expect
      .poll(() => calendarEvents(page).count(), { timeout: 10_000 })
      .toBe(before);
  });

  test("navigates months and returns to today", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "month");

    const title = page.locator('[data-testid="calendar-title"]');
    const thisMonth = (await title.textContent())!.trim();

    await page.locator('[data-testid="calendar-next"]').click();
    await expect(title).not.toHaveText(thisMonth);
    // Off this month, no cell *of that month* is today. The grid always spills
    // into its neighbours, so the month after one that ends today still shows
    // today as a leading outside cell — and marks it, deliberately.
    await expect(
      page.locator('[data-testid="calendar-day"][data-today="true"]:not([data-outside="true"])'),
    ).toHaveCount(0);

    await page.locator('[data-testid="calendar-prev"]').click();
    await expect(title).toHaveText(thisMonth);

    // Two steps away, then Today brings it straight back.
    await page.locator('[data-testid="calendar-prev"]').click();
    await page.locator('[data-testid="calendar-prev"]').click();
    await expect(title).not.toHaveText(thisMonth);
    await page.locator('[data-testid="calendar-today"]').click();
    await expect(title).toHaveText(thisMonth);
    // Today is back in the grid — unless today IS a weekend, which the default grid
    // does not draw at all.
    await expect(page.locator('[data-testid="calendar-day"][data-today="true"]')).toHaveCount(
      isWeekendToday() ? 0 : 1,
    );
  });

  test("switches between the month, week, day and agenda views", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);

    await openCalendarView(page, "month");
    await expect(page.locator('[data-testid="calendar-month"]')).toBeVisible();

    await openCalendarView(page, "week");
    // Five day columns — the working week, weekends being off by default — and a
    // 24-hour body.
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveCount(5);
    await expect(page.locator('[data-testid="calendar-hours"]')).toBeVisible();

    await openCalendarView(page, "day");
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveCount(1);
    // The "now" line only ever draws on today, which the Day view is showing.
    await expect(page.locator('[data-testid="calendar-now-line"]')).toHaveCount(1);

    await openCalendarView(page, "agenda");
    await expect(page.locator('[data-testid="calendar-agenda"]')).toBeVisible();
    expect(await page.locator('[data-testid="calendar-agenda-day"]').count()).toBeGreaterThan(0);

    await openCalendarView(page, "month");
    await expect(page.locator('[data-testid="calendar-month"]')).toBeVisible();
  });

  test("lays a multi-day event out as one bar, not a chip per day", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);

    await openCalendarView(page, "month");
    const { calendars, events } = await fetchTestCalendar(page);
    const leave = events.find((e) => e.id === "ev-leave")!;
    expect(leave.is_all_day).toBe(true);

    // It lives on the team calendar, so switch that on.
    await page
      .locator(`[data-testid="calendar-toggle"][data-calendar-id="${leave.calendar_id}"]`)
      .click();
    const bar = calendarEvent(page, "ev-leave");
    await expect(bar.first()).toBeVisible();
    // ONE element for the whole run of days (a week row may clip it into at most two).
    expect(await bar.count()).toBeLessThanOrEqual(2);
    // And that element is genuinely wider than a single day cell. Measured on the widest
    // piece: a run clipped by a row boundary leaves a short remainder on one side, and a
    // week that starts on the leave's last day is one cell wide for a good reason.
    const boxes = await bar.evaluateAll((bars) => bars.map((el) => el.getBoundingClientRect().width));
    const cellBox = (await page.locator('[data-testid="calendar-day"]').first().boundingBox())!;
    expect(Math.max(...boxes)).toBeGreaterThan(cellBox.width * 1.5);

    expect(calendars.length).toBeGreaterThan(1);
  });

  test("cascades overlapping meetings so each keeps a readable leading edge", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "day");

    // Two of today's overlapping meetings are on the default calendar.
    const a = calendarEvent(page, "ev-overlap-a");
    const b = calendarEvent(page, "ev-overlap-b");
    await expect(a).toBeVisible();
    await expect(b).toBeVisible();

    const boxA = (await a.boundingBox())!;
    const boxB = (await b.boundingBox())!;
    const column = (await page.locator('[data-testid="calendar-day-column"]').boundingBox())!;
    // They overlap in time, so they are offset horizontally: the later one starts well
    // inside the earlier one and paints over its trailing edge (the way Notion
    // Calendar, Outlook and Google all draw a double-booked hour).
    expect(boxB.x).toBeGreaterThan(boxA.x + 0.15 * column.width);
    // Neither is squeezed below the width its title needs, and neither escapes the
    // column.
    for (const box of [boxA, boxB]) {
      expect(box.width).toBeGreaterThan(0.2 * column.width);
      expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 1);
    }
  });

  test("never draws a quarter-hour meeting over the one that follows it", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "day");

    // Three quarter-hour meetings, back to back, on the default calendar. The day holds
    // no overlap, so the blocks must not overlap either — a short block is grown for its
    // title only as far as the next meeting's start.
    const boxes = [];
    for (const id of ["ev-quarter-0", "ev-quarter-1", "ev-quarter-2"]) {
      const block = calendarEvent(page, id);
      await expect(block).toBeVisible();
      boxes.push((await block.boundingBox())!);
    }
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i - 1]!.y + boxes[i - 1]!.height).toBeLessThanOrEqual(boxes[i]!.y + 1);
    }
    // And none of them is cascaded aside: they share the column's leading edge.
    for (const box of boxes) expect(box.x).toBeCloseTo(boxes[0]!.x, 0);
  });

  test("opens the details beside the event, and puts them away on a background click", async ({
    page,
  }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "week");

    // A timed block in the hour body, so it occupies one day column and the panel has
    // room beside it — and one taken from the grid rather than by id, because which of
    // the fixture's events the working week holds depends on the day the suite runs on.
    const event = page.locator('[data-testid="calendar-hours"] [data-testid="calendar-event"]').first();
    await expect(event).toBeVisible();
    const eventBox = (await event.boundingBox())!;
    await event.click();

    const details = page.locator('[data-testid="calendar-event-details"]');
    await expect(details).toBeVisible();
    // Beside the event, not over it: the row the user is reasoning about stays visible.
    const panel = (await details.boundingBox())!;
    const overlaps =
      panel.x < eventBox.x + eventBox.width && panel.x + panel.width > eventBox.x;
    expect(overlaps).toBe(false);
    // And the event it describes is marked as the open one.
    await expect(event).toHaveAttribute("data-selected", "true");

    // A click on the grid's own background closes it, like every calendar.
    await page.locator('[data-testid="calendar-hours"]').click({ position: { x: 8, y: 200 } });
    await expect(details).toHaveCount(0);
  });

  test("opens an event's details, with the user's own actions and nothing else", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "day");

    await calendarEvent(page, "ev-overlap-a").click();
    const details = page.locator('[data-testid="calendar-event-details"]');
    await expect(details).toBeVisible();
    await expect(details.locator('[data-testid="calendar-event-title"]')).toHaveText(
      "Architecture guild",
    );
    await expect(details.locator('[data-testid="calendar-event-when"]')).not.toBeEmpty();
    await expect(details.locator('[data-testid="calendar-event-attendees"] li')).toHaveCount(2);

    // Joining and opening in Outlook are links the USER follows — never actions this
    // app takes on their behalf.
    const join = details.locator('[data-testid="calendar-event-join"]');
    await expect(join).toHaveAttribute("href", /teams\.microsoft\.com/);
    await expect(join).toHaveAttribute("target", "_blank");
    await expect(details.locator('[data-testid="calendar-event-outlook"]')).toHaveAttribute(
      "href",
      /outlook\.office\.com/,
    );
    await expect(details).toContainText("this app never writes");

    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
  });

  test("adds the weekend, and week numbers, when the view menu says so", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "week");
    // The working week by default: five columns, Monday to Friday.
    const columns = page.locator('[data-testid="calendar-day-column"]');
    await expect(columns).toHaveCount(5);
    expect(await weekdaysOf(columns)).toEqual([1, 2, 3, 4, 5]);

    await toggleCalendarSetting(page, "showWeekends");
    // Seven columns, and the same window: drawing the weekend is a display choice, so it
    // must never change which events were fetched.
    await expect(columns).toHaveCount(7);
    expect(await weekdaysOf(columns)).toEqual([1, 2, 3, 4, 5, 6, 0]);

    await openCalendarView(page, "month");
    await expect(page.locator('[data-testid="calendar-day"]')).toHaveCount(42);
    await toggleCalendarSetting(page, "showWeekends");
    await expect(page.locator('[data-testid="calendar-day"]')).toHaveCount(30);

    // Week numbers are off by default and gate the month grid's leading column.
    await expect(page.locator('[data-testid="calendar-week-number"]')).toHaveCount(0);
    await toggleCalendarSetting(page, "showWeekNumbers");
    await expect(page.locator('[data-testid="calendar-week-number"]')).toHaveCount(6);
    await toggleCalendarSetting(page, "showWeekNumbers");
    await expect(page.locator('[data-testid="calendar-week-number"]')).toHaveCount(0);
  });

  test("draws declined and cancelled events only when the view menu says so", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    // The agenda, so the assertion holds whichever day the suite runs on: the declined
    // meeting is two days out, which a single week does not always contain.
    await openCalendarView(page, "agenda");

    // A meeting the user declined (this one was cancelled by its organizer too) is not
    // on their day, so it is not drawn by default.
    const declined = calendarEvent(page, "ev-cancelled");
    await expect(declined).toHaveCount(0);
    // Everything else is untouched.
    await expect(calendarEvent(page, "ev-overlap-a")).toBeVisible();

    await toggleCalendarSetting(page, "showDeclined");
    // Turned on, it comes back struck through: it still explains a quiet hour.
    await expect(declined).toBeVisible();

    await toggleCalendarSetting(page, "showDeclined");
    await expect(declined).toHaveCount(0);
  });

  test("switches views and steps the period from the keyboard", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    const title = page.locator('[data-testid="calendar-title"]');
    // Take the focus off the sidebar's tablist first: while a tab has it, the arrow keys
    // belong to the tabs (they move between Chats/Channels/Mail/Calendar), not to the
    // calendar — which is correct for a tablist and not what this spec is about.
    await title.click();

    await page.keyboard.press("m");
    await expect(page.locator('[data-testid="calendar-month"]')).toBeVisible();
    await page.keyboard.press("w");
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveCount(5);
    await expect(page.locator('[data-testid="calendar-subtitle"]')).toContainText(/week \d+/i);

    const thisWeek = (await page.locator('[data-testid="calendar-subtitle"]').textContent())!;
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-testid="calendar-subtitle"]')).not.toHaveText(thisWeek);
    await page.keyboard.press("t");
    await expect(page.locator('[data-testid="calendar-subtitle"]')).toHaveText(thisWeek);

    await page.keyboard.press("d");
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveCount(1);
    await page.keyboard.press("a");
    await expect(page.locator('[data-testid="calendar-agenda"]')).toBeVisible();
    await page.keyboard.press("m");
    await expect(page.locator('[data-testid="calendar-month"]')).toBeVisible();
    await expect(title).not.toBeEmpty();
  });

  test("shows the true attendee count even when the list is capped", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "agenda");

    await calendarEvent(page, "ev-all-hands").click();
    const details = page.locator('[data-testid="calendar-event-details"]');
    // The backend keeps 20 of them; the count must still be the real one (777 here,
    // and one real invitation in this tenant genuinely has that many).
    await expect(details).toContainText("777 attendees");
    await expect(details.locator('[data-testid="calendar-event-attendees"] li')).toHaveCount(20);
    await expect(details).toContainText("and 757 more");
  });

  test("picks a day from the month grid and from the mini month", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "month");

    // Clicking a day number in the grid zooms into that day. Any cell will do — today's
    // is not in the default grid when today is a Saturday.
    const cell = page.locator('[data-testid="calendar-day"]').nth(7);
    const day = await cell.getAttribute("data-day");
    await cell.locator("button").first().click();
    await expect(page.locator('[data-testid="calendar-time-grid"]')).toBeVisible();
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveAttribute(
      "data-day",
      day!,
    );

    // The mini month moves the view without changing which view it is.
    const otherDay = page
      .locator(`[data-testid="calendar-mini-day"]:not([data-day="${day}"])`)
      .nth(20);
    const otherKey = await otherDay.getAttribute("data-day");
    await otherDay.click();
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveAttribute(
      "data-day",
      otherKey!,
    );

    // A Saturday picked from the mini month draws that Saturday. The default grid leaves
    // the weekend out of a WEEK, and the Day view is the one place that must not apply
    // it: the user asked for that day.
    const miniDays = page.locator('[data-testid="calendar-mini-day"]');
    const weekdays = await weekdaysOf(miniDays);
    const saturday = miniDays.nth(weekdays.indexOf(6));
    const saturdayKey = await saturday.getAttribute("data-day");
    await saturday.click();
    const column = page.locator('[data-testid="calendar-day-column"]');
    await expect(column).toHaveCount(1);
    await expect(column).toHaveAttribute("data-day", saturdayKey!);
  });

  test("reconciles a meeting rescheduled elsewhere, live", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "agenda");

    const event = calendarEvent(page, "ev-overlap-b");
    await expect(event).toContainText("1:1 with Ada");

    // The same thing the backend's poll notices when the organizer renames a meeting
    // in real Outlook: the window is re-read and pushed.
    await emitCalendarChange(page, { event_id: "ev-overlap-b", subject: "1:1 with Ada (moved)" });
    await expect(event).toContainText("1:1 with Ada (moved)");
  });

  test("drops an event cancelled elsewhere, live", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    await openCalendarView(page, "agenda");

    const event = calendarEvent(page, "ev-overlap-a");
    await expect(event).toBeVisible();

    // Removed from the server's own view of the window — the client's merge treats the
    // incoming window as authoritative, so it must disappear here too.
    await emitCalendarChange(page, { event_id: "ev-overlap-a", remove: true });
    await expect(event).toHaveCount(0);
  });

  test("remembers the visible calendars across a reload", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);

    const { calendars } = await fetchTestCalendar(page);
    const other = calendars.find((c) => !c.is_default)!;
    const toggle = page.locator(`[data-testid="calendar-toggle"][data-calendar-id="${other.id}"]`);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await openCalendarTab(page);
    await expect(
      page.locator(`[data-testid="calendar-toggle"][data-calendar-id="${other.id}"]`),
    ).toHaveAttribute("aria-checked", "true");

    // Leave the shared mock's client-side state as we found it: the specs run
    // serially against one browser profile.
    await page.locator(`[data-testid="calendar-toggle"][data-calendar-id="${other.id}"]`).click();
  });

  test("runs the calendar without console errors", async ({ page, consoleErrors }) => {
    await gotoApp(page);
    await openCalendarTab(page);
    for (const view of ["week", "day", "agenda", "month"] as const) {
      await openCalendarView(page, view);
    }
    await page.locator('[data-testid="calendar-next"]').click();
    await page.locator('[data-testid="calendar-today"]').click();
    expect(realErrors(consoleErrors)).toEqual([]);
  });
});

/**
 * The weekdays a set of day columns (or month cells) draws, as `Date.getDay()` numbers
 * and in the grid's own order — read from each element's `data-day`.
 *
 * The fixtures are relative to today, so the suite runs on every weekday and both
 * weekend days. Asserting the SHAPE of the week this way keeps those runs identical.
 */
async function weekdaysOf(days: Locator): Promise<number[]> {
  const keys = await days.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-day") ?? ""),
  );
  return keys.map((key) => {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year!, month! - 1, day!).getDay();
  });
}

/** Whether today is a Saturday or a Sunday — the one case where the default grid, which
 *  draws the working week only, has no cell for today at all. */
function isWeekendToday(): boolean {
  const weekday = new Date().getDay();
  return weekday === 0 || weekday === 6;
}
