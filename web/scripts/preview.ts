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
//   bun run web/scripts/preview.ts --out /tmp/mr --gitlab       # the merge-request page
//   bun run web/scripts/preview.ts --out /tmp/pipe --pipeline    # its pipeline graph
//   bun run web/scripts/preview.ts --out /tmp/diff --diff       # the Changes section
//   bun run web/scripts/preview.ts --out /tmp/dc --diff-comment # a comment on a diff line
//   bun run web/scripts/preview.ts --out /tmp/log --job-log     # one CI job's log
//   bun run web/scripts/preview.ts --out /tmp/links --links      # Linear + GitLab link cards
//   bun run web/scripts/preview.ts --out /tmp/img --image       # the picture lightbox
//   bun run web/scripts/preview.ts --out /tmp/pics --compose-images # several pending images
//   bun run web/scripts/preview.ts --out /tmp/preview --react   # reaction chips + emoji picker
//   bun run web/scripts/preview.ts --out /tmp/del --delete      # delete: menu, confirm, placeholder
//   bun run web/scripts/preview.ts --out /tmp/preview --scrolled # history scrolled up (jump button)
//   bun run web/scripts/preview.ts --out /tmp/ghost --ghost     # read state + Ghost mode
//   bun run web/scripts/preview.ts --out /tmp/set --settings    # the Settings pane
//   bun run web/scripts/preview.ts --out /tmp/person --person   # rename + custom avatar
//   bun run web/scripts/preview.ts --out /tmp/agent --agent     # the local-agent menu
//   bun run web/scripts/preview.ts --out /tmp/reply --agent-reply  # the agent answering
//   bun run web/scripts/preview.ts --out /tmp/prov --ai-providers # Settings › AI providers
//   bun run web/scripts/preview.ts --out /tmp/app --maintenance # Settings › This app
//   bun run web/scripts/preview.ts --out /tmp/at --mentions     # the @mention list + chip
//   bun run web/scripts/preview.ts --out /tmp/tag --agent-tag   # tagging an agent
//   bun run web/scripts/preview.ts --out /tmp/ca --custom-agents # the user's own agents
//   bun run web/scripts/preview.ts --out /tmp/ref --tracker-refs # a reference as a chip
//   bun run web/scripts/preview.ts --out /tmp/ask --answer-with # "Answer with <agent>" on a message
//   bun run web/scripts/preview.ts --out /tmp/mr --merge-request # review + approve a merge request
//   bun run web/scripts/preview.ts --out /tmp/chat --chat-menu  # chat sections + the row's "…" menu
//   bun run web/scripts/preview.ts --out /tmp/seal --seal       # a chat whose words are encrypted
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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ENGINE_SERVED } from "../engine-file";

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
  /** A PHONE with a finger: a narrow viewport AND a coarse pointer. Several captures set the
   *  viewport themselves, which is enough for what a narrow screen LAYS OUT — but not for what
   *  a touch device is offered at all, since the affordances a hold replaces are behind
   *  `@media (pointer: coarse)`. A mode reviewing one of those needs this. */
  phone?: boolean;
};

/** What `phone` emulates: Playwright's own Pixel 7, minus its Chrome-on-Android user agent —
 *  the app reads the pointer and the width, and nothing about it reads a UA string. */
const PHONE = { viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true } as const;

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
      ...(options.phone ? PHONE : {}),
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
        // Through the OS query, which is the app's OWN path into a theme: the default
        // appearance is `system`, so the store hears the change, repaints `data-theme`
        // and updates `resolvedTheme` with it. Writing the attribute from here instead
        // left the two disagreeing — the palette was dark while the app still believed
        // it was light — so anything drawn FROM the app's theme (the update button's orb,
        // the emoji picker) was captured in the wrong one, and the capture said nothing.
        // It has to be the query rather than a reload, because a capture mid-flow (a
        // download in progress, a live agent run) would not survive one.
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForFunction(
          `document.documentElement.getAttribute("data-theme") === ${JSON.stringify(theme)}`,
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
  // The composer has one field and it is the rich editor, so type in the editable
  // itself: its wrapper takes no keystrokes.
  const composer = page.locator('[data-testid="composer-rich"] .tiptap-message').first();
  await composer.click();
  await composer.pressSequentially(text, { delay: 5 });
  if (opts.send) {
    await assertMockBackend(page); // last check, right before the message leaves
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
  }
}

/**
 * Empty the composer, so a capture starts from a field nobody wrote in.
 *
 * Worth a helper because the mock persists drafts for the whole run: whatever an earlier
 * step (or an earlier flow) left in this thread is still there, and a leftover word in
 * front of the caret is not a mention query. It only deletes, and only in the app's own
 * field, but it asserts the sentinel like every other keystroke does.
 */
export async function clearComposer(page: Page): Promise<void> {
  await assertMockBackend(page);
  const composer = page.locator('[data-testid="composer-rich"] .tiptap-message').first();
  await composer.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
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

/**
 * Open the "…" menu on a chat row — Teams' own settings for that chat (pin, mute,
 * hide, mark read; see `web/src/components/chat-menu.tsx`). Returns the chat's id.
 *
 * The chat is named by its id, not by its place in the list: the list is virtualized
 * AND the menu moves a row between sections, so a position is only ever a guess about
 * what is on screen. Without an id the first row on screen is used.
 *
 * The trigger only shows on hover, so this hovers the row first, exactly as a person
 * does. Every item in the menu is a local setting or the same `mark_read` the app makes
 * on open, and none of them types into a thread — but the sentinel is asserted all the
 * same, because a menu that can mark a chat read publishes a read receipt.
 */
export async function openChatMenu(page: Page, conversationId?: string): Promise<string> {
  await assertMockBackend(page);
  const row = conversationId
    ? page.locator(`[data-testid="conversation-row"][data-conversation-id="${conversationId}"]`)
    : page.locator('[data-testid="conversation-row"]').first();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  // An item that was just clicked closes the menu with an animation, and the trigger
  // TOGGLES — so a click landing while the last panel is still closing is swallowed.
  await page.waitForSelector('[data-testid="chat-menu-pin"]', { state: "detached" });
  const id = (await row.getAttribute("data-conversation-id")) ?? "";
  await page.locator(`[data-testid="chat-menu"][data-conversation-id="${id}"]`).click();
  await page.waitForSelector('[data-testid="chat-menu-pin"]');
  await page.waitForTimeout(250); // the panel zooms in; capture it settled
  return id;
}

/** Collapse (or expand) the chat-list section named by `section` (`pinned`,
 *  `recent` or `hidden`), by its header — the same toggle a person clicks. */
export async function toggleChatSection(
  page: Page,
  section: "pinned" | "recent" | "hidden",
): Promise<void> {
  const header = page.locator(`[data-testid="chat-section-header"][data-section="${section}"]`);
  // The chat list is virtualized and a header is a row in it, so the Hidden one at the
  // foot of 34 chats is simply not in the DOM until the list has been scrolled to it.
  while ((await header.count()) === 0) {
    if (!(await scrollDown(page, "sidebar-scroll"))) {
      throw new Error(`no "${section}" section in the chat list, after scrolling to its end`);
    }
    await page.waitForTimeout(150);
  }
  await header.click();
  await page.waitForTimeout(250); // the chevron rotates; capture it settled
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
 * Switch the sidebar to the GitLab tab and wait for its list to populate.
 *
 * The merge requests load lazily — nothing is fetched until this tab is first shown — so a
 * caller must go through here rather than assuming rows exist.
 *
 * Reading merge requests is a pure read. The page's four WRITES (merge, comment, delete a
 * comment, close) are exercised here too, and that is safe for exactly one reason: this only
 * ever runs inside `withPreview`, which proved the backend was the mock before handing over
 * the page. There is no GitLab and no token behind it — see the `gitlab_mr_*` fixtures in
 * web/mock/server.ts.
 */
export async function openGitLabTab(page: Page): Promise<void> {
  await page.locator('[data-testid="tab-gitlab"]').click();
  await page.waitForSelector('[data-testid="gitlab-row"]', { timeout: APP_READY_TIMEOUT_MS });
}

/** Open the merge request at `index` in the list and wait for its page. Returns its
 *  reference ("!596"), which is what a report names it by. */
export async function openMergeRequestAt(page: Page, index: number): Promise<string> {
  const row = page.locator('[data-testid="gitlab-row"]').nth(index);
  const iid = (await row.getAttribute("data-iid")) ?? "";
  await row.click();
  await page.waitForSelector('[data-testid="gitlab-heading"]', { timeout: APP_READY_TIMEOUT_MS });
  // The pipeline and the comments arrive in their own round-trips; wait for the pipeline
  // panel to settle on something rather than catching it mid-read.
  await page
    .locator(
      '[data-testid="gitlab-pipeline-status"], [data-testid="gitlab-no-pipeline"]',
    )
    .first()
    .waitFor({ timeout: APP_READY_TIMEOUT_MS });
  return `!${iid}`;
}

/**
 * Move to one of the four PAGES of the open merge request through the sub-header the reader
 * presses — Overview, Commits, Pipelines or Diffs (see lib/gitlab-mr-pages.ts).
 *
 * Each is a route, so this is a navigation rather than a piece of state being swapped. The
 * WAIT is on the strip's own statement of which page is current, which is present on all four
 * — the diff page carries the same strip — and never on the body, since two of the four
 * deliberately hold nothing.
 */
export async function openMergeRequestPage(
  page: Page,
  name: "overview" | "commits" | "pipelines" | "diffs",
): Promise<void> {
  await page.locator(`[data-testid="gitlab-mr-page-${name}"]`).click();
  await page.waitForSelector(`[data-testid="gitlab-mr-pages"][data-page="${name}"]`, {
    timeout: APP_READY_TIMEOUT_MS,
  });
}

/**
 * Open one JOB's LOG from the pipeline page, by the job's own name, and wait for its lines.
 *
 * A card is a LINK (the graph holds no buttons — see `gitlab-pipeline-graph.tsx`), so this is a
 * navigation: what it waits for is the log page's own container plus a first row, because the read
 * is a round trip and a capture taken before it lands is a capture of "Reading the log…".
 */
export async function openJobLog(page: Page, jobName: string): Promise<void> {
  await page.locator(`[data-testid="gitlab-pipeline-job"][data-name="${jobName}"]`).click();
  await page.waitForSelector('[data-testid="gitlab-job-log-page"]', {
    timeout: APP_READY_TIMEOUT_MS,
  });
  await page
    .locator('[data-testid="gitlab-job-log-line"], [data-testid="gitlab-job-log-empty"]')
    .first()
    .waitFor({ timeout: APP_READY_TIMEOUT_MS });
}

/** Open the PIPELINE page of the open merge request, and wait for its graph.
 *
 *  The wait is on the graph's own container rather than on the route: the page paints from the
 *  read the merge request already made, so what a capture has to wait for is the cards being
 *  laid out and the curves being MEASURED off them (see `useEdgePaths` — the paths exist only
 *  after a layout pass). */
export async function openPipelinePage(page: Page): Promise<void> {
  await page.locator('[data-testid="gitlab-pipeline-open"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="gitlab-pipeline-open"]').click();
  await page.waitForSelector('[data-testid="gitlab-pipeline-page"]', {
    timeout: APP_READY_TIMEOUT_MS,
  });
  await page.waitForSelector('[data-testid="gitlab-pipeline-job"]', {
    timeout: APP_READY_TIMEOUT_MS,
  });
  // One frame past the layout, so the curves are drawn on the cards rather than at nothing.
  await page.waitForTimeout(300);
}

/** Group the pipeline graph by `stage` or by `needs`, through the control a reader presses. */
export async function setPipelineGrouping(page: Page, grouping: "stage" | "needs"): Promise<void> {
  await page
    .locator(`[data-testid="gitlab-pipeline-grouping"] [data-value="${grouping}"]`)
    .click();
  await page.waitForSelector(`[data-testid="gitlab-pipeline-graph"][data-grouping="${grouping}"]`, {
    timeout: APP_READY_TIMEOUT_MS,
  });
  await page.waitForTimeout(250);
}

/** Scroll the Changes section into view and wait for the diff FEED to be drawn.
 *
 *  The wait is for a file's own header rather than the feed's box: the box paints from the read,
 *  and what takes time after that is the lazy chunk (`@pierre/diffs` carries Shiki) and then the
 *  grammar for the first files' languages. A shot taken before both is a shot of the
 *  "Highlighting…" placeholder. */
export async function openChanges(page: Page): Promise<void> {
  await page.locator('[data-testid="gitlab-review-changes"]').scrollIntoViewIfNeeded();
  await page.locator('[data-testid="gitlab-review-changes"]').click();
  await page.waitForSelector('[data-testid="gitlab-diff-page"]', {
    timeout: APP_READY_TIMEOUT_MS,
  });
  // ATTACHED rather than visible: the header's sentinel is data — a file with nothing to say
  // beside its name draws no ink at all, which is most files.
  await page.waitForSelector('[data-testid="gitlab-diff-feed"] [data-testid="gitlab-diff-file"]', {
    state: "attached",
    timeout: APP_READY_TIMEOUT_MS,
  });
  // The highlighter resolves its grammar and theme asynchronously, so the rows exist before
  // they hold any code. One frame past that is what makes a capture readable.
  await page.waitForTimeout(800);
}

/** Bring one file of the feed to the top by clicking its row in the tree.
 *
 *  The tree renders inside a shadow root, and Playwright's CSS engine pierces an open one — so
 *  this drives the row a reader would press rather than the store behind it. `data-item-path`
 *  is `@pierre/trees`' own attribute per row; the WAIT is on the PANE's own statement of which
 *  file the reader is at, which is what proves the click reached the page rather than only the
 *  tree.
 *
 *  What is asserted afterwards is always the app's own `[data-testid]`s. Reaching further into
 *  a vendor's markup would be a test of their release notes. */
export async function pickDiffFile(page: Page, path: string): Promise<void> {
  await page.locator(`[data-item-path="${path}"]`).first().click();
  await page.waitForSelector(`[data-testid="gitlab-diff-pane"][data-path="${path}"]`, {
    timeout: APP_READY_TIMEOUT_MS,
  });
  // A file whose language the highlighter has not loaded yet resolves one more grammar, and the
  // feed has just scrolled to it.
  await page.waitForTimeout(600);
}

/**
 * Scroll the diff's feed the way a reader does — the wheel over the code.
 *
 * Through the pointer rather than by writing `scrollTop`, because the feed is virtualized: the
 * renderer mounts what the viewport reaches, measures it, and holds the scroll anchored while it
 * does. A capture taken after a scripted assignment can be a capture of a frame no reader ever
 * sees.
 */
export async function scrollDiffFeed(page: Page, by: number): Promise<void> {
  const feed = page.locator('[data-testid="gitlab-diff-feed"]');
  await feed.hover();
  await page.mouse.wheel(0, by);
  // The renderer settles over a frame or two: it mounts the files the scroll reached, resolves
  // their grammars and corrects the layout it had only estimated.
  await page.waitForTimeout(900);
}

/**
 * One FILE of the feed, as the renderer's own element.
 *
 * The element carries no path of its own, so it is found by the header slot this app renders
 * into it (`gitlab-diff-file`, a light-DOM child of that element). It is what scopes a line
 * number to one file, which in a feed of 149 files is the whole difference between commenting on
 * the code the reader means and on line 42 of something else.
 */
export function diffFileItem(page: Page, path: string) {
  return page
    .locator(`diffs-container:has([data-testid="gitlab-diff-file"][data-path="${path}"])`)
    .first();
}

/**
 * One line NUMBER in the gutter of one file of the feed — where the comment gesture starts.
 *
 * The FILE, the number and the SIDE together. The file because the feed holds them all; the side
 * because in a unified diff an old line and a new line can wear the same number: three lines
 * down a change block, `3` is both the line that went and the line that came. So neither is
 * decoration, and the side's default is the new one, which is what a reviewer comments on.
 *
 * `data-column-number` and `data-line-type` are `@pierre/diffs`' own attributes on a gutter
 * cell, and Playwright's CSS engine pierces the open shadow root they live in. Everything
 * ASSERTED afterwards is this app's own `[data-testid]`.
 */
export function diffGutterLine(
  page: Page,
  path: string,
  line: number,
  side: "additions" | "deletions" = "additions",
) {
  const types =
    side === "additions"
      ? ["context", "addition", "change-addition"]
      : ["context", "deletion", "change-deletion"];
  const selector = types
    .map((type) => `[data-column-number="${line}"][data-line-type="${type}"]`)
    .join(", ");
  return diffFileItem(page, path).locator(`:is(${selector})`).first();
}

/**
 * Drag down the gutter from one line number to another — the gesture that comments on several
 * lines at once.
 *
 * Driven with the mouse rather than through the store, because the drag IS the feature: it is
 * pierre's interaction manager following a pointer, and the steps matter — a jump straight from
 * one point to the other fires no move between them and would select one line.
 */
export async function dragDiffLines(
  page: Page,
  path: string,
  from: number,
  to: number,
  side: "additions" | "deletions" = "additions",
): Promise<void> {
  const start = await diffGutterLine(page, path, from, side).boundingBox();
  const end = await diffGutterLine(page, path, to, side).boundingBox();
  if (!start || !end) throw new Error(`[preview] no gutter line ${from} or ${to} to drag between`);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 });
  await page.mouse.up();
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

/** Open one NAMED event's details panel, for a capture that needs the fixture's own
 *  shape — a meeting with a join link and a real invitation body, which `.first()` is a
 *  coin toss for. Same pane scoping and the same wait as {@link openFirstEvent}. */
export async function openEvent(page: Page, id: string): Promise<void> {
  await page
    .locator(`[data-testid="calendar-pane"] [data-testid="calendar-event"][data-event-id="${id}"]`)
    .first()
    .click();
  await page.waitForSelector('[data-testid="calendar-event-details"]');
  await page.waitForTimeout(250);
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
export async function openMessageActions(
  page: Page,
  opts: { mine?: boolean } = {},
): Promise<void> {
  await assertMockBackend(page);
  // `mine` picks one of OUR messages, which is the only kind offering Edit and
  // Delete — a menu on somebody else's message is a different, shorter menu.
  const messages = opts.mine
    ? page.locator('[data-testid="message"][data-mine="true"]')
    : page.locator('[data-testid="message"]');
  const message = messages.last();
  await message.hover(); // the trigger only shows on a hovered bubble
  await message.locator('[data-testid="message-actions"]').click();
  await page.waitForSelector('[data-testid="menu-reaction-picker"]');
  await page.waitForTimeout(300); // let the menu's open animation settle
}

/**
 * Arm the deletion confirmation in the open actions menu. The first select of
 * "Delete" deletes nothing: it holds the menu open and swaps the row for "Delete for
 * everyone", because a deletion is the one outward action nothing takes back.
 *
 * Nothing leaves the machine here — the backend is the mock — but this is the
 * approach to a write, so the sentinel is re-asserted like every other helper's.
 */
export async function armDeleteConfirmation(page: Page): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="action-delete"]').click();
  await page.waitForSelector('[data-testid="action-delete-confirm"]');
  await page.waitForTimeout(200);
}

/**
 * Open the full emoji picker from the actions menu's quick row. Returns once
 * emoji-mart has mounted and its Apple images (served from our own origin) have
 * had a beat to arrive, so a capture isn't of a half-loaded grid.
 */
/**
 * Open a chat image in the lightbox and wait for its travel to end, so a capture
 * shows the picture where it lands rather than mid-flight.
 *
 * `thumb` is the picture to open — pass one from the message you mean, since the
 * gallery holds several and the interesting one is the smallest.
 */
export async function openImageLightbox(
  page: Page,
  thumb: ReturnType<Page["locator"]>,
): Promise<void> {
  await thumb.waitFor({ state: "visible" });
  await thumb.click();
  await page.waitForSelector('dialog[data-testid="image-lightbox"][data-phase="open"]');
  await page.waitForTimeout(500);
}

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
/**
 * Open the menu in the header of the conversation on screen — the ONE control that header
 * carries, and everything the conversation offers is inside it: the call it places or the
 * meeting it joins, a game of chess, whether the chat is encrypted, and whether this thread
 * answers an `@claude` message (`web/src/components/conversation-menu.tsx`).
 *
 * The sentinel is asserted here rather than at each row, because every outward action a
 * conversation has is now one press behind this one: against the real backend a click in here
 * rings somebody's phone, posts a challenge under the user's name, or tells a machine it may
 * answer for them.
 */
export async function openConversationMenu(page: Page): Promise<void> {
  await assertMockBackend(page);
  // IDEMPOTENT, because the mock's live feed re-renders the pane every few seconds and a
  // non-modal Radix menu can be unmounted in that window — so a capture that switches theme
  // between two shots of this menu may find it gone. Calling this again before each shot is
  // cheap and re-asserts the sentinel; a bare click would toggle an open menu shut instead.
  if (!(await page.locator('[data-testid="conversation-menu-content"]').count())) {
    await page.locator('[data-testid="conversation-menu"]').click();
  }
  // The agent switch, which is the one row EVERY conversation has: a channel offers no call,
  // Notes offers no game, and neither can be waited on as proof the menu is open.
  await page.waitForSelector('[data-testid="agent-mode-toggle"]');
}

/**
 * Close it again by pressing its own trigger — never with Escape, which the app's own
 * window-level handler reads as "leave this conversation" and which would take the composer off
 * screen with the menu.
 */
export async function closeConversationMenu(page: Page): Promise<void> {
  if (!(await page.locator('[data-testid="conversation-menu-content"]').count())) return;
  await page.locator('[data-testid="conversation-menu"]').click();
  await page.waitForSelector('[data-testid="conversation-menu-content"]', { state: "detached" });
}

/**
 * The local-agent half of that menu, which is what most captures of it are about: where this
 * machine answers, and what the program it runs may read.
 *
 * It is the same menu — the agent switch stopped having a trigger of its own when the header's
 * three controls became one — so this is an alias kept for the captures that name it, and for
 * the reader who comes looking for the old surface.
 */
export async function openAgentMenu(page: Page): Promise<void> {
  await openConversationMenu(page);
}

/**
 * Open that menu and press the row that places a CALL — one person in a 1:1, everybody at once
 * in a group chat.
 *
 * A call is two presses now, which is the cost the one-trigger header pays for a target that
 * does not move between conversations; this helper is where that cost is spelled once rather
 * than at every capture.
 */
export async function callFromMenu(page: Page): Promise<void> {
  await openConversationMenu(page);
  await page.locator('[data-testid="call-button"]').click();
  await page.waitForSelector('[data-testid="conversation-menu-content"]', { state: "detached" });
}

/**
 * Open that menu and press the row that JOINS the meeting this thread was minted for.
 *
 * Only a MEETING chat offers it, and only there: a calendar event keeps its own labelled
 * "Join here" beside its way out to Teams, so a capture of that surface clicks the button
 * directly and never comes through here.
 */
export async function joinMeetingFromMenu(page: Page): Promise<void> {
  await openConversationMenu(page);
  await page.locator('[data-testid="meeting-join-here"]').click();
  await page.waitForSelector('[data-testid="conversation-menu-content"]', { state: "detached" });
}

export async function openSettings(page: Page): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="open-settings"]').click();
  await page.waitForSelector('[data-testid="settings-pane"]');
}

/**
 * Opt the open thread into agent replies, from that thread's own header — which is the
 * only place the app offers it, and on purpose (the consent belongs where the user can
 * see who reads the thread).
 *
 * A write affordance, so it re-asserts the sentinel: against the real backend this click
 * is what tells a machine it may post under the user's name.
 */
export async function turnAgentOn(page: Page): Promise<void> {
  await assertMockBackend(page);
  // The conversation's own menu, which is where the switch lives now — and which still states
  // the mode on its trigger, so what is checked below is the app's own attribute rather than
  // our memory of clicking.
  const menu = page.locator('[data-testid="conversation-menu"]');
  const isOn = async () => (await menu.getAttribute("data-agent-mode")) === "reply";

  // Retried, because the mock's live feed re-renders the pane every few seconds and a
  // non-modal Radix menu can be unmounted between opening it and reaching its switch.
  // The state that is checked is the app's own attribute, never our memory of clicking.
  for (let attempt = 0; attempt < 3 && !(await isOn()); attempt += 1) {
    try {
      await menu.click({ timeout: 5_000 });
      const toggle = page.locator('[data-testid="agent-mode-toggle"]');
      await toggle.waitFor({ state: "visible", timeout: 5_000 });
      await toggle.click({ timeout: 5_000 });
      await page.waitForFunction(
        `document.querySelector('[data-testid="conversation-menu"]')?.getAttribute("data-agent-mode") === "reply"`,
        undefined,
        { timeout: 5_000 },
      );
    } catch {
      await page.waitForTimeout(300);
    }
  }
  if (!(await isOn())) throw new Error("[preview] could not opt the thread into agent replies");

  // Close the menu by clicking the trigger again, NOT with Escape: the app's
  // window-level handler reads Escape as "close the conversation", so that key would
  // take the composer off screen along with the menu.
  if ((await page.locator('[data-testid="agent-mode-toggle"]').count()) > 0) {
    await menu.click();
    await page.waitForSelector('[data-testid="agent-mode-toggle"]', { state: "detached" });
  }
  await page.waitForTimeout(200);
}

/**
 * Summon the local agent in the open thread and wait for the run to reach `phase`.
 *
 * The mock answers an `@claude` message the same way the backend does — it posts a
 * placeholder, narrates the run on `agent_stream`, and edits the message on the way (see
 * `simulateMockAgentRun` in web/mock/server.ts) — so this drives the whole streaming
 * surface without a CLI, a tenant or a single real send.
 */
export async function askAgent(page: Page, prompt: string): Promise<void> {
  await typeInComposer(page, prompt, { send: true });
  // Only that the run is on screen. Waiting for a NAMED phase would be a race the
  // script loses: `thinking` and `working` last a beat each, and a wait that has to
  // re-poll (a re-render detaches the node) can miss the window it was waiting for.
  // The caller waits for the durable things instead — the tool chip, the writing phase.
  await page.waitForSelector('[data-testid="agent-stream"]', { timeout: 30_000 });
}

/**
 * Park the open thread back on its newest message.
 *
 * Needed after an element capture: Playwright scrolls a cropped element into view, and
 * the history is virtualized — so the rows that were at the bottom get unmounted, and a
 * following `waitForSelector` on one of them waits forever. It only scrolls, so it needs
 * no sentinel.
 */
export async function scrollToNewest(page: Page): Promise<void> {
  // Source text, not a closure: this file type-checks under the node tsconfig (no DOM
  // lib), and the body runs in the page — the same idiom as `setTheme`.
  await page.evaluate(
    `(() => {
       const el = document.querySelector('[data-testid="message-scroll"]');
       if (el) el.scrollTop = el.scrollHeight;
     })()`,
  );
  await page.waitForTimeout(300);
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
 * Set the HOURS that switch keeps, or clear them back to all day (`null`).
 *
 * The sentinel again: against the real backend these two fields decide when the user's own
 * status is published, so a driver that typed into them without proving the backend is a
 * mock is the failure § Automation safety exists for.
 */
export async function setAvailableHours(
  page: Page,
  hours: { from: string; to: string } | null,
): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="open-settings"]').click();
  const from = page.locator('[data-testid="available-from"]');
  await from.waitFor({ state: "visible" });
  if (hours) {
    await from.fill(hours.from);
    await page.locator('[data-testid="available-to"]').fill(hours.to);
  } else {
    await page.locator('[data-testid="available-all-day"]').click();
  }
  await page.waitForTimeout(300);
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
    env: {
      ...process.env,
      PORT: String(MOCK_PORT),
      MOCK_TEST_HOOKS: "1",
      // Pace the simulated agent run for somebody LOOKING at it: each phase has to
      // last long enough to be captured, and to be read in a recording. The E2E suite
      // sets its own (faster) value, and so may the caller.
      MOCK_AGENT_STEP_MS: process.env.MOCK_AGENT_STEP_MS ?? "650",
      // Same reasoning for a call: the ring, the lobby and the roster each have to last
      // long enough to be captured and to be read in a recording.
      MOCK_CALL_ANSWER_MS: process.env.MOCK_CALL_ANSWER_MS ?? "1800",
      MOCK_CALL_CONNECT_MS: process.env.MOCK_CALL_CONNECT_MS ?? "2600",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

/**
 * THE CHESS ENGINE, stood in for — the same substitution the E2E run makes.
 *
 * A game against the computer loads a Worker from the path the backend names, out of the directory
 * `TEAMS_LITE_ENGINE_DIR` points at (see src/chess_engine.rs and engine-file.ts). The real engine is
 * 7.3 MB, so a capture writes the STUB there instead — `web/mock/engine-stub.js`, which asks the mock
 * for a legal move — and the shot is of a game that really advances. It stands in for the BYTES and
 * never for the address: the route, the Worker-path guard and the whole UCI exchange are the real
 * ones, and this can never be reached in production, where a backend installs only what it hashed.
 */
function engineStubDir(): string {
  const dir = join(tmpdir(), `teams-lite-preview-engine-${MOCK_PORT}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ENGINE_SERVED[0]!.name),
    readFileSync(join(WEB_DIR, "mock", "engine-stub.js"), "utf8").replace(
      "__MOCK_ORIGIN__",
      `http://127.0.0.1:${MOCK_PORT}`,
    ),
  );
  return dir;
}

function startWebServer(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", "vite", "dev", "--port", String(WEB_PORT), "--host", "127.0.0.1"], {
    cwd: WEB_DIR,
    // The explicit WS target is what keeps the app off the real backend; the dev
    // build refuses to start without it (see `defaultWsUrl` in lib/ws-client.ts).
    env: {
      ...process.env,
      VITE_TEAMS_WS_URL: MOCK_WS_URL,
      // The STUB by default, and the REAL engine when the caller names a directory holding it:
      //   TEAMS_LITE_ENGINE_DIR=/path/to/engine bun run preview -- --out /tmp/chess --chess
      // which is how one checks that 7.3 MB of WebAssembly really plays a move in a browser.
      TEAMS_LITE_ENGINE_DIR: process.env.TEAMS_LITE_ENGINE_DIR ?? engineStubDir(),
    },
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

  // Signing in again: the banner's second button, the panel that usually needs nobody, the
  // broker's own window served into the app, the words a reader acts on, and the two ways a
  // sign-in ends. Driven through the mock's own control plane — the real thing needs a Primary
  // Refresh Token that has expired, which is not a state a capture can arrange (SIGN-IN.md § 4).
  if (args.includes("--signin")) {
    await withPreview(async ({ page, shot, setTheme, emit }) => {
      const panel = '[data-testid="signin-panel"]';
      const broken = {
        kind: "broker",
        ok: false,
        signature: "refused",
        message: "The identity broker refused to sign in silently.",
        can_repair: false,
        can_sign_in: true,
      };

      // The offer: the failure a container restart cannot fix, with the button that answers it.
      await emit(broken);
      await page.locator('[data-testid="broker-signin"]').waitFor({ state: "visible" });
      await shot(`${out}-offered-light.png`);
      await setTheme("dark");
      await shot(`${out}-offered-dark.png`, '[data-testid="broker-banner"]');
      await setTheme("light");

      // The common case, and the one worth capturing first: the machine does it on its own and
      // no page is ever shown.
      await emit({ kind: "signin", outcome: "immediate" });
      await page.locator('[data-testid="broker-signin"]').click();
      await page.locator(`${panel}[data-phase="done"]`).waitFor();
      await shot(`${out}-done-light.png`, panel);
      await page.locator('[data-testid="signin-close"]').click();

      // The window itself: Microsoft's own page, served into the app. Both themes, because the
      // frame is somebody else's white page and how it sits in a dark app is the thing a
      // screenshot answers.
      await emit(broken);
      await emit({ kind: "signin", outcome: "window" });
      await page.locator('[data-testid="broker-signin"]').click();
      await page.locator(`${panel}[data-phase="waiting"]`).waitFor();
      await page.locator('[data-testid="signin-frame"]').waitFor({ state: "visible" });
      await shot(`${out}-window-light.png`);
      await setTheme("dark");
      await shot(`${out}-window-dark.png`, panel);

      // Typed into: the mock draws a dot per character, so this is the state a reader sees
      // while they work — and it is what proves the keystrokes reach the page.
      await page.locator('[data-testid="signin-keyboard"]').fill("hunter2");
      await page.waitForTimeout(1200);
      await shot(`${out}-typed-dark.png`, panel);

      // A phone, which is where this is really used: press it on the laptop, finish it here.
      await page.setViewportSize({ width: 390, height: 780 });
      await page.waitForTimeout(300);
      await shot(`${out}-phone-dark.png`);
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.locator('[data-testid="signin-cancel"]').click();
      await page.locator(`${panel}[data-phase="cancelled"]`).waitFor();
      await shot(`${out}-cancelled-dark.png`, panel);
      await page.locator('[data-testid="signin-close"]').click();

      // And the machine that cannot serve one at all: the button is there and inert, with the
      // backend's own sentence under it — in flow, because a phone has no hover.
      await emit({
        ...broken,
        can_sign_in: false,
        signin_blocker:
          "The identity broker draws its sign-in window on display :77, and nothing is serving " +
          "that display, so the window cannot appear at all. Restarting Intune on this machine " +
          "puts it back.",
      });
      await page.locator('[data-testid="broker-signin"]').waitFor({ state: "visible" });
      await shot(`${out}-blocked-dark.png`, '[data-testid="broker-banner"]');

      // Leave the shared mock healthy, and its sign-in hook reset: one mock process serves the
      // whole run, and a sign-in left running puts a dialog over every later capture.
      await emit({ kind: "signin", reset: true });
      await emit({ kind: "broker", ok: true });
      console.log(
        `[preview] wrote ${out}-offered-{light,dark}.png, ${out}-done-light.png, ` +
          `${out}-window-{light,dark}.png, ${out}-typed-dark.png, ${out}-phone-dark.png, ` +
          `${out}-cancelled-dark.png and ${out}-blocked-dark.png`,
      );
    });
    process.exit(0);
  }

  // The write-lock banner: what the sidebar says when this page holds a token its backend
  // does not accept — every read answers, every send is refused, and nothing else in the app
  // shows it. Driven through the mock's own control plane, and reloaded after arming because
  // the page asks the question once per connection.
  if (args.includes("--write-lock")) {
    await withPreview(async ({ page, shot, setTheme, emit }) => {
      const banner = '[data-testid="write-lock-banner"]';
      // A backend another instance owns: its token is pinned, so no file holds the right
      // one and the way out is outside this app.
      await emit({ kind: "write_lock", state: "foreign", pinned: true });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="conversation-row"]');
      await page.locator(banner).waitFor({ state: "visible" });
      await shot(`${out}-light.png`);
      await setTheme("dark");
      await shot(`${out}-dark.png`);
      await shot(`${out}-banner-dark.png`, banner);

      // The other cause: this app serving a token that is not that backend's, which a
      // restart of the app re-reads. Same banner, a different sentence — and the sentence
      // is the whole of what the reader gets, so both are captured.
      await emit({ kind: "write_lock", state: "foreign", pinned: false });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="conversation-row"]');
      await page.locator(banner).waitFor({ state: "visible" });
      await shot(`${out}-published-dark.png`, banner);

      // Leave the shared mock accepting the page's token, or this banner sits above every
      // later capture.
      await emit({ kind: "write_lock", reset: true });
      console.log(
        `[preview] wrote ${out}-light.png, ${out}-dark.png, ${out}-banner-dark.png ` +
          `and ${out}-published-dark.png`,
      );
    });
    process.exit(0);
  }

  // The update: the blue button, its progress mid-download, the restart it offers next,
  // and the plain link an install that cannot replace itself keeps instead. Driven
  // through the mock's own control plane — the real thing needs a published release
  // newer than this build, which is not a state a capture can arrange.
  if (args.includes("--update")) {
    await withPreview(async ({ page, shot, setTheme, emit }) => {
      const control = page.locator('[data-testid="update-control"]');
      await emit({ kind: "update" });
      await control.waitFor({ state: "visible" });
      await shot(`${out}-offered-light.png`);
      await setTheme("dark");
      await shot(`${out}-offered-dark.png`);

      // WHAT IT BRINGS, which is the one part of this row that is not in the row: the
      // commits between this build and the release, disclosed by resting the pointer on the
      // button. Captured in both themes because the panel is the app's floating surface and
      // its own contrast is the thing a screenshot answers.
      await page.locator('[data-testid="update-button"]').hover();
      await page.locator('[data-testid="update-changes"]').waitFor({ state: "visible" });
      await shot(`${out}-changes-dark.png`);
      await setTheme("light");
      await shot(`${out}-changes-light.png`);
      await setTheme("dark");

      // A build far behind: the list is capped and the panel says so, which is the only
      // sentence in it that is ours rather than an author's.
      await emit({ kind: "update", changes_omitted: 37 });
      await page.locator('[data-testid="update-control"][data-phase="idle"]').waitFor();
      await page.locator('[data-testid="update-button"]').hover();
      await page.locator('[data-testid="update-changes"]').waitFor({ state: "visible" });
      await shot(`${out}-changes-capped-dark.png`);
      // Off the button, or the panel covers every state captured below it.
      await page.mouse.move(700, 320);
      await page.locator('[data-testid="update-changes"]').waitFor({ state: "hidden" });

      // Mid-download: the progress is a fill behind the button's own label, so this
      // capture is the only way to review it.
      await page.locator('[data-testid="update-button"]').click();
      await page.waitForFunction(
        `(() => { const el = document.querySelector('[data-testid="update-button"]');
                  const pct = Number(el?.getAttribute("data-percent") ?? 0);
                  return pct > 20 && pct < 80; })()`,
      );
      await shot(`${out}-downloading-dark.png`);

      // Downloaded: the second click, which is a restart.
      await page.locator('[data-testid="update-control"][data-phase="ready"]').waitFor();
      await shot(`${out}-ready-dark.png`);

      // A FAILED download, which is the one state that draws a line of its own: the
      // reason. It is captured because the row is 240 px wide and the message has to fit
      // in it — the one the user was shown opened with two nine-digit numbers.
      await emit({ kind: "update", fail_once: true });
      await page.locator('[data-testid="update-control"][data-phase="idle"]').waitFor();
      await page.locator('[data-testid="update-button"]').click();
      await page.locator('[data-testid="update-control"][data-phase="failed"]').waitFor();
      await shot(`${out}-failed-dark.png`);

      // The other install shape: a staged service is updated where it was installed
      // from, so it keeps a link and never a button that would lie.
      await emit({ kind: "update", can_install: false });
      await page.locator('[data-testid="update-link"]').waitFor({ state: "visible" });
      await shot(`${out}-link-dark.png`);

      // Leave the shared mock without an update, or every later capture grows this row.
      await emit({ kind: "update", available: false });
      console.log(
        `[preview] wrote ${out}-offered-light.png, ${out}-offered-dark.png, ` +
          `${out}-changes-dark.png, ${out}-changes-light.png, ` +
          `${out}-changes-capped-dark.png, ${out}-downloading-dark.png, ` +
          `${out}-ready-dark.png, ${out}-failed-dark.png and ${out}-link-dark.png`,
      );
    });
    process.exit(0);
  }

  // The notification OFFER: the row that asks once, at the foot of the sidebar. It needs
  // no test hook — a browser that can subscribe and has not is the state every fresh
  // profile is in, which is the point of the row. The iOS "add to Home Screen" shape is
  // deliberately not captured: it is a paragraph of text, pinned by
  // e2e/notification-settings.spec.ts, and spoofing a user agent to photograph a sentence
  // buys nothing.
  if (args.includes("--notifications")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      const offer = '[data-testid="notification-offer"][data-shape="enable"]';
      await page.locator(offer).waitFor({ state: "visible" });
      await shot(`${out}-light.png`);
      await shot(`${out}-row-light.png`, offer);
      await setTheme("dark");
      await shot(`${out}-dark.png`);
      await shot(`${out}-row-dark.png`, offer);

      // A phone, where this row is the only place the reader will ever meet the feature:
      // the sidebar IS the screen there, and the row shares its foot with the status line.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(offer).waitFor({ state: "visible" });
      await shot(`${out}-mobile-dark.png`);
      console.log(
        `[preview] wrote ${out}-light.png, ${out}-row-light.png, ${out}-dark.png, ` +
          `${out}-row-dark.png and ${out}-mobile-dark.png`,
      );
    });
    process.exit(0);
  }

  // @mentions: the suggestion list a typed "@" opens, the chip a picked person leaves
  // in the composer, what Backspace does to it (one word per keystroke, Teams-style),
  // and the mention as it reads once the message is sent.
  if (args.includes("--mentions")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openConversation(page, "Mention Demo");
      // How Teams really sends a full name: one span per WORD of it. The two words
      // must read as ONE chip, while the two people written after them stay two.
      const split = '[data-testid="message"]:has-text("ping me")';
      await page.waitForSelector(split);
      await shot(`${out}-split-light.png`, split);
      await setTheme("dark");
      await shot(`${out}-split-dark.png`, split);
      await setTheme("light");
      // The list, opened by the "@" alone: everybody this thread can mention.
      await typeInComposer(page, "@");
      await page.waitForSelector('[data-testid="mention-suggestions"]');
      await page.waitForTimeout(250);
      await shot(`${out}-list-light.png`);
      // Narrowed by what is typed, then picked with Enter.
      await typeInComposer(page, "li");
      await page.waitForTimeout(200);
      await shot(`${out}-filtered-light.png`);
      await page.keyboard.press("Enter");
      await typeInComposer(page, "could you review this?");
      await page.waitForSelector(".tiptap-message .composer-mention");
      await shot(`${out}-composed-light.png`, '[data-testid="composer-shell"]');
      await setTheme("dark");
      await shot(`${out}-composed-dark.png`, '[data-testid="composer-shell"]');
      await setTheme("light");
      // The mention as it reads in the thread, ours and somebody else's — the chip
      // changes colour inside our own bubble, where blue on blue would vanish.
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      await shot(`${out}-sent-light.png`);
      await setTheme("dark");
      await shot(`${out}-sent-dark.png`);
      console.log(
        `[preview] wrote ${out}-split-{light,dark}.png, ${out}-list-light.png, ` +
          `${out}-filtered-light.png, ${out}-composed-{light,dark}.png and ` +
          `${out}-sent-{light,dark}.png`,
      );
    });
    process.exit(0);
  }

  // Agent tags: the same "@" list, in the one thread that is opted in out of the box,
  // where it offers the agents this machine can run above the people. A picked agent
  // leaves a chip in the vendor's own colour — which is the thing to look at here, in
  // both themes and up close.
  if (args.includes("--agent-tag")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openConversation(page, "Agent Sandbox");
      // The other machine's half, which the thread already holds: a colleague who runs
      // teams-lite too, their own `@claude` and the answer their agent posted under their
      // name. Their prefix wears the same chip — nothing of ours decides whether it ran —
      // and their reply wears the CLI's mark with the signature line stripped, so it reads
      // as an answer rather than as words that colleague typed.
      await page.waitForSelector(
        '[data-testid="message"][data-mine="false"] [data-testid="agent-tag"]',
      );
      await page.waitForTimeout(250);
      await shot(`${out}-theirs-light.png`);
      await setTheme("dark");
      await shot(`${out}-theirs-dark.png`);
      await setTheme("light");
      // Nothing is switched on first: this thread answers by default, the way the
      // backend's own policy has it (see `seedAgentSandbox` in web/mock/server.ts).
      await typeInComposer(page, "@");
      await page.waitForSelector('[data-testid="mention-suggestion"][data-kind="agent"]');
      await page.waitForTimeout(250);
      await shot(`${out}-list-light.png`);
      await setTheme("dark");
      await shot(`${out}-list-dark.png`);
      await setTheme("light");
      // Picked with Enter — the agent is the first row — and then a prompt after it.
      await page.keyboard.press("Enter");
      await page.waitForSelector('.tiptap-message [data-testid="agent-tag"]');
      await typeInComposer(page, "which port does the backend listen on?");
      await shot(`${out}-composed-light.png`, '[data-testid="composer-shell"]');
      await setTheme("dark");
      await shot(`${out}-composed-dark.png`, '[data-testid="composer-shell"]');
      await setTheme("light");
      // The chip itself, at four times the pixels: the mark, the name and the wash are
      // 16px things, and that is where this feature is either right or wrong.
      await shot(`${out}-chip-light.png`, '.tiptap-message [data-testid="agent-tag"]');
      await setTheme("dark");
      await shot(`${out}-chip-dark.png`, '.tiptap-message [data-testid="agent-tag"]');
      await setTheme("light");
      // The tag as it reads once sent: the same chip, in our own bubble, where the wash
      // now sits on the solid accent fill. The message carries only the plain prefix, so
      // this is also where the reader sees that reading it back really works.
      await page.keyboard.press("Enter");
      await page.waitForSelector(
        '[data-testid="message"][data-mine="true"] [data-testid="agent-tag"]',
      );
      await page.waitForTimeout(400);
      await shot(`${out}-sent-light.png`);
      await shot(
        `${out}-sent-chip-light.png`,
        '[data-testid="message"][data-mine="true"] [data-testid="agent-tag"]',
      );
      await setTheme("dark");
      await shot(`${out}-sent-dark.png`);
      await shot(
        `${out}-sent-chip-dark.png`,
        '[data-testid="message"][data-mine="true"] [data-testid="agent-tag"]',
      );
      await setTheme("light");
      console.log(
        `[preview] wrote ${out}-theirs-{light,dark}.png, ${out}-list-{light,dark}.png, ` +
          `${out}-composed-{light,dark}.png, ${out}-chip-{light,dark}.png, ` +
          `${out}-sent-{light,dark}.png and ${out}-sent-chip-{light,dark}.png`,
      );
      // Each CLI wears its own colour, so the second one is worth its own capture — but
      // only this machine says which CLIs it holds, and the mock holds one. Skipping is
      // said out loud rather than passed over in silence.
      await clearComposer(page);
      await typeInComposer(page, "@open");
      const second = page.locator('[data-testid="mention-suggestion"][data-agent="opencode"]');
      if ((await second.count()) === 0) {
        console.log("[preview] no second agent on this backend: no opencode chip captured");
        return;
      }
      await page.keyboard.press("Enter");
      await page.waitForSelector(
        '.tiptap-message [data-testid="agent-tag"][data-agent="opencode"]',
      );
      await shot(`${out}-opencode-light.png`, '.tiptap-message [data-testid="agent-tag"]');
      await setTheme("dark");
      await shot(`${out}-opencode-dark.png`, '.tiptap-message [data-testid="agent-tag"]');
      console.log(`[preview] wrote ${out}-opencode-{light,dark}.png`);
    });
    process.exit(0);
  }

  // The user's own CUSTOM AGENTS: the Settings section that makes one, the "@" list that
  // offers it beside the providers, the chip a message carries, and the answer under its own
  // name and face. The FALLBACK is half the feature, so both fixtures are on screen: `bebou`
  // has a face and `natacha` wears Claude's own mark.
  if (args.includes("--custom-agents")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openSettings(page);
      const section = page.locator('[data-testid="custom-agents-settings"]');
      await section.waitFor();
      await section.scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-testid="custom-agent-row"] img[data-persona="bebou"]');
      await page.waitForTimeout(250);
      await shot(`${out}-settings-light.png`, '[data-testid="custom-agents-settings"]');
      await setTheme("dark");
      await shot(`${out}-settings-dark.png`, '[data-testid="custom-agents-settings"]');
      await setTheme("light");

      // The form, on an agent that already exists: the face beside the fields, and the
      // instructions — the one thing about a custom agent no message ever shows.
      await section.locator('[data-testid="custom-agent-edit"]').first().click();
      await page.waitForSelector('[data-testid="custom-agent-dialog"]');
      await page.waitForTimeout(250);
      await shot(`${out}-dialog-light.png`);
      await setTheme("dark");
      await shot(`${out}-dialog-dark.png`);
      await setTheme("light");
      await page.keyboard.press("Escape");
      // The dialog's own close animation re-renders the section under it, so the next click
      // has to wait for it to be gone rather than race the element out of the DOM.
      await page.locator('[data-testid="custom-agent-dialog"]').waitFor({ state: "detached" });

      // The name a persona may NOT take: `@claude` already summons the provider, so a form
      // that accepted it would store a row nobody could ever summon.
      await section.locator('[data-testid="add-custom-agent"]').click();
      await page.waitForSelector('[data-testid="custom-agent-dialog"]');
      await page.locator('[data-testid="custom-agent-name"]').fill("claude");
      await page.waitForSelector('[data-testid="custom-agent-name-error"]');
      await shot(`${out}-name-taken-light.png`, '[data-testid="custom-agent-dialog"]');
      await page.keyboard.press("Escape");

      // The "@" list: the two providers, then the user's own agents — each with its own face
      // and the CLI behind it named, which is the one thing its name cannot say.
      await page.locator('[data-testid="tab-chats"]').click();
      await openConversation(page, "Agent Sandbox");
      await clearComposer(page);
      await typeInComposer(page, "@");
      await page.waitForSelector('[data-testid="mention-suggestion"][data-persona="bebou"]');
      await page.waitForTimeout(250);
      await shot(`${out}-list-light.png`);
      await setTheme("dark");
      await shot(`${out}-list-dark.png`);
      await setTheme("light");

      // Tagged, sent, and answered — the whole point of the feature in one bubble: the reply
      // carries the persona's name and face rather than the vendor's, from the first frame.
      await clearComposer(page);
      await typeInComposer(page, "@bebou");
      await page.waitForSelector('[data-testid="mention-suggestion"][data-persona="bebou"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector('.tiptap-message [data-testid="agent-tag"][data-persona="bebou"]');
      // The caret is already in the field, so the request is typed straight on rather than
      // through `typeInComposer` — whose click is what a reader does not have to do here, and
      // which lands dead centre on a document holding one atom (a click there selects it, the
      // way it selects a person mention).
      await page.keyboard.type("which port does the backend listen on?", { delay: 5 });
      await shot(`${out}-chip-light.png`, '.tiptap-message [data-testid="agent-tag"]');
      await setTheme("dark");
      await shot(`${out}-chip-dark.png`, '.tiptap-message [data-testid="agent-tag"]');
      await setTheme("light");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="agent-signature"][data-persona="bebou"]');
      await page.waitForTimeout(600);
      await shot(`${out}-answering-light.png`);
      await setTheme("dark");
      await shot(`${out}-answering-dark.png`);
      await setTheme("light");
      await shot(
        `${out}-signature-light.png`,
        '[data-testid="agent-signature"][data-persona="bebou"]',
      );
      console.log(
        `[preview] wrote ${out}-settings-{light,dark}.png, ${out}-dialog-{light,dark}.png, ` +
          `${out}-name-taken-light.png, ${out}-list-{light,dark}.png, ` +
          `${out}-chip-{light,dark}.png, ${out}-answering-{light,dark}.png and ` +
          `${out}-signature-light.png`,
      );
    });
    process.exit(0);
  }

  // "Answer with <agent>": the same tag reached from a message's own ⋯ menu. Two things
  // to look at — the row (the vendor's mark beside the words, in a menu whose other rows
  // wear our own glyphs) and the draft it writes (a reply, tag first, request seeded).
  // The message actions as a PHONE draws them: opened by a hold rather than by the "…", and
  // measured at the touch floor. This surface had no capture and shipped the same bug twice —
  // a hold whose menu the browser's own echo took away, and rows a thumb could not hit.
  if (args.includes("--message-actions")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        await openFirstConversation(page);
        const bubble = page.locator('[data-testid="message"]').last();
        await bubble.scrollIntoViewIfNeeded();

        // A REAL hold, through the browser's own input pipeline: the app gives up the
        // browser's long-press gestures on a coarse pointer, and a synthetic event would
        // exercise none of that.
        const box = (await bubble.boundingBox())!;
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: point.x, y: point.y }],
        });
        await page.waitForTimeout(700);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();

        const menu = page.locator('[data-testid="action-reply"]');
        await menu.waitFor({ state: "visible" });
        await page.waitForTimeout(400);
        await shot(`${out}-held-light.png`);
        await setTheme("dark");
        await shot(`${out}-held-dark.png`);

        // And what the bubble keeps once the menu closes: nothing. The "…" belongs to a
        // pointer, and it used to be left behind holding the focus the menu restored to it.
        // Dismissed the way a reader does — a tap away from the menu, not Escape, which on this
        // app leaves the whole conversation.
        await setTheme("light");
        await page.touchscreen.tap(24, 140);
        await menu.waitFor({ state: "hidden" });
        await page.waitForTimeout(400);
        await shot(`${out}-closed-light.png`);
        console.log(
          `[preview] wrote ${out}-held-{light,dark}.png and ${out}-closed-light.png`,
        );
      },
      // A phone, with a finger: the whole point of this capture is the coarse-pointer shape.
      { phone: true, deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  if (args.includes("--answer-with")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openConversation(page, "Agent Sandbox");
      await clearComposer(page);
      const bubble = page.locator('[data-testid="message"]').first();
      await bubble.hover();
      await bubble.locator('[data-testid="message-actions"]').click();
      const row = page.locator('[data-testid="action-answer-with"]');
      await row.waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-menu-light.png`);
      await setTheme("dark");
      await shot(`${out}-menu-dark.png`);
      await setTheme("light");
      // The row up close: a 16px mark next to two words is where this is right or wrong.
      await shot(`${out}-row-light.png`, '[data-testid="action-answer-with"]');
      // Picked: the composer holds the reply banner, the chip and the seeded request, and
      // nothing has been sent — the Enter is the user's.
      await row.click();
      await page.waitForSelector('.tiptap-message [data-testid="agent-tag"]');
      await page.waitForTimeout(200);
      await shot(`${out}-draft-light.png`, '[data-testid="composer-shell"]');
      await setTheme("dark");
      await shot(`${out}-draft-dark.png`, '[data-testid="composer-shell"]');
      console.log(
        `[preview] wrote ${out}-menu-{light,dark}.png, ${out}-row-light.png and ` +
          `${out}-draft-{light,dark}.png`,
      );
    });
    process.exit(0);
  }

  // A game of CHESS played in a conversation. Every challenge, accept and move is an ordinary
  // Teams message carrying a trailing marker, and the whole run of them collapses into ONE
  // board row where the game started (see AGENTS.md § Chess in a conversation). The mock plays
  // the opponent, so the capture walks a real game: the conversation's own menu, the challenge
  // rows that say what the press costs, the board once somebody accepted, a few moves with the
  // sheet under them, the board at a phone's width, and — last, because it needs a settled game
  // above it — the card a reader meets when somebody challenges THEM.
  if (args.includes("--chess")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      const conversation = await openConversation(page, "Agent Sandbox");
      // The header's control up close. It is ONE trigger for the whole conversation now, so
      // what this shot is for has changed: not whether a pawn reads at 20px, but whether the
      // trigger carries the attention DOT a game that wants a move puts on it. Captured at a
      // raised pixel density for that reason.
      await shot(`${out}-button-light.png`, '[data-testid="conversation-menu"]');
      await setTheme("dark");
      await shot(`${out}-button-dark.png`, '[data-testid="conversation-menu"]');
      await setTheme("light");

      // The challenge: the colour, and the sentence that says a message goes out under the
      // user's name and everybody in the conversation sees it. It is rows of the conversation's
      // menu rather than a popover of its own, so the shot is the whole page — the menu is
      // portaled, and a crop of the trigger would not hold it. Two presses, as before: the
      // menu, then the row that discloses what a challenge costs.
      //
      // Re-asserted before every shot and before the press: the mock's feed re-renders the pane
      // and a closed menu forgets the disclosure, so a capture that only opened it once would
      // photograph an app with no menu in it and say nothing about that.
      const openChallenge = async (): Promise<void> => {
        await openConversationMenu(page);
        if (!(await page.locator('[data-testid="chess-challenge"]').count())) {
          await page.locator('[data-testid="chess-button"]').click();
        }
        await page.locator('[data-testid="chess-challenge"]').waitFor();
        await page.waitForTimeout(200);
      };
      await openChallenge();
      await shot(`${out}-challenge-light.png`);
      await setTheme("dark");
      await openChallenge();
      await shot(`${out}-challenge-dark.png`);
      await setTheme("light");

      // Sent, and the mock accepts: the board arrives as one row in the history.
      await openChallenge();
      await page.locator('[data-testid="chess-challenge"]').click();
      const board = page.locator('[data-testid="chess-game"]');
      await board.waitFor();
      // Wait for the opponent's accept, which is what turns "waiting" into a playable board.
      // Polled from here rather than with `waitForFunction`: this file is type-checked without
      // the DOM lib, so a predicate running in the page cannot name `document`.
      const status = page.locator('[data-testid="chess-status"]');
      for (let i = 0; i < 50; i += 1) {
        if (!/waiting for somebody to accept/i.test((await status.textContent()) ?? "")) break;
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(200);
      await shot(`${out}-board-light.png`, '[data-testid="chess-game"]');
      await setTheme("dark");
      await shot(`${out}-board-dark.png`, '[data-testid="chess-game"]');
      await setTheme("light");

      // A few moves in, so the score sheet under the board has something to say. Only when it
      // is really our move: the challenge picks a colour at random.
      const ourMove = async (): Promise<boolean> =>
        /your move/i.test((await page.locator('[data-testid="chess-status"]').textContent()) ?? "");
      if (await ourMove()) {
        for (const [from, to] of [
          ["e2", "e4"],
          ["g1", "f3"],
        ] as const) {
          if (!(await ourMove())) break;
          await page.locator(`[data-square="${from}"]`).click();
          await page.locator(`[data-square="${to}"]`).click();
          await page.waitForTimeout(900);
        }
      }
      await page.waitForTimeout(300);
      await shot(`${out}-mid-game-light.png`, '[data-testid="chess-game"]');
      // The armed resignation, which says on the control that nothing takes it back.
      const resign = page.locator('[data-testid="chess-resign"]');
      if ((await resign.count()) > 0) {
        await resign.click();
        await page.waitForTimeout(150);
        await shot(`${out}-resign-armed-light.png`, '[data-testid="chess-game"]');
      }

      // A phone: the board is a square in a column 390px wide, and it must not widen the pane.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await shot(`${out}-mobile-light.png`);
      await page.setViewportSize(VIEWPORT);

      // BEING CHALLENGED, which is the half a reader meets first when a colleague opens the game:
      // the card owes them an ANSWER rather than a move, so it names who asked, says which side
      // they would take, and offers both answers — a state that had no control at all until the
      // mock could be the challenger. Two things about how it is captured:
      //   * the conversation is NAMED rather than left to the hook's own default, which is the
      //     chess spec's own thread: a challenge posted anywhere but the open one captures nothing;
      //   * it comes LAST, on the resigned game above it, because a finished game frees the
      //     conversation for the next challenge — and `shot` crops the FIRST match, so a challenge
      //     opened earlier would have stood in front of every board shot below it.
      await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
        data: { kind: "chess", challenge: "w", conversation },
      });
      const answer = page.locator('[data-testid="chess-accept"]');
      await answer.waitFor();
      await page.waitForTimeout(300);
      const challenged = '[data-testid="chess-game"] >> nth=-1';
      await shot(`${out}-challenged-light.png`, challenged);
      await setTheme("dark");
      await shot(`${out}-challenged-dark.png`, challenged);
      await setTheme("light");

      // ---- THE STRIP, AND THE PAGE ------------------------------------------------------
      //
      // Everything above is the card in the conversation. What follows is the two surfaces the
      // feature grew: the STRIP of running games floating under the header, and one game in FULL
      // on its own page. Both are captured off a SEEDED game rather than a played one, for the
      // reason a clock cannot be photographed otherwise — a seed puts the moves and both clocks
      // exactly where this shot needs them, and a played game would be four minutes of waiting.
      const seed = async (body: Record<string, unknown>): Promise<string> => {
        const res = await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
          data: { kind: "chess", seed: { conversation, ...body } },
        });
        const answer = (await res.json()) as { game: string | null };
        return answer.game ?? "";
      };
      // Two games at once, which is the rule that replaced "one game in flight": the strip names
      // both, most urgent first, each with its own two clocks.
      const played = await seed({
        mine: "w",
        moves: ["e4", "e5", "Nf3", "Nc6"],
        base: 600,
        clock: { w: 512_000, b: 486_000 },
      });
      await seed({ mine: "b", moves: ["d4"], base: 600, clock: { b: 25_000 } });
      const strip = '[data-testid="chess-games-strip"]';
      await page.locator(strip).waitFor();
      await page.waitForTimeout(300);
      await shot(`${out}-strip-light.png`, strip);
      await setTheme("dark");
      await shot(`${out}-strip-dark.png`, strip);
      await setTheme("light");

      // The PAGE: the board in the middle, the score sheet down the right, the conversation's own
      // chat under it. It is opened from the STRIP's own chip, which is a press a reader really
      // makes and — unlike the card in the history — is on screen whatever the reader has
      // scrolled to: the history is virtualized, so a board four screens up is not in the DOM at
      // all. The game is NAMED, because the first card may be a challenge nobody accepted, whose
      // board has no moves to walk back through.
      await page.locator(`[data-testid="chess-game-chip"][data-chess-game="${played}"]`).click();
      await page.locator('[data-testid="chess-page"]').waitFor();
      await page.locator('[data-testid="chess-score-sheet"]').waitFor();
      await page.waitForTimeout(400);
      await shot(`${out}-page-light.png`);
      await setTheme("dark");
      await shot(`${out}-page-dark.png`);
      await setTheme("light");

      // The board WALKED BACK, which is the one state a score sheet exists for: the ply the reader
      // is reading is marked, and the page says the board is not live.
      await page.locator('[data-testid="chess-nav-prev"]').click();
      await page.locator('[data-testid="chess-nav-prev"]').click();
      await page.waitForTimeout(400);
      await shot(`${out}-review-light.png`);
      await page.locator('[data-testid="chess-nav-live"]').click();
      await page.waitForTimeout(300);

      // A PREMOVE: the move the reader decided on while their opponent thinks, in its own tint on
      // both of its squares — and, before it, the DOTS that make one settable at all. The position
      // is chosen so the rules allow that pawn NOTHING (e5 is blocked by their own pawn, both
      // diagonals are empty), because a premove is offered wherever the piece could go once THEY
      // have moved rather than where it may go now (see web/src/lib/chess-premove.ts).
      await page.goBack();
      await page.locator('[data-testid="message-pane"]').waitFor();
      const premoving = await seed({ mine: "w", moves: ["e4", "e5", "Nf3"], base: 600 });
      // Its own ADDRESS rather than the strip's chip: the strip is bounded to three chips and puts
      // the games waiting for the READER first, so a game waiting for the opponent — which is the
      // only kind a premove can be set in — is exactly the one that falls off the end of it.
      await page.goto(`${WEB_ORIGIN}/c/${encodeURIComponent(conversation)}/chess/${premoving}`);
      await page.locator('[data-testid="chess-page"]').waitFor();
      await page.locator('[data-testid="chess-board"]').first().waitFor();
      await page.locator('[data-square="e4"]').click();
      await page.locator('[data-square="d5"] [data-target="true"]').waitFor();
      await page.waitForTimeout(300);
      await shot(`${out}-premove-targets-light.png`);
      await page.locator('[data-square="d5"]').click();
      await page.locator('[data-testid="chess-premove-hint"]').waitFor();
      await page.waitForTimeout(300);
      await shot(`${out}-premove-light.png`);
      await setTheme("dark");
      await shot(`${out}-premove-dark.png`);
      await setTheme("light");

      // The PROMOTION picker: four pieces over the square the pawn lands on, drawn with the
      // renderer's own art. It needs a position with a pawn one square away, so it is seeded.
      await page.goBack();
      await page.locator('[data-testid="message-pane"]').waitFor();
      const promoting = await seed({
        mine: "w",
        moves: ["e4", "d5", "exd5", "c6", "dxc6", "Qd6", "cxb7", "Qc6"],
        base: 600,
      });
      await page
        .locator(`[data-testid="chess-game-chip"][data-chess-game="${promoting}"]`)
        .click();
      await page.locator('[data-testid="chess-page"]').waitFor();
      await page.locator('[data-square="b7"]').click();
      await page.locator('[data-square="a8"]').click();
      await page.locator('[data-testid="chess-promotion"]').waitFor();
      await page.waitForTimeout(300);
      await shot(`${out}-promotion-light.png`);
      await setTheme("dark");
      await shot(`${out}-promotion-dark.png`);
      await setTheme("light");
      await page.keyboard.press("Escape");

      // A PHONE: one column, the board over the moves over the chat.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await shot(`${out}-page-mobile-light.png`);
      await page.setViewportSize(VIEWPORT);

      // ---- THE COMPUTER --------------------------------------------------------------
      //
      // The engine is 7.3 MB this machine may not hold, so the row a reader meets FIRST is the one
      // that states the size and offers to fetch it (§ Playing STOCKFISH). Both halves are
      // photographed, in this order, because the whole point of the first is that it comes before
      // the second: an app that downloaded on its own would never draw it.
      await page.goBack();
      await page.locator('[data-testid="message-pane"]').waitFor();
      const engineHook = async (body: Record<string, unknown>): Promise<void> => {
        await page.request.post(`http://127.0.0.1:${MOCK_PORT}/__test/emit`, {
          data: { kind: "engine", ...body },
        });
        await page.waitForTimeout(200);
      };
      // The row is a DISCLOSURE, so it is pressed open — and re-pressed for every shot, because a
      // closed menu forgets it and a capture that only opened it once would photograph the row shut.
      const openEngine = async (): Promise<void> => {
        await openConversationMenu(page);
        await page.locator('[data-testid="chess-engine-row"]').waitFor();
        if (
          !(await page.locator('[data-testid="chess-engine-download"]').count()) &&
          !(await page.locator('[data-testid="chess-engine-play"]').count())
        ) {
          await page.locator('[data-testid="chess-engine-row"]').click();
        }
        await page.waitForTimeout(250);
      };
      await engineHook({ present: false });
      await openEngine();
      await shot(`${out}-engine-fetch-light.png`);
      await setTheme("dark");
      await openEngine();
      await shot(`${out}-engine-fetch-dark.png`);
      await setTheme("light");

      // Here: the seven strengths, with the one that is picked marked. The picker is what "we can
      // choose the Elo" IS, so it is captured open — and at a PHONE's width too, because seven
      // presses in a menu is exactly the row that wraps badly at 390px.
      await engineHook({ present: true });
      await openEngine();
      await page.locator('[data-testid="chess-elo-2400"]').click();
      await page.waitForTimeout(200);
      await shot(`${out}-engine-elo-light.png`);
      await setTheme("dark");
      await openEngine();
      await shot(`${out}-engine-elo-dark.png`);
      await setTheme("light");
      await page.setViewportSize({ width: 390, height: 844 });
      await openEngine();
      await shot(`${out}-engine-elo-mobile-light.png`);
      await page.setViewportSize(VIEWPORT);

      // A GAME against it: one message, both sides in one ledger, and a seat that wears a mark
      // rather than a face — the engine is not a person, and nothing here draws it as one.
      await openEngine();
      // WHITE, said out loud: the picker opens on Random, and a capture whose subject depends on a
      // coin toss is a capture that photographs a different thing every run.
      await page.locator('[data-testid="chess-engine-color-w"]').click();
      await page.locator('[data-testid="chess-engine-play"]').click();
      const engineBoard = '[data-testid="chess-game"] >> nth=-1';
      await page.locator('[data-testid="chess-engine-seat"]').last().waitFor();
      // Play one move so the board is a GAME rather than an opening position: the computer answers
      // from the stub the harness installs, so the shot holds both sides' first move.
      const engineStatus = page.locator('[data-testid="chess-status"]').last();
      if (/your move/i.test((await engineStatus.textContent()) ?? "")) {
        await page.locator(`${engineBoard} >> [data-square="e2"]`).click();
        await page.locator(`${engineBoard} >> [data-square="e4"]`).click();
      }
      // POLLED rather than waited out: the colour is random, so this shot is of the engine's own
      // first move about half the time — and that move costs a worker boot, a UCI handshake and a
      // search before the message is edited. A fixed pause photographed the opening position.
      const engineMoves = page.locator(`${engineBoard} >> [data-testid="chess-moves"]`);
      for (let i = 0; i < 80; i += 1) {
        if (/[a-h1-8]/.test((await engineMoves.textContent()) ?? "")) break;
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(400);
      await shot(`${out}-engine-game-light.png`, engineBoard);
      await setTheme("dark");
      await shot(`${out}-engine-game-dark.png`, engineBoard);
      await setTheme("light");

      // What it COSTS, in the one place a reader can find it months later: Settings' own
      // inventory, which is the half of this feature the conversation's menu cannot offer.
      // The board's own layer is dismissed first: a menu or a picker still open would take the
      // press meant for Settings, which is a capture that photographs the wrong surface.
      // A RELOAD first, deliberately: this run has walked through several chess pages and pressed
      // Back, and Settings is reached from the sidebar rather than from any of them. A fresh page is
      // the shortest way to a state where that press means one thing.
      await page.goto(`${WEB_ORIGIN}/`);
      await page.locator('[data-testid="backend-badge"][data-backend="mock"]').waitFor();
      await openSettings(page);
      const inventory = '[data-testid="chess-engine-settings"]';
      await page.locator(inventory).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(`${out}-engine-settings-light.png`, inventory);
      await setTheme("dark");
      await shot(`${out}-engine-settings-dark.png`, inventory);
      await setTheme("light");
      await engineHook({ reset: true });

      console.log(
        `[preview] wrote ${out}-button-{light,dark}.png, ${out}-challenge-{light,dark}.png, ` +
          `${out}-board-{light,dark}.png, ${out}-mid-game-light.png, ` +
          `${out}-resign-armed-light.png, ${out}-mobile-light.png, ` +
          `${out}-challenged-{light,dark}.png, ${out}-strip-{light,dark}.png, ` +
          `${out}-page-{light,dark}.png, ${out}-review-light.png, ` +
          `${out}-premove-targets-light.png, ${out}-premove-{light,dark}.png, ` +
          `${out}-promotion-{light,dark}.png, ${out}-page-mobile-light.png, ` +
          `${out}-engine-fetch-{light,dark}.png, ${out}-engine-elo-{light,dark}.png, ` +
          `${out}-engine-elo-mobile-light.png, ${out}-engine-game-{light,dark}.png ` +
          `and ${out}-engine-settings-{light,dark}.png`,
      );
    });
    process.exit(0);
  }

  // A SEALED chat: the words of every message this app posts are encrypted before they reach
  // Teams (see AGENTS.md § A SEALED chat). The page holds no crypto at all, so every surface
  // here is a reading of what the backend tells it — which is exactly why it is worth
  // photographing: the whole feature is words, a quiet mark, and one dialog.
  //
  // TWO threads, and the split is what makes the run possible rather than a convenience:
  //
  //   * an ORDINARY chat the script seals itself, which is the flow a reader really walks and
  //     the only place the first passphrase, the generated one and the PLAIN composer hint
  //     exist;
  //   * the mock's own "Sealed Chat" fixture, which carries all four message states at once and
  //     is permanently in DISAGREEMENT with this machine (a colleague rotated their passphrase)
  //     — so it is where the mismatch is captured, and where the plain hint never can be.
  if (args.includes("--seal")) {
    await withPreview(async ({ page, shot, setTheme, emit }) => {
      const dialog = '[data-testid="seal-dialog"]';
      const composer = '[data-testid="composer-shell"]';

      /** Open the dialog from the conversation's own menu — the one place a chat is sealed,
       *  because that is the surface which says who is in the conversation.
       *
       *  IDEMPOTENT for `openConversationMenu`'s own reason: the mock's live feed re-renders the
       *  pane every few seconds, so a capture that opened this once and then switched theme may
       *  find it gone. */
      const openDialog = async (): Promise<void> => {
        if (await page.locator(dialog).count()) return;
        await openConversationMenu(page);
        await page.locator('[data-testid="conversation-seal"]').click();
        await page.locator(dialog).waitFor();
        await page.waitForTimeout(250); // the dialog fades in; capture it settled
      };

      // ---- the chat this script seals itself -------------------------------------------
      await openConversation(page, "Plain Text");
      await clearComposer(page);

      // The row that offers it, in the menu the header's one trigger opens. A whole-page shot,
      // because the menu is portaled and a crop of the trigger would not hold it.
      await openConversationMenu(page);
      await shot(`${out}-menu-light.png`);
      await setTheme("dark");
      await openConversationMenu(page);
      await shot(`${out}-menu-dark.png`);
      await setTheme("light");
      await closeConversationMenu(page);

      // The dialog with no passphrase yet — the state most readers meet it in. Both themes,
      // because what it mostly IS is sentences, and how a paragraph of them sits on a card is
      // the thing a screenshot answers.
      await openDialog();
      await shot(`${out}-dialog-light.png`, dialog);
      await setTheme("dark");
      await openDialog();
      await shot(`${out}-dialog-dark.png`, dialog);
      await setTheme("light");

      // A passphrase the app made: five groups it can be read aloud in, with the press beside
      // it that copies the whole thing. This answer is the ONE time a passphrase crosses the
      // socket, so this shot is the whole of the reader's chance to share it.
      await openDialog();
      await page.locator('[data-testid="seal-apply"]').click();
      await page.locator('[data-testid="seal-generated"]').waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-generated-light.png`, dialog);
      await setTheme("dark");
      await shot(`${out}-generated-dark.png`, dialog);
      await setTheme("light");
      await page.locator('[data-testid="seal-close"]').click();
      await page.locator(dialog).waitFor({ state: "detached" });

      // The PLAIN composer hint, which only a chat with no disagreement can show: the words are
      // encrypted, and a picture is not. Cropped to the composer, because eleven words at the
      // foot of a 1200px page say nothing at that size.
      await page.locator(composer).waitFor();
      await page.waitForTimeout(300);
      await shot(`${out}-composer-light.png`, composer);
      await setTheme("dark");
      await shot(`${out}-composer-dark.png`, composer);
      await setTheme("light");

      // ---- the fixture, which holds every state at once --------------------------------
      await openConversation(page, "Sealed Chat");
      await page.locator('[data-testid="message"][data-seal="locked"]').waitFor();
      await page.waitForTimeout(300);
      // The four rows together, which is the only way to review them: each says something
      // different and the reader's next move differs, so a surface that collapsed two of them
      // would only be caught by having all four side by side.
      await shot(`${out}-states-light.png`, '[data-testid="message-pane"]');
      await setTheme("dark");
      await shot(`${out}-states-dark.png`, '[data-testid="message-pane"]');
      await setTheme("light");

      // The MISMATCH at the composer, which needs no press at all: this chat seals under one
      // passphrase while a colleague's message in it carries another, and without this sentence
      // nobody is told — each posts messages the other cannot read and each blames the other's
      // app.
      await shot(`${out}-mismatch-composer-light.png`, composer);
      await setTheme("dark");
      await shot(`${out}-mismatch-composer-dark.png`, composer);
      await setTheme("light");

      // And the same failure caught one moment EARLIER, from the other side: a passphrase that
      // does not open what the thread already holds, reported while the reader is still in front
      // of the field that mends it.
      await openDialog();
      await page.locator('[data-testid="seal-passphrase-field"]').fill("zzzz-yyyy-xxxx-wwww-vvvv");
      await page.locator('[data-testid="seal-apply"]').click();
      await page.locator('[data-testid="seal-mismatch"]').waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-mismatch-light.png`, dialog);
      await setTheme("dark");
      await shot(`${out}-mismatch-dark.png`, dialog);
      await setTheme("light");

      // The armed FORGET: the one act in this feature that no later press takes back, so the
      // sentence saying what it costs is what the second press is really about. The row it is
      // armed on is the one that is NOT current, so the shot also shows the current one intact
      // beside it — which is what makes "this passphrase" rather than "the passphrase" readable.
      await page.locator('[data-testid="seal-forget"]').first().click();
      await page.locator('[data-testid="seal-forget-warning"]').waitFor();
      await page.waitForTimeout(200);
      await shot(`${out}-forget-armed-light.png`, dialog);
      await setTheme("dark");
      await shot(`${out}-forget-armed-dark.png`, dialog);
      await setTheme("light");
      await page.locator('[data-testid="seal-forget-cancel"]').first().click();

      // A PHONE, which is where the sharing half of this feature really happens: a passphrase is
      // read off a laptop and typed in here. Everything about the dialog that could go wrong is
      // only visible at 390px — a Copy button off the right edge, a passphrase wrapped mid-group,
      // a paragraph of notes pushing the press off the bottom.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await shot(`${out}-mobile-dialog-light.png`);
      await page.locator('[data-testid="seal-reveal"]').first().click();
      await page.locator('[data-testid="seal-revealed-passphrase"]').first().waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-mobile-revealed-light.png`);
      await page.locator('[data-testid="seal-close"]').click();
      await page.locator(dialog).waitFor({ state: "detached" });
      await shot(`${out}-mobile-states-light.png`);
      await page.setViewportSize(VIEWPORT);

      // Leave the shared mock the way it declares itself: one mock process serves the whole
      // run, and a chat this script sealed would change what every later capture's composer says
      // about the message it is about to send.
      await emit({ kind: "seal" });
      console.log(
        `[preview] wrote ${out}-menu-{light,dark}.png, ${out}-dialog-{light,dark}.png, ` +
          `${out}-generated-{light,dark}.png, ${out}-composer-{light,dark}.png, ` +
          `${out}-states-{light,dark}.png, ${out}-mismatch-composer-{light,dark}.png, ` +
          `${out}-mismatch-{light,dark}.png, ${out}-forget-armed-{light,dark}.png and ` +
          `${out}-mobile-{dialog,revealed,states}-light.png`,
      );
    });
    process.exit(0);
  }

  // A MERGE REQUEST in a message: the two rows its ⋯ menu grows. "Review !44 with
  // Claude", which drafts like "Answer with" does, and the approval — the one action in
  // this app that writes to a tracker, so the capture walks its whole shape: the row, the
  // confirmation it arms with the sentence saying what it costs, and the outcome it reports
  // in the menu it was clicked in.
  if (args.includes("--merge-request")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openConversation(page, "Merge Request Review");
      await clearComposer(page);
      const bubble = page.locator('[data-testid="message"]').first();
      await bubble.hover();
      await bubble.locator('[data-testid="message-actions"]').click();
      const approve = page.locator('[data-testid="action-approve-mr"]');
      await approve.waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-menu-light.png`);
      await setTheme("dark");
      await shot(`${out}-menu-dark.png`);
      await setTheme("light");
      // The two rows up close: a vendor's 16px mark beside the words is where this is
      // right or wrong.
      await shot(`${out}-review-row-light.png`, '[data-testid="action-review-with"]');
      await shot(`${out}-approve-row-light.png`, '[data-testid="action-approve-mr"]');

      // Armed: what the second click costs, said before it is made.
      await approve.click();
      await page.waitForSelector('[data-testid="action-approve-mr-confirm"]');
      await page.waitForTimeout(200);
      await shot(`${out}-confirm-light.png`);
      await setTheme("dark");
      await shot(`${out}-confirm-dark.png`);
      await setTheme("light");

      // Done: GitLab's answer, in the menu the user is still looking at.
      await page.locator('[data-testid="action-approve-mr-confirm"]').click();
      await page.waitForSelector('[data-testid="approval-outcome"]');
      await page.waitForTimeout(200);
      await shot(`${out}-approved-light.png`);
      await setTheme("dark");
      await shot(`${out}-approved-dark.png`);
      await setTheme("light");
      // Out of the menu through the mouse: an open menu is modal, so it is the only layer
      // taking pointer events, and the app reads Escape as "leave this conversation".
      await page.mouse.click(5, 5);
      // Written as a string, like the other waits here: this script is typechecked
      // against the Node lib, which has no `document`.
      await page.waitForFunction(
        `getComputedStyle(document.body).pointerEvents !== "none"`,
        undefined,
        { timeout: 5_000 },
      );

      // And the review draft: a reply, tag first, the merge request named in the request.
      await bubble.hover();
      await bubble.locator('[data-testid="message-actions"]').click();
      const review = page.locator('[data-testid="action-review-with"]').first();
      await review.waitFor();
      await review.click();
      await page.waitForSelector('.tiptap-message [data-testid="agent-tag"]');
      await page.waitForTimeout(200);
      await shot(`${out}-draft-light.png`, '[data-testid="composer-shell"]');
      console.log(
        `[preview] wrote ${out}-menu-{light,dark}.png, ${out}-review-row-light.png, ` +
          `${out}-approve-row-light.png, ${out}-confirm-{light,dark}.png, ` +
          `${out}-approved-{light,dark}.png and ${out}-draft-light.png`,
      );
    });
    process.exit(0);
  }

  // Audio calling: the call row in a 1:1's own menu, a call ringing with a working Answer, the
  // PAGE it becomes once answered — its people, its chat, its picture — and the window
  // that page folds into and is dragged around in.
  //
  // Nothing here registers anything or opens a microphone. The mock reproduces the
  // signaling and the page uses `simulatedCallMedia` because the backend announced
  // itself as a mock — which is what makes this surface reviewable with nothing leaving
  // the machine (see web/mock/server.ts and src/lib/call-media.ts).
  if (args.includes("--call")) {
    await withPreview(async ({ page, shot, setTheme, emit }) => {
      // 1. The call row, live with no step in between: the backend registered as a device the
      //    user's calls ring on at startup, and there is no switch anywhere. It is a row of the
      //    conversation's own menu now rather than a glyph in its header, so the crop is the
      //    menu — which is portaled, and is not inside the header's box at all.
      const conversationId = await openConversation(page, "Ava Thompson");
      await openConversationMenu(page);
      await page.waitForTimeout(200);
      await shot(`${out}-button-light.png`, '[data-testid="conversation-menu-content"]');
      await closeConversationMenu(page);

      // 2. A window whose backend does not take calls at all — a read-only one, or the
      //    second install beside the user's app. The row stays, disabled, and the reason
      //    stands under it in WORDS: it used to be a tooltip, which on a phone is a sentence
      //    that does not exist.
      await emit({ kind: "calling", enabled: false });
      await page.waitForTimeout(300);
      await openConversationMenu(page);
      await page.waitForSelector('[data-testid="conversation-call-reason"]');
      await page.waitForTimeout(200);
      await shot(`${out}-off-light.png`, '[data-testid="conversation-menu-content"]');
      await closeConversationMenu(page);
      await emit({ kind: "call_invite", reset: true });
      await page.waitForTimeout(300);

      // 3. Ringing, with an Answer that works.
      await emit({ kind: "call_invite", conversation: conversationId });
      await page.waitForSelector('[data-testid="call-bar"][data-phase="ringing"]');
      await page.waitForTimeout(300);
      await shot(`${out}-ringing-light.png`);
      await shot(`${out}-ringing-card-light.png`, '[data-testid="call-bar"]');
      await setTheme("dark");
      await shot(`${out}-ringing-card-dark.png`, '[data-testid="call-bar"]');
      await setTheme("light");

      // 4. Answered: the CALL AS A PAGE — the header, the time, the controls, and the card
      //    with the person in the middle of it. This is the whole surface, so the shot is
      //    the page rather than a crop.
      await page.locator('[data-testid="call-answer"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-mode="full"]');
      await page.waitForTimeout(1100);
      await shot(`${out}-stage-light.png`);
      await shot(`${out}-stage-header-light.png`, '[data-testid="call-stage"] header');
      await page.locator('[data-testid="call-mute"]').first().click();
      await page.waitForSelector('[data-testid="call-mute"][aria-pressed="true"]');
      await shot(`${out}-stage-muted-light.png`, '[data-testid="call-stage"] header');
      await setTheme("dark");
      await shot(`${out}-stage-dark.png`);
      await setTheme("light");

      // 4a. FOLDED. The same element, morphed into a window the user drags out of the way
      //     — so the shot after the drag is the proof that the position is the window's own
      //     and that expanding returns from exactly there.
      await page.locator('[data-testid="call-stage-minimize"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-mode="mini"]');
      await page.waitForTimeout(600);
      await shot(`${out}-mini-light.png`, '[data-testid="call-stage"]');
      await shot(`${out}-mini-page-light.png`);
      const folded = await page.locator('[data-testid="call-stage"]').boundingBox();
      if (folded) {
        await page.mouse.move(folded.x + folded.width / 2, folded.y + 12);
        await page.mouse.down();
        await page.mouse.move(240, 160, { steps: 24 });
        await page.mouse.up();
        await page.waitForTimeout(600);
        await shot(`${out}-mini-dragged-light.png`);
      }
      await setTheme("dark");
      await shot(`${out}-mini-dark.png`, '[data-testid="call-stage"]');
      await setTheme("light");
      // And back, from where it was dropped.
      await page.locator('[data-testid="call-stage-expand"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-mode="full"]');
      await page.waitForTimeout(600);
      await page.locator('[data-testid="call-hangup"]').first().click();
      await page.waitForSelector('[data-testid="call-stage"]', { state: "detached" });

      // 4b. A GROUP chat: the same row, and words that say it rings everybody. Then
      //     the stage, which names the CONVERSATION and fills in who picked up.
      await openConversation(page, "Platform Team");
      await openConversationMenu(page);
      await page.waitForTimeout(200);
      await shot(`${out}-group-button-light.png`, '[data-testid="conversation-menu-content"]');
      await page.locator('[data-testid="call-button"]').click();
      await page.waitForSelector('[data-testid="call-stage"]');
      await shot(`${out}-group-dialing-light.png`);
      await page.waitForSelector('[data-testid="call-stage"][data-phase="connected"]');
      await page.waitForSelector('[data-testid="call-phase"]:has-text("With")');
      await shot(`${out}-group-stage-light.png`);
      await page.locator('[data-testid="call-hangup"]').first().click();
      await page.waitForSelector('[data-testid="call-stage"]', { state: "detached" });

      // 4c. A MEETING chat, which is the other thing a chat header can offer: Join, from the
      //     thread itself, with no calendar and no link. The meeting the thread was minted
      //     for is the one action it gets — and once joined, that thread's own chat is the
      //     panel beside the picture.
      await openConversation(page, "Design Sync");
      await openConversationMenu(page);
      await page.waitForTimeout(200);
      await shot(`${out}-meeting-chat-light.png`, '[data-testid="conversation-menu-content"]');
      // The row on its own. Both actions wear the handset, so the WORDS are what tell a join
      // from a ring — which is what a menu buys and a row of 20px glyphs could not.
      await shot(`${out}-meeting-chat-icon.png`, '[data-testid="meeting-join-here"]');
      await setTheme("dark");
      await openConversationMenu(page);
      await page.waitForTimeout(200);
      await shot(`${out}-meeting-chat-dark.png`, '[data-testid="conversation-menu-content"]');
      await setTheme("light");
      await openConversationMenu(page);
      await page.locator('[data-testid="meeting-join-here"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-phase="connected"]');
      await page.waitForTimeout(600);
      await shot(`${out}-meeting-chat-stage-light.png`);

      // 4d. The two panels. The CHAT is already open — a call in a conversation opens with
      //     it (`initialCallStagePanel`), which is what the shot above shows — so this walks
      //     to People, the roster the service reports, and back.
      await page.locator('[data-testid="call-stage-people"]').click();
      await page.waitForSelector('[data-testid="call-stage-people-panel"]');
      await page.waitForTimeout(500);
      await shot(`${out}-people-light.png`);
      await shot(`${out}-people-panel-light.png`, '[data-testid="call-stage-panel"]');
      await page.locator('[data-testid="call-stage-chat-toggle"]').click();
      await page.waitForSelector('[data-testid="call-stage-transcript"]');
      await page.waitForTimeout(500);
      await shot(`${out}-chat-light.png`);
      await shot(`${out}-chat-panel-light.png`, '[data-testid="call-stage-panel"]');
      await setTheme("dark");
      await shot(`${out}-chat-dark.png`);
      await setTheme("light");
      await page.locator('[data-testid="call-hangup"]').first().click();
      await page.waitForSelector('[data-testid="call-stage"]', { state: "detached" });

      // 5. A meeting from the CALENDAR: the Join button beside the link out, the lobby,
      //    then the roster.
      //
      // Back to the root first: the calendar pane only shows when no conversation is in
      // the URL, and the steps above opened several (see app.tsx).
      await page.goto(WEB_ORIGIN, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="conversation-row"]');
      await openCalendarTab(page);
      await openCalendarView(page, "day");
      // A fixture that HAS a join link: the seed gives one to every other event, so
      // `.first()` is a coin toss and a Join button that is simply absent reads as a bug.
      await page
        .locator('[data-testid="calendar-event"][data-event-id="ev-overlap-a"]')
        .first()
        .click();
      const details = page.locator('[data-testid="calendar-event-details"]');
      await details.waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-meeting-actions-light.png`, '[data-testid="calendar-event-details"]');
      await page.locator('[data-testid="meeting-join-here"]').click();
      await page.waitForSelector('[data-testid="call-phase"]:has-text("Waiting")');
      await shot(`${out}-meeting-lobby-light.png`);
      await page.waitForSelector('[data-testid="call-stage"][data-phase="connected"]');
      await page.waitForSelector('[data-testid="call-phase"]:has-text("others")');
      await shot(`${out}-meeting-stage-light.png`);

      // 6. And the PICTURE. The mock's service renegotiates right after the roster, the
      //    page answers and subscribes, and the shared screen takes the whole content with
      //    the camera as a tile under it. Nothing here opens a camera: the streams come
      //    from a canvas (`simulatedCallMedia`).
      await page.waitForSelector('[data-testid="call-video-frame"][data-sharing="true"]');
      await page.waitForTimeout(400);
      await shot(`${out}-video-light.png`, '[data-testid="call-video"]');
      await shot(`${out}-video-page-light.png`);
      await setTheme("dark");
      await shot(`${out}-video-dark.png`, '[data-testid="call-video"]');
      await setTheme("light");

      // 7. SENDING. The camera and the screen, each one click, each one the consent for that
      //    action. Nothing is opened here either: against the mock the preview is a canvas,
      //    so no camera light comes on and no picker appears.
      //
      //    The share TAKES the meeting's one sharing session, so the colleague's screen
      //    captured in step 6 is gone from these shots — the service zeroes their section the
      //    moment the role changes hands, which is what real Teams does too. What is left is
      //    their camera as a tile and the user's own screen as the corner preview.
      await shot(`${out}-send-off-light.png`, '[data-testid="call-stage"] header');
      await page.locator('[data-testid="call-camera"]').click();
      await page.waitForSelector('[data-testid="call-video-local"][data-kind="camera"]');
      await page.waitForSelector('[data-testid="call-camera"][aria-pressed="true"]');
      await page.locator('[data-testid="call-share"]').click();
      await page.waitForSelector('[data-testid="call-video-local"][data-kind="screen"]');
      await page.waitForTimeout(400);
      await shot(`${out}-send-on-light.png`, '[data-testid="call-stage"] header');
      await shot(`${out}-sending-light.png`, '[data-testid="call-video"]');
      await shot(`${out}-sending-page-light.png`);
      // Folded, with a screen on the wire: the window carries the picture rather than the
      // avatar, which is what makes it worth 208 pixels of somebody's screen.
      await page.locator('[data-testid="call-stage-minimize"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-mode="mini"]');
      await page.waitForTimeout(600);
      await shot(`${out}-mini-video-light.png`, '[data-testid="call-stage"]');
      await setTheme("dark");
      await shot(`${out}-sending-dark.png`, '[data-testid="call-stage"]');
      await setTheme("light");

      // 8. And what the app SAYS when one of those is refused. It is a transient notice
      //    (web/src/lib/notice.ts), so the page shot is the one that matters: it shows the
      //    notice clear of the header every control sits in. The refusal is armed through the
      //    mock's own hook — the simulated camera never refuses, and the service that would
      //    is a real tenant.
      await page.locator('[data-testid="call-stage-expand"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-mode="full"]');
      await page.waitForTimeout(600);
      await emit({ kind: "call_media", refuse: true });
      await page.locator('[data-testid="call-camera"]').click();
      await page.waitForSelector('[data-testid="call-notice"]');
      await page.waitForTimeout(500);
      await shot(`${out}-notice-light.png`);
      await shot(`${out}-notice-card-light.png`, '[data-testid="call-notice"]');
      await setTheme("dark");
      await shot(`${out}-notice-card-dark.png`, '[data-testid="call-notice"]');
      await setTheme("light");
      await page.locator('[data-testid="call-hangup"]').first().click();

      console.log(
        `[preview] wrote ${out}-button-light.png, ${out}-off-light.png, ` +
          `${out}-ringing-{light,card-light,card-dark}.png and ` +
          `${out}-stage-{light,header-light,muted-light,dark}.png and ` +
          `${out}-mini-{light,page-light,dragged-light,dark,video-light}.png and ` +
          `${out}-group-{button-light,dialing-light,stage-light}.png and ` +
          `${out}-meeting-chat-{light,dark,icon,stage-light}.png and ` +
          `${out}-{people-light,people-panel-light,chat-light,chat-panel-light,chat-dark}.png and ` +
          `${out}-meeting-{actions-light,lobby-light,stage-light}.png and ` +
          `${out}-video-{light,page-light,dark}.png and ` +
          `${out}-send-{off-light,on-light}.png and ` +
          `${out}-sending-{light,page-light,dark}.png and ` +
          `${out}-notice-{light,card-light,card-dark}.png`,
      );
    });
    process.exit(0);
  }

  // Recording a call: teams-lite's own file, made in the page and kept in this browser —
  // the control that says nobody on the call is told, the state while it runs, the card it
  // leaves in the conversation, and the list in Settings
  // (web/src/lib/call-recording.ts, call-recorder.ts, recording-store.ts).
  //
  // The mock has no tenant, no camera and no microphone: `simulatedCallMedia` hands the
  // recorder canvases and one silent voice, so what is captured here is a REAL webm written
  // by a real `MediaRecorder`, with nothing leaving the machine.
  if (args.includes("--call-recording")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      // Calling needs no step: this app is a device the user's calls ring on from startup.
      //
      // 1. A live call, with the control in its header. The tooltip is the whole promise, so
      //    the crop is the header the control sits in.
      await openConversation(page, "Ava Thompson");
      await callFromMenu(page);
      await page.waitForSelector('[data-testid="call-stage"][data-phase="connected"]');
      await page.waitForTimeout(900);
      await shot(`${out}-control-light.png`, '[data-testid="call-stage"] header');
      await setTheme("dark");
      await shot(`${out}-control-dark.png`, '[data-testid="call-stage"] header');
      await setTheme("light");

      // 2. Recording. The control becomes the state: a red pill counting its own time, which
      //    is not the call's — a recording begun ten minutes in is ten minutes shorter.
      await page.locator('[data-testid="call-record"]').click();
      await page.waitForSelector('[data-testid="call-record"][data-recording="true"]');
      await page.waitForTimeout(1200);
      await shot(`${out}-recording-light.png`, '[data-testid="call-stage"] header');
      await shot(`${out}-recording-page-light.png`);

      // 2a. Folded, where the stop is the ONE control the window gains: a recording the user
      //     cannot end without unfolding the call would be the microphone mistake again.
      await page.locator('[data-testid="call-stage-minimize"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-mode="mini"]');
      await page.waitForTimeout(700);
      await shot(`${out}-recording-mini-light.png`, '[data-testid="call-stage"]');
      await page.locator('[data-testid="call-stage-expand"]').click();
      await page.waitForSelector('[data-testid="call-stage"][data-mode="full"]');
      await page.waitForTimeout(700);

      // 3. Stopped: the file is written, and the app says where it went.
      await page.locator('[data-testid="call-record"]').click();
      await page.waitForSelector('[data-testid="call-recording-notice"]');
      await shot(`${out}-kept-light.png`, '[data-testid="call-recording-notice"]');

      await page.locator('[data-testid="call-hangup"]').first().click();
      await page.waitForSelector('[data-testid="call-stage"]', { state: "detached" });

      // 3a. And one recording made while there are PICTURES on the call, which is what the
      //     compositor is really for: every stream drawn into one frame, each tile named. A
      //     MEETING is where several arrive — the mock renegotiates after the roster with a
      //     colleague's camera and screen — and the user's own camera goes on top of them.
      //     Every one is a canvas, so the frame is dark: what these shots are for is the
      //     LAYOUT and the labels the recorder draws into the file.
      await openConversation(page, "Design Sync");
      await joinMeetingFromMenu(page);
      await page.waitForSelector('[data-testid="call-stage"][data-phase="connected"]');
      await page.waitForSelector('[data-testid="call-video-frame"]', { timeout: 30_000 });
      await page.locator('[data-testid="call-camera"]').click();
      await page.waitForSelector('[data-testid="call-video-local"]');
      await page.locator('[data-testid="call-record"]').click();
      await page.waitForSelector('[data-testid="call-record"][data-recording="true"]');
      await page.waitForTimeout(1500);
      await shot(`${out}-recording-video-light.png`);
      await page.locator('[data-testid="call-record"]').click();

      // 4. The card in the conversation, which is the whole point of the feature. The call is
      //    ended first, because a live call is a page over the app — which is also when the
      //    user reaches for the recording.
      await page.locator('[data-testid="call-hangup"]').first().click();
      await page.waitForSelector('[data-testid="call-stage"]', { state: "detached" });
      // The meeting's recording, in the meeting's own thread. Its first frame is the composite
      // the recorder drew — the shared screen with the faces under it — which is the one place
      // the layout inside the FILE can be reviewed.
      await page.waitForSelector('[data-testid="call-recording"]');
      await page.waitForTimeout(800);
      await shot(`${out}-meeting-card-light.png`, '[data-testid="call-recording"]');
      await openConversation(page, "Ava Thompson");
      await page.waitForSelector('[data-testid="call-recording"]');
      await page.waitForTimeout(600);
      // The one from the 1:1 call, in the conversation that call was in. The meeting's own
      // recording is in the meeting's thread — a recording belongs where the call was.
      await shot(`${out}-card-light.png`, '[data-testid="call-recording"]');
      await shot(`${out}-card-page-light.png`);
      await setTheme("dark");
      await shot(`${out}-card-dark.png`, '[data-testid="call-recording"]');
      await setTheme("light");

      // 4a. Armed for deletion, which is asked twice: there is nothing upstream to take a
      //     deletion back from.
      await page.locator('[data-testid="call-recording-delete"]').click();
      await page.waitForSelector('[data-testid="call-recording-delete-confirm"]');
      await shot(`${out}-card-confirm-light.png`, '[data-testid="call-recording"]');
      await page.locator('[data-testid="call-recording-delete-cancel"]').click();

      // 5. And the list in Settings — how a recording made in a link-joined meeting, or one
      //    made months ago, is reachable at all.
      await openSettings(page);
      await page.waitForSelector('[data-testid="call-recording-row"]');
      await shot(`${out}-settings-light.png`, '[data-testid="call-recordings-settings"]');
      await setTheme("dark");
      await shot(`${out}-settings-dark.png`, '[data-testid="call-recordings-settings"]');
      await setTheme("light");

      console.log(
        `[preview] wrote ${out}-control-{light,dark}.png, ` +
          `${out}-recording-{light,page-light,mini-light,video-light}.png, ${out}-kept-light.png, ` +
          `${out}-card-{light,page-light,dark,confirm-light}.png, ${out}-meeting-card-light.png and ` +
          `${out}-settings-{light,dark}.png`,
      );
    });
    process.exit(0);
  }

  // The typing hint above the composer: one typist, then three. The whole-page shots
  // are what shows the thing the row is judged on — it starts on the composer's own
  // column, so the faces line up with the words the user types.
  if (args.includes("--typing")) {
    // The row is 20px tall, so `--dpr 4` is how the faces in it are really read.
    await withPreview(
      async ({ page, shot, setTheme, emit }) => {
        const conversationId = await openConversation(page, "Ava Thompson");
        const indicator = '[data-testid="typing-indicator"]';
        const typers = [
          { sender: "Lucas Silva", sender_mri: "8:orgid:lucas-silva" },
          { sender: "Mia Chen", sender_mri: "8:orgid:mia-chen" },
          { sender: "Noah Kim", sender_mri: "8:orgid:noah-kim" },
        ];
        const type = (who: (typeof typers)[number]) =>
          emit({ kind: "typing", conversation: conversationId, ...who });

        // 1. One person: their face, their name, the dots.
        await type(typers[0]!);
        await page.waitForSelector(indicator);
        await page.waitForTimeout(300);
        await shot(`${out}-one-light.png`);
        await shot(`${out}-one-row-light.png`, indicator);
        await setTheme("dark");
        await shot(`${out}-one-dark.png`);
        await shot(`${out}-one-row-dark.png`, indicator);
        await setTheme("light");

        // 2. Three of them: the faces stack, and the label counts the one it does not
        //    name. Every typer is re-sent, which is what Teams does while somebody keeps
        //    typing — and it re-arms the hint's own expiry.
        for (const who of typers) await type(who);
        await page.waitForTimeout(300);
        await shot(`${out}-many-light.png`);
        await shot(`${out}-many-row-light.png`, indicator);

        console.log(
          `[preview] wrote ${out}-one-{light,dark}.png, ${out}-one-row-{light,dark}.png, ` +
            `${out}-many-light.png and ${out}-many-row-light.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // The Mail surface: the sidebar's Mail tab plus the reading pane, in both themes.
  if (args.includes("--mail")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openMailTab(page);
      // `--element` crops this one too, which is how a 36px sender face is reviewed
      // (e.g. --element '[data-testid="mail-avatar"]' --dpr 4).
      await shot(`${out}-list-light.png`, element);
      await openFirstMail(page);
      await shot(`${out}-light.png`);
      // The second fixture is the interesting one to look at: file attachments
      // plus an inline image the backend embedded.
      await openMailAt(page, 1);
      await shot(`${out}-attachments-light.png`);
      // The fifth fixture is addressed to a whole room: a face for the sender and
      // for every person it names, and a "+N" chip for the rest.
      await openMailAt(page, 4);
      // `--element` crops the two recipient shots, which is how a 20px face and its
      // chip are reviewed at all (see `--dpr`).
      await shot(`${out}-recipients-light.png`, element);
      // And with the rest revealed, which is where the wrap and the initials of an
      // address the directory cannot name are seen.
      await page.locator('[data-testid="mail-recipients-more"]').click();
      await shot(`${out}-recipients-all-light.png`, element);
      await setTheme("dark");
      await shot(`${out}-recipients-dark.png`, element);
      await shot(`${out}-dark.png`);
      console.log(
        `[preview] wrote ${out}-list-light.png, ${out}-light.png, ` +
          `${out}-attachments-light.png, ${out}-recipients-{light,all-light,dark}.png ` +
          `and ${out}-dark.png`,
      );
    });
    process.exit(0);
  }

  // The merge-request page: the sidebar's list, one merge request in full with its live
  // pipeline, the merge asking twice, and the comment box — in both themes.
  //
  // Nothing here reaches GitLab. The mock holds the merge requests, advances one pipeline a
  // step per read and answers the four writes in memory (see the `gitlab_mr_*` fixtures in
  // web/mock/server.ts), which is what makes an irreversible action reviewable at all.
  if (args.includes("--gitlab")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        // The tab STRIP first, in both of its states: the tanuki is GitLab's line while the
        // section is at rest — one weight across five icons — and GitLab's own colours once it
        // is the current one. Pass `--dpr 4`: the mark is 17px, so the two spellings are only
        // really readable enlarged (see `GitLabLogoOutline`).
        const strip = '[role="tablist"]';
        await shot(`${out}-tabs-rest-light.png`, strip);
        await setTheme("dark");
        await shot(`${out}-tabs-rest-dark.png`, strip);
        await setTheme("light");

        await openGitLabTab(page);
        await shot(`${out}-tabs-current-light.png`, strip);
        await setTheme("dark");
        await shot(`${out}-tabs-current-dark.png`, strip);
        await setTheme("light");
        await shot(`${out}-list-light.png`, element);

        // The first fixture is the interesting one: it can merge, its pipeline is running,
        // and it carries a thread with a code comment on it.
        await openMergeRequestAt(page, 0);
        await shot(`${out}-light.png`);

        // The HEADER, cropped: the two decisions this page is opened to make — the approval and
        // the merge — stand at its right, before the reload and the way out to GitLab. Both
        // themes, because the merge is the one control here drawn in the accent and a wrong
        // token shows as a flat tile.
        const paneHeader = '[data-testid="gitlab-pane"] > header';
        await shot(`${out}-actions-light.png`, paneHeader);
        await setTheme("dark");
        await shot(`${out}-actions-dark.png`, paneHeader);
        await setTheme("light");

        // The SUB-HEADER: the four pages of this merge request, in GitLab's own order, with
        // the Overview current. Cropped, because what is worth reading here is which pill is
        // lit and that the four fit — pass `--dpr 4` for the labels.
        const pages = '[data-testid="gitlab-mr-pages"]';
        await shot(`${out}-pages-light.png`, pages);
        await setTheme("dark");
        await shot(`${out}-pages-dark.png`, pages);
        await setTheme("light");

        // A page this app does not read yet: it SAYS which one is missing and offers GitLab's
        // own for it. Drawn blank it would read as a read that failed.
        await openMergeRequestPage(page, "commits");
        await shot(`${out}-commits-light.png`);
        await setTheme("dark");
        await shot(`${out}-commits-dark.png`);
        await setTheme("light");
        // And the Pipelines one is BUILT: it holds the graph, which has a capture of its own
        // (`--pipeline`). This one only says the strip really opens it.
        await openMergeRequestPage(page, "pipelines");
        await shot(`${out}-pipelines-light.png`);

        // The strip at a phone's width, which is where four labels have to fit: it scrolls
        // sideways rather than widening the pane, because a header that grows past its column
        // takes the page's own controls off the right of the screen.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await shot(`${out}-pages-mobile-light.png`);
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(400);
        await openMergeRequestPage(page, "overview");

        // The merge ARMED — the second click is the one that lands the branch. The control says
        // so on itself, and the page brings the sentence naming both branches to the reader,
        // because the press was made in a header that does not scroll. The whole page for that
        // pair, then the header cropped in both themes: armed it is the one destructive control
        // on this surface.
        await page.locator('[data-testid="gitlab-merge"]').click();
        await page.locator('[data-testid="gitlab-merge-confirm"]').waitFor();
        await shot(`${out}-merge-armed-light.png`);
        await shot(`${out}-merge-armed-header-light.png`, paneHeader);
        await setTheme("dark");
        await shot(`${out}-merge-armed-header-dark.png`, paneHeader);
        await setTheme("light");
        await page.locator('[data-testid="gitlab-merge-cancel"]').click();

        // The conversation: a standalone comment, a thread with a code comment on it and the
        // user's own reply in it, and the box that posts under their name. The first comment
        // also carries a pasted PICTURE and a badge on somebody else's host, so this says the
        // one that can be drawn is drawn and the other stays a link (see `gitlab-upload.ts`).
        await page.locator('[data-testid="gitlab-comments"]').scrollIntoViewIfNeeded();
        await page.locator('[data-testid="gitlab-note"] [data-testid="message-image"]').first().waitFor();
        await shot(`${out}-comments-light.png`);

        // The DESCRIPTION's own fold, which is how every long one opens: eight lines, the last
        // three of them fading out, and one control under it. The fixture is a whole document —
        // a heading, a table, a fenced block and a task list — so this is what the reader is
        // handed before they ask for the rest. Both themes, because the gradient runs to the
        // page's own background and a wrong token shows as a grey band over the words.
        const description = '[data-testid="gitlab-description"]';
        const descriptionBox = page.locator(description);
        await descriptionBox.scrollIntoViewIfNeeded();
        await shot(`${out}-description-folded-light.png`, description);
        await setTheme("dark");
        await shot(`${out}-description-folded-dark.png`, description);
        await setTheme("light");

        // And opened: the fade is gone, the control says the way back, and nothing else moved.
        const descriptionToggle = page.locator('[data-testid="gitlab-description-toggle"]');
        await descriptionToggle.click();
        await page.waitForTimeout(400);
        await shot(`${out}-description-open-light.png`, description);

        // The PICTURE the description ends with — a screenshot pasted into it, drawn from
        // bytes the BACKEND fetched, because GitLab serves an upload to a token and answers a
        // browser 404 (measured). Both themes, and the picture itself cropped: what is worth
        // reading here is that a body which used to print `![image.png](/uploads/…)` as text
        // now shows the picture, at the size its own attribute block asked for.
        const picture = '[data-testid="gitlab-description"] [data-testid="message-image"]';
        await page.locator(picture).waitFor();
        await page.locator(picture).scrollIntoViewIfNeeded();
        await shot(`${out}-description-picture-light.png`, picture);
        await setTheme("dark");
        await shot(`${out}-description-picture-dark.png`, description);
        await setTheme("light");

        // The DESCRIPTION on a phone, which is the width its markdown has to survive: the
        // fixture's 3-column table and its fenced command lines are both wider than 390px, so
        // this says whether they scroll inside the description or widen the page and take the
        // Merge button off screen (see `gitlab-markdown.ts`, and the renderer's own `table`
        // and `pre` cases). It is captured OPEN — the click above left it so — because a table
        // behind the fold says nothing about the width it needs.
        await descriptionBox.scrollIntoViewIfNeeded();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await shot(`${out}-description-mobile-light.png`);
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(400);

        // A merge request GitLab will not merge: the button is disabled and the reason is on
        // it, rather than a refusal arriving after the click.
        await openMergeRequestAt(page, 1);
        await shot(`${out}-blocked-light.png`);
        await setTheme("dark");
        await shot(`${out}-blocked-dark.png`);
        await setTheme("light");

        // A LONG title — the fixture's own, which is the length an author on the tenant
        // writes when they list every ticket a branch closes. The header shortens it to one
        // line and the heading wraps, and neither widens the page: the whole layout used to
        // grow to the title's own width, which pushed the article and its controls off the
        // right of the screen. On a phone too, where the page is the only column there is.
        await openMergeRequestAt(page, 2);
        await shot(`${out}-long-title-light.png`);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await shot(`${out}-long-title-mobile-light.png`);
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(400);

        // The PEOPLE rows, in both of their shapes — cropped, because what is worth reading
        // is which rows there are. !63 is assigned to somebody other than its author and names
        // the two; !596 is assigned to the person who wrote it and names them ONCE, as
        // "Author & assignee" (see `mergeRequestPeopleLines`).
        const people = '[data-testid="gitlab-people-rows"]';
        await openMergeRequestAt(page, 3);
        await shot(`${out}-people-light.png`, people);
        await openMergeRequestAt(page, 0);
        await shot(`${out}-people-authored-light.png`, people);
        await setTheme("dark");
        await shot(`${out}-people-authored-dark.png`, people);

        // …and the whole page in the dark theme, which this merge request is already on.
        await shot(`${out}-dark.png`);
        console.log(
          `[preview] wrote ${out}-tabs-{rest,current}-{light,dark}.png, ` +
            `${out}-list-light.png, ${out}-light.png, ` +
            `${out}-actions-{light,dark}.png, ` +
            `${out}-pages-{light,dark,mobile-light}.png, ` +
            `${out}-commits-{light,dark}.png, ${out}-pipelines-light.png, ` +
            `${out}-merge-armed-light.png, ` +
            `${out}-merge-armed-header-{light,dark}.png, ${out}-comments-light.png, ` +
            `${out}-description-picture-{light,dark}.png, ` +
            `${out}-description-mobile-light.png, ` +
            `${out}-long-title-{light,mobile-light}.png, ` +
            `${out}-blocked-{light,dark}.png, ${out}-people-light.png, ` +
            `${out}-people-authored-{light,dark}.png and ${out}-dark.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // The PIPELINE: the compact graph the Overview draws, and the Pipelines page it opens —
  // grouped by dependency and by stage, the curves lit and off, one job pointed at, and both on
  // a phone. Nothing here reaches GitLab: the mock's own pipeline declares `needs` (see
  // `MOCK_LIVE_PIPELINE_JOBS`), which is what makes the whole surface reviewable.
  if (args.includes("--pipeline")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        await openGitLabTab(page);
        await openMergeRequestAt(page, 0);

        // The PANEL first: a look at the run, in the shape the pipeline's own author wrote.
        await page.locator('[data-testid="gitlab-pipeline"]').scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await shot(`${out}-panel-light.png`, '[data-testid="gitlab-pipeline"]');
        await setTheme("dark");
        await shot(`${out}-panel-dark.png`, '[data-testid="gitlab-pipeline"]');
        await setTheme("light");

        // The PAGE, grouped by dependency — which is what the mock's pipeline declares, so it
        // is what the page opens on.
        await openPipelinePage(page);
        await shot(`${out}-needs-light.png`);
        await setTheme("dark");
        await shot(`${out}-needs-dark.png`);
        await setTheme("light");

        // ONE JOB pointed at: everything it waits for and everything waiting on it stays lit,
        // and the rest of the graph goes faint.
        await page.locator('[data-testid="gitlab-pipeline-job"][data-name="🧪 unit"]').hover();
        await page.waitForTimeout(300);
        await shot(`${out}-focused-light.png`);

        // The same run grouped by STAGE, with the curves still lit: the dependencies are a fact
        // about the pipeline rather than about the grouping.
        await page.mouse.move(4, 4);
        await setPipelineGrouping(page, "stage");
        await shot(`${out}-stage-light.png`);

        // And with them off, which is the plain stage view.
        await page.locator('[data-testid="gitlab-pipeline-needs-toggle"]').click();
        await page.waitForSelector('[data-testid="gitlab-pipeline-graph"][data-needs="hidden"]');
        await page.waitForTimeout(250);
        await shot(`${out}-stage-plain-light.png`);
        await page.locator('[data-testid="gitlab-pipeline-needs-toggle"]').click();

        // The JOBS list, which is the view a phone reads better — durations down one column.
        await page.locator('[data-testid="gitlab-pipeline-view"] [data-value="jobs"]').click();
        await page.waitForSelector('[data-testid="gitlab-pipeline-jobs"]');
        await shot(`${out}-jobs-light.png`);
        await page.locator('[data-testid="gitlab-pipeline-view"] [data-value="graph"]').click();
        await page.waitForSelector('[data-testid="gitlab-pipeline-graph"]');

        // A PHONE: the graph scrolls sideways inside its own box, and the header's controls stay
        // on screen — the failure this width exists to catch.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await shot(`${out}-mobile-light.png`);
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(400);

        // A pipeline that FAILED, which is where the four colours are told apart: red for the
        // test that blocks the merge, orange for the review nobody has to fix, neutral for the
        // deploy that will never run now.
        await openGitLabTab(page);
        await openMergeRequestAt(page, 1);
        await openPipelinePage(page);
        // The pointer is left wherever the press was, and a card under it IS hovered — which
        // would capture the graph half-dimmed rather than as a reader first meets it.
        await page.mouse.move(4, 4);
        await page.waitForTimeout(250);
        await shot(`${out}-failed-light.png`);
        await setTheme("dark");
        await shot(`${out}-failed-dark.png`);

        console.log(
          `[preview] wrote ${out}-panel-{light,dark}.png, ${out}-needs-{light,dark}.png, ` +
            `${out}-focused-light.png, ${out}-stage-light.png, ${out}-stage-plain-light.png, ` +
            `${out}-jobs-light.png, ${out}-mobile-light.png and ${out}-failed-{light,dark}.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // ONE JOB's LOG: the page a job card opens. Everything the renderer has to draw is in the
  // mock's own trace — sections that NEST, ANSI colour over 16 names and the 256-colour cube, a
  // progress line rewritten in place — plus the three states that are not a log at all: a job
  // that has not run, a log too big to travel whole, and a read that was refused.
  if (args.includes("--job-log")) {
    await withPreview(
      async ({ page, shot, setTheme, emit }) => {
        await openGitLabTab(page);
        await openMergeRequestAt(page, 1);
        await openPipelinePage(page);

        // The way IN: a card in the graph, which is a link to the log rather than a trip out to
        // GitLab. Cropped to one card — pass `--dpr 4` to read its own words.
        const card = '[data-testid="gitlab-pipeline-job"][data-status="failed"]';
        await page.locator(card).first().hover();
        await page.waitForTimeout(250);
        await shot(`${out}-card-light.png`, card);

        // THE PAGE, on the job that failed: the sections the runner wrote, the colours it wrote
        // them in, and what the job cost above them.
        await page.mouse.move(4, 4);
        const failed = (await page.locator(card).first().getAttribute("data-name")) ?? "";
        await openJobLog(page, failed);
        await page.waitForTimeout(300);
        await shot(`${out}-light.png`);
        await setTheme("dark");
        await shot(`${out}-dark.png`);
        await setTheme("light");

        // FOLDED: every section shut, which is the shape a reader scans a long run in — each row
        // says what its section is called and what it cost.
        await page.locator('[data-testid="gitlab-job-log-fold-all"]').click();
        await page.waitForTimeout(250);
        await shot(`${out}-folded-light.png`);
        await page.locator('[data-testid="gitlab-job-log-fold-all"]').click();
        await page.waitForTimeout(250);

        // FILTERED: the lines that say `error`, each keeping the log's own line number — which is
        // what takes the reader back into the log in place.
        await page.locator('[data-testid="gitlab-job-log-search"]').fill("error");
        await page.waitForTimeout(300);
        await shot(`${out}-filtered-light.png`);
        await setTheme("dark");
        await shot(`${out}-filtered-dark.png`);
        await setTheme("light");
        await page.locator('[data-testid="gitlab-job-log-search-clear"]').click();

        // A PHONE: one column, sideways scrolling for a long line, and the header's own controls
        // still on screen.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await shot(`${out}-mobile-light.png`);
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(400);

        // A log too big to travel whole: what is on screen is its END, and the whole of it is in
        // GitLab — this instance refuses a Range read, so there is nothing here to ask with.
        await emit({ kind: "gitlab_mr", truncate_job_log: true });
        await page.locator('[data-testid="gitlab-job-log-reload"]').click();
        await page.waitForSelector('[data-testid="gitlab-job-log-truncated"]');
        await shot(`${out}-truncated-light.png`);
        await emit({ kind: "gitlab_mr", clear: true });

        // A job that has not RUN: its empty log is a state, and the page says which one rather
        // than drawing a blank screen.
        await page.goBack();
        await page.waitForSelector('[data-testid="gitlab-pipeline-page"]');
        await openGitLabTab(page);
        await openMergeRequestAt(page, 0);
        await openPipelinePage(page);
        await page.mouse.move(4, 4);
        await openJobLog(page, "🚀 deploy staging");
        await shot(`${out}-empty-light.png`);

        // A LIVE one: the log is followed as its lines arrive, and the page says it is.
        await page.goBack();
        await page.waitForSelector('[data-testid="gitlab-pipeline-page"]');
        await openJobLog(page, "🧪 unit");
        await page.waitForTimeout(400);
        await shot(`${out}-live-light.png`);

        // And a read that was REFUSED: this page IS that read, so the failure is the whole screen
        // and it offers the one thing left.
        await emit({
          kind: "gitlab_mr",
          refuse_job_log: "GitLab refused: this account may not read the job's log",
        });
        await page.locator('[data-testid="gitlab-job-log-reload"]').click();
        await page.waitForTimeout(600);
        await page.reload();
        await page.waitForSelector('[data-testid="gitlab-job-log-error"]', {
          timeout: APP_READY_TIMEOUT_MS,
        });
        await shot(`${out}-refused-light.png`);
        await emit({ kind: "gitlab_mr", clear: true });

        console.log(
          `[preview] wrote ${out}-card-light.png, ${out}-{light,dark}.png, ` +
            `${out}-folded-light.png, ${out}-filtered-{light,dark}.png, ` +
            `${out}-mobile-light.png, ${out}-truncated-light.png, ${out}-empty-light.png, ` +
            `${out}-live-light.png and ${out}-refused-light.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // The DIFF: the Changes section, which is the one part of this page drawn by somebody
  // else's renderer (`@pierre/trees` and `@pierre/diffs`, behind a lazy import — see
  // web/src/components/gitlab-diff-view.tsx). Every state a real answer holds is in the
  // mock's fixture: a patch, a pure rename, a binary file, a file GitLab collapsed and a
  // generated one, over several languages so the highlighter really resolves more than one
  // grammar.
  if (args.includes("--diff")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        await openGitLabTab(page);
        await openMergeRequestAt(page, 0);

        // The way IN, on the merge-request page: what changed in one line, and the press that
        // opens the diff. Nothing on that page carries a highlighter any more.
        await page.locator('[data-testid="gitlab-changes"]').scrollIntoViewIfNeeded();
        await shot(`${out}-entry-light.png`, '[data-testid="gitlab-changes"]');

        await openChanges(page);

        // The PAGE: the whole screen, the changed files down the left, one of them read on the
        // right. Both themes, because this is where the CSS seam is checked — both renderers
        // live in a shadow root and follow the app's own `color-scheme` rather than the OS's
        // (see app.css § the merge-request DIFF).
        await shot(`${out}-light.png`);
        await setTheme("dark");
        await shot(`${out}-dark.png`);
        await setTheme("light");

        // SPLIT, the layout the page offers only where two columns of code fit.
        await page.locator('[data-testid="gitlab-diff-layout-split"]').click();
        await page.waitForTimeout(500);
        await shot(`${out}-split-light.png`);
        await page.locator('[data-testid="gitlab-diff-layout-unified"]').click();
        await page.waitForTimeout(300);

        // The FEED, scrolled: the reader is reading, and the tree's lit row followed them into
        // whichever file the top of the screen now holds. That pairing is the whole feature, so
        // the shot is the page — both columns — rather than either one of them.
        await scrollDiffFeed(page, 2400);
        await shot(`${out}-scrolled-light.png`);

        // The three files with NO patch, each of which says something different. The shot is
        // the FEED column, because the point of these three is the sentence in place of code —
        // and each is reached the way a reader reaches it, by pressing its row.
        for (const [name, path] of [
          ["rename", "src/server/drain.ts"],
          ["binary", "docs/diagrams/rollout.png"],
          ["collapsed", "bun.lock"],
        ] as const) {
          await pickDiffFile(page, path);
          await shot(`${out}-${name}-light.png`, '[data-testid="gitlab-diff-pane"]');
        }

        // The expanded read: the control names the count and what it costs, at the foot of the
        // files column because that is a fact about that list.
        await shot(`${out}-expand-light.png`, '[data-testid="gitlab-diff-files"]');
        await page.locator('[data-testid="gitlab-diff-expand"]').click();
        // The file that was withheld now has a patch, and the way to look at it is the way a
        // reader looks at any file: press its row. A file the feed has not reached is not in the
        // page at all — that is what virtualized means — so the press is what brings it there.
        await pickDiffFile(page, "bun.lock");
        await page.waitForSelector(
          '[data-testid="gitlab-diff-file"][data-path="bun.lock"][data-state="patch"]',
          { state: "attached", timeout: 15_000 },
        );
        await page.waitForTimeout(600);
        await shot(`${out}-expanded-light.png`);

        // And on a PHONE, where the page is one column at a time. It opens on whichever column
        // the reader was IN — a patch here, because they had picked a file on the wide screen,
        // which is the right answer: narrowing a window must not take away what was being read.
        // Back is then how the files are reached, and a pick is how a file is.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(600);
        await page.locator('[data-testid="gitlab-diff-back"]').click();
        await page.waitForSelector('[data-testid="gitlab-diff-page"][data-column="files"]');
        await page.waitForTimeout(400);
        await shot(`${out}-mobile-files-light.png`);
        await pickDiffFile(page, "src/server/health.ts");
        await shot(`${out}-mobile-patch-light.png`);
        await page.setViewportSize(VIEWPORT);

        console.log(
          `[preview] wrote ${out}-entry-light.png, ${out}-{light,dark}.png, ` +
            `${out}-split-light.png, ${out}-scrolled-light.png, ` +
            `${out}-{rename,binary,collapsed}-light.png, ` +
            `${out}-expand-light.png, ${out}-expanded-light.png and ` +
            `${out}-mobile-{files,patch}-light.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // A COMMENT on a diff line: the gesture that starts one, the box it opens under the line,
  // and the thread that is already there.
  //
  // The gesture is the point and it is a POINTER one, so it is driven here the way a reader
  // makes it: pressing a line number, and dragging from one line number to another. Both go
  // through the mock like every other write in this suite — nothing reaches a GitLab.
  if (args.includes("--diff-comment")) {
    // The one file every gesture below is made in. In a feed a line number names nothing on its
    // own, so the file travels with it — the rule the app itself follows.
    const HEALTH_FILE = "src/server/health.ts";
    await withPreview(
      async ({ page, shot, setTheme }) => {
        await openGitLabTab(page);
        await openMergeRequestAt(page, 0);
        await openChanges(page);
        await pickDiffFile(page, HEALTH_FILE);

        // The THREAD already on this file, and its span. It is a comment on lines 8–10 by a
        // colleague with the user's own reply under it, so the deletion that makes commenting
        // acceptable is on screen too.
        await page.waitForSelector('[data-testid="gitlab-diff-thread"]', { timeout: 15_000 });
        await shot(`${out}-thread-light.png`, '[data-testid="gitlab-diff-thread"]');
        await setTheme("dark");
        await shot(`${out}-thread-dark.png`, '[data-testid="gitlab-diff-thread"]');
        await setTheme("light");

        // The AFFORDANCE: hovering a line reveals the control that says a comment can go
        // there. It is pierre's own gutter slot, wearing this app's glyph.
        await diffGutterLine(page, HEALTH_FILE, 5).hover();
        await page.waitForTimeout(200);
        await shot(`${out}-affordance-light.png`, '[data-testid="gitlab-diff-pane"]');

        // ONE LINE: a press on its number opens the box under it.
        await diffGutterLine(page, HEALTH_FILE, 5).click();
        await page.waitForSelector('[data-testid="gitlab-diff-composer"][data-lines="Line 5"]', {
          timeout: 10_000,
        });
        await shot(`${out}-line-light.png`, '[data-testid="gitlab-diff-pane"]');

        // SEVERAL: a drag from one line number down to another, which is the half of the
        // gesture nobody discovers by looking — hence the hint on the control.
        await dragDiffLines(page, HEALTH_FILE, 3, 6);
        await page.waitForSelector('[data-testid="gitlab-diff-composer"][data-lines="Lines 3–6"]', {
          timeout: 10_000,
        });
        await shot(`${out}-range-light.png`, '[data-testid="gitlab-diff-pane"]');
        await setTheme("dark");
        await shot(`${out}-range-dark.png`, '[data-testid="gitlab-diff-pane"]');
        await setTheme("light");

        // The comment posted: the box goes, and the thread it made hangs on the same lines.
        await page.locator('[data-testid="gitlab-diff-comment-input"]').fill(
          "This whole block runs on every probe — worth a note about the cost.",
        );
        await shot(`${out}-written-light.png`, '[data-testid="gitlab-diff-composer"]');
        await page.locator('[data-testid="gitlab-diff-comment-send"]').click();
        await page.waitForSelector('[data-testid="gitlab-diff-composer"]', {
          state: "detached",
          timeout: 15_000,
        });
        await page.waitForTimeout(600);
        await shot(`${out}-posted-light.png`, '[data-testid="gitlab-diff-pane"]');

        // What the reader may do to a thread afterwards: rewrite their own words, and settle it.
        const thread = page.locator('[data-testid="gitlab-diff-thread"][data-lines="Lines 8–10"]');
        await thread
          .locator('[data-testid="gitlab-diff-note"][data-mine="true"]')
          .first()
          .locator('[data-testid="gitlab-diff-note-edit"]')
          .click();
        await page.waitForSelector('[data-testid="gitlab-diff-note-edit-input"]', {
          timeout: 10_000,
        });
        await shot(`${out}-edit-light.png`, '[data-testid="gitlab-diff-thread"]');
        await thread.locator('[data-testid="gitlab-diff-note-edit-cancel"]').click();

        // RESOLVED, which folds the thread the way GitLab's own diff does: a settled objection
        // has no claim on two centimetres of somebody's code.
        await thread.locator('[data-testid="gitlab-diff-thread-resolve"]').click();
        await page.waitForSelector(
          '[data-testid="gitlab-diff-thread"][data-resolved="true"]:not([data-open])',
          { timeout: 10_000 },
        );
        await shot(`${out}-resolved-light.png`, '[data-testid="gitlab-diff-pane"]');
        await setTheme("dark");
        await shot(`${out}-resolved-dark.png`, '[data-testid="gitlab-diff-thread"]');
        await setTheme("light");
        // …and the reopen is the same control the other way round.
        await thread.locator('[data-testid="gitlab-diff-thread-resolve"]').click();
        await page.waitForSelector('[data-testid="gitlab-diff-thread"][data-open="true"]', {
          timeout: 10_000,
        });

        // And on a PHONE, where the box shares the screen with the code it is about.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(600);
        await diffGutterLine(page, HEALTH_FILE, 5).click();
        await page.waitForSelector('[data-testid="gitlab-diff-composer"]', { timeout: 10_000 });
        await shot(`${out}-mobile-light.png`);
        await page.setViewportSize(VIEWPORT);

        console.log(
          `[preview] wrote ${out}-thread-{light,dark}.png, ${out}-affordance-light.png, ` +
            `${out}-line-light.png, ${out}-range-{light,dark}.png, ${out}-written-light.png, ` +
            `${out}-posted-light.png, ${out}-edit-light.png, ` +
            `${out}-resolved-{light,dark}.png and ${out}-mobile-light.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // The local agent answering in a thread: every phase of one run, light and dark.
  //
  // Nothing here reaches a tenant. The mock runs no CLI — it reproduces the flow (see
  // `simulateMockAgentRun` in web/mock/server.ts), which is what makes this surface
  // reviewable without asking a real agent a real question in a real channel.
  if (args.includes("--agent-reply")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openFirstConversation(page);
      await turnAgentOn(page);

      await askAgent(page, "@claude which port does the backend listen on?");
      await shot(`${out}-thinking-light.png`);
      // Best-effort: a tool call is a phase of the run, and a capture that arrives after
      // it must not take the whole preview down with it. `MOCK_AGENT_STEP_MS` is what
      // widens the window (the mock reads it — see web/mock/server.ts).
      await page
        .locator('[data-testid="agent-activity"]')
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() =>
          console.log("[preview] no tool call on screen — capturing the run as it stands"),
        );
      await shot(`${out}-working-light.png`);
      // Stop sits on the live bubble's own header while the run streams — the control that
      // ends a run mid-answer, reachable from any client watching one. Captured on the
      // bubble, in both themes, because it is a per-vendor mark's neighbour.
      const stop = page.locator('[data-testid="agent-stop"]');
      if (await stop.count()) {
        await shot(
          `${out}-stop-light.png`,
          '[data-testid="message"]:has([data-testid="agent-signature"]), [data-testid="agent-pending"]',
        );
        await setTheme("dark");
        await shot(
          `${out}-stop-dark.png`,
          '[data-testid="message"]:has([data-testid="agent-signature"]), [data-testid="agent-pending"]',
        );
        await setTheme("light");
      } else {
        console.log("[preview] the run finished before Stop could be captured");
      }
      // The transcript at its fullest, on its own, which is where its detail is: the
      // reasoning being written, a finished call and a running one, the rail they hang
      // off, and the ceiling it scrolls itself inside once it has all of that.
      await page
        .locator('[data-testid="agent-activity"]')
        .nth(1)
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => console.log("[preview] one call only — capturing the transcript as it is"));
      await shot(`${out}-transcript-light.png`, '[data-testid="agent-transcript"]');
      await scrollToNewest(page);
      // Both themes while the run is WAITING, because that is the state the shimmer
      // stands in for — and shadcn's utility derives its highlight from the text's own
      // colour through a dark-only branch, so one theme proves half of it.
      await setTheme("dark");
      await shot(`${out}-working-dark.png`);
      await setTheme("light");
      // Also best-effort, for the same reason: the run is a real clock, and a preview
      // that arrives after a phase should capture the next one rather than die.
      await page
        .locator('[data-testid="agent-stream"][data-phase="writing"]')
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => console.log("[preview] the answer was already written — capturing that"));
      await page.waitForTimeout(900);
      await shot(`${out}-writing-light.png`);
      // The bubble on its own, where the detail is: the mark, the caret at the end of
      // the answer, the status line under it. Cropped on the MESSAGE, not on the stream:
      // the stream is an overlay that goes when the run ends, and a crop is exactly the
      // slow operation that arrives after it.
      await shot(
        `${out}-bubble-light.png`,
        '[data-testid="message"]:has([data-testid="agent-signature"])',
      );
      await scrollToNewest(page);
      await setTheme("dark");
      await shot(`${out}-writing-dark.png`);

      // The finished answer, which is also what every reply this app never watched
      // being written looks like: the stream is gone and the message renders alone.
      await page.waitForSelector('[data-testid="agent-signature"]');
      await page.waitForFunction(
        `!document.querySelector('[data-testid="agent-status"]')`,
        undefined,
        { timeout: 30_000 },
      );
      await page.waitForTimeout(400);
      await shot(`${out}-done-dark.png`);
      await setTheme("light");
      await shot(`${out}-done-light.png`);

      // THE SIDEBAR ROW, which is the other place this reply is read — and the place it used
      // to be read wrongly: "You: …" over words a machine wrote, ending in the line the
      // bubble deliberately strips. Cropped in both themes, because the whole subject is two
      // lines of an eleven-pixel row.
      const openRow = '[data-testid="conversation-row"][data-open="true"]';
      await shot(`${out}-row-light.png`, openRow);
      await setTheme("dark");
      await shot(`${out}-row-dark.png`, openRow);
      await setTheme("light");

      // The work survives the run: the finished reply keeps the folded row, and the same
      // rows are behind it. Captured open, on the bubble, because that is the state a
      // reader reaches for after the answer has landed.
      await page.locator('[data-testid="agent-transcript-toggle"]').last().click();
      await shot(
        `${out}-kept-light.png`,
        '[data-testid="message"]:has([data-testid="agent-transcript"])',
      );
      await scrollToNewest(page);

      // The other CLI, whose mark is drawn per theme (opencode ships one logo per
      // background) — so it is captured on both.
      await askAgent(page, "@opencode and where do the web ports live?");
      await page.waitForSelector('[data-testid="agent-stream"][data-phase="writing"]');
      await shot(`${out}-opencode-light.png`);
      await shot(`${out}-opencode-coin-light.png`, '[data-testid="agent-coin"][data-backend="opencode"]');
      await scrollToNewest(page);
      await setTheme("dark");
      await shot(`${out}-opencode-dark.png`);
      await shot(`${out}-opencode-coin-dark.png`, '[data-testid="agent-coin"][data-backend="opencode"]');
      console.log(
        `[preview] wrote ${out}-{thinking,working,stop,transcript,writing,done,row,opencode}-*.png`,
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
      // The two placements Teams gives a channel beyond its team. A pin lifts one to
      // the top; the channels Teams HIDES sit folded at the foot of their team, which
      // is what the flag the sidebar used to call "favorite" actually means.
      // The pin sits beside its row, not inside it, so both are addressed by index.
      await page.locator('[data-testid="channel-row"]').nth(1).hover();
      await page.locator('[data-testid="channel-pin"]').nth(1).click();
      await page.waitForSelector('[data-testid="pinned-group"]');
      await page.locator('[data-testid="hidden-header"]').first().click();
      await page.waitForTimeout(250); // the chevron rotates; capture it settled
      await shot(`${out}-placement-light.png`);
      // Leave the tree as every other shot expects it.
      await page.locator('[data-testid="hidden-header"]').first().click();
      await page.locator('[data-testid="pinned-group"] [data-testid="channel-pin"]').click();
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
      // A channel post has a TITLE and a chat message does not: the composer's own field,
      // empty and then filled, and the post it becomes — the heading drawn as a heading.
      await shot(`${out}-subject-empty-dark.png`, '[data-testid="composer-shell"]');
      await setTheme("light");
      await page.locator('[data-testid="composer-subject"]').fill("Ship the US envs on Friday");
      await typeInComposer(page, "The state diff is behind a feature flag now.");
      await shot(`${out}-subject-light.png`, '[data-testid="composer-shell"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="thread-subject"]');
      const titled = page
        .locator('[data-testid="thread-group"]')
        .filter({ hasText: "The state diff is behind a feature flag now." })
        .first();
      await titled.screenshot({ path: `${out}-titled-post-light.png`, animations: "disabled" });
      await setTheme("dark");
      await titled.screenshot({ path: `${out}-titled-post-dark.png`, animations: "disabled" });
      // The composer grows a row on a channel, and this app is read from a PHONE — where the
      // box is the whole width and every field in it competes with the keyboard.
      await setTheme("light");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-testid="composer-subject"]').fill("Ship the US envs on Friday");
      await typeInComposer(page, "One more line, written on a phone.");
      await shot(`${out}-subject-phone-light.png`);
      await page.setViewportSize(VIEWPORT);
      console.log(
        `[preview] wrote ${out}-tree-light.png, ${out}-open-light.png, ` +
          `${out}-collapsed-light.png, ${out}-placement-light.png, ${out}-card-light.png, ` +
          `${out}-card-dark.png, ${out}-card-actions-dark.png, ${out}-dark.png, ` +
          `${out}-subject-{empty-dark,light,phone-light}.png and ` +
          `${out}-titled-post-{light,dark}.png`,
      );
    });
    process.exit(0);
  }

  // The picture lightbox: a chat image opened, the same picture magnified with the
  // wheel, and a SMALL picture — the one that has to grow, since a preview the size
  // of the thumbnail it came from reads as a dead click.
  if (args.includes("--image")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openConversation(page, "Media Gallery");
      const images = page.locator('[data-testid="message-image"]');
      await shot(`${out}-thread-light.png`);

      await openImageLightbox(page, images.first());
      await shot(`${out}-open-light.png`);
      // Scrolling magnifies around the pointer instead of dismissing.
      await page.mouse.move(760, 300);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(300);
      await shot(`${out}-zoomed-light.png`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);

      const small = page
        .locator("[data-message-id]")
        .filter({ hasText: "The exported icon" })
        .locator('[data-testid="message-image"]');
      await openImageLightbox(page, small);
      await shot(`${out}-small-light.png`);
      await setTheme("dark");
      await shot(`${out}-small-dark.png`);
      console.log(
        `[preview] wrote ${out}-thread-light.png, ${out}-open-light.png, ` +
          `${out}-zoomed-light.png and ${out}-small-{light,dark}.png`,
      );
    });
    process.exit(0);
  }

  // The composer holding several pictures at once: the row of thumbnails above the
  // field, each with its own size and its own remove button, and the sentence an
  // eleventh earns. The files are this app's own icons, so nothing is fetched and the
  // three pixel sizes under them differ — which is the part a reviewer reads.
  if (args.includes("--compose-images")) {
    const icons = [
      "public/icons/icon-192.png",
      "public/icons/apple-touch-icon-180.png",
      "public/icons/icon-512.png",
    ];
    await withPreview(async ({ page, shot, setTheme }) => {
      await openFirstConversation(page);
      const input = page.locator('[data-testid="composer-image-input"]');
      await input.setInputFiles(icons);
      const previews = page.locator('[data-testid="composer-image-preview"]');
      await previews.nth(icons.length - 1).waitFor();
      await typeInComposer(page, "Three shots of the same icon");
      await shot(`${out}-light.png`);
      await setTheme("dark");
      await shot(`${out}-dark.png`);
      await setTheme("light");
      // The ceiling, stated where the pictures are. The batch keeps the ten that fit.
      await input.setInputFiles(Array.from({ length: 8 }, () => icons[0]!));
      await page.locator('[data-testid="composer-image-error"]').waitFor();
      await shot(`${out}-full-light.png`);
      console.log(`[preview] wrote ${out}-{light,dark}.png and ${out}-full-light.png`);
    });
    process.exit(0);
  }

  // Sending later: the moments the composer offers, the picker for any other one, and
  // the line that says where the words went once Teams is holding the message.
  //
  // Nothing leaves the machine: the mock takes the moment and refuses the same ones the
  // backend would (see `parseScheduledTime` in web/mock/server.ts).
  if (args.includes("--schedule")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      await openFirstConversation(page);
      await typeInComposer(page, "Ship it in the morning");
      // The control: one pill, Send and the chevron that discloses "later".
      await shot(`${out}-control-light.png`, '[data-testid="composer-send-group"]');
      await page.locator('[data-testid="composer-schedule"]').click();
      await page.locator('[data-testid="composer-schedule-menu"]').waitFor();
      await page.waitForTimeout(250); // the menu fades in; capture it settled, not at 60%
      await shot(`${out}-menu-light.png`);
      await setTheme("dark");
      await shot(`${out}-menu-dark.png`);
      await setTheme("light");
      // Any other moment: a row that opens a dialog, because the browser's own calendar is
      // not in the document and pressing it used to dismiss the menu it sat in.
      await page.locator('[data-testid="composer-schedule-custom-open"]').click();
      await page.locator('[data-testid="composer-schedule-custom-dialog"]').waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-custom-light.png`);
      await setTheme("dark");
      await shot(`${out}-custom-dark.png`);
      await setTheme("light");
      // A moment that has passed, refused before the send rather than by one.
      const gone = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      await page.locator('[data-testid="composer-schedule-custom"]').fill(
        `${gone.getFullYear()}-${pad(gone.getMonth() + 1)}-${pad(gone.getDate())}` +
          `T${pad(gone.getHours())}:${pad(gone.getMinutes())}`,
      );
      await page.locator('[data-testid="composer-schedule-confirm"]').click();
      await page.locator('[data-testid="composer-schedule-error"]').waitFor();
      await shot(`${out}-refused-light.png`);
      // Queued: the thread has nothing new, and the BANNER above the composer is what
      // accounts for the words — with the way into the list beside it.
      await page.locator('[data-testid="composer-schedule-custom-cancel"]').click();
      await page.locator('[data-testid="composer-schedule"]').click();
      await page.locator('[data-testid="composer-schedule-preset"]').first().click();
      await page.locator('[data-testid="composer-schedule-note"]').waitFor();
      await shot(`${out}-queued-light.png`);
      await setTheme("dark");
      await shot(`${out}-queued-dark.png`);
      await setTheme("light");
      // The list, and the three things a row offers.
      await page.locator('[data-testid="composer-schedule-open-list"]').click();
      await page.locator('[data-testid="scheduled-messages-dialog"]').waitFor();
      await shot(`${out}-list-light.png`);
      await setTheme("dark");
      await shot(`${out}-list-dark.png`);
      await setTheme("light");
      // The deletion armed: it asks twice, like every other deletion in this app.
      await page.locator('[data-testid="scheduled-delete"]').first().click();
      await page.locator('[data-testid="scheduled-delete-confirm"]').first().waitFor();
      await shot(`${out}-armed-light.png`);
      await page.keyboard.press("Escape");

      // A PHONE. Every surface of this feature is reached from a composer that is the whole
      // width of the screen there, so each one is captured again at 390px: a menu that
      // overflowed, a dialog wider than the viewport or a row whose controls fell off the
      // right are all invisible at 1200px.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await shot(`${out}-mobile-banner-light.png`);
      // The chevron is disabled on an empty box, so there are words to schedule again.
      await typeInComposer(page, "Ship it in the morning");
      await page.locator('[data-testid="composer-schedule"]').click();
      await page.locator('[data-testid="composer-schedule-menu"]').waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-mobile-menu-light.png`);
      await page.locator('[data-testid="composer-schedule-custom-open"]').click();
      await page.locator('[data-testid="composer-schedule-custom-dialog"]').waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-mobile-custom-light.png`);
      await page.locator('[data-testid="composer-schedule-custom-cancel"]').click();
      await page.locator('[data-testid="composer-schedule-open-list"]').click();
      await page.locator('[data-testid="scheduled-messages-dialog"]').waitFor();
      await page.waitForTimeout(250);
      await shot(`${out}-mobile-list-light.png`);
      await setTheme("dark");
      await shot(`${out}-mobile-list-dark.png`);
      await setTheme("light");
      await page.setViewportSize({ width: 1200, height: 850 });
      console.log(
        `[preview] wrote ${out}-control-light.png, ${out}-menu-{light,dark}.png, ` +
          `${out}-custom-{light,dark}.png, ${out}-refused-light.png, ` +
          `${out}-queued-{light,dark}.png, ${out}-list-{light,dark}.png, ` +
          `${out}-armed-light.png and ${out}-mobile-{banner,menu,custom,list}-*.png`,
      );
    });
    process.exit(0);
  }

  // The chat list's own sections and the "…" menu that fills them: Teams' settings
  // for one chat (pin, mute, hide, mark read), and what each one does to the list.
  //
  // Nothing here leaves the machine — pin, mute and hide are local overrides, and the
  // mock answers `mark_read` itself.
  if (args.includes("--chat-menu")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      // The list as it arrives: a Pinned section (the mock pins two chats) and Recent.
      // Nothing is hidden until the user hides something — Teams' own `hidden` flag is
      // not a hide (see `chatIsHidden`), so the app does not bucket on it.
      await shot(`${out}-sections-light.png`);
      // The menu on a Recent row — every item, in both themes.
      const chat = await page
        .locator('[data-testid="conversation-row"][data-section="recent"]')
        .first()
        .getAttribute("data-conversation-id");
      await openChatMenu(page, chat ?? undefined);
      await shot(`${out}-menu-light.png`);
      await setTheme("dark");
      await shot(`${out}-menu-dark.png`);
      await setTheme("light");
      // Pin it, then mute it. Each item acts and closes, as in Teams, so the menu is
      // opened again on the row — which has moved up into Pinned by then. The mute goes
      // out through `set_chat_muted`, which the mock answers as the tenant would.
      await page.locator('[data-testid="chat-menu-pin"]').click();
      await page.waitForTimeout(250);
      await openChatMenu(page, chat ?? undefined);
      await page.locator('[data-testid="chat-menu-mute"]').click();
      await page.waitForTimeout(250);
      await shot(`${out}-pinned-light.png`);
      // Hide a chat, which is what creates the Hidden section at the foot of the list —
      // and where a chat put away is brought back from.
      const other = await page
        .locator('[data-testid="conversation-row"][data-section="recent"]')
        .first()
        .getAttribute("data-conversation-id");
      await openChatMenu(page, other ?? undefined);
      await page.locator('[data-testid="chat-menu-hide"]').click();
      await page.waitForTimeout(250);
      await toggleChatSection(page, "hidden");
      await page
        .locator('[data-testid="conversation-row"][data-section="hidden"]')
        .first()
        .scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await shot(`${out}-hidden-light.png`);
      await setTheme("dark");
      await shot(`${out}-hidden-dark.png`);
      console.log(
        `[preview] wrote ${out}-sections-light.png, ${out}-menu-{light,dark}.png, ` +
          `${out}-pinned-light.png and ${out}-hidden-{light,dark}.png`,
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
      // A PHONE, which is where these are usually read, and the width every line of
      // a card has to shrink to: the seeded long-shape link — a deep group path, a
      // branch named after its ticket — is the one that says whether it does. The
      // thread is opened FIRST and the viewport narrowed after, because below `md`
      // the chat list is the page and the conversation covers it.
      await setTheme("light");
      for (const provider of ["linear", "gitlab"] as const) {
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(300);
        await openConversation(page, provider === "linear" ? "Linear Links" : "GitLab Links");
        await page.waitForSelector(`[data-testid="${provider}-link-card"]`);
        await page.waitForTimeout(600);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(400);
        await shot(`${out}-${provider}-mobile-light.png`);
      }
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(400);
      console.log(
        `[preview] wrote ${out}-{linear,gitlab}-light.png, ${out}-{gitlab,linear}-dark.png and ` +
          `${out}-{linear,gitlab}-mobile-light.png`,
      );
    });
    process.exit(0);
  }

  // A TRACKER REFERENCE in somebody's words: a Linear issue and a GitLab merge request named
  // as text, drawn as the chip that goes to each (see web/src/lib/tracker-ref.ts). Captured on
  // the three surfaces that carry one for three different reasons — a chat message, an agent's
  // own answer, and a merge request's description — because the whole claim of this feature is
  // that they read the same everywhere.
  if (args.includes("--tracker-refs")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      // 1. A CHAT MESSAGE. The seeded thread carries the three cases at once: a bare `!99`
      // resolved from the project this message's own link names, a Linear identifier, and
      // `UTF-8`, which must stay the word it is.
      await openConversation(page, "GitLab Links");
      await page.waitForSelector('[data-testid="tracker-ref"]');
      await page.waitForTimeout(600);
      await shot(`${out}-message-light.png`);
      const bubble = '[data-testid="message"]:has([data-testid="tracker-ref"])';
      await shot(`${out}-bubble-light.png`, bubble);
      await setTheme("dark");
      await shot(`${out}-bubble-dark.png`, bubble);
      await setTheme("light");
      // On a phone, where the chip has to stay one piece: it is `nowrap`, so a narrow bubble
      // wraps around it rather than breaking the mark off its number.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await shot(`${out}-mobile-light.png`);
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(400);

      // 2. An AGENT'S ANSWER, which is where this started: the reply names a merge request and
      // an issue, and the chips are read out of the words the CLI wrote — there is no markup in
      // them (see lib/tracker-ref.ts). Waited out to the finished message, because that is the
      // body every client shows and the one a reader acts on.
      await openFirstConversation(page);
      await turnAgentOn(page);
      await askAgent(page, "@claude which port does the backend listen on?");
      const answer = '[data-testid="message"]:has([data-testid="agent-signature"])';
      // The chips are drawn as the words arrive — the stream goes through the same renderer —
      // so waiting on one is waiting for the part of the answer this capture is about.
      await page
        .locator(`${answer} [data-testid="tracker-ref"]`)
        .last()
        .waitFor({ state: "visible", timeout: 60_000 });
      // Then, best-effort, let the run END, so what is captured is the message's own body
      // rather than the overlay above it: the two agree, and the posted one is what a reader
      // comes back to.
      await page
        .waitForFunction(`!document.querySelector('[data-testid="agent-status"]')`, undefined, {
          timeout: 30_000,
        })
        .catch(() => console.log("[preview] the run is still going — capturing the stream"));
      await page.waitForTimeout(400);
      await shot(`${out}-answer-light.png`, answer);
      await setTheme("dark");
      await shot(`${out}-answer-dark.png`, answer);
      await setTheme("light");

      // 3. A MERGE REQUEST's own description, where a bare `!595` means a merge request of the
      // project the page is about — GitLab's own rule, and the one thing a chat message has no
      // surface to say (see `TrackerProjectProvider`).
      await openGitLabTab(page);
      await openMergeRequestAt(page, 0);
      await page.waitForSelector('[data-testid="gitlab-description"] [data-testid="tracker-ref"]');
      await shot(`${out}-description-light.png`, '[data-testid="gitlab-description"]');
      await setTheme("dark");
      await shot(`${out}-description-dark.png`, '[data-testid="gitlab-description"]');
      console.log(
        `[preview] wrote ${out}-{message,bubble,mobile,answer,description}-*.png`,
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
      // A MEETING, by name. It is the event that carries both ways out of the app and a
      // real invitation body, and it is the width the footer is hardest at — the two are
      // the same fixture, and `.first()` is a Focus block that shows neither.
      await openEvent(page, "ev-overlap-a");
      await shot(`${out}-mobile-details-light.png`);
      // And its "Open in", open: the two destinations that used to be two more buttons.
      await page.locator('[data-testid="calendar-event-open-in"]').click();
      await page.waitForSelector('[data-testid="calendar-event-outlook"]');
      await page.waitForTimeout(200);
      await shot(`${out}-mobile-open-in-light.png`);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(400);
      await setTheme("dark");
      await shot(`${out}-month-dark.png`);
      await openCalendarView(page, "week");
      await shot(`${out}-week-dark.png`);
      console.log(
        `[preview] wrote ${out}-{week,week-all,details,month,day,agenda,weekends,mobile,` +
          `mobile-details,mobile-open-in}-light.png and ${out}-{month,week}-dark.png`,
      );
    });
    process.exit(0);
  }

  // "Always available": the one setting other people can see. Every state, because the
  // copy under the switch is what tells the user who reads the green dot — and the HOURS
  // have two of their own, which are the whole reason the setting is not just a switch:
  // inside them the status is green, outside them nothing is published at all.
  if (args.includes("--available")) {
    await withPreview(async ({ page, shot, setTheme }) => {
      // The pane scrolls, and this section sits below the integrations — so bring it
      // into view before every capture, or the shot is of GitLab's token field.
      const section = page.locator('[data-testid="always-available-settings"]');
      const show = async (name: string) => {
        await section.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await shot(name);
      };
      // The window is aimed relative to NOW, because the mock decides `available_now` on
      // its own clock: a capture pinned to 08:00-19:00 would show "green until" all day
      // and "nothing published until" all night.
      const at = (offsetMinutes: number) => {
        const when = new Date(Date.now() + offsetMinutes * 60_000);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
      };

      await setAlwaysAvailable(page, false);
      await show(`${out}-off-light.png`);
      await setAlwaysAvailable(page, true);
      await show(`${out}-on-light.png`);

      // Hours that are running: green, and the line says when it stops.
      await setAvailableHours(page, { from: at(-60), to: at(60) });
      await show(`${out}-hours-light.png`);
      await setTheme("dark");
      await show(`${out}-hours-dark.png`);

      // Hours that have not come round: the switch is on and nothing is published, which
      // is the state a plain switch could not express.
      await setTheme("light");
      await setAvailableHours(page, { from: at(120), to: at(180) });
      await show(`${out}-waiting-light.png`);
      await setTheme("dark");
      await show(`${out}-on-dark.png`);

      // A window that CROSSES MIDNIGHT: the two thumbs are the same pair, and the green is
      // drawn on the OUTSIDE of them — the one state the slider's own range cannot express.
      await setTheme("light");
      await setAvailableHours(page, { from: "22:00", to: "06:00" });
      await show(`${out}-night-light.png`);

      // A phone's width, because this card now holds a slider, two fields and a zone picker:
      // the row wraps rather than pushing the pane sideways.
      await setAvailableHours(page, { from: "08:00", to: "19:00" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await show(`${out}-mobile-light.png`);
      await page.setViewportSize(VIEWPORT);
      await page.waitForTimeout(300);

      // Leave the shared mock as it was found.
      await setTheme("light");
      await setAvailableHours(page, null);
      await setAlwaysAvailable(page, false);
      console.log(
        `[preview] wrote ${out}-{off,on,hours,waiting,night,mobile}-light.png and ` +
          `${out}-{hours,on}-dark.png`,
      );
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

  // The local-agent menu: the per-conversation switch, and the read-only tool groups
  // the user grants under it. One capture per theme, and one with Grafana granted, so
  // the state a switch lands in is reviewable rather than assumed.
  if (args.includes("--agent")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        await openFirstConversation(page);
        await openAgentMenu(page);
        await shot(`${out}-light.png`, element);
        await setTheme("dark");
        // Re-asserted: the helper is idempotent, and the mock's feed re-renders the pane
        // between two shots often enough to lose a non-modal menu.
        await openAgentMenu(page);
        await shot(`${out}-dark.png`, element);
        await setTheme("light");
        await openAgentMenu(page);
        await page.locator('[data-testid="agent-tool-grant-grafana"]').click();
        await page.waitForSelector('[data-testid="agent-tool-grant-grafana"][data-granted="true"]');
        await shot(`${out}-granted-light.png`, element);
        // And the widest state: the user's own configuration, where the read-only groups
        // stop applying and the menu says what that means.
        await page.locator('[data-testid="agent-unrestricted-toggle"]').click();
        await page.waitForSelector('[data-testid="agent-unrestricted-warning"]');
        await shot(`${out}-own-config-light.png`, element);
        console.log(
          `[preview] wrote ${out}-{light,dark,granted-light,own-config-light}.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // Renaming somebody and giving them a face — the card that offers it, and the dialog
  // it opens. Three captures, because three states have to be looked at rather than
  // assumed: the card before anything is overridden, the dialog with a nickname typed,
  // and the card afterwards — which has to keep saying who Teams calls this person.
  if (args.includes("--person")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        // A 1:1, deliberately: its title IS a person, so the header itself offers the
        // card — which is what makes the retitling visible in the same capture.
        await openConversation(page, "Ava Thompson");
        const header = page.locator('[data-testid="conversation-title"]');
        await header.hover();
        await page.waitForSelector('[data-testid="person-card"]');
        await shot(`${out}-card-light.png`, element ?? '[data-testid="person-card"]');

        await page.locator('[data-testid="person-card-edit"]').click();
        await page.waitForSelector('[data-testid="person-edit-dialog"]');
        await page.locator('[data-testid="person-name-field"]').fill("Ava (design)");
        const dialog = element ?? '[data-testid="person-edit-dialog"]';
        await shot(`${out}-dialog-light.png`, dialog);
        await setTheme("dark");
        await shot(`${out}-dialog-dark.png`, dialog);
        await setTheme("light");

        // Saved: the card now leads with the chosen name and keeps the real one under
        // it. That second line is the honesty half of the whole feature, so it is the
        // one thing here that must be looked at rather than trusted.
        await page.locator('[data-testid="person-edit-save"]').click();
        await page.waitForSelector('[data-testid="person-edit-dialog"]', { state: "detached" });
        await header.hover();
        await page.waitForSelector('[data-testid="person-card-renamed-from"]');
        await shot(`${out}-renamed-light.png`, element ?? '[data-testid="person-card"]');

        // And Settings, which is where a rename made months ago is still reversible.
        await openSettings(page);
        await page.waitForSelector('[data-testid="renamed-person-row"]');
        await shot(`${out}-list-light.png`, element ?? '[data-testid="renamed-people-settings"]');
        console.log(
          `[preview] wrote ${out}-{card-light,dialog-light,dialog-dark,renamed-light,list-light}.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // Custom emoji: the picker, the Add Emoji dialog in both tabs, the `:` list mid-type, a
  // bubble with an inline emoji, an emoji-only bubble drawn jumbo, and the Settings section.
  // Both themes, because each surface must be reviewable. The mock seeds three emoji into
  // the sandbox thread: :shipit: (PNG), :partyparrot: (GIF), and :ship: (an alias of shipit).
  if (args.includes("--custom-emoji")) {
    await withPreview(
      async ({ page, shot, setTheme }) => {
        // This feature's own thread, which carries the colleague's message with real inline
        // emoji markup — and which no other capture or spec asserts on, so the two messages
        // sent below perturb nothing (`seedCustomEmojiThread` in web/mock/server.ts).
        await openConversation(page, "Custom Emoji");
        await clearComposer(page);

        // The `:` list mid-type: the pack's own emoji above the Unicode ones, which is the
        // ordering the whole typeahead promises.
        await typeInComposer(page, ":ship");
        await page.waitForSelector('[data-testid="emoji-suggestions"]');
        await shot(`${out}-typeahead-light.png`, '[data-testid="emoji-suggestions"]');
        await setTheme("dark");
        await shot(`${out}-typeahead-dark.png`, '[data-testid="emoji-suggestions"]');
        await setTheme("light");
        await clearComposer(page);

        // A sent bubble with the art inline in the words, and one that is nothing BUT the
        // art, which Slack draws jumbo — the two sizes side by side in one capture.
        await typeInComposer(page, "shipping it :shipit: today", { send: true });
        await typeInComposer(page, ":shipit:", { send: true });
        await page.waitForSelector('[data-testid="message"] img[alt=":shipit:"]');
        await shot(`${out}-bubbles-light.png`, '[data-testid="message-pane"]');
        await setTheme("dark");
        await shot(`${out}-bubbles-dark.png`, '[data-testid="message-pane"]');
        await setTheme("light");

        // The reaction row, whose top band is the user's own emoji — the one reaction
        // surface where the art is the pack's rather than a message's, and the one that
        // says out loud that no other Teams client draws it.
        await openMessageActions(page);
        const reactionRow = '[data-testid="menu-reaction-picker"]';
        await page.waitForSelector(`${reactionRow} [data-testid="reaction-option-custom-shipit"] img`);
        await shot(`${out}-reactions-light.png`, reactionRow);
        await setTheme("dark");
        await shot(`${out}-reactions-dark.png`, reactionRow);
        await setTheme("light");

        // The chip that row leaves on the message: the art the KEY names, fetched back
        // through the media proxy — what every reader of the thread sees.
        await page
          .locator(`${reactionRow} [data-testid="reaction-option-custom-shipit"]`)
          .click();
        await page.waitForSelector('[data-testid^="reaction-chip-tlcustom-"] img');
        await shot(`${out}-reaction-chip-light.png`, '[data-testid="message-pane"]');
        await setTheme("dark");
        await shot(`${out}-reaction-chip-dark.png`, '[data-testid="message-pane"]');
        await setTheme("light");

        // The emoji picker with custom emoji, reached through the same menu.
        await openMessageActions(page);
        await openReactionPicker(page);
        // The pack's own category, which the picker only grows once the art has loaded — and
        // it is the one surface this feature has that no unit test can reach (emoji-mart
        // draws in a shadow root), so the capture waits for it and then opens it, rather
        // than photographing whatever was on screen first.
        const customCategory = page.locator(
          '[data-testid="emoji-picker"] [aria-label="Custom"]',
        );
        await customCategory.waitFor();
        await customCategory.click();
        await page.waitForTimeout(300); // the grid scrolls to the category
        await shot(`${out}-picker-light.png`, '[data-testid="emoji-picker"]');
        await setTheme("dark");
        await shot(`${out}-picker-dark.png`, '[data-testid="emoji-picker"]');
        await setTheme("light");

        // The Add Emoji row at the picker's foot, with the notice under it.
        await page.locator('[data-testid="add-emoji"]').click();
        await page.waitForSelector('[data-testid="add-emoji-dialog"]');
        await shot(`${out}-add-upload-light.png`, '[data-testid="add-emoji-dialog"]');
        await setTheme("dark");
        await shot(`${out}-add-upload-dark.png`, '[data-testid="add-emoji-dialog"]');
        await setTheme("light");

        // The packs tab.
        await page.locator('[data-testid="add-emoji-tab-packs"]').click();
        await page.waitForTimeout(200);
        await shot(`${out}-add-packs-light.png`, '[data-testid="add-emoji-dialog"]');
        await setTheme("dark");
        await shot(`${out}-add-packs-dark.png`, '[data-testid="add-emoji-dialog"]');
        await setTheme("light");
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");

        // Settings › Custom emoji.
        await openSettings(page);
        const section = '[data-testid="custom-emoji-settings"]';
        await page.locator(section).scrollIntoViewIfNeeded();
        await shot(`${out}-settings-light.png`, section);
        await setTheme("dark");
        await shot(`${out}-settings-dark.png`, section);

        console.log(
          `[preview] wrote ` +
            `${out}-{typeahead,bubbles,reactions,picker,add-upload,add-packs,` +
            `reaction-chip,settings}-{light,dark}.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
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

  // Settings › This app: the two rows, and the three answers that are worth looking at
  // rather than trusting — because each one is a sentence appearing in a row of controls,
  // which is what the column below it moves for (web/src/components/maintenance-settings.tsx).
  if (args.includes("--maintenance")) {
    await withPreview(
      async ({ page, shot, setTheme, emit }) => {
        await openSettings(page);
        const section = '[data-testid="maintenance-settings"]';
        await page.locator(section).scrollIntoViewIfNeeded();
        await shot(`${out}-light.png`, element ?? section);
        await setTheme("dark");
        await shot(`${out}-dark.png`, element ?? section);
        await setTheme("light");

        // The check's own answer. The mock holds no release out of the box, so this is the
        // reassuring one — and the commonest, which is the reason the row exists at all.
        await page.locator('[data-testid="update-check-button"]').click();
        await page.waitForSelector('[data-testid="update-check-message"]');
        await shot(`${out}-checked-light.png`, element ?? section);

        // And the restart ARMED: a local agent is mid-reply, so the second press is the
        // user answering for it. The colour and the sentence are the whole of that state.
        await emit({ kind: "maintenance", runs: 1 });
        await page.locator('[data-testid="restart-backend-button"]').click();
        await page.waitForSelector('[data-testid="restart-backend-message"]');
        await shot(`${out}-armed-light.png`, element ?? section);
        await setTheme("dark");
        await shot(`${out}-armed-dark.png`, element ?? section);
        await setTheme("light");
        await emit({ kind: "maintenance", reset: true });
        console.log(
          `[preview] wrote ${out}-{light,dark,checked-light,armed-light,armed-dark}.png`,
        );
      },
      { deviceScaleFactor: dpr },
    );
    process.exit(0);
  }

  // Settings › AI providers: the two provider rows, the default control as a pair, then
  // the model picker open over them. Every half needs a look in both themes — each row
  // wears a vendor's own artwork, and opencode's mark ships one file per theme, so one
  // capture proves half of it (web/src/components/ai-providers-settings.tsx and
  // agent-model-select.tsx).
  if (args.includes("--ai-providers")) {
    await withPreview(
      async ({ page, shot, setTheme, emit }) => {
        await openSettings(page);
        const section = '[data-testid="ai-providers-settings"]';
        await page.locator(section).scrollIntoViewIfNeeded();
        await shot(`${out}-light.png`, section);
        await setTheme("dark");
        await shot(`${out}-dark.png`, section);
        await setTheme("light");

        // The default control as a PAIR, which needs a machine holding both CLIs: the
        // chip on the provider that has it, the button on the one that could take it.
        // The mock installs one CLI out of the box, so the state is armed and reset.
        await emit({ kind: "agent_providers", available: { opencode: true } });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="conversation-row"]');
        await openSettings(page);
        await page.locator(section).scrollIntoViewIfNeeded();
        await shot(`${out}-default-light.png`, section);
        await setTheme("dark");
        await shot(`${out}-default-dark.png`, section);
        await setTheme("light");
        await emit({ kind: "agent_providers", reset: true });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="conversation-row"]');
        await openSettings(page);
        await page.locator(section).scrollIntoViewIfNeeded();

        // The picker open on the installed provider, which is the one with a list.
        await page
          .locator(
            '[data-testid="ai-provider"][data-provider="claude"] ' +
              '[data-testid="ai-provider-model-select"]',
          )
          .click();
        await page.waitForSelector('[data-testid="ai-provider-model-option"]');
        await page.waitForTimeout(300);
        await shot(`${out}-open-light.png`);
        await setTheme("dark");
        await shot(`${out}-open-dark.png`);
        console.log(
          `[preview] wrote ${out}-{light,dark,default-light,default-dark,open-light,open-dark}.png`,
        );
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
        // Their counts differ for the same reason — a lone reaction is a circle
        // around the emoji, a shared one adds the number.
        const messages = page.locator("[data-message-id]");
        const count = await messages.count();
        for (const [index, key, reacted] of [
          [Math.max(0, count - 4), "1f389_partypopper", 1],
          [Math.max(0, count - 3), "heart", 2],
        ] as const) {
          const id = await messages.nth(index).getAttribute("data-message-id");
          if (id)
            await emit({ kind: "reaction", conversation, message_id: id, key, count: reacted });
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
      // Deleting one of our own messages: the menu that offers it, the confirmation
      // it arms, and the placeholder the message becomes.
      if (args.includes("--delete")) {
        await openMessageActions(page, { mine: true });
        await shot(`${out}-menu-light.png`);
        await armDeleteConfirmation(page);
        await shot(`${out}-confirm-light.png`);
        await page.locator('[data-testid="action-delete-confirm"]').click();
        await page.waitForSelector('[data-testid="deleted-message"]');
        await page.waitForTimeout(400);
      }
      await shot(`${out}-light.png`, element);
      await setTheme("dark");
      await shot(`${out}-dark.png`, element);
      console.log(`[preview] wrote ${out}-light.png and ${out}-dark.png`);
    },
    { deviceScaleFactor: dpr },
  );
}
