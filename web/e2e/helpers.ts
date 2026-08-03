import { test as base, expect, type Page } from "@playwright/test";

// A test fixture that tracks browser console errors and page errors, so specs
// can assert the app runs clean. Favicon 404s and the React devtools notice are
// filtered out as noise.
type Fixtures = {
  consoleErrors: string[];
  plainComposer: void;
  mockBackendOnly: void;
};

/** The port the mock is expected on — mirrors `playwright.config.ts`. */
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? "19457";

export const test = base.extend<Fixtures>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await use(errors);
  },

  // The suite sends, edits and reacts. If the app under test is talking to the
  // real backend, those are real messages to real colleagues — it has happened:
  // moving E2E_MOCK_PORT without rebuilding the app's baked WebSocket URL left the
  // app dialing 127.0.0.1:19420, and four test strings landed in a 1:1 chat.
  //
  // This is an AUTO fixture, and it watches the socket rather than the DOM, for one
  // reason: it must be impossible to bypass. The previous guard lived in `gotoApp`,
  // so every spec that called `page.goto` directly walked straight past it. Here,
  // any WebSocket the page opens to anywhere but the mock closes the page
  // immediately, which fails the spec on its very next action — before it can type.
  mockBackendOnly: [
    async ({ page }, use) => {
      page.on("websocket", (ws) => {
        if (ws.url().includes(`:${MOCK_PORT}`)) return;
        console.error(
          `[e2e] REFUSING: the app opened a WebSocket to ${ws.url()}, not the mock on ` +
            `port ${MOCK_PORT}. Closing the page before this spec can write anything. ` +
            `The app's target is baked at build time — see VITE_TEAMS_WS_URL in playwright.config.ts.`,
        );
        void page.close();
      });
      await use();
    },
    { auto: true },
  ],

  // The app now defaults the composer to the rich-text editor. These specs drive
  // the plain `[data-testid="composer"]` textarea (fill / toHaveValue), so opt
  // every test out to the deterministic plain field before it navigates. Specs
  // that exercise the rich default clear this key themselves (see
  // rich-composer.spec.ts). Registered as an auto fixture so it also covers the
  // one spec that calls `page.goto` directly.
  plainComposer: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem("teams-composer-rich", "0");
        } catch {
          /* ignore */
        }
      });
      await use();
    },
    { auto: true },
  ],
});

export { expect };

/** Navigate to the app and wait until it has connected and loaded conversations. */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto("/");
  // The sidebar renders conversation rows once the WebSocket handshake completes
  // and `conversations` returns — a reliable "app is live" signal.
  await expect
    .poll(() => page.locator('[data-testid="conversation-row"]').count(), { timeout: 15_000 })
    .toBeGreaterThan(3);
  // Per-page confirmation that we are on the mock, from the backend's own
  // `backend_info` sentinel: `e2e/global-setup.ts` checks the port once up front,
  // this catches a client that ended up pointed somewhere else entirely. Specs
  // send, edit and react freely, so this must hold before any of them run.
  await expect(page.locator('[data-testid="backend-badge"]')).toHaveAttribute(
    "data-backend",
    "mock",
  );
}

/** Open the conversation at the given sidebar index and wait for its messages. */
export async function openConversationAt(page: Page, index = 0): Promise<string> {
  const row = page.locator('[data-testid="conversation-row"]').nth(index);
  const id = (await row.getAttribute("data-conversation-id")) ?? "";
  await row.click();
  await expect(page.locator('[data-testid="conversation-title"]')).not.toBeEmpty();
  await expect
    .poll(() => page.locator('[data-testid="message"]').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
  return id;
}

export type CapturedSend = {
  conversation: string;
  text: string;
  content_html?: string;
  image?: {
    name: string;
    content_type: string;
    data_base64: string;
    width?: number;
    height?: number;
  };
};

/** Configure the mock's next sends. Always reset the control after a failure test,
 *  because one mock process serves the complete E2E run. */
export async function setSendControl(
  page: Page,
  body: { delay_ms?: number; error?: string; clear?: boolean } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/send-control`, {
    data: body,
  });
  expect(res.ok()).toBeTruthy();
}

/** Return the send requests captured by the mock test control plane. */
export async function fetchCapturedSends(page: Page): Promise<CapturedSend[]> {
  const res = await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/sends`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { sends: CapturedSend[] };
  return body.sends;
}

/** Inject a live message through the mock's gated test hook. */
export async function emitLive(
  page: Page,
  body: { conversation: string; content: string; sender?: string; is_self?: boolean; reply?: boolean },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, { data: body });
  expect(res.ok()).toBeTruthy();
}

/** Inject an activity-feed entry (reaction/mention) through the mock's gated
 *  test hook, then the mock broadcasts `notifications_changed`. */
export async function emitNotification(
  page: Page,
  body: {
    activity_type?: string;
    activity_subtype?: string;
    actor_name?: string;
    source_thread_id?: string;
    preview?: string;
  } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "notification", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Broadcast a typing/presence signal through the mock's gated test hook. */
export async function emitTyping(
  page: Page,
  body: { conversation: string; sender?: string; sender_mri?: string; is_typing?: boolean },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "typing", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Broadcast an incoming-call awareness signal through the mock's gated test
 *  hook, mirroring the Rust backend's `call` event. A `started` rings the banner;
 *  `ended`/`missed` dismisses it. */
export async function emitCall(
  page: Page,
  body: {
    conversation: string;
    event?: "started" | "ended" | "missed";
    caller?: string;
    caller_mri?: string;
    participants?: string[];
    participant_count?: number;
  },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "call", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Set the broker health the mock reports, through its gated test hook; the mock then
 *  broadcasts `broker_status`, mirroring the Rust backend's own event.
 *
 *  ALWAYS restore it with `{ ok: true }` before the spec ends. The mock is a shared
 *  process and `reuseExistingServer` adopts it across runs, so a broker left broken
 *  would raise the banner in every later spec. */
export async function emitBrokerStatus(
  page: Page,
  body: {
    ok?: boolean;
    signature?: string;
    message?: string;
    detail?: string;
    consecutive_failures?: number;
    can_repair?: boolean;
    repairing?: boolean;
  } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "broker", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Move a member's read position ("seen by") through the mock's gated test hook,
 *  then the mock broadcasts a `read_receipt` event. Defaults anchor the reader to
 *  the conversation's newest message (avatars land at the bottom). */
export async function emitReadReceipt(
  page: Page,
  body: {
    conversation: string;
    member?: string;
    member_mri?: string;
    last_read_message_id?: string;
    read_time_ms?: number;
  },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "read_receipt", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** Clear every injected read position on the shared mock, so "seen by" avatars
 *  from one spec never leak into the next. */
export async function clearReadReceipts(page: Page): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "read_receipt", clear: true },
  });
  expect(res.ok()).toBeTruthy();
}

/** Set a reaction on an existing message through the mock's gated test hook
 *  (from someone else by default), then the mock re-broadcasts the message. */
export async function emitReaction(
  page: Page,
  body: {
    conversation?: string;
    message_id?: string;
    key?: string;
    count?: number;
    mine?: boolean;
  },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "reaction", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** The mock's seeded channels, via the gated `/__test/channels` endpoint — used
 *  to assert the Chats list never contains a channel thread. */
export async function fetchTestChannels(
  page: Page,
): Promise<{ id: string; name: string; team_id: string; team_name: string }[]> {
  const res = await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/channels`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Which conversations the mock backend has been told to answer an `@claude` message
 *  in, via the gated `/__test/agent` endpoint.
 *
 *  A spec asserts the opt-in through this rather than through the switch it just
 *  clicked: the control is only worth anything if the BACKEND stored the consent. */
export async function fetchAgentModes(
  page: Page,
): Promise<{ sandbox: string; conversations: { conversation: string; mode: string }[] }> {
  const res = await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/agent`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Switch the sidebar to the Channels tab and wait for the tree to populate. */
export async function openChannelsTab(page: Page): Promise<void> {
  await page.locator('[data-testid="tab-channels"]').click();
  // Channels load at startup alongside chats; wait until the tree has rows.
  await expect
    .poll(() => page.locator('[data-testid="channel-row"]').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

/** Switch the sidebar to the Mail tab and wait for the list to populate. Mail loads
 *  lazily — the folder list is fetched only when this tab is first shown — so specs
 *  must go through here rather than assume rows exist. */
export async function openMailTab(page: Page): Promise<void> {
  await page.locator('[data-testid="tab-mail"]').click();
  await expect
    .poll(() => page.locator('[data-testid="mail-row"]').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
}

/** Open the mail at `index` and wait for its reading pane + body to render. */
export async function openMailAt(page: Page, index = 0): Promise<string> {
  const row = page.locator('[data-testid="mail-row"]').nth(index);
  const id = (await row.getAttribute("data-mail-id")) ?? "";
  await row.click();
  await expect(page.locator('[data-testid="mail-heading"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="mail-body"], [data-testid="mail-body-empty"]').first(),
  ).toBeVisible();
  return id;
}

/** Deliver a new mail through the mock's gated test hook, then the mock broadcasts
 *  `mail_list_updated` + `mail_folders_changed` — mirroring what the Rust backend
 *  emits when its newest-window poll notices one. */
export async function emitMail(
  page: Page,
  body: { folder?: string; subject?: string; sender?: string; preview?: string } = {},
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "mail", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** The mock's seeded mailbox, via the gated `/__test/mail` endpoint. */
export async function fetchTestMail(page: Page): Promise<{
  folders: { id: string; display_name: string; well_known: string; unread_count: number }[];
  inbox: { id: string; subject: string; is_read: boolean; received: string }[];
}> {
  const res = await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/mail`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Switch the sidebar to the Calendar tab and wait for the grid to render. The
 *  calendar loads lazily — the calendar list and the first window are fetched only
 *  when this tab is first shown — so specs must go through here. */
export async function openCalendarTab(page: Page): Promise<void> {
  await page.locator('[data-testid="tab-calendar"]').click();
  await expect(page.locator('[data-testid="calendar-pane"]')).toBeVisible();
  await expect
    .poll(() => calendarEvents(page).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
}

/** Every event drawn in the calendar GRID.
 *
 *  Scoped to the pane on purpose: the sidebar's "Up next" list renders the same
 *  events with the same test id, so an unscoped locator matches an event twice and
 *  every strict-mode assertion on it fails. */
export function calendarEvents(page: Page) {
  return page.locator('[data-testid="calendar-pane"] [data-testid="calendar-event"]');
}

/** One event in the grid, by id (see {@link calendarEvents} on why this is scoped). */
export function calendarEvent(page: Page, id: string) {
  return page.locator(
    `[data-testid="calendar-pane"] [data-testid="calendar-event"][data-event-id="${id}"]`,
  );
}

/**
 * Open the header's view menu and wait until its rows are settled enough to click.
 *
 * Two waits, both for the same reason — a spec drives this control far faster than a
 * person does. Radix keeps a CLOSING menu mounted for its exit animation, and a menu
 * opened during that window is re-created mid-flight, which detaches the row the caller
 * is about to click. So: wait for any previous menu to be gone, then for the new one to
 * have finished opening.
 */
async function openCalendarViewMenu(page: Page): Promise<void> {
  const menu = page.locator('[role="menu"]');
  await expect(menu).toHaveCount(0);
  await page.locator('[data-testid="calendar-view-menu"]').click();
  await expect(menu).toHaveCount(1);
  await expect(menu).toHaveAttribute("data-state", "open");
}

/** Switch the calendar to one of its views and wait for that view to mount. The views
 *  live behind the header's view menu, so this opens that first. */
export async function openCalendarView(
  page: Page,
  view: "month" | "week" | "day" | "agenda",
): Promise<void> {
  await openCalendarViewMenu(page);
  await page.locator(`[data-testid="calendar-view-${view}"]`).click();
  const surface = {
    month: '[data-testid="calendar-month"]',
    week: '[data-testid="calendar-time-grid"]',
    day: '[data-testid="calendar-time-grid"]',
    agenda: '[data-testid="calendar-agenda"], [data-testid="calendar-agenda-empty"]',
  }[view];
  await expect(page.locator(surface).first()).toBeVisible();
}

/** Flip one of the view menu's display settings (weekends, declined events, week
 *  numbers) and close the menu again. Checkbox rows keep the menu open on purpose, so
 *  the Escape is this helper's job. */
export async function toggleCalendarSetting(
  page: Page,
  key: "showWeekends" | "showDeclined" | "showWeekNumbers",
): Promise<void> {
  await openCalendarViewMenu(page);
  const item = page.locator(`[data-testid="calendar-setting-${key}"]`);
  const before = await item.getAttribute("aria-checked");
  await item.click();
  await expect(item).not.toHaveAttribute("aria-checked", before ?? "");
  await page.keyboard.press("Escape");
  await expect(item).toHaveCount(0);
}

/** Reschedule, cancel or remove an event on the mock and broadcast the window it
 *  lives in — mirroring what the Rust backend emits when its poll notices a change
 *  made in real Outlook. */
export async function emitCalendarChange(
  page: Page,
  body: {
    event_id?: string;
    subject?: string;
    start?: string;
    end?: string;
    is_cancelled?: boolean;
    response?: string;
    remove?: boolean;
    calendar?: string;
    /** Re-seed the mock's calendar, undoing every change made by this suite. */
    reset?: boolean;
  },
): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
    data: { kind: "calendar", ...body },
  });
  expect(res.ok()).toBeTruthy();
}

/** The mock's seeded calendars and events, via the gated `/__test/calendar` endpoint. */
export async function fetchTestCalendar(page: Page): Promise<{
  calendars: { id: string; name: string; is_default: boolean }[];
  events: {
    id: string;
    calendar_id: string;
    subject: string;
    start: string;
    end: string;
    is_all_day: boolean;
    response: string;
  }[];
}> {
  const res = await page.request.get(`http://127.0.0.1:${MOCK_PORT}/__test/calendar`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

/** Filter out benign console noise so `consoleErrors` only holds real problems. */
export function realErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !/favicon/i.test(e) && !/Download the React DevTools/i.test(e) && !/404/.test(e),
  );
}
