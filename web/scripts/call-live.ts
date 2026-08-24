// The ONLY sanctioned way to PLACE a call from the live app without the user.
//
// `sandbox-live.ts` types into one pinned chat; `join-live.ts` joins one pinned meeting;
// this rings one pinned PERSON. It is the third of the three live drivers and it earns its
// place the same way they do — a constant target, proved from the app's own state at the
// moment of the click — never by being tracked, and never by a name the guard's allowlist
// happens to match.
//
// It exists because a call that dies cannot be diagnosed from anywhere else. The failure
// this was written for is a call the service ends two seconds in: the store keeps only
// "Call ended · 2s", the released build hides its backend's output, and the reason lives on
// frames that reach the PAGE and are rendered nowhere. Every round of that cost the user a
// click and a paste.
//
// THE RAILS, and none of them is a promise in a comment:
//   1. the conversation is a CONSTANT here — the one-to-one the user authorized out loud
//      for exactly this test. The script takes no id, no name and no url, so no argument
//      can ring somebody else;
//   2. it hands the caller no raw `page`, so there is nothing to navigate away with;
//   3. the conversation is opened BY THAT ID rather than clicked for in the sidebar, and
//      two things out of the app's own state are read immediately before the click: the
//      composer's `data-conversation-id`, and the call ROW's own `data-conversation-id`.
//      Either one disagreeing throws instead of ringing. The call is a row of the
//      conversation's own menu now rather than a button in its header (see
//      components/conversation-menu.tsx), so this opens that menu first — which changes
//      nothing about the proof: the row states the same attribute the button did, and it is
//      still read off the app's state in the moment before the click;
//   4. it ALWAYS hangs up, on every path out, including a throw. A driver that rang
//      somebody and walked away would leave their phone buzzing.
//
// The microphone is a FAKE device capturing SILENCE, exactly as in `join-live.ts`: the
// offer is real — real fingerprint, real candidates, real SDP — and nobody's actual
// microphone is opened. What is under test is the signaling, and a real person is on the
// other end.
//
// Usage:
//
//   cd web && bun run call-live              # ring, watch, hang up, print why it ended
//   cd web && bun run call-live -- --local   # the same call through this machine's front
//   cd web && bun run call-live -- --hold 20 # stay 20s before hanging up

import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./preview";
import { LOCAL_ORIGIN, TAILNET_ORIGIN } from "./sandbox-live";
import {
  assertFrontIsServing,
  fakeAudioArgs,
  hangUp,
  oneLine,
  PEER_CONNECTION_PROBE,
  readCallBar,
  readMediaStats,
  SIGNAL_PROBE,
  waitForPhase,
  type CallBarState,
  type MediaStats,
} from "./join-live";

/**
 * The one conversation this script may ever ring: the user's own one-to-one, authorized out
 * loud for exactly this test.
 *
 * A call has no sandbox — every other thread in this account belongs to a colleague who
 * agreed to nothing — so this constant is the whole safety of the file. Never parameterise
 * it, and never widen it to "the open conversation".
 */
export const AUTHORIZED_CALL_CONVERSATION =
  "19:2367c029-149d-4ebd-a96c-1fe12bfc24cf_d98f6938-47be-4db9-a509-9676cbe3020d@unq.gbl.spaces";

const APP_READY_TIMEOUT_MS = 60_000;
const CALL_BUTTON_TIMEOUT_MS = 30_000;
/** How many times the conversation's menu is re-opened before giving up.
 *
 *  A live page re-renders on every frame the feed delivers, and a non-modal Radix menu can be
 *  unmounted between the press that opens it and the row being reached. Each attempt re-proves
 *  the target from scratch, so a retry can never carry a stale proof forward — it is only the
 *  OPENING that is retried. */
const MENU_OPEN_ATTEMPTS = 4;
/** How long to watch a live call before hanging up, unless `--hold` says otherwise. A real
 *  person's phone is ringing for every second of this, so it is short. */
const DEFAULT_HOLD_SECONDS = 12;

/** What the service said about this call, reduced to the one thing a dead call needs. */
export type CallSignalDigest = {
  /** How many raw calling frames the page saw at all. Zero means the call never started. */
  frames: number;
  /** Which callback paths the service POSTed to, and how often — the call's own shape. */
  framePaths: Record<string, number>;
  /** Every reason-shaped field of every frame, in order: `code`, `subCode`, `reason`,
   *  `resultCategories`, `phrase`. This is what names a `conversationEnd`. */
  endReasons: string[];
  /** The media sections of every SDP the service sent, as kind/port/profile — which is where
   *  an `UnrecognizedTransportProfile` becomes visible. */
  mediaLines: string[];
};

export type CallLiveSession = {
  conversation: string;
  url: string;
  callBar: () => Promise<CallBarState>;
  waitForPhase: (phases: string[], timeoutMs?: number) => Promise<CallBarState>;
  timeline: () => CallBarState[];
  mediaStats: () => Promise<MediaStats | null>;
  /** What the SERVICE said about the call, digested — including why it ended. */
  signals: () => Promise<CallSignalDigest>;
  /** Everything the page logged, which is where the media half reports itself. */
  log: () => string[];
};

/**
 * Ring the pinned person in the live app, run `body`, then hang up and close.
 *
 * Throws — before the click — unless the app's own state says the open conversation and the
 * button's target are both the pinned one.
 */
export async function withCallLive<T>(
  body: (session: CallLiveSession) => Promise<T>,
  opts: { front?: "tailnet" | "local" } = {},
): Promise<T> {
  const origin = opts.front === "local" ? LOCAL_ORIGIN : TAILNET_ORIGIN;
  await assertFrontIsServing(origin);

  console.log(
    `\n  LIVE ACCOUNT — this RINGS a real person's devices.\n` +
      `  pinned to ${AUTHORIZED_CALL_CONVERSATION}\n  ${origin}\n` +
      `  microphone: fake, capturing silence\n`,
  );

  let browser: Browser | null = null;
  let page: Page | null = null;
  const log: string[] = [];
  try {
    browser = await chromium.launch({
      executablePath: findChromium(),
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        ...fakeAudioArgs(false),
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 850 },
      permissions: ["microphone"],
      ignoreHTTPSErrors: true,
    });
    await context.addInitScript({ content: PEER_CONNECTION_PROBE });
    await context.addInitScript({ content: SIGNAL_PROBE });
    page = await context.newPage();
    // The page's own voice. A call that dies in the MEDIA half reports itself here and
    // nowhere else — the backend sees a clean call, and the browser sees an answer refused.
    page.on("console", (message) => {
      const text = oneLine(message.text());
      log.push(`${message.type()}: ${text}`);
      if (!/call|sdp|media|microphone|rtc|transceiver/i.test(text)) return;
      console.log(`  [page ${message.type()}] ${text.slice(0, 400)}`);
    });
    page.on("pageerror", (error) => {
      const text = oneLine(String(error.message));
      log.push(`pageerror: ${text}`);
      console.log(`  [page error] ${text.slice(0, 400)}`);
    });

    const button = await findPinnedCallButton(page, origin);
    console.log(`  calling the pinned conversation`);
    await button.click();

    const seen: CallBarState[] = [];
    const session: CallLiveSession = {
      conversation: AUTHORIZED_CALL_CONVERSATION,
      url: origin,
      callBar: () => readCallBar(page as Page),
      timeline: () => seen,
      waitForPhase: (phases, timeoutMs = 60_000) =>
        waitForPhase(page as Page, phases, timeoutMs, seen),
      mediaStats: () => readMediaStats(page as Page),
      signals: () => readCallSignals(page as Page),
      log: () => log,
    };
    return await body(session);
  } finally {
    // Hang up on EVERY path, including a throw: a driver that rang somebody and walked away
    // would leave a real phone buzzing.
    if (page) await hangUp(page).catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/**
 * The call ROW of the pinned conversation, with both proofs read before it is returned.
 *
 * The conversation is opened by its own ID — never clicked for in the sidebar, which cannot
 * prove which thread was opened — its menu is opened, and then two independent statements out
 * of the app's own state have to agree: the composer says which conversation is open, and the
 * row says whom it would ring.
 */
async function findPinnedCallButton(page: Page, origin: string) {
  await page.goto(`${origin}/c/${encodeURIComponent(AUTHORIZED_CALL_CONVERSATION)}`, {
    waitUntil: "domcontentloaded",
  });
  const composer = page.locator('[data-testid="composer-shell"]');
  await composer.waitFor({ timeout: APP_READY_TIMEOUT_MS });
  const open = await composer.getAttribute("data-conversation-id");
  if (open !== AUTHORIZED_CALL_CONVERSATION) {
    throw new Error(
      `REFUSING TO CALL: the open conversation is ${open ?? "unknown"}, not the pinned one.\n` +
        `  now at: ${page.url()}`,
    );
  }
  const button = await openCallRow(page);
  const target = await button.getAttribute("data-conversation-id");
  if (target !== AUTHORIZED_CALL_CONVERSATION) {
    throw new Error(
      `REFUSING TO CALL: this app is talking to the real Teams account, and the row on ` +
        `screen rings ${target ?? "an unknown conversation"}, not the pinned one.\n` +
        `  now at: ${page.url()}\n` +
        `A click here would make a stranger's phone ring. Do not work around this.`,
    );
  }
  // A menu row is a `div[role=menuitem]`, so "disabled" is Radix's own attribute rather than a
  // form control's — read as the attribute rather than through `isDisabled()`, because a driver
  // that silently read "enabled" off the wrong spelling would click a control the app refused.
  if ((await button.getAttribute("data-disabled")) !== null) {
    throw new Error(
      "The call row is disabled, so this window does not take calls (a read-only backend, or " +
        "a call already in flight) — and this script will not click a disabled row. What the " +
        "app says is beside it: " +
        ((await page
          .locator('[data-testid="conversation-call-reason"]')
          .first()
          .innerText()
          .catch(() => "")) || "(no reason stated)"),
    );
  }
  return button;
}

/**
 * Open the open conversation's own menu and hand back its call row.
 *
 * The call moved into that menu, so this is the one step the driver gained — and it is the
 * cheap half: opening a menu reaches nobody. Retried, because a live page re-renders on every
 * frame its feed delivers and a non-modal Radix menu can be unmounted in that window. Nothing
 * about the target is remembered across an attempt; the proof is read by the caller after this
 * returns, from the row that is on screen then.
 */
async function openCallRow(page: Page) {
  const trigger = page.locator('[data-testid="conversation-menu"]').first();
  await trigger.waitFor({ timeout: APP_READY_TIMEOUT_MS });
  const row = page.locator('[data-testid="call-button"]').first();
  for (let attempt = 1; attempt <= MENU_OPEN_ATTEMPTS; attempt += 1) {
    try {
      if (!(await row.count())) await trigger.click({ timeout: 5_000 });
      await row.waitFor({ timeout: CALL_BUTTON_TIMEOUT_MS / MENU_OPEN_ATTEMPTS });
      return row;
    } catch {
      await page.waitForTimeout(400);
    }
  }
  throw new Error(
    "REFUSING TO CALL: this conversation's menu never offered a call row. That is what a " +
      "conversation with nobody to ring looks like (Notes), and also what a bundle staged " +
      "before the menu existed looks like — check `bin/teams-lite-service.sh status` and " +
      "re-stage with `update`. It rings the pinned conversation and no other; do not point " +
      "it elsewhere.",
  );
}

/** Fields whose value names why a call ended, or why a request was refused. Read from every
 *  frame at any depth, because the service puts them wherever it likes. */
const REASON_KEYS = new Set([
  "code",
  "subCode",
  "reason",
  "phrase",
  "resultCategories",
  "callEndReason",
  "terminatedReason",
]);

/**
 * Digest what the service said about this call.
 *
 * The frames are parsed HERE rather than in the page, exactly as in `join-live.ts`: the page
 * hands back the raw strings it received, so a reading that turns out to be wrong can be
 * corrected without ringing anybody again.
 */
async function readCallSignals(page: Page): Promise<CallSignalDigest> {
  const raw = (await page.evaluate("window.__tlSignals || []")) as string[];
  const digest: CallSignalDigest = { frames: 0, framePaths: {}, endReasons: [], mediaLines: [] };
  const reasons = new Set<string>();
  const lines = new Set<string>();
  for (const text of raw) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (message.method !== "call_signal" && message.event !== "call_signal") continue;
    const params = (message.params ?? message.data) as Record<string, unknown> | undefined;
    if (!params) continue;
    digest.frames += 1;
    const url = typeof params.url === "string" ? params.url : "";
    // The url's own TAIL, never the surl in front of it, which is a session key.
    const path = url.match(/\/(?:call|conversation)\/[A-Za-z]+\/?$/)?.[0] ?? "other";
    digest.framePaths[path] = (digest.framePaths[path] ?? 0) + 1;
    for (const reason of reasonsIn(params.body)) reasons.add(`${path} ${reason}`);
    for (const blob of sdpBlobsIn(params.body)) {
      for (const line of mediaLines(blob)) lines.add(`${path} ${line}`);
    }
  }
  digest.endReasons = [...reasons];
  digest.mediaLines = [...lines];
  return digest;
}

/** Every reason-shaped field at any depth, as `key=value`. Values only for the keys in
 *  {@link REASON_KEYS}, so nothing else about the call travels. */
function reasonsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) reasonsIn(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (REASON_KEYS.has(key) && (typeof child !== "object" || child === null)) {
      out.push(`${key}=${JSON.stringify(child)}`);
      continue;
    }
    reasonsIn(child, out);
  }
  return out;
}

/** Every SDP blob a frame carries, found by its own shape rather than by a path. */
function sdpBlobsIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) sdpBlobsIn(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === "string" && child.startsWith("v=0")) out.push(child);
    else sdpBlobsIn(child, out);
  }
  return out;
}

/** One line per media section: kind, port and transport profile, and nothing else — no
 *  candidate, no fingerprint, no key. */
function mediaLines(sdp: string): string[] {
  return sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("m="))
    .map((line) => line.slice(2));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const front = argv.includes("--local") ? "local" : "tailnet";
  const holdAt = argv.indexOf("--hold");
  const hold = holdAt >= 0 ? Number(argv[holdAt + 1]) : DEFAULT_HOLD_SECONDS;

  await withCallLive(
    async ({ waitForPhase: wait, timeline, mediaStats, signals, log }) => {
      // Does it get past dialling, and does it STAY up? The failure under test is a call
      // that reaches `connected` and dies two seconds later, so both are watched.
      const state = await wait(["connected", "ended"], 40_000);
      if (state.phase === "connected") {
        console.log(`\n  CONNECTED. Holding ${hold}s to see whether it stays up.`);
        await wait(["ended"], hold * 1_000);
      }
      const media = await mediaStats();
      if (media) {
        console.log(
          `\n  media: ${media.connectionState}/${media.iceConnectionState}` +
            ` via ${media.candidatePair ?? "no pair"}\n` +
            `  sent ${media.bytesSent}B in ${media.packetsSent} packets,` +
            ` received ${media.bytesReceived}B in ${media.packetsReceived}`,
        );
      }
      const signal = await signals();
      console.log(`\n  signals: ${signal.frames} frames`);
      console.log(`  frames by path: ${JSON.stringify(signal.framePaths)}`);
      console.log(
        `  reasons: ${signal.endReasons.length ? signal.endReasons.join("  ") : "(none stated)"}`,
      );
      for (const line of signal.mediaLines) console.log(`  sdp ${line}`);
      const failures = log().filter((line) => /^(error|pageerror|warning)/.test(line));
      if (failures.length > 0) {
        console.log("\n  what the page reported:");
        for (const line of failures.slice(-12)) console.log(`    ${line.slice(0, 300)}`);
      }
      const end = timeline().at(-1);
      console.log(
        `\n  final: ${end?.phase ?? "-"} ${end?.detail || end?.notice || ""}\n` +
          "  The backend journal has its own half: " +
          "journalctl --user -u teams-lite-backend -n 80\n",
      );
    },
    { front },
  );
}
