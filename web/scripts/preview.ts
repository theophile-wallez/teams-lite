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
//   bun run web/scripts/preview.ts --out /tmp/preview --react   # reaction chips + emoji picker
//
// To capture a specific thread instead of the top row — `--conversation` matches a
// sidebar row by name, so a fixture can be aimed at without writing a driver:
//
//   bun run web/scripts/preview.ts --out /tmp/cards --conversation "App Cards"

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

/** The real backend's port. Nothing here may ever talk to it. */
const BACKEND_PORT = 8420;
/** Ports for our own throwaway mock + dev server (override via env if taken). */
const MOCK_PORT = Number(process.env.PREVIEW_MOCK_PORT ?? 8455);
const WEB_PORT = Number(process.env.PREVIEW_WEB_PORT ?? 4455);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const MOCK_WS_URL = `ws://127.0.0.1:${MOCK_PORT}`;

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

/**
 * Boot a mock-backed preview of the web app, run `body` against it, then tear
 * everything down. Throws — before `body` runs — if the app is not provably
 * talking to the mock.
 */
export async function withPreview<T>(body: (session: PreviewSession) => Promise<T>): Promise<T> {
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
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
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
        const target = selector ? page.locator(selector).first() : page;
        await target.screenshot({ path });
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
 * Hover the last message until its quick reaction row appears (it is revealed
 * after a dwell, see REACTION_HOVER_MS in message-bubble.tsx).
 *
 * Reaction surfaces only *offer* a reaction — nothing leaves until an emoji is
 * clicked — but they are still write affordances, so these helpers re-assert the
 * mock sentinel like every other one here.
 */
export async function revealReactionRow(page: Page): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="message"]').last().hover();
  await page.waitForSelector('[data-testid="reaction-picker"]');
  await page.waitForTimeout(300); // let the row's reveal animation settle
}

/**
 * Open the full emoji picker from a revealed quick row. Returns once emoji-mart
 * has mounted and its Apple images (served from our own origin) have had a beat
 * to arrive, so a capture isn't of a half-loaded grid.
 */
export async function openReactionPicker(page: Page): Promise<void> {
  await assertMockBackend(page);
  await page.locator('[data-testid="reaction-picker"] [data-testid="reaction-more"]').click();
  await page.waitForSelector('[data-testid="emoji-picker"]');
  await page.waitForTimeout(800);
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
  if (MOCK_PORT === BACKEND_PORT || WEB_PORT === BACKEND_PORT) {
    throw new Error(
      `PREVIEW_MOCK_PORT/PREVIEW_WEB_PORT must not be ${BACKEND_PORT} — that is the real backend.`,
    );
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
 */
function findChromium(): string {
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

  await withPreview(async ({ page, shot, setTheme, emit }) => {
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
      // Three states worth reviewing: chips, the quick row, then the full picker.
      await shot(`${out}-chips-light.png`);
      await setTheme("dark");
      await shot(`${out}-chips-dark.png`);
      await setTheme("light");
      await revealReactionRow(page);
      await shot(`${out}-row-light.png`);
      await openReactionPicker(page);
    }
    await shot(`${out}-light.png`);
    await setTheme("dark");
    await shot(`${out}-dark.png`);
    console.log(`[preview] wrote ${out}-light.png and ${out}-dark.png`);
  });
}
