// The ONLY sanctioned way to JOIN a meeting from the live app without the user.
//
// `sandbox-live.ts` is this file's sibling and the model for it: one pinned target, no
// argument that can aim it elsewhere, and the app's own state read as proof immediately
// before the outward action. It exists because a chat feature sometimes needs one real
// send. This one exists for the same reason, one step further out: a meeting join cannot
// be exercised anywhere else at all.
//
// `examples/meeting_join_probe.rs` gets close — it POSTs a real join from this machine
// and leaves again — but it has no browser, so no `RTCPeerConnection`, no real SDP, and,
// decisively, no live trouter socket: it fabricates the surl its callback links sit on.
// Everything that goes wrong AFTER the join arrives on that socket — the acceptance, its
// answer, the acknowledgement the service waits 30 s for — so the probe cannot see any of
// it. Only a browser attached to the backend's real calling connection can, which is the
// app. Without this file, every one of those rounds cost the user a click and a paste.
//
// THE RAILS, and none of them is a promise in a comment:
//   1. the meeting is a CONSTANT here — its code, from the link the user authorized for
//      testing. The script takes no url, no code, no event name, so no argument can aim
//      it at somebody else's meeting;
//   2. it hands the caller no raw `page`, so there is nothing to navigate away with;
//   3. immediately before the click it reads the button's OWN `data-join-url` out of the
//      page and throws unless that link names the pinned meeting. That value comes from
//      the store, not from our assumption — the live counterpart of the MOCK sentinel and
//      the twin of the composer's `data-conversation-id` check;
//   4. it ALWAYS hangs up, on every path out, including a throw. A driver that joined and
//      stayed would leave a silent participant in a real meeting.
//
// The microphone is a FAKE device (`--use-fake-device-for-media-stream`), so the browser
// produces a real offer with a real fingerprint and real candidates while nobody's actual
// microphone is opened. That is the whole point: the SDP is what is under test.
//
// Usage:
//
//   cd web && bun run join-live            # join, watch, hang up, print the timeline
//   cd web && bun run join-live -- --local # the same meeting through this machine's front
//   cd web && bun run join-live -- --hold 45   # stay 45s before hanging up

import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./preview";
import { LOCAL_ORIGIN, TAILNET_ORIGIN } from "./sandbox-live";

/**
 * The one meeting this script may ever join: the user's own, authorized out loud for
 * exactly this test. Its CODE, because that is the part every spelling of the link
 * shares — the short `/meet/{code}` one in the invitation and the long
 * `/l/meetup-join/{thread}` one Graph hands the app both carry it.
 *
 * Never parameterise this, and never widen it to "the next meeting in the calendar".
 */
export const AUTHORIZED_MEETING_CODE = "35017215452446";

/** The thread that code resolves to on this tenant, for the second half of the proof. */
export const AUTHORIZED_MEETING_THREAD =
  "19:meeting_MTVjNTZlMGQtYTY3My00MjU1LThkM2QtYWE3NDEzNjYzOGVi@thread.v2";

const CALENDAR_PATH = "/calendar";
const APP_READY_TIMEOUT_MS = 60_000;
const JOIN_BUTTON_TIMEOUT_MS = 30_000;
/** How long to watch a joined call before hanging up, unless `--hold` says otherwise. */
const DEFAULT_HOLD_SECONDS = 25;

/** One reading of the call bar, as the app itself renders it. */
export type CallBarState = {
  /** `dialing` | `connecting` | `connected` | `ended`, from the bar's own attribute. */
  phase: string | null;
  /** What the bar says under the title — "Joining…", "Waiting to be let in…", a timer. */
  detail: string;
  /** The notice that replaces the bar when a call ends, when there is one. */
  notice: string;
};

export type JoinLiveSession = {
  meeting: string;
  url: string;
  /** Read the call bar now. */
  callBar: () => Promise<CallBarState>;
  /** Wait until the bar reaches one of `phases`, or the timeout expires. */
  waitForPhase: (phases: string[], timeoutMs?: number) => Promise<CallBarState>;
  /** Every distinct bar state seen since the click, in order. */
  timeline: () => CallBarState[];
  /** Screenshot the page or one element. */
  shot: (path: string, selector?: string) => Promise<void>;
};

/**
 * Join the pinned meeting in the live app, run `body`, then hang up and close.
 *
 * Throws — before the click — unless the button on screen names the pinned meeting.
 */
export async function withJoinLive<T>(
  body: (session: JoinLiveSession) => Promise<T>,
  opts: { front?: "tailnet" | "local" } = {},
): Promise<T> {
  const origin = opts.front === "local" ? LOCAL_ORIGIN : TAILNET_ORIGIN;
  const url = `${origin}${CALENDAR_PATH}`;
  await assertFrontIsServing(origin);

  console.log(`\n  LIVE ACCOUNT — pinned to meeting ${AUTHORIZED_MEETING_CODE}\n  ${url}\n`);

  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    browser = await chromium.launch({
      executablePath: findChromium(),
      // A fake microphone, and no permission prompt for it. The offer is real — real
      // fingerprint, real ICE candidates — and no actual microphone is opened.
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1200, height: 850 },
      permissions: ["microphone"],
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    const seen: CallBarState[] = [];
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const button = await findPinnedJoinButton(page);
    await assertPinnedMeeting(button, page);
    console.log(`  joining ${AUTHORIZED_MEETING_CODE} — the pinned meeting`);
    await button.click();

    const session: JoinLiveSession = {
      meeting: AUTHORIZED_MEETING_CODE,
      url,
      callBar: () => readCallBar(page as Page),
      timeline: () => seen,
      waitForPhase: (phases, timeoutMs = 60_000) =>
        waitForPhase(page as Page, phases, timeoutMs, seen),
      shot: async (path, selector) => {
        const target = selector ? (page as Page).locator(selector).first() : (page as Page);
        await target.screenshot({ path });
      },
    };
    return await body(session);
  } finally {
    // Hang up on EVERY path, including a throw: a driver that joined and stayed is a
    // silent participant in a real meeting.
    if (page) await hangUp(page).catch(() => {});
    await browser?.close().catch(() => {});
  }
}

/**
 * The Join button of the pinned meeting, found by opening events until one of them
 * offers a join for that code.
 *
 * It walks the day's events rather than trusting a position, and it never clicks a
 * button whose link it has not read.
 */
async function findPinnedJoinButton(page: Page) {
  await page.waitForSelector('[data-testid="calendar-pane"], [data-testid="calendar-event"]', {
    timeout: APP_READY_TIMEOUT_MS,
  });
  const direct = page.locator(`[data-testid="meeting-join-here"]`).first();
  if (await direct.count()) {
    const link = (await direct.getAttribute("data-join-url")) ?? "";
    if (link.includes(AUTHORIZED_MEETING_CODE)) return direct;
  }
  // Otherwise open events one at a time and look at what each offers.
  const events = page.locator('[data-testid="calendar-event"]');
  const count = await events.count();
  for (let i = 0; i < count; i += 1) {
    await events.nth(i).click();
    const join = page.locator('[data-testid="meeting-join-here"]').first();
    const link = await join
      .getAttribute("data-join-url", { timeout: 2_000 })
      .catch(() => null);
    if (link && link.includes(AUTHORIZED_MEETING_CODE)) return join;
  }
  throw new Error(
    `No event in the calendar offers a join for meeting ${AUTHORIZED_MEETING_CODE}, which ` +
      `is the only one this script may join. It may not be in the window on screen, or ` +
      `calling may be off in Settings (the button is disabled then). This script joins ` +
      `that meeting and no other — do not point it elsewhere.`,
  );
}

/**
 * The gate. Reads the button's own `data-join-url` and throws unless it names the
 * pinned meeting.
 *
 * Re-read immediately before the click for the same reason `sandbox-live.ts` re-reads
 * its conversation id: "it was the right event a moment ago" is not proof that the
 * panel still shows it.
 */
async function assertPinnedMeeting(
  button: ReturnType<Page["locator"]>,
  page: Page,
): Promise<void> {
  const link = await button.getAttribute("data-join-url", { timeout: JOIN_BUTTON_TIMEOUT_MS });
  const names = (value: string | null) =>
    !!value &&
    (value.includes(AUTHORIZED_MEETING_CODE) || value.includes(AUTHORIZED_MEETING_THREAD));
  if (names(link)) return;
  const shown =
    link === null
      ? "unknown: the button carries no `data-join-url`. If the app otherwise works, the " +
        "service is probably serving a bundle staged before that attribute existed — " +
        "check `bin/teams-lite-service.sh status` and re-stage with `update`"
      : `"${link}"`;
  throw new Error(
    `REFUSING TO JOIN: this app is talking to the real Teams account, and the button on ` +
      `screen joins ${shown}, not the pinned meeting ${AUTHORIZED_MEETING_CODE}.\n` +
      `  now at: ${page.url()}\n` +
      `A click here would put the user in somebody else's meeting, where everybody ` +
      `present would see them arrive. Do not work around this.`,
  );
}

/** Read the call bar as the app renders it. */
async function readCallBar(page: Page): Promise<CallBarState> {
  const bar = page.locator('[data-testid="call-bar"]').first();
  if (!(await bar.count())) {
    const notice = await page
      .locator('[data-testid="call-notice"]')
      .first()
      .innerText()
      .catch(() => "");
    return { phase: null, detail: "", notice: oneLine(notice) };
  }
  const phase = await bar.getAttribute("data-phase").catch(() => null);
  const detail = await page
    .locator('[data-testid="call-phase"]')
    .first()
    .innerText()
    .catch(() => "");
  return { phase, detail: oneLine(detail), notice: "" };
}

/** Poll the bar until it reaches one of `phases`, recording every change on the way. */
async function waitForPhase(
  page: Page,
  phases: string[],
  timeoutMs: number,
  seen: CallBarState[],
): Promise<CallBarState> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const state = await readCallBar(page);
    const key = `${state.phase}|${state.detail}|${state.notice}`;
    if (key !== last) {
      last = key;
      seen.push(state);
      console.log(
        `  ${String(state.phase ?? "-").padEnd(11)} ${state.detail || state.notice || ""}`,
      );
    }
    if (state.phase && phases.includes(state.phase)) return state;
    if (state.notice && phases.includes("ended")) return state;
    if (Date.now() > deadline) return state;
    await page.waitForTimeout(500);
  }
}

/** Leave the call, if one is up. Idempotent: nothing to do is not an error. */
async function hangUp(page: Page): Promise<void> {
  const button = page.locator('[data-testid="call-hangup"]').first();
  if (!(await button.count())) return;
  console.log("  hanging up");
  await button.click();
  await page.waitForTimeout(1_500);
}

/** Refuse to launch at a front that is not answering, so the failure names its cause. */
async function assertFrontIsServing(origin: string): Promise<void> {
  const reachable = await fetch(origin, { redirect: "manual" })
    .then(() => true)
    .catch(() => false);
  if (reachable) return;
  throw new Error(
    `${origin} is not answering, so there is nothing to drive.\n` +
      (origin === TAILNET_ORIGIN
        ? "That is the tailnet front — check `tailscale serve status` and " +
          "`bin/teams-lite-service.sh status`, or pass --local for the same app on this machine."
        : "Check `bin/teams-lite-service.sh status`."),
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const front = argv.includes("--local") ? "local" : "tailnet";
  const holdAt = argv.indexOf("--hold");
  const hold = holdAt >= 0 ? Number(argv[holdAt + 1]) : DEFAULT_HOLD_SECONDS;

  await withJoinLive(
    async ({ waitForPhase: wait, timeline }) => {
      // First: does it get past "joining" at all? That is the acceptance and its answer.
      const state = await wait(["connected", "ended"], 45_000);
      if (state.phase === "connected") {
        console.log(`\n  CONNECTED. Holding ${hold}s to see whether it stays up.`);
        await wait(["ended"], hold * 1_000);
      }
      const end = timeline().at(-1);
      console.log(
        `\n  final: ${end?.phase ?? "-"} ${end?.detail || end?.notice || ""}\n` +
          "  The backend journal has the frames: journalctl --user -u teams-lite-backend -n 60\n",
      );
    },
    { front },
  );
}
