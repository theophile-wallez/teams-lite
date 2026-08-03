// The ONLY sanctioned way to drive the web UI with a browser.
//
// Why this file exists, in one incident: a screenshot script was pointed at the
// mock backend, the dev server was restarted without `VITE_TEAMS_WS_URL`, and the
// app silently reconnected to the user's REAL Teams account. The script then typed
// its test phrases into the composer and pressed Enter — three messages went out
// to two real 1:1 chats with colleagues. Nothing in the loop was able to notice.
//
// So this helper owns the whole setup and refuses to hand over a page it cannot
// prove is fake:
//   1. it starts `web/mock/server.ts` itself, on a port that is not the backend's;
//   2. it starts `vite dev` with `VITE_TEAMS_WS_URL` pointing at that mock;
//   3. it waits for the app, then asserts the MOCK sentinel badge rendered by
//      `StatusBar` — a value that comes from the backend over the wire, not from
//      our own configuration, so it cannot be fooled by a bad assumption here;
//   4. every keystroke helper re-asserts that badge immediately before typing.
//
// If any of that fails it tears everything down and throws BEFORE a single key is
// pressed. Never bypass it with an ad-hoc Playwright script: `AGENTS.md` makes
// this mandatory, and `.claude/hooks/guard-live-automation.sh` enforces it.
//
// Usage as a library:
//
//   import { withPreview, typeInComposer } from "./scripts/preview";
//   await withPreview(async ({ page, shot }) => {
//     await openFirstConversation(page);
//     await typeInComposer(page, "hello", { send: true });
//     await shot("/tmp/out.png");
//   });
//
// Usage from the shell (screenshot the first conversation, light + dark):
//
//   bun run web/scripts/preview.ts --out /tmp/preview
//   bun run web/scripts/preview.ts --out /tmp/preview --type "hello there" --send
//   bun run web/scripts/preview.ts --out /tmp/preview --incoming "hello there"
//   bun run web/scripts/preview.ts --out /tmp/mail --mail        # the Mail surface
//   bun run web/scripts/preview.ts --out /tmp/cal --calendar     # the Calendar surface
//   bun run web/scripts/preview.ts --out /tmp/chan --channels    # the team → channel tree
//   bun run web/scripts/preview.ts --out /tmp/links --links      # Linear + GitLab link cards
//   bun run web/scripts/preview.ts --out /tmp/preview --react   # reaction chips + emoji picker
//   bun run web/scripts/preview.ts --out /tmp/preview --scrolled # history scrolled up (jump button)
//   bun run web/scripts/preview.ts --out /tmp/ghost --ghost     # read state + Ghost mode
//   bun run web/scripts/preview.ts --out /tmp/set --settings    # the Settings pane
//
// To capture a specific thread instead of the top row — `--conversation` matches a
// sidebar row by name, so a fixture can be aimed at without writing a driver:
//
//   bun run web/scripts/preview.ts --out /tmp/cards --conversation "App Cards"
//
// The window is 1200x850. A layout that caps its own width needs a wider one:
//
//   PREVIEW_VIEWPORT=1920x900 bun run web/scripts/preview.ts --out /tmp/wide
//
// To review a small detail — an icon, a chip, a badge — crop to it and ask for more
// pixels per CSS pixel, instead of squinting at a 16px glyph in a 1200px page:
//
//   bun run web/scripts/preview.ts --out /tmp/chip --element '[data-testid="message-file"]' --dpr 4

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

/**
 * Ports a send-capable backend — or the app server that relays to one — may be on.
 * Nothing here may ever talk to any of them: 19420/19440 are the always-on service,
 * 19421/19441 the user's hands-on dev pair. All four reach the real account.
 */
const LIVE_PORTS = [19420, 19421, 19440, 19441];
/** Ports for our own throwaway mock + dev server (override via env if taken). */
const MOCK_PORT = Number(process.env.PREVIEW_MOCK_PORT ?? 19456);
const WEB_PORT = Number(process.env.PREVIEW_WEB_PORT ?? 19446);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const MOCK_WS_URL = `ws://127.0.0.1:${MOCK_PORT}`;

/**
 * The window every capture uses. A wider one matters for a pane that caps its own
 * width — the chat column and the composer only reach their cap past ~1000px, so
 * the default window never shows the gap the user sees on a large screen.
 * Override with `PREVIEW_VIEWPORT=1920x900`.
 */
const VIEWPORT = parseViewport(process.env.PREVIEW_VIEWPORT) ?? { width: 1200, height: 850 };

/** `1920x900` → `{ width: 1920, height: 900 }`; anything else → null. */
function parseViewport(spec: string | undefined): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(spec?.trim() ?? "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

const STARTUP_TIMEOUT_MS = 90_000;
const APP_READY_TIMEOUT_MS = 60_000;

/** The web/ directory, derived from this file's location (cwd-independent). */
const WEB_DIR = join(import.meta.dirname, "..");

export type PreviewSession = {
  page: Page;
  /** The mock's port, for its `/__test/emit` control plane. */
  mockPort: number;
  /** Inject a live event through the mock (see `web/e2e/helpers.ts`). */
  emit: (body: Record<string, unknown>) => Promise<void>;
  /** Screenshot the whole page (or an element, when a selector is given). */
  shot: (path: string, selector?: string) => Promise<void>;
  /** Switch the app between light and dark for a second capture. */
  setTheme: (theme: "light" | "dark") => Promise<void>;
};

export type PreviewOptions = {
  /** Pixels captured per CSS pixel. Raise it to review a small detail (an icon, a
   *  chip) without changing the layout the app renders at. */
  deviceScaleFactor?: number;
};

/**
 * Boot a mock-backed preview of the web app, run `body` against it, then tear
 * everything down. Throws — before `body` runs — if the app is not provably
 * talking to the mock.
 */
export async function withPreview<T>(
  body: (session: PreviewSession) => Promise<T>,
  options: PreviewOptions = {},
): Promise<T> {
  assertPortsAreNotTheBackend();
  await assertPortsAreFree();
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  let browser: Browser | null = null;
  try {
    children.push(startMock());
    children.push(startWebServer());
    await waitForHttp(`http://127.0.0.1:${MOCK_PORT}/`, "mock backend");
    await waitForHttp(`${WEB_ORIGIN}/`, "vite dev server");

    browser = await chromium.launch({ executablePath: findChromium() });
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: options.deviceScaleFactor,
    });
    await page.goto(WEB_ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="conversation-row"]', {
      timeout: APP_READY_TIMEOUT_MS,
    });
    await assertMockBackend(page);

    return await body({
      page,
      mockPort: MOCK_PORT,
      emit: async (data) => {
        const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, { data });
        if (!res.ok()) throw new Error(`mock /__test/emit failed: ${res.status()}`);
      },
      shot: async (path, selector) => {
        if (!selector) {
          await page.screenshot({ path });
          return;
        }
        // An element capture waits for the element to stop moving, so a looping
        // animation anywhere in it never settles and the call times out. Finishing
        // every animation first also makes the crop reproducible.
        await page.locator(selector).first().screenshot({ path, animations: "disabled" });
      },
      setTheme: async (theme) => {
        // Passed as source text, not a closure: this file type-checks under the
        // node tsconfig (no DOM lib), and the body runs in the page.
        await page.evaluate(
          `document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`,
        );
        await page.waitForTimeout(400);
      },
    });
  } finally {
    await browser?.close().catch(() => {});
    for (const child of children) child.kill();
  }
}

/**
 * The gate. Reads the backend badge the app renders from the mock's own
 * `backend_info` sentinel, and throws unless it says `mock`.
 *
 * Called once at startup and again before every keystroke helper — the app can
 * reconnect at any moment (the client auto-reconnects with backoff), so "it was
 * the mock a minute ago" is not proof that it still is.
 */
async function assertMockBackend(page: Page): Promise<void> {
  const badge = page.locator('[data-testid="backend-badge"]');
  const kind = await badge.getAttribute("data-backend", { timeout: 15_000 }).catch(() => null);
  if (kind === "mock") return;
  throw new Error(
    kind === null
      ? "REFUSING TO DRIVE THIS APP: no backend sentinel found. The badge in the status " +
        "bar renders only in a dev build, and only the mock announces itself. Either this " +
        "is a production build or the app is not connected to web/mock/server.ts."
      : `REFUSING TO DRIVE THIS APP: the backend badge says "${kind}", not "mock". This app ` +
        "is talking to a real Teams account — a keystroke here would post as the user. " +
        "Fix the setup (see web/scripts/preview.ts) instead of working around this.",
  );
}

/**
 * Type into the composer, optionally sending. The only sanctioned way to put
 * characters into the app: it re-asserts the mock sentinel first, so a page that
 * silently reconnected to the real backend gets no keystrokes.
 */
export async function typeInComposer(
  page: Page,
  text: string,
  opts: { send?: boolean } = {},
): Promise<void> {
  await assertMockBackend(page);
  const composer = page
    .locator('[data-testid="composer"], [data-testid="composer-rich"], .tiptap-message')
    .first();
  await composer.click();
  await composer.type(text, { delay: 5 });
  if (opts.send) {
    await assertMockBackend(page); // last check, right before the message leaves
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }
}

/**
 * Open the first conversation and wait for its messages to render. Returns its
 * id, so callers can aim `emit` at the thread that is actually on screen — the
 * mock defaults injected messages to its *own* first thread, which is not the
 * top row once the list is sorted by recency.
 */
export async function openFirstConversation(page: Page): Promise<string> {
  return openRow(page, page.locator('[data-testid="conversation-row"]').first());
}

/** The two sidebar tabs, and how to walk each one's list. */
const SIDEBAR_TABS = [
  { tab: "chats", row: "conversation-row", scroll: "sidebar-scroll" },
  { tab: "channels", row: "channel-row", scroll: "channels-scroll" },
] as const;

/**
 * Open the chat or channel whose sidebar row contains `name` (case-insensitive)
 * and wait for its thread to render. Returns its id, like `openFirstConversation`.
 *
 * Exists so that capturing a specific fixture never requires a hand-rolled browser
 * driver: "the preview can only open the first conversation" is a reason to reach
 * for an ad-hoc Playwright script, and that reach is what this file exists to
 * prevent. Both tabs are searched, and each list is scrolled while looking — the
 * chat list is virtualized, so a row far enough down is simply not in the DOM until
 * it has been scrolled to. Throws, listing what it did see, when nothing matches.
 */
export async function openConversation(page: Page, name: string): Promise<string> {
  const pattern = new RegExp(escapeForRegExp(name), "i");
  const seen: string[] = [];
  for (const { tab, row, scroll } of SIDEBAR_TABS) {
    const tabButton = page.locator(`[data-testid="tab-${tab}"]`);
    if ((await tabButton.count()) > 0) {
      await tabButton.click();
      await page.waitForTimeout(200);
    }
    const rows = page.locator(`[data-testid="${row}"]`);
    // Walk the list one viewport at a time until the row shows up or the list ends.
    for (;;) {
      const match = rows.filter({ hasText: pattern }).first();
      if ((await match.count()) > 0) return openRow(page, match);
      seen.push(...(await rows.allInnerTexts()).map((text) => `${tab}: ${oneLine(text)}`));
      if (!(await scrollDown(page, scroll))) break;
      await page.waitForTimeout(150);
    }
  }
  throw new Error(
    `no conversation or channel matching "${name}". Rows seen while scrolling:\n` +
      [...new Set(seen)].map((text) => `  - ${text}`).join("\n"),
  );
}

/** Click a sidebar row, wait for its thread, and report the id that was opened. */
async function openRow(page: Page, row: ReturnType<Page["locator"]>): Promise<string> {
  const id =
    (await row.getAttribute("data-conversation-id")) ??
    (await row.getAttribute("data-channel-id")) ??
    "";
  await row.click();
  // A thread is "there" once it shows a bubble OR a system line — a conversation
  // can legitimately consist of nothing but membership/call notices.
  await page.waitForSelector('[data-testid="message"], [data-testid="system-event"]');
  return id;
}

/**
 * Switch the sidebar to the Channels tab and wait for the team → channel tree.
 *
 * Reading the tree is a pure read, so — like the mail and calendar helpers — this
 * one has no keystroke gate of its own. It still only ever runs inside
 * `withPreview`, which proved the backend was the mock before handing over the page.
 */
export async function openChannelsTab(page: Page): Promise<void> {
  await page.locator('[data-testid="tab-channels"]').click();
  await page.waitForSelector('[data-testid="channel-row"]', { timeout: APP_READY_TIMEOUT_MS });
}

/** Collapse (or expand) the team section at `index`, by its header — the same
 *  toggle a person clicks. */
export async function toggleTeamSection(page: Page, index: number): Promise<void> {
  await page
    .locator('[data-testid="team-group"]')
    .nth(index)
    .locator('[data-testid="team-header"]')
    .click();
  await page.waitForTimeout(250); // the chevron rotates; capture it settled
}

/**
 * Switch the sidebar to the Mail tab and wait for the list to populate.
 *
 * Mail loads lazily — the folder list is only fetched when this tab is first shown
 * — so a caller must go through here rather than assuming rows exist.
 */
export async function openMailTab(page: Page): Promise<void> {
  await page.locator('[data-testid="tab-mail"]').click();
  await page.waitForSelector('[data-testid="mail-row"]', { timeout: APP_READY_TIMEOUT_MS });
}

/**
 * Open the first mail in the list and wait for its body frame. Returns its id.
 *
 * Reading a mail is a pure read on any backend — there is no mail send/reply path
 * at all (see src/mail.rs) — so unlike the composer helpers this one has no
 * keystroke gate to re-assert. It still only ever runs inside `withPreview`, which
 * proved the backend was the mock before handing over the page.
 */
export async function openFirstMail(page: Page): Promise<string> {
  return openMailAt(page, 0);
}

/** Open the mail at `index` in the list and wait for its body frame. See
 *  {@link openFirstMail} for the read-only note. */
export async function openMailAt(page: Page, index: number): Promise<string> {
  const row = page.locator('[data-testid="mail-row"]').nth(index);
  const id = (await row.getAttribute("data-mail-id")) ?? "";
  await row.click();
  await page.waitForSelector('[data-testid="mail-heading"]');
  // The body arrives in a second round-trip; wait for the frame (or the notice
  // shown for a mail that sanitized down to nothing).
  await page
    .locator('[data-testid="mail-body"], [data-testid="mail-body-empty"]')
    .first()
    .waitFor({ timeout: APP_READY_TIMEOUT_MS });
  return id;
}

/**
 * Switch the sidebar to the Calendar tab and wait for the grid to render.
 *
 * The calendar loads lazily — the calendar list and the first window are only
 * fetched when this tab is first shown — so a caller must go through here rather
 * than assuming a grid exists.
 *
 * Reading a calendar is a pure read on any backend: there is no create/respond path
 * at all (see src/calendar.rs), so unlike the composer helpers this one has no
 * keystroke gate to re-assert. It still only ever runs inside `withPreview`, which
 * proved the backend was the mock before handing over the page.
 */
export async function openCalendarTab(page: Page): Promise<void> {
  await page.locator('[data-testid="tab-calendar"]').click();
  await page.waitForSelector('[data-testid="calendar-pane"]', { timeout: APP_READY_TIMEOUT_MS });
  await page.waitForSelector('[data-testid="calendar-event"]', { timeout: APP_READY_TIMEOUT_MS });
}

/**
 * Open the calendar header's view menu and wait until its rows can be clicked.
 *
 * Radix keeps a CLOSING menu mounted for its exit animation, and a menu opened during
 * that window is re-created mid-flight — which detaches the row this is about to click.
 * Only a script drives a control that fast, so the waiting belongs here.
 */
async function openCalendarViewMenu(page: Page): Promise<void> {
  const menu = page.locator('[role="menu"]');
  await menu.waitFor({ state: "detached" }).catch(() => {});
  await page.locator('[data-testid="calendar-view-menu"]').click();
  await menu.waitFor();
  // Let the panel finish opening: its rows are still moving for a frame or two, and a
  // click on a moving target is a click Playwright has to retry.
  await page.waitForTimeout(200);
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
  await page.locator(surface).first().waitFor({ timeout: APP_READY_TIMEOUT_MS });
}

/**
 * Switch every calendar on, so a capture shows the layouts that only appear with
 * more than one source: multi-day bars, lanes, and colour-coded overlays. The app
 * defaults to the primary calendar alone (see the store's `visibleCalendarIds`).
 */
export async function enableAllCalendars(page: Page): Promise<void> {
  const toggles = page.locator('[data-testid="calendar-toggle"]');
  for (let i = 0; i < (await toggles.count()); i++) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
  }
  await page.waitForTimeout(500);
}

/** Open the first event's details panel. Returns its id.
 *
 *  Scoped to the pane: the sidebar's "Up next" rail renders the same events with the
 *  same test id, and an unscoped `.first()` would open one of those instead — which
 *  looks the same in a screenshot but is not the grid interaction being captured. */
export async function openFirstEvent(page: Page): Promise<string> {
  const event = page
    .locator('[data-testid="calendar-pane"] [data-testid="calendar-event"]')
    .first();
  const id = (await event.getAttribute("data-event-id")) ?? "";
  await event.click();
  await page.waitForSelector('[data-testid="calendar-event-details"]');
  // The panel fades and zooms in; capturing mid-animation photographs a half-opacity
  // surface and reads as a styling bug that is not there.
  await page.waitForTimeout(250);
  return id;
}

/** Flip one of the view menu's display settings and close the menu again. */
export async function toggleCalendarSetting(
  page: Page,
  key: "showWeekends" | "showDeclined" | "showWeekNumbers",
): Promise<void> {
  await openCalendarViewMenu(page);
  await page.locator(`[data-testid="calendar-setting-${key}"]`).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

/**
 * Open the ⋯ actions menu of the last message, whose reaction bar is the only way
 * in to a reaction (there is no picker on hover).
 *
 * Reaction surfaces only *offer* a reaction — nothing leaves until an emoji is
 * clicked — but they are still write affordances, so these helpers re-assert the
 * mock sentinel like every other one here.
 */
export async function openMessageActions(page: Page): Promise<void> {
  await assertMockBackend(page);
  const message = page.locator('[data-testid="message"]').last();
  await message.hover(); // the trigger only shows on a hovered bubble
  await message.locator('[data-testid="message-actions"]').click();
  await page.waitForSelector('[data-testid="menu-reaction-picker"]');
  await page.waitForTimeout(300); // let the menu's open animation settle
}

/**
 * Open the full emoji picker from the actions menu's quick row. Returns once
 * emoji-mart has mounted and its Apple images (served from our own origin) have
 * had a beat to arrive, so a capture isn't of a half-loaded grid.
 */
export async function openReactionPicker(page: Page): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="menu-reaction-picker"] [data-testid="reaction-more"]').click();
  await page.waitForSelector('[data-testid="emoji-picker"]');
  await page.waitForTimeout(800);
}

/**
 * Open the Settings pane and set Ghost mode on or off, then return to a state a
 * capture can use. Ghost mode decides whether reading a chat is declared to Teams
 * (see the `mark_read` RPC), so the switch is a write affordance like the others
 * here — hence the sentinel — and against the mock it changes nothing but the mock's
 * own settings row.
 */
/**
 * Open the Settings pane, which takes the place of a conversation in the right
 * pane. Every setting — the integration tokens, Ghost mode, appearance — is behind
 * this one click.
 */
export async function openSettings(page: Page): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="open-settings"]').click();
  await page.waitForSelector('[data-testid="settings-pane"]');
}

export async function setGhostMode(page: Page, on: boolean): Promise<void> {
  await openSettings(page);
  const toggle = page.locator('[data-testid="ghost-mode-toggle"]');
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  // Source text, not a closure: this file type-checks under the node tsconfig (no DOM
  // lib), and the body runs in the page — same idiom as `setTheme` above.
  await page.waitForFunction(
    `document.querySelector('[data-testid="ghost-mode-toggle"]')` +
      `?.getAttribute("aria-checked") === ${JSON.stringify(String(on))}`,
  );
  await page.waitForTimeout(200);
}

/**
 * Open the Settings pane and set "Always available" on or off.
 *
 * Against the REAL backend this switch publishes the user's own presence, which every
 * colleague reads — so the sentinel is the point of this helper, not decoration. The
 * mock only remembers the flag, and nothing leaves the machine.
 */
export async function setAlwaysAvailable(page: Page, on: boolean): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="open-settings"]').click();
  const toggle = page.locator('[data-testid="always-available-toggle"]');
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  // Source text, not a closure: this file type-checks under the node tsconfig (no DOM
  // lib), and the body runs in the page — same idiom as `setGhostMode` above.
  await page.waitForFunction(
    `document.querySelector('[data-testid="always-available-toggle"]')` +
      `?.getAttribute("aria-checked") === ${JSON.stringify(String(on))}`,
  );
  await page.waitForTimeout(200);
}

/**
 * Open the first UNREAD chat, which is what has an unread marker to clear. Returns
 * its id like {@link openFirstConversation}, or throws when the fixture set has no
 * unread row left (a previous open in the same session reads them one by one).
 */
export async function openFirstUnreadConversation(page: Page): Promise<string> {
  const row = page.locator('[data-testid="conversation-row"][data-unread="true"]').first();
  if ((await row.count()) === 0) throw new Error("[preview] no unread conversation in the sidebar");
  return openRow(page, row);
}

/**
 * Read the open conversation upward by `screens` viewports, then wait for the
 * history to settle. This is what puts the pane in the one state where the
 * jump-to-latest button matters: the newest message off-screen below.
 *
 * It only scrolls, so it needs no sentinel of its own — but scrolling pulls older
 * pages, hence the dwell before a capture.
 */
export async function scrollHistoryUp(page: Page, screens = 2): Promise<void> {
  // Passed as source text, not a closure: this file type-checks under the node
  // tsconfig (no DOM lib), and the body runs in the page.
  await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    if (el) el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight * ${screens});
  })()`);
  await page.waitForSelector('[data-testid="jump-to-latest"][data-visible="true"]');
  await page.waitForTimeout(400);
}

/**
 * Scroll a sidebar list down by most of a viewport. Returns false once it cannot
 * advance any further, which is how the row search knows the list is exhausted
 * rather than looping forever.
 */
async function scrollDown(page: Page, testid: string): Promise<boolean> {
  // Passed as source text, not a closure: this file type-checks under the node
  // tsconfig (no DOM lib), and the body runs in the page.
  return (await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="${testid}"]');
    if (!el) return false;
    const before = el.scrollTop;
    el.scrollTop = before + el.clientHeight * 0.8;
    return el.scrollTop > before;
  })()`)) as boolean;
}

/** Collapse a row's multi-line text into one readable line for an error message. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Quote a user-supplied name so it matches literally inside a RegExp. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- setup helpers ---------------------------------------------------------

/** Belt and braces: never let a misconfigured port aim this at the real backend. */
function assertPortsAreNotTheBackend(): void {
  for (const port of [MOCK_PORT, WEB_PORT]) {
    if (LIVE_PORTS.includes(port)) {
      throw new Error(
        `PREVIEW_MOCK_PORT/PREVIEW_WEB_PORT must not be ${port} — that port reaches the ` +
          `real account (live ports: ${LIVE_PORTS.join(", ")}).`,
      );
    }
  }
}

/**
 * Refuse to start when either port is already serving.
 *
 * Otherwise we would silently drive *someone else's* app: Vite falls back to
 * another port when its own is taken (`strictPort: false`), so the browser would
 * end up on whatever already answers there — a parallel session's dev server, or
 * anything else. Port squatting is how automation ends up looking at a UI it does
 * not control; make it a hard, explicit failure instead.
 */
async function assertPortsAreFree(): Promise<void> {
  for (const [port, what] of [
    [MOCK_PORT, "PREVIEW_MOCK_PORT"],
    [WEB_PORT, "PREVIEW_WEB_PORT"],
  ] as const) {
    const taken = await fetch(`http://127.0.0.1:${port}/`)
      .then(() => true)
      .catch(() => false);
    if (taken) {
      throw new Error(
        `port ${port} is already serving something — refusing to attach to it. ` +
          `Set ${what} to a free port (e.g. ${port + 10}).`,
      );
    }
  }
}

function startMock(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", "mock/server.ts"], {
    cwd: WEB_DIR,
    env: { ...process.env, PORT: String(MOCK_PORT), MOCK_TEST_HOOKS: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
}

function startWebServer(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", "vite", "dev", "--port", String(WEB_PORT), "--host", "127.0.0.1"], {
    cwd: WEB_DIR,
    // The explicit WS target is what keeps the app off the real backend; the dev
    // build refuses to start without it (see `defaultWsUrl` in lib/ws-client.ts).
    env: { ...process.env, VITE_TEAMS_WS_URL: MOCK_WS_URL },
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function waitForHttp(url: string, what: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`${what} did not come up at ${url} within ${STARTUP_TIMEOUT_MS}ms`);
}

/**
 * Newest cached Playwright chromium. The MCP browser is not installed in this
 * environment, and `playwright-core` ships no browser of its own, so we point at
 * the revision the Playwright test runner already downloaded.
 *
 * Exported for `scripts/sandbox-live.ts`, the live-account twin of this file: one
 * way of finding a browser, so a second driver never grows its own.
 */
export function findChromium(): string {
  const root = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  const revisions = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  const newest = revisions[revisions.length - 1];
  if (!newest) {
    throw new Error(
      `no cached chromium under ${root} — run \`bunx playwright install chromium\` first`,
    );
  }
  return join(root, newest, "chrome-linux64", "chrome");
}

// ---- CLI -------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = flag("--out") ?? "/tmp/preview";
  const text = flag("--type");
  const send = args.includes("--send");
  const incoming = flag("--incoming");
  const react = args.includes("--react");
  const named = flag("--conversation");
  /** Crop every capture of the default branch — or of `--settings` — to one
   *  element, for detail review. */
  const element = flag("--element");
  const dpr = Number(flag("--dpr") ?? 1);
  if (!Number.isFinite(dpr) || dpr < 1 || dpr > 8) {
    throw new Error(`--dpr must be a number between 1 and 8, got "${flag("--dpr")}"`);
  }

  // The sign-in banner: what the sidebar shows when the identity broker stops minting
  // tokens. Driven through the mock's own control plane, so no Intune container is
  // touched — and the banner cannot be seen any other way without breaking sign-in.
  if (args.includes("--broker")) {
    await withPreview(async ({ page, shot, setTheme, emit }) => {
      await emit({
        kind: "broker",
        ok: false,
        signature: "disconnected",
        message: "The identity broker stopped answering. Its keyring is usually locked.",
      });
      await page.locator('[data-testid="broker-banner"]').waitFor({ state: "visible" });
      await shot(`${out}-light.png`);
      await setTheme("dark");
      await shot(`${out}-dark.png`);
      // The other half: a failure a container restart cannot fix keeps the button
      // visible but inert, so the boundary is explicit.
      await emit({
        kind: "broker",
        ok: false,
        signature: "refused",
        message: "The identity broker refused to sign in silently.",
        can_repair: false,
      });
      await page.waitForTimeout(200);
      await shot(`${out}-refused-dark.png`);
      // Leave the shared mock healthy again.
      await emit({ kind: "broker", ok: true });
      console.log(`[preview] wrote ${out}-light.png, ${out}-dark.png and ${out}-refused-dark.png`);
    });
    process.exit(0);
  }

  // The Mail surface: the sidebar's Mail tab plus the reading pane, in both themes.
  if (args.includes("--mail")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openMailTab(page);
      await shot(`${out}-list-light.png`);
      await openFirstMail(page);
      await shot(`${out}-light.png`);
      // The second fixture is the interesting one to look at: file attachments
      // plus an inline image the backend embedded.
      await openMailAt(page, 1);
      await shot(`${out}-attachments-light.png`);
      await setTheme("dark");
      await shot(`${out}-dark.png`);
      console.log(
        `[preview] wrote ${out}-list-light.png, ${out}-light.png, ` +
          `${out}-attachments-light.png and ${out}-dark.png`,
      );
    });
    process.exit(0);
  }

  // The channel surface: the team → channel tree, an open channel, and a folded team.
  if (args.includes("--channels")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openChannelsTab(page);
      await shot(`${out}-tree-light.png`);
      await page.locator('[data-testid="channel-row"]').first().click();
      await page.waitForSelector('[data-testid="message"], [data-testid="system-event"]');
      await shot(`${out}-open-light.png`);
      // A folded team: the header keeps the name and reports what it hides.
      await toggleTeamSection(page, 0);
      await shot(`${out}-collapsed-light.png`);
      await toggleTeamSection(page, 0);
      // A post that is nothing but an app card — a whole class of channel. The
      // thread's own card is that post's surface, so the card renders flush on it
      // instead of as a card inside a card.
      await openConversation(page, "Incidents");
      await page.waitForSelector('[data-testid="card-attachment"]');
      await page.waitForTimeout(300);
      await shot(`${out}-card-light.png`);
      await setTheme("dark");
      await shot(`${out}-card-dark.png`);
      // That post spans its panel, so its actions trigger has no room beside it and
      // floats in its top-right corner instead.
      await openMessageActions(page);
      await shot(`${out}-card-actions-dark.png`);
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="channel-row"]').first().click();
      await page.waitForSelector('[data-testid="message"], [data-testid="system-event"]');
      await shot(`${out}-dark.png`);
      console.log(
        `[preview] wrote ${out}-tree-light.png, ${out}-open-light.png, ` +
          `${out}-collapsed-light.png, ${out}-card-light.png, ${out}-card-dark.png, ` +
          `${out}-card-actions-dark.png and ${out}-dark.png`,
      );
    });
    process.exit(0);
  }

  // The rich link previews: the cards each integration renders for a link pasted
  // into a chat. Both providers, because they share one frame on purpose and the
  // thing worth looking at is whether they still read as one list of cards.
  if (args.includes("--links")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openConversation(page, "Linear Links");
      await page.waitForSelector('[data-testid="linear-link-card"]');
      // Settle the four lookups before capturing, so no card is caught mid-arrival.
      await page.waitForTimeout(600);
      await shot(`${out}-linear-light.png`);
      await openConversation(page, "GitLab Links");
      await page.waitForSelector('[data-testid="gitlab-link-card"]');
      await page.waitForTimeout(600);
      await shot(`${out}-gitlab-light.png`);
      await setTheme("dark");
      await shot(`${out}-gitlab-dark.png`);
      await openConversation(page, "Linear Links");
      await page.waitForSelector('[data-testid="linear-link-card"]');
      await page.waitForTimeout(600);
      await shot(`${out}-linear-dark.png`);
      console.log(
        `[preview] wrote ${out}-{linear,gitlab}-light.png and ${out}-{gitlab,linear}-dark.png`,
      );
    });
    process.exit(0);
  }

  // The Calendar surface: every view, in both themes, plus the details panel and the
  // working-week variant the view menu's settings produce.
  if (args.includes("--calendar")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openCalendarTab(page);
      // The working week, which is the view the calendar opens on.
      await shot(`${out}-week-light.png`);
      // Again with every calendar on: multi-day bars, lanes and the colour coding
      // only show once there is more than one source.
      await enableAllCalendars(page);
      await shot(`${out}-week-all-light.png`);
      // The details panel opens BESIDE the event it describes, so it is only worth
      // looking at over a view that has something around it.
      await openFirstEvent(page);
      await shot(`${out}-details-light.png`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await openCalendarView(page, "month");
      await shot(`${out}-month-light.png`);
      await openCalendarView(page, "day");
      await shot(`${out}-day-light.png`);
      await openCalendarView(page, "agenda");
      await shot(`${out}-agenda-light.png`);
      // Weekends and week numbers on: the two columns and the leading column the view
      // menu adds to the default grid.
      await openCalendarView(page, "month");
      await toggleCalendarSetting(page, "showWeekends");
      await toggleCalendarSetting(page, "showWeekNumbers");
      await shot(`${out}-weekends-light.png`);
      await toggleCalendarSetting(page, "showWeekends");
      await toggleCalendarSetting(page, "showWeekNumbers");
      // Mobile: the grid IS the page there, and the details arrive as a dialog — a
      // 320px panel pinned beside a full-width event has nowhere to go.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await shot(`${out}-mobile-light.png`);
      await openFirstEvent(page);
      await shot(`${out}-mobile-details-light.png`);
      await page.keyboard.press("Escape");
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(400);
      await setTheme("dark");
      await shot(`${out}-month-dark.png`);
      await openCalendarView(page, "week");
      await shot(`${out}-week-dark.png`);
      console.log(
        `[preview] wrote ${out}-{week,week-all,details,month,day,agenda,weekends,mobile,` +
          `mobile-details}-light.png and ${out}-{month,week}-dark.png`,
      );
    });
    process.exit(0);
  }

  // "Always available": the one setting other people can see. Both states, because the
  // copy under the switch is what tells the user who reads the green dot.
  if (args.includes("--available")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      // The pane scrolls, and this section sits below the integrations — so bring it
      // into view before every capture, or the shot is of GitLab's token field.
      const section = page.locator('[data-testid="always-available-settings"]');
      await setAlwaysAvailable(page, false);
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(`${out}-off-light.png`);
      await setAlwaysAvailable(page, true);
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(`${out}-on-light.png`);
      await setTheme("dark");
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(`${out}-on-dark.png`);

      // Leave the shared mock as it was found.
      await setTheme("light");
      await setAlwaysAvailable(page, false);
      console.log(`[preview] wrote ${out}-{off,on}-light.png and ${out}-on-dark.png`);
    });
    process.exit(0);
  }

  // The read state: an unread chat losing its marker when it is opened, and the same
  // read taken in Ghost mode — where the marker clears but Teams is never told, which
  // the row says with a ghost beside it. Both halves are only visible in the sidebar,
  // so each capture is of the whole window.
  if (args.includes("--ghost")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      // The setting itself first: off by default, which is the state to review.
      await setGhostMode(page, false);
      await shot(`${out}-settings-light.png`);

      // A normal read: the marker goes, and nothing takes its place.
      await openFirstUnreadConversation(page);
      await page.waitForTimeout(400);
      await shot(`${out}-read-light.png`);

      // The same read with Ghost mode on: marker gone, ghost shown.
      await setGhostMode(page, true);
      await shot(`${out}-settings-on-light.png`);
      await openFirstUnreadConversation(page);
      await page.waitForSelector('[data-testid="ghost-read-mark"]');
      await page.waitForTimeout(400);
      await shot(`${out}-ghost-light.png`);
      await setTheme("dark");
      await shot(`${out}-ghost-dark.png`);

      // Leave the shared mock as it was found, or a later capture runs in Ghost mode.
      await setTheme("light");
      await setGhostMode(page, false);
      console.log(
        `[preview] wrote ${out}-{settings,read,settings-on,ghost}-light.png and ` +
          `${out}-ghost-dark.png`,
      );
    });
    process.exit(0);
  }

  // The Settings surface: the integration sections at the top of the pane, in both
  // themes. Two of them are headed by a third party's own logo, which ships one file
  // per theme, so a capture of one theme proves only half of it.
  if (args.includes("--settings")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        await openSettings(page);
        await shot(`${out}-light.png`, element);
        await setTheme("dark");
        await shot(`${out}-dark.png`, element);
        console.log(`[preview] wrote ${out}-light.png and ${out}-dark.png`);
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  await withPreview(
    async ({ page, shot, setTheme, emit }) => {
      const conversation = named
        ? await openConversation(page, named)
        : await openFirstConversation(page);
      // Inject the other side's message first, so a `--type` draft (or the message
      // it sends) stays the last thing in the thread.
      if (incoming !== undefined) {
        await emit({ conversation, content: incoming });
        await page.waitForTimeout(500);
      }
      if (text) await typeInComposer(page, text, { send });
      // The history scrolled up: the state that shows the jump-to-latest button
      // floating over the bottom of the messages, above the composer.
      if (args.includes("--scrolled")) {
        await scrollHistoryUp(page);
        await shot(`${out}-scrolled-light.png`);
        await setTheme("dark");
        await shot(`${out}-scrolled-dark.png`);
        await setTheme("light");
      }
      if (react) {
        // Chips first (from the mock, not from us clicking): one classic key and one
        // of the extended ones a real tenant sends, so a capture shows both paths.
        const messages = page.locator("[data-message-id]");
        const count = await messages.count();
        for (const [index, key] of [
          [Math.max(0, count - 4), "1f389_partypopper"],
          [Math.max(0, count - 3), "heart"],
        ] as const) {
          const id = await messages.nth(index).getAttribute("data-message-id");
          if (id) await emit({ kind: "reaction", conversation, message_id: id, key, count: 2 });
        }
        await page.waitForTimeout(400);
        // Three states worth reviewing: chips, the menu's quick row, then the full
        // picker.
        await shot(`${out}-chips-light.png`);
        await setTheme("dark");
        await shot(`${out}-chips-dark.png`);
        await setTheme("light");
        await openMessageActions(page);
        await shot(`${out}-row-light.png`);
        await openReactionPicker(page);
      }
      await shot(`${out}-light.png`, element);
      await setTheme("dark");
      await shot(`${out}-dark.png`, element);
      console.log(`[preview] wrote ${out}-light.png and ${out}-dark.png`);
    },
    { deviceScaleFactor: dpr },
  );
}
