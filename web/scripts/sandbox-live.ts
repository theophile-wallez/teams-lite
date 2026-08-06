// The ONLY sanctioned way to type into the app while it talks to the REAL account.
//
// `scripts/preview.ts` is the mock twin of this file and covers almost everything:
// nothing it types leaves the machine. Some things it cannot show — how Teams itself
// renders what we send, what the tenant does with an edit, whether a reaction key is
// the one Microsoft expects — and answering those needs one real send.
//
// So this file exists to make "one real send" mean exactly that, in exactly one
// place: the designated sandbox chat (see AGENTS.md § Sending messages). Every other
// conversation in the account is off-limits, and the way that is kept true is not a
// promise in a comment:
//   1. the thread and its two URLs are CONSTANTS here — the script takes no url,
//      no thread, no port, so there is no argument that can aim it elsewhere;
//   2. it hands the caller no raw `page`, only `type` / `shot` / `lastMessages`, so
//      there is nothing to navigate away with either;
//   3. before every keystroke — and again immediately before Enter — it reads the
//      open conversation id out of the app's own state
//      (`[data-testid="composer-shell"]`'s `data-conversation-id`) and throws unless
//      it is the sandbox thread. That value comes from the store, not from the URL
//      and not from our assumption, so a redirect, a restored session or a stray
//      click cannot fool it. It is the live counterpart of the MOCK sentinel badge.
//
// A failed check throws BEFORE a key is pressed. If it throws, fix the setup — never
// reach for a hand-rolled driver, which is precisely how three messages once went out
// to two real 1:1 chats (AGENTS.md § Automation safety).
//
// Usage from the shell:
//
//   cd web && bun run sandbox                          # open it, prove it, screenshot it
//   cd web && bun run sandbox -- --type "hello"         # type, do not send
//   cd web && bun run sandbox -- --type "hello" --send  # type and send, for real
//   cd web && bun run sandbox -- --local                # same chat, this machine's front
//
// Usage as a library:
//
//   import { withSandboxLive } from "./scripts/sandbox-live";
//   await withSandboxLive(async ({ type, lastMessages }) => {
//     await type("hello", { send: true });
//     console.log(await lastMessages(3));
//   });

import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./preview";

/** The one conversation an agent may post in. Never parameterise this. */
export const SANDBOX_THREAD = "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2";

/** Its route in the web app. */
export const SANDBOX_PATH = `/c/${encodeURIComponent(SANDBOX_THREAD)}`;

/**
 * The two fronts of the always-on web unit, and nothing else. Both serve the same
 * app against the same backend, so they open the same chat: the tailnet one is the
 * address in AGENTS.md (and the one the user's phone uses), the local one is the
 * same door from this machine, for when the tailnet name does not resolve here.
 */
export const TAILNET_ORIGIN = "https://theophile-remote.taild26c06.ts.net:8443";
export const LOCAL_ORIGIN = "http://127.0.0.1:19440";
/**
 * The RELEASED build's own front, which runs beside the staged pair on this machine
 * (AGENTS.md § Running the released build beside the staged one).
 *
 * It is a second INSTALL, not a second target: both doors open the same account and the same
 * conversations, and every rail in these drivers is about WHICH conversation is typed into or
 * called. What it buys is a second calling ENDPOINT — the service sees two devices — which is
 * the only way this machine can put somebody else in a meeting.
 */
export const RELEASED_ORIGIN = "http://127.0.0.1:19442";

export const SANDBOX_URL = `${TAILNET_ORIGIN}${SANDBOX_PATH}`;
export const SANDBOX_URL_LOCAL = `${LOCAL_ORIGIN}${SANDBOX_PATH}`;

const APP_READY_TIMEOUT_MS = 60_000;
const SENTINEL_TIMEOUT_MS = 15_000;

export type SandboxLiveSession = {
  /** The thread every keystroke is pinned to — `SANDBOX_THREAD`. */
  thread: string;
  /** Which front this session opened. */
  url: string;
  /**
   * Type into the composer of the sandbox chat. `send: true` presses Enter, which
   * posts for real. Re-asserts the pin first, and once more before Enter.
   */
  type: (text: string, opts?: { send?: boolean }) => Promise<void>;
  /** Screenshot the page (or an element, when a selector is given). */
  shot: (path: string, selector?: string) => Promise<void>;
  /** The rendered text of the last `count` messages — how a send is verified. */
  lastMessages: (count?: number) => Promise<string[]>;
  /** Re-assert the pin by hand; `type` already does it for you. */
  assertSandbox: () => Promise<void>;
};

/**
 * Open the sandbox chat in the live app, run `body` against it, then close the
 * browser. Throws — before `body` runs — unless the conversation on screen is the
 * sandbox thread.
 */
export async function withSandboxLive<T>(
  body: (session: SandboxLiveSession) => Promise<T>,
  opts: { front?: "tailnet" | "local" } = {},
): Promise<T> {
  const url = opts.front === "local" ? SANDBOX_URL_LOCAL : SANDBOX_URL;
  await assertFrontIsServing(url);

  console.log(`\n  LIVE ACCOUNT — pinned to the sandbox chat\n  ${url}\n`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: findChromium() });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="composer-shell"]', {
      timeout: APP_READY_TIMEOUT_MS,
    });
    const assertSandbox = () => assertSandboxThread(page, url);
    await assertSandbox();

    return await body({
      thread: SANDBOX_THREAD,
      url,
      assertSandbox,
      type: (text, typeOpts = {}) => typeInSandbox(page, url, text, typeOpts),
      shot: async (path, selector) => {
        const target = selector ? page.locator(selector).first() : page;
        await target.screenshot({ path });
      },
      lastMessages: async (count = 5) => {
        const texts = await page.locator('[data-testid="message"]').allInnerTexts();
        return texts.slice(-count).map(oneLine);
      },
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * The gate. Reads the open conversation id out of the app's own state and throws
 * unless it is the sandbox thread.
 *
 * Called once after load and again before every keystroke, for the same reason
 * `preview.ts` re-reads its badge: "it was the right thread a minute ago" is not
 * proof that it still is. The URL is checked too, but the attribute is what decides
 * — a URL can point at a thread the app never managed to open.
 */
async function assertSandboxThread(page: Page, url: string): Promise<void> {
  const shell = page.locator('[data-testid="composer-shell"]').first();
  const open = await shell
    .getAttribute("data-conversation-id", { timeout: SENTINEL_TIMEOUT_MS })
    .catch(() => null);
  if (open === SANDBOX_THREAD && page.url().includes(encodeURIComponent(SANDBOX_THREAD))) return;
  // A missing attribute is treated exactly like a wrong one — unproven means live —
  // but it has one very likely cause worth naming: the always-on service serves a
  // STAGED bundle, so a build from before this sentinel existed looks like this.
  const conversation =
    open === null
      ? "unknown: the composer carries no `data-conversation-id`. If the app otherwise " +
        "works, the service is probably serving a bundle staged before that attribute " +
        "existed — check `bin/teams-lite-service.sh status` and re-stage with `update`"
      : `"${open}"`;
  throw new Error(
    `REFUSING TO TYPE IN THIS APP: it is talking to the real Teams account, and the ` +
      `open conversation is ${conversation}, not the sandbox chat ${SANDBOX_THREAD}.\n` +
      `  opened: ${url}\n  now at: ${page.url()}\n` +
      `A keystroke here would post to whoever is on the other side. Open the sandbox ` +
      `chat and nothing else (AGENTS.md § Sending messages); do not work around this.`,
  );
}

/**
 * Type into the sandbox chat's composer, optionally sending. The only path from this
 * file to a keypress: the pin is re-read here, and again after the text is in place,
 * so the last thing that happens before Enter is a proof of where it lands.
 */
async function typeInSandbox(
  page: Page,
  url: string,
  text: string,
  opts: { send?: boolean },
): Promise<void> {
  await assertSandboxThread(page, url);
  // The composer has one field and it is the rich editor, so type in the editable
  // itself: its wrapper takes no keystrokes.
  const composer = page.locator('[data-testid="composer-rich"] .tiptap-message').first();
  await composer.click();
  await composer.pressSequentially(text, { delay: 5 });
  if (!opts.send) return;
  await assertSandboxThread(page, url); // last check, right before the message leaves
  console.log(`  sending: ${oneLine(text)}`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_200);
}

/**
 * Refuse to launch a browser at a front that is not answering, so the failure reads
 * "the web unit is down" instead of a Chromium navigation error — and so the tailnet
 * name, which does not resolve on every machine, names its own remedy.
 */
async function assertFrontIsServing(url: string): Promise<void> {
  const origin = new URL(url).origin;
  const reachable = await fetch(origin, { redirect: "manual" })
    .then(() => true)
    .catch(() => false);
  if (reachable) return;
  throw new Error(
    `${origin} is not answering, so there is nothing to drive.\n` +
      (origin === TAILNET_ORIGIN
        ? `That is the tailnet front. Check \`tailscale serve status\` and ` +
          `\`bin/teams-lite-service.sh status\`, or pass --local to open the same chat ` +
          `through ${LOCAL_ORIGIN}.`
        : `That is the always-on web unit. Check \`bin/teams-lite-service.sh status\`; ` +
          `starting it is the user's call.`),
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---- CLI -------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const text = flag("--type");
  const send = args.includes("--send");
  const out = flag("--out") ?? "/tmp/sandbox-live.png";
  const front = args.includes("--local") ? "local" : "tailnet";

  if (send && !text) {
    throw new Error("--send needs --type: there is nothing to send otherwise.");
  }

  await withSandboxLive(async ({ type, shot, lastMessages }) => {
    if (text) await type(text, { send });
    await shot(out);
    console.log(`  screenshot: ${out}`);
    for (const message of await lastMessages(5)) console.log(`  · ${message}`);
  }, { front });
}
