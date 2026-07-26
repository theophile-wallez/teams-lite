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

  test("has a Calendar tab that reveals the month grid", async ({ page }) => {
    await gotoApp(page);

    await expect(page.locator('[data-testid="tab-calendar"]')).toBeVisible();
    // Lazy: nothing is loaded until the tab is opened.
    await expect(page.locator('[data-testid="calendar-pane"]')).toHaveCount(0);

    await openCalendarTab(page);

    // The month grid is the default view, and it always shows six full weeks so its
    // height never jumps between months.
    await expect(page.locator('[data-testid="calendar-month"]')).toBeVisible();
    await expect(page.locator('[data-testid="calendar-day"]')).toHaveCount(42);
    // Exactly one cell is today.
    await expect(page.locator('[data-testid="calendar-day"][data-today="true"]')).toHaveCount(1);
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
    // And the surface says what it is.
    await expect(page.locator('[data-testid="calendar-pane"]')).toContainText("read-only");
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

    const title = page.locator('[data-testid="calendar-title"]');
    const thisMonth = (await title.textContent())!.trim();

    await page.locator('[data-testid="calendar-next"]').click();
    await expect(title).not.toHaveText(thisMonth);
    // Off this month, no cell is today.
    await expect(page.locator('[data-testid="calendar-day"][data-today="true"]')).toHaveCount(0);

    await page.locator('[data-testid="calendar-prev"]').click();
    await expect(title).toHaveText(thisMonth);

    // Two steps away, then Today brings it straight back.
    await page.locator('[data-testid="calendar-prev"]').click();
    await page.locator('[data-testid="calendar-prev"]').click();
    await expect(title).not.toHaveText(thisMonth);
    await page.locator('[data-testid="calendar-today"]').click();
    await expect(title).toHaveText(thisMonth);
    await expect(page.locator('[data-testid="calendar-day"][data-today="true"]')).toHaveCount(1);
  });

  test("switches between the month, week, day and agenda views", async ({ page }) => {
    await gotoApp(page);
    await openCalendarTab(page);

    await openCalendarView(page, "week");
    // Seven day columns and a 24-hour body.
    await expect(page.locator('[data-testid="calendar-day-column"]')).toHaveCount(7);
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
    // It is genuinely wider than a single day cell.
    const barBox = (await bar.first().boundingBox())!;
    const cellBox = (await page.locator('[data-testid="calendar-day"]').first().boundingBox())!;
    expect(barBox.width).toBeGreaterThan(cellBox.width * 1.5);

    expect(calendars.length).toBeGreaterThan(1);
  });

  test("places overlapping meetings side by side in the day view", async ({ page }) => {
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
    // They overlap in time, so they must not overlap on screen.
    const separated = boxA.x + boxA.width <= boxB.x + 1 || boxB.x + boxB.width <= boxA.x + 1;
    expect(separated).toBe(true);
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

    // Clicking a day number in the grid zooms into that day.
    const cell = page.locator('[data-testid="calendar-day"][data-today="true"]');
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
